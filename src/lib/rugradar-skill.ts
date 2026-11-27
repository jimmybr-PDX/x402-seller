/**
 * Agent-facing RugRadar guide served at GET /skill.md and GET /agents.md
 * (Bankr, AgentCash, Claude/Cursor, OpenClaw, and other AI clients).
 */
export const SKILL_CONTENT_TYPE = "text/markdown; charset=utf-8";

const money = (p: string) => (p.startsWith("$") ? p : `$${p}`);

/** Concise install/usage markdown for external AI agents. */
export function rugradarAgentGuide(publicUrl: string, priceUsd = "0.01"): string {
  const base = publicUrl.replace(/\/$/, "");
  const p = money(priceUsd);
  return [
    "# RugRadar",
    "",
    "On-chain rug and honeypot danger-warning check for token addresses on Solana (including pump.fun), Base, Ethereum, BNB Chain, and Arbitrum.",
    "",
    "RugRadar reports **warnings only**. Never say or imply a token is \"safe\". Do not give financial advice. Call a contract or mint a **token address** (not a \"CA\").",
    "",
    "## Pricing",
    "",
    `- ${p} USDC per \`/rug-check\` or \`/honeypot-check\` call via x402 (no API key, no account) on Base, Solana, and other supported x402 networks.`,
    `- Prepaid credits: \`GET ${base}/credits/buy?credits=N\` at ${p} each (1 credit = 1 rug or honeypot check). Send header \`X-RugRadar-Key\` to skip the x402 round trip.`,
    `- 1 free check every day on the web UI: ${base}/rugradar`,
    "",
    "## HTTP endpoints",
    "",
    `- \`GET ${base}/rug-check?token=<address>&chain=<solana|base|ethereum|bnb|arbitrum>\` (${p}) — full 0-100 danger-warning report (authority, holders, liquidity, sellability, taxes/fees, creator launch history). Same engine also at \`/token-safety\`.`,
    `- \`GET ${base}/honeypot-check?token=<address>&chain=<chain>\` (${p}) — fast sellability / honeypot check.`,
    `- \`GET ${base}/price?token=<address>\` ($0.001) — USD price and 24h change.`,
    `- \`GET ${base}/watch?token=<solana-mint>&hours=24&webhook=<https-url>\` ($0.05 / 24h, $0.10 / 48h) — re-check a Solana token and send a signed webhook on material warning changes.`,
    "",
    "Call without payment to receive HTTP 402 and a `PAYMENT-REQUIRED` header, then retry with `PAYMENT-SIGNATURE` (any x402 client). Failed calls are not charged.",
    "",
    "## MCP",
    "",
    `\`${base}/mcp\` — streamable HTTP, JSON. Six RugRadar tools:`,
    "",
    `- \`rug_check\` (${p})`,
    `- \`honeypot_check\` (${p})`,
    `- \`token_price\` ($0.001)`,
    "- `watch_token` ($0.05 / 24h, $0.10 / 48h)",
    "- `list_watches` (free with a credit key)",
    "- `cancel_watch` (free with a credit key)",
    "",
    "## Warnings checked",
    "",
    "Mint authority, freeze authority, concentrated supply, dev bag / dev sells, unlocked liquidity, honeypot / sellability, taxes and fees, creator launch history.",
    "",
    "## Rules for agents",
    "",
    "- Warnings only. Never say or imply a token is \"safe\".",
    "- No financial advice.",
    "- Say \"token address\", not \"CA\".",
    "- Do not mention or invent private detection methods.",
    "",
    `More: ${base}/llms.txt · ${base}/openapi.json · ${base}/rugradar#agents`,
    "",
  ].join("\n");
}
