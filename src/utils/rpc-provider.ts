import {
  Connection,
  PublicKey,
  AccountInfo,
  VersionedTransaction,
  SendOptions,
  ParsedTransactionWithMeta,
  Finality,
} from '@solana/web3.js';
import type { Logger } from 'pino';
import type { NetworkConfig } from '../config/types.js';
import { RateLimiter, TTLCache } from './rpc.js';

/**
 * RPC provider type
 */
export type RpcProviderName = 'helius' | 'shyft' | 'solana';

/**
 * RPC provider configuration
 */
export interface RpcProvider {
  name: RpcProviderName;
  url: string;
  rps: number;
  priority: 1 | 2 | 3; // 1 = highest priority
  role: 'primary' | 'backup';
  connection: Connection;
  rateLimiter: RateLimiter;
  healthy: boolean;
  consecutiveFailures: number;
  lastFailure: number;
  lastSuccess: number;
  // Performance stats
  stats: {
    requestCount: number;
    totalLatencyMs: number;
    cacheHits: number;
    cacheMisses: number;
    failureCount: number;
  };
}

/**
 * Provider health status
 */
export interface ProviderHealth {
  name: RpcProviderName;
  healthy: boolean;
  consecutiveFailures: number;
  lastFailure: number | null;
  lastSuccess: number | null;
}

/**
 * Provider performance statistics
 */
export interface ProviderStats {
  name: RpcProviderName;
  requestCount: number;
  avgLatencyMs: number;
  cacheHits: number;
  cacheMisses: number;
  cacheHitRate: number;
  failureCount: number;
  failureRate: number;
}

/**
 * RPC provider manager options
 */
export interface RpcProviderManagerOptions {
  /** Maximum consecutive failures before marking unhealthy (default: 3) */
  maxConsecutiveFailures?: number;
  /** Cooldown period in ms before retrying unhealthy provider (default: 30000) */
  healthRecoveryCooldownMs?: number;
  /** Cache TTL in ms (default: 2000) */
  cacheTtlMs?: number;
  /** Cache max size (default: 1000) */
  cacheMaxSize?: number;
}

/**
 * RPC Provider Manager
 *
 * Manages multiple RPC providers with:
 * - Per-provider rate limiting
 * - Round-robin load balancing across healthy providers with same priority
 * - Health tracking with automatic recovery
 * - Failover to lower priority providers when higher priority ones fail
 * - Response caching for account info
 */
export class RpcProviderManager {
  private readonly providers: Map<RpcProviderName, RpcProvider> = new Map();
  private readonly logger: Logger;
  private readonly cache: TTLCache<AccountInfo<Buffer> | null>;
  private readonly maxConsecutiveFailures: number;
  private readonly healthRecoveryCooldownMs: number;
  private initialized: boolean = false;

  constructor(
    networkConfig: NetworkConfig,
    logger: Logger,
    options: RpcProviderManagerOptions = {}
  ) {
    this.logger = logger.child({ component: 'rpc-provider-manager' });
    this.maxConsecutiveFailures = options.maxConsecutiveFailures ?? 3;
    this.healthRecoveryCooldownMs = options.healthRecoveryCooldownMs ?? 30000;
    this.cache = new TTLCache(
      options.cacheMaxSize ?? 1000,
      options.cacheTtlMs ?? networkConfig.rpcCacheTtlMs
    );

    // Initialize providers
    this.initializeProviders(networkConfig);
  }

  /**
   * Initialize RPC providers from network config
   */
  private initializeProviders(config: NetworkConfig): void {
    const defaultStats = () => ({
      requestCount: 0,
      totalLatencyMs: 0,
      cacheHits: 0,
      cacheMisses: 0,
      failureCount: 0,
    });

    // Shyft RPC (priority from config)
    if (config.shyftRpcUrl) {
      this.providers.set('shyft', {
        name: 'shyft',
        url: config.shyftRpcUrl,
        rps: config.shyftRpcRps,
        priority: config.shyftPriority,
        role: config.shyftPriority === 3 ? 'backup' : 'primary',
        connection: new Connection(config.shyftRpcUrl, { commitment: 'confirmed' }),
        rateLimiter: new RateLimiter(config.shyftRpcRps, 2), // Max burst of 2 to prevent 429s
        healthy: true,
        consecutiveFailures: 0,
        lastFailure: 0,
        lastSuccess: 0,
        stats: defaultStats(),
      });
    }

    // Helius RPC (priority from config)
    if (config.heliusRpcUrl) {
      this.providers.set('helius', {
        name: 'helius',
        url: config.heliusRpcUrl,
        rps: config.heliusRpcRps,
        priority: config.heliusPriority,
        role: config.heliusPriority === 3 ? 'backup' : 'primary',
        connection: new Connection(config.heliusRpcUrl, { commitment: 'confirmed' }),
        rateLimiter: new RateLimiter(config.heliusRpcRps, 2), // Max burst of 2 to prevent 429s
        healthy: true,
        consecutiveFailures: 0,
        lastFailure: 0,
        lastSuccess: 0,
        stats: defaultStats(),
      });
    }

    // Solana native RPC (priority from config)
    if (config.solanaRpcUrl) {
      this.providers.set('solana', {
        name: 'solana',
        url: config.solanaRpcUrl,
        rps: 5, // Conservative rate limit for public endpoint
        priority: config.solanaPriority,
        role: config.solanaPriority === 3 ? 'backup' : 'primary',
        connection: new Connection(config.solanaRpcUrl, { commitment: 'confirmed' }),
        rateLimiter: new RateLimiter(5, 1), // Max burst of 1 for public endpoint
        healthy: true,
        consecutiveFailures: 0,
        lastFailure: 0,
        lastSuccess: 0,
        stats: defaultStats(),
      });
    }

    this.logger.info(
      { providers: Array.from(this.providers.keys()) },
      'RPC providers initialized'
    );
  }

  /**
   * Initialize the provider manager (verify connections)
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    this.logger.info('Verifying RPC provider connections...');

    for (const [name, provider] of this.providers) {
      try {
        await provider.rateLimiter.acquire();
        const slot = await provider.connection.getSlot();
        provider.lastSuccess = Date.now();
        this.logger.info({ provider: name, slot }, 'Provider connection verified');
      } catch (error) {
        this.logger.warn(
          { provider: name, error },
          'Provider connection failed during initialization'
        );
        this.markProviderUnhealthy(provider, error);
      }
    }

    this.initialized = true;
  }

  /**
   * Get a connection from the next healthy provider using round-robin
   */
  getConnection(): Connection {
    const provider = this.selectProvider();
    return provider.connection;
  }

  /**
   * Get account info with automatic failover and caching
   */
  async getAccountInfo(
    pubkey: PublicKey,
    priority: number = 0
  ): Promise<AccountInfo<Buffer> | null> {
    const cacheKey = pubkey.toBase58();
    const startTime = Date.now();

    // Check cache
    const cached = this.cache.get(cacheKey);
    if (cached !== undefined) {
      // Track cache hit on first available provider for stats
      const firstProvider = this.getHealthyProvidersByPriority()[0];
      if (firstProvider) {
        firstProvider.stats.cacheHits++;
      }
      this.logger.debug(
        { pubkey: cacheKey, latencyMs: Date.now() - startTime, cacheHit: true },
        'perf:getAccountInfo cache hit'
      );
      return cached;
    }

    // Try providers in priority order
    const providers = this.getHealthyProvidersByPriority();

    for (const provider of providers) {
      const rpcStartTime = Date.now();
      try {
        const rateLimitStartTime = Date.now();
        await provider.rateLimiter.acquire(priority);
        const rateLimitWaitMs = Date.now() - rateLimitStartTime;

        const result = await provider.connection.getAccountInfo(pubkey, 'confirmed');
        const rpcLatencyMs = Date.now() - rpcStartTime;

        // Update stats
        provider.stats.requestCount++;
        provider.stats.totalLatencyMs += rpcLatencyMs;
        provider.stats.cacheMisses++;

        this.markProviderHealthy(provider);
        this.cache.set(cacheKey, result);

        this.logger.debug(
          {
            provider: provider.name,
            pubkey: cacheKey,
            rpcLatencyMs,
            rateLimitWaitMs,
            totalLatencyMs: Date.now() - startTime,
            cacheHit: false,
          },
          'perf:getAccountInfo success'
        );

        return result;
      } catch (error) {
        provider.stats.failureCount++;
        this.markProviderUnhealthy(provider, error);
        this.logger.warn(
          {
            provider: provider.name,
            error,
            pubkey: cacheKey,
            latencyMs: Date.now() - rpcStartTime,
          },
          'perf:getAccountInfo failed, trying next provider'
        );
      }
    }

    throw new Error('All RPC providers failed for getAccountInfo');
  }

  /**
   * Get multiple accounts info with automatic failover and caching
   */
  async getMultipleAccountsInfo(
    pubkeys: PublicKey[],
    priority: number = 0
  ): Promise<(AccountInfo<Buffer> | null)[]> {
    if (pubkeys.length === 0) return [];

    const startTime = Date.now();

    // Check cache for all keys
    const results: (AccountInfo<Buffer> | null)[] = new Array(pubkeys.length);
    const uncachedIndices: number[] = [];
    const uncachedKeys: PublicKey[] = [];
    let cacheHits = 0;

    for (let i = 0; i < pubkeys.length; i++) {
      const pubkey = pubkeys[i];
      if (!pubkey) continue;

      const cached = this.cache.get(pubkey.toBase58());
      if (cached !== undefined) {
        results[i] = cached;
        cacheHits++;
      } else {
        uncachedIndices.push(i);
        uncachedKeys.push(pubkey);
      }
    }

    if (uncachedKeys.length === 0) {
      const firstProvider = this.getHealthyProvidersByPriority()[0];
      if (firstProvider) {
        firstProvider.stats.cacheHits += cacheHits;
      }
      this.logger.debug(
        {
          totalKeys: pubkeys.length,
          cacheHits,
          latencyMs: Date.now() - startTime,
        },
        'perf:getMultipleAccountsInfo all cached'
      );
      return results;
    }

    // Fetch uncached accounts
    const providers = this.getHealthyProvidersByPriority();
    const BATCH_SIZE = 100;

    for (const provider of providers) {
      const rpcStartTime = Date.now();
      try {
        let totalRateLimitWaitMs = 0;

        for (let i = 0; i < uncachedKeys.length; i += BATCH_SIZE) {
          const rateLimitStartTime = Date.now();
          await provider.rateLimiter.acquire(priority);
          totalRateLimitWaitMs += Date.now() - rateLimitStartTime;

          const batch = uncachedKeys.slice(i, i + BATCH_SIZE);
          const batchResults = await provider.connection.getMultipleAccountsInfo(
            batch,
            'confirmed'
          );

          // Store results and cache
          for (let j = 0; j < batchResults.length; j++) {
            const idx = i + j;
            const originalIndex = uncachedIndices[idx];
            const uncachedKey = uncachedKeys[idx];
            const batchResult = batchResults[j] ?? null;

            if (originalIndex !== undefined && uncachedKey) {
              results[originalIndex] = batchResult;
              this.cache.set(uncachedKey.toBase58(), batchResult);
            }
          }
        }

        const rpcLatencyMs = Date.now() - rpcStartTime;

        // Update stats
        provider.stats.requestCount++;
        provider.stats.totalLatencyMs += rpcLatencyMs;
        provider.stats.cacheHits += cacheHits;
        provider.stats.cacheMisses += uncachedKeys.length;

        this.markProviderHealthy(provider);
        this.logger.debug(
          {
            provider: provider.name,
            totalKeys: pubkeys.length,
            cacheHits,
            cacheMisses: uncachedKeys.length,
            batches: Math.ceil(uncachedKeys.length / BATCH_SIZE),
            rpcLatencyMs,
            rateLimitWaitMs: totalRateLimitWaitMs,
            totalLatencyMs: Date.now() - startTime,
          },
          'perf:getMultipleAccountsInfo success'
        );

        return results;
      } catch (error) {
        provider.stats.failureCount++;
        this.markProviderUnhealthy(provider, error);
        this.logger.warn(
          {
            provider: provider.name,
            error,
            latencyMs: Date.now() - rpcStartTime,
          },
          'perf:getMultipleAccountsInfo failed, trying next provider'
        );
      }
    }

    throw new Error('All RPC providers failed for getMultipleAccountsInfo');
  }

  /**
   * Send a transaction with automatic failover
   */
  async sendTransaction(
    transaction: VersionedTransaction,
    options?: SendOptions
  ): Promise<string> {
    const startTime = Date.now();
    const providers = this.getHealthyProvidersByPriority();

    for (const provider of providers) {
      const rpcStartTime = Date.now();
      try {
        const rateLimitStartTime = Date.now();
        await provider.rateLimiter.acquire(10); // High priority for transactions
        const rateLimitWaitMs = Date.now() - rateLimitStartTime;

        const signature = await provider.connection.sendTransaction(transaction, options);
        const rpcLatencyMs = Date.now() - rpcStartTime;

        // Update stats
        provider.stats.requestCount++;
        provider.stats.totalLatencyMs += rpcLatencyMs;

        this.markProviderHealthy(provider);
        this.logger.info(
          {
            provider: provider.name,
            signature,
            rpcLatencyMs,
            rateLimitWaitMs,
            totalLatencyMs: Date.now() - startTime,
          },
          'perf:sendTransaction success'
        );

        return signature;
      } catch (error) {
        provider.stats.failureCount++;
        this.markProviderUnhealthy(provider, error);
        this.logger.warn(
          {
            provider: provider.name,
            error,
            latencyMs: Date.now() - rpcStartTime,
          },
          'perf:sendTransaction failed, trying next provider'
        );
      }
    }

    throw new Error('All RPC providers failed to send transaction');
  }

  /**
   * Get a parsed transaction with automatic failover and rate limiting
   */
  async getParsedTransaction(
    signature: string,
    options?: {
      commitment?: Finality;
      maxSupportedTransactionVersion?: number;
    }
  ): Promise<ParsedTransactionWithMeta | null> {
    const startTime = Date.now();
    const providers = this.getHealthyProvidersByPriority();

    for (const provider of providers) {
      const rpcStartTime = Date.now();
      try {
        const rateLimitStartTime = Date.now();
        await provider.rateLimiter.acquire();
        const rateLimitWaitMs = Date.now() - rateLimitStartTime;

        const tx = await provider.connection.getParsedTransaction(signature, {
          commitment: options?.commitment ?? 'confirmed',
          maxSupportedTransactionVersion: options?.maxSupportedTransactionVersion ?? 0,
        });
        const rpcLatencyMs = Date.now() - rpcStartTime;

        // Update stats
        provider.stats.requestCount++;
        provider.stats.totalLatencyMs += rpcLatencyMs;

        this.markProviderHealthy(provider);
        this.logger.debug(
          {
            provider: provider.name,
            signature: signature.slice(0, 20) + '...',
            rpcLatencyMs,
            rateLimitWaitMs,
            totalLatencyMs: Date.now() - startTime,
            found: tx !== null,
          },
          'perf:getParsedTransaction success'
        );

        return tx;
      } catch (error) {
        provider.stats.failureCount++;
        this.markProviderUnhealthy(provider, error);
        this.logger.warn(
          {
            provider: provider.name,
            error,
            signature: signature.slice(0, 20) + '...',
            latencyMs: Date.now() - rpcStartTime,
          },
          'perf:getParsedTransaction failed, trying next provider'
        );
      }
    }

    throw new Error('All RPC providers failed for getParsedTransaction');
  }

  /**
   * Get a specific provider's connection
   */
  getProviderConnection(name: RpcProviderName): Connection | null {
    const provider = this.providers.get(name);
    return provider?.connection ?? null;
  }

  /**
   * Get health status of all providers
   */
  getHealthStatus(): ProviderHealth[] {
    return Array.from(this.providers.values()).map((p) => ({
      name: p.name,
      healthy: p.healthy,
      consecutiveFailures: p.consecutiveFailures,
      lastFailure: p.lastFailure || null,
      lastSuccess: p.lastSuccess || null,
    }));
  }

  /**
   * Clear the response cache
   */
  clearCache(): void {
    this.cache.clear();
  }

  /**
   * Get cache statistics
   */
  getCacheStats(): { size: number } {
    return { size: this.cache.size() };
  }

  /**
   * Get performance statistics for all providers
   */
  getPerformanceStats(): ProviderStats[] {
    return Array.from(this.providers.values()).map((p) => {
      const totalRequests = p.stats.cacheHits + p.stats.cacheMisses;
      return {
        name: p.name,
        requestCount: p.stats.requestCount,
        avgLatencyMs: p.stats.requestCount > 0
          ? Math.round(p.stats.totalLatencyMs / p.stats.requestCount)
          : 0,
        cacheHits: p.stats.cacheHits,
        cacheMisses: p.stats.cacheMisses,
        cacheHitRate: totalRequests > 0
          ? Math.round((p.stats.cacheHits / totalRequests) * 100)
          : 0,
        failureCount: p.stats.failureCount,
        failureRate: p.stats.requestCount > 0
          ? Math.round((p.stats.failureCount / p.stats.requestCount) * 100)
          : 0,
      };
    });
  }

  /**
   * Reset performance statistics for all providers
   */
  resetPerformanceStats(): void {
    for (const provider of this.providers.values()) {
      provider.stats = {
        requestCount: 0,
        totalLatencyMs: 0,
        cacheHits: 0,
        cacheMisses: 0,
        failureCount: 0,
      };
    }
    this.logger.info('Performance stats reset');
  }

  /**
   * Select the next healthy provider using capacity-aware selection
   * Prefers providers with more available rate limit tokens to maximize throughput
   */
  private selectProvider(): RpcProvider {
    const healthyProviders = this.getHealthyProvidersByPriority();

    if (healthyProviders.length === 0) {
      // Fall back to any provider (even unhealthy ones)
      const allProviders = Array.from(this.providers.values());
      if (allProviders.length === 0) {
        throw new Error('No RPC providers configured');
      }
      return allProviders[0]!;
    }

    // Get providers with the highest priority (lowest number)
    const highestPriority = healthyProviders[0]!.priority;
    const samePriorityProviders = healthyProviders.filter(
      (p) => p.priority === highestPriority
    );

    // If only one provider at this priority, use it
    if (samePriorityProviders.length === 1) {
      return samePriorityProviders[0]!;
    }

    // Capacity-aware selection: prefer provider with more available tokens
    // This naturally distributes load proportional to each provider's RPS limit
    let bestProvider = samePriorityProviders[0]!;
    let bestAvailableTokens = bestProvider.rateLimiter.getAvailableTokens();

    for (let i = 1; i < samePriorityProviders.length; i++) {
      const provider = samePriorityProviders[i]!;
      const availableTokens = provider.rateLimiter.getAvailableTokens();

      if (availableTokens > bestAvailableTokens) {
        bestProvider = provider;
        bestAvailableTokens = availableTokens;
      }
    }

    return bestProvider;
  }

  /**
   * Get healthy providers sorted by priority
   */
  private getHealthyProvidersByPriority(): RpcProvider[] {
    const now = Date.now();

    // Check for providers that should recover from unhealthy state
    for (const provider of this.providers.values()) {
      if (
        !provider.healthy &&
        now - provider.lastFailure > this.healthRecoveryCooldownMs
      ) {
        this.logger.info(
          { provider: provider.name },
          'Provider cooldown expired, marking as healthy for retry'
        );
        provider.healthy = true;
        provider.consecutiveFailures = 0;
      }
    }

    return Array.from(this.providers.values())
      .filter((p) => p.healthy)
      .sort((a, b) => a.priority - b.priority);
  }

  /**
   * Mark a provider as unhealthy after failure
   */
  private markProviderUnhealthy(provider: RpcProvider, error: unknown): void {
    provider.consecutiveFailures++;
    provider.lastFailure = Date.now();

    if (provider.consecutiveFailures >= this.maxConsecutiveFailures) {
      provider.healthy = false;
      this.logger.warn(
        {
          provider: provider.name,
          consecutiveFailures: provider.consecutiveFailures,
          error,
        },
        'Provider marked as unhealthy'
      );
    }
  }

  /**
   * Mark a provider as healthy after success
   */
  private markProviderHealthy(provider: RpcProvider): void {
    if (!provider.healthy || provider.consecutiveFailures > 0) {
      this.logger.info(
        { provider: provider.name },
        'Provider recovered to healthy state'
      );
    }
    provider.healthy = true;
    provider.consecutiveFailures = 0;
    provider.lastSuccess = Date.now();
  }
}
