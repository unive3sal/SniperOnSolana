import { z } from 'zod';
import { Keypair, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';

/**
 * Environment variable schema with validation
 */
export const envSchema = z.object({
  // Network
  GRPC_ENDPOINT: z.string().min(1, 'gRPC endpoint is required'),
  GRPC_TOKEN: z.string().min(1, 'gRPC token is required'),
  HELIUS_API_KEY: z.string().min(1, 'Helius API key is required'),
  BACKUP_RPC_URLS: z.string().optional().default(''),
  // RPC cache TTL in milliseconds (higher = fewer requests, but staler data)
  RPC_CACHE_TTL_MS: z.string().transform(Number).pipe(
    z.number().int().nonnegative().max(60000)
  ).optional().default('2000'),

  // Multi-provider RPC configuration
  // Shyft API key (optional - defaults to GRPC_TOKEN)
  SHYFT_API_KEY: z.string().optional(),
  // Per-provider rate limits (free plan: ~10 RPS each)
  SHYFT_RPC_RPS: z.string().transform(Number).pipe(
    z.number().int().positive().max(1000)
  ).optional().default('10'),
  HELIUS_RPC_RPS: z.string().transform(Number).pipe(
    z.number().int().positive().max(1000)
  ).optional().default('10'),
  // Provider priority (1=highest, 2=medium, 3=lowest/backup)
  // Lower priority providers are used when higher priority ones are overloaded
  HELIUS_PRIORITY: z.string().transform(Number).pipe(
    z.number().int().min(1).max(3)
  ).optional().default('1'),
  SHYFT_PRIORITY: z.string().transform(Number).pipe(
    z.number().int().min(1).max(3)
  ).optional().default('2'),
  SOLANA_PRIORITY: z.string().transform(Number).pipe(
    z.number().int().min(1).max(3)
  ).optional().default('3'),
  // RPC polling interval when streaming unavailable (ms)
  RPC_POLLING_INTERVAL_MS: z.string().transform(Number).pipe(
    z.number().int().positive().max(60000)
  ).optional().default('2000'),
  // Auto-detect gRPC capability (set false to always use WebSocket)
  ENABLE_GRPC_AUTO_DETECT: z.string().transform((v) => v === 'true').optional().default('true'),
  // Max concurrent transaction fetches (lower = fewer 429 errors, but slower detection)
  MAX_CONCURRENT_FETCHES: z.string().transform(Number).pipe(
    z.number().int().positive().max(20)
  ).optional().default('2'),
  // Fetch timeout in milliseconds (should be > rate limit wait time)
  FETCH_TIMEOUT_MS: z.string().transform(Number).pipe(
    z.number().int().positive().max(30000)
  ).optional().default('5000'),

  // Wallet
  PRIVATE_KEY: z.string().min(1, 'Private key is required').refine(
    (key) => {
      try {
        const decoded = bs58.decode(key);
        return decoded.length === 64;
      } catch {
        return false;
      }
    },
    { message: 'Invalid base58 private key (must be 64 bytes)' }
  ),
  
  // Trading
  BUY_AMOUNT_SOL: z.string().transform(Number).pipe(
    z.number().positive().max(100, 'Buy amount too high')
  ),
  MAX_SLIPPAGE_BPS: z.string().transform(Number).pipe(
    z.number().int().min(1).max(5000, 'Slippage must be 1-5000 bps')
  ),
  TAKE_PROFIT_PERCENT: z.string().transform(Number).pipe(
    z.number().positive().max(10000)
  ),
  STOP_LOSS_PERCENT: z.string().transform(Number).pipe(
    z.number().positive().max(100)
  ),
  MAX_POSITION_SIZE_SOL: z.string().transform(Number).pipe(
    z.number().positive()
  ),
  MAX_CONCURRENT_POSITIONS: z.string().transform(Number).pipe(
    z.number().int().positive().max(100)
  ).optional().default('5'),
  
  // Jito
  JITO_BLOCK_ENGINE_URL: z.string().url().optional().default('https://mainnet.block-engine.jito.wtf'),
  JITO_TIP_LAMPORTS: z.string().transform(Number).pipe(
    z.number().int().nonnegative()
  ),
  JITO_TIP_PERCENT: z.string().transform(Number).pipe(
    z.number().nonnegative().max(100)
  ).optional().default('5'),
  JITO_MAX_TIP_LAMPORTS: z.string().transform(Number).pipe(
    z.number().int().nonnegative()
  ).optional().default('100000'),
  
  // Security
  MIN_LIQUIDITY_SOL: z.string().transform(Number).pipe(
    z.number().nonnegative()
  ),
  MAX_TOP_HOLDER_PERCENT: z.string().transform(Number).pipe(
    z.number().positive().max(100)
  ),
  RISK_SCORE_THRESHOLD: z.string().transform(Number).pipe(
    z.number().int().min(0).max(100)
  ),
  ENABLE_HONEYPOT_CHECK: z.string().transform((v) => v === 'true').optional().default('true'),
  MAX_TAX_PERCENT: z.string().transform(Number).pipe(
    z.number().nonnegative().max(100)
  ).optional().default('10'),
  
  // DEX
  ENABLE_RAYDIUM: z.string().transform((v) => v === 'true').optional().default('true'),
  ENABLE_PUMPFUN: z.string().transform((v) => v === 'true').optional().default('true'),
  ENABLE_ORCA: z.string().transform((v) => v === 'true').optional().default('false'),
  
  // Logging
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).optional().default('info'),
  LOG_FILE: z.string().optional().default('./logs/sniper.log'),
  LOG_CONSOLE: z.string().transform((v) => v === 'true').optional().default('true'),
  
  // Mode
  DRY_RUN: z.string().transform((v) => v === 'true').optional().default('false'),
  USE_DEVNET: z.string().transform((v) => v === 'true').optional().default('false'),

  // Auto-Sweep
  ENABLE_AUTO_SWEEP: z.string().transform((v) => v === 'true').optional().default('false'),
  COLD_WALLET_ADDRESS: z.string().optional().refine(
    (addr) => {
      if (!addr) return true; // Optional, so empty is valid
      try {
        new PublicKey(addr);
        return true;
      } catch {
        return false;
      }
    },
    { message: 'Invalid Solana public key address' }
  ),
});

/**
 * Type inferred from schema
 */
export type EnvConfig = z.infer<typeof envSchema>;

/**
 * Load and validate environment variables
 */
export function loadEnv(): EnvConfig {
  const result = envSchema.safeParse(process.env);
  
  if (!result.success) {
    const errors = result.error.errors.map((e) => `  - ${e.path.join('.')}: ${e.message}`);
    throw new Error(`Environment validation failed:\n${errors.join('\n')}`);
  }
  
  return result.data;
}

/**
 * Get keypair from private key string
 */
export function getKeypairFromPrivateKey(privateKey: string): Keypair {
  try {
    const decoded = bs58.decode(privateKey);
    return Keypair.fromSecretKey(decoded);
  } catch (error) {
    throw new Error('Failed to decode private key');
  }
}
