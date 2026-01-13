import { PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { TOKEN_MINTS } from '../config/constants.js';

/**
 * Convert lamports to SOL
 */
export function lamportsToSol(lamports: number | bigint): number {
  return Number(lamports) / LAMPORTS_PER_SOL;
}

/**
 * Convert SOL to lamports
 */
export function solToLamports(sol: number): number {
  return Math.floor(sol * LAMPORTS_PER_SOL);
}

/**
 * Convert basis points to percentage
 */
export function bpsToPercent(bps: number): number {
  return bps / 100;
}

/**
 * Convert percentage to basis points
 */
export function percentToBps(percent: number): number {
  return Math.floor(percent * 100);
}

/**
 * Check if a mint is SOL (native or wrapped)
 */
export function isSolMint(mint: PublicKey): boolean {
  return mint.equals(TOKEN_MINTS.SOL);
}

/**
 * Check if a mint is a stablecoin
 */
export function isStablecoin(mint: PublicKey): boolean {
  return mint.equals(TOKEN_MINTS.USDC) || mint.equals(TOKEN_MINTS.USDT);
}

/**
 * Parse public key safely
 */
export function parsePublicKey(value: string): PublicKey | null {
  try {
    return new PublicKey(value);
  } catch {
    return null;
  }
}

/**
 * Generate a unique ID
 */
export function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

/**
 * Format number with commas
 */
export function formatNumber(num: number, decimals: number = 2): string {
  return num.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

/**
 * Format SOL amount
 */
export function formatSol(lamports: number | bigint): string {
  const sol = lamportsToSol(lamports);
  return `${formatNumber(sol, 4)} SOL`;
}

/**
 * Format percentage
 */
export function formatPercent(value: number): string {
  const sign = value >= 0 ? '+' : '';
  return `${sign}${formatNumber(value, 2)}%`;
}

/**
 * Calculate percentage change
 */
export function calculatePercentChange(oldValue: number, newValue: number): number {
  if (oldValue === 0) return 0;
  return ((newValue - oldValue) / oldValue) * 100;
}

/**
 * Calculate price from reserves (constant product AMM)
 */
export function calculatePriceFromReserves(
  baseReserve: number,
  quoteReserve: number,
  baseDecimals: number,
  quoteDecimals: number
): number {
  const adjustedBase = baseReserve / Math.pow(10, baseDecimals);
  const adjustedQuote = quoteReserve / Math.pow(10, quoteDecimals);
  return adjustedQuote / adjustedBase;
}

/**
 * Calculate output amount for a swap (constant product AMM)
 */
export function calculateSwapOutput(
  inputAmount: number,
  inputReserve: number,
  outputReserve: number,
  feeBps: number = 25 // 0.25% default fee
): number {
  const feeMultiplier = 1 - feeBps / 10000;
  const inputWithFee = inputAmount * feeMultiplier;
  const numerator = inputWithFee * outputReserve;
  const denominator = inputReserve + inputWithFee;
  return numerator / denominator;
}

/**
 * Calculate minimum output with slippage
 */
export function calculateMinOutput(
  expectedOutput: number,
  slippageBps: number
): number {
  const slippageMultiplier = 1 - slippageBps / 10000;
  return expectedOutput * slippageMultiplier;
}

/**
 * Check if value is within range
 */
export function isInRange(value: number, min: number, max: number): boolean {
  return value >= min && value <= max;
}

/**
 * Clamp value to range
 */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Deep clone an object
 */
export function deepClone<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj));
}

/**
 * Create a deferred promise
 */
export function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  
  return { promise, resolve, reject };
}

/**
 * Chunk an array into smaller arrays
 */
export function chunk<T>(array: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}

/**
 * Remove duplicates from array
 */
export function unique<T>(array: T[], key?: (item: T) => string): T[] {
  if (!key) {
    return [...new Set(array)];
  }
  
  const seen = new Set<string>();
  return array.filter((item) => {
    const k = key(item);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
