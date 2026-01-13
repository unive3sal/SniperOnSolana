import { PublicKey } from '@solana/web3.js';

/**
 * Solana Program IDs
 */
export const PROGRAM_IDS = {
  // Native programs
  SYSTEM_PROGRAM: new PublicKey('11111111111111111111111111111111'),
  TOKEN_PROGRAM: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
  TOKEN_2022_PROGRAM: new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'),
  ASSOCIATED_TOKEN_PROGRAM: new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'),
  RENT_PROGRAM: new PublicKey('SysvarRent111111111111111111111111111111111'),
  
  // Raydium AMM V4
  RAYDIUM_AMM_V4: new PublicKey('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8'),
  RAYDIUM_AUTHORITY: new PublicKey('5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1'),
  RAYDIUM_OPEN_BOOK: new PublicKey('srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX'),
  
  // Raydium CLMM (Concentrated Liquidity)
  RAYDIUM_CLMM: new PublicKey('CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK'),
  
  // Raydium CPMM (Constant Product)
  RAYDIUM_CPMM: new PublicKey('CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C'),
  
  // Pump.fun
  PUMPFUN_PROGRAM: new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'),
  PUMPFUN_GLOBAL: new PublicKey('4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf'),
  PUMPFUN_FEE_RECIPIENT: new PublicKey('CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM'),
  PUMPFUN_EVENT_AUTHORITY: new PublicKey('Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1'),
  
  // Orca Whirlpool
  ORCA_WHIRLPOOL: new PublicKey('whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc'),
  
  // Meteora
  METEORA_DLMM: new PublicKey('LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo'),
  
  // OpenBook DEX (Serum successor)
  OPENBOOK_V2: new PublicKey('opnb2LAfJYbRMAHHvqjCwQxanZn7ReEHp1k81EohpZb'),
} as const;

/**
 * Common token mints
 */
export const TOKEN_MINTS = {
  SOL: new PublicKey('So11111111111111111111111111111111111111112'),
  USDC: new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'),
  USDT: new PublicKey('Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'),
} as const;

/**
 * Jito configuration
 */
export const JITO_CONFIG = {
  // Block Engine endpoints
  BLOCK_ENGINE_URLS: {
    MAINNET: 'https://mainnet.block-engine.jito.wtf',
    AMSTERDAM: 'https://amsterdam.mainnet.block-engine.jito.wtf',
    FRANKFURT: 'https://frankfurt.mainnet.block-engine.jito.wtf',
    NY: 'https://ny.mainnet.block-engine.jito.wtf',
    TOKYO: 'https://tokyo.mainnet.block-engine.jito.wtf',
  },
  
  // Jito tip accounts (one will be randomly selected)
  TIP_ACCOUNTS: [
    new PublicKey('96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5'),
    new PublicKey('HFqU5x63VTqvQss8hp11i4bVmkdzGTT4X4TyQYz3jPMV'),
    new PublicKey('Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY'),
    new PublicKey('ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49'),
    new PublicKey('DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh'),
    new PublicKey('ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt'),
    new PublicKey('DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL'),
    new PublicKey('3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT'),
  ],
  
  // Bundle configuration
  MAX_BUNDLE_SIZE: 5,
  BUNDLE_TIMEOUT_MS: 60000,
} as const;

/**
 * RPC endpoints
 */
export const RPC_ENDPOINTS = {
  // Mainnet
  MAINNET: {
    SOLANA: 'https://api.mainnet-beta.solana.com',
    HELIUS: (apiKey: string) => `https://mainnet.helius-rpc.com/?api-key=${apiKey}`,
    HELIUS_WS: (apiKey: string) => `wss://mainnet.helius-rpc.com/?api-key=${apiKey}`,
    SHYFT_RPC: (apiKey: string) => `https://rpc.shyft.to?api_key=${apiKey}`,
    SHYFT_GRPC: 'grpc.shyft.to:443',
  },
  
  // Devnet
  DEVNET: {
    SOLANA: 'https://api.devnet.solana.com',
    HELIUS: (apiKey: string) => `https://devnet.helius-rpc.com/?api-key=${apiKey}`,
    HELIUS_WS: (apiKey: string) => `wss://devnet.helius-rpc.com/?api-key=${apiKey}`,
  },
} as const;

/**
 * Compute budget defaults
 */
export const COMPUTE_BUDGET = {
  DEFAULT_UNITS: 200000,
  MAX_UNITS: 1400000,
  DEFAULT_PRIORITY_FEE: 1, // micro-lamports per compute unit
  HIGH_PRIORITY_FEE: 100000,
} as const;

/**
 * Timing constants
 */
export const TIMING = {
  // Connection
  GRPC_RECONNECT_DELAY_MS: 1000,
  GRPC_MAX_RECONNECT_DELAY_MS: 30000,
  GRPC_HEALTH_CHECK_INTERVAL_MS: 30000,
  WS_RECONNECT_DELAY_MS: 1000,
  
  // Monitoring
  PRICE_POLL_INTERVAL_MS: 1000,
  POSITION_CHECK_INTERVAL_MS: 500,
  
  // Execution
  TX_CONFIRMATION_TIMEOUT_MS: 60000,
  BUNDLE_STATUS_POLL_INTERVAL_MS: 2000,
  
  // Cache
  TOKEN_CACHE_TTL_MS: 300000, // 5 minutes
  BLACKLIST_CACHE_TTL_MS: 86400000, // 24 hours
} as const;

/**
 * Risk scoring weights
 */
export const RISK_WEIGHTS = {
  MINT_AUTHORITY_REVOKED: 20,
  FREEZE_AUTHORITY_REVOKED: 15,
  LP_LOCKED: 25,
  LP_LOCK_DURATION_BONUS: 5, // bonus if > 30 days
  TOP_HOLDER_PENALTY: 1, // -1 per % over threshold
  LIQUIDITY_BONUS: 10, // if > 10 SOL
  HONEYPOT_PASSED: 15,
  CONTRACT_VERIFIED: 10,
  KNOWN_DEVELOPER: 5,
} as const;

/**
 * Raydium instruction discriminators
 */
export const RAYDIUM_DISCRIMINATORS = {
  INITIALIZE_2: Buffer.from([175, 175, 109, 31, 13, 152, 155, 237]),
  SWAP_BASE_IN: Buffer.from([143, 190, 90, 218, 196, 30, 51, 222]),
  SWAP_BASE_OUT: Buffer.from([55, 217, 98, 86, 163, 74, 180, 173]),
} as const;

/**
 * Pump.fun instruction discriminators
 */
export const PUMPFUN_DISCRIMINATORS = {
  CREATE: Buffer.from([24, 30, 200, 40, 5, 28, 7, 119]),
  BUY: Buffer.from([102, 6, 61, 18, 1, 218, 235, 234]),
  SELL: Buffer.from([51, 230, 133, 164, 1, 127, 131, 173]),
} as const;

/**
 * Pump.fun bonding curve constants
 */
export const PUMPFUN_CONSTANTS = {
  VIRTUAL_SOL_RESERVES: 30_000_000_000, // 30 SOL in lamports
  VIRTUAL_TOKEN_RESERVES: 1_073_000_000_000_000, // 1.073B tokens
  INITIAL_REAL_TOKEN_RESERVES: 793_100_000_000_000, // 793.1M tokens
  TOTAL_SUPPLY: 1_000_000_000_000_000, // 1B tokens (with 6 decimals)
  FEE_BPS: 100, // 1% fee
  MIGRATION_THRESHOLD: 85_000_000_000, // ~85 SOL triggers migration
} as const;

/**
 * Orca Whirlpool constants
 */
export const ORCA_CONSTANTS = {
  TICK_SPACING_STABLE: 1,
  TICK_SPACING_STANDARD: 64,
  TICK_SPACING_VOLATILE: 128,
} as const;
