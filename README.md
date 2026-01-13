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
  - Risk scoring (0-100)
- **MEV Protection**: Jito bundle submission with dynamic tip management
- **Position Management**: Automated take-profit and stop-loss execution
- **Configurable**: Extensive configuration via environment variables

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         SNIPER BOT                              │
├─────────────────────────────────────────────────────────────────┤
│  Monitor Module          Security Module       Executor Module  │
│  ┌─────────────────┐    ┌─────────────────┐   ┌──────────────┐ │
│  │ gRPC (Primary)  │───▶│ Fast Checks     │──▶│ Jito Bundle  │ │
│  │ WebSocket (Fallback)│ │ Deep Analysis   │   │ RPC Fallback │ │
│  │                 │    │ Honeypot Sim    │   │              │ │
│  └─────────────────┘    └─────────────────┘   └──────────────┘ │
│           │                      │                    │         │
│           └──────────────────────┼────────────────────┘         │
│                                  ▼                              │
│                    ┌─────────────────────────┐                  │
│                    │   Position Manager      │                  │
│                    │   (TP/SL Automation)    │                  │
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
│       └── blacklist.ts   # Known scam cache
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

A token must score above `RISK_SCORE_THRESHOLD` (default: 70) to be traded.

## How It Works

1. **Detection**: Monitor subscribes to DEX program accounts via gRPC
2. **Parsing**: New pool creation transactions are parsed for token info
3. **Analysis**: Security module runs all checks and calculates risk score
4. **Execution**: If passed, buy transaction is submitted via Jito bundle
5. **Management**: Position is tracked for take-profit or stop-loss

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
