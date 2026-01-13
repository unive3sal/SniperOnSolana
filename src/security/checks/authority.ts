import { Connection, PublicKey } from '@solana/web3.js';
import { getMint, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import type { Logger } from 'pino';
import type { RiskFactor } from '../../config/types.js';
import { RISK_WEIGHTS } from '../../config/constants.js';

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
    // Try Token Program first
    let mintInfo;
    try {
      mintInfo = await getMint(connection, mint, 'confirmed', TOKEN_PROGRAM_ID);
    } catch {
      // Try Token-2022 Program
      mintInfo = await getMint(connection, mint, 'confirmed', TOKEN_2022_PROGRAM_ID);
    }

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
    // Try Token Program first
    let mintInfo;
    try {
      mintInfo = await getMint(connection, mint, 'confirmed', TOKEN_PROGRAM_ID);
    } catch {
      // Try Token-2022 Program
      mintInfo = await getMint(connection, mint, 'confirmed', TOKEN_2022_PROGRAM_ID);
    }

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
 * Combined authority check
 */
export async function checkAuthorities(
  connection: Connection,
  mint: PublicKey,
  logger: Logger
): Promise<{ mintAuthority: RiskFactor; freezeAuthority: RiskFactor }> {
  const [mintAuthority, freezeAuthority] = await Promise.all([
    checkMintAuthority(connection, mint, logger),
    checkFreezeAuthority(connection, mint, logger),
  ]);

  return { mintAuthority, freezeAuthority };
}
