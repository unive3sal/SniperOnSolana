import { PublicKey } from '@solana/web3.js';
import { LRUCache } from 'lru-cache';
import type { Logger } from 'pino';
import { TIMING } from '../../config/constants.js';

/**
 * Blacklist entry
 */
export interface BlacklistEntry {
  address: string;
  type: 'token' | 'developer' | 'pool';
  reason: string;
  addedAt: number;
  source?: string;
}

/**
 * Blacklist manager with LRU cache
 */
export class BlacklistManager {
  private readonly cache: LRUCache<string, BlacklistEntry>;
  private readonly logger: Logger;
  
  // Known scam addresses (hardcoded for now, could be loaded from API)
  private static readonly KNOWN_SCAMS: BlacklistEntry[] = [
    // Add known scam addresses here
    // {
    //   address: '...',
    //   type: 'developer',
    //   reason: 'Known rug puller',
    //   addedAt: Date.now(),
    // },
  ];

  constructor(logger: Logger, maxEntries: number = 10000) {
    this.logger = logger.child({ component: 'blacklist' });
    
    this.cache = new LRUCache<string, BlacklistEntry>({
      max: maxEntries,
      ttl: TIMING.BLACKLIST_CACHE_TTL_MS,
    });

    // Load known scams
    this.loadKnownScams();
  }

  /**
   * Load known scams into cache
   */
  private loadKnownScams(): void {
    for (const entry of BlacklistManager.KNOWN_SCAMS) {
      this.cache.set(entry.address, entry);
    }
    this.logger.info({ count: BlacklistManager.KNOWN_SCAMS.length }, 'Loaded known scams');
  }

  /**
   * Check if an address is blacklisted
   */
  isBlacklisted(address: PublicKey | string): BlacklistEntry | null {
    const key = typeof address === 'string' ? address : address.toBase58();
    return this.cache.get(key) ?? null;
  }

  /**
   * Add address to blacklist
   */
  add(
    address: PublicKey | string,
    type: BlacklistEntry['type'],
    reason: string,
    source?: string
  ): void {
    const key = typeof address === 'string' ? address : address.toBase58();
    
    const entry: BlacklistEntry = {
      address: key,
      type,
      reason,
      addedAt: Date.now(),
      source,
    };

    this.cache.set(key, entry);
    this.logger.info({ address: key, type, reason }, 'Added to blacklist');
  }

  /**
   * Remove address from blacklist
   */
  remove(address: PublicKey | string): boolean {
    const key = typeof address === 'string' ? address : address.toBase58();
    const existed = this.cache.has(key);
    this.cache.delete(key);
    
    if (existed) {
      this.logger.info({ address: key }, 'Removed from blacklist');
    }
    
    return existed;
  }

  /**
   * Get all blacklisted addresses
   */
  getAll(): BlacklistEntry[] {
    const entries: BlacklistEntry[] = [];
    for (const [_, entry] of this.cache.entries()) {
      entries.push(entry);
    }
    return entries;
  }

  /**
   * Get blacklist size
   */
  size(): number {
    return this.cache.size;
  }

  /**
   * Clear all entries
   */
  clear(): void {
    this.cache.clear();
    this.loadKnownScams(); // Reload known scams
    this.logger.info('Blacklist cleared');
  }

  /**
   * Check multiple addresses at once
   */
  checkMultiple(addresses: (PublicKey | string)[]): Map<string, BlacklistEntry | null> {
    const results = new Map<string, BlacklistEntry | null>();
    
    for (const addr of addresses) {
      const key = typeof addr === 'string' ? addr : addr.toBase58();
      results.set(key, this.isBlacklisted(key));
    }
    
    return results;
  }
}

/**
 * Whitelist manager for known safe tokens/developers
 */
export class WhitelistManager {
  private readonly cache: LRUCache<string, { addedAt: number; reason: string }>;
  private readonly logger: Logger;

  constructor(logger: Logger, maxEntries: number = 1000) {
    this.logger = logger.child({ component: 'whitelist' });
    
    this.cache = new LRUCache({
      max: maxEntries,
      ttl: TIMING.BLACKLIST_CACHE_TTL_MS,
    });
  }

  /**
   * Check if address is whitelisted
   */
  isWhitelisted(address: PublicKey | string): boolean {
    const key = typeof address === 'string' ? address : address.toBase58();
    return this.cache.has(key);
  }

  /**
   * Add to whitelist
   */
  add(address: PublicKey | string, reason: string): void {
    const key = typeof address === 'string' ? address : address.toBase58();
    this.cache.set(key, { addedAt: Date.now(), reason });
    this.logger.info({ address: key, reason }, 'Added to whitelist');
  }

  /**
   * Remove from whitelist
   */
  remove(address: PublicKey | string): boolean {
    const key = typeof address === 'string' ? address : address.toBase58();
    const existed = this.cache.has(key);
    this.cache.delete(key);
    return existed;
  }
}
