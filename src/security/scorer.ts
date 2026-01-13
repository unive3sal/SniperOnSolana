import type { RiskFactor, RiskAnalysis } from '../config/types.js';

/**
 * Calculate overall risk score from individual factors
 */
export function calculateRiskScore(factors: RiskFactor[]): RiskAnalysis {
  let totalScore = 0;
  let maxPossibleScore = 0;
  const warnings: string[] = [];
  const passedFactors: RiskFactor[] = [];
  const failedFactors: RiskFactor[] = [];

  for (const factor of factors) {
    totalScore += factor.score;
    maxPossibleScore += factor.maxScore;

    if (factor.passed) {
      passedFactors.push(factor);
    } else {
      failedFactors.push(factor);
      if (factor.details) {
        warnings.push(`${factor.name}: ${factor.details}`);
      }
    }
  }

  // Normalize score to 0-100 range
  // Negative scores are possible from penalties
  const normalizedScore = Math.max(
    0,
    Math.min(100, Math.round((totalScore / Math.max(maxPossibleScore, 1)) * 100))
  );

  // Determine if overall analysis passed
  // Must have no critical failures and score above threshold
  const hasCriticalFailure = factors.some(f => 
    !f.passed && (
      f.name === 'honeypot' ||
      f.name === 'mint_authority' ||
      (f.name === 'holder_distribution' && f.score < -10)
    )
  );

  return {
    score: normalizedScore,
    passed: !hasCriticalFailure && normalizedScore >= 50,
    factors,
    warnings,
    timestamp: Date.now(),
  };
}

/**
 * Get risk level label from score
 */
export function getRiskLevel(score: number): 'high' | 'medium' | 'low' {
  if (score >= 70) return 'low';
  if (score >= 40) return 'medium';
  return 'high';
}

/**
 * Format risk analysis for logging
 */
export function formatRiskAnalysis(analysis: RiskAnalysis): string {
  const level = getRiskLevel(analysis.score);
  const lines: string[] = [
    `Risk Score: ${analysis.score}/100 (${level.toUpperCase()})`,
    `Status: ${analysis.passed ? 'PASSED' : 'FAILED'}`,
    '',
    'Factors:',
  ];

  for (const factor of analysis.factors) {
    const status = factor.passed ? '+' : '-';
    lines.push(`  ${status} ${factor.name}: ${factor.score}/${factor.maxScore} - ${factor.details || 'OK'}`);
  }

  if (analysis.warnings.length > 0) {
    lines.push('');
    lines.push('Warnings:');
    for (const warning of analysis.warnings) {
      lines.push(`  ! ${warning}`);
    }
  }

  return lines.join('\n');
}

/**
 * Quick check to determine if we should proceed to deep analysis
 */
export function shouldProceedToDeepAnalysis(fastCheckFactors: RiskFactor[]): boolean {
  // If any critical fast check failed, don't proceed
  const criticalFailure = fastCheckFactors.some(f => 
    !f.passed && (
      f.name === 'mint_authority' ||
      f.name === 'freeze_authority' ||
      f.name === 'liquidity'
    )
  );

  return !criticalFailure;
}

/**
 * Merge two risk analyses
 */
export function mergeAnalyses(fast: RiskAnalysis, deep: RiskAnalysis): RiskAnalysis {
  return calculateRiskScore([...fast.factors, ...deep.factors]);
}
