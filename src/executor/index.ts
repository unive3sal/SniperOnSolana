import {
  Connection,
  PublicKey,
  Keypair,
  TransactionInstruction,
  ComputeBudgetProgram,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import type { Logger } from 'pino';
import type { Config, SwapResult, DexType, BundleResult } from '../config/types.js';
import { COMPUTE_BUDGET } from '../config/constants.js';
import { RpcProviderManager } from '../utils/rpc-provider.js';
import { JitoClient, buildVersionedTransaction } from './jito/client.js';
import { TipManager } from './jito/tip.js';
import { buildPumpfunBuyInstruction, buildPumpfunSellInstruction, getPumpfunPrice } from './builder/pumpfun.js';
import { retry } from '../utils/retry.js';

// Re-export
export * from './jito/client.js';
export * from './jito/tip.js';
export * from './builder/pumpfun.js';

/**
 * Swap request
 */
export interface SwapRequest {
  dex: DexType;
  mint: PublicKey;
  pool: PublicKey;
  type: 'buy' | 'sell';
  solAmount?: number; // For buy
  tokenAmount?: bigint; // For sell
  slippageBps?: number;
  priorityFee?: number;
}

/**
 * Executor module for transaction building and submission
 */
export class ExecutorModule {
  private readonly config: Config;
  private readonly logger: Logger;
  private readonly rpcProviderManager: RpcProviderManager | null;
  private readonly connection: Connection;
  private readonly jitoClient: JitoClient;
  private readonly tipManager: TipManager;

  constructor(config: Config, logger: Logger, rpcProviderManager?: RpcProviderManager) {
    this.config = config;
    this.logger = logger.child({ module: 'executor' });
    this.rpcProviderManager = rpcProviderManager ?? null;

    // Use RpcProviderManager if available, otherwise fall back to direct connection
    if (rpcProviderManager) {
      this.connection = rpcProviderManager.getConnection();
      this.logger.info('ExecutorModule using RpcProviderManager');
    } else {
      this.connection = new Connection(config.network.heliusRpcUrl, {
        commitment: 'confirmed',
      });
      this.logger.info('ExecutorModule using direct Helius connection');
    }

    this.jitoClient = new JitoClient(config.jito.blockEngineUrl, this.logger);
    this.tipManager = new TipManager(config.jito, this.logger);
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
   * Execute a swap via Jito bundle
   */
  async executeSwap(request: SwapRequest): Promise<SwapResult> {
    const startTime = Date.now();
    const timings: Record<string, number> = {};

    this.logger.info({
      dex: request.dex,
      mint: request.mint.toBase58(),
      type: request.type,
      solAmount: request.solAmount,
      tokenAmount: request.tokenAmount?.toString(),
    }, 'perf:executeSwap starting');

    // Dry run check
    if (this.config.mode.dryRun) {
      this.logger.info('Dry run mode - swap not executed');
      return {
        success: true,
        latencyMs: Date.now() - startTime,
      };
    }

    try {
      // Build swap instructions
      const buildInstructionsStart = Date.now();
      const instructions = await this.buildSwapInstructions(request);
      timings.buildInstructionsMs = Date.now() - buildInstructionsStart;

      if (instructions.length === 0) {
        throw new Error('No instructions built');
      }

      // Add compute budget
      const computeInstructions = this.buildComputeBudgetInstructions(
        request.priorityFee ?? COMPUTE_BUDGET.HIGH_PRIORITY_FEE
      );

      // Calculate tip
      const tipCalc = this.tipManager.calculateTip('dynamic', {
        expectedProfitLamports: request.solAmount
          ? request.solAmount * LAMPORTS_PER_SOL * 0.1 // Assume 10% profit
          : 0,
      });

      // Add tip instruction
      const tipInstruction = this.jitoClient.createTipInstruction(
        this.config.wallet.publicKey,
        tipCalc.tipLamports
      );

      // Combine all instructions
      const allInstructions = [
        ...computeInstructions,
        ...instructions,
        tipInstruction,
      ];

      // Build versioned transaction
      const buildTxStart = Date.now();
      const tx = await buildVersionedTransaction(
        this.connection,
        this.config.wallet.publicKey,
        allInstructions,
        [this.config.wallet.keypair]
      );
      timings.buildTxMs = Date.now() - buildTxStart;

      // Submit via Jito
      const jitoSubmitStart = Date.now();
      const bundleResult = await this.jitoClient.sendBundle([tx], this.connection);
      timings.jitoSubmitMs = Date.now() - jitoSubmitStart;

      // Record tip for statistics
      this.tipManager.recordTip(tipCalc.tipLamports, bundleResult.landed);

      if (!bundleResult.success) {
        // Try fallback to direct RPC
        this.logger.warn(
          {
            ...timings,
            totalLatencyMs: Date.now() - startTime,
          },
          'perf:executeSwap Jito bundle failed, trying direct RPC fallback'
        );
        return this.executeFallbackWithTimings(allInstructions, startTime, timings);
      }

      const latencyMs = Date.now() - startTime;

      // Get execution price if possible
      let price: number | undefined;
      try {
        if (request.dex === 'pumpfun') {
          const priceStart = Date.now();
          price = await getPumpfunPrice(this.connection, request.pool);
          timings.priceFetchMs = Date.now() - priceStart;
        }
      } catch {
        // Price fetch optional
      }

      this.logger.info({
        dex: request.dex,
        type: request.type,
        bundleId: bundleResult.bundleId,
        slot: bundleResult.slot,
        tipLamports: tipCalc.tipLamports,
        instructionCount: allInstructions.length,
        ...timings,
        totalLatencyMs: latencyMs,
      }, 'perf:executeSwap success via Jito');

      return {
        success: true,
        txHash: bundleResult.bundleId,
        price,
        latencyMs,
      };
    } catch (error) {
      const latencyMs = Date.now() - startTime;
      this.logger.error({
        error,
        ...timings,
        totalLatencyMs: latencyMs,
      }, 'perf:executeSwap failed');

      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        latencyMs,
      };
    }
  }

  /**
   * Build swap instructions based on DEX
   */
  private async buildSwapInstructions(request: SwapRequest): Promise<TransactionInstruction[]> {
    const slippageBps = request.slippageBps ?? this.config.trading.maxSlippageBps;

    switch (request.dex) {
      case 'pumpfun':
        if (request.type === 'buy') {
          return buildPumpfunBuyInstruction(
            this.connection,
            {
              mint: request.mint,
              bondingCurve: request.pool,
              owner: this.config.wallet.publicKey,
              solAmount: request.solAmount,
              slippageBps,
            },
            this.logger
          );
        } else {
          return buildPumpfunSellInstruction(
            this.connection,
            {
              mint: request.mint,
              bondingCurve: request.pool,
              owner: this.config.wallet.publicKey,
              tokenAmount: request.tokenAmount,
              slippageBps,
            },
            this.logger
          );
        }

      case 'raydium':
        // TODO: Implement Raydium swap builder
        throw new Error('Raydium swaps not yet implemented');

      default:
        throw new Error(`Unsupported DEX: ${request.dex}`);
    }
  }

  /**
   * Build compute budget instructions
   */
  private buildComputeBudgetInstructions(priorityFee: number): TransactionInstruction[] {
    return [
      ComputeBudgetProgram.setComputeUnitLimit({
        units: COMPUTE_BUDGET.DEFAULT_UNITS,
      }),
      ComputeBudgetProgram.setComputeUnitPrice({
        microLamports: priorityFee,
      }),
    ];
  }

  /**
   * Fallback to direct RPC submission with provider failover
   */
  private async executeFallbackWithTimings(
    instructions: TransactionInstruction[],
    startTime: number,
    priorTimings: Record<string, number> = {}
  ): Promise<SwapResult> {
    const fallbackStart = Date.now();
    const timings: Record<string, number> = { ...priorTimings };

    try {
      // Remove tip instruction for direct submission
      const instructionsNoTip = instructions.slice(0, -1);
      const connection = this.getBestConnection();

      const buildTxStart = Date.now();
      const tx = await buildVersionedTransaction(
        connection,
        this.config.wallet.publicKey,
        instructionsNoTip,
        [this.config.wallet.keypair]
      );
      timings.fallbackBuildTxMs = Date.now() - buildTxStart;

      // Use RpcProviderManager for failover if available
      let signature: string;
      const sendStart = Date.now();
      if (this.rpcProviderManager) {
        signature = await this.rpcProviderManager.sendTransaction(tx, {
          skipPreflight: true,
          maxRetries: 3,
        });
      } else {
        signature = await retry(
          async () => {
            return connection.sendTransaction(tx, {
              skipPreflight: true,
              maxRetries: 3,
            });
          },
          { maxAttempts: 3, baseDelayMs: 1000 },
          this.logger
        );
      }
      timings.fallbackSendMs = Date.now() - sendStart;

      // Wait for confirmation
      const confirmStart = Date.now();
      const confirmation = await connection.confirmTransaction(
        signature,
        'confirmed'
      );
      timings.fallbackConfirmMs = Date.now() - confirmStart;

      if (confirmation.value.err) {
        throw new Error(`Transaction failed: ${JSON.stringify(confirmation.value.err)}`);
      }

      const latencyMs = Date.now() - startTime;
      timings.fallbackTotalMs = Date.now() - fallbackStart;

      this.logger.info({
        signature,
        ...timings,
        totalLatencyMs: latencyMs,
      }, 'perf:executeFallback success via direct RPC');

      return {
        success: true,
        txHash: signature,
        latencyMs,
      };
    } catch (error) {
      const latencyMs = Date.now() - startTime;
      timings.fallbackTotalMs = Date.now() - fallbackStart;

      this.logger.error({
        error,
        ...timings,
        totalLatencyMs: latencyMs,
      }, 'perf:executeFallback failed');

      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        latencyMs,
      };
    }
  }

  /**
   * Execute a buy operation
   */
  async buy(
    dex: DexType,
    mint: PublicKey,
    pool: PublicKey,
    solAmount?: number
  ): Promise<SwapResult> {
    return this.executeSwap({
      dex,
      mint,
      pool,
      type: 'buy',
      solAmount: solAmount ?? this.config.trading.buyAmountSol,
    });
  }

  /**
   * Execute a sell operation
   */
  async sell(
    dex: DexType,
    mint: PublicKey,
    pool: PublicKey,
    tokenAmount: bigint
  ): Promise<SwapResult> {
    return this.executeSwap({
      dex,
      mint,
      pool,
      type: 'sell',
      tokenAmount,
    });
  }

  /**
   * Get connection
   */
  getConnection(): Connection {
    return this.connection;
  }

  /**
   * Get tip manager
   */
  getTipManager(): TipManager {
    return this.tipManager;
  }

  /**
   * Get Jito client
   */
  getJitoClient(): JitoClient {
    return this.jitoClient;
  }
}
