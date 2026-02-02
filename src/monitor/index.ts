import { PublicKey } from '@solana/web3.js';
import { EventEmitter } from 'events';
import type { Logger } from 'pino';
import type { Config, DexType } from '../config/types.js';
import { PROGRAM_IDS } from '../config/constants.js';
import { getSharedRateLimiter } from '../utils/rpc.js';
import { RpcProviderManager } from '../utils/rpc-provider.js';
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

/**
 * Monitor mode type
 */
export type MonitorMode = 'grpc' | 'websocket' | 'polling';

// Re-export types
export * from './types.js';

/**
 * Monitor coordinator that manages gRPC, WebSocket, and polling connections
 */
export class MonitorCoordinator extends EventEmitter {
  private readonly config: Config;
  private readonly logger: Logger;
  private readonly grpcClient: GrpcClient;
  private readonly wsClient: WebSocketClient;
  private readonly raydiumParser: RaydiumParser;
  private readonly pumpfunParser: PumpfunParser;
  private readonly rpcProviderManager: RpcProviderManager | null;

  private isRunning = false;
  private monitorMode: MonitorMode = 'grpc'; // Current monitoring mode
  private grpcAvailable = true; // Whether gRPC is available (auto-detected)
  private pollingInterval: NodeJS.Timeout | null = null;
  private lastPolledSignatures: Map<string, string> = new Map(); // programId -> lastSignature
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

  // Concurrency control for transaction fetches
  private pendingFetches = 0;
  private readonly maxConcurrentFetches: number;
  private readonly fetchTimeoutMs: number;

  constructor(config: Config, logger: Logger, rpcProviderManager?: RpcProviderManager) {
    super();
    this.config = config;
    this.logger = logger.child({ module: 'monitor' });
    this.rpcProviderManager = rpcProviderManager ?? null;

    // Initialize concurrency control from config
    this.maxConcurrentFetches = config.network.maxConcurrentFetches;
    this.fetchTimeoutMs = config.network.fetchTimeoutMs;

    // Initialize clients
    this.grpcClient = new GrpcClient(config.network, this.logger);
    this.wsClient = new WebSocketClient(config.network, this.logger);

    // Initialize parsers
    this.raydiumParser = new RaydiumParser(this.logger);
    this.pumpfunParser = new PumpfunParser(this.logger);

    // Devnet: use WebSocket only (gRPC providers typically don't support devnet)
    if (config.mode.useDevnet) {
      this.grpcAvailable = false;
      this.monitorMode = 'websocket';
      this.logger.info('Devnet mode: using WebSocket instead of gRPC');
    }

    // Setup event handlers
    this.setupEventHandlers();
  }

  /**
   * Get current monitoring mode
   */
  getMonitorMode(): MonitorMode {
    return this.monitorMode;
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
      if (this.isRunning && this.monitorMode === 'grpc') {
        this.logger.info('gRPC disconnected, falling back to WebSocket');
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
      if (this.monitorMode === 'websocket') {
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
    const startTime = Date.now();

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
    let dex: DexType | null = null;

    if (owner.equals(PROGRAM_IDS.RAYDIUM_AMM_V4) && this.config.dex.enableRaydium) {
      dex = 'raydium';
      event = this.raydiumParser.parseAccountUpdate(pubkey, data, slot, '');
    } else if (owner.equals(PROGRAM_IDS.PUMPFUN_PROGRAM) && this.config.dex.enablePumpfun) {
      dex = 'pumpfun';
      event = this.pumpfunParser.parseAccountUpdate(pubkey, data, slot, '');
    }

    const parseLatencyMs = Date.now() - startTime;

    if (event) {
      this.logger.info(
        {
          dex,
          slot,
          parseLatencyMs,
          dataSize: data.length,
        },
        'perf:handleAccountUpdate pool detected'
      );
      this.emitPoolEvent(event);
    }
  }

  /**
   * Handle gRPC transaction update
   */
  private handleTransactionUpdate(update: GrpcTransactionUpdate): void {
    const startTime = Date.now();

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
    let dex: DexType | null = null;

    if (this.config.dex.enableRaydium) {
      event = this.raydiumParser.parseTransaction(signature, accountKeys, instructions, slot);
      if (event) dex = 'raydium';
    }

    if (!event && this.config.dex.enablePumpfun) {
      event = this.pumpfunParser.parseTransaction(signature, accountKeys, instructions, slot);
      if (event) dex = 'pumpfun';
    }

    const parseLatencyMs = Date.now() - startTime;

    if (event) {
      event.signature = signature;
      this.logger.info(
        {
          dex,
          slot,
          signature: signature.slice(0, 20) + '...',
          parseLatencyMs,
          instructionCount: instructions.length,
        },
        'perf:handleTransactionUpdate pool detected'
      );
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
    this.monitorMode = 'grpc';

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
    this.monitorMode = 'websocket';

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

    // Check if we're already at max concurrent fetches - skip to avoid queue buildup
    if (this.pendingFetches >= this.maxConcurrentFetches) {
      return;
    }

    // Check logs for pool creation events - use specific patterns per DEX
    const isPoolCreation = this.isPoolCreationLog(dex, logs.logs);

    if (isPoolCreation) {
      this.logger.debug(
        { dex, signature: logs.signature, logs: logs.logs.slice(0, 5) },
        'Potential pool creation detected via logs'
      );

      // Fetch full transaction to parse
      this.fetchAndParseTransaction(dex, logs.signature, slot);
    }
  }

  /**
   * Check if logs indicate a pool creation event (specific patterns per DEX)
   */
  private isPoolCreationLog(dex: DexType, logs: string[]): boolean {
    switch (dex) {
      case 'pumpfun':
        // Pumpfun pool creation has specific instruction pattern
        // Look for "Program log: Instruction: Create" (not just "Create" anywhere)
        return logs.some((log) =>
          log.includes('Program log: Instruction: Create') ||
          log.includes('Program log: Instruction: Initialize')
        );

      case 'raydium':
        // Raydium AMM initialization
        return logs.some((log) =>
          log.includes('Program log: initialize2') ||
          log.includes('Program log: Initialize') ||
          log.includes('ray_log') // Raydium specific log prefix
        );

      case 'orca':
        // Orca Whirlpool initialization
        return logs.some((log) =>
          log.includes('Program log: Instruction: InitializePool') ||
          log.includes('Program log: Instruction: InitializeConfig')
        );

      default:
        return false;
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
    // Check concurrency limit
    if (this.pendingFetches >= this.maxConcurrentFetches) {
      this.logger.debug({ signature: signature.slice(0, 20) + '...' }, 'Skipping fetch - at concurrency limit');
      return;
    }

    this.pendingFetches++;
    const startTime = Date.now();

    try {
      let tx;
      let fetchLatencyMs: number;

      // Use RpcProviderManager for load-balanced, rate-limited access to Helius/Shyft
      if (this.rpcProviderManager) {
        const fetchStartTime = Date.now();
        const fetchPromise = this.rpcProviderManager.getParsedTransaction(signature, {
          commitment: 'confirmed',
          maxSupportedTransactionVersion: 0,
        });

        const timeoutPromise = new Promise<null>((_, reject) =>
          setTimeout(() => reject(new Error('Fetch timeout')), this.fetchTimeoutMs)
        );

        tx = await Promise.race([fetchPromise, timeoutPromise]);
        fetchLatencyMs = Date.now() - fetchStartTime;
      } else {
        // Fallback to WebSocket connection with shared rate limiter
        const connection = this.wsClient.getConnection();
        if (!connection) {
          this.pendingFetches--;
          return;
        }

        const rateLimiter = getSharedRateLimiter();
        await rateLimiter.acquire();

        const fetchStartTime = Date.now();
        const fetchPromise = connection.getParsedTransaction(signature, {
          commitment: 'confirmed',
          maxSupportedTransactionVersion: 0,
        });

        const timeoutPromise = new Promise<null>((_, reject) =>
          setTimeout(() => reject(new Error('Fetch timeout')), this.fetchTimeoutMs)
        );

        tx = await Promise.race([fetchPromise, timeoutPromise]);
        fetchLatencyMs = Date.now() - fetchStartTime;
      }

      if (!tx?.meta || tx.meta.err) {
        this.logger.debug(
          {
            signature: signature.slice(0, 20) + '...',
            fetchLatencyMs,
            error: tx?.meta?.err ? 'tx_error' : 'no_tx',
          },
          'perf:fetchAndParseTransaction skipped'
        );
        return;
      }

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

      const totalLatencyMs = Date.now() - startTime;

      if (event) {
        this.logger.info(
          {
            dex,
            signature: signature.slice(0, 20) + '...',
            slot,
            fetchLatencyMs,
            totalLatencyMs,
          },
          'perf:fetchAndParseTransaction pool detected'
        );
        this.emitPoolEvent(event);
      } else {
        this.logger.debug(
          {
            dex,
            signature: signature.slice(0, 20) + '...',
            fetchLatencyMs,
            totalLatencyMs,
          },
          'perf:fetchAndParseTransaction no pool event'
        );
      }
    } catch (error) {
      this.logger.warn(
        {
          error: error instanceof Error ? error.message : String(error),
          signature: signature.slice(0, 20) + '...',
          latencyMs: Date.now() - startTime,
        },
        'perf:fetchAndParseTransaction failed'
      );
    } finally {
      this.pendingFetches--;
    }
  }

  /**
   * Start monitoring with RPC polling (last resort fallback)
   */
  private async startPolling(): Promise<void> {
    this.monitorMode = 'polling';
    this.stats.connectionStatus = 'connected';
    this.logger.info('Starting RPC polling mode');

    const pollingIntervalMs = this.config.network.rpcPollingIntervalMs;

    // Get programs to watch
    const programsToWatch: { id: PublicKey; dex: DexType }[] = [];
    if (this.config.dex.enableRaydium) {
      programsToWatch.push({ id: PROGRAM_IDS.RAYDIUM_AMM_V4, dex: 'raydium' });
    }
    if (this.config.dex.enablePumpfun) {
      programsToWatch.push({ id: PROGRAM_IDS.PUMPFUN_PROGRAM, dex: 'pumpfun' });
    }
    if (this.config.dex.enableOrca) {
      programsToWatch.push({ id: PROGRAM_IDS.ORCA_WHIRLPOOL, dex: 'orca' });
    }

    this.emit('connected', { source: 'polling' });
    this.logger.info({ programs: programsToWatch.map(p => p.id.toBase58()), intervalMs: pollingIntervalMs }, 'Polling mode started');

    this.pollingInterval = setInterval(async () => {
      for (const program of programsToWatch) {
        await this.pollProgramSignatures(program.id, program.dex);
      }
    }, pollingIntervalMs);

    // Initial poll
    for (const program of programsToWatch) {
      await this.pollProgramSignatures(program.id, program.dex);
    }
  }

  /**
   * Poll for new signatures from a program
   */
  private async pollProgramSignatures(programId: PublicKey, dex: DexType): Promise<void> {
    const startTime = Date.now();
    const connection = this.rpcProviderManager?.getConnection() ?? this.wsClient.getConnection();
    if (!connection) {
      this.logger.warn('No connection available for polling');
      return;
    }

    try {
      const rateLimiter = getSharedRateLimiter();
      const rateLimitStartTime = Date.now();
      await rateLimiter.acquire();
      const rateLimitWaitMs = Date.now() - rateLimitStartTime;

      const fetchStartTime = Date.now();
      const lastSignature = this.lastPolledSignatures.get(programId.toBase58());
      const signatures = await connection.getSignaturesForAddress(
        programId,
        {
          limit: 20,
          until: lastSignature,
        },
        'confirmed'
      );
      const fetchLatencyMs = Date.now() - fetchStartTime;

      if (signatures.length === 0) {
        this.logger.debug(
          {
            dex,
            programId: programId.toBase58().slice(0, 8) + '...',
            fetchLatencyMs,
            rateLimitWaitMs,
            newSignatures: 0,
          },
          'perf:pollProgramSignatures no new signatures'
        );
        return;
      }

      // Update last signature (newest first)
      const newestSignature = signatures[0]?.signature;
      if (newestSignature) {
        this.lastPolledSignatures.set(programId.toBase58(), newestSignature);
      }

      const newSignatures = signatures.filter(s => !this.seenSignatures.has(s.signature));

      this.logger.debug(
        {
          dex,
          programId: programId.toBase58().slice(0, 8) + '...',
          fetchLatencyMs,
          rateLimitWaitMs,
          totalSignatures: signatures.length,
          newSignatures: newSignatures.length,
        },
        'perf:pollProgramSignatures signatures fetched'
      );

      // Process signatures (oldest first to maintain order)
      for (const sig of signatures.reverse()) {
        if (this.seenSignatures.has(sig.signature)) {
          continue;
        }
        this.seenSignatures.add(sig.signature);

        // Fetch and parse transaction
        await this.fetchAndParseTransaction(dex, sig.signature, sig.slot);
      }

      // Cleanup old signatures
      if (this.seenSignatures.size > 10000) {
        const entries = Array.from(this.seenSignatures);
        this.seenSignatures = new Set(entries.slice(-5000));
      }

      this.logger.debug(
        {
          dex,
          totalLatencyMs: Date.now() - startTime,
          processedSignatures: newSignatures.length,
        },
        'perf:pollProgramSignatures complete'
      );
    } catch (error) {
      this.logger.warn(
        {
          error,
          programId: programId.toBase58().slice(0, 8) + '...',
          latencyMs: Date.now() - startTime,
        },
        'perf:pollProgramSignatures error'
      );
      this.stats.errorsCount++;
    }
  }

  /**
   * Stop polling
   */
  private stopPolling(): void {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
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

    // Use WebSocket directly if gRPC is disabled (e.g., devnet mode)
    if (!this.grpcAvailable) {
      await this.startWebSocket();
      return;
    }

    // Auto-detect gRPC capability if enabled
    if (this.config.network.enableGrpcAutoDetect) {
      this.logger.info('Auto-detecting gRPC capability...');
      const probeResult = await this.grpcClient.probeCapability();

      if (!probeResult.available) {
        this.logger.info({ error: probeResult.error }, 'gRPC unavailable, will use WebSocket');
        this.grpcAvailable = false;
      } else {
        this.logger.info('gRPC is available');
        this.grpcAvailable = true;
      }
    }

    // Try gRPC first if available, then fallback chain
    if (this.grpcAvailable) {
      try {
        await this.startGrpc();
        return;
      } catch (error) {
        this.logger.warn({ error }, 'gRPC failed, falling back to WebSocket');
      }
    }

    // Try WebSocket
    try {
      await this.startWebSocket();
      return;
    } catch (error) {
      this.logger.warn({ error }, 'WebSocket failed, falling back to RPC polling');
    }

    // Last resort: RPC polling
    await this.startPolling();
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

    // Stop polling if active
    this.stopPolling();

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
