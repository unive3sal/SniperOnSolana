import 'dotenv/config';
import { PublicKey } from '@solana/web3.js';
import { loadEnv, getKeypairFromPrivateKey } from './env.js';
import { RPC_ENDPOINTS } from './constants.js';
import type { Config } from './types.js';

// Re-export types and constants
export * from './types.js';
export * from './constants.js';

/**
 * Singleton config instance
 */
let configInstance: Config | null = null;

/**
 * Load and build complete configuration
 */
export function loadConfig(): Config {
  if (configInstance) {
    return configInstance;
  }
  
  const env = loadEnv();
  const keypair = getKeypairFromPrivateKey(env.PRIVATE_KEY);
  const isDevnet = env.USE_DEVNET;
  
  // Build RPC URLs
  const heliusRpcUrl = isDevnet
    ? RPC_ENDPOINTS.DEVNET.HELIUS(env.HELIUS_API_KEY)
    : RPC_ENDPOINTS.MAINNET.HELIUS(env.HELIUS_API_KEY);
    
  const heliusWsUrl = isDevnet
    ? RPC_ENDPOINTS.DEVNET.HELIUS_WS(env.HELIUS_API_KEY)
    : RPC_ENDPOINTS.MAINNET.HELIUS_WS(env.HELIUS_API_KEY);
  
  // Parse backup RPC URLs
  const backupRpcUrls = env.BACKUP_RPC_URLS
    ? env.BACKUP_RPC_URLS.split(',').map((url) => url.trim()).filter(Boolean)
    : [];

  configInstance = {
    network: {
      grpcEndpoint: env.GRPC_ENDPOINT,
      grpcToken: env.GRPC_TOKEN,
      heliusApiKey: env.HELIUS_API_KEY,
      heliusRpcUrl,
      heliusWsUrl,
      backupRpcUrls,
    },
    
    wallet: {
      privateKey: env.PRIVATE_KEY,
      keypair,
      publicKey: keypair.publicKey,
    },
    
    trading: {
      buyAmountSol: env.BUY_AMOUNT_SOL,
      maxSlippageBps: env.MAX_SLIPPAGE_BPS,
      takeProfitPercent: env.TAKE_PROFIT_PERCENT,
      stopLossPercent: env.STOP_LOSS_PERCENT,
      maxPositionSizeSol: env.MAX_POSITION_SIZE_SOL,
      maxConcurrentPositions: env.MAX_CONCURRENT_POSITIONS,
    },
    
    jito: {
      blockEngineUrl: env.JITO_BLOCK_ENGINE_URL,
      tipLamports: env.JITO_TIP_LAMPORTS,
      tipPercent: env.JITO_TIP_PERCENT,
      maxTipLamports: env.JITO_MAX_TIP_LAMPORTS,
    },
    
    security: {
      minLiquiditySol: env.MIN_LIQUIDITY_SOL,
      maxTopHolderPercent: env.MAX_TOP_HOLDER_PERCENT,
      riskScoreThreshold: env.RISK_SCORE_THRESHOLD,
      enableHoneypotCheck: env.ENABLE_HONEYPOT_CHECK,
      maxTaxPercent: env.MAX_TAX_PERCENT,
    },
    
    dex: {
      enableRaydium: env.ENABLE_RAYDIUM,
      enablePumpfun: env.ENABLE_PUMPFUN,
      enableOrca: env.ENABLE_ORCA,
    },
    
    logging: {
      level: env.LOG_LEVEL,
      filePath: env.LOG_FILE,
      console: env.LOG_CONSOLE,
    },
    
    mode: {
      dryRun: env.DRY_RUN,
      useDevnet: env.USE_DEVNET,
    },

    autoSweep: {
      enabled: env.ENABLE_AUTO_SWEEP,
      coldWalletAddress: env.COLD_WALLET_ADDRESS ? new PublicKey(env.COLD_WALLET_ADDRESS) : null,
      thresholdSol: env.BUY_AMOUNT_SOL * 2, // Dynamic: 2x buy amount
      checkIntervalMs: 30000, // 30 seconds
    },
  };
  
  return configInstance;
}

/**
 * Get current config (must be loaded first)
 */
export function getConfig(): Config {
  if (!configInstance) {
    throw new Error('Config not loaded. Call loadConfig() first.');
  }
  return configInstance;
}

/**
 * Reset config (useful for testing)
 */
export function resetConfig(): void {
  configInstance = null;
}

/**
 * Validate config values at runtime
 */
export function validateConfig(config: Config): void {
  // Check wallet has SOL (warning only, don't fail)
  // This would need an RPC call, so we skip for now
  
  // Validate trading params make sense
  if (config.trading.stopLossPercent >= 100) {
    throw new Error('Stop loss must be less than 100%');
  }
  
  if (config.trading.buyAmountSol > config.trading.maxPositionSizeSol) {
    throw new Error('Buy amount cannot exceed max position size');
  }
  
  // Validate security thresholds
  if (config.security.riskScoreThreshold < 0 || config.security.riskScoreThreshold > 100) {
    throw new Error('Risk score threshold must be between 0 and 100');
  }
  
  // Validate at least one DEX is enabled
  if (!config.dex.enableRaydium && !config.dex.enablePumpfun && !config.dex.enableOrca) {
    throw new Error('At least one DEX must be enabled');
  }

  // Validate auto-sweep configuration
  if (config.autoSweep.enabled && !config.autoSweep.coldWalletAddress) {
    throw new Error('COLD_WALLET_ADDRESS must be set when ENABLE_AUTO_SWEEP is true');
  }

  if (config.autoSweep.enabled && config.autoSweep.coldWalletAddress?.equals(config.wallet.publicKey)) {
    throw new Error('Cold wallet address cannot be the same as trading wallet');
  }
}

/**
 * Print config summary (for logging, masks sensitive data)
 */
export function getConfigSummary(config: Config): Record<string, unknown> {
  return {
    network: {
      grpcEndpoint: config.network.grpcEndpoint,
      heliusRpcUrl: config.network.heliusRpcUrl.replace(/api-key=[^&]+/, 'api-key=***'),
      backupRpcCount: config.network.backupRpcUrls.length,
    },
    wallet: {
      publicKey: config.wallet.publicKey.toBase58(),
    },
    trading: config.trading,
    jito: {
      blockEngineUrl: config.jito.blockEngineUrl,
      tipLamports: config.jito.tipLamports,
      tipPercent: config.jito.tipPercent,
    },
    security: config.security,
    dex: config.dex,
    logging: config.logging,
    mode: config.mode,
    autoSweep: {
      enabled: config.autoSweep.enabled,
      coldWalletAddress: config.autoSweep.coldWalletAddress
        ? `${config.autoSweep.coldWalletAddress.toBase58().slice(0, 4)}...${config.autoSweep.coldWalletAddress.toBase58().slice(-4)}`
        : null,
      thresholdSol: config.autoSweep.thresholdSol,
      checkIntervalMs: config.autoSweep.checkIntervalMs,
    },
  };
}
