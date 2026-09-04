# x402 seller (minimal)

Minimal Express seller using Coinbase CDP `createX402Server` and `@x402/express` `paymentMiddlewareFromHTTPServer`.

Default: **development** on **Base Sepolia** (`eip155:84532`) at **$0.01** for `GET /report`.

This project does **not** ship secrets. Do **not** commit `.env` or `payments.jsonl`.

Official quickstart: https://docs.cdp.coinbase.com/x402/quickstart-for-sellers

## Prerequisites

- Node.js 22+
- A CDP API key from https://portal.cdp.coinbase.com
- Either your own receive address in `X402_PAY_TO`, or a `CDP_WALLET_SECRET` so CDP can provision a receiver wallet

## Setup (beginner)

1. Create an API key at portal.cdp.coinbase.com.

2. Copy .env.example to .env. Fill CDP credentials from the portal.

3. Option A: set X402_PAY_TO. Server uses payToConfig with type address.

3b. Option B: leave X402_PAY_TO unset; set CDP_WALLET_SECRET. Server omits payToConfig so CDP provisions.

4. Install deps, load env, start with the dev script. Default PORT is 8402.

## Prove 402 with curl

Free: curl -sS http://localhost:8402/health

Paid without payment (expect HTTP 402 and PAYMENT-REQUIRED header):

curl -i "http://localhost:8402/report?q=test"

## Routes

- GET /health — free status
- GET /report?q= — paid; returns JSON { query, summary, bullets, generatedAt, note }

Without OPENAI_API_KEY or GROK_API_KEY, report body is a synthetic outline labeled for testing.

## Environment

- CDP_API_KEY_ID / CDP_API_KEY_SECRET — required for facilitator auth
- X402_PAY_TO — optional; if set uses address payToConfig
- CDP_WALLET_SECRET — needed when X402_PAY_TO is unset
- PORT=8402
- X402_ENV=development|production
- REPORT_PRICE — default $0.01 (dev) or $1.25 (prod)
- DAILY_SPEND_CAP_USD — default 50

## Flip to production (Base mainnet)

After Sepolia works, set X402_ENV=production and REPORT_PRICE=$1.25. Networks become eip155:8453 (Base). Ensure the receive address can accept mainnet USDC. Real funds; do not deploy publicly from this alone.

## Guard rails

- Appends settlements and errors to payments.jsonl (gitignored)
- DAILY_SPEND_CAP_USD default 50; returns 503 when exceeded

- Circuit breaker: 3 settle failures in 10 minutes opens the circuit (503)
- Does not invent on-chain payment hashes

Weekly summary script: report-week (see package.json scripts).

## Scripts

- dev: tsx src/server.ts
- report-week: summarize last 7 days of payments.jsonl

## Safety

No GitHub clone. No secrets committed. Do not call live CDP APIs until you set keys and start the server intentionally. Local/private use only.
