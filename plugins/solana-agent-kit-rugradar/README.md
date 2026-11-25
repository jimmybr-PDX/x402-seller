# RugRadar for Solana Agent Kit

Adds three actions/tools: **rug check**, **token safety** and **honeypot check** for Solana, Base, BNB Chain, Ethereum and Arbitrum.
**$0.02 per check: 45+ data points per token, including 16 signals RugCheck's free report doesn't show (dev-sold %, sniper and launch-bundle share, a live can-you-sell quote, the creator's past launches, volume vs market cap, bot-trading score), across 5 chains.**

Each call costs $0.02 and is paid from a prepaid RugRadar credit key (sent as `X-RugRadar-Key`).

> Danger warnings only. Results describe high-risk patterns, not people.

## Install

```
npm install solana-agent-kit-rugradar
```

RugRadar: https://x402-seller-pmlm.onrender.com/rugradar

## Setup
1. Buy credits (x402, USDC on Base or Solana): `GET https://x402-seller-pmlm.onrender.com/credits/buy?credits=100` (1–1000 credits, $0.02 each). The response contains your key.
2. Set `RUGRADAR_API_KEY=<your key>` in your agent's environment.
3. Install this package and register the plugin (see `src/index.ts`).

Try it free in a browser: https://x402-seller-pmlm.onrender.com/rugradar (3 free checks). MCP server: `https://x402-seller-pmlm.onrender.com/mcp` (streamable HTTP).

## Submitting to the Solana Agent Kit directory (needs the owner's GitHub/npm login)
github.com/sendaifun/solana-agent-kit — PR adding the actions under packages/plugin-* (or publish to npm and list in docs); needs a tests file and docs page.
