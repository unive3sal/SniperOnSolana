import { Connection, PublicKey } from '@solana/web3.js';
import {
  getMint,
  getExtensionTypes,
  ExtensionType,
  getTransferFeeConfig,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  Mint,
} from '@solana/spl-token';
import type { Logger } from 'pino';
import type { RiskFactor, Token2022ExtensionInfo } from '../../config/types.js';
import { RISK_WEIGHTS } from '../../config/constants.js';
import { getSharedRateLimiter } from '../../utils/rpc.js';

/**
 * Critical extensions that should cause instant rejection
 */
const CRITICAL_EXTENSIONS = new Set([
  ExtensionType.MintCloseAuthority,
  ExtensionType.PermanentDelegate,
  ExtensionType.TransferHook,
  ExtensionType.NonTransferable,
]);

/**
 * Extensions that warrant warnings but aren't instant-fail
 */
const WARNING_EXTENSIONS = new Set([
  ExtensionType.TransferFeeConfig,
  ExtensionType.DefaultAccountState,
  ExtensionType.ConfidentialTransferMint,
  ExtensionType.InterestBearingConfig,
]);

/**
 * Human-readable names for extension types
 */
const EXTENSION_NAMES: Record<number, string> = {
  [ExtensionType.MintCloseAuthority]: 'MintCloseAuthority',
  [ExtensionType.PermanentDelegate]: 'PermanentDelegate',
  [ExtensionType.TransferHook]: 'TransferHook',
  [ExtensionType.NonTransferable]: 'NonTransferable',
  [ExtensionType.TransferFeeConfig]: 'TransferFee',
  [ExtensionType.DefaultAccountState]: 'DefaultAccountState',
  [ExtensionType.ConfidentialTransferMint]: 'ConfidentialTransfer',
  [ExtensionType.InterestBearingConfig]: 'InterestBearing',
  [ExtensionType.MetadataPointer]: 'MetadataPointer',
  [ExtensionType.TokenMetadata]: 'TokenMetadata',
  [ExtensionType.GroupPointer]: 'GroupPointer',
  [ExtensionType.GroupMemberPointer]: 'GroupMemberPointer',
};

/**
 * Check if a mint is a Token-2022 token
 */
export async function isToken2022Mint(
  connection: Connection,
  mint: PublicKey
): Promise<boolean> {
  try {
    const rateLimiter = getSharedRateLimiter();
    await rateLimiter.acquire();

    const accountInfo = await connection.getAccountInfo(mint, 'confirmed');
    if (!accountInfo) return false;
    return accountInfo.owner.equals(TOKEN_2022_PROGRAM_ID);
  } catch {
    return false;
  }
}

/**
 * Get mint info with program detection
 * Returns mint info and which program it belongs to
 */
export async function getMintWithProgram(
  connection: Connection,
  mint: PublicKey
): Promise<{ mintInfo: Mint; programId: PublicKey } | null> {
  const rateLimiter = getSharedRateLimiter();
  await rateLimiter.acquire();

  // First check account owner to determine program
  const accountInfo = await connection.getAccountInfo(mint, 'confirmed');
  if (!accountInfo) return null;

  const programId = accountInfo.owner;

  await rateLimiter.acquire();
  if (programId.equals(TOKEN_PROGRAM_ID)) {
    const mintInfo = await getMint(connection, mint, 'confirmed', TOKEN_PROGRAM_ID);
    return { mintInfo, programId };
  } else if (programId.equals(TOKEN_2022_PROGRAM_ID)) {
    const mintInfo = await getMint(connection, mint, 'confirmed', TOKEN_2022_PROGRAM_ID);
    return { mintInfo, programId };
  }

  return null;
}

/**
 * Parse Token-2022 extensions from a mint
 */
export function parseToken2022Extensions(mintInfo: Mint): Token2022ExtensionInfo {
  const info: Token2022ExtensionInfo = {
    isToken2022: true,
    extensions: [],
    hasMintCloseAuthority: false,
    hasPermanentDelegate: false,
    hasTransferHook: false,
    isNonTransferable: false,
    defaultAccountStateFrozen: false,
  };

  try {
    const extensionTypes = getExtensionTypes(mintInfo.tlvData);
    info.extensions = extensionTypes.map(ext => EXTENSION_NAMES[ext] ?? `Unknown(${ext})`);

    // Check for critical extensions
    info.hasMintCloseAuthority = extensionTypes.includes(ExtensionType.MintCloseAuthority);
    info.hasPermanentDelegate = extensionTypes.includes(ExtensionType.PermanentDelegate);
    info.hasTransferHook = extensionTypes.includes(ExtensionType.TransferHook);
    info.isNonTransferable = extensionTypes.includes(ExtensionType.NonTransferable);

    // Check for transfer fee
    if (extensionTypes.includes(ExtensionType.TransferFeeConfig)) {
      const transferFeeConfig = getTransferFeeConfig(mintInfo);
      if (transferFeeConfig) {
        // Get the newer (current or next) fee config
        const newerFee = transferFeeConfig.newerTransferFee;
        const olderFee = transferFeeConfig.olderTransferFee;
        
        // Use the higher of the two fees to be conservative
        const newerFeeBps = newerFee.transferFeeBasisPoints;
        const olderFeeBps = olderFee.transferFeeBasisPoints;
        const maxFeeBps = Math.max(newerFeeBps, olderFeeBps);
        
        info.transferFeePercent = maxFeeBps / 100; // Convert basis points to percent
      }
    }

    // Check for default account state
    if (extensionTypes.includes(ExtensionType.DefaultAccountState)) {
      // DefaultAccountState extension means new accounts are frozen by default
      // This is a red flag for potential honeypot
      info.defaultAccountStateFrozen = true;
    }

  } catch {
    // If we can't parse extensions, the token might not have any
    info.extensions = [];
  }

  return info;
}

/**
 * Analyze Token-2022 extensions and return risk factors
 */
export async function checkToken2022Extensions(
  connection: Connection,
  mint: PublicKey,
  logger: Logger
): Promise<{ factors: RiskFactor[]; extensionInfo: Token2022ExtensionInfo | null }> {
  const factors: RiskFactor[] = [];
  const mintStr = mint.toBase58();

  try {
    const result = await getMintWithProgram(connection, mint);
    
    if (!result) {
      logger.warn({ mint: mintStr }, 'Could not fetch mint info for Token-2022 check');
      return { factors: [], extensionInfo: null };
    }

    const { mintInfo, programId } = result;

    // Regular SPL Token (not Token-2022)
    if (programId.equals(TOKEN_PROGRAM_ID)) {
      factors.push({
        name: 'token_program',
        score: RISK_WEIGHTS.TOKEN_STANDARD_SPL,
        maxScore: RISK_WEIGHTS.TOKEN_STANDARD_SPL,
        passed: true,
        details: 'Standard SPL Token (no extension risks)',
      });

      logger.debug({ mint: mintStr }, 'Token is standard SPL Token');
      
      return {
        factors,
        extensionInfo: {
          isToken2022: false,
          extensions: [],
          hasMintCloseAuthority: false,
          hasPermanentDelegate: false,
          hasTransferHook: false,
          isNonTransferable: false,
          defaultAccountStateFrozen: false,
        },
      };
    }

    // Token-2022 - parse extensions
    const extensionInfo = parseToken2022Extensions(mintInfo);

    logger.info(
      { mint: mintStr, extensions: extensionInfo.extensions },
      'Token-2022 extensions detected'
    );

    // Check for critical extensions (instant fail)
    if (extensionInfo.hasMintCloseAuthority) {
      factors.push({
        name: 'mint_close_authority',
        score: RISK_WEIGHTS.TOKEN2022_MINT_CLOSE_AUTHORITY,
        maxScore: 0,
        passed: false,
        details: 'CRITICAL: MintCloseAuthority extension - mint can be closed, making tokens worthless',
      });
    }

    if (extensionInfo.hasPermanentDelegate) {
      factors.push({
        name: 'permanent_delegate',
        score: RISK_WEIGHTS.TOKEN2022_PERMANENT_DELEGATE,
        maxScore: 0,
        passed: false,
        details: 'CRITICAL: PermanentDelegate extension - authority can transfer/burn any holder\'s tokens',
      });
    }

    if (extensionInfo.hasTransferHook) {
      factors.push({
        name: 'transfer_hook',
        score: RISK_WEIGHTS.TOKEN2022_TRANSFER_HOOK,
        maxScore: 0,
        passed: false,
        details: 'CRITICAL: TransferHook extension - custom program can block transfers (honeypot risk)',
      });
    }

    if (extensionInfo.isNonTransferable) {
      factors.push({
        name: 'non_transferable',
        score: RISK_WEIGHTS.TOKEN2022_NON_TRANSFERABLE,
        maxScore: 0,
        passed: false,
        details: 'CRITICAL: NonTransferable extension - tokens cannot be transferred or sold',
      });
    }

    // Check transfer fee
    if (extensionInfo.transferFeePercent !== undefined) {
      const feePercent = extensionInfo.transferFeePercent;
      
      if (feePercent > 1) {
        // Over 1% - high risk
        factors.push({
          name: 'transfer_fee',
          score: RISK_WEIGHTS.TOKEN2022_HIGH_TRANSFER_FEE,
          maxScore: 0,
          passed: false,
          details: `High transfer fee: ${feePercent.toFixed(2)}% (max safe: 1%)`,
        });
      } else if (feePercent > 0.1) {
        // 0.1% - 1% - warning
        factors.push({
          name: 'transfer_fee',
          score: RISK_WEIGHTS.TOKEN2022_MODERATE_TRANSFER_FEE,
          maxScore: 0,
          passed: true, // Pass but with penalty
          details: `Moderate transfer fee: ${feePercent.toFixed(2)}%`,
        });
      } else if (feePercent > 0) {
        // Under 0.1% - acceptable
        factors.push({
          name: 'transfer_fee',
          score: 0,
          maxScore: 0,
          passed: true,
          details: `Low transfer fee: ${feePercent.toFixed(3)}%`,
        });
      }
    }

    // Check default account state
    if (extensionInfo.defaultAccountStateFrozen) {
      factors.push({
        name: 'default_frozen',
        score: RISK_WEIGHTS.TOKEN2022_DEFAULT_FROZEN,
        maxScore: 0,
        passed: false,
        details: 'DefaultAccountState extension - new token accounts are frozen by default',
      });
    }

    // Check if token has NO dangerous extensions (bonus)
    const hasCriticalExtension = 
      extensionInfo.hasMintCloseAuthority ||
      extensionInfo.hasPermanentDelegate ||
      extensionInfo.hasTransferHook ||
      extensionInfo.isNonTransferable;

    const hasHighFee = (extensionInfo.transferFeePercent ?? 0) > 1;

    if (!hasCriticalExtension && !hasHighFee && !extensionInfo.defaultAccountStateFrozen) {
      factors.push({
        name: 'token2022_safe',
        score: RISK_WEIGHTS.TOKEN2022_NO_DANGEROUS_EXTENSIONS,
        maxScore: RISK_WEIGHTS.TOKEN2022_NO_DANGEROUS_EXTENSIONS,
        passed: true,
        details: `Token-2022 with safe extensions: ${extensionInfo.extensions.join(', ') || 'none'}`,
      });
    }

    return { factors, extensionInfo };

  } catch (error) {
    logger.error({ error, mint: mintStr }, 'Failed to check Token-2022 extensions');
    
    // Return a warning factor on error
    factors.push({
      name: 'token2022_check_error',
      score: -10,
      maxScore: 0,
      passed: false,
      details: `Failed to analyze Token-2022 extensions: ${error instanceof Error ? error.message : String(error)}`,
    });

    return { factors, extensionInfo: null };
  }
}

/**
 * Quick check for critical Token-2022 extensions
 * Returns true if token has any instant-fail extensions
 */
export async function hasCriticalExtensions(
  connection: Connection,
  mint: PublicKey,
  logger: Logger
): Promise<{ hasCritical: boolean; reasons: string[] }> {
  const reasons: string[] = [];

  try {
    const result = await getMintWithProgram(connection, mint);
    
    if (!result) {
      return { hasCritical: false, reasons: [] };
    }

    const { mintInfo, programId } = result;

    // Regular SPL Token - no extension risks
    if (programId.equals(TOKEN_PROGRAM_ID)) {
      return { hasCritical: false, reasons: [] };
    }

    // Parse Token-2022 extensions
    const extensionInfo = parseToken2022Extensions(mintInfo);

    if (extensionInfo.hasMintCloseAuthority) {
      reasons.push('MintCloseAuthority: mint can be closed');
    }
    if (extensionInfo.hasPermanentDelegate) {
      reasons.push('PermanentDelegate: tokens can be stolen');
    }
    if (extensionInfo.hasTransferHook) {
      reasons.push('TransferHook: transfers can be blocked');
    }
    if (extensionInfo.isNonTransferable) {
      reasons.push('NonTransferable: cannot sell tokens');
    }
    if ((extensionInfo.transferFeePercent ?? 0) > 10) {
      reasons.push(`TransferFee: ${extensionInfo.transferFeePercent}% fee`);
    }

    return {
      hasCritical: reasons.length > 0,
      reasons,
    };

  } catch (error) {
    logger.warn({ error, mint: mint.toBase58() }, 'Error checking critical extensions');
    return { hasCritical: false, reasons: [] };
  }
}
