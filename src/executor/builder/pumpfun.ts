import {
  Connection,
  PublicKey,
  TransactionInstruction,
  SystemProgram,
  LAMPORTS_PER_SOL,
  ComputeBudgetProgram,
} from '@solana/web3.js';
import {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import type { Logger } from 'pino';
import { PROGRAM_IDS, PUMPFUN_CONSTANTS, PUMPFUN_DISCRIMINATORS } from '../../config/constants.js';
import { parsePumpfunBondingCurveState, calculatePumpfunBuyOutput, calculatePumpfunSellOutput } from '../../monitor/parsers/pumpfun.js';
import { getSharedRateLimiter } from '../../utils/rpc.js';

/**
 * Pump.fun swap parameters
 */
export interface PumpfunSwapParams {
  mint: PublicKey;
  bondingCurve: PublicKey;
  owner: PublicKey;
  solAmount?: number; // For buy
  tokenAmount?: bigint; // For sell
  slippageBps: number;
}

/**
 * Build Pump.fun buy instruction
 */
export async function buildPumpfunBuyInstruction(
  connection: Connection,
  params: PumpfunSwapParams,
  logger: Logger
): Promise<TransactionInstruction[]> {
  const instructions: TransactionInstruction[] = [];

  if (!params.solAmount) {
    throw new Error('solAmount required for buy');
  }

  const solAmountLamports = BigInt(Math.floor(params.solAmount * LAMPORTS_PER_SOL));

  // Get associated token addresses first (no RPC needed)
  const userAta = await getAssociatedTokenAddress(params.mint, params.owner);
  const bondingCurveAta = await getAssociatedTokenAddress(
    params.mint,
    params.bondingCurve,
    true // allowOwnerOffCurve
  );

  // Batch fetch bonding curve and user ATA in one RPC call
  const rateLimiter = getSharedRateLimiter();
  await rateLimiter.acquire();

  const [bondingCurveAccount, userAtaAccount] = await connection.getMultipleAccountsInfo(
    [params.bondingCurve, userAta],
    'confirmed'
  );

  if (!bondingCurveAccount) {
    throw new Error('Bonding curve account not found');
  }

  const state = parsePumpfunBondingCurveState(bondingCurveAccount.data);
  if (!state) {
    throw new Error('Failed to parse bonding curve state');
  }

  if (state.complete) {
    throw new Error('Bonding curve is complete (migrated to Raydium)');
  }

  // Calculate expected output
  const expectedTokens = calculatePumpfunBuyOutput(state, solAmountLamports);
  const minTokens = (expectedTokens * BigInt(10000 - params.slippageBps)) / 10000n;

  logger.debug({
    solAmount: params.solAmount,
    expectedTokens: expectedTokens.toString(),
    minTokens: minTokens.toString(),
    slippageBps: params.slippageBps,
  }, 'Calculated Pump.fun buy output');
  if (!userAtaAccount) {
    instructions.push(
      createAssociatedTokenAccountInstruction(
        params.owner,
        userAta,
        params.owner,
        params.mint
      )
    );
  }

  // Build buy instruction
  // Pump.fun buy discriminator: [102, 6, 61, 18, 1, 218, 235, 234]
  const data = Buffer.alloc(24);
  data.set(PUMPFUN_DISCRIMINATORS.BUY, 0);
  data.writeBigUInt64LE(minTokens, 8); // amount (min tokens to receive)
  data.writeBigUInt64LE(solAmountLamports, 16); // max_sol_cost

  const buyIx = new TransactionInstruction({
    programId: PROGRAM_IDS.PUMPFUN_PROGRAM,
    keys: [
      { pubkey: PROGRAM_IDS.PUMPFUN_GLOBAL, isSigner: false, isWritable: false },
      { pubkey: PROGRAM_IDS.PUMPFUN_FEE_RECIPIENT, isSigner: false, isWritable: true },
      { pubkey: params.mint, isSigner: false, isWritable: false },
      { pubkey: params.bondingCurve, isSigner: false, isWritable: true },
      { pubkey: bondingCurveAta, isSigner: false, isWritable: true },
      { pubkey: userAta, isSigner: false, isWritable: true },
      { pubkey: params.owner, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: new PublicKey('SysvarRent111111111111111111111111111111111'), isSigner: false, isWritable: false },
      { pubkey: PROGRAM_IDS.PUMPFUN_EVENT_AUTHORITY, isSigner: false, isWritable: false },
      { pubkey: PROGRAM_IDS.PUMPFUN_PROGRAM, isSigner: false, isWritable: false },
    ],
    data,
  });

  instructions.push(buyIx);

  return instructions;
}

/**
 * Build Pump.fun sell instruction
 */
export async function buildPumpfunSellInstruction(
  connection: Connection,
  params: PumpfunSwapParams,
  logger: Logger
): Promise<TransactionInstruction[]> {
  const instructions: TransactionInstruction[] = [];

  if (!params.tokenAmount) {
    throw new Error('tokenAmount required for sell');
  }

  // Get bonding curve state with rate limiting
  const rateLimiter = getSharedRateLimiter();
  await rateLimiter.acquire();

  const bondingCurveAccount = await connection.getAccountInfo(params.bondingCurve, 'confirmed');
  if (!bondingCurveAccount) {
    throw new Error('Bonding curve account not found');
  }

  const state = parsePumpfunBondingCurveState(bondingCurveAccount.data);
  if (!state) {
    throw new Error('Failed to parse bonding curve state');
  }

  if (state.complete) {
    throw new Error('Bonding curve is complete - use Raydium to sell');
  }

  // Calculate expected output
  const expectedSol = calculatePumpfunSellOutput(state, params.tokenAmount);
  const minSol = (expectedSol * BigInt(10000 - params.slippageBps)) / 10000n;

  logger.debug({
    tokenAmount: params.tokenAmount.toString(),
    expectedSol: expectedSol.toString(),
    minSol: minSol.toString(),
    slippageBps: params.slippageBps,
  }, 'Calculated Pump.fun sell output');

  // Get associated token addresses
  const userAta = await getAssociatedTokenAddress(params.mint, params.owner);
  const bondingCurveAta = await getAssociatedTokenAddress(
    params.mint,
    params.bondingCurve,
    true
  );

  // Build sell instruction
  // Pump.fun sell discriminator: [51, 230, 133, 164, 1, 127, 131, 173]
  const data = Buffer.alloc(24);
  data.set(PUMPFUN_DISCRIMINATORS.SELL, 0);
  data.writeBigUInt64LE(params.tokenAmount, 8); // amount (tokens to sell)
  data.writeBigUInt64LE(minSol, 16); // min_sol_output

  const sellIx = new TransactionInstruction({
    programId: PROGRAM_IDS.PUMPFUN_PROGRAM,
    keys: [
      { pubkey: PROGRAM_IDS.PUMPFUN_GLOBAL, isSigner: false, isWritable: false },
      { pubkey: PROGRAM_IDS.PUMPFUN_FEE_RECIPIENT, isSigner: false, isWritable: true },
      { pubkey: params.mint, isSigner: false, isWritable: false },
      { pubkey: params.bondingCurve, isSigner: false, isWritable: true },
      { pubkey: bondingCurveAta, isSigner: false, isWritable: true },
      { pubkey: userAta, isSigner: false, isWritable: true },
      { pubkey: params.owner, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: PROGRAM_IDS.PUMPFUN_EVENT_AUTHORITY, isSigner: false, isWritable: false },
      { pubkey: PROGRAM_IDS.PUMPFUN_PROGRAM, isSigner: false, isWritable: false },
    ],
    data,
  });

  instructions.push(sellIx);

  return instructions;
}

/**
 * Get current Pump.fun price
 */
export async function getPumpfunPrice(
  connection: Connection,
  bondingCurve: PublicKey
): Promise<number> {
  const rateLimiter = getSharedRateLimiter();
  await rateLimiter.acquire();

  const account = await connection.getAccountInfo(bondingCurve, 'confirmed');
  if (!account) {
    throw new Error('Bonding curve not found');
  }

  const state = parsePumpfunBondingCurveState(account.data);
  if (!state) {
    throw new Error('Failed to parse bonding curve');
  }

  // Price = virtualSolReserves / virtualTokenReserves
  const price = Number(state.virtualSolReserves) / Number(state.virtualTokenReserves);
  return price * 1e3; // Adjust for decimal difference (SOL 9 decimals, token 6 decimals)
}

/**
 * Check if bonding curve is complete
 */
export async function isBondingCurveComplete(
  connection: Connection,
  bondingCurve: PublicKey
): Promise<boolean> {
  const rateLimiter = getSharedRateLimiter();
  await rateLimiter.acquire();

  const account = await connection.getAccountInfo(bondingCurve, 'confirmed');
  if (!account) return true; // Assume complete if not found

  const state = parsePumpfunBondingCurveState(account.data);
  return state?.complete ?? true;
}
