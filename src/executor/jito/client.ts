import {
  Connection,
  PublicKey,
  Transaction,
  VersionedTransaction,
  TransactionMessage,
  TransactionInstruction,
  Keypair,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import type { Logger } from 'pino';
import type { BundleResult } from '../../config/types.js';
import { JITO_CONFIG } from '../../config/constants.js';
import { retry } from '../../utils/retry.js';

/**
 * Jito bundle status
 */
export type BundleStatus = 
  | 'pending'
  | 'landed'
  | 'failed'
  | 'dropped'
  | 'unknown';

/**
 * Jito bundle response
 */
interface JitoBundleResponse {
  jsonrpc: string;
  id: number;
  result?: string;
  error?: {
    code: number;
    message: string;
  };
}

/**
 * Jito bundle status response
 */
interface JitoBundleStatusResponse {
  jsonrpc: string;
  id: number;
  result?: {
    context: {
      slot: number;
    };
    value: Array<{
      bundle_id: string;
      status: string;
      landed_slot?: number;
    }>;
  };
  error?: {
    code: number;
    message: string;
  };
}

/**
 * Jito client for bundle submission
 */
export class JitoClient {
  private readonly blockEngineUrl: string;
  private readonly logger: Logger;
  private currentTipAccount: PublicKey;

  constructor(blockEngineUrl: string, logger: Logger) {
    this.blockEngineUrl = blockEngineUrl;
    this.logger = logger.child({ component: 'jito' });
    
    // Select random tip account
    this.currentTipAccount = this.getRandomTipAccount();
  }

  /**
   * Get a random Jito tip account
   */
  private getRandomTipAccount(): PublicKey {
    const index = Math.floor(Math.random() * JITO_CONFIG.TIP_ACCOUNTS.length);
    return JITO_CONFIG.TIP_ACCOUNTS[index]!;
  }

  /**
   * Rotate to a new tip account
   */
  rotateTipAccount(): void {
    this.currentTipAccount = this.getRandomTipAccount();
    this.logger.debug({ tipAccount: this.currentTipAccount.toBase58() }, 'Rotated tip account');
  }

  /**
   * Get current tip account
   */
  getTipAccount(): PublicKey {
    return this.currentTipAccount;
  }

  /**
   * Create a tip instruction
   */
  createTipInstruction(
    payer: PublicKey,
    tipLamports: number
  ): TransactionInstruction {
    return SystemProgram.transfer({
      fromPubkey: payer,
      toPubkey: this.currentTipAccount,
      lamports: tipLamports,
    });
  }

  /**
   * Send a bundle to Jito
   */
  async sendBundle(
    transactions: (Transaction | VersionedTransaction)[],
    connection: Connection
  ): Promise<BundleResult> {
    const startTime = Date.now();

    try {
      // Serialize transactions
      const serializedTxs = transactions.map(tx => {
        if (tx instanceof VersionedTransaction) {
          return Buffer.from(tx.serialize()).toString('base64');
        } else {
          return Buffer.from(tx.serialize()).toString('base64');
        }
      });

      this.logger.debug({ txCount: serializedTxs.length }, 'Sending bundle to Jito');

      // Send bundle via JSON-RPC
      const response = await retry(
        async () => {
          const res = await fetch(`${this.blockEngineUrl}/api/v1/bundles`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              method: 'sendBundle',
              params: [serializedTxs],
            }),
          });

          if (!res.ok) {
            throw new Error(`HTTP error: ${res.status}`);
          }

          return res.json() as Promise<JitoBundleResponse>;
        },
        { maxAttempts: 3, baseDelayMs: 500 },
        this.logger
      );

      if (response.error) {
        this.logger.error({ error: response.error }, 'Jito bundle submission failed');
        return {
          success: false,
          error: response.error.message,
          landed: false,
        };
      }

      const bundleId = response.result;
      if (!bundleId) {
        return {
          success: false,
          error: 'No bundle ID returned',
          landed: false,
        };
      }

      this.logger.info({ bundleId, duration: Date.now() - startTime }, 'Bundle submitted to Jito');

      // Poll for status
      const status = await this.waitForBundleStatus(bundleId, connection);

      return {
        success: status.status === 'landed',
        bundleId,
        slot: status.slot,
        error: status.status === 'failed' ? 'Bundle failed' : undefined,
        landed: status.status === 'landed',
      };
    } catch (error) {
      this.logger.error({ error }, 'Failed to send bundle');
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        landed: false,
      };
    }
  }

  /**
   * Wait for bundle status
   */
  private async waitForBundleStatus(
    bundleId: string,
    connection: Connection,
    timeoutMs: number = JITO_CONFIG.BUNDLE_TIMEOUT_MS
  ): Promise<{ status: BundleStatus; slot?: number }> {
    const startTime = Date.now();
    const pollInterval = 2000; // 2 seconds

    while (Date.now() - startTime < timeoutMs) {
      try {
        const response = await fetch(`${this.blockEngineUrl}/api/v1/bundles`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'getBundleStatuses',
            params: [[bundleId]],
          }),
        });

        if (!response.ok) {
          await this.sleep(pollInterval);
          continue;
        }

        const data = await response.json() as JitoBundleStatusResponse;

        if (data.result?.value?.[0]) {
          const bundleStatus = data.result.value[0];
          const status = this.parseStatus(bundleStatus.status);

          if (status === 'landed' || status === 'failed' || status === 'dropped') {
            this.logger.info({
              bundleId,
              status,
              slot: bundleStatus.landed_slot,
              duration: Date.now() - startTime,
            }, 'Bundle status resolved');

            return {
              status,
              slot: bundleStatus.landed_slot,
            };
          }
        }
      } catch (error) {
        this.logger.warn({ error, bundleId }, 'Error polling bundle status');
      }

      await this.sleep(pollInterval);
    }

    this.logger.warn({ bundleId, timeoutMs }, 'Bundle status poll timed out');
    return { status: 'unknown' };
  }

  /**
   * Parse Jito status string
   */
  private parseStatus(status: string): BundleStatus {
    switch (status.toLowerCase()) {
      case 'landed':
      case 'confirmed':
      case 'finalized':
        return 'landed';
      case 'failed':
      case 'rejected':
        return 'failed';
      case 'dropped':
        return 'dropped';
      case 'pending':
      case 'processing':
        return 'pending';
      default:
        return 'unknown';
    }
  }

  /**
   * Sleep helper
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Get Jito tip accounts (refresh from API)
   */
  async refreshTipAccounts(): Promise<PublicKey[]> {
    try {
      const response = await fetch(`${this.blockEngineUrl}/api/v1/bundles`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'getTipAccounts',
          params: [],
        }),
      });

      if (!response.ok) {
        throw new Error(`HTTP error: ${response.status}`);
      }

      const data = await response.json() as { result?: string[] };
      
      if (data.result && Array.isArray(data.result)) {
        const accounts = data.result.map(addr => new PublicKey(addr));
        this.logger.info({ count: accounts.length }, 'Refreshed tip accounts');
        return accounts;
      }

      return [...JITO_CONFIG.TIP_ACCOUNTS];
    } catch (error) {
      this.logger.warn({ error }, 'Failed to refresh tip accounts, using defaults');
      return [...JITO_CONFIG.TIP_ACCOUNTS];
    }
  }
}

/**
 * Build a versioned transaction from instructions
 */
export async function buildVersionedTransaction(
  connection: Connection,
  payer: PublicKey,
  instructions: TransactionInstruction[],
  signers: Keypair[] = []
): Promise<VersionedTransaction> {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');

  const messageV0 = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message();

  const tx = new VersionedTransaction(messageV0);

  if (signers.length > 0) {
    tx.sign(signers);
  }

  return tx;
}
