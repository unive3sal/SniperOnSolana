import { Connection, PublicKey, SystemProgram, TransactionInstruction, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { EventEmitter } from 'events';
import type { Logger } from 'pino';
import type { Config } from '../config/types.js';
import { TIMING } from '../config/constants.js';
import { getSolBalance } from '../utils/wallet.js';
import { buildVersionedTransaction } from '../executor/jito/client.js';
import { retry } from '../utils/retry.js';

/**
 * Sweep result
 */
export interface SweepResult {
  success: boolean;
  amount?: number; // SOL transferred
  txHash?: string;
  error?: string;
  timestamp: number;
}

/**
 * Wallet sweep manager for auto-transferring excess SOL
 */
export class WalletSweepManager extends EventEmitter {
  private readonly config: Config;
  private readonly logger: Logger;
  private readonly connection: Connection;
  private checkInterval: NodeJS.Timeout | null = null;
  private isRunning = false;
  private lastSweepTime = 0;
  private sweepStats = {
    totalSwept: 0,
    successCount: 0,
    failureCount: 0,
  };

  constructor(config: Config, logger: Logger, connection: Connection) {
    super();
    this.config = config;
    this.logger = logger.child({ module: 'sweep' });
    this.connection = connection;
  }

  /**
   * Start auto-sweep monitoring
   */
  start(): void {
    if (!this.config.autoSweep.enabled) {
      this.logger.info('Auto-sweep disabled, not starting');
      return;
    }

    if (this.isRunning) {
      this.logger.warn('Auto-sweep already running');
      return;
    }

    if (!this.config.autoSweep.coldWalletAddress) {
      this.logger.error('Cold wallet address not configured');
      return;
    }

    this.isRunning = true;
    this.logger.info({
      coldWallet: this.config.autoSweep.coldWalletAddress.toBase58(),
      thresholdSol: this.config.autoSweep.thresholdSol,
      intervalMs: this.config.autoSweep.checkIntervalMs,
    }, 'Starting auto-sweep monitoring');

    // Run first check immediately
    this.checkAndSweep().catch((error) => {
      this.logger.error({ error }, 'Initial sweep check failed');
    });

    // Schedule periodic checks
    this.checkInterval = setInterval(
      () => this.checkAndSweep().catch((error) => {
        this.logger.error({ error }, 'Periodic sweep check failed');
      }),
      this.config.autoSweep.checkIntervalMs
    );

    this.emit('started');
  }

  /**
   * Stop auto-sweep monitoring
   */
  stop(): void {
    if (!this.isRunning) {
      return;
    }

    this.isRunning = false;

    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }

    this.logger.info({ stats: this.sweepStats }, 'Stopped auto-sweep monitoring');
    this.emit('stopped');
  }

  /**
   * Check balance and sweep if needed
   */
  private async checkAndSweep(): Promise<void> {
    if (!this.config.autoSweep.enabled || !this.config.autoSweep.coldWalletAddress) {
      return;
    }

    try {
      // Get current balance
      const balance = await getSolBalance(this.connection, this.config.wallet.publicKey);
      const threshold = this.config.autoSweep.thresholdSol;

      this.logger.debug({
        balance: balance.toFixed(4),
        threshold: threshold.toFixed(4),
      }, 'Checking balance for sweep');

      // Check if balance exceeds threshold
      if (balance <= threshold) {
        this.logger.debug('Balance below threshold, no sweep needed');
        return;
      }

      // Calculate transfer amount (keep threshold, transfer excess)
      const transferAmount = balance - threshold;

      // Check minimum transfer amount (dust threshold)
      if (transferAmount < TIMING.AUTO_SWEEP_MIN_TRANSFER_SOL) {
        this.logger.debug({ transferAmount }, 'Transfer amount below dust threshold');
        return;
      }

      // Execute sweep
      this.logger.info({
        balance: balance.toFixed(4),
        threshold: threshold.toFixed(4),
        transferAmount: transferAmount.toFixed(4),
      }, 'Executing sweep');

      const result = await this.executeSweep(transferAmount);

      if (result.success) {
        this.sweepStats.totalSwept += transferAmount;
        this.sweepStats.successCount++;
        this.lastSweepTime = Date.now();

        this.logger.info({
          amount: transferAmount.toFixed(4),
          txHash: result.txHash,
          coldWallet: this.config.autoSweep.coldWalletAddress.toBase58(),
        }, 'Sweep executed successfully');

        this.emit('sweep_success', result);
      } else {
        this.sweepStats.failureCount++;

        this.logger.error({
          error: result.error,
          amount: transferAmount.toFixed(4),
        }, 'Sweep execution failed');

        this.emit('sweep_failure', result);
      }
    } catch (error) {
      this.logger.error({ error }, 'Error during sweep check');
      this.emit('sweep_error', { error: error instanceof Error ? error.message : String(error) });
    }
  }

  /**
   * Execute sweep transaction with retry logic
   */
  private async executeSweep(amountSol: number): Promise<SweepResult> {
    const startTime = Date.now();

    // Dry run check
    if (this.config.mode.dryRun) {
      this.logger.info({ amount: amountSol }, 'DRY RUN: Would sweep SOL to cold wallet');
      return {
        success: true,
        amount: amountSol,
        txHash: 'dry-run',
        timestamp: startTime,
      };
    }

    try {
      const result = await retry(
        async () => this.buildAndSendSweepTx(amountSol),
        {
          maxAttempts: 3,
          baseDelayMs: 5000, // First retry after 5s
          maxDelayMs: 45000, // Cap at 45s
          backoffMultiplier: 3, // 5s, 15s, 45s
          onRetry: (error, attempt) => {
            this.logger.warn({
              attempt,
              error: error.message,
              nextRetryIn: this.calculateNextRetryDelay(attempt),
            }, 'Sweep attempt failed, retrying...');
          },
        },
        this.logger
      );

      return {
        success: true,
        amount: amountSol,
        txHash: result,
        timestamp: startTime,
      };
    } catch (error) {
      return {
        success: false,
        amount: amountSol,
        error: error instanceof Error ? error.message : String(error),
        timestamp: startTime,
      };
    }
  }

  /**
   * Build and send sweep transaction
   */
  private async buildAndSendSweepTx(amountSol: number): Promise<string> {
    const lamports = Math.floor(amountSol * LAMPORTS_PER_SOL);

    // Create transfer instruction
    const transferIx = SystemProgram.transfer({
      fromPubkey: this.config.wallet.publicKey,
      toPubkey: this.config.autoSweep.coldWalletAddress!,
      lamports,
    });

    // Build versioned transaction (no compute budget needed for simple transfer)
    const tx = await buildVersionedTransaction(
      this.connection,
      this.config.wallet.publicKey,
      [transferIx],
      [this.config.wallet.keypair]
    );

    // Send transaction
    const signature = await this.connection.sendTransaction(tx, {
      skipPreflight: false, // Preflight to catch errors
      maxRetries: 0, // We handle retries ourselves
    });

    // Wait for confirmation
    const confirmation = await this.connection.confirmTransaction(signature, 'confirmed');

    if (confirmation.value.err) {
      throw new Error(`Transaction failed: ${JSON.stringify(confirmation.value.err)}`);
    }

    return signature;
  }

  /**
   * Calculate next retry delay
   */
  private calculateNextRetryDelay(attempt: number): string {
    const delays = [5000, 15000, 45000];
    const delayMs = delays[attempt - 1] || 45000;
    return `${delayMs / 1000}s`;
  }

  /**
   * Get sweep statistics
   */
  getStats(): {
    totalSwept: number;
    successCount: number;
    failureCount: number;
    lastSweepTime: number;
    isRunning: boolean;
  } {
    return {
      ...this.sweepStats,
      lastSweepTime: this.lastSweepTime,
      isRunning: this.isRunning,
    };
  }

  /**
   * Manual sweep trigger (for testing or user-initiated sweep)
   */
  async manualSweep(amountSol?: number): Promise<SweepResult> {
    if (!this.config.autoSweep.coldWalletAddress) {
      return {
        success: false,
        error: 'Cold wallet address not configured',
        timestamp: Date.now(),
      };
    }

    let transferAmount = amountSol;

    if (!transferAmount) {
      // Calculate amount based on current balance
      const balance = await getSolBalance(this.connection, this.config.wallet.publicKey);
      transferAmount = Math.max(0, balance - this.config.autoSweep.thresholdSol);
    }

    if (transferAmount <= 0) {
      return {
        success: false,
        error: 'No excess balance to sweep',
        timestamp: Date.now(),
      };
    }

    this.logger.info({ amount: transferAmount }, 'Manual sweep triggered');
    return this.executeSweep(transferAmount);
  }
}
