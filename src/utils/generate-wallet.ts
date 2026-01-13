#!/usr/bin/env tsx
/**
 * Utility script to generate a new Solana wallet
 * Run with: npm run generate-wallet
 */

import { generateKeypair, keypairToBase58 } from './wallet.js';

function main() {
  console.log('Generating new Solana wallet...\n');
  
  const keypair = generateKeypair();
  const publicKey = keypair.publicKey.toBase58();
  const privateKey = keypairToBase58(keypair);
  
  console.log('='.repeat(60));
  console.log('NEW WALLET GENERATED');
  console.log('='.repeat(60));
  console.log('');
  console.log('Public Key (address):');
  console.log(`  ${publicKey}`);
  console.log('');
  console.log('Private Key (for .env PRIVATE_KEY):');
  console.log(`  ${privateKey}`);
  console.log('');
  console.log('='.repeat(60));
  console.log('IMPORTANT SECURITY NOTES:');
  console.log('='.repeat(60));
  console.log('1. NEVER share your private key with anyone');
  console.log('2. NEVER commit your .env file to git');
  console.log('3. Store your private key securely (password manager, etc.)');
  console.log('4. Fund this wallet with SOL before using the sniper bot');
  console.log('');
  console.log('Add to your .env file:');
  console.log(`  PRIVATE_KEY=${privateKey}`);
  console.log('');
}

main();
