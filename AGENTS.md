# AGENTS.md - Solana Sniper Bot

Guidelines for AI agents working in this codebase.

## Project Overview

High-performance Solana token sniper bot built with TypeScript. Monitors DEXes (Pump.fun, Raydium) for new token pools, performs security analysis, and executes trades using Jito bundles.

**Tech Stack:** TypeScript, Node.js (>=18), ESM modules, Solana Web3.js, Zod, Pino logger

## Build/Lint/Test Commands

```bash
# Install dependencies
npm install

# Build (TypeScript compilation)
npm run build

# Run development mode (hot-reload)
npm run dev

# Run once without watching
npm run dev:once

# Run production
npm start

# Lint
npm run lint

# Run all tests
npm test

# Run a single test file
npx vitest run src/path/to/file.test.ts

# Run tests matching a pattern
npx vitest run -t "test name pattern"

# Run tests in watch mode
npx vitest

# Generate wallet utility
npm run generate-wallet
```

## Code Style Guidelines

### File Structure

- Source code in `src/`
- Compiled output in `dist/`
- Entry point: `src/index.ts`
- Modular architecture: `config/`, `monitor/`, `security/`, `executor/`, `position/`, `sweep/`, `utils/`

### Imports

1. **Order imports** (separated by blank lines):
   - External packages (node_modules)
   - Internal modules (relative paths)
   - Type-only imports last with `type` keyword

2. **Use `.js` extension** for local imports (ESM requirement):
   ```typescript
   import { loadConfig } from './config/index.js';
   import type { Config } from './config/types.js';
   ```

3. **Re-export from index files**:
   ```typescript
   // config/index.ts
   export * from './types.js';
   export * from './constants.js';
   ```

### TypeScript Configuration

- **Strict mode enabled** with additional checks:
  - `noImplicitAny`, `strictNullChecks`, `strictFunctionTypes`
  - `noImplicitReturns`, `noFallthroughCasesInSwitch`
  - `noUncheckedIndexedAccess` - array/object access returns `T | undefined`
- **Target:** ES2022
- **Module:** NodeNext (ESM)

### Types and Interfaces

1. **Use interfaces** for object shapes, prefer `interface` over `type` for extendability:
   ```typescript
   export interface NetworkConfig {
     grpcEndpoint: string;
     heliusApiKey: string;
   }
   ```

2. **Use type aliases** for unions and complex types:
   ```typescript
   export type DexType = 'raydium' | 'pumpfun' | 'orca';
   export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected';
   ```

3. **Explicit return types** for public functions:
   ```typescript
   export function loadConfig(): Config { }
   async function start(): Promise<void> { }
   ```

4. **Use `type` keyword for type-only imports**:
   ```typescript
   import type { Logger } from 'pino';
   import type { Config, Position } from '../config/types.js';
   ```

### Naming Conventions

- **Files:** lowercase with hyphens (`grpc-client.ts`, `pumpfun.ts`)
- **Classes:** PascalCase (`SecurityModule`, `PositionManager`)
- **Functions/methods:** camelCase (`loadConfig`, `handleNewPool`)
- **Interfaces:** PascalCase, descriptive (`TradingConfig`, `RiskAnalysis`)
- **Type aliases:** PascalCase (`DexType`, `ConnectionStatus`)
- **Constants:** SCREAMING_SNAKE_CASE (`LAMPORTS_PER_SOL`, `PROGRAM_IDS`)
- **Private class members:** no underscore prefix, use `private` keyword

### Error Handling

1. **Throw descriptive Error objects**:
   ```typescript
   throw new Error('Bonding curve account not found');
   throw new Error(`Maximum concurrent positions (${max}) reached`);
   ```

2. **Catch and wrap errors with context**:
   ```typescript
   try {
     const result = await fn();
   } catch (error) {
     this.logger.error({ error, mint: mintStr }, 'Error handling new pool');
   }
   ```

3. **Use structured logging for errors**:
   ```typescript
   this.logger.error({ error, positionId: position.id }, 'Sell execution failed');
   ```

4. **Return result objects for operations that can fail**:
   ```typescript
   interface SwapResult {
     success: boolean;
     txHash?: string;
     error?: string;
     latencyMs: number;
   }
   ```

### Async/Await Patterns

1. **Always use async/await** (no raw promises):
   ```typescript
   async function fetchData(): Promise<Data> {
     const result = await connection.getAccountInfo(pubkey);
     return result;
   }
   ```

2. **Parallel execution with Promise.all**:
   ```typescript
   const [mintAuth, freezeAuth, liquidity] = await Promise.all([
     checkMintAuthority(mint),
     checkFreezeAuthority(mint),
     checkLiquidity(pool),
   ]);
   ```

### Logging

Use Pino structured logging with context objects:

```typescript
// Create child loggers with module context
this.logger = logger.child({ module: 'security' });

// Log with structured data first, message last
this.logger.info({ mint: cacheKey, score: analysis.score }, 'Analysis completed');
this.logger.warn({ error }, 'Could not check wallet balance');
this.logger.error({ error, positionId }, 'Failed to execute sell');
```

### Class Patterns

1. **Use readonly for injected dependencies**:
   ```typescript
   class SecurityModule {
     private readonly config: Config;
     private readonly logger: Logger;
     private readonly connection: Connection;
   }
   ```

2. **Initialize in constructor**:
   ```typescript
   constructor(config: Config, logger: Logger) {
     this.config = config;
     this.logger = logger.child({ module: 'security' });
     this.connection = new Connection(config.network.heliusRpcUrl);
   }
   ```

3. **Use EventEmitter for event-driven patterns**:
   ```typescript
   class PositionManager extends EventEmitter {
     this.emit('position_opened', position);
     this.emit('exit_trigger', { position, reason: 'take_profit' });
   }
   ```

### Solana-Specific Patterns

1. **PublicKey handling**:
   ```typescript
   const mintStr = mint.toBase58();  // For logging/display
   mint.equals(otherMint);           // For comparison
   new PublicKey(addressString);     // Parse from string
   ```

2. **BigInt for lamports/token amounts**:
   ```typescript
   const lamports = BigInt(Math.floor(sol * LAMPORTS_PER_SOL));
   const minTokens = (expectedTokens * BigInt(10000 - slippageBps)) / 10000n;
   ```

3. **Connection commitment levels**:
   ```typescript
   new Connection(url, { commitment: 'confirmed' });
   await connection.getAccountInfo(pubkey, 'confirmed');
   ```

### Configuration & Validation

1. **Use Zod schemas for env validation**:
   ```typescript
   const envSchema = z.object({
     BUY_AMOUNT_SOL: z.string().transform(Number).pipe(
       z.number().positive().max(100)
     ),
   });
   ```

2. **Singleton config pattern**:
   ```typescript
   let configInstance: Config | null = null;
   export function loadConfig(): Config {
     if (configInstance) return configInstance;
     // ... load and cache
   }
   ```

### Testing

- Test framework: Vitest
- Test files: `*.test.ts` (excluded from build)
- No tests currently exist - write tests for new features
- Tests run with: `npm test` or `npx vitest`

### Important Directories

```
src/
├── config/          # Configuration, types, constants
├── monitor/         # Pool detection (gRPC, WebSocket, parsers)
├── security/        # Risk analysis and scoring
├── executor/        # Transaction building and Jito bundles
├── position/        # Position tracking and TP/SL
├── sweep/           # Auto-sweep to cold wallet
└── utils/           # Logger, retry, helpers, wallet utilities
```

### Key Constants Location

- Program IDs: `src/config/constants.ts`
- Type definitions: `src/config/types.ts`
- Environment schema: `src/config/env.ts`

### Common Utilities

- `retry()` - Exponential backoff retry: `src/utils/retry.ts`
- `lamportsToSol()`, `solToLamports()` - Conversions: `src/utils/helpers.ts`
- `createLogger()` - Pino logger factory: `src/utils/logger.ts`
- `getSolBalance()`, `getAta()` - Wallet utils: `src/utils/wallet.ts`
