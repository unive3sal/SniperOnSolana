import { Connection, PublicKey } from '@solana/web3.js';
import { EventEmitter } from 'events';
import type { Logger } from 'pino';
import type { NetworkConfig } from '../../config/types.js';
import type { ConnectionStatus } from '../types.js';
import { TIMING } from '../../config/constants.js';
import { sleep } from '../../utils/retry.js';

/**
 * WebSocket subscription info
 */
interface SubscriptionInfo {
  id: number;
  type: 'account' | 'program' | 'logs';
  key: string;
}

/**
 * WebSocket client for fallback monitoring
 */
export class WebSocketClient extends EventEmitter {
  private connection: Connection | null = null;
  private status: ConnectionStatus = 'disconnected';
  private subscriptions: Map<string, SubscriptionInfo> = new Map();
  private isShuttingDown = false;
  private reconnectAttempts = 0;
  private readonly logger: Logger;
  private readonly config: NetworkConfig;

  constructor(config: NetworkConfig, logger: Logger) {
    super();
    this.config = config;
    this.logger = logger.child({ component: 'ws-client' });
  }

  /**
   * Get current connection status
   */
  getStatus(): ConnectionStatus {
    return this.status;
  }

  /**
   * Connect to WebSocket endpoint
   */
  async connect(): Promise<void> {
    if (this.status === 'connected' || this.status === 'connecting') {
      return;
    }

    this.status = 'connecting';
    this.emit('status', this.status);

    try {
      this.logger.info({ wsUrl: this.config.heliusWsUrl }, 'Connecting to WebSocket');

      this.connection = new Connection(this.config.heliusRpcUrl, {
        wsEndpoint: this.config.heliusWsUrl,
        commitment: 'confirmed',
      });

      // Test connection
      await this.connection.getSlot();

      this.status = 'connected';
      this.reconnectAttempts = 0;
      this.emit('status', this.status);
      this.emit('connected');

      this.logger.info('WebSocket connection established');
    } catch (error) {
      this.status = 'error';
      this.emit('status', this.status);
      this.emit('error', error);
      this.logger.error({ error }, 'Failed to connect to WebSocket');
      throw error;
    }
  }

  /**
   * Subscribe to program account changes
   */
  async subscribeToProgramAccounts(
    programId: PublicKey,
    callback: (accountInfo: { pubkey: PublicKey; account: any }, slot: number) => void,
    filters?: { memcmp?: { offset: number; bytes: string }; dataSize?: number }[]
  ): Promise<string> {
    if (!this.connection) {
      throw new Error('Connection not established');
    }

    const key = `program:${programId.toBase58()}`;
    
    if (this.subscriptions.has(key)) {
      this.logger.warn({ programId: programId.toBase58() }, 'Already subscribed to program');
      return key;
    }

    try {
      const subId = this.connection.onProgramAccountChange(
        programId,
        (accountInfo, context) => {
          callback(
            {
              pubkey: accountInfo.accountId,
              account: accountInfo.accountInfo,
            },
            context.slot
          );
        },
        'confirmed',
        filters?.filter((f) => f.memcmp || f.dataSize !== undefined).map((f) => {
          if (f.memcmp) {
            return { memcmp: f.memcmp };
          }
          return { dataSize: f.dataSize! };
        })
      );

      this.subscriptions.set(key, {
        id: subId,
        type: 'program',
        key: programId.toBase58(),
      });

      this.logger.info({ programId: programId.toBase58(), subId }, 'Subscribed to program');
      return key;
    } catch (error) {
      this.logger.error({ error, programId: programId.toBase58() }, 'Failed to subscribe to program');
      throw error;
    }
  }

  /**
   * Subscribe to account changes
   */
  async subscribeToAccount(
    publicKey: PublicKey,
    callback: (account: any, slot: number) => void
  ): Promise<string> {
    if (!this.connection) {
      throw new Error('Connection not established');
    }

    const key = `account:${publicKey.toBase58()}`;
    
    if (this.subscriptions.has(key)) {
      this.logger.warn({ publicKey: publicKey.toBase58() }, 'Already subscribed to account');
      return key;
    }

    try {
      const subId = this.connection.onAccountChange(
        publicKey,
        (account, context) => {
          callback(account, context.slot);
        },
        'confirmed'
      );

      this.subscriptions.set(key, {
        id: subId,
        type: 'account',
        key: publicKey.toBase58(),
      });

      this.logger.info({ publicKey: publicKey.toBase58(), subId }, 'Subscribed to account');
      return key;
    } catch (error) {
      this.logger.error({ error, publicKey: publicKey.toBase58() }, 'Failed to subscribe to account');
      throw error;
    }
  }

  /**
   * Subscribe to logs for a program
   */
  async subscribeToLogs(
    programId: PublicKey,
    callback: (logs: { signature: string; logs: string[] }, slot: number) => void
  ): Promise<string> {
    if (!this.connection) {
      throw new Error('Connection not established');
    }

    const key = `logs:${programId.toBase58()}`;
    
    if (this.subscriptions.has(key)) {
      this.logger.warn({ programId: programId.toBase58() }, 'Already subscribed to logs');
      return key;
    }

    try {
      const subId = this.connection.onLogs(
        programId,
        (logsInfo, context) => {
          callback(
            {
              signature: logsInfo.signature,
              logs: logsInfo.logs,
            },
            context.slot
          );
        },
        'confirmed'
      );

      this.subscriptions.set(key, {
        id: subId,
        type: 'logs',
        key: programId.toBase58(),
      });

      this.logger.info({ programId: programId.toBase58(), subId }, 'Subscribed to logs');
      return key;
    } catch (error) {
      this.logger.error({ error, programId: programId.toBase58() }, 'Failed to subscribe to logs');
      throw error;
    }
  }

  /**
   * Unsubscribe from a subscription
   */
  async unsubscribe(key: string): Promise<void> {
    const sub = this.subscriptions.get(key);
    if (!sub || !this.connection) {
      return;
    }

    try {
      switch (sub.type) {
        case 'program':
          await this.connection.removeProgramAccountChangeListener(sub.id);
          break;
        case 'account':
          await this.connection.removeAccountChangeListener(sub.id);
          break;
        case 'logs':
          await this.connection.removeOnLogsListener(sub.id);
          break;
      }

      this.subscriptions.delete(key);
      this.logger.info({ key, type: sub.type }, 'Unsubscribed');
    } catch (error) {
      this.logger.error({ error, key }, 'Failed to unsubscribe');
    }
  }

  /**
   * Unsubscribe from all subscriptions
   */
  async unsubscribeAll(): Promise<void> {
    const keys = Array.from(this.subscriptions.keys());
    await Promise.all(keys.map((key) => this.unsubscribe(key)));
  }

  /**
   * Get the underlying connection
   */
  getConnection(): Connection | null {
    return this.connection;
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
      TIMING.WS_RECONNECT_DELAY_MS * Math.pow(2, this.reconnectAttempts),
      TIMING.GRPC_MAX_RECONNECT_DELAY_MS
    );

    this.reconnectAttempts++;
    this.logger.info({ delay, attempt: this.reconnectAttempts }, 'Scheduling reconnection');

    await sleep(delay);

    if (!this.isShuttingDown) {
      try {
        await this.connect();
        // Resubscribe to all previous subscriptions
        // Note: This would require storing subscription callbacks
      } catch (error) {
        this.logger.error({ error }, 'Reconnection failed');
        this.handleDisconnect();
      }
    }
  }

  /**
   * Disconnect from WebSocket
   */
  async disconnect(): Promise<void> {
    this.isShuttingDown = true;
    this.status = 'disconnected';
    this.emit('status', this.status);

    await this.unsubscribeAll();
    this.connection = null;

    this.logger.info('WebSocket client disconnected');
  }
}
