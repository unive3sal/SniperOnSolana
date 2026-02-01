import { PublicKey } from '@solana/web3.js';
import { loadConfig, validateConfig, getConfigSummary } from './config/index.js';
import { createLogger, createModuleLogger, bootstrapLogger } from './utils/logger.js';
import { MonitorCoordinator } from './monitor/index.js';
import { SecurityModule, type AnalysisRequest } from './security/index.js';
import { ExecutorModule } from './executor/index.js';
import { PositionManager } from './position/index.js';
import { WalletSweepManager, type SweepResult } from './sweep/index.js';
import { getSolBalance } from './utils/wallet.js';
import { setRateLimitRps, setCacheTtlMs } from './utils/rpc.js';
import type { Logger } from 'pino';
import type { Position } from './config/types.js';
import type { NewPoolEvent } from './monitor/types.js';

/**
 * Main Sniper Bot Application
 */
class SniperBot {
  private readonly config;
  private readonly logger: Logger;
  private readonly monitor: MonitorCoordinator;
  private readonly security: SecurityModule;
  private readonly executor: ExecutorModule;
  private readonly positions: PositionManager;
  private readonly sweep: WalletSweepManager;
  private isRunning = false;

  constructor() {
    // Load and validate config
    this.config = loadConfig();
    validateConfig(this.config);

    // Create logger
    this.logger = createLogger(this.config.logging);

    // Initialize global rate limiter and cache with configured values
    setRateLimitRps(this.config.network.rpcRateLimitRps);
    setCacheTtlMs(this.config.network.rpcCacheTtlMs);
    this.logger.info({
      rps: this.config.network.rpcRateLimitRps,
      cacheTtlMs: this.config.network.rpcCacheTtlMs,
    }, 'RPC rate limiter and cache initialized');

    // Initialize modules
    this.monitor = new MonitorCoordinator(this.config, this.logger);
    this.security = new SecurityModule(this.config, this.logger);
    this.executor = new ExecutorModule(this.config, this.logger);
    this.positions = new PositionManager(this.config, this.logger);
    this.sweep = new WalletSweepManager(this.config, this.logger, this.executor.getConnection());
  }

  /**
   * Start the sniper bot
   */
  async start(): Promise<void> {
    this.logger.info({ config: getConfigSummary(this.config) }, 'Starting Solana Sniper Bot');

    // Log mode warnings
    if (this.config.mode.dryRun) {
      this.logger.warn('=== DRY RUN MODE - No transactions will be executed ===');
    }
    if (this.config.mode.useDevnet) {
      this.logger.warn('=== DEVNET MODE ===');
    }

    // Check wallet balance
    try {
      const balance = await getSolBalance(
        this.executor.getConnection(),
        this.config.wallet.publicKey
      );
      this.logger.info({ 
        wallet: this.config.wallet.publicKey.toBase58(),
        balance: balance.toFixed(4),
      }, 'Wallet balance');

      if (balance < this.config.trading.buyAmountSol + 0.01) {
        this.logger.warn('Wallet balance may be insufficient for trading');
      }
    } catch (error) {
      this.logger.warn({ error }, 'Could not check wallet balance');
    }

    // Setup event handlers
    this.setupEventHandlers();

    // Start monitoring
    await this.monitor.start();

    // Start position monitoring
    this.positions.startMonitoring();

    // Start auto-sweep if enabled
    this.sweep.start();

    this.isRunning = true;
    this.logger.info('Sniper bot is now running. Listening for new pools...');
  }

  /**
   * Setup event handlers
   */
  private setupEventHandlers(): void {
    // Handle new pool events
    this.monitor.on('new_pool', async (event: NewPoolEvent) => {
      await this.handleNewPool(event);
    });

    // Handle position exit triggers
    this.positions.on('exit_trigger', async ({ position, reason }) => {
      await this.handleExitTrigger(position, reason);
    });

    // Handle monitor connection events
    this.monitor.on('connected', ({ source }) => {
      this.logger.info({ source }, 'Monitor connected');
    });

    this.monitor.on('disconnected', ({ source }) => {
      this.logger.warn({ source }, 'Monitor disconnected');
    });

    this.monitor.on('error', ({ source, error }) => {
      this.logger.error({ source, error }, 'Monitor error');
    });

    // Handle position events
    this.positions.on('position_opened', (position: Position) => {
      this.logger.info({
        id: position.id,
        mint: position.mint.toBase58(),
        solSpent: position.solSpent,
      }, 'Position opened event');
    });

    this.positions.on('position_closed', (position: Position) => {
      this.logger.info({
        id: position.id,
        mint: position.mint.toBase58(),
        pnlPercent: position.pnlPercent.toFixed(2),
        exitReason: position.exitReason,
      }, 'Position closed event');
    });

    // Handle sweep events
    this.sweep.on('sweep_success', (result: SweepResult) => {
      this.logger.info({
        amount: result.amount?.toFixed(4),
        txHash: result.txHash,
      }, 'Auto-sweep completed successfully');
    });

    this.sweep.on('sweep_failure', (result: SweepResult) => {
      this.logger.error({
        amount: result.amount?.toFixed(4),
        error: result.error,
      }, 'Auto-sweep failed');
    });

    this.sweep.on('sweep_error', ({ error }: { error: string }) => {
      this.logger.error({ error }, 'Auto-sweep error');
    });
  }

  /**
   * Handle a new pool detection
   */
  private async handleNewPool(event: NewPoolEvent): Promise<void> {
    const mintStr = event.mint.toBase58();

    this.logger.info({
      dex: event.dex,
      mint: mintStr,
      pool: event.pool.toBase58(),
      slot: event.slot,
    }, 'New pool detected');

    // Check if we already have a position in this token
    const existingPosition = this.positions.getPositionByMint(event.mint);
    if (existingPosition) {
      this.logger.info({ mint: mintStr }, 'Already have position in this token, skipping');
      return;
    }

    try {
      // Build analysis request
      const analysisRequest: AnalysisRequest = {
        mint: event.mint,
        pool: event.pool,
        dex: event.dex,
        baseMint: event.baseMint,
        quoteMint: event.quoteMint,
        baseVault: event.baseVault,
        quoteVault: event.quoteVault,
        lpMint: event.lpMint,
      };

      // Run security analysis
      this.logger.info({ mint: mintStr }, 'Running security analysis...');
      const analysis = await this.security.analyze(analysisRequest);

      this.logger.info({
        mint: mintStr,
        score: analysis.score,
        passed: analysis.passed,
        warnings: analysis.warnings,
      }, 'Security analysis completed');

      // Check if analysis passed
      if (!analysis.passed) {
        this.logger.info({
          mint: mintStr,
          score: analysis.score,
          warnings: analysis.warnings,
        }, 'Token failed security analysis, skipping');
        return;
      }

      // Check score threshold
      if (analysis.score < this.config.security.riskScoreThreshold) {
        this.logger.info({
          mint: mintStr,
          score: analysis.score,
          threshold: this.config.security.riskScoreThreshold,
        }, 'Token score below threshold, skipping');
        return;
      }

      // Execute buy
      this.logger.info({
        mint: mintStr,
        dex: event.dex,
        amount: this.config.trading.buyAmountSol,
      }, 'Executing buy...');

      const result = await this.executor.buy(
        event.dex,
        event.mint,
        event.pool,
        this.config.trading.buyAmountSol
      );

      if (result.success) {
        // Open position
        await this.positions.openPosition(
          event.mint,
          event.pool,
          event.dex,
          result.price ?? 0,
          this.config.trading.buyAmountSol,
          result.tokenAmount ?? 0,
          result.txHash ?? ''
        );

        this.logger.info({
          mint: mintStr,
          txHash: result.txHash,
          price: result.price,
          latencyMs: result.latencyMs,
        }, 'Buy executed successfully');
      } else {
        this.logger.error({
          mint: mintStr,
          error: result.error,
          latencyMs: result.latencyMs,
        }, 'Buy execution failed');
      }
    } catch (error) {
      this.logger.error({ error, mint: mintStr }, 'Error handling new pool');
    }
  }

  /**
   * Handle position exit trigger
   */
  private async handleExitTrigger(
    position: Position,
    reason: 'take_profit' | 'stop_loss'
  ): Promise<void> {
    this.logger.info({
      positionId: position.id,
      mint: position.mint.toBase58(),
      reason,
      pnlPercent: position.pnlPercent.toFixed(2),
    }, 'Exit trigger received, executing sell...');

    try {
      // Get token balance
      const tokenBalance = await this.positions.getPositionTokenBalance(position);
      
      if (tokenBalance === 0n) {
        this.logger.warn({ positionId: position.id }, 'No tokens to sell');
        this.positions.closePosition(position.id, reason);
        return;
      }

      // Execute sell
      const result = await this.executor.sell(
        position.dex,
        position.mint,
        position.pool,
        tokenBalance
      );

      if (result.success) {
        this.positions.closePosition(
          position.id,
          reason,
          result.txHash,
          result.price
        );

        this.logger.info({
          positionId: position.id,
          txHash: result.txHash,
          pnlPercent: position.pnlPercent.toFixed(2),
          reason,
        }, 'Position closed successfully');
      } else {
        this.logger.error({
          positionId: position.id,
          error: result.error,
        }, 'Sell execution failed');

        // Reset position status so it can be tried again
        position.status = 'open';
      }
    } catch (error) {
      this.logger.error({ error, positionId: position.id }, 'Error handling exit trigger');
      position.status = 'open';
    }
  }

  /**
   * Stop the sniper bot
   */
  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    this.logger.info('Stopping Sniper Bot...');
    this.isRunning = false;

    // Stop monitoring
    await this.monitor.stop();
    this.positions.stopMonitoring();
    this.sweep.stop();

    // Log final portfolio summary
    const summary = this.positions.getPortfolioSummary();
    this.logger.info({
      totalPositions: summary.totalPositions,
      openPositions: summary.openPositions,
      totalSolInvested: summary.totalSolInvested.toFixed(4),
      totalPnlPercent: summary.totalPnlPercent.toFixed(2),
    }, 'Final portfolio summary');

    this.logger.info('Sniper Bot stopped');
  }

  /**
   * Get current status
   */
  getStatus(): {
    isRunning: boolean;
    monitorStatus: string;
    openPositions: number;
    stats: ReturnType<MonitorCoordinator['getStats']>;
    sweepStats: ReturnType<WalletSweepManager['getStats']>;
  } {
    return {
      isRunning: this.isRunning,
      monitorStatus: this.monitor.getConnectionStatus(),
      openPositions: this.positions.getOpenPositions().length,
      stats: this.monitor.getStats(),
      sweepStats: this.sweep.getStats(),
    };
  }
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  bootstrapLogger.info('Initializing Solana Sniper Bot...');

  const bot = new SniperBot();

  // Setup graceful shutdown
  const shutdown = async (signal: string) => {
    bootstrapLogger.info({ signal }, 'Shutdown signal received');
    await bot.stop();
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  process.on('uncaughtException', (error) => {
    bootstrapLogger.fatal({ error }, 'Uncaught exception');
    process.exit(1);
  });

  process.on('unhandledRejection', (reason) => {
    bootstrapLogger.fatal({ reason }, 'Unhandled rejection');
    process.exit(1);
  });

  // Start the bot
  await bot.start();

  // Keep process alive
  await new Promise(() => {});
}

// Run main
main().catch((error) => {
  bootstrapLogger.fatal({ error }, 'Fatal error during startup');
  process.exit(1);
});
