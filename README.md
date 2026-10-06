# Agent Research Tools — pay-per-call x402 APIs (USDC on Base, Polygon, Arbitrum, Solana, Avalanche, Sei)

Live: **https://x402-seller-pmlm.onrender.com** · Agent guide: [`/llms.txt`](https://x402-seller-pmlm.onrender.com/llms.txt) · OpenAPI: [`/openapi.json`](https://x402-seller-pmlm.onrender.com/openapi.json) · Discovery: [`/.well-known/x402`](https://x402-seller-pmlm.onrender.com/.well-known/x402)

No API key, no signup. AI agents pay per request in USDC on Base (`eip155:8453`), Polygon (`eip155:137`),
Arbitrum (`eip155:42161`), Solana mainnet (CDP facilitator) or Avalanche (`eip155:43114`) and Sei (`eip155:1329`)
(free PayAI facilitator) using the
[x402](https://x402.org) protocol, settled through the Coinbase CDP facilitator and listed in the CDP x402 Bazaar.

| Endpoint | Price | Use it when | Returns |
|---|---|---|---|
| `GET /report?q=<question>` | $0.01 | You need a quick, cited answer or background on a topic | `summary`, 3-6 cited `bullets`, `sources[]` (official docs, Wikipedia, Stack Overflow, GitHub, papers; off-topic sources dropped) with URLs + dates |
| `GET /read?url=<https url>` | $0.005 | You have a URL and need its text for an LLM | `title`, `description`, `publishedAt`, clean `markdown`, `wordCount`, `headings[]`, `links[]` |
| `GET /check?url=<x402 endpoint>` | $0.005 | You are about to pay for or list an x402 API | readiness `score`, per-check results, `fixes[]` (one unpaid probe; never pays the target) |
| `GET /news?q=<keywords>` | $0.005 | You need what happened on a topic in the last 1-7 days | `articles[]` (title, url, outlet, `publishedAt`, match `score`, `partialMatch`), `outlets`, provider status. Optional `hours` (1-168, default 72), `limit` (1-25). Headlines + links only |
| `GET /price?token=<symbol, 0x address or Solana mint>` | $0.002 | You need a verifiable USD price + 24h change for a token | `priceUsd`, `change24hPct` + `priceUsd24hAgo` (EVM), `confidence`, `poolSpreadPct`, `totalDepthUsd`, `pools[]` with explorer links, `block`/`slot`. Optional `chain` (ethereum, base, arbitrum, polygon, solana) |
| `GET /solana-price?token=<symbol or mint>` | $0.002 | You need a Solana token price (incl. pump.fun / PumpSwap tokens) | `priceUsd`, `confidence`, `thinLiquidity`, `pools[]` (Orca Whirlpool, Raydium CLMM, PumpSwap, pump.fun curve) with depth, `poolSpreadPct`, `solUsd`, `slot` |
| `GET /balance?address=<0x, name.eth or Solana address>` | $0.003 | You need what a wallet holds and what it is worth | per-chain `native` + `tokens[]` (balance, price, USD) and `totalUsd`; EVM = Ethereum, Base, Arbitrum, Polygon in one call. Optional `chain`, `tokens` (extra contracts/mints) |
| `GET /tx?hash=<0x hash or Solana signature>` | $0.003 | You need to know if a tx/payment landed and what it did | `status`, `timestamp`, `confirmations`, `from`/`to`, decoded `method` (flags x402 / EIP-3009 USDC payments), `fee` in USD, decoded `tokenTransfers[]` (EVM) or SOL/token balance changes (Solana). Optional `chain` |
| `GET /gas[?chain=]` | $0.002 | You need current fees before sending a tx | base fee, slow/standard/fast priority fees, `maxFeePerGas`, USD cost of a transfer / ERC-20 transfer / swap per EVM chain, Solana priority fees, `cheapestEvmForErc20Transfer` |

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
| `X402_ENV` | `development` | `production` = Base, Polygon, Arbitrum, Solana (CDP) + Avalanche, Sei (PayAI); `development` = Base Sepolia + Solana Devnet |
| `X402_NETWORKS` | per `X402_ENV` | Optional comma-separated CAIP-2 override, e.g. `eip155:8453,eip155:137` (supported: 8453, 137, 42161, 43114, 1329, 84532, Solana mainnet/devnet). Same `X402_PAY_TO` on every EVM chain |
| `X402_SOLANA_PAY_TO` | built-in public address | Solana receive address (public key only; the secret never lives in this repo) |
| `PAYAI_FACILITATOR_URL` | `https://facilitator.payai.network` | Facilitator for Avalanche/Sei (free tier, no API key) |
| `X402_PAY_TO` | — | Your EVM receive address (else CDP provisions one; needs `CDP_WALLET_SECRET`) |
| `REPORT_PRICE` / `READ_PRICE` / `CHECK_PRICE` / `NEWS_PRICE` / `TOKEN_PRICE` | `$0.01` / `$0.005` / `$0.005` / `$0.005` / `$0.002` | Per-call prices |
| `SOL_PRICE` / `BALANCE_PRICE` / `TX_PRICE` / `GAS_PRICE` | `$0.002` / `$0.003` / `$0.003` / `$0.002` | Per-call prices for `/solana-price`, `/balance`, `/tx`, `/gas` |
| `NEWS_GKG_HOURS` | `24` | Hours of the GDELT GKG 15-minute news index kept in memory (0 = off). ~2.5 MB download per 15 min, ~50k headlines/day, ~60 MB RAM |
| `NEWS_GDELT_API` | off | `1` = also query the GDELT DOC API (rate-limited; adds latency) |
| `TRAFFIC_FILE` | `./data/traffic.json` | Where `/stats` counts are saved (every 10 min + on shutdown). `off` = memory only. Render free has no persistent disk, so counts reset on each deploy unless you mount a disk here |
| `SOLANA_RPC_URLS` | Solana Foundation + PublicNode | Comma-separated Solana RPC URLs (first healthy one wins) |
| `PUBLIC_URL` | Render URL | Used in discovery docs |
| `DAILY_SPEND_CAP_USD` | `50` | Runaway guard on confirmed settlements per UTC day |
| `GROK_API_KEY` or `OPENAI_API_KEY` | — | Optional: LLM synthesis over the cited sources; without it `/report` is extractive |

Free routes: `/health`, `/stats`, `/examples`, `/llms.txt`, `/openapi.json`, `/.well-known/x402`, `/robots.txt`, `/icon.png` (`/icon.svg`).

## Answer permalinks (`/a/<id>`)

Every paid `/report` answer gets a free shareable page at `/a/<id>` (clean HTML; `?format=json` for the stored JSON) with a footer link back to the service. Stored in memory only (max 500, 30 days), so links reset on each Render deploy/restart. Only the answer is stored (question, answer, sources), never IP, user agent or payer. `/a/example-rag` is a pinned demo. The paid response leads with bot-friendly fields: `answer`, `answer_citations`, `key_points[{text,citations}]`, sources with `publisher`, `published`, `quote`, `confidence` + `confidence_why`, `checked_at`, `permalink`; the original fields (`summary`, `bullets`, ...) are unchanged.

## Interest tracker (`/stats`)

Open `/stats` in a browser (or `/stats?view=simple`) for a plain-English page: one headline sentence, a per-tool table (looked at price / paid / bots-crawlers), Pacific times. Programs get JSON (default, or `?format=json`). Payments signed by our own test wallet (`SELF_PAYERS`, default `0x4862…4940`) and the unpaid probe just before them from the same visitor are tagged `self` and excluded from buyer counts (`selfPaid` shows them).

Per paid route and per hour / UTC day: unpaid 402s, paid 200s, settle failures, rejected payments, uncharged
errors and unique visitors, split by visitor class: `client` (anyone who sends a payment, or a non-bot user agent such
as node, python, curl, a browser), `crawler` (CDP Bazaar, x402scan, 402index, other x402 directories), `pinger`
(cron-job.org, UptimeRobot, ...), `bot` (search/AI crawlers, scanners, empty UA), `head` (HEAD/OPTIONS) and `self`
(`scripts/rank-check.mjs`). Visitors are `sha256(random daily salt + IP + UA)`; raw IPs are never stored and the salt
never leaves memory. `/health` carries a compact `traffic` block; `/stats` has today, yesterday, last 7 days, 48 hourly
and 35 daily buckets, top user agents and definitions. Memory use is a few hundred KB.

## Discovery and ranking

- Every paid route declares `extensions.bazaar` (input schema + example, typed output schema + example) and
  `resource.serviceName` / `tags` / `iconUrl` / `mimeType`, per the x402 Bazaar spec.
- CDP Bazaar indexes a route after its first CDP-settled payment and refreshes ranking every ~6 h
  (30-day calls, unique payers, metadata quality, availability). Routes with no settlement for 30 days drop out.
- `node scripts/rank-check.mjs` prints the recurring checklist (live status, Bazaar listing + rank per query with and
  without the Base filter, CDP validate, on-chain sales, `/stats` interest tracker, x402scan presence).
- What moves Bazaar search order (CDP docs + observed rankings): relevance of `serviceName`, tags and description to
  the query (hybrid text + semantic search), blended with 30-day unique buyers, settled calls, recency and metadata
  completeness; recomputed about every 6 h; results are capped per domain; indexed metadata only refreshes after a new
  CDP-settled payment.

## Guard rails

- Settlements are logged to `payments.jsonl` (gitignored) only after the facilitator confirms, with payer + tx hash.
- Circuit breaker: 3 failed settlements (verified payment, settle failed) in 10 minutes -> 503 (uncharged) for paid calls.
- `/news` sources: the GDELT GKG 15-minute files (open data, cite gdeltproject.org; indexed in memory so no API rate
  limits), Hacker News (Algolia API) and ~26 publisher RSS/Atom feeds (cached 10 min). Only headlines, links, outlet and
  time are returned, never article text.
- `/price` reads Uniswap v3 pool state (`slot0`, reserves) straight from public RPC nodes via Multicall: no third-party
  price API, so every number is verifiable onchain at the returned block. Pools under $25k quote-side depth are ignored;
  no qualifying pool -> 422 (uncharged). 24h change comes from the deepest pool's own TWAP oracle (`observe`) or an
  archive `slot0` read ~24 h of blocks back. Cached 30 s.
- `/solana-price` (and `/price` for Solana) derives Orca Whirlpool, Raydium CLMM, PumpSwap and pump.fun bonding-curve
  accounts by PDA and reads them from public Solana RPC (no indexer, no API key). Not covered: Raydium AMM v4, Meteora.
  No 24h change on Solana (public RPC keeps no price history). Under $5k depth -> 422; under $25k -> `thinLiquidity`.
- `/balance`, `/tx`, `/gas` read public RPC nodes only (Multicall3 on EVM). Balances cover native + a curated list of
  major tokens per chain plus any `tokens=` you pass (public RPC does not index every token a wallet holds).
- `/read` and `/check` only fetch public `https` hosts (private/loopback/link-local IPs blocked, redirects re-checked, 3 MB / 15 s caps).

MIT-style: use freely. No secrets in this repo; never commit `.env`.
