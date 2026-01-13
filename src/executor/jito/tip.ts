import type { Logger } from 'pino';
import type { JitoConfig } from '../../config/types.js';

/**
 * Tip calculation strategy
 */
export type TipStrategy = 'fixed' | 'dynamic' | 'competitive';

/**
 * Tip calculation result
 */
export interface TipCalculation {
  tipLamports: number;
  strategy: TipStrategy;
  reason: string;
}

/**
 * Dynamic tip manager for Jito bundles
 */
export class TipManager {
  private readonly config: JitoConfig;
  private readonly logger: Logger;
  private recentTips: number[] = [];
  private readonly maxRecentTips = 10;

  constructor(config: JitoConfig, logger: Logger) {
    this.config = config;
    this.logger = logger.child({ component: 'tip-manager' });
  }

  /**
   * Calculate optimal tip based on strategy
   */
  calculateTip(
    strategy: TipStrategy,
    options?: {
      expectedProfitLamports?: number;
      competitorTips?: number[];
      urgency?: 'low' | 'medium' | 'high';
    }
  ): TipCalculation {
    switch (strategy) {
      case 'fixed':
        return this.calculateFixedTip();
      
      case 'dynamic':
        return this.calculateDynamicTip(options?.expectedProfitLamports ?? 0);
      
      case 'competitive':
        return this.calculateCompetitiveTip(
          options?.competitorTips ?? [],
          options?.urgency ?? 'medium'
        );
      
      default:
        return this.calculateFixedTip();
    }
  }

  /**
   * Fixed tip strategy - use configured tip amount
   */
  private calculateFixedTip(): TipCalculation {
    return {
      tipLamports: this.config.tipLamports,
      strategy: 'fixed',
      reason: `Fixed tip: ${this.config.tipLamports} lamports`,
    };
  }

  /**
   * Dynamic tip strategy - based on expected profit
   */
  private calculateDynamicTip(expectedProfitLamports: number): TipCalculation {
    if (expectedProfitLamports <= 0) {
      return this.calculateFixedTip();
    }

    // Calculate tip as percentage of expected profit
    const percentTip = Math.floor(expectedProfitLamports * (this.config.tipPercent / 100));
    
    // Clamp between min and max
    const tipLamports = Math.max(
      this.config.tipLamports, // minimum
      Math.min(percentTip, this.config.maxTipLamports) // max
    );

    return {
      tipLamports,
      strategy: 'dynamic',
      reason: `${this.config.tipPercent}% of ${expectedProfitLamports} lamports profit`,
    };
  }

  /**
   * Competitive tip strategy - outbid competitors
   */
  private calculateCompetitiveTip(
    competitorTips: number[],
    urgency: 'low' | 'medium' | 'high'
  ): TipCalculation {
    // Calculate base from competitor tips
    const maxCompetitorTip = competitorTips.length > 0
      ? Math.max(...competitorTips)
      : this.config.tipLamports;

    // Add increment based on urgency
    const urgencyMultiplier = {
      low: 1.1,
      medium: 1.25,
      high: 1.5,
    };

    const tipLamports = Math.min(
      Math.floor(maxCompetitorTip * urgencyMultiplier[urgency]),
      this.config.maxTipLamports
    );

    return {
      tipLamports: Math.max(tipLamports, this.config.tipLamports),
      strategy: 'competitive',
      reason: `Competitive tip (${urgency} urgency): ${tipLamports} lamports`,
    };
  }

  /**
   * Record a tip for historical tracking
   */
  recordTip(tipLamports: number, landed: boolean): void {
    if (landed) {
      this.recentTips.push(tipLamports);
      if (this.recentTips.length > this.maxRecentTips) {
        this.recentTips.shift();
      }
    }
  }

  /**
   * Get average recent tip
   */
  getAverageRecentTip(): number {
    if (this.recentTips.length === 0) {
      return this.config.tipLamports;
    }
    return Math.floor(
      this.recentTips.reduce((a, b) => a + b, 0) / this.recentTips.length
    );
  }

  /**
   * Get recommended tip based on historical success
   */
  getRecommendedTip(): TipCalculation {
    const avgTip = this.getAverageRecentTip();
    
    // If we have historical data, use average + 10% as recommendation
    if (this.recentTips.length >= 5) {
      const recommendedTip = Math.floor(avgTip * 1.1);
      return {
        tipLamports: Math.min(recommendedTip, this.config.maxTipLamports),
        strategy: 'dynamic',
        reason: `Based on ${this.recentTips.length} recent successful tips`,
      };
    }

    return this.calculateFixedTip();
  }

  /**
   * Calculate tip for a specific trade value
   */
  calculateTipForTrade(
    tradeSolAmount: number,
    expectedProfitPercent: number
  ): TipCalculation {
    // Convert to lamports
    const tradeValueLamports = tradeSolAmount * 1e9;
    const expectedProfitLamports = tradeValueLamports * (expectedProfitPercent / 100);

    return this.calculateDynamicTip(expectedProfitLamports);
  }

  /**
   * Get tip statistics
   */
  getStats(): {
    recentTipCount: number;
    averageTip: number;
    minTip: number;
    maxTip: number;
  } {
    if (this.recentTips.length === 0) {
      return {
        recentTipCount: 0,
        averageTip: this.config.tipLamports,
        minTip: this.config.tipLamports,
        maxTip: this.config.tipLamports,
      };
    }

    return {
      recentTipCount: this.recentTips.length,
      averageTip: this.getAverageRecentTip(),
      minTip: Math.min(...this.recentTips),
      maxTip: Math.max(...this.recentTips),
    };
  }
}
