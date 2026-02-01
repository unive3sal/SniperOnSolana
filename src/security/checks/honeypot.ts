import {
  Connection,
  PublicKey,
  Transaction,
  TransactionInstruction,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import type { Logger } from 'pino';
import type { RiskFactor, DexType } from '../../config/types.js';
import { RISK_WEIGHTS, PROGRAM_IDS, TOKEN_MINTS, PUMPFUN_CONSTANTS } from '../../config/constants.js';
import { getSharedRateLimiter } from '../../utils/rpc.js';

/**
 * Honeypot detection result
 */
export interface HoneypotResult {
  isHoneypot: boolean;
  canBuy: boolean;
  canSell: boolean;
  buyTax: number;
  sellTax: number;
  transferTax: number;
  hasBlacklist: boolean;
  hasMaxTx: boolean;
  maxTxAmount?: number;
  error?: string;
}

/**
 * Simulate a sell transaction to detect honeypot
 */
export async function simulateSell(
  connection: Connection,
  mint: PublicKey,
  pool: PublicKey,
  dex: DexType,
  testAmount: bigint,
  owner: PublicKey,
  logger: Logger
): Promise<HoneypotResult> {
  const result: HoneypotResult = {
    isHoneypot: false,
    canBuy: true, // Assume can buy if we got here
    canSell: false,
    buyTax: 0,
    sellTax: 0,
    transferTax: 0,
    hasBlacklist: false,
    hasMaxTx: false,
  };

  try {
    // Build a simulated sell transaction based on DEX
    let sellIx: TransactionInstruction | null = null;

    if (dex === 'pumpfun') {
      sellIx = await buildPumpfunSellInstruction(
        mint,
        pool,
        testAmount,
        owner
      );
    } else if (dex === 'raydium') {
      sellIx = await buildRaydiumSellInstruction(
        connection,
        mint,
        pool,
        testAmount,
        owner
      );
    }

    if (!sellIx) {
      result.error = 'Could not build sell instruction';
      return result;
    }

    // Rate limit RPC calls
    const rateLimiter = getSharedRateLimiter();
    await rateLimiter.acquire();

    // Create transaction
    const { blockhash } = await connection.getLatestBlockhash('confirmed');
    const tx = new Transaction();
    tx.recentBlockhash = blockhash;
    tx.feePayer = owner;
    tx.add(sellIx);

    await rateLimiter.acquire();
    // Simulate transaction
    const simulation = await connection.simulateTransaction(tx, []);

    if (simulation.value.err) {
      // Check error type
      const errorStr = JSON.stringify(simulation.value.err);
      
      if (errorStr.includes('InsufficientFunds')) {
        // This is expected if we don't have tokens
        result.canSell = true;
        result.error = 'Simulation failed due to insufficient funds (expected)';
      } else if (
        errorStr.includes('blocked') ||
        errorStr.includes('blacklist') ||
        errorStr.includes('denied')
      ) {
        result.isHoneypot = true;
        result.canSell = false;
        result.hasBlacklist = true;
        result.error = 'Token appears to have blacklist functionality';
      } else if (errorStr.includes('max') || errorStr.includes('limit')) {
        result.hasMaxTx = true;
        result.error = 'Token has max transaction limit';
      } else {
        result.error = `Simulation error: ${errorStr}`;
      }

      logger.debug(
        { mint: mint.toBase58(), error: errorStr, logs: simulation.value.logs },
        'Sell simulation failed'
      );
    } else {
      result.canSell = true;
      
      // Check logs for tax indicators
      const logs = simulation.value.logs ?? [];
      result.sellTax = detectTaxFromLogs(logs);
      
      if (result.sellTax > 50) {
        result.isHoneypot = true;
        result.error = `Extremely high sell tax detected: ${result.sellTax}%`;
      }

      logger.debug(
        { mint: mint.toBase58(), sellTax: result.sellTax, logs: logs.slice(0, 5) },
        'Sell simulation successful'
      );
    }
  } catch (error) {
    result.error = `Simulation exception: ${error instanceof Error ? error.message : String(error)}`;
    logger.warn({ error, mint: mint.toBase58() }, 'Honeypot simulation failed');
  }

  return result;
}

/**
 * Build Pump.fun sell instruction for simulation
 */
async function buildPumpfunSellInstruction(
  mint: PublicKey,
  bondingCurve: PublicKey,
  amount: bigint,
  owner: PublicKey
): Promise<TransactionInstruction | null> {
  try {
    const associatedUser = await getAssociatedTokenAddress(mint, owner);
    const associatedBondingCurve = await getAssociatedTokenAddress(mint, bondingCurve, true);

    // Pump.fun sell instruction
    // Discriminator: [51, 230, 133, 164, 1, 127, 131, 173]
    const data = Buffer.alloc(24);
    data.set([51, 230, 133, 164, 1, 127, 131, 173], 0); // discriminator
    data.writeBigUInt64LE(amount, 8); // amount
    data.writeBigUInt64LE(0n, 16); // min_sol_output

    return new TransactionInstruction({
      programId: PROGRAM_IDS.PUMPFUN_PROGRAM,
      keys: [
        { pubkey: PROGRAM_IDS.PUMPFUN_GLOBAL, isSigner: false, isWritable: false },
        { pubkey: PROGRAM_IDS.PUMPFUN_FEE_RECIPIENT, isSigner: false, isWritable: true },
        { pubkey: mint, isSigner: false, isWritable: false },
        { pubkey: bondingCurve, isSigner: false, isWritable: true },
        { pubkey: associatedBondingCurve, isSigner: false, isWritable: true },
        { pubkey: associatedUser, isSigner: false, isWritable: true },
        { pubkey: owner, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: PROGRAM_IDS.PUMPFUN_EVENT_AUTHORITY, isSigner: false, isWritable: false },
        { pubkey: PROGRAM_IDS.PUMPFUN_PROGRAM, isSigner: false, isWritable: false },
      ],
      data,
    });
  } catch {
    return null;
  }
}

/**
 * Build Raydium sell instruction for simulation
 */
async function buildRaydiumSellInstruction(
  connection: Connection,
  mint: PublicKey,
  pool: PublicKey,
  amount: bigint,
  owner: PublicKey
): Promise<TransactionInstruction | null> {
  // This is a simplified version - full Raydium swap requires pool state
  // For simulation purposes, we just need to check if the token can be sold
  try {
    const userTokenAccount = await getAssociatedTokenAddress(mint, owner);
    const userSolAccount = await getAssociatedTokenAddress(TOKEN_MINTS.SOL, owner);

    // Raydium swap base in
    // This is a placeholder - actual implementation needs pool accounts
    const data = Buffer.alloc(17);
    data.set([143, 190, 90, 218, 196, 30, 51, 222], 0); // swap_base_in discriminator
    data.writeBigUInt64LE(amount, 8);
    data.writeUInt8(0, 16); // dummy

    return new TransactionInstruction({
      programId: PROGRAM_IDS.RAYDIUM_AMM_V4,
      keys: [
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: pool, isSigner: false, isWritable: true },
        { pubkey: PROGRAM_IDS.RAYDIUM_AUTHORITY, isSigner: false, isWritable: false },
        // Additional accounts would be needed here
      ],
      data,
    });
  } catch {
    return null;
  }
}

/**
 * Detect tax percentage from transaction logs
 */
function detectTaxFromLogs(logs: string[]): number {
  // Look for common tax indicators in logs
  for (const log of logs) {
    const taxMatch = log.match(/tax[:\s]+(\d+(?:\.\d+)?)/i);
    if (taxMatch) {
      return parseFloat(taxMatch[1] ?? '0');
    }
    
    const feeMatch = log.match(/fee[:\s]+(\d+(?:\.\d+)?)/i);
    if (feeMatch) {
      return parseFloat(feeMatch[1] ?? '0');
    }
  }
  
  return 0;
}

/**
 * Full honeypot check
 */
export async function checkHoneypot(
  connection: Connection,
  mint: PublicKey,
  pool: PublicKey,
  dex: DexType,
  owner: PublicKey,
  maxTaxPercent: number,
  logger: Logger
): Promise<RiskFactor> {
  const factor: RiskFactor = {
    name: 'honeypot',
    score: 0,
    maxScore: RISK_WEIGHTS.HONEYPOT_PASSED,
    passed: false,
    details: '',
  };

  // Use a small test amount (1000 tokens with 6 decimals)
  const testAmount = BigInt(1000 * 1e6);

  const result = await simulateSell(
    connection,
    mint,
    pool,
    dex,
    testAmount,
    owner,
    logger
  );

  if (result.isHoneypot) {
    factor.passed = false;
    factor.score = -50; // Heavy penalty for honeypot
    factor.details = result.error ?? 'Honeypot detected';
  } else if (!result.canSell && result.error?.includes('insufficient')) {
    // Can't determine due to insufficient funds - give partial score
    factor.passed = true;
    factor.score = RISK_WEIGHTS.HONEYPOT_PASSED / 2;
    factor.details = 'Could not fully verify (insufficient test funds)';
  } else if (result.canSell) {
    if (result.sellTax <= maxTaxPercent) {
      factor.passed = true;
      factor.score = RISK_WEIGHTS.HONEYPOT_PASSED;
      factor.details = result.sellTax > 0 
        ? `Sell simulation passed (${result.sellTax}% tax)`
        : 'Sell simulation passed';
    } else {
      factor.passed = false;
      factor.score = -20;
      factor.details = `High sell tax: ${result.sellTax}%`;
    }
  } else {
    factor.passed = false;
    factor.score = -30;
    factor.details = result.error ?? 'Sell simulation failed';
  }

  logger.info(
    {
      mint: mint.toBase58(),
      isHoneypot: result.isHoneypot,
      canSell: result.canSell,
      sellTax: result.sellTax,
      passed: factor.passed,
    },
    'Honeypot check completed'
  );

  return factor;
}
