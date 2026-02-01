import { PublicKey, Keypair } from '@solana/web3.js';

/**
 * Network configuration for RPC and gRPC endpoints
 */
export interface NetworkConfig {
  grpcEndpoint: string;
  grpcToken: string;
  heliusApiKey: string;
  heliusRpcUrl: string;
  heliusWsUrl: string;
  backupRpcUrls: string[];
  /** RPC rate limit in requests per second (default: 8 for Helius free plan) */
  rpcRateLimitRps: number;
  /** RPC cache TTL in milliseconds (default: 2000) */
  rpcCacheTtlMs: number;
}

/**
 * Wallet configuration
 */
export interface WalletConfig {
  privateKey: string;
  keypair: Keypair;
  publicKey: PublicKey;
}

/**
 * Trading parameters configuration
 */
export interface TradingConfig {
  buyAmountSol: number;
  maxSlippageBps: number;
  takeProfitPercent: number;
  stopLossPercent: number;
  maxPositionSizeSol: number;
  maxConcurrentPositions: number;
}

/**
 * Jito MEV protection configuration
 */
export interface JitoConfig {
  blockEngineUrl: string;
  tipLamports: number;
  tipPercent: number;
  maxTipLamports: number;
}

/**
 * Security thresholds configuration
 */
export interface SecurityConfig {
  minLiquiditySol: number;
  maxTopHolderPercent: number;
  riskScoreThreshold: number;
  enableHoneypotCheck: boolean;
  maxTaxPercent: number;
}

/**
 * DEX enablement configuration
 */
export interface DexConfig {
  enableRaydium: boolean;
  enablePumpfun: boolean;
  enableOrca: boolean;
}

/**
 * Logging configuration
 */
export interface LoggingConfig {
  level: 'debug' | 'info' | 'warn' | 'error';
  filePath: string;
  console: boolean;
}

/**
 * Operational mode configuration
 */
export interface ModeConfig {
  dryRun: boolean;
  useDevnet: boolean;
}

/**
 * Auto-sweep configuration
 */
export interface AutoSweepConfig {
  enabled: boolean;
  coldWalletAddress: PublicKey | null;
  thresholdSol: number;
  checkIntervalMs: number;
}

/**
 * Complete application configuration
 */
export interface Config {
  network: NetworkConfig;
  wallet: WalletConfig;
  trading: TradingConfig;
  jito: JitoConfig;
  security: SecurityConfig;
  dex: DexConfig;
  logging: LoggingConfig;
  mode: ModeConfig;
  autoSweep: AutoSweepConfig;
}

/**
 * Supported DEX types
 */
export type DexType = 'raydium' | 'pumpfun' | 'orca';

/**
 * Token event emitted by monitors
 */
export interface TokenEvent {
  type: 'NEW_POOL' | 'LIQUIDITY_ADDED' | 'MIGRATION';
  dex: DexType;
  mint: PublicKey;
  pool: PublicKey;
  baseMint: PublicKey;
  quoteMint: PublicKey;
  baseVault?: PublicKey;
  quoteVault?: PublicKey;
  liquidity?: number;
  timestamp: number;
  slot: number;
  signature: string;
}

/**
 * Risk analysis result
 */
export interface RiskAnalysis {
  score: number;
  passed: boolean;
  factors: RiskFactor[];
  warnings: string[];
  timestamp: number;
}

/**
 * Individual risk factor
 */
export interface RiskFactor {
  name: string;
  score: number;
  maxScore: number;
  passed: boolean;
  details?: string;
}

/**
 * Position tracking
 */
export interface Position {
  id: string;
  mint: PublicKey;
  pool: PublicKey;
  dex: DexType;
  entryPrice: number;
  entryTime: number;
  amount: number;
  solSpent: number;
  currentPrice: number;
  pnlPercent: number;
  takeProfitPrice: number;
  stopLossPrice: number;
  status: 'open' | 'closing' | 'closed';
  entryTxHash: string;
  exitTxHash?: string;
  exitReason?: 'take_profit' | 'stop_loss' | 'manual' | 'error';
}

/**
 * Swap execution result
 */
export interface SwapResult {
  success: boolean;
  txHash?: string;
  price?: number;
  tokenAmount?: number;
  solAmount?: number;
  error?: string;
  latencyMs: number;
}

/**
 * Bundle submission result
 */
export interface BundleResult {
  success: boolean;
  bundleId?: string;
  slot?: number;
  error?: string;
  landed: boolean;
}

/**
 * Token-2022 extension information
 */
export interface Token2022ExtensionInfo {
  /** Whether this is a Token-2022 token (vs standard SPL Token) */
  isToken2022: boolean;
  /** List of extension names present on the mint */
  extensions: string[];
  /** Transfer fee percentage (if TransferFeeConfig extension present) */
  transferFeePercent?: number;
  /** TransferHook program address (if TransferHook extension present) */
  transferHookProgram?: string;
  /** Whether MintCloseAuthority extension is present (CRITICAL - can make tokens worthless) */
  hasMintCloseAuthority: boolean;
  /** Whether PermanentDelegate extension is present (CRITICAL - can steal tokens) */
  hasPermanentDelegate: boolean;
  /** Whether TransferHook extension is present (CRITICAL - can block transfers) */
  hasTransferHook: boolean;
  /** Whether NonTransferable extension is present (CRITICAL - cannot sell) */
  isNonTransferable: boolean;
  /** Whether DefaultAccountState is set to frozen */
  defaultAccountStateFrozen: boolean;
}
