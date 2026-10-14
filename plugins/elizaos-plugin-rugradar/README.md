# RugRadar for ElizaOS

Adds three actions/tools: **rug check**, **token safety** and **honeypot check** for Solana, Base, BNB Chain, Ethereum and Arbitrum.
Each call costs $0.01 and is paid from a prepaid RugRadar credit key (sent as `X-RugRadar-Key`).

> Automated heuristic, may be wrong. Not financial advice. Do your own research. Results describe high-risk patterns, not people.

## Setup
1. Buy credits (x402, USDC on Base or Solana): `GET https://x402-seller-pmlm.onrender.com/credits/buy?credits=100` (1–1000 credits, $0.01 each). The response contains your key.
2. Set `RUGRADAR_API_KEY=<your key>` in your agent's environment.
3. Install this package and register the plugin (see `src/index.ts`).

Try it free in a browser: https://x402-seller-pmlm.onrender.com/rugradar (3 free checks). MCP server: `https://x402-seller-pmlm.onrender.com/mcp` (streamable HTTP).

## Submitting to the ElizaOS directory (needs the owner's GitHub/npm login)
github.com/elizaos-plugins/registry — PR adding `"@rugradar/plugin-rugradar": "github:<owner>/<repo>"` to index.json; plugin must be in its own public GitHub repo named plugin-*, published to npm, with images/logo.png (400x400) and images/banner.png (1280x640), and a 'elizaos-plugins' topic.
