import { PublicKey } from '@solana/web3.js';
import { loadConfig, validateConfig, getConfigSummary } from './config/index.js';
import { createLogger, createModuleLogger, bootstrapLogger } from './utils/logger.js';
import { RpcProviderManager } from './utils/rpc-provider.js';
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
  private readonly rpcProviderManager: RpcProviderManager;
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
    // Global RPS is the sum of per-provider limits (shared by all direct connection calls)
    const globalRps = this.config.network.shyftRpcRps + this.config.network.heliusRpcRps;
    setRateLimitRps(globalRps);
    setCacheTtlMs(this.config.network.rpcCacheTtlMs);
    this.logger.info({
      globalRps,
      shyftRps: this.config.network.shyftRpcRps,
      heliusRps: this.config.network.heliusRpcRps,
      cacheTtlMs: this.config.network.rpcCacheTtlMs,
    }, 'RPC rate limiter and cache initialized');

    // Create shared RPC provider manager for multi-provider load balancing and failover
    this.rpcProviderManager = new RpcProviderManager(this.config.network, this.logger, {
      maxConsecutiveFailures: 3,
      healthRecoveryCooldownMs: 30000,
      cacheTtlMs: this.config.network.rpcCacheTtlMs,
    });

    this.logger.info(
      { providers: this.rpcProviderManager.getHealthStatus().map(p => p.name) },
      'RPC provider manager initialized'
    );

    // Initialize modules with shared RpcProviderManager
    this.monitor = new MonitorCoordinator(this.config, this.logger, this.rpcProviderManager);
    this.security = new SecurityModule(this.config, this.logger, this.rpcProviderManager);
    this.executor = new ExecutorModule(this.config, this.logger, this.rpcProviderManager);
    this.positions = new PositionManager(this.config, this.logger, this.rpcProviderManager);
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

    // Initialize RPC provider manager (verify connections)
    await this.rpcProviderManager.initialize();
    this.logger.info(
      { healthStatus: this.rpcProviderManager.getHealthStatus() },
      'RPC provider connections verified'
    );

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
    this.logger.info({ mode: this.monitor.getMonitorMode() }, 'Monitor started');

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
    const pipelineStartTime = Date.now();
    const mintStr = event.mint.toBase58();
    const timings: Record<string, number> = {};

    this.logger.info({
      dex: event.dex,
      mint: mintStr,
      pool: event.pool.toBase58(),
      slot: event.slot,
      timestamp: pipelineStartTime,
    }, 'perf:pipeline pool detected - starting pipeline');

    // Check if we already have a position in this token
    const existingPosition = this.positions.getPositionByMint(event.mint);
    if (existingPosition) {
      this.logger.info({
        mint: mintStr,
        pipelineLatencyMs: Date.now() - pipelineStartTime,
        outcome: 'skipped_existing_position',
      }, 'perf:pipeline skipped - already have position');
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
      const analysisStartTime = Date.now();
      const analysis = await this.security.analyze(analysisRequest);
      timings.securityAnalysisMs = Date.now() - analysisStartTime;

      this.logger.info({
        mint: mintStr,
        score: analysis.score,
        passed: analysis.passed,
        warnings: analysis.warnings,
        securityAnalysisMs: timings.securityAnalysisMs,
      }, 'perf:pipeline security analysis completed');

      // Check if analysis passed
      if (!analysis.passed) {
        this.logger.info({
          mint: mintStr,
          score: analysis.score,
          warnings: analysis.warnings,
          ...timings,
          pipelineLatencyMs: Date.now() - pipelineStartTime,
          outcome: 'rejected_security_failed',
        }, 'perf:pipeline rejected - security analysis failed');
        return;
      }

      // Check score threshold
      if (analysis.score < this.config.security.riskScoreThreshold) {
        this.logger.info({
          mint: mintStr,
          score: analysis.score,
          threshold: this.config.security.riskScoreThreshold,
          ...timings,
          pipelineLatencyMs: Date.now() - pipelineStartTime,
          outcome: 'rejected_score_below_threshold',
        }, 'perf:pipeline rejected - score below threshold');
        return;
      }

      // Execute buy
      const buyStartTime = Date.now();
      this.logger.info({
        mint: mintStr,
        dex: event.dex,
        amount: this.config.trading.buyAmountSol,
        timeToExecuteMs: Date.now() - pipelineStartTime,
      }, 'perf:pipeline executing buy');

      const result = await this.executor.buy(
        event.dex,
        event.mint,
        event.pool,
        this.config.trading.buyAmountSol
      );
      timings.buyExecutionMs = Date.now() - buyStartTime;

      if (result.success) {
        // Open position
        const positionStartTime = Date.now();
        await this.positions.openPosition(
          event.mint,
          event.pool,
          event.dex,
          result.price ?? 0,
          this.config.trading.buyAmountSol,
          result.tokenAmount ?? 0,
          result.txHash ?? ''
        );
        timings.openPositionMs = Date.now() - positionStartTime;

        const totalPipelineMs = Date.now() - pipelineStartTime;
        this.logger.info({
          mint: mintStr,
          dex: event.dex,
          txHash: result.txHash,
          price: result.price,
          score: analysis.score,
          ...timings,
          pipelineLatencyMs: totalPipelineMs,
          outcome: 'success',
        }, 'perf:pipeline SUCCESS - buy executed');
      } else {
        const totalPipelineMs = Date.now() - pipelineStartTime;
        this.logger.error({
          mint: mintStr,
          error: result.error,
          ...timings,
          pipelineLatencyMs: totalPipelineMs,
          outcome: 'failed_buy_execution',
        }, 'perf:pipeline FAILED - buy execution error');
      }
    } catch (error) {
      const totalPipelineMs = Date.now() - pipelineStartTime;
      this.logger.error({
        error,
        mint: mintStr,
        ...timings,
        pipelineLatencyMs: totalPipelineMs,
        outcome: 'error',
      }, 'perf:pipeline ERROR - exception thrown');
    }
  }

  /**
   * Handle position exit trigger
   */
  private async handleExitTrigger(
    position: Position,
    reason: 'take_profit' | 'stop_loss'
  ): Promise<void> {
    const exitStartTime = Date.now();
    const mintStr = position.mint.toBase58();
    const timings: Record<string, number> = {};

    this.logger.info({
      positionId: position.id,
      mint: mintStr,
      reason,
      pnlPercent: position.pnlPercent.toFixed(2),
      timestamp: exitStartTime,
    }, 'perf:exit starting exit pipeline');

    try {
      // Get token balance
      const balanceStartTime = Date.now();
      const tokenBalance = await this.positions.getPositionTokenBalance(position);
      timings.getBalanceMs = Date.now() - balanceStartTime;

      if (tokenBalance === 0n) {
        this.logger.warn({
          positionId: position.id,
          ...timings,
          exitLatencyMs: Date.now() - exitStartTime,
          outcome: 'no_tokens',
        }, 'perf:exit no tokens to sell');
        this.positions.closePosition(position.id, reason);
        return;
      }

      // Execute sell
      const sellStartTime = Date.now();
      const result = await this.executor.sell(
        position.dex,
        position.mint,
        position.pool,
        tokenBalance
      );
      timings.sellExecutionMs = Date.now() - sellStartTime;

      if (result.success) {
        const closeStartTime = Date.now();
        this.positions.closePosition(
          position.id,
          reason,
          result.txHash,
          result.price
        );
        timings.closePositionMs = Date.now() - closeStartTime;

        const totalExitMs = Date.now() - exitStartTime;
        this.logger.info({
          positionId: position.id,
          mint: mintStr,
          txHash: result.txHash,
          pnlPercent: position.pnlPercent.toFixed(2),
          reason,
          tokenBalance: tokenBalance.toString(),
          ...timings,
          exitLatencyMs: totalExitMs,
          outcome: 'success',
        }, 'perf:exit SUCCESS - position closed');
      } else {
        const totalExitMs = Date.now() - exitStartTime;
        this.logger.error({
          positionId: position.id,
          mint: mintStr,
          error: result.error,
          ...timings,
          exitLatencyMs: totalExitMs,
          outcome: 'sell_failed',
        }, 'perf:exit FAILED - sell execution error');

        // Reset position status so it can be tried again
        position.status = 'open';
      }
    } catch (error) {
      const totalExitMs = Date.now() - exitStartTime;
      this.logger.error({
        error,
        positionId: position.id,
        mint: mintStr,
        ...timings,
        exitLatencyMs: totalExitMs,
        outcome: 'error',
      }, 'perf:exit ERROR - exception thrown');
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
    monitorMode: string;
    openPositions: number;
    stats: ReturnType<MonitorCoordinator['getStats']>;
    sweepStats: ReturnType<WalletSweepManager['getStats']>;
    rpcProviderHealth: ReturnType<RpcProviderManager['getHealthStatus']>;
  } {
    return {
      isRunning: this.isRunning,
      monitorStatus: this.monitor.getConnectionStatus(),
      monitorMode: this.monitor.getMonitorMode(),
      openPositions: this.positions.getOpenPositions().length,
      stats: this.monitor.getStats(),
      sweepStats: this.sweep.getStats(),
      rpcProviderHealth: this.rpcProviderManager.getHealthStatus(),
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
