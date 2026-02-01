import { Connection, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import type { Logger } from 'pino';
import type { RiskFactor } from '../../config/types.js';
import { RISK_WEIGHTS, TOKEN_MINTS } from '../../config/constants.js';
import { getSharedRateLimiter, getCachedMultipleAccountsInfo } from '../../utils/rpc.js';

/**
 * Check pool liquidity level
 */
export async function checkPoolLiquidity(
  connection: Connection,
  quoteVault: PublicKey,
  quoteMint: PublicKey,
  minLiquiditySol: number,
  logger: Logger
): Promise<RiskFactor> {
  const factor: RiskFactor = {
    name: 'liquidity',
    score: 0,
    maxScore: RISK_WEIGHTS.LIQUIDITY_BONUS,
    passed: false,
    details: '',
  };

  try {
    let liquiditySol = 0;

    // Rate limit RPC calls
    const rateLimiter = getSharedRateLimiter();
    await rateLimiter.acquire();

    // Check if quote is SOL (wrapped)
    if (quoteMint.equals(TOKEN_MINTS.SOL)) {
      // Get SOL balance of vault
      const balance = await connection.getBalance(quoteVault, 'confirmed');
      liquiditySol = balance / LAMPORTS_PER_SOL;
    } else {
      // For other quote tokens (USDC, etc.), fetch token account balance
      const accountInfo = await connection.getTokenAccountBalance(quoteVault, 'confirmed');
      const amount = Number(accountInfo.value.amount);
      const decimals = accountInfo.value.decimals;
      
      // Convert to approximate SOL value (rough estimate for stablecoins)
      // In production, you'd fetch actual price
      if (quoteMint.equals(TOKEN_MINTS.USDC) || quoteMint.equals(TOKEN_MINTS.USDT)) {
        // Assume ~$100 per SOL for rough estimate
        liquiditySol = (amount / Math.pow(10, decimals)) / 100;
      } else {
        // For other tokens, just use raw amount as proxy
        liquiditySol = amount / Math.pow(10, decimals);
      }
    }

    if (liquiditySol >= minLiquiditySol) {
      factor.passed = true;
      factor.score = liquiditySol >= 10 ? RISK_WEIGHTS.LIQUIDITY_BONUS : Math.floor(RISK_WEIGHTS.LIQUIDITY_BONUS * (liquiditySol / 10));
      factor.details = `Liquidity: ${liquiditySol.toFixed(2)} SOL`;
    } else {
      factor.passed = false;
      factor.score = 0;
      factor.details = `Insufficient liquidity: ${liquiditySol.toFixed(2)} SOL (min: ${minLiquiditySol} SOL)`;
    }

    logger.debug(
      { quoteVault: quoteVault.toBase58(), liquiditySol },
      'Liquidity check completed'
    );
  } catch (error) {
    logger.warn({ error, quoteVault: quoteVault.toBase58() }, 'Failed to check liquidity');
    factor.details = 'Failed to fetch vault balance';
  }

  return factor;
}

/**
 * Check if LP tokens are locked
 * This checks for common LP locker programs
 */
export async function checkLpLock(
  connection: Connection,
  lpMint: PublicKey,
  logger: Logger
): Promise<RiskFactor> {
  const factor: RiskFactor = {
    name: 'lp_lock',
    score: 0,
    maxScore: RISK_WEIGHTS.LP_LOCKED + RISK_WEIGHTS.LP_LOCK_DURATION_BONUS,
    passed: false,
    details: '',
  };

  // Known LP locker programs
  const LP_LOCKERS = [
    // Streamflow
    new PublicKey('8e72pYCDaxu3GqMfeQ5r8wFgoZSYk6oua1Qo9XpsZjX'),
    // Uncx
    new PublicKey('GJsLSvRQ2vL4wQjJWGxHFRmGPrZdGNzmJJH5zTSmUkzq'),
    // Team Finance
    new PublicKey('TEAM_FINANCE_PROGRAM_ID'),
    // Raydium LP Lock
    new PublicKey('RAYLock11111111111111111111111111111111111'),
  ];

  try {
    // Rate limit RPC calls
    const rateLimiter = getSharedRateLimiter();
    await rateLimiter.acquire();

    // Get largest LP token holders
    const largestAccounts = await connection.getTokenLargestAccounts(lpMint, 'confirmed');

    if (largestAccounts.value.length === 0) {
      factor.details = 'No LP token holders found';
      return factor;
    }

    // Check if top holders are locker contracts
    let totalLocked = 0n;
    let totalSupply = 0n;

    // Calculate total supply from largest accounts
    for (const account of largestAccounts.value) {
      totalSupply += BigInt(account.amount);
    }

    // Batch fetch all account infos at once with caching
    const accountAddresses = largestAccounts.value.map(a => a.address);
    const accountInfos = await getCachedMultipleAccountsInfo(connection, accountAddresses);

    // Check which accounts are owned by known lockers
    for (let i = 0; i < accountInfos.length; i++) {
      const accountInfo = accountInfos[i];
      const account = largestAccounts.value[i];
      if (accountInfo && account && LP_LOCKERS.some(locker => {
        try {
          return accountInfo.owner.equals(locker);
        } catch {
          return false;
        }
      })) {
        totalLocked += BigInt(account.amount);
      }
    }

    const lockedPercent = totalSupply > 0n 
      ? Number((totalLocked * 100n) / totalSupply)
      : 0;

    if (lockedPercent >= 90) {
      factor.passed = true;
      factor.score = RISK_WEIGHTS.LP_LOCKED + RISK_WEIGHTS.LP_LOCK_DURATION_BONUS;
      factor.details = `${lockedPercent}% of LP tokens locked`;
    } else if (lockedPercent >= 50) {
      factor.passed = true;
      factor.score = RISK_WEIGHTS.LP_LOCKED;
      factor.details = `${lockedPercent}% of LP tokens locked (partial)`;
    } else {
      factor.passed = false;
      factor.score = 0;
      factor.details = `Only ${lockedPercent}% of LP tokens locked`;
    }

    logger.debug(
      { lpMint: lpMint.toBase58(), lockedPercent },
      'LP lock check completed'
    );
  } catch (error) {
    logger.warn({ error, lpMint: lpMint.toBase58() }, 'Failed to check LP lock');
    factor.details = 'Failed to verify LP lock status';
  }

  return factor;
}

/**
 * Check LP burn status (alternative to locking)
 */
export async function checkLpBurn(
  connection: Connection,
  lpMint: PublicKey,
  logger: Logger
): Promise<RiskFactor> {
  const factor: RiskFactor = {
    name: 'lp_burn',
    score: 0,
    maxScore: RISK_WEIGHTS.LP_LOCKED,
    passed: false,
    details: '',
  };

  try {
    // Rate limit RPC calls
    const rateLimiter = getSharedRateLimiter();
    await rateLimiter.acquire();

    // Get LP mint info to check supply vs largest accounts
    const mintInfo = await connection.getTokenSupply(lpMint, 'confirmed');
    const totalSupply = BigInt(mintInfo.value.amount);

    await rateLimiter.acquire();
    // Get largest accounts
    const largestAccounts = await connection.getTokenLargestAccounts(lpMint, 'confirmed');
    
    let circulatingSupply = 0n;
    for (const account of largestAccounts.value) {
      circulatingSupply += BigInt(account.amount);
    }

    // If circulating is much less than total, tokens might be burned
    const burnedPercent = totalSupply > 0n
      ? Number(((totalSupply - circulatingSupply) * 100n) / totalSupply)
      : 0;

    if (burnedPercent >= 90) {
      factor.passed = true;
      factor.score = RISK_WEIGHTS.LP_LOCKED;
      factor.details = `~${burnedPercent}% of LP tokens burned`;
    }

    logger.debug(
      { lpMint: lpMint.toBase58(), burnedPercent },
      'LP burn check completed'
    );
  } catch (error) {
    logger.warn({ error, lpMint: lpMint.toBase58() }, 'Failed to check LP burn');
  }

  return factor;
}
