import { Keypair, PublicKey, Connection, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { getAssociatedTokenAddress, getAccount } from '@solana/spl-token';
import bs58 from 'bs58';

/**
 * Generate a new Solana keypair
 */
export function generateKeypair(): Keypair {
  return Keypair.generate();
}

/**
 * Export keypair to base58 string (for .env)
 */
export function keypairToBase58(keypair: Keypair): string {
  return bs58.encode(keypair.secretKey);
}

/**
 * Import keypair from base58 string
 */
export function base58ToKeypair(base58: string): Keypair {
  const decoded = bs58.decode(base58);
  return Keypair.fromSecretKey(decoded);
}

/**
 * Get SOL balance for a wallet
 */
export async function getSolBalance(
  connection: Connection,
  publicKey: PublicKey
): Promise<number> {
  const balance = await connection.getBalance(publicKey);
  return balance / LAMPORTS_PER_SOL;
}

/**
 * Get token balance for a wallet
 */
export async function getTokenBalance(
  connection: Connection,
  owner: PublicKey,
  mint: PublicKey
): Promise<{ balance: number; decimals: number } | null> {
  try {
    const ata = await getAssociatedTokenAddress(mint, owner);
    const account = await getAccount(connection, ata);
    const balance = Number(account.amount);
    
    // Get mint info for decimals
    const mintInfo = await connection.getParsedAccountInfo(mint);
    const decimals = (mintInfo.value?.data as any)?.parsed?.info?.decimals ?? 9;
    
    return {
      balance: balance / Math.pow(10, decimals),
      decimals,
    };
  } catch {
    return null;
  }
}

/**
 * Check if wallet has enough SOL for a transaction
 */
export async function hasEnoughSol(
  connection: Connection,
  publicKey: PublicKey,
  requiredSol: number,
  bufferSol: number = 0.01 // Reserve for fees
): Promise<boolean> {
  const balance = await getSolBalance(connection, publicKey);
  return balance >= requiredSol + bufferSol;
}

/**
 * Get associated token address
 */
export async function getAta(
  owner: PublicKey,
  mint: PublicKey
): Promise<PublicKey> {
  return getAssociatedTokenAddress(mint, owner);
}

/**
 * Shorten public key for display
 */
export function shortenAddress(address: PublicKey | string, chars: number = 4): string {
  const str = typeof address === 'string' ? address : address.toBase58();
  return `${str.slice(0, chars)}...${str.slice(-chars)}`;
}
