import { Connection, PublicKey } from '@solana/web3.js';
import type { Logger } from 'pino';
import type { RiskFactor } from '../../config/types.js';
import { RISK_WEIGHTS } from '../../config/constants.js';

/**
 * Holder analysis result
 */
export interface HolderAnalysis {
  totalHolders: number;
  topHolderPercent: number;
  top5HoldersPercent: number;
  top10HoldersPercent: number;
  devWalletPercent: number;
  concentrationRisk: 'low' | 'medium' | 'high';
}

/**
 * Analyze token holder distribution
 */
export async function analyzeHolders(
  connection: Connection,
  mint: PublicKey,
  maxTopHolderPercent: number,
  logger: Logger
): Promise<{ factor: RiskFactor; analysis: HolderAnalysis }> {
  const factor: RiskFactor = {
    name: 'holder_distribution',
    score: 0,
    maxScore: 20, // Max penalty reduction
    passed: false,
    details: '',
  };

  const analysis: HolderAnalysis = {
    totalHolders: 0,
    topHolderPercent: 0,
    top5HoldersPercent: 0,
    top10HoldersPercent: 0,
    devWalletPercent: 0,
    concentrationRisk: 'high',
  };

  try {
    // Get largest token accounts
    const largestAccounts = await connection.getTokenLargestAccounts(mint, 'confirmed');
    
    if (largestAccounts.value.length === 0) {
      factor.details = 'No token holders found';
      return { factor, analysis };
    }

    // Get total supply
    const supplyInfo = await connection.getTokenSupply(mint, 'confirmed');
    const totalSupply = BigInt(supplyInfo.value.amount);

    if (totalSupply === 0n) {
      factor.details = 'Zero total supply';
      return { factor, analysis };
    }

    // Calculate holder percentages
    const holders = largestAccounts.value.map(account => ({
      address: account.address.toBase58(),
      amount: BigInt(account.amount),
      percent: Number((BigInt(account.amount) * 10000n) / totalSupply) / 100,
    }));

    analysis.totalHolders = holders.length;
    analysis.topHolderPercent = holders[0]?.percent ?? 0;
    analysis.top5HoldersPercent = holders.slice(0, 5).reduce((sum, h) => sum + h.percent, 0);
    analysis.top10HoldersPercent = holders.slice(0, 10).reduce((sum, h) => sum + h.percent, 0);

    // Determine concentration risk
    if (analysis.topHolderPercent <= 10 && analysis.top5HoldersPercent <= 30) {
      analysis.concentrationRisk = 'low';
    } else if (analysis.topHolderPercent <= 20 && analysis.top5HoldersPercent <= 50) {
      analysis.concentrationRisk = 'medium';
    } else {
      analysis.concentrationRisk = 'high';
    }

    // Calculate score
    if (analysis.topHolderPercent <= maxTopHolderPercent) {
      factor.passed = true;
      // Score based on how well distributed
      if (analysis.concentrationRisk === 'low') {
        factor.score = 15;
      } else if (analysis.concentrationRisk === 'medium') {
        factor.score = 10;
      } else {
        factor.score = 5;
      }
    } else {
      factor.passed = false;
      // Apply penalty for concentration
      const excessPercent = analysis.topHolderPercent - maxTopHolderPercent;
      factor.score = -Math.min(Math.floor(excessPercent * RISK_WEIGHTS.TOP_HOLDER_PENALTY), 20);
    }

    factor.details = `Top holder: ${analysis.topHolderPercent.toFixed(1)}%, Top 5: ${analysis.top5HoldersPercent.toFixed(1)}%, Risk: ${analysis.concentrationRisk}`;

    logger.debug(
      {
        mint: mint.toBase58(),
        topHolder: analysis.topHolderPercent,
        top5: analysis.top5HoldersPercent,
        concentrationRisk: analysis.concentrationRisk,
      },
      'Holder analysis completed'
    );
  } catch (error) {
    logger.warn({ error, mint: mint.toBase58() }, 'Failed to analyze holders');
    factor.details = 'Failed to analyze holder distribution';
  }

  return { factor, analysis };
}

/**
 * Check for known dev/team wallet patterns
 */
export async function checkDevWallet(
  connection: Connection,
  mint: PublicKey,
  creator: PublicKey | null,
  logger: Logger
): Promise<RiskFactor> {
  const factor: RiskFactor = {
    name: 'dev_wallet',
    score: 0,
    maxScore: 10,
    passed: true, // Pass by default unless red flags found
    details: '',
  };

  if (!creator) {
    factor.details = 'Creator unknown';
    return factor;
  }

  try {
    // Get largest accounts
    const largestAccounts = await connection.getTokenLargestAccounts(mint, 'confirmed');
    const supplyInfo = await connection.getTokenSupply(mint, 'confirmed');
    const totalSupply = BigInt(supplyInfo.value.amount);

    if (totalSupply === 0n) {
      return factor;
    }

    // Check if creator holds significant amount
    for (const account of largestAccounts.value) {
      const accountInfo = await connection.getParsedAccountInfo(account.address, 'confirmed');
      const data = accountInfo.value?.data;
      
      if (data && 'parsed' in data) {
        const owner = data.parsed?.info?.owner;
        if (owner && owner === creator.toBase58()) {
          const devPercent = Number((BigInt(account.amount) * 10000n) / totalSupply) / 100;
          
          if (devPercent > 10) {
            factor.passed = false;
            factor.score = -10;
            factor.details = `Dev wallet holds ${devPercent.toFixed(1)}%`;
          } else {
            factor.details = `Dev wallet holds ${devPercent.toFixed(1)}%`;
            factor.score = 5;
          }
          break;
        }
      }
    }

    if (!factor.details) {
      factor.details = 'Dev wallet not in top holders';
      factor.score = RISK_WEIGHTS.KNOWN_DEVELOPER;
    }

    logger.debug(
      { mint: mint.toBase58(), creator: creator.toBase58() },
      'Dev wallet check completed'
    );
  } catch (error) {
    logger.warn({ error, mint: mint.toBase58() }, 'Failed to check dev wallet');
  }

  return factor;
}

/**
 * Check for bundled buys (snipers/bots buying at launch)
 */
export async function checkBundledBuys(
  connection: Connection,
  mint: PublicKey,
  logger: Logger
): Promise<{ bundled: boolean; bundledPercent: number }> {
  // This would require analyzing transaction history
  // For now, return a placeholder
  logger.debug({ mint: mint.toBase58() }, 'Bundled buy check skipped (requires historical data)');
  
  return {
    bundled: false,
    bundledPercent: 0,
  };
}
