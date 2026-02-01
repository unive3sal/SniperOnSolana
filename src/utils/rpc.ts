import { Connection, PublicKey, AccountInfo } from '@solana/web3.js';
import type { Logger } from 'pino';

/**
 * Simple token bucket rate limiter
 */
export class RateLimiter {
  private tokens: number;
  private lastRefill: number;
  private readonly maxTokens: number;
  private readonly refillRate: number; // tokens per second
  private queue: Array<{ resolve: () => void; priority: number }> = [];
  private processing = false;

  constructor(requestsPerSecond: number) {
    this.maxTokens = requestsPerSecond;
    this.tokens = requestsPerSecond;
    this.refillRate = requestsPerSecond;
    this.lastRefill = Date.now();
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    this.tokens = Math.min(this.maxTokens, this.tokens + elapsed * this.refillRate);
    this.lastRefill = now;
  }

  async acquire(priority = 0): Promise<void> {
    return new Promise((resolve) => {
      this.queue.push({ resolve, priority });
      // Sort by priority (higher = more important)
      this.queue.sort((a, b) => b.priority - a.priority);
      this.processQueue();
    });
  }

  private async processQueue(): Promise<void> {
    if (this.processing) return;
    this.processing = true;

    while (this.queue.length > 0) {
      this.refill();

      if (this.tokens >= 1) {
        this.tokens -= 1;
        const item = this.queue.shift();
        item?.resolve();
      } else {
        // Wait for token refill
        const waitTime = Math.ceil((1 - this.tokens) / this.refillRate * 1000);
        await new Promise((r) => setTimeout(r, Math.max(waitTime, 10)));
      }
    }

    this.processing = false;
  }

  /**
   * Get current available tokens (for monitoring)
   */
  getAvailableTokens(): number {
    this.refill();
    return this.tokens;
  }
}

/**
 * LRU Cache with TTL
 */
export class TTLCache<T> {
  private cache = new Map<string, { value: T; expires: number }>();
  private readonly maxSize: number;
  private readonly ttlMs: number;

  constructor(maxSize: number, ttlMs: number) {
    this.maxSize = maxSize;
    this.ttlMs = ttlMs;
  }

  get(key: string): T | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;

    if (Date.now() > entry.expires) {
      this.cache.delete(key);
      return undefined;
    }

    // Move to end (most recently used)
    this.cache.delete(key);
    this.cache.set(key, entry);
    return entry.value;
  }

  set(key: string, value: T): void {
    // Evict oldest if at capacity
    if (this.cache.size >= this.maxSize) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey) this.cache.delete(oldestKey);
    }

    this.cache.set(key, {
      value,
      expires: Date.now() + this.ttlMs,
    });
  }

  has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  delete(key: string): void {
    this.cache.delete(key);
  }

  clear(): void {
    this.cache.clear();
  }

  size(): number {
    return this.cache.size;
  }
}

/**
 * Request deduplicator - coalesces concurrent requests for the same key
 */
export class RequestDeduplicator<T> {
  private pending = new Map<string, Promise<T>>();

  async dedupe(key: string, fn: () => Promise<T>): Promise<T> {
    const existing = this.pending.get(key);
    if (existing) {
      return existing;
    }

    const promise = fn().finally(() => {
      this.pending.delete(key);
    });

    this.pending.set(key, promise);
    return promise;
  }
}

/**
 * Throttled RPC connection wrapper
 */
export class ThrottledConnection {
  private readonly connection: Connection;
  private readonly rateLimiter: RateLimiter;
  private readonly cache: TTLCache<AccountInfo<Buffer> | null>;
  private readonly deduplicator: RequestDeduplicator<AccountInfo<Buffer> | null>;
  private readonly logger?: Logger;

  constructor(
    connection: Connection,
    requestsPerSecond: number,
    logger?: Logger
  ) {
    this.connection = connection;
    this.rateLimiter = new RateLimiter(requestsPerSecond);
    this.cache = new TTLCache(500, 2000); // 500 items, 2 second TTL
    this.deduplicator = new RequestDeduplicator();
    this.logger = logger;
  }

  /**
   * Get the underlying connection for operations that don't need throttling
   */
  getConnection(): Connection {
    return this.connection;
  }

  /**
   * Get account info with rate limiting and caching
   */
  async getAccountInfo(
    pubkey: PublicKey,
    priority = 0
  ): Promise<AccountInfo<Buffer> | null> {
    const key = pubkey.toBase58();

    // Check cache first
    const cached = this.cache.get(key);
    if (cached !== undefined) {
      return cached;
    }

    // Deduplicate concurrent requests
    return this.deduplicator.dedupe(key, async () => {
      await this.rateLimiter.acquire(priority);

      const result = await this.connection.getAccountInfo(pubkey, 'confirmed');
      this.cache.set(key, result);
      return result;
    });
  }

  /**
   * Get multiple accounts with rate limiting (batched)
   * Much more efficient than individual calls
   */
  async getMultipleAccountsInfo(
    pubkeys: PublicKey[],
    priority = 0
  ): Promise<(AccountInfo<Buffer> | null)[]> {
    if (pubkeys.length === 0) return [];

    // Check cache for all keys
    const results: (AccountInfo<Buffer> | null)[] = new Array(pubkeys.length);
    const uncachedIndices: number[] = [];
    const uncachedKeys: PublicKey[] = [];

    for (let i = 0; i < pubkeys.length; i++) {
      const pubkey = pubkeys[i];
      if (!pubkey) continue;
      const cached = this.cache.get(pubkey.toBase58());
      if (cached !== undefined) {
        results[i] = cached;
      } else {
        uncachedIndices.push(i);
        uncachedKeys.push(pubkey);
      }
    }

    // Fetch uncached accounts in batches of 100 (Solana limit)
    const BATCH_SIZE = 100;
    for (let i = 0; i < uncachedKeys.length; i += BATCH_SIZE) {
      await this.rateLimiter.acquire(priority);

      const batch = uncachedKeys.slice(i, i + BATCH_SIZE);
      const batchResults = await this.connection.getMultipleAccountsInfo(batch, 'confirmed');

      // Store results and cache
      for (let j = 0; j < batchResults.length; j++) {
        const idx = i + j;
        const originalIndex = uncachedIndices[idx] as number;
        const uncachedKey = uncachedKeys[idx] as PublicKey;
        const batchResult = batchResults[j] ?? null;
        results[originalIndex] = batchResult;
        this.cache.set(uncachedKey.toBase58(), batchResult);
      }
    }

    return results;
  }

  /**
   * Clear the cache
   */
  clearCache(): void {
    this.cache.clear();
  }

  /**
   * Get rate limiter stats
   */
  getStats(): { availableTokens: number; cacheSize: number } {
    return {
      availableTokens: this.rateLimiter.getAvailableTokens(),
      cacheSize: this.cache.size(),
    };
  }
}

/**
 * Batch account fetcher for multiple accounts at once
 */
export async function batchGetAccountsInfo(
  connection: Connection,
  pubkeys: PublicKey[],
  rateLimiter?: RateLimiter
): Promise<(AccountInfo<Buffer> | null)[]> {
  if (pubkeys.length === 0) return [];

  const BATCH_SIZE = 100;
  const results: (AccountInfo<Buffer> | null)[] = [];

  for (let i = 0; i < pubkeys.length; i += BATCH_SIZE) {
    if (rateLimiter) {
      await rateLimiter.acquire();
    }

    const batch = pubkeys.slice(i, i + BATCH_SIZE);
    const batchResults = await connection.getMultipleAccountsInfo(batch, 'confirmed');
    results.push(...batchResults);
  }

  return results;
}

/**
 * Shared instances for rate limiting and caching
 */
let sharedRateLimiter: RateLimiter | null = null;
let sharedCacheTtlMs = 2000; // Default 2 seconds
let sharedAccountCache: TTLCache<AccountInfo<Buffer> | null> | null = null;

export function getSharedRateLimiter(requestsPerSecond = 8): RateLimiter {
  if (!sharedRateLimiter) {
    sharedRateLimiter = new RateLimiter(requestsPerSecond);
  }
  return sharedRateLimiter;
}

export function setRateLimitRps(requestsPerSecond: number): void {
  sharedRateLimiter = new RateLimiter(requestsPerSecond);
}

export function getSharedCacheTtlMs(): number {
  return sharedCacheTtlMs;
}

export function setCacheTtlMs(ttlMs: number): void {
  sharedCacheTtlMs = ttlMs;
  // Recreate cache with new TTL
  sharedAccountCache = new TTLCache<AccountInfo<Buffer> | null>(1000, ttlMs);
}

export function getSharedAccountCache(): TTLCache<AccountInfo<Buffer> | null> {
  if (!sharedAccountCache) {
    sharedAccountCache = new TTLCache<AccountInfo<Buffer> | null>(1000, sharedCacheTtlMs);
  }
  return sharedAccountCache;
}

/**
 * Get account info with caching and rate limiting
 * Use this instead of connection.getAccountInfo() for better RPC efficiency
 */
export async function getCachedAccountInfo(
  connection: Connection,
  pubkey: PublicKey
): Promise<AccountInfo<Buffer> | null> {
  const cache = getSharedAccountCache();
  const key = pubkey.toBase58();

  // Check cache first
  const cached = cache.get(key);
  if (cached !== undefined) {
    return cached;
  }

  // Rate limit and fetch
  const rateLimiter = getSharedRateLimiter();
  await rateLimiter.acquire();

  const result = await connection.getAccountInfo(pubkey, 'confirmed');
  cache.set(key, result);
  return result;
}

/**
 * Get multiple accounts with caching and rate limiting
 * Use this instead of connection.getMultipleAccountsInfo() for better RPC efficiency
 */
export async function getCachedMultipleAccountsInfo(
  connection: Connection,
  pubkeys: PublicKey[]
): Promise<(AccountInfo<Buffer> | null)[]> {
  if (pubkeys.length === 0) return [];

  const cache = getSharedAccountCache();
  const results: (AccountInfo<Buffer> | null)[] = new Array(pubkeys.length);
  const uncachedIndices: number[] = [];
  const uncachedKeys: PublicKey[] = [];

  // Check cache for all keys
  for (let i = 0; i < pubkeys.length; i++) {
    const pubkey = pubkeys[i];
    if (!pubkey) continue;
    const cached = cache.get(pubkey.toBase58());
    if (cached !== undefined) {
      results[i] = cached;
    } else {
      uncachedIndices.push(i);
      uncachedKeys.push(pubkey);
    }
  }

  // Fetch uncached accounts in batches of 100
  const BATCH_SIZE = 100;
  const rateLimiter = getSharedRateLimiter();

  for (let i = 0; i < uncachedKeys.length; i += BATCH_SIZE) {
    await rateLimiter.acquire();

    const batch = uncachedKeys.slice(i, i + BATCH_SIZE);
    const batchResults = await connection.getMultipleAccountsInfo(batch, 'confirmed');

    // Store results and cache
    for (let j = 0; j < batchResults.length; j++) {
      const idx = i + j;
      const originalIndex = uncachedIndices[idx];
      const uncachedKey = uncachedKeys[idx];
      const batchResult = batchResults[j] ?? null;
      if (originalIndex !== undefined && uncachedKey) {
        results[originalIndex] = batchResult;
        cache.set(uncachedKey.toBase58(), batchResult);
      }
    }
  }

  return results;
}
