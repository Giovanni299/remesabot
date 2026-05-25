# Stellar Anchor Demo

A hands-on implementation of a **Stellar Anchor** using the [Stellar Anchor Platform](https://developers.stellar.org/platforms/anchor-platform), featuring a Telegram bot as the client interface for SEP-24 deposits.

## Repository Structure

```
Stellar/
├── anchor-platform/          # Stellar Anchor Platform (Docker-based)
├── business-server/          # Custom Business Server (Express + TypeScript)
│   ├── src/
│   │   ├── server.ts         # Express app, KYC endpoints, event handler
│   │   ├── telegram.ts       # Telegram bot + SEP-24 orchestration
│   │   └── types.ts          # Shared TypeScript types
│   ├── .env                  # Environment configuration
│   └── package.json
└── EnviarFondos/             # Standalone USDC transfer script
    ├── send-usdc.js
    └── package.json
```

## Architecture Overview

```
Telegram User
    │
    │ "depositar 50"
    ▼
Telegram Bot (business-server)
    │
    │ POST /sep24/transactions/deposit/interactive
    ▼
Anchor Platform (:8080)  ◄──────────────────────────────────────────┐
    │                                                                 │
    │ POST /event (transaction_created)                               │
    ▼                                                                 │
Business Server (:8092)                                              │
    │                                                                 │
    │ sends interactive URL to user via Telegram                     │
    │                                                                 │
User fills KYC form (browser)                                        │
    │                                                                 │
    │ PUT /customer                                                   │
    ▼                                                                 │
Business Server                                                      │
    │                                                                 │
    │ RPC: request_offchain_funds                                     │
    │ RPC: notify_offchain_funds_received                             │
    ▼                                                                 │
Anchor Platform                                                      │
    │                                                                 │
    │ POST /event (status: pending_anchor)                            │
    ▼                                                                 │
Business Server                                                      │
    │                                                                 │
    │ submits Stellar payment (distribution account → user wallet)   │
    ▼                                                                 │
Stellar Testnet                                                      │
    │                                                                 │
    │ RPC: notify_onchain_funds_sent (tx hash)                       │
    └─────────────────────────────────────────────────────────────────┘
                                                      ▲
                                          Anchor Platform marks txn
                                               as "completed"
```

## SEP-24 Deposit Flow

| Step | Actor | Action |
|------|-------|--------|
| 1 | User | Sends `depositar [amount]` to the Telegram bot |
| 2 | Bot | Calls `POST /sep24/transactions/deposit/interactive` on the Anchor Platform with a SEP-10 JWT |
| 3 | Platform | Creates transaction, returns an interactive URL |
| 4 | Bot | Sends the URL to the user as an inline button |
| 5 | User | Opens the URL and submits the KYC form (name, email) |
| 6 | Business Server | Receives `PUT /customer`, stores KYC data, calls Platform RPC to advance the transaction |
| 7 | Platform | Fires `transaction_status_changed` event with `pending_anchor` status |
| 8 | Business Server | Submits USDC payment on Stellar Testnet from the distribution account |
| 9 | Business Server | Calls `notify_onchain_funds_sent` RPC with the transaction hash |
| 10 | Platform | Marks transaction as `completed` |

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) v20+
- [Docker](https://www.docker.com/) (for the Anchor Platform)
- A Telegram bot token from [@BotFather](https://t.me/BotFather)
- A funded Stellar Testnet account (use [Friendbot](https://friendbot.stellar.org/))

### 1. Start the Anchor Platform

```bash
cd anchor-platform
# Follow the instructions in anchor-platform/README.md
# The platform exposes:
#   :8080  → public SEP endpoints (client-facing)
#   :8085  → private Platform API (business server only)
```

### 2. Configure the Business Server

```bash
cd business-server
cp .env.example .env   # create from the template below
npm install
```

**.env**

```env
PORT=8092

# Anchor Platform URLs
PLATFORM_API_BASE_URL=http://localhost:8085
ANCHOR_SEP24_URL=http://localhost:8080

# Public URL exposed to users (e.g. via Cloudflare Tunnel for local dev)
SEP24_PUBLIC_URL=https://your-tunnel.trycloudflare.com

# Must match SECRET_SEP10_JWT_SECRET in the Anchor Platform config
SECRET_SEP10_JWT_SECRET=your_sep10_jwt_secret

# Stellar Testnet account used as the "user" in bot sessions
STELLAR_TEST_ACCOUNT=G...

# Distribution account that signs on-chain USDC payments
DISTRIBUTION_SECRET_KEY=S...

# Telegram bot token
TELEGRAM_BOT_TOKEN=123456:ABC-...

# Production only — webhook URL for the Telegram bot
# If unset, the bot falls back to long polling (recommended for local dev)
# TELEGRAM_WEBHOOK_URL=https://your-domain.com
```

### 3. Run the Business Server

```bash
# Development (hot reload)
npm run dev

# Production
npm run build && npm start
```

The server starts on `http://localhost:8092` and logs all incoming requests.

If `TELEGRAM_WEBHOOK_URL` is **not** set, the Telegram bot starts in **long-polling** mode automatically — no public URL needed for local development.

## Business Server — API Reference

### Event Endpoint

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/event` | Receives lifecycle events from the Anchor Platform |

**Handled event types:**

- `transaction_created` — logs the new transaction
- `transaction_status_changed` — drives the deposit state machine
- `quote_created` — logs SEP-38 quote creation

### SEP-12 KYC Callbacks

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/customer` | Returns KYC status for a user (`id` or `account` query param) |
| `PUT` | `/customer` | Receives and stores KYC fields submitted by the user |
| `DELETE` | `/customer/:id` | Removes a customer record |

**KYC fields collected:**

| Field | Type | Required |
|-------|------|----------|
| `first_name` | string | Yes |
| `last_name` | string | Yes |
| `email_address` | string | Yes |

### SEP-24 Interactive UI

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/sep24/transaction/interactive` | Serves the KYC form embedded inside the SEP-24 iframe |
| `GET` | `/sep24/transaction/more_info` | Renders transaction detail page |

### Telegram Webhook

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/telegram/webhook` | Receives Telegram updates (production webhook mode) |

## Telegram Bot Commands

The bot recognizes the following trigger words: `depositar`, `deposit`, `enviar`, `send`, `transfer`.

| Input | Bot Response |
|-------|-------------|
| `depositar 50` | Starts a SEP-24 deposit for 50 USDC immediately |
| `depositar` | Asks for the amount, then proceeds |
| Any other text | Shows help message |

## EnviarFondos — Standalone USDC Transfer

A simple script that sends USDC directly on Stellar Testnet without an anchor, useful for testing wallets and trustlines.

```bash
cd EnviarFondos
npm install
```

**.env** (inside `EnviarFondos/`)

```env
SENDER_PUBLIC_KEY=G...
SENDER_SECRET_KEY=S...
RECEIVER_PUBLIC_KEY=G...
RECEIVER_SECRET_KEY=S...
USDC_ISSUER=GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5
```

```bash
npm start
```

The script will:
1. Ensure both accounts have a USDC trustline
2. Verify the sender has at least 10 USDC
3. Send 3 USDC from sender to receiver
4. Print final balances and the transaction link on Stellar Expert

## Local Development with Cloudflare Tunnel

The Anchor Platform needs a publicly reachable URL to embed in the SEP-24 interactive iframe. Use [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/get-started/create-local-tunnel/) for zero-config tunneling:

```bash
cloudflared tunnel --url http://localhost:8092
```

Set the generated URL as `SEP24_PUBLIC_URL` in your `.env`.

## Environment Variables Reference

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PORT` | No | `8092` | Port the business server listens on |
| `PLATFORM_API_BASE_URL` | Yes | `http://localhost:8085` | Private Anchor Platform API |
| `ANCHOR_SEP24_URL` | Yes | `http://localhost:8080` | Public Anchor Platform URL |
| `SEP24_PUBLIC_URL` | No | — | Public base URL rewriting for interactive URLs |
| `SECRET_SEP10_JWT_SECRET` | Yes | — | Shared secret with the Anchor Platform for SEP-10 JWTs |
| `STELLAR_TEST_ACCOUNT` | Yes | — | Stellar account used in bot sessions |
| `DISTRIBUTION_SECRET_KEY` | Yes | — | Secret key of the account that sends USDC on-chain |
| `TELEGRAM_BOT_TOKEN` | Yes | — | Token from @BotFather |
| `TELEGRAM_WEBHOOK_URL` | No | — | If set, registers this URL as the Telegram webhook |

## Relevant Standards

- [SEP-10](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0010.md) — Stellar Web Authentication
- [SEP-12](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0012.md) — KYC API
- [SEP-24](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0024.md) — Hosted Deposit and Withdrawal

## License

MIT
