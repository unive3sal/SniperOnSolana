import type { Logger } from 'pino';

/**
 * Retry options
 */
export interface RetryOptions {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  backoffMultiplier: number;
  retryableErrors?: string[];
  onRetry?: (error: Error, attempt: number) => void;
}

/**
 * Default retry options
 */
export const DEFAULT_RETRY_OPTIONS: RetryOptions = {
  maxAttempts: 3,
  baseDelayMs: 1000,
  maxDelayMs: 30000,
  backoffMultiplier: 2,
};

/**
 * Sleep for a specified duration
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Calculate exponential backoff delay
 */
export function calculateBackoff(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
  multiplier: number
): number {
  const delay = baseDelayMs * Math.pow(multiplier, attempt - 1);
  // Add jitter (10-30% random variation)
  const jitter = delay * (0.1 + Math.random() * 0.2);
  return Math.min(delay + jitter, maxDelayMs);
}

/**
 * Retry a function with exponential backoff
 */
export async function retry<T>(
  fn: () => Promise<T>,
  options: Partial<RetryOptions> = {},
  logger?: Logger
): Promise<T> {
  const opts = { ...DEFAULT_RETRY_OPTIONS, ...options };
  let lastError: Error | null = null;
  
  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      
      // Check if error is retryable
      if (opts.retryableErrors && opts.retryableErrors.length > 0) {
        const isRetryable = opts.retryableErrors.some(
          (msg) => lastError!.message.includes(msg)
        );
        if (!isRetryable) {
          throw lastError;
        }
      }
      
      // Call retry callback if provided
      if (opts.onRetry) {
        opts.onRetry(lastError, attempt);
      }
      
      // Log retry attempt
      if (logger) {
        logger.warn(
          { attempt, maxAttempts: opts.maxAttempts, error: lastError.message },
          'Retry attempt failed'
        );
      }
      
      // Don't sleep on last attempt
      if (attempt < opts.maxAttempts) {
        const delay = calculateBackoff(
          attempt,
          opts.baseDelayMs,
          opts.maxDelayMs,
          opts.backoffMultiplier
        );
        await sleep(delay);
      }
    }
  }
  
  throw lastError;
}

/**
 * Retry with timeout
 */
export async function retryWithTimeout<T>(
  fn: () => Promise<T>,
  timeoutMs: number,
  options: Partial<RetryOptions> = {},
  logger?: Logger
): Promise<T> {
  return Promise.race([
    retry(fn, options, logger),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Operation timed out after ${timeoutMs}ms`)), timeoutMs)
    ),
  ]);
}

/**
 * Create a timeout promise
 */
export function timeout<T>(promise: Promise<T>, ms: number, message?: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(message ?? `Operation timed out after ${ms}ms`)),
        ms
      )
    ),
  ]);
}
