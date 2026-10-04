# Agent Research Tools — pay-per-call x402 APIs (USDC on Base, Polygon, Arbitrum)

Live: **https://x402-seller-pmlm.onrender.com** · Agent guide: [`/llms.txt`](https://x402-seller-pmlm.onrender.com/llms.txt) · OpenAPI: [`/openapi.json`](https://x402-seller-pmlm.onrender.com/openapi.json) · Discovery: [`/.well-known/x402`](https://x402-seller-pmlm.onrender.com/.well-known/x402)

No API key, no signup. AI agents pay per request in USDC on Base (`eip155:8453`), Polygon (`eip155:137`) or
Arbitrum (`eip155:42161`) using the
[x402](https://x402.org) protocol, settled through the Coinbase CDP facilitator and listed in the CDP x402 Bazaar.

| Endpoint | Price | Use it when | Returns |
|---|---|---|---|
| `GET /report?q=<question>` | $0.01 | You need a quick, cited answer or background on a topic | `summary`, 3-6 cited `bullets`, `sources[]` (official docs, Wikipedia, Stack Overflow, GitHub, papers; off-topic sources dropped) with URLs + dates |
| `GET /read?url=<https url>` | $0.005 | You have a URL and need its text for an LLM | `title`, `description`, `publishedAt`, clean `markdown`, `wordCount`, `headings[]`, `links[]` |
| `GET /check?url=<x402 endpoint>` | $0.005 | You are about to pay for or list an x402 API | readiness `score`, per-check results, `fixes[]` (one unpaid probe; never pays the target) |

**Never charged for errors:** 400 bad input, 422 nothing found / target unreachable, 503 unavailable.
The x402 middleware only settles a payment when the handler returns 2xx.

## Call it

```bash
# 1. Unpaid call -> 402 with base64 JSON challenge in the PAYMENT-REQUIRED header
curl -i "https://x402-seller-pmlm.onrender.com/report?q=history+of+the+transistor"

# 2. Pay with any x402 client, e.g. @x402/fetch
```

```ts
import { wrapFetchWithPayment } from "@x402/fetch";
// ... create an x402 client with an EVM signer holding a little Base USDC
const res = await fetchWithPayment("https://x402-seller-pmlm.onrender.com/report?q=what+is+RAG");
console.log(await res.json()); // { summary, bullets, sources, ... }
```

## Run it yourself

Node 22+, a CDP API key (https://portal.cdp.coinbase.com), and a Base receive address.

```bash
cp .env.example .env   # fill CDP_API_KEY_ID / CDP_API_KEY_SECRET / X402_PAY_TO
npm ci && npm run dev  # http://localhost:8402
```

| Env | Default | Notes |
|---|---|---|
| `X402_ENV` | `development` | `production` = Base + Polygon + Arbitrum mainnet, `development` = Base Sepolia |
| `X402_NETWORKS` | per `X402_ENV` | Optional comma-separated CAIP-2 override, e.g. `eip155:8453,eip155:137` (supported: 8453, 137, 42161, 84532). Same `X402_PAY_TO` on every EVM chain |
| `X402_PAY_TO` | — | Your EVM receive address (else CDP provisions one; needs `CDP_WALLET_SECRET`) |
| `REPORT_PRICE` / `READ_PRICE` / `CHECK_PRICE` | `$0.01` / `$0.005` / `$0.005` | Per-call prices |
| `PUBLIC_URL` | Render URL | Used in discovery docs |
| `DAILY_SPEND_CAP_USD` | `50` | Runaway guard on confirmed settlements per UTC day |
| `GROK_API_KEY` or `OPENAI_API_KEY` | — | Optional: LLM synthesis over the cited sources; without it `/report` is extractive |

Free routes: `/health`, `/llms.txt`, `/openapi.json`, `/.well-known/x402`, `/robots.txt`, `/icon.svg`.

## Discovery and ranking

- Every paid route declares `extensions.bazaar` (input schema + example, typed output schema + example) and
  `resource.serviceName` / `tags` / `iconUrl` / `mimeType`, per the x402 Bazaar spec.
- CDP Bazaar indexes a route after its first CDP-settled payment and refreshes ranking every ~6 h
  (30-day calls, unique payers, metadata quality, availability). Routes with no settlement for 30 days drop out.
- `node scripts/rank-check.mjs` prints the recurring checklist (live status, Bazaar listing + rank per query,
  CDP validate, on-chain sales, x402scan presence). A weekly GitHub Action runs it.

## Guard rails

- Settlements are logged to `payments.jsonl` (gitignored) only after the facilitator confirms, with payer + tx hash.
- Circuit breaker: 3 failed settlements (verified payment, settle failed) in 10 minutes -> 503 (uncharged) for paid calls.
- `/read` and `/check` only fetch public `https` hosts (private/loopback/link-local IPs blocked, redirects re-checked, 3 MB / 15 s caps).

MIT-style: use freely. No secrets in this repo; never commit `.env`.
