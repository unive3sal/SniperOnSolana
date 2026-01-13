import { PublicKey } from '@solana/web3.js';
import { EventEmitter } from 'events';
import type { Logger } from 'pino';
import type { Config, DexType } from '../config/types.js';
import { PROGRAM_IDS } from '../config/constants.js';
import { GrpcClient, uint8ArrayToPublicKey } from './grpc/client.js';
import { WebSocketClient } from './websocket/client.js';
import { RaydiumParser } from './parsers/raydium.js';
import { PumpfunParser } from './parsers/pumpfun.js';
import type {
  ConnectionStatus,
  MonitorStats,
  NewPoolEvent,
  PoolEvent,
  GrpcAccountUpdate,
  GrpcTransactionUpdate,
} from './types.js';

// Re-export types
export * from './types.js';

/**
 * Monitor coordinator that manages gRPC and WebSocket connections
 */
export class MonitorCoordinator extends EventEmitter {
  private readonly config: Config;
  private readonly logger: Logger;
  private readonly grpcClient: GrpcClient;
  private readonly wsClient: WebSocketClient;
  private readonly raydiumParser: RaydiumParser;
  private readonly pumpfunParser: PumpfunParser;
  
  private isRunning = false;
  private useGrpc = true; // Primary: gRPC, fallback: WebSocket
  private stats: MonitorStats = {
    eventsReceived: 0,
    poolsDetected: 0,
    errorsCount: 0,
    lastEventTime: 0,
    uptime: 0,
    connectionStatus: 'disconnected',
  };
  private startTime = 0;
  private seenSignatures: Set<string> = new Set();

  constructor(config: Config, logger: Logger) {
    super();
    this.config = config;
    this.logger = logger.child({ module: 'monitor' });
    
    // Initialize clients
    this.grpcClient = new GrpcClient(config.network, this.logger);
    this.wsClient = new WebSocketClient(config.network, this.logger);
    
    // Initialize parsers
    this.raydiumParser = new RaydiumParser(this.logger);
    this.pumpfunParser = new PumpfunParser(this.logger);
    
    // Setup event handlers
    this.setupEventHandlers();
  }

  /**
   * Setup event handlers for clients
   */
  private setupEventHandlers(): void {
    // gRPC event handlers
    this.grpcClient.on('connected', () => {
      this.logger.info('gRPC connected');
      this.stats.connectionStatus = 'connected';
      this.emit('connected', { source: 'grpc' });
    });

    this.grpcClient.on('disconnected', () => {
      this.logger.warn('gRPC disconnected');
      this.stats.connectionStatus = 'disconnected';
      this.emit('disconnected', { source: 'grpc' });
      
      // Fallback to WebSocket
      if (this.isRunning && this.useGrpc) {
        this.logger.info('Falling back to WebSocket');
        this.startWebSocket();
      }
    });

    this.grpcClient.on('error', (error: Error) => {
      this.logger.error({ error }, 'gRPC error');
      this.stats.errorsCount++;
      this.emit('error', { source: 'grpc', error });
    });

    this.grpcClient.on('account', (update: GrpcAccountUpdate) => {
      this.handleAccountUpdate(update);
    });

    this.grpcClient.on('transaction', (update: GrpcTransactionUpdate) => {
      this.handleTransactionUpdate(update);
    });

    // WebSocket event handlers
    this.wsClient.on('connected', () => {
      this.logger.info('WebSocket connected');
      if (!this.useGrpc) {
        this.stats.connectionStatus = 'connected';
      }
      this.emit('connected', { source: 'websocket' });
    });

    this.wsClient.on('disconnected', () => {
      this.logger.warn('WebSocket disconnected');
      this.emit('disconnected', { source: 'websocket' });
    });

    this.wsClient.on('error', (error: Error) => {
      this.logger.error({ error }, 'WebSocket error');
      this.stats.errorsCount++;
      this.emit('error', { source: 'websocket', error });
    });
  }

  /**
   * Handle gRPC account update
   */
  private handleAccountUpdate(update: GrpcAccountUpdate): void {
    if (!update.account.pubkey || !update.account.data || !update.account.owner) {
      return;
    }

    this.stats.eventsReceived++;
    this.stats.lastEventTime = Date.now();

    const pubkey = uint8ArrayToPublicKey(update.account.pubkey);
    const owner = uint8ArrayToPublicKey(update.account.owner);
    const data = Buffer.from(update.account.data);
    const slot = Number(update.slot);

    // Route to appropriate parser based on owner
    let event: PoolEvent | null = null;

    if (owner.equals(PROGRAM_IDS.RAYDIUM_AMM_V4) && this.config.dex.enableRaydium) {
      event = this.raydiumParser.parseAccountUpdate(pubkey, data, slot, '');
    } else if (owner.equals(PROGRAM_IDS.PUMPFUN_PROGRAM) && this.config.dex.enablePumpfun) {
      event = this.pumpfunParser.parseAccountUpdate(pubkey, data, slot, '');
    }

    if (event) {
      this.emitPoolEvent(event);
    }
  }

  /**
   * Handle gRPC transaction update
   */
  private handleTransactionUpdate(update: GrpcTransactionUpdate): void {
    if (!update.transaction) {
      return;
    }

    // Check for errors
    if (update.transaction.meta?.err) {
      return;
    }

    this.stats.eventsReceived++;
    this.stats.lastEventTime = Date.now();

    const tx = update.transaction;
    const signature = Buffer.from(tx.signature).toString('base64');
    const slot = Number(update.slot);

    // Deduplicate
    if (this.seenSignatures.has(signature)) {
      return;
    }
    this.seenSignatures.add(signature);

    // Cleanup old signatures periodically
    if (this.seenSignatures.size > 10000) {
      const entries = Array.from(this.seenSignatures);
      this.seenSignatures = new Set(entries.slice(-5000));
    }

    const message = tx.transaction?.message;
    if (!message) return;

    // Parse account keys
    const accountKeys = message.accountKeys.map((key: Uint8Array) => uint8ArrayToPublicKey(key));

    // Parse instructions
    const instructions = message.instructions.map((ix: { programIdIndex: number; accounts: Uint8Array; data: Uint8Array }) => ({
      programIdIndex: ix.programIdIndex,
      accounts: Array.from(ix.accounts),
      data: Buffer.from(ix.data),
    }));

    // Try parsing with each enabled parser
    let event: PoolEvent | null = null;

    if (this.config.dex.enableRaydium) {
      event = this.raydiumParser.parseTransaction(signature, accountKeys, instructions, slot);
    }

    if (!event && this.config.dex.enablePumpfun) {
      event = this.pumpfunParser.parseTransaction(signature, accountKeys, instructions, slot);
    }

    if (event) {
      event.signature = signature;
      this.emitPoolEvent(event);
    }
  }

  /**
   * Emit a pool event
   */
  private emitPoolEvent(event: PoolEvent): void {
    this.stats.poolsDetected++;
    
    const dex = 'dex' in event ? event.dex : ('sourceDex' in event ? event.sourceDex : 'unknown');
    
    this.logger.info(
      {
        type: event.type,
        dex,
        mint: 'mint' in event ? event.mint.toBase58() : undefined,
        pool: 'pool' in event ? event.pool.toBase58() : ('sourcePool' in event ? event.sourcePool.toBase58() : undefined),
        slot: event.slot,
      },
      'Pool event detected'
    );

    this.emit(event.type, event);
    this.emit('pool_event', event);
  }

  /**
   * Start monitoring with gRPC
   */
  private async startGrpc(): Promise<void> {
    this.useGrpc = true;

    try {
      await this.grpcClient.connect();

      // Build subscription request
      const programsToWatch: string[] = [];
      
      if (this.config.dex.enableRaydium) {
        programsToWatch.push(PROGRAM_IDS.RAYDIUM_AMM_V4.toBase58());
      }
      
      if (this.config.dex.enablePumpfun) {
        programsToWatch.push(PROGRAM_IDS.PUMPFUN_PROGRAM.toBase58());
      }
      
      if (this.config.dex.enableOrca) {
        programsToWatch.push(PROGRAM_IDS.ORCA_WHIRLPOOL.toBase58());
      }

      // Subscribe to program accounts and transactions
      await this.grpcClient.subscribe({
        accounts: {
          pools: {
            owner: programsToWatch,
          },
        },
        transactions: {
          dex_txs: {
            accountInclude: programsToWatch,
          },
        },
        commitment: 'confirmed',
      });

      this.logger.info({ programs: programsToWatch }, 'gRPC subscriptions created');
    } catch (error) {
      this.logger.error({ error }, 'Failed to start gRPC monitoring');
      throw error;
    }
  }

  /**
   * Start monitoring with WebSocket (fallback)
   */
  private async startWebSocket(): Promise<void> {
    this.useGrpc = false;

    try {
      await this.wsClient.connect();

      // Subscribe to program logs
      if (this.config.dex.enableRaydium) {
        await this.wsClient.subscribeToLogs(
          PROGRAM_IDS.RAYDIUM_AMM_V4,
          (logs, slot) => {
            // Handle Raydium logs
            this.handleWebSocketLogs('raydium', logs, slot);
          }
        );
      }

      if (this.config.dex.enablePumpfun) {
        await this.wsClient.subscribeToLogs(
          PROGRAM_IDS.PUMPFUN_PROGRAM,
          (logs, slot) => {
            // Handle Pump.fun logs
            this.handleWebSocketLogs('pumpfun', logs, slot);
          }
        );
      }

      if (this.config.dex.enableOrca) {
        await this.wsClient.subscribeToLogs(
          PROGRAM_IDS.ORCA_WHIRLPOOL,
          (logs, slot) => {
            // Handle Orca logs
            this.handleWebSocketLogs('orca', logs, slot);
          }
        );
      }

      this.logger.info('WebSocket subscriptions created');
    } catch (error) {
      this.logger.error({ error }, 'Failed to start WebSocket monitoring');
      throw error;
    }
  }

  /**
   * Handle WebSocket log events
   */
  private handleWebSocketLogs(
    dex: DexType,
    logs: { signature: string; logs: string[] },
    slot: number
  ): void {
    this.stats.eventsReceived++;
    this.stats.lastEventTime = Date.now();

    // Deduplicate
    if (this.seenSignatures.has(logs.signature)) {
      return;
    }
    this.seenSignatures.add(logs.signature);

    // Check logs for relevant events
    const hasCreate = logs.logs.some((log) => 
      log.includes('Initialize') || 
      log.includes('Create') ||
      log.includes('InitializePool')
    );

    if (hasCreate) {
      this.logger.debug(
        { dex, signature: logs.signature, logs: logs.logs.slice(0, 5) },
        'Potential pool creation detected via logs'
      );

      // Fetch full transaction to parse
      this.fetchAndParseTransaction(dex, logs.signature, slot);
    }
  }

  /**
   * Fetch and parse a transaction by signature
   */
  private async fetchAndParseTransaction(
    dex: DexType,
    signature: string,
    slot: number
  ): Promise<void> {
    const connection = this.wsClient.getConnection();
    if (!connection) return;

    try {
      const tx = await connection.getParsedTransaction(signature, {
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0,
      });

      if (!tx?.meta || tx.meta.err) return;

      // Extract account keys
      const accountKeys = tx.transaction.message.accountKeys.map((k) => 
        typeof k === 'string' ? new PublicKey(k) : k.pubkey
      );

      // Extract instructions
      const instructions = tx.transaction.message.instructions
        .filter((ix): ix is any => 'data' in ix)
        .map((ix) => ({
          programIdIndex: accountKeys.findIndex((k) => 
            k.equals(typeof ix.programId === 'string' ? new PublicKey(ix.programId) : ix.programId)
          ),
          accounts: ix.accounts?.map((a: string | PublicKey) => 
            accountKeys.findIndex((k) => k.equals(typeof a === 'string' ? new PublicKey(a) : a))
          ) ?? [],
          data: Buffer.from(ix.data, 'base64'),
        }));

      // Parse with appropriate parser
      let event: PoolEvent | null = null;

      if (dex === 'raydium') {
        event = this.raydiumParser.parseTransaction(signature, accountKeys, instructions, slot);
      } else if (dex === 'pumpfun') {
        event = this.pumpfunParser.parseTransaction(signature, accountKeys, instructions, slot);
      }

      if (event) {
        this.emitPoolEvent(event);
      }
    } catch (error) {
      this.logger.warn({ error, signature }, 'Failed to fetch transaction');
    }
  }

  /**
   * Start monitoring
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      this.logger.warn('Monitor already running');
      return;
    }

    this.isRunning = true;
    this.startTime = Date.now();
    this.stats.connectionStatus = 'connecting';

    this.logger.info('Starting monitor coordinator');

    // Try gRPC first, fallback to WebSocket
    try {
      await this.startGrpc();
    } catch (error) {
      this.logger.warn({ error }, 'gRPC failed, falling back to WebSocket');
      await this.startWebSocket();
    }
  }

  /**
   * Stop monitoring
   */
  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    this.isRunning = false;
    this.stats.connectionStatus = 'disconnected';

    this.logger.info('Stopping monitor coordinator');

    await Promise.all([
      this.grpcClient.disconnect(),
      this.wsClient.disconnect(),
    ]);

    this.logger.info('Monitor coordinator stopped');
  }

  /**
   * Get current stats
   */
  getStats(): MonitorStats {
    return {
      ...this.stats,
      uptime: this.startTime > 0 ? Date.now() - this.startTime : 0,
    };
  }

  /**
   * Check if monitor is running
   */
  isActive(): boolean {
    return this.isRunning;
  }

  /**
   * Get connection status
   */
  getConnectionStatus(): ConnectionStatus {
    return this.stats.connectionStatus;
  }
}
