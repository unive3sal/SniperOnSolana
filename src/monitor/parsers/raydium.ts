import { PublicKey } from '@solana/web3.js';
import type { Logger } from 'pino';
import { PROGRAM_IDS, RAYDIUM_DISCRIMINATORS } from '../../config/constants.js';
import type { RaydiumPoolState, NewPoolEvent, ParsedPoolInfo } from '../types.js';

/**
 * Raydium AMM V4 pool state layout offsets
 */
const POOL_STATE_LAYOUT = {
  STATUS: 0,
  NONCE: 8,
  MAX_ORDER: 9,
  DEPTH: 10,
  BASE_DECIMAL: 11,
  QUOTE_DECIMAL: 12,
  STATE: 13,
  RESET_FLAG: 14,
  MIN_SIZE: 15,
  VOL_MAX_CUT_RATIO: 23,
  AMOUNT_WAVE_RATIO: 31,
  BASE_LOT_SIZE: 39,
  QUOTE_LOT_SIZE: 47,
  MIN_PRICE_MULTIPLIER: 55,
  MAX_PRICE_MULTIPLIER: 63,
  SYSTEM_DECIMAL_VALUE: 71,
  MIN_SEPARATE_NUMERATOR: 79,
  MIN_SEPARATE_DENOMINATOR: 87,
  TRADE_FEE_NUMERATOR: 95,
  TRADE_FEE_DENOMINATOR: 103,
  PNL_NUMERATOR: 111,
  PNL_DENOMINATOR: 119,
  SWAP_FEE_NUMERATOR: 127,
  SWAP_FEE_DENOMINATOR: 135,
  BASE_NEED_TAKE_PNL: 143,
  QUOTE_NEED_TAKE_PNL: 151,
  QUOTE_TOTAL_PNL: 159,
  BASE_TOTAL_PNL: 167,
  POOL_OPEN_TIME: 175,
  PUNISH_PC_AMOUNT: 183,
  PUNISH_COIN_AMOUNT: 191,
  ORDERBOOK_TO_INIT_TIME: 199,
  SWAP_BASE_IN_AMOUNT: 207,
  SWAP_QUOTE_OUT_AMOUNT: 223,
  SWAP_BASE_2_QUOTE_FEE: 239,
  SWAP_QUOTE_IN_AMOUNT: 247,
  SWAP_BASE_OUT_AMOUNT: 263,
  SWAP_QUOTE_2_BASE_FEE: 279,
  BASE_VAULT: 287,
  QUOTE_VAULT: 319,
  BASE_MINT: 351,
  QUOTE_MINT: 383,
  LP_MINT: 415,
  OPEN_ORDERS: 447,
  MARKET_ID: 479,
  MARKET_PROGRAM_ID: 511,
  TARGET_ORDERS: 543,
  WITHDRAW_QUEUE: 575,
  LP_VAULT: 607,
  OWNER: 639,
  LP_RESERVE: 671,
} as const;

/**
 * Parse Raydium AMM V4 pool state from account data
 */
export function parseRaydiumPoolState(data: Buffer | Uint8Array): RaydiumPoolState | null {
  try {
    const buffer = Buffer.from(data);
    
    if (buffer.length < 679) {
      return null;
    }

    return {
      status: buffer.readBigUInt64LE(POOL_STATE_LAYOUT.STATUS),
      nonce: buffer.readUInt8(POOL_STATE_LAYOUT.NONCE),
      maxOrder: buffer.readUInt8(POOL_STATE_LAYOUT.MAX_ORDER),
      depth: buffer.readUInt8(POOL_STATE_LAYOUT.DEPTH),
      baseDecimal: buffer.readUInt8(POOL_STATE_LAYOUT.BASE_DECIMAL),
      quoteDecimal: buffer.readUInt8(POOL_STATE_LAYOUT.QUOTE_DECIMAL),
      state: buffer.readUInt8(POOL_STATE_LAYOUT.STATE),
      resetFlag: buffer.readUInt8(POOL_STATE_LAYOUT.RESET_FLAG),
      minSize: buffer.readBigUInt64LE(POOL_STATE_LAYOUT.MIN_SIZE),
      volMaxCutRatio: buffer.readBigUInt64LE(POOL_STATE_LAYOUT.VOL_MAX_CUT_RATIO),
      amountWaveRatio: buffer.readBigUInt64LE(POOL_STATE_LAYOUT.AMOUNT_WAVE_RATIO),
      baseLotSize: buffer.readBigUInt64LE(POOL_STATE_LAYOUT.BASE_LOT_SIZE),
      quoteLotSize: buffer.readBigUInt64LE(POOL_STATE_LAYOUT.QUOTE_LOT_SIZE),
      minPriceMultiplier: buffer.readBigUInt64LE(POOL_STATE_LAYOUT.MIN_PRICE_MULTIPLIER),
      maxPriceMultiplier: buffer.readBigUInt64LE(POOL_STATE_LAYOUT.MAX_PRICE_MULTIPLIER),
      systemDecimalValue: buffer.readBigUInt64LE(POOL_STATE_LAYOUT.SYSTEM_DECIMAL_VALUE),
      minSeparateNumerator: buffer.readBigUInt64LE(POOL_STATE_LAYOUT.MIN_SEPARATE_NUMERATOR),
      minSeparateDenominator: buffer.readBigUInt64LE(POOL_STATE_LAYOUT.MIN_SEPARATE_DENOMINATOR),
      tradeFeeNumerator: buffer.readBigUInt64LE(POOL_STATE_LAYOUT.TRADE_FEE_NUMERATOR),
      tradeFeeDenominator: buffer.readBigUInt64LE(POOL_STATE_LAYOUT.TRADE_FEE_DENOMINATOR),
      pnlNumerator: buffer.readBigUInt64LE(POOL_STATE_LAYOUT.PNL_NUMERATOR),
      pnlDenominator: buffer.readBigUInt64LE(POOL_STATE_LAYOUT.PNL_DENOMINATOR),
      swapFeeNumerator: buffer.readBigUInt64LE(POOL_STATE_LAYOUT.SWAP_FEE_NUMERATOR),
      swapFeeDenominator: buffer.readBigUInt64LE(POOL_STATE_LAYOUT.SWAP_FEE_DENOMINATOR),
      baseNeedTakePnl: buffer.readBigUInt64LE(POOL_STATE_LAYOUT.BASE_NEED_TAKE_PNL),
      quoteNeedTakePnl: buffer.readBigUInt64LE(POOL_STATE_LAYOUT.QUOTE_NEED_TAKE_PNL),
      quoteTotalPnl: buffer.readBigUInt64LE(POOL_STATE_LAYOUT.QUOTE_TOTAL_PNL),
      baseTotalPnl: buffer.readBigUInt64LE(POOL_STATE_LAYOUT.BASE_TOTAL_PNL),
      poolOpenTime: buffer.readBigUInt64LE(POOL_STATE_LAYOUT.POOL_OPEN_TIME),
      punishPcAmount: buffer.readBigUInt64LE(POOL_STATE_LAYOUT.PUNISH_PC_AMOUNT),
      punishCoinAmount: buffer.readBigUInt64LE(POOL_STATE_LAYOUT.PUNISH_COIN_AMOUNT),
      orderbookToInitTime: buffer.readBigUInt64LE(POOL_STATE_LAYOUT.ORDERBOOK_TO_INIT_TIME),
      swapBaseInAmount: buffer.readBigUInt64LE(POOL_STATE_LAYOUT.SWAP_BASE_IN_AMOUNT),
      swapQuoteOutAmount: buffer.readBigUInt64LE(POOL_STATE_LAYOUT.SWAP_QUOTE_OUT_AMOUNT),
      swapBase2QuoteFee: buffer.readBigUInt64LE(POOL_STATE_LAYOUT.SWAP_BASE_2_QUOTE_FEE),
      swapQuoteInAmount: buffer.readBigUInt64LE(POOL_STATE_LAYOUT.SWAP_QUOTE_IN_AMOUNT),
      swapBaseOutAmount: buffer.readBigUInt64LE(POOL_STATE_LAYOUT.SWAP_BASE_OUT_AMOUNT),
      swapQuote2BaseFee: buffer.readBigUInt64LE(POOL_STATE_LAYOUT.SWAP_QUOTE_2_BASE_FEE),
      baseVault: new PublicKey(buffer.subarray(POOL_STATE_LAYOUT.BASE_VAULT, POOL_STATE_LAYOUT.BASE_VAULT + 32)),
      quoteVault: new PublicKey(buffer.subarray(POOL_STATE_LAYOUT.QUOTE_VAULT, POOL_STATE_LAYOUT.QUOTE_VAULT + 32)),
      baseMint: new PublicKey(buffer.subarray(POOL_STATE_LAYOUT.BASE_MINT, POOL_STATE_LAYOUT.BASE_MINT + 32)),
      quoteMint: new PublicKey(buffer.subarray(POOL_STATE_LAYOUT.QUOTE_MINT, POOL_STATE_LAYOUT.QUOTE_MINT + 32)),
      lpMint: new PublicKey(buffer.subarray(POOL_STATE_LAYOUT.LP_MINT, POOL_STATE_LAYOUT.LP_MINT + 32)),
      openOrders: new PublicKey(buffer.subarray(POOL_STATE_LAYOUT.OPEN_ORDERS, POOL_STATE_LAYOUT.OPEN_ORDERS + 32)),
      marketId: new PublicKey(buffer.subarray(POOL_STATE_LAYOUT.MARKET_ID, POOL_STATE_LAYOUT.MARKET_ID + 32)),
      marketProgramId: new PublicKey(buffer.subarray(POOL_STATE_LAYOUT.MARKET_PROGRAM_ID, POOL_STATE_LAYOUT.MARKET_PROGRAM_ID + 32)),
      targetOrders: new PublicKey(buffer.subarray(POOL_STATE_LAYOUT.TARGET_ORDERS, POOL_STATE_LAYOUT.TARGET_ORDERS + 32)),
      withdrawQueue: new PublicKey(buffer.subarray(POOL_STATE_LAYOUT.WITHDRAW_QUEUE, POOL_STATE_LAYOUT.WITHDRAW_QUEUE + 32)),
      lpVault: new PublicKey(buffer.subarray(POOL_STATE_LAYOUT.LP_VAULT, POOL_STATE_LAYOUT.LP_VAULT + 32)),
      owner: new PublicKey(buffer.subarray(POOL_STATE_LAYOUT.OWNER, POOL_STATE_LAYOUT.OWNER + 32)),
      lpReserve: buffer.readBigUInt64LE(POOL_STATE_LAYOUT.LP_RESERVE),
      padding: [],
    };
  } catch (error) {
    return null;
  }
}

/**
 * Convert Raydium pool state to parsed pool info
 */
export function raydiumPoolStateToInfo(
  poolAddress: PublicKey,
  state: RaydiumPoolState
): ParsedPoolInfo {
  return {
    dex: 'raydium',
    pool: poolAddress,
    baseMint: state.baseMint,
    quoteMint: state.quoteMint,
    baseVault: state.baseVault,
    quoteVault: state.quoteVault,
    baseReserve: BigInt(0), // Need to fetch from vault
    quoteReserve: BigInt(0), // Need to fetch from vault
    baseDecimals: state.baseDecimal,
    quoteDecimals: state.quoteDecimal,
    lpMint: state.lpMint,
    openTime: Number(state.poolOpenTime),
  };
}

/**
 * Check if instruction data is initialize2 (new pool creation)
 */
export function isRaydiumInitialize2(data: Buffer | Uint8Array): boolean {
  const buffer = Buffer.from(data);
  if (buffer.length < 8) return false;
  return buffer.subarray(0, 8).equals(RAYDIUM_DISCRIMINATORS.INITIALIZE_2);
}

/**
 * Parse initialize2 instruction arguments
 */
export interface Initialize2Args {
  nonce: number;
  openTime: bigint;
  initPcAmount: bigint;
  initCoinAmount: bigint;
}

export function parseInitialize2Args(data: Buffer | Uint8Array): Initialize2Args | null {
  try {
    const buffer = Buffer.from(data);
    if (buffer.length < 32) return null;
    
    return {
      nonce: buffer.readUInt8(8),
      openTime: buffer.readBigUInt64LE(9),
      initPcAmount: buffer.readBigUInt64LE(17),
      initCoinAmount: buffer.readBigUInt64LE(25),
    };
  } catch {
    return null;
  }
}

/**
 * Raydium parser class
 */
export class RaydiumParser {
  private readonly logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger.child({ parser: 'raydium' });
  }

  /**
   * Parse account update for new pool detection
   */
  parseAccountUpdate(
    pubkey: PublicKey,
    data: Buffer | Uint8Array,
    slot: number,
    signature: string
  ): NewPoolEvent | null {
    const state = parseRaydiumPoolState(data);
    if (!state) {
      return null;
    }

    // Check if this is a newly created pool (status check)
    // Status 1 = initialized, status 6 = swap enabled
    const validStatuses = [1n, 6n];
    if (!validStatuses.includes(state.status)) {
      return null;
    }

    this.logger.info(
      {
        pool: pubkey.toBase58(),
        baseMint: state.baseMint.toBase58(),
        quoteMint: state.quoteMint.toBase58(),
        openTime: state.poolOpenTime.toString(),
      },
      'Parsed Raydium pool'
    );

    return {
      type: 'new_pool',
      dex: 'raydium',
      mint: state.baseMint, // Usually the new token
      pool: pubkey,
      baseMint: state.baseMint,
      quoteMint: state.quoteMint,
      baseVault: state.baseVault,
      quoteVault: state.quoteVault,
      lpMint: state.lpMint,
      openTime: Number(state.poolOpenTime),
      slot,
      signature,
      timestamp: Date.now(),
    };
  }

  /**
   * Parse transaction for pool creation
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

      // Check if this is a Raydium AMM instruction
      if (!programId.equals(PROGRAM_IDS.RAYDIUM_AMM_V4)) {
        continue;
      }

      // Check if this is initialize2
      if (!isRaydiumInitialize2(ix.data)) {
        continue;
      }

      const args = parseInitialize2Args(ix.data);
      if (!args) {
        continue;
      }

      // Account indices for initialize2:
      // 0: token_program
      // 1: associated_token_program
      // 2: system_program
      // 3: rent
      // 4: amm_id
      // 5: amm_authority
      // 6: amm_open_orders
      // 7: lp_mint
      // 8: coin_mint
      // 9: pc_mint
      // 10: coin_vault
      // 11: pc_vault
      // ...

      if (ix.accounts.length < 12) {
        continue;
      }

      const ammId = accountKeys[ix.accounts[4]!];
      const lpMint = accountKeys[ix.accounts[7]!];
      const coinMint = accountKeys[ix.accounts[8]!];
      const pcMint = accountKeys[ix.accounts[9]!];
      const coinVault = accountKeys[ix.accounts[10]!];
      const pcVault = accountKeys[ix.accounts[11]!];

      if (!ammId || !lpMint || !coinMint || !pcMint || !coinVault || !pcVault) {
        continue;
      }

      this.logger.info(
        {
          signature,
          pool: ammId.toBase58(),
          coinMint: coinMint.toBase58(),
          pcMint: pcMint.toBase58(),
        },
        'Detected Raydium pool creation transaction'
      );

      return {
        type: 'new_pool',
        dex: 'raydium',
        mint: coinMint,
        pool: ammId,
        baseMint: coinMint,
        quoteMint: pcMint,
        baseVault: coinVault,
        quoteVault: pcVault,
        lpMint,
        openTime: Number(args.openTime),
        slot,
        signature,
        timestamp: Date.now(),
      };
    }

    return null;
  }
}
