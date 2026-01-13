import { PublicKey } from '@solana/web3.js';
import type { Logger } from 'pino';
import { PROGRAM_IDS, PUMPFUN_DISCRIMINATORS, PUMPFUN_CONSTANTS } from '../../config/constants.js';
import type { PumpfunBondingCurveState, NewPoolEvent, ParsedPoolInfo, MigrationEvent } from '../types.js';

/**
 * Pump.fun bonding curve state layout
 */
const BONDING_CURVE_LAYOUT = {
  DISCRIMINATOR: 0,
  VIRTUAL_TOKEN_RESERVES: 8,
  VIRTUAL_SOL_RESERVES: 16,
  REAL_TOKEN_RESERVES: 24,
  REAL_SOL_RESERVES: 32,
  TOKEN_TOTAL_SUPPLY: 40,
  COMPLETE: 48,
} as const;

/**
 * Parse Pump.fun bonding curve state from account data
 */
export function parsePumpfunBondingCurveState(data: Buffer | Uint8Array): PumpfunBondingCurveState | null {
  try {
    const buffer = Buffer.from(data);
    
    if (buffer.length < 49) {
      return null;
    }

    return {
      virtualTokenReserves: buffer.readBigUInt64LE(BONDING_CURVE_LAYOUT.VIRTUAL_TOKEN_RESERVES),
      virtualSolReserves: buffer.readBigUInt64LE(BONDING_CURVE_LAYOUT.VIRTUAL_SOL_RESERVES),
      realTokenReserves: buffer.readBigUInt64LE(BONDING_CURVE_LAYOUT.REAL_TOKEN_RESERVES),
      realSolReserves: buffer.readBigUInt64LE(BONDING_CURVE_LAYOUT.REAL_SOL_RESERVES),
      tokenTotalSupply: buffer.readBigUInt64LE(BONDING_CURVE_LAYOUT.TOKEN_TOTAL_SUPPLY),
      complete: buffer.readUInt8(BONDING_CURVE_LAYOUT.COMPLETE) === 1,
    };
  } catch (error) {
    return null;
  }
}

/**
 * Convert bonding curve state to parsed pool info
 */
export function pumpfunBondingCurveToInfo(
  bondingCurve: PublicKey,
  mint: PublicKey,
  state: PumpfunBondingCurveState
): ParsedPoolInfo {
  return {
    dex: 'pumpfun',
    pool: bondingCurve,
    baseMint: mint,
    quoteMint: new PublicKey('So11111111111111111111111111111111111111112'), // SOL
    baseVault: bondingCurve, // Pump.fun uses bonding curve as vault
    quoteVault: bondingCurve,
    baseReserve: state.realTokenReserves,
    quoteReserve: state.realSolReserves,
    baseDecimals: 6, // Pump.fun tokens always have 6 decimals
    quoteDecimals: 9, // SOL
  };
}

/**
 * Calculate price from Pump.fun bonding curve state
 */
export function calculatePumpfunPrice(state: PumpfunBondingCurveState): number {
  const virtualSol = Number(state.virtualSolReserves) / 1e9;
  const virtualTokens = Number(state.virtualTokenReserves) / 1e6;
  
  if (virtualTokens === 0) return 0;
  
  return virtualSol / virtualTokens;
}

/**
 * Calculate buy output amount
 */
export function calculatePumpfunBuyOutput(
  state: PumpfunBondingCurveState,
  solAmount: bigint
): bigint {
  const feeAmount = (solAmount * BigInt(PUMPFUN_CONSTANTS.FEE_BPS)) / 10000n;
  const solAmountAfterFee = solAmount - feeAmount;
  
  const newVirtualSolReserves = state.virtualSolReserves + solAmountAfterFee;
  const newVirtualTokenReserves = 
    (state.virtualSolReserves * state.virtualTokenReserves) / newVirtualSolReserves;
  
  return state.virtualTokenReserves - newVirtualTokenReserves;
}

/**
 * Calculate sell output amount
 */
export function calculatePumpfunSellOutput(
  state: PumpfunBondingCurveState,
  tokenAmount: bigint
): bigint {
  const newVirtualTokenReserves = state.virtualTokenReserves + tokenAmount;
  const newVirtualSolReserves = 
    (state.virtualSolReserves * state.virtualTokenReserves) / newVirtualTokenReserves;
  
  const solOutput = state.virtualSolReserves - newVirtualSolReserves;
  const feeAmount = (solOutput * BigInt(PUMPFUN_CONSTANTS.FEE_BPS)) / 10000n;
  
  return solOutput - feeAmount;
}

/**
 * Check if bonding curve is near migration threshold
 */
export function isNearMigration(state: PumpfunBondingCurveState): boolean {
  return state.realSolReserves >= BigInt(PUMPFUN_CONSTANTS.MIGRATION_THRESHOLD);
}

/**
 * Derive bonding curve PDA
 */
export function deriveBondingCurvePDA(mint: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('bonding-curve'), mint.toBuffer()],
    PROGRAM_IDS.PUMPFUN_PROGRAM
  );
  return pda;
}

/**
 * Derive associated bonding curve address (for tokens)
 */
export function deriveAssociatedBondingCurve(mint: PublicKey): PublicKey {
  const bondingCurve = deriveBondingCurvePDA(mint);
  const [ata] = PublicKey.findProgramAddressSync(
    [bondingCurve.toBuffer(), PROGRAM_IDS.TOKEN_PROGRAM.toBuffer(), mint.toBuffer()],
    PROGRAM_IDS.ASSOCIATED_TOKEN_PROGRAM
  );
  return ata;
}

/**
 * Check if instruction data is create (new token)
 */
export function isPumpfunCreate(data: Buffer | Uint8Array): boolean {
  const buffer = Buffer.from(data);
  if (buffer.length < 8) return false;
  return buffer.subarray(0, 8).equals(PUMPFUN_DISCRIMINATORS.CREATE);
}

/**
 * Check if instruction data is buy
 */
export function isPumpfunBuy(data: Buffer | Uint8Array): boolean {
  const buffer = Buffer.from(data);
  if (buffer.length < 8) return false;
  return buffer.subarray(0, 8).equals(PUMPFUN_DISCRIMINATORS.BUY);
}

/**
 * Check if instruction data is sell
 */
export function isPumpfunSell(data: Buffer | Uint8Array): boolean {
  const buffer = Buffer.from(data);
  if (buffer.length < 8) return false;
  return buffer.subarray(0, 8).equals(PUMPFUN_DISCRIMINATORS.SELL);
}

/**
 * Parse create instruction arguments
 */
export interface CreateArgs {
  name: string;
  symbol: string;
  uri: string;
}

export function parseCreateArgs(data: Buffer | Uint8Array): CreateArgs | null {
  try {
    const buffer = Buffer.from(data);
    let offset = 8; // Skip discriminator
    
    // Read name (string with length prefix)
    const nameLen = buffer.readUInt32LE(offset);
    offset += 4;
    const name = buffer.subarray(offset, offset + nameLen).toString('utf8');
    offset += nameLen;
    
    // Read symbol
    const symbolLen = buffer.readUInt32LE(offset);
    offset += 4;
    const symbol = buffer.subarray(offset, offset + symbolLen).toString('utf8');
    offset += symbolLen;
    
    // Read uri
    const uriLen = buffer.readUInt32LE(offset);
    offset += 4;
    const uri = buffer.subarray(offset, offset + uriLen).toString('utf8');
    
    return { name, symbol, uri };
  } catch {
    return null;
  }
}

/**
 * Parse buy instruction arguments
 */
export interface BuyArgs {
  amount: bigint;
  maxSolCost: bigint;
}

export function parseBuyArgs(data: Buffer | Uint8Array): BuyArgs | null {
  try {
    const buffer = Buffer.from(data);
    if (buffer.length < 24) return null;
    
    return {
      amount: buffer.readBigUInt64LE(8),
      maxSolCost: buffer.readBigUInt64LE(16),
    };
  } catch {
    return null;
  }
}

/**
 * Parse sell instruction arguments
 */
export interface SellArgs {
  amount: bigint;
  minSolOutput: bigint;
}

export function parseSellArgs(data: Buffer | Uint8Array): SellArgs | null {
  try {
    const buffer = Buffer.from(data);
    if (buffer.length < 24) return null;
    
    return {
      amount: buffer.readBigUInt64LE(8),
      minSolOutput: buffer.readBigUInt64LE(16),
    };
  } catch {
    return null;
  }
}

/**
 * Pump.fun parser class
 */
export class PumpfunParser {
  private readonly logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger.child({ parser: 'pumpfun' });
  }

  /**
   * Parse account update for bonding curve changes
   */
  parseAccountUpdate(
    pubkey: PublicKey,
    data: Buffer | Uint8Array,
    slot: number,
    signature: string,
    mint?: PublicKey
  ): NewPoolEvent | MigrationEvent | null {
    const state = parsePumpfunBondingCurveState(data);
    if (!state) {
      return null;
    }

    // If complete, this is a migration event
    if (state.complete) {
      this.logger.info(
        {
          bondingCurve: pubkey.toBase58(),
          realSolReserves: state.realSolReserves.toString(),
        },
        'Detected Pump.fun migration (bonding curve complete)'
      );

      // Note: We need the mint address to create full event
      // This should be tracked separately
      if (mint) {
        return {
          type: 'migration',
          sourceDex: 'pumpfun',
          targetDex: 'raydium',
          mint,
          sourcePool: pubkey,
          targetPool: pubkey, // Will be updated when Raydium pool is created
          slot,
          signature,
          timestamp: Date.now(),
        };
      }
      return null;
    }

    // Check if this is a new bonding curve (initial reserves match constants)
    const isNew = 
      state.virtualSolReserves === BigInt(PUMPFUN_CONSTANTS.VIRTUAL_SOL_RESERVES) &&
      state.virtualTokenReserves === BigInt(PUMPFUN_CONSTANTS.VIRTUAL_TOKEN_RESERVES);

    if (isNew && mint) {
      this.logger.info(
        {
          bondingCurve: pubkey.toBase58(),
          mint: mint.toBase58(),
        },
        'Detected new Pump.fun bonding curve'
      );

      return {
        type: 'new_pool',
        dex: 'pumpfun',
        mint,
        pool: pubkey,
        baseMint: mint,
        quoteMint: new PublicKey('So11111111111111111111111111111111111111112'),
        baseVault: pubkey,
        quoteVault: pubkey,
        slot,
        signature,
        timestamp: Date.now(),
      };
    }

    return null;
  }

  /**
   * Parse transaction for token creation
   */
  parseTransaction(
    signature: string,
    accountKeys: PublicKey[],
    instructions: { programIdIndex: number; accounts: number[]; data: Buffer }[],
    slot: number
  ): NewPoolEvent | null {
    for (const ix of instructions) {
      const programId = accountKeys[ix.programIdIndex];
      if (!programId) continue;

      // Check if this is a Pump.fun instruction
      if (!programId.equals(PROGRAM_IDS.PUMPFUN_PROGRAM)) {
        continue;
      }

      // Check if this is create instruction
      if (!isPumpfunCreate(ix.data)) {
        continue;
      }

      const args = parseCreateArgs(ix.data);
      
      // Account indices for create:
      // 0: mint
      // 1: mint_authority
      // 2: bonding_curve
      // 3: associated_bonding_curve
      // 4: global
      // 5: mpl_token_metadata
      // 6: metadata
      // 7: user
      // 8: system_program
      // 9: token_program
      // 10: associated_token_program
      // 11: rent
      // 12: event_authority
      // 13: program

      if (ix.accounts.length < 4) {
        continue;
      }

      const mint = accountKeys[ix.accounts[0]!];
      const bondingCurve = accountKeys[ix.accounts[2]!];

      if (!mint || !bondingCurve) {
        continue;
      }

      this.logger.info(
        {
          signature,
          mint: mint.toBase58(),
          bondingCurve: bondingCurve.toBase58(),
          name: args?.name,
          symbol: args?.symbol,
        },
        'Detected Pump.fun token creation'
      );

      return {
        type: 'new_pool',
        dex: 'pumpfun',
        mint,
        pool: bondingCurve,
        baseMint: mint,
        quoteMint: new PublicKey('So11111111111111111111111111111111111111112'),
        baseVault: bondingCurve,
        quoteVault: bondingCurve,
        slot,
        signature,
        timestamp: Date.now(),
      };
    }

    return null;
  }

  /**
   * Parse logs for Pump.fun events
   */
  parseLogs(
    signature: string,
    logs: string[],
    slot: number
  ): { type: string; data: Record<string, unknown> } | null {
    for (const log of logs) {
      // Check for program log data
      if (log.startsWith('Program log: ')) {
        const data = log.slice('Program log: '.length);
        
        // Try to parse as base64 encoded event
        try {
          const decoded = Buffer.from(data, 'base64');
          // Parse event based on discriminator
          // This would need event-specific parsing
        } catch {
          // Not base64 encoded
        }
      }
    }

    return null;
  }
}
