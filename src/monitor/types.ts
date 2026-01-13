import { PublicKey } from '@solana/web3.js';
import type { DexType } from '../config/types.js';

/**
 * Monitor connection status
 */
export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'error';

/**
 * Monitor event types
 */
export type MonitorEventType = 
  | 'connected'
  | 'disconnected'
  | 'error'
  | 'new_pool'
  | 'liquidity_added'
  | 'migration';

/**
 * Base monitor event
 */
export interface MonitorEvent {
  type: MonitorEventType;
  timestamp: number;
}

/**
 * Connection event
 */
export interface ConnectionEvent extends MonitorEvent {
  type: 'connected' | 'disconnected';
  source: 'grpc' | 'websocket';
}

/**
 * Error event
 */
export interface ErrorEvent extends MonitorEvent {
  type: 'error';
  source: 'grpc' | 'websocket';
  error: Error;
}

/**
 * New pool detected event
 */
export interface NewPoolEvent extends MonitorEvent {
  type: 'new_pool';
  dex: DexType;
  mint: PublicKey;
  pool: PublicKey;
  baseMint: PublicKey;
  quoteMint: PublicKey;
  baseVault: PublicKey;
  quoteVault: PublicKey;
  lpMint?: PublicKey;
  openTime?: number;
  slot: number;
  signature: string;
}

/**
 * Liquidity added event
 */
export interface LiquidityAddedEvent extends MonitorEvent {
  type: 'liquidity_added';
  dex: DexType;
  pool: PublicKey;
  baseMint: PublicKey;
  quoteMint: PublicKey;
  baseAmount: bigint;
  quoteAmount: bigint;
  slot: number;
  signature: string;
}

/**
 * Migration event (e.g., Pump.fun to Raydium)
 */
export interface MigrationEvent extends MonitorEvent {
  type: 'migration';
  sourceDex: DexType;
  targetDex: DexType;
  mint: PublicKey;
  sourcePool: PublicKey;
  targetPool: PublicKey;
  slot: number;
  signature: string;
}

/**
 * Union of all pool events
 */
export type PoolEvent = NewPoolEvent | LiquidityAddedEvent | MigrationEvent;

/**
 * gRPC subscription request
 */
export interface GrpcSubscriptionRequest {
  accounts?: {
    [key: string]: {
      owner: string[];
      filters?: AccountFilter[];
    };
  };
  transactions?: {
    [key: string]: {
      accountInclude: string[];
      accountExclude?: string[];
    };
  };
  slots?: Record<string, Record<string, never>>;
  commitment?: 'processed' | 'confirmed' | 'finalized';
}

/**
 * Account filter for gRPC
 */
export interface AccountFilter {
  memcmp?: {
    offset: number;
    bytes: string;
  };
  dataSize?: number;
}

/**
 * gRPC update types
 */
export interface GrpcAccountUpdate {
  account: {
    pubkey: Uint8Array;
    lamports: bigint;
    owner: Uint8Array;
    executable: boolean;
    rentEpoch: bigint;
    data: Uint8Array;
  };
  slot: bigint;
  isStartup: boolean;
}

export interface GrpcTransactionUpdate {
  transaction: {
    signature: Uint8Array;
    isVote: boolean;
    transaction: {
      message: {
        accountKeys: Uint8Array[];
        instructions: {
          programIdIndex: number;
          accounts: Uint8Array;
          data: Uint8Array;
        }[];
      };
    };
    meta?: {
      err: unknown;
      fee: bigint;
      preBalances: bigint[];
      postBalances: bigint[];
      logMessages: string[];
    };
  };
  slot: bigint;
}

export interface GrpcSlotUpdate {
  slot: bigint;
  parent?: bigint;
  status: 'processed' | 'confirmed' | 'finalized';
}

/**
 * Raydium pool state (AMM V4)
 */
export interface RaydiumPoolState {
  status: bigint;
  nonce: number;
  maxOrder: number;
  depth: number;
  baseDecimal: number;
  quoteDecimal: number;
  state: number;
  resetFlag: number;
  minSize: bigint;
  volMaxCutRatio: bigint;
  amountWaveRatio: bigint;
  baseLotSize: bigint;
  quoteLotSize: bigint;
  minPriceMultiplier: bigint;
  maxPriceMultiplier: bigint;
  systemDecimalValue: bigint;
  minSeparateNumerator: bigint;
  minSeparateDenominator: bigint;
  tradeFeeNumerator: bigint;
  tradeFeeDenominator: bigint;
  pnlNumerator: bigint;
  pnlDenominator: bigint;
  swapFeeNumerator: bigint;
  swapFeeDenominator: bigint;
  baseNeedTakePnl: bigint;
  quoteNeedTakePnl: bigint;
  quoteTotalPnl: bigint;
  baseTotalPnl: bigint;
  poolOpenTime: bigint;
  punishPcAmount: bigint;
  punishCoinAmount: bigint;
  orderbookToInitTime: bigint;
  swapBaseInAmount: bigint;
  swapQuoteOutAmount: bigint;
  swapBase2QuoteFee: bigint;
  swapQuoteInAmount: bigint;
  swapBaseOutAmount: bigint;
  swapQuote2BaseFee: bigint;
  baseVault: PublicKey;
  quoteVault: PublicKey;
  baseMint: PublicKey;
  quoteMint: PublicKey;
  lpMint: PublicKey;
  openOrders: PublicKey;
  marketId: PublicKey;
  marketProgramId: PublicKey;
  targetOrders: PublicKey;
  withdrawQueue: PublicKey;
  lpVault: PublicKey;
  owner: PublicKey;
  lpReserve: bigint;
  padding: bigint[];
}

/**
 * Pump.fun bonding curve state
 */
export interface PumpfunBondingCurveState {
  virtualTokenReserves: bigint;
  virtualSolReserves: bigint;
  realTokenReserves: bigint;
  realSolReserves: bigint;
  tokenTotalSupply: bigint;
  complete: boolean;
}

/**
 * Parsed pool info
 */
export interface ParsedPoolInfo {
  dex: DexType;
  pool: PublicKey;
  baseMint: PublicKey;
  quoteMint: PublicKey;
  baseVault: PublicKey;
  quoteVault: PublicKey;
  baseReserve: bigint;
  quoteReserve: bigint;
  baseDecimals: number;
  quoteDecimals: number;
  lpMint?: PublicKey;
  openTime?: number;
}

/**
 * Monitor statistics
 */
export interface MonitorStats {
  eventsReceived: number;
  poolsDetected: number;
  errorsCount: number;
  lastEventTime: number;
  uptime: number;
  connectionStatus: ConnectionStatus;
}
