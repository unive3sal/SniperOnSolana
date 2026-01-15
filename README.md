# Solana Sniper Bot

A high-performance Solana token sniper bot built with TypeScript. Features gRPC monitoring, comprehensive security analysis, Jito bundle execution, and automated position management.

## Features

- **Multi-DEX Monitoring**: Supports Pump.fun and Raydium (extensible to Orca, Meteora)
- **Fast Detection**: Yellowstone gRPC for ~50-100ms latency with WebSocket fallback
- **Security Analysis**: Multi-layer risk assessment before every trade
  - Mint/freeze authority verification
  - Liquidity and LP lock checks
  - Top holder concentration analysis
  - Honeypot simulation
  - **Token-2022 extension detection** (MintCloseAuthority, PermanentDelegate, TransferHook, etc.)
  - Risk scoring (0-100)
- **MEV Protection**: Jito bundle submission with dynamic tip management
- **Position Management**: Automated take-profit and stop-loss execution
- **Auto-Sweep**: Automatic profit protection by transferring excess SOL to cold wallet
- **Configurable**: Extensive configuration via environment variables

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         SNIPER BOT                              │
├─────────────────────────────────────────────────────────────────┤
│     Monitor Module        Security Module      Executor Module  │
│  ┌─────────────────┐    ┌─────────────────┐   ┌──────────────┐  │
│  │ gRPC (Primary)  │───▶│ Fast Checks     │──▶│ Jito Bundle  │  │
│  │    WebSocket    │    │                 │   │              │  │
│  │   (Fallback)    │    │ Deep Analysis   │   │ RPC Fallback │  │
│  │                 │    │ Honeypot Sim    │   │              │  │
│  └─────────────────┘    └─────────────────┘   └──────────────┘  │
│           │                      │                    │         │
│           └──────────────────────┼────────────────────┘         │
│                                  ▼                              │
│                    ┌─────────────────────────┐                  │
│                    │   Position Manager      │                  │
│                    │   (TP/SL Automation)    │                  │
│                    └─────────────────────────┘                  │
│                                  │                              │
│                                  ▼                              │
│                    ┌─────────────────────────┐                  │
│                    │   Wallet Sweep Manager  │                  │
│                    │ (Auto-Profit Protection)│                  │
│                    └─────────────────────────┘                  │
└─────────────────────────────────────────────────────────────────┘
```

## Prerequisites

- Node.js >= 18.0.0
- npm or yarn
- Solana wallet with SOL for trading
- API keys from:
  - [Shyft](https://shyft.to) (free tier for gRPC)
  - [Helius](https://helius.dev) (free tier for WebSocket fallback)

## Installation

1. **Clone the repository**
   ```bash
   git clone https://github.com/yourusername/solana-sniper.git
   cd solana-sniper
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Configure environment**
   ```bash
   cp .env.example .env
   ```

4. **Generate a new wallet (optional)**
   ```bash
   npm run generate-wallet
   ```
   Copy the private key to your `.env` file.

5. **Build the project**
   ```bash
   npm run build
   ```

## Configuration

Edit `.env` with your settings:

```env
# Network - Get free API keys from shyft.to and helius.dev
GRPC_ENDPOINT=grpc.shyft.to:443
GRPC_TOKEN=your-shyft-api-key
HELIUS_API_KEY=your-helius-api-key

# Wallet - Base58 encoded private key
PRIVATE_KEY=your-private-key

# Trading Parameters
BUY_AMOUNT_SOL=0.1          # SOL per trade
MAX_SLIPPAGE_BPS=500        # 5% slippage
TAKE_PROFIT_PERCENT=100     # 2x (100% gain)
STOP_LOSS_PERCENT=30        # -30% loss

# Security Thresholds
MIN_LIQUIDITY_SOL=5         # Minimum pool liquidity
MAX_TOP_HOLDER_PERCENT=20   # Max single holder %
RISK_SCORE_THRESHOLD=70     # Min score to trade (0-100)
ENABLE_HONEYPOT_CHECK=true  # Simulate sells

# Target DEXes
ENABLE_RAYDIUM=true
ENABLE_PUMPFUN=true

# Mode
DRY_RUN=false               # Set true to test without trading
USE_DEVNET=false            # Set true for devnet testing

# Auto-Sweep (optional)
ENABLE_AUTO_SWEEP=false     # Enable automatic profit sweeping
# COLD_WALLET_ADDRESS=...   # Your cold wallet address (when enabled)
```

See [.env.example](.env.example) for all available options.

## Usage

### Development Mode
```bash
npm run dev
```
Hot-reloads on file changes.

### Production Mode
```bash
npm run build
npm start
```

### Dry Run Mode
Test the bot without executing real transactions:
```bash
# Set in .env
DRY_RUN=true
```

### Devnet Testing
Test on Solana devnet first:
```bash
# Set in .env
USE_DEVNET=true

# Fund your devnet wallet
solana airdrop 2 <your-wallet-address> --url devnet
```

## Project Structure

```
src/
├── config/                 # Configuration & validation
│   ├── index.ts           # Config loader
│   ├── env.ts             # Zod schema validation
│   ├── constants.ts       # Program IDs, endpoints
│   └── types.ts           # TypeScript interfaces
│
├── monitor/               # Pool detection
│   ├── index.ts           # Monitor coordinator
│   ├── grpc/client.ts     # Yellowstone gRPC
│   ├── websocket/client.ts # WebSocket fallback
│   └── parsers/           # DEX instruction parsers
│       ├── raydium.ts
│       └── pumpfun.ts
│
├── security/              # Risk analysis
│   ├── index.ts           # Security module
│   ├── scorer.ts          # Risk scoring algorithm
│   └── checks/            # Individual security checks
│       ├── authority.ts   # Mint/freeze authority
│       ├── liquidity.ts   # LP lock verification
│       ├── holders.ts     # Holder distribution
│       ├── honeypot.ts    # Sell simulation
│       ├── blacklist.ts   # Known scam cache
│       └── token2022.ts   # Token-2022 extension detection
│
├── executor/              # Transaction execution
│   ├── index.ts           # Executor module
│   ├── builder/           # DEX-specific builders
│   │   └── pumpfun.ts     # Pump.fun swaps
│   └── jito/              # MEV protection
│       ├── client.ts      # Bundle submission
│       └── tip.ts         # Dynamic tip manager
│
├── position/              # Position management
│   └── index.ts           # TP/SL automation
│
├── sweep/                 # Wallet management
│   └── index.ts           # Auto-sweep to cold wallet
│
├── utils/                 # Utilities
│   ├── logger.ts          # Pino structured logging
│   ├── wallet.ts          # Keypair utilities
│   ├── retry.ts           # Retry with backoff
│   └── helpers.ts         # Common helpers
│
└── index.ts               # Main entry point
```

## Security Checks

The bot runs multiple security checks before executing any trade:

| Check | Description | Impact |
|-------|-------------|--------|
| Mint Authority | Verifies mint authority is revoked | +20 score |
| Freeze Authority | Verifies freeze authority is revoked | +15 score |
| Liquidity | Checks minimum pool liquidity | Required |
| LP Lock | Verifies LP tokens are locked | +25-30 score |
| Holder Distribution | Analyzes top holder concentration | +/-15 score |
| Honeypot Simulation | Simulates a sell transaction | +15 score |
| Token-2022 Extensions | Detects dangerous Token-2022 extensions | See below |

A token must score above `RISK_SCORE_THRESHOLD` (default: 70) to be traded.

### Token-2022 Extension Protection

Token-2022 (SPL Token 2022) introduces extensions that can be exploited for rug-pulls. The bot automatically detects and rejects tokens with dangerous extensions:

| Extension | Risk Level | Description | Action |
|-----------|------------|-------------|--------|
| MintCloseAuthority | **Critical** | Authority can close mint, making all tokens worthless | Instant reject |
| PermanentDelegate | **Critical** | Authority can transfer/burn ANY holder's tokens | Instant reject |
| TransferHook | **Critical** | Custom program executes on transfers - can block sells | Instant reject |
| NonTransferable | **Critical** | Soulbound tokens that cannot be transferred or sold | Instant reject |
| TransferFee >1% | High | Hidden tax on every transfer | -50 score |
| TransferFee 0.1-1% | Medium | Moderate transfer tax | -15 score |
| DefaultAccountState | Medium | New token accounts frozen by default | -30 score |
| ConfidentialTransfer | Low | Hides transfer amounts, harder to analyze | -5 score |

**Safe tokens receive bonuses:**
- Standard SPL Token (no extensions): +10 score
- Token-2022 with only safe extensions: +15 score

## How It Works

1. **Detection**: Monitor subscribes to DEX program accounts via gRPC
2. **Parsing**: New pool creation transactions are parsed for token info
3. **Analysis**: Security module runs all checks and calculates risk score
4. **Execution**: If passed, buy transaction is submitted via Jito bundle
5. **Management**: Position is tracked for take-profit or stop-loss
6. **Auto-Sweep**: Excess SOL automatically transferred to cold wallet for protection

## Auto-Sweep Feature

Protect your accumulated profits by automatically transferring excess SOL to a secure cold wallet.

### How It Works

- **Automatic Monitoring**: Checks wallet balance every 30 seconds
- **Dynamic Threshold**: Threshold = 2× your `BUY_AMOUNT_SOL` setting
- **Smart Transfers**: When balance exceeds threshold, transfers the excess while keeping enough for trading
- **Retry Logic**: Failed transfers automatically retry 3 times with exponential backoff
- **Safety Features**: Minimum 0.01 SOL transfer, address validation, dry-run support

### Configuration

```env
# Enable auto-sweep
ENABLE_AUTO_SWEEP=true

# Your cold wallet public key (Solana address)
COLD_WALLET_ADDRESS=YourColdWalletPublicKeyHere

# Buy amount determines threshold (2× this value)
BUY_AMOUNT_SOL=0.1  # Threshold will be 0.2 SOL
```

### Example Behavior

With `BUY_AMOUNT_SOL=0.1` (threshold = 0.2 SOL):

| Balance | Action |
|---------|--------|
| 0.15 SOL | No sweep (below threshold) |
| 0.25 SOL | Sweep 0.05 SOL to cold wallet |
| 1.00 SOL | Sweep 0.80 SOL to cold wallet |

The bot always keeps the threshold amount (0.2 SOL) for continued trading operations.

### Testing

**Always test on devnet first:**

```bash
USE_DEVNET=true
ENABLE_AUTO_SWEEP=true
COLD_WALLET_ADDRESS=<devnet-address>
npm run dev
```

See [AUTO_SWEEP_GUIDE.md](AUTO_SWEEP_GUIDE.md) for detailed testing procedures and troubleshooting.

### Security

- Cold wallet address must be different from trading wallet
- Only the public key is needed (never share private keys)
- Transactions are confirmed before marking success
- Graceful failure - bot continues trading even if sweep fails

## Supported DEXes

| DEX | Status | Pool Detection | Swaps |
|-----|--------|----------------|-------|
| Pump.fun | Stable | Yes | Yes |
| Raydium AMM V4 | Partial | Yes | Planned |
| Orca Whirlpool | Planned | No | No |
| Meteora | Planned | No | No |

## Jito Integration

The bot uses Jito bundles for MEV protection:

- Bundles swap + tip transaction together
- Dynamic tip calculation based on expected profit
- Automatic fallback to direct RPC if bundle fails
- Rotates between multiple Jito tip accounts

## Logs

Logs are written to:
- Console (colored, human-readable)
- `./logs/sniper.log` (JSON format)

Configure log level in `.env`:
```env
LOG_LEVEL=info  # debug, info, warn, error
```

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start with hot-reload |
| `npm run build` | Compile TypeScript |
| `npm start` | Run compiled code |
| `npm run generate-wallet` | Generate new keypair |
| `npm test` | Run tests |

## Disclaimer

**USE AT YOUR OWN RISK**

- This software is provided as-is with no warranties
- Cryptocurrency trading involves substantial risk of loss
- Most new tokens are scams - the security checks reduce but don't eliminate risk
- Never invest more than you can afford to lose
- Always test on devnet first
- Keep your private keys secure - never share them

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Run `npm run build` to ensure no errors
5. Submit a pull request

## License

MIT License - see [LICENSE](LICENSE) for details.

## Acknowledgments

- [Solana](https://solana.com) - Blockchain platform
- [Jito Labs](https://jito.wtf) - MEV infrastructure
- [Helius](https://helius.dev) - RPC provider
- [Shyft](https://shyft.to) - gRPC provider
- [Triton One](https://triton.one) - Yellowstone gRPC
