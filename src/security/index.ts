import { Connection, PublicKey } from '@solana/web3.js';
import { LRUCache } from 'lru-cache';
import type { Logger } from 'pino';
import type { Config, RiskAnalysis, RiskFactor, DexType } from '../config/types.js';
import { TIMING } from '../config/constants.js';
import { checkAuthorities } from './checks/authority.js';
import { checkPoolLiquidity, checkLpLock, checkLpBurn } from './checks/liquidity.js';
import { analyzeHolders, checkDevWallet } from './checks/holders.js';
import { checkHoneypot } from './checks/honeypot.js';
import { BlacklistManager, WhitelistManager } from './checks/blacklist.js';
import {
  calculateRiskScore,
  getRiskLevel,
  formatRiskAnalysis,
  shouldProceedToDeepAnalysis,
} from './scorer.js';

// Re-export
export * from './scorer.js';
export * from './checks/blacklist.js';

/**
 * Token analysis request
 */
export interface AnalysisRequest {
  mint: PublicKey;
  pool: PublicKey;
  dex: DexType;
  baseMint: PublicKey;
  quoteMint: PublicKey;
  baseVault: PublicKey;
  quoteVault: PublicKey;
  lpMint?: PublicKey;
  creator?: PublicKey;
}

/**
 * Security module for token risk analysis
 */
export class SecurityModule {
  private readonly config: Config;
  private readonly logger: Logger;
  private readonly connection: Connection;
  private readonly cache: LRUCache<string, RiskAnalysis>;
  private readonly blacklist: BlacklistManager;
  private readonly whitelist: WhitelistManager;

  constructor(config: Config, logger: Logger) {
    this.config = config;
    this.logger = logger.child({ module: 'security' });
    
    this.connection = new Connection(config.network.heliusRpcUrl, {
      commitment: 'confirmed',
    });

    this.cache = new LRUCache<string, RiskAnalysis>({
      max: 1000,
      ttl: TIMING.TOKEN_CACHE_TTL_MS,
    });

    this.blacklist = new BlacklistManager(this.logger);
    this.whitelist = new WhitelistManager(this.logger);
  }

  /**
   * Run full security analysis on a token
   */
  async analyze(request: AnalysisRequest): Promise<RiskAnalysis> {
    const cacheKey = request.mint.toBase58();
    
    // Check cache
    const cached = this.cache.get(cacheKey);
    if (cached) {
      this.logger.debug({ mint: cacheKey }, 'Using cached analysis');
      return cached;
    }

    // Check blacklist
    const blacklisted = this.blacklist.isBlacklisted(request.mint);
    if (blacklisted) {
      const analysis: RiskAnalysis = {
        score: 0,
        passed: false,
        factors: [{
          name: 'blacklist',
          score: -100,
          maxScore: 0,
          passed: false,
          details: `Blacklisted: ${blacklisted.reason}`,
        }],
        warnings: [`Token is blacklisted: ${blacklisted.reason}`],
        timestamp: Date.now(),
      };
      return analysis;
    }

    // Check whitelist
    if (this.whitelist.isWhitelisted(request.mint)) {
      this.logger.info({ mint: cacheKey }, 'Token is whitelisted, skipping analysis');
      const analysis: RiskAnalysis = {
        score: 100,
        passed: true,
        factors: [{
          name: 'whitelist',
          score: 100,
          maxScore: 100,
          passed: true,
          details: 'Token is whitelisted',
        }],
        warnings: [],
        timestamp: Date.now(),
      };
      return analysis;
    }

    this.logger.info({ mint: cacheKey, dex: request.dex }, 'Starting security analysis');
    const startTime = Date.now();

    try {
      // Phase 1: Fast checks (run in parallel)
      const fastFactors = await this.runFastChecks(request);
      
      // Check if we should proceed to deep analysis
      if (!shouldProceedToDeepAnalysis(fastFactors)) {
        const analysis = calculateRiskScore(fastFactors);
        this.cache.set(cacheKey, analysis);
        this.logger.info(
          { mint: cacheKey, score: analysis.score, passed: false, phase: 'fast' },
          'Analysis failed fast checks'
        );
        return analysis;
      }

      // Phase 2: Deep checks (run in parallel where possible)
      const deepFactors = await this.runDeepChecks(request);

      // Phase 3: Honeypot check (if enabled)
      let honeypotFactor: RiskFactor | null = null;
      if (this.config.security.enableHoneypotCheck) {
        honeypotFactor = await this.runHoneypotCheck(request);
      }

      // Combine all factors
      const allFactors = [
        ...fastFactors,
        ...deepFactors,
        ...(honeypotFactor ? [honeypotFactor] : []),
      ];

      const analysis = calculateRiskScore(allFactors);
      
      // Cache result
      this.cache.set(cacheKey, analysis);

      const duration = Date.now() - startTime;
      this.logger.info(
        {
          mint: cacheKey,
          score: analysis.score,
          passed: analysis.passed,
          level: getRiskLevel(analysis.score),
          duration,
        },
        'Security analysis completed'
      );

      return analysis;
    } catch (error) {
      this.logger.error({ error, mint: cacheKey }, 'Security analysis failed');
      
      // Return a failed analysis on error
      const analysis: RiskAnalysis = {
        score: 0,
        passed: false,
        factors: [{
          name: 'error',
          score: 0,
          maxScore: 0,
          passed: false,
          details: `Analysis error: ${error instanceof Error ? error.message : String(error)}`,
        }],
        warnings: ['Security analysis failed due to error'],
        timestamp: Date.now(),
      };
      
      return analysis;
    }
  }

  /**
   * Run fast security checks
   */
  private async runFastChecks(request: AnalysisRequest): Promise<RiskFactor[]> {
    const { mintAuthority, freezeAuthority } = await checkAuthorities(
      this.connection,
      request.mint,
      this.logger
    );

    const liquidity = await checkPoolLiquidity(
      this.connection,
      request.quoteVault,
      request.quoteMint,
      this.config.security.minLiquiditySol,
      this.logger
    );

    return [mintAuthority, freezeAuthority, liquidity];
  }

  /**
   * Run deep security checks
   */
  private async runDeepChecks(request: AnalysisRequest): Promise<RiskFactor[]> {
    const factors: RiskFactor[] = [];

    // Holder analysis
    const { factor: holderFactor } = await analyzeHolders(
      this.connection,
      request.mint,
      this.config.security.maxTopHolderPercent,
      this.logger
    );
    factors.push(holderFactor);

    // LP lock check (if LP mint provided)
    if (request.lpMint) {
      const lpLockFactor = await checkLpLock(
        this.connection,
        request.lpMint,
        this.logger
      );
      factors.push(lpLockFactor);

      // Also check LP burn
      const lpBurnFactor = await checkLpBurn(
        this.connection,
        request.lpMint,
        this.logger
      );
      if (lpBurnFactor.score > 0) {
        factors.push(lpBurnFactor);
      }
    }

    // Dev wallet check (if creator provided)
    if (request.creator) {
      const devFactor = await checkDevWallet(
        this.connection,
        request.mint,
        request.creator,
        this.logger
      );
      factors.push(devFactor);
    }

    return factors;
  }

  /**
   * Run honeypot check
   */
  private async runHoneypotCheck(request: AnalysisRequest): Promise<RiskFactor> {
    return checkHoneypot(
      this.connection,
      request.mint,
      request.pool,
      request.dex,
      this.config.wallet.publicKey,
      this.config.security.maxTaxPercent,
      this.logger
    );
  }

  /**
   * Quick check for minimum viability (for ultra-fast decisions)
   */
  async quickCheck(request: AnalysisRequest): Promise<{ viable: boolean; reason?: string }> {
    // Check blacklist first
    const blacklisted = this.blacklist.isBlacklisted(request.mint);
    if (blacklisted) {
      return { viable: false, reason: `Blacklisted: ${blacklisted.reason}` };
    }

    // Check whitelist
    if (this.whitelist.isWhitelisted(request.mint)) {
      return { viable: true };
    }

    // Just check liquidity
    const liquidity = await checkPoolLiquidity(
      this.connection,
      request.quoteVault,
      request.quoteMint,
      this.config.security.minLiquiditySol,
      this.logger
    );

    if (!liquidity.passed) {
      return { viable: false, reason: liquidity.details };
    }

    return { viable: true };
  }

  /**
   * Get blacklist manager
   */
  getBlacklist(): BlacklistManager {
    return this.blacklist;
  }

  /**
   * Get whitelist manager
   */
  getWhitelist(): WhitelistManager {
    return this.whitelist;
  }

  /**
   * Clear analysis cache
   */
  clearCache(): void {
    this.cache.clear();
    this.logger.info('Analysis cache cleared');
  }

  /**
   * Get cache stats
   */
  getCacheStats(): { size: number; maxSize: number } {
    return {
      size: this.cache.size,
      maxSize: 1000,
    };
  }

  /**
   * Format analysis for display
   */
  formatAnalysis(analysis: RiskAnalysis): string {
    return formatRiskAnalysis(analysis);
  }
}
