import YellowstoneModule, {
  SubscribeRequest,
  SubscribeUpdate,
  CommitmentLevel,
  SubscribeUpdateAccount,
  SubscribeUpdateTransaction,
  SubscribeUpdateSlot,
  SubscribeRequestFilterAccountsFilter,
} from '@triton-one/yellowstone-grpc';
import { PublicKey } from '@solana/web3.js';
import { EventEmitter } from 'events';
import type { Logger } from 'pino';
import type { Duplex } from 'stream';
import type { NetworkConfig } from '../../config/types.js';
import type { ConnectionStatus, GrpcSubscriptionRequest } from '../types.js';
import { TIMING } from '../../config/constants.js';
import { sleep } from '../../utils/retry.js';

// Handle default export correctly
const Client = YellowstoneModule.default ?? YellowstoneModule;

/**
 * Yellowstone gRPC client wrapper with auto-reconnect
 */
export class GrpcClient extends EventEmitter {
  private client: InstanceType<typeof Client> | null = null;
  private stream: Duplex | null = null;
  private status: ConnectionStatus = 'disconnected';
  private reconnectAttempts = 0;
  private isShuttingDown = false;
  private readonly logger: Logger;
  private readonly config: NetworkConfig;

  constructor(config: NetworkConfig, logger: Logger) {
    super();
    this.config = config;
    this.logger = logger.child({ component: 'grpc-client' });
  }

  /**
   * Get current connection status
   */
  getStatus(): ConnectionStatus {
    return this.status;
  }

  /**
   * Connect to gRPC endpoint
   */
  async connect(): Promise<void> {
    if (this.status === 'connected' || this.status === 'connecting') {
      return;
    }

    this.status = 'connecting';
    this.emit('status', this.status);

    try {
      this.logger.info({ endpoint: this.config.grpcEndpoint }, 'Connecting to gRPC endpoint');

      this.client = new Client(
        this.config.grpcEndpoint,
        this.config.grpcToken,
        undefined
      );

      await this.client.connect();

      this.status = 'connected';
      this.reconnectAttempts = 0;
      this.emit('status', this.status);
      this.emit('connected');
      
      this.logger.info('gRPC connection established');
    } catch (error) {
      this.status = 'error';
      this.emit('status', this.status);
      this.emit('error', error);
      this.logger.error({ error }, 'Failed to connect to gRPC');
      throw error;
    }
  }

  /**
   * Subscribe to accounts and transactions
   */
  async subscribe(request: GrpcSubscriptionRequest): Promise<void> {
    if (!this.client) {
      throw new Error('Client not connected');
    }

    const subscribeRequest: SubscribeRequest = {
      accounts: {},
      transactions: {},
      slots: {},
      blocks: {},
      blocksMeta: {},
      entry: {},
      commitment: this.mapCommitment(request.commitment ?? 'confirmed'),
      accountsDataSlice: [],
      ping: undefined,
      transactionsStatus: {},
    };

    // Map accounts subscriptions
    if (request.accounts) {
      for (const [key, value] of Object.entries(request.accounts)) {
        const filters: SubscribeRequestFilterAccountsFilter[] = [];
        
        if (value.filters) {
          for (const f of value.filters) {
            if (f.memcmp) {
              filters.push({
                memcmp: {
                  offset: String(f.memcmp.offset),
                  base58: f.memcmp.bytes,
                },
              });
            } else if (f.dataSize !== undefined) {
              filters.push({
                datasize: String(f.dataSize),
              });
            }
          }
        }
        
        subscribeRequest.accounts[key] = {
          owner: value.owner,
          filters,
          account: [],
          nonemptyTxnSignature: false,
        };
      }
    }

    // Map transaction subscriptions
    if (request.transactions) {
      for (const [key, value] of Object.entries(request.transactions)) {
        subscribeRequest.transactions[key] = {
          accountInclude: value.accountInclude,
          accountExclude: value.accountExclude ?? [],
          accountRequired: [],
          vote: false,
          failed: false,
        };
      }
    }

    // Map slot subscriptions
    if (request.slots) {
      for (const key of Object.keys(request.slots)) {
        subscribeRequest.slots[key] = {
          filterByCommitment: true,
        };
      }
    }

    try {
      this.logger.info('Creating gRPC subscription stream');
      const stream = await this.client.subscribe();
      this.stream = stream;
      
      // Send subscription request
      stream.write(subscribeRequest, (err: Error | null | undefined) => {
        if (err) {
          this.logger.error({ error: err }, 'Failed to write subscription request');
        } else {
          this.logger.info('Subscription request sent');
        }
      });

      // Process updates
      this.processUpdates();
    } catch (error) {
      this.logger.error({ error }, 'Failed to create subscription');
      throw error;
    }
  }

  /**
   * Process incoming updates from the stream
   */
  private processUpdates(): void {
    if (!this.stream) {
      return;
    }

    this.stream.on('data', (update: SubscribeUpdate) => {
      if (this.isShuttingDown) {
        return;
      }

      // Handle different update types
      if (update.account) {
        const accountUpdate = update.account as SubscribeUpdateAccount;
        if (accountUpdate.account) {
          this.emit('account', {
            account: {
              pubkey: accountUpdate.account.pubkey,
              lamports: accountUpdate.account.lamports,
              owner: accountUpdate.account.owner,
              executable: accountUpdate.account.executable,
              rentEpoch: accountUpdate.account.rentEpoch,
              data: accountUpdate.account.data,
            },
            slot: accountUpdate.slot,
            isStartup: accountUpdate.isStartup,
          });
        }
      }

      if (update.transaction) {
        const txUpdate = update.transaction as SubscribeUpdateTransaction;
        this.emit('transaction', {
          transaction: txUpdate.transaction,
          slot: txUpdate.slot,
        });
      }

      if (update.slot) {
        const slotUpdate = update.slot as SubscribeUpdateSlot;
        this.emit('slot', {
          slot: slotUpdate.slot,
          parent: slotUpdate.parent,
          status: this.mapSlotStatus(slotUpdate.status),
        });
      }

      if (update.ping) {
        this.logger.debug('Received ping from server');
      }
    });

    this.stream.on('error', (error: Error) => {
      if (!this.isShuttingDown) {
        this.logger.error({ error }, 'Stream error');
        this.emit('error', error);
        this.handleDisconnect();
      }
    });

    this.stream.on('end', () => {
      if (!this.isShuttingDown) {
        this.logger.warn('Stream ended');
        this.handleDisconnect();
      }
    });

    this.stream.on('close', () => {
      if (!this.isShuttingDown) {
        this.logger.warn('Stream closed');
        this.handleDisconnect();
      }
    });
  }

  /**
   * Handle disconnection and trigger reconnect
   */
  private async handleDisconnect(): Promise<void> {
    if (this.isShuttingDown) {
      return;
    }

    this.status = 'reconnecting';
    this.emit('status', this.status);
    this.emit('disconnected');

    // Exponential backoff for reconnection
    const delay = Math.min(
      TIMING.GRPC_RECONNECT_DELAY_MS * Math.pow(2, this.reconnectAttempts),
      TIMING.GRPC_MAX_RECONNECT_DELAY_MS
    );

    this.reconnectAttempts++;
    this.logger.info({ delay, attempt: this.reconnectAttempts }, 'Scheduling reconnection');

    await sleep(delay);

    if (!this.isShuttingDown) {
      try {
        await this.connect();
      } catch (error) {
        this.logger.error({ error }, 'Reconnection failed');
        this.handleDisconnect();
      }
    }
  }

  /**
   * Disconnect from gRPC endpoint
   */
  async disconnect(): Promise<void> {
    this.isShuttingDown = true;
    this.status = 'disconnected';
    this.emit('status', this.status);

    if (this.stream) {
      try {
        this.stream.destroy();
      } catch (error) {
        this.logger.warn({ error }, 'Error destroying stream');
      }
      this.stream = null;
    }

    this.client = null;
    this.logger.info('gRPC client disconnected');
  }

  /**
   * Map commitment level
   */
  private mapCommitment(commitment: string): CommitmentLevel {
    switch (commitment) {
      case 'processed':
        return CommitmentLevel.PROCESSED;
      case 'confirmed':
        return CommitmentLevel.CONFIRMED;
      case 'finalized':
        return CommitmentLevel.FINALIZED;
      default:
        return CommitmentLevel.CONFIRMED;
    }
  }

  /**
   * Map slot status
   */
  private mapSlotStatus(status: number): 'processed' | 'confirmed' | 'finalized' {
    switch (status) {
      case 0:
        return 'processed';
      case 1:
        return 'confirmed';
      case 2:
        return 'finalized';
      default:
        return 'processed';
    }
  }
}

/**
 * Convert Uint8Array to PublicKey
 */
export function uint8ArrayToPublicKey(data: Uint8Array): PublicKey {
  return new PublicKey(data);
}

/**
 * Convert Uint8Array to base58 string
 */
export function uint8ArrayToBase58(data: Uint8Array): string {
  return new PublicKey(data).toBase58();
}
