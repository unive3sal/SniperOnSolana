import { Connection, PublicKey } from '@solana/web3.js';
import type { Logger } from 'pino';
import type { RiskFactor } from '../../config/types.js';
import { RISK_WEIGHTS } from '../../config/constants.js';
import { getMintWithProgram } from './token2022.js';

/**
 * Check if mint authority is revoked
 */
export async function checkMintAuthority(
  connection: Connection,
  mint: PublicKey,
  logger: Logger
): Promise<RiskFactor> {
  const factor: RiskFactor = {
    name: 'mint_authority',
    score: 0,
    maxScore: RISK_WEIGHTS.MINT_AUTHORITY_REVOKED,
    passed: false,
    details: '',
  };

  try {
    const result = await getMintWithProgram(connection, mint);
    
    if (!result) {
      factor.details = 'Failed to fetch mint info';
      return factor;
    }

    const { mintInfo } = result;

    if (mintInfo.mintAuthority === null) {
      factor.passed = true;
      factor.score = RISK_WEIGHTS.MINT_AUTHORITY_REVOKED;
      factor.details = 'Mint authority revoked - cannot mint more tokens';
    } else {
      factor.passed = false;
      factor.score = 0;
      factor.details = `Mint authority active: ${mintInfo.mintAuthority.toBase58()}`;
    }

    logger.debug(
      { mint: mint.toBase58(), mintAuthority: mintInfo.mintAuthority?.toBase58() ?? 'revoked' },
      'Mint authority check completed'
    );
  } catch (error) {
    logger.warn({ error, mint: mint.toBase58() }, 'Failed to check mint authority');
    factor.details = 'Failed to fetch mint info';
  }

  return factor;
}

/**
 * Check if freeze authority is revoked
 */
export async function checkFreezeAuthority(
  connection: Connection,
  mint: PublicKey,
  logger: Logger
): Promise<RiskFactor> {
  const factor: RiskFactor = {
    name: 'freeze_authority',
    score: 0,
    maxScore: RISK_WEIGHTS.FREEZE_AUTHORITY_REVOKED,
    passed: false,
    details: '',
  };

  try {
    const result = await getMintWithProgram(connection, mint);
    
    if (!result) {
      factor.details = 'Failed to fetch mint info';
      return factor;
    }

    const { mintInfo } = result;

    if (mintInfo.freezeAuthority === null) {
      factor.passed = true;
      factor.score = RISK_WEIGHTS.FREEZE_AUTHORITY_REVOKED;
      factor.details = 'Freeze authority revoked - tokens cannot be frozen';
    } else {
      factor.passed = false;
      factor.score = 0;
      factor.details = `Freeze authority active: ${mintInfo.freezeAuthority.toBase58()}`;
    }

    logger.debug(
      { mint: mint.toBase58(), freezeAuthority: mintInfo.freezeAuthority?.toBase58() ?? 'revoked' },
      'Freeze authority check completed'
    );
  } catch (error) {
    logger.warn({ error, mint: mint.toBase58() }, 'Failed to check freeze authority');
    factor.details = 'Failed to fetch mint info';
  }

  return factor;
}

/**
 * Combined authority check - fetches mint info once and checks both authorities
 */
export async function checkAuthorities(
  connection: Connection,
  mint: PublicKey,
  logger: Logger
): Promise<{ mintAuthority: RiskFactor; freezeAuthority: RiskFactor }> {
  const mintAuthorityFactor: RiskFactor = {
    name: 'mint_authority',
    score: 0,
    maxScore: RISK_WEIGHTS.MINT_AUTHORITY_REVOKED,
    passed: false,
    details: '',
  };

  const freezeAuthorityFactor: RiskFactor = {
    name: 'freeze_authority',
    score: 0,
    maxScore: RISK_WEIGHTS.FREEZE_AUTHORITY_REVOKED,
    passed: false,
    details: '',
  };

  try {
    // Single RPC call to get mint info
    const result = await getMintWithProgram(connection, mint);
    
    if (!result) {
      mintAuthorityFactor.details = 'Failed to fetch mint info';
      freezeAuthorityFactor.details = 'Failed to fetch mint info';
      return { mintAuthority: mintAuthorityFactor, freezeAuthority: freezeAuthorityFactor };
    }

    const { mintInfo } = result;

    // Check mint authority
    if (mintInfo.mintAuthority === null) {
      mintAuthorityFactor.passed = true;
      mintAuthorityFactor.score = RISK_WEIGHTS.MINT_AUTHORITY_REVOKED;
      mintAuthorityFactor.details = 'Mint authority revoked - cannot mint more tokens';
    } else {
      mintAuthorityFactor.details = `Mint authority active: ${mintInfo.mintAuthority.toBase58()}`;
    }

    // Check freeze authority
    if (mintInfo.freezeAuthority === null) {
      freezeAuthorityFactor.passed = true;
      freezeAuthorityFactor.score = RISK_WEIGHTS.FREEZE_AUTHORITY_REVOKED;
      freezeAuthorityFactor.details = 'Freeze authority revoked - tokens cannot be frozen';
    } else {
      freezeAuthorityFactor.details = `Freeze authority active: ${mintInfo.freezeAuthority.toBase58()}`;
    }

    logger.debug(
      {
        mint: mint.toBase58(),
        mintAuthority: mintInfo.mintAuthority?.toBase58() ?? 'revoked',
        freezeAuthority: mintInfo.freezeAuthority?.toBase58() ?? 'revoked',
      },
      'Authority checks completed'
    );

  } catch (error) {
    logger.warn({ error, mint: mint.toBase58() }, 'Failed to check authorities');
    mintAuthorityFactor.details = 'Failed to fetch mint info';
    freezeAuthorityFactor.details = 'Failed to fetch mint info';
  }

  return { mintAuthority: mintAuthorityFactor, freezeAuthority: freezeAuthorityFactor };
}
