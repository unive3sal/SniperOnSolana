import { Connection, PublicKey } from '@solana/web3.js';
import { getAccount } from '@solana/spl-token';
import { EventEmitter } from 'events';
import type { Logger } from 'pino';
import type { Config, Position, DexType, SwapResult } from '../config/types.js';
import { TIMING } from '../config/constants.js';
import { RpcProviderManager } from '../utils/rpc-provider.js';
import { generateId } from '../utils/helpers.js';
import { getAta, getTokenBalance } from '../utils/wallet.js';
import { parsePumpfunBondingCurveState } from '../monitor/parsers/pumpfun.js';
import { getCachedMultipleAccountsInfo } from '../utils/rpc.js';

/**
 * Position manager for tracking open trades
 */
export class PositionManager extends EventEmitter {
  private readonly config: Config;
  private readonly logger: Logger;
  private readonly rpcProviderManager: RpcProviderManager | null;
  private readonly connection: Connection;
  private positions: Map<string, Position> = new Map();
  private priceMonitorInterval: NodeJS.Timeout | null = null;
  private isRunning = false;

  constructor(config: Config, logger: Logger, rpcProviderManager?: RpcProviderManager) {
    super();
    this.config = config;
    this.logger = logger.child({ module: 'position' });
    this.rpcProviderManager = rpcProviderManager ?? null;

    // Use RpcProviderManager if available, otherwise fall back to direct connection
    if (rpcProviderManager) {
      this.connection = rpcProviderManager.getConnection();
      this.logger.info('PositionManager using RpcProviderManager');
    } else {
      this.connection = new Connection(config.network.heliusRpcUrl, {
        commitment: 'confirmed',
      });
      this.logger.info('PositionManager using direct Helius connection');
    }
  }

  /**
   * Get the best available connection (uses RpcProviderManager for failover if available)
   */
  private getBestConnection(): Connection {
    if (this.rpcProviderManager) {
      return this.rpcProviderManager.getConnection();
    }
    return this.connection;
  }

  /**
   * Open a new position
   */
  async openPosition(
    mint: PublicKey,
    pool: PublicKey,
    dex: DexType,
    entryPrice: number,
    solSpent: number,
    tokenAmount: number,
    entryTxHash: string
  ): Promise<Position> {
    // Check if we've reached max positions
    const openPositions = this.getOpenPositions();
    if (openPositions.length >= this.config.trading.maxConcurrentPositions) {
      throw new Error(`Maximum concurrent positions (${this.config.trading.maxConcurrentPositions}) reached`);
    }

    // Check max position size
    const totalSolInPositions = openPositions.reduce((sum, p) => sum + p.solSpent, 0);
    if (totalSolInPositions + solSpent > this.config.trading.maxPositionSizeSol) {
      throw new Error(`Would exceed maximum position size (${this.config.trading.maxPositionSizeSol} SOL)`);
    }

    const takeProfitPrice = entryPrice * (1 + this.config.trading.takeProfitPercent / 100);
    const stopLossPrice = entryPrice * (1 - this.config.trading.stopLossPercent / 100);

    const position: Position = {
      id: generateId(),
      mint,
      pool,
      dex,
      entryPrice,
      entryTime: Date.now(),
      amount: tokenAmount,
      solSpent,
      currentPrice: entryPrice,
      pnlPercent: 0,
      takeProfitPrice,
      stopLossPrice,
      status: 'open',
      entryTxHash,
    };

    this.positions.set(position.id, position);

    this.logger.info({
      id: position.id,
      mint: mint.toBase58(),
      entryPrice,
      takeProfitPrice,
      stopLossPrice,
      tokenAmount,
      solSpent,
    }, 'Position opened');

    this.emit('position_opened', position);

    return position;
  }

  /**
   * Close a position
   */
  closePosition(
    positionId: string,
    exitReason: Position['exitReason'],
    exitTxHash?: string,
    exitPrice?: number
  ): Position | null {
    const position = this.positions.get(positionId);
    if (!position) {
      this.logger.warn({ positionId }, 'Position not found');
      return null;
    }

    position.status = 'closed';
    position.exitReason = exitReason;
    position.exitTxHash = exitTxHash;
    
    if (exitPrice) {
      position.currentPrice = exitPrice;
      position.pnlPercent = ((exitPrice - position.entryPrice) / position.entryPrice) * 100;
    }

    this.logger.info({
      id: position.id,
      mint: position.mint.toBase58(),
      exitReason,
      pnlPercent: position.pnlPercent.toFixed(2),
    }, 'Position closed');

    this.emit('position_closed', position);

    return position;
  }

  /**
   * Get a position by ID
   */
  getPosition(positionId: string): Position | undefined {
    return this.positions.get(positionId);
  }

  /**
   * Get all open positions
   */
  getOpenPositions(): Position[] {
    return Array.from(this.positions.values()).filter(p => p.status === 'open');
  }

  /**
   * Get all positions
   */
  getAllPositions(): Position[] {
    return Array.from(this.positions.values());
  }

  /**
   * Get position by mint
   */
  getPositionByMint(mint: PublicKey): Position | undefined {
    return Array.from(this.positions.values()).find(
      p => p.status === 'open' && p.mint.equals(mint)
    );
  }

  /**
   * Start price monitoring
   */
  startMonitoring(): void {
    if (this.isRunning) {
      return;
    }

    this.isRunning = true;
    this.logger.info('Starting position price monitoring');

    this.priceMonitorInterval = setInterval(
      () => this.checkPositions(),
      TIMING.POSITION_CHECK_INTERVAL_MS
    );
  }

  /**
   * Stop price monitoring
   */
  stopMonitoring(): void {
    if (!this.isRunning) {
      return;
    }

    this.isRunning = false;
    
    if (this.priceMonitorInterval) {
      clearInterval(this.priceMonitorInterval);
      this.priceMonitorInterval = null;
    }

    this.logger.info('Stopped position price monitoring');
  }

  /**
   * Check all positions for TP/SL triggers
   * Uses batch fetching to reduce RPC calls
   */
  private async checkPositions(): Promise<void> {
    const openPositions = this.getOpenPositions();

    if (openPositions.length === 0) {
      return;
    }

    // Separate positions by DEX type for batch processing
    const pumpfunPositions = openPositions.filter(p => p.dex === 'pumpfun');

    // Batch fetch all pumpfun bonding curves at once
    if (pumpfunPositions.length > 0) {
      try {
        const bondingCurves = pumpfunPositions.map(p => p.pool);
        // Use RpcProviderManager for batch fetching if available
        const accounts = this.rpcProviderManager
          ? await this.rpcProviderManager.getMultipleAccountsInfo(bondingCurves)
          : await getCachedMultipleAccountsInfo(this.connection, bondingCurves);

        for (let i = 0; i < pumpfunPositions.length; i++) {
          const position = pumpfunPositions[i];
          const account = accounts[i];

          if (!position || !account) continue;

          try {
            const state = parsePumpfunBondingCurveState(account.data);
            if (state) {
              const price = Number(state.virtualSolReserves) / Number(state.virtualTokenReserves) * 1e3;
              position.currentPrice = price;
              position.pnlPercent = ((price - position.entryPrice) / position.entryPrice) * 100;

              this.emit('price_update', {
                positionId: position.id,
                currentPrice: price,
                pnlPercent: position.pnlPercent,
              });

              this.checkExitConditions(position);
            }
          } catch (error) {
            this.logger.debug(
              { error, positionId: position.id },
              'Failed to parse bonding curve for position'
            );
          }
        }
      } catch (error) {
        this.logger.warn({ error }, 'Error batch fetching pumpfun prices');
      }
    }

    // Handle other DEX positions individually (TODO: batch these too)
    const otherPositions = openPositions.filter(p => p.dex !== 'pumpfun');
    for (const position of otherPositions) {
      try {
        await this.updatePositionPrice(position);
        this.checkExitConditions(position);
      } catch (error) {
        this.logger.warn(
          { error, positionId: position.id },
          'Error updating position price'
        );
      }
    }
  }

  /**
   * Update position's current price (for non-pumpfun positions)
   */
  private async updatePositionPrice(position: Position): Promise<void> {
    // Pumpfun positions are handled by batch fetch in checkPositions()
    if (position.dex === 'pumpfun') {
      return;
    }

    // TODO: Implement price fetching for other DEXes (Raydium, Orca)
    // For now, skip non-pumpfun positions
    this.logger.debug(
      { positionId: position.id, dex: position.dex },
      'Price fetching not implemented for this DEX'
    );
  }

  /**
   * Check if position should be exited
   */
  private checkExitConditions(position: Position): void {
    if (position.status !== 'open') {
      return;
    }

    // Take profit check
    if (position.currentPrice >= position.takeProfitPrice) {
      this.logger.info({
        positionId: position.id,
        currentPrice: position.currentPrice,
        takeProfitPrice: position.takeProfitPrice,
        pnlPercent: position.pnlPercent,
      }, 'Take profit triggered');

      position.status = 'closing';
      this.emit('exit_trigger', {
        position,
        reason: 'take_profit',
      });
      return;
    }

    // Stop loss check
    if (position.currentPrice <= position.stopLossPrice) {
      this.logger.info({
        positionId: position.id,
        currentPrice: position.currentPrice,
        stopLossPrice: position.stopLossPrice,
        pnlPercent: position.pnlPercent,
      }, 'Stop loss triggered');

      position.status = 'closing';
      this.emit('exit_trigger', {
        position,
        reason: 'stop_loss',
      });
      return;
    }
  }

  /**
   * Get token balance for a position
   */
  async getPositionTokenBalance(position: Position): Promise<bigint> {
    try {
      const ata = await getAta(this.config.wallet.publicKey, position.mint);
      const account = await getAccount(this.connection, ata, 'confirmed');
      return account.amount;
    } catch {
      return 0n;
    }
  }

  /**
   * Get portfolio summary
   */
  getPortfolioSummary(): {
    totalPositions: number;
    openPositions: number;
    totalSolInvested: number;
    totalPnlPercent: number;
    positions: Position[];
  } {
    const allPositions = this.getAllPositions();
    const openPositions = allPositions.filter(p => p.status === 'open');
    
    const totalSolInvested = openPositions.reduce((sum, p) => sum + p.solSpent, 0);
    
    // Weighted average PnL
    const totalPnlPercent = openPositions.length > 0
      ? openPositions.reduce((sum, p) => sum + (p.pnlPercent * p.solSpent), 0) / totalSolInvested
      : 0;

    return {
      totalPositions: allPositions.length,
      openPositions: openPositions.length,
      totalSolInvested,
      totalPnlPercent,
      positions: openPositions,
    };
  }

  /**
   * Clear closed positions (cleanup)
   */
  clearClosedPositions(): void {
    const closedIds: string[] = [];
    
    for (const [id, position] of this.positions) {
      if (position.status === 'closed') {
        closedIds.push(id);
      }
    }

    for (const id of closedIds) {
      this.positions.delete(id);
    }

    this.logger.info({ count: closedIds.length }, 'Cleared closed positions');
  }
}
