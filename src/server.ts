/**
 * x402 research tools for AI agents — x402 resource server (CDP + PayAI facilitators) + Express.
 * Pattern: https://docs.cdp.coinbase.com/x402/quickstart-for-sellers
 *
 * Paid (USDC on Base, Polygon, Arbitrum, Solana via the CDP facilitator; Avalanche, Sei via PayAI):
 *   GET /report?q=   cited research brief (official docs, Wikipedia, Stack Overflow, GitHub, HN-linked articles, Crossref; relevance-filtered extractive summary)
 *   GET /read?url=   any public web page -> clean LLM-ready markdown + title, headings, links
 *   GET /check?url=  x402 endpoint readiness + Bazaar ranking check (one unpaid probe)
 *   GET /news?q=     recent news headlines (GDELT, Hacker News, major publisher RSS feeds)
 *   GET /price?token= onchain token USD price + 24h change (Uniswap v3 on EVM; Orca/Raydium/PumpSwap on Solana)
 *   GET /solana-price?token=  Solana token price by symbol or mint (Orca, Raydium CLMM, PumpSwap, pump.fun curve)
 *   GET /balance?address=     wallet balances + USD (EVM chains or Solana; ENS supported)
 *   GET /tx?hash=             transaction status + decoded token transfers (EVM chains or Solana)
 *   GET /gas                  live gas / priority fees + USD cost per tx type (EVM chains + Solana)
 *
 * Buyers are only charged on HTTP 2xx: @x402/express skips settlement when the handler
 * answers >= 400, so bad input, no sources, or an unreachable target cost nothing.
 *
 * Settlements are logged only after the facilitator confirms (PAYMENT-RESPONSE header),
 * with the real tx hash and payer. No invented hashes.
 */

import { CDP_SUPPORTED_EXTENSIONS, createCdpFacilitatorClient, getCdpDefaultSchemes, getCdpExtensionRegistrations } from "@coinbase/cdp-sdk/x402";
import { HTTPFacilitatorClient, x402HTTPResourceServer, x402ResourceServer } from "@x402/core/server";
import { paymentMiddlewareFromHTTPServer } from "@x402/express";
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";
import express, { type Request, type Response, type NextFunction } from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { InputError, PUBLIC_URL } from "./lib/net.js";
import { researchBrief } from "./lib/research.js";
import { readPage } from "./lib/read.js";
import { checkX402Endpoint } from "./lib/check.js";
import { newsSearch, newsStatus, warmNews } from "./lib/news.js";
import { PRICE_CHAINS, PRICE_SYMBOLS, PriceInputError, tokenPrice } from "./lib/price.js";
import { SOLANA_PRICE_SYMBOLS, SolanaInputError, solanaTokenPrice } from "./lib/solana.js";
import { WalletInputError, walletBalances } from "./lib/wallet.js";
import { TxInputError, txLookup } from "./lib/tx.js";
import { GasInputError, gasNow } from "./lib/gas.js";
import { recordRequest, startTraffic, trafficStats, type Outcome } from "./lib/traffic.js";
import { statsHtml } from "./lib/stats-page.js";
import { answerHtml, deleteAnswer, getAnswer, newAnswerId, pinAnswer, saveAnswer } from "./lib/answers.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const PAYMENTS_LOG = path.join(ROOT, "payments.jsonl");

type EnvMode = "development" | "production";

const PORT = Number(process.env.PORT ?? 8402);
const X402_ENV = (process.env.X402_ENV ?? "development") as EnvMode;
// Daily cap on *earned* USD (a runaway guard). Counted from confirmed settlements only.
const DAILY_SPEND_CAP_USD = Number(process.env.DAILY_SPEND_CAP_USD ?? 50);

const REPORT_PRICE = process.env.REPORT_PRICE ?? "$0.01";
const READ_PRICE = process.env.READ_PRICE ?? "$0.005";
const CHECK_PRICE = process.env.CHECK_PRICE ?? "$0.005";
const NEWS_PRICE = process.env.NEWS_PRICE ?? "$0.005";
const TOKEN_PRICE = process.env.TOKEN_PRICE ?? "$0.002";
const SOL_PRICE = process.env.SOL_PRICE ?? "$0.002";
const BALANCE_PRICE = process.env.BALANCE_PRICE ?? "$0.003";
const TX_PRICE = process.env.TX_PRICE ?? "$0.003";
const GAS_PRICE = process.env.GAS_PRICE ?? "$0.002";
const SERVICE_NAME = "Agent Research Tools"; // <= 32 printable ASCII (Bazaar rule)
// PNG: the Bazaar re-hosts PNG/JPEG icons; our SVG icon never showed up in listings
const ICON_URL = `${PUBLIC_URL}/icon.png`;

// Accepted networks. Base stays first: most x402 clients pick the first matching accepts entry.
// "cdp" networks settle via the Coinbase CDP facilitator (and feed the CDP Bazaar);
// "payai" networks settle via the free PayAI facilitator (no API key; free tier per receiving wallet).
// The same EVM payTo works on every EVM chain; Solana uses its own address (X402_SOLANA_PAY_TO).
// CDP has no Polygon/Arbitrum testnet, so development is Base Sepolia (+ Solana Devnet).
// Override with X402_NETWORKS=eip155:8453,eip155:137 (comma-separated CAIP-2 ids).
type Facilitator = "cdp" | "payai";
const SOLANA_MAINNET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const SOLANA_DEVNET = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
const NETWORK_INFO: Record<string, { name: string; usdc: string; facilitator: Facilitator; family: "evm" | "svm" }> = {
  "eip155:8453": { name: "Base", usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", facilitator: "cdp", family: "evm" },
  "eip155:137": { name: "Polygon", usdc: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", facilitator: "cdp", family: "evm" },
  "eip155:42161": { name: "Arbitrum", usdc: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", facilitator: "cdp", family: "evm" },
  [SOLANA_MAINNET]: { name: "Solana", usdc: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", facilitator: "cdp", family: "svm" },
  "eip155:43114": { name: "Avalanche", usdc: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E", facilitator: "payai", family: "evm" },
  "eip155:1329": { name: "Sei", usdc: "0xe15fC38F6D8c56aF07bbCBe3BAf5708A2Bf42392", facilitator: "payai", family: "evm" },
  "eip155:84532": { name: "Base Sepolia", usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", facilitator: "cdp", family: "evm" },
  [SOLANA_DEVNET]: { name: "Solana Devnet", usdc: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", facilitator: "cdp", family: "svm" },
};
// Public receiving addresses (not secrets). Env overrides win.
const PAY_TO_EVM = process.env.X402_PAY_TO?.trim() || "0x079471E6F43b6feeF80895E19cBFcBB496904852";
const PAY_TO_SVM = process.env.X402_SOLANA_PAY_TO?.trim() || "787RZwDGpjmRsG5wgnyBeWQHBuARax8Qo6P7dmDuqKeW";
const PAYAI_FACILITATOR_URL = process.env.PAYAI_FACILITATOR_URL?.trim() || "https://facilitator.payai.network";
const DEFAULT_NETWORKS =
  X402_ENV === "production"
    ? ["eip155:8453", "eip155:137", "eip155:42161", SOLANA_MAINNET, "eip155:43114", "eip155:1329"] // Solana payTo has an initialized USDC ATA
    : ["eip155:84532", SOLANA_DEVNET];
const NETWORKS: string[] = (process.env.X402_NETWORKS?.split(",").map((n) => n.trim()).filter(Boolean) ?? DEFAULT_NETWORKS).filter((n) => {
  const info = NETWORK_INFO[n];
  if (!info) console.warn(`ignoring unsupported network ${n}`);
  else if (info.family === "svm" && !PAY_TO_SVM) console.warn(`ignoring ${n}: no X402_SOLANA_PAY_TO`);
  else return true;
  return false;
});
if (!NETWORKS.length) throw new Error("No supported networks configured (X402_NETWORKS)");
const payToFor = (network: string) => (NETWORK_INFO[network]!.family === "svm" ? PAY_TO_SVM : PAY_TO_EVM);
const NETWORK_NAMES = NETWORKS.map((n) => NETWORK_INFO[n]!.name);
const NETWORK_LABEL = NETWORK_NAMES.length > 1 ? `${NETWORK_NAMES.slice(0, -1).join(", ")} or ${NETWORK_NAMES.at(-1)}` : NETWORK_NAMES[0]!;
const ON_NETWORKS = `USDC on ${NETWORK_LABEL}`;
const ON_NETWORKS_SHORT = `USDC (${NETWORK_NAMES.join("/")})`;
/** Short price + no-charge note for Bazaar descriptions (keeps the text about the task, not boilerplate). */
const perCall = (p: string) => `${usd(p)} USDC/call; failed calls are free.`;

const PAID = {
  "/report": REPORT_PRICE,
  "/read": READ_PRICE,
  "/check": CHECK_PRICE,
  "/news": NEWS_PRICE,
  "/price": TOKEN_PRICE,
  "/solana-price": SOL_PRICE,
  "/balance": BALANCE_PRICE,
  "/tx": TX_PRICE,
  "/gas": GAS_PRICE,
} as const;
type PaidPath = keyof typeof PAID;

const FAIL_WINDOW_MS = 10 * 60 * 1000;
const FAIL_THRESHOLD = 3;
const settleFailures: number[] = [];
const startedAt = new Date().toISOString();
const counters = { paid200: 0, settleFailed: 0, paymentInvalid: 0, unpaid402: 0, uncharged4xx5xx: 0 };

function appendPaymentLog(entry: Record<string, unknown>): void {
  const line = JSON.stringify({ ...entry, at: new Date().toISOString() }) + "\n";
  try {
    fs.appendFileSync(PAYMENTS_LOG, line, "utf8");
  } catch {
    /* read-only FS: ignore */
  }
}

function parsePriceUsd(price: string): number {
  const n = Number(String(price).replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function sumSettledTodayUsd(): number {
  if (!fs.existsSync(PAYMENTS_LOG)) return 0;
  const day = new Date().toISOString().slice(0, 10);
  let sum = 0;
  for (const line of fs.readFileSync(PAYMENTS_LOG, "utf8").split("\n")) {
    if (!line) continue;
    try {
      const row = JSON.parse(line) as { type?: string; priceUsd?: number; at?: string; confirmed?: boolean };
      if (row.type === "settlement" && row.confirmed && row.at?.startsWith(day) && typeof row.priceUsd === "number") sum += row.priceUsd;
    } catch {
      /* ignore */
    }
  }
  return Math.round(sum * 1e6) / 1e6;
}

function circuitOpen(): boolean {
  const cutoff = Date.now() - FAIL_WINDOW_MS;
  while (settleFailures.length && settleFailures[0]! < cutoff) settleFailures.shift();
  return settleFailures.length >= FAIL_THRESHOLD;
}

// Our own test wallet(s): their payments are tagged "self" in /stats, not counted as buyers.
const SELF_PAYERS = new Set(
  (process.env.SELF_PAYERS ?? "0x4862dac2c03fAA8B36A23D176932945193B04940").toLowerCase().split(",").map((x) => x.trim()).filter(Boolean),
);
function isSelfPayer(req: Request, res: Response): boolean {
  const settled = decodeB64Json(res.getHeader("payment-response"))?.payer;
  const sig = decodeB64Json(req.header("payment-signature") ?? req.header("x-payment"));
  const from = settled ?? sig?.payload?.authorization?.from ?? sig?.payload?.permit2Authorization?.from;
  return typeof from === "string" && SELF_PAYERS.has(from.toLowerCase());
}

function decodeB64Json(v: unknown): any {
  if (typeof v !== "string" || !v) return null;
  try {
    return JSON.parse(Buffer.from(v, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

const usd = (p: string) => p.replace(/^\$/, "");
const ERRORS_DOC =
  "Errors are never charged: 400 bad input, 422 nothing found or target unreachable, 503 busy.";

async function main() {
  const app = express();
  // Render terminates TLS at the edge; trust proxy so 402 resource URLs become https://.
  app.set("trust proxy", 1);
  app.disable("x-powered-by");
  app.use(express.json());

  // Interest tracker (counts only; visitor = salted hash of IP+UA, raw IPs never stored).
  const FREE_LABELS = new Set(["/", "/health", "/stats", "/examples", "/llms.txt", "/openapi.json", "/.well-known/x402", "/.well-known/x402.json", "/robots.txt", "/icon.svg", "/icon.png"]);
  app.use((req: Request, res: Response, next: NextFunction) => {
    const method = req.method;
    // HEAD on a paid route: answer like GET without payment (402 + PAYMENT-REQUIRED, no body) instead of
    // running the paid handler for free. Node drops the body for HEAD requests automatically.
    if (method === "HEAD" && req.path in PAID) req.method = "GET";
    res.on("finish", () => {
      try {
        const paid = req.path in PAID;
        const label = paid ? req.path : FREE_LABELS.has(req.path) ? req.path : req.path.startsWith("/a/") ? "/a" : "other";
        const hasPayment = !!(req.header("payment-signature") || req.header("x-payment"));
        const sc = res.statusCode;
        let outcome: Outcome = sc < 400 ? "ok" : "error";
        if (paid) {
          if (sc === 402) outcome = !hasPayment ? "unpaid402" : res.locals.paidHandlerRan ? "settleFailed" : "paymentInvalid";
          else if (hasPayment && sc < 300 && decodeB64Json(res.getHeader("payment-response"))?.success) outcome = "paid200";
          else if (hasPayment && sc >= 400) outcome = "uncharged";
        }
        const selfPayer = paid && hasPayment && isSelfPayer(req, res);
        recordRequest(label, method, String(req.header("user-agent") ?? "").slice(0, 300), req.ip ?? "", outcome, paid && hasPayment, selfPayer);
      } catch {
        /* never let stats break a response */
      }
    });
    next();
  });

  // CORS for browser-based agents / directory probes (payment headers must be readable).
  app.use((req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "*");
    res.setHeader("Access-Control-Expose-Headers", "PAYMENT-REQUIRED, PAYMENT-RESPONSE, EXTENSION-RESPONSES");
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
  });


  // Guard rails + accurate settlement logging (runs before payment middleware).
  app.use((req: Request, res: Response, next: NextFunction) => {
    const p = req.path as PaidPath;
    if (req.method !== "GET" || !(p in PAID)) return next();
    const price = PAID[p];
    const hasPayment = !!(req.header("payment-signature") || req.header("x-payment"));
    if (hasPayment) {
      if (circuitOpen()) {
        res.status(503).json({ error: "circuit_open", message: "Settlement failures in the last 10 minutes; retry shortly. You were not charged." });
        return;
      }
      const spent = sumSettledTodayUsd();
      if (spent + parsePriceUsd(price) > DAILY_SPEND_CAP_USD) {
        res.status(503).json({ error: "daily_cap", message: "Daily volume cap reached; retry after 00:00 UTC. You were not charged." });
        return;
      }
    }
    res.on("finish", () => {
      const pr = decodeB64Json(res.getHeader("payment-response"));
      if (res.statusCode === 402) {
        if (hasPayment && res.locals.paidHandlerRan) {
          // Payment verified, handler produced content, but settlement failed (buyer not charged, got 402).
          counters.settleFailed++;
          settleFailures.push(Date.now());
          appendPaymentLog({ type: "error", kind: "settle_failed", route: `GET ${p}`, reason: pr?.errorReason ?? null, payer: pr?.payer ?? null });
        } else if (hasPayment) {
          counters.paymentInvalid++; // bad/expired signature: rejected at verify; does not trip the circuit
        } else counters.unpaid402++;
        return;
      }
      if (res.statusCode >= 400) {
        if (hasPayment) counters.uncharged4xx5xx++;
        return;
      }
      if (hasPayment && pr?.success) {
        counters.paid200++;
        appendPaymentLog({
          type: "settlement",
          confirmed: true,
          route: `GET ${p}`,
          price,
          priceUsd: parsePriceUsd(price),
          network: pr.network ?? NETWORKS[0],
          payer: pr.payer ?? null,
          transaction: pr.transaction ?? null,
          query: String(req.query.q ?? req.query.url ?? req.query.token ?? req.query.address ?? req.query.hash ?? req.query.chain ?? "").slice(0, 200),
        });
      }
    });
    next();
  });

  // One accepts entry per network; CDP resolves "$0.01" to each chain's native USDC.
  const accept = (price: string) =>
    NETWORKS.map((network) => ({
      scheme: "exact",
      price,
      network,
      payTo: payToFor(network),
      maxTimeoutSeconds: 300,
    }));

  // Trimmed for the 402 header: legacy fields (summary, bullets, snippet, wikipedia, next, ...) are also returned; see schema.
  const reportExample = {
    "answer": "Retrieval-augmented generation (RAG) is a technique that enables large language models (LLMs) to retrieve and incorporate new information from external data sources. With RAG, LLMs first refer to a specified set of documents, then respond to user queries.",
    "answer_citations": [2],
    "key_points": [{"text": "Retrieval-Augmented Generation (RAG) has shown significant improvements in various natural language processing tasks by integrating the strengths of…", "citations": [1]}, {"text": "Retrieval-augmented generation is a technique for enhancing the accuracy and reliability of generative AI models with information fetched from…", "citations": [3]}, {"text": "The term retrieval-augmented generation (RAG) was introduced in a 2020 paper that described combining a parametric language model with a…", "citations": [2]}],
    "confidence": "high",
    "confidence_why": "3 cited sources from 3 publisher(s), incl. primary/authoritative: arxiv.org.",
    "checked_at": "2026-10-06T07:13:00.721Z",
    "permalink": "https://x402-seller-pmlm.onrender.com/a/example-rag",
    "sources": [{"id": 1, "type": "web_page", "publisher": "arxiv.org", "title": "[2404.12457] RAGCache: Efficient Knowledge Caching for…", "url": "https://arxiv.org/abs/2404.12457", "published": "2024-04-30", "quote": "Retrieval-Augmented Generation (RAG) has shown significant improvements in various natural language…"}, {"id": 2, "type": "encyclopedia", "publisher": "Wikipedia", "title": "Retrieval-augmented generation", "url": "https://en.wikipedia.org/wiki/Retrieval-augmented_generation", "published": "2026-10-02", "quote": "Retrieval-augmented generation (RAG) is a technique that enables large language models (LLMs) to retrieve and…"}, {"id": 3, "type": "web_page", "publisher": "blogs.nvidia.com", "title": "What Is Retrieval-Augmented Generation aka RAG | NVIDIA Blogs", "url": "https://blogs.nvidia.com/blog/what-is-retrieval-augmented-generation/", "published": "2025-01-31", "quote": "Retrieval-augmented generation is a technique for enhancing the accuracy and reliability of generative AI…"}],
    "query": "What is retrieval-augmented generation?",
    "sourceCount": 3,
    "method": "extractive (Wikipedia lead + ranked sentences)",
    "latencyMs": 3805,
  };

  const readExample = {
    "url": "https://en.wikipedia.org/wiki/HTTP_402",
    "finalUrl": "https://en.wikipedia.org/wiki/HTTP_402",
    "status": 200,
    "contentType": "text/html; charset=UTF-8",
    "title": "List of HTTP status codes - Wikipedia",
    "description": null,
    "lang": "en",
    "publishedAt": null,
    "markdown": "From Wikipedia, the free encyclopedia\n\n(Redirected from [HTTP 402](https://en.wikipedia.org/w/index.php?title=HTTP_402&redirect=no))\n\nThis article lists standard and notable non-standard [HTTP response status codes](https://en.wikipedia.org/wiki/HTTP#response-status-code). Standardized codes are defined by [IETF](https://en.wikipedia.org/wiki/IETF) as documented in [Request for…",
    "wordCount": 6414,
    "truncated": true,
    "headings": [{"level": 2, "text": "Standard codes"}, {"level": 3, "text": "1xx informational response"}, {"level": 3, "text": "2xx success"}, {"level": 3, "text": "3xx redirection"}],
    "links": [{"text": "HTTP 402", "url": "https://en.wikipedia.org/w/index.php?title=HTTP_402&redirect=no"}, {"text": "HTTP response status codes", "url": "https://en.wikipedia.org/wiki/HTTP#response-status-code"}, {"text": "IETF", "url": "https://en.wikipedia.org/wiki/IETF"}],
    "fetchMs": 801,
    "fetchedAt": "2026-10-06T07:02:52.859Z",
  };

  const checkExample = {
    "target": "https://x402-seller-pmlm.onrender.com/report",
    "method": "GET",
    "score": 100,
    "grade": "A",
    "passed": 22,
    "total": 22,
    "indexable": true,
    "serviceName": "Research Brief with Citations",
    "priceUsdIfUsdc": 0.01,
    "networks": ["eip155:8453", "eip155:137", "eip155:42161", "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", "eip155:43114", "eip155:1329"],
    "latencyMs": 79,
    "checks": [{"id": "status_402", "pass": true, "severity": "required", "detail": "HTTP 402 (unpaid probe must return 402)"}, {"id": "latency_under_1500ms", "pass": true, "severity": "ranking", "detail": "79 ms"}, {"id": "service_name_set", "pass": true, "severity": "ranking", "detail": "Research Brief with Citations"}, {"id": "tags_set", "pass": true, "severity": "ranking", "detail": "5 tag(s): research brief, web research, summarize a topic, wikipedia summary, answer with sources"}, {"id": "bazaar_extension", "pass": true, "severity": "required", "detail": "extensions.bazaar present"}, {"id": "output_example", "pass": true, "severity": "ranking", "detail": "17 top-level fields in the output example"}, {"id": "example_matches_schema", "pass": true, "severity": "advisory", "detail": "required output fields present in example"}, {"id": "cdp_validator", "pass": true, "severity": "required", "detail": "Coinbase validator: valid=true, simulation=accepted"}],
    "fixes": [],
    "bazaarListing": {"listed": true, "calls30d": 8, "uniquePayers30d": 4, "lastCalledAt": "2026-10-06T05:32:44.371Z", "lastUpdated": "2026-10-06T05:32:44.958Z", "indexedServiceName": "Research Brief with Citations", "indexedTags": ["research brief", "web research", "summarize a topic", "wikipedia summary", "answer with sources"], "metadataStale": []},
    "searchRanks": [{"query": "Research Brief with Citations", "rank": 1, "of": 9, "leader": {"resource": "https://x402-seller-pmlm.onrender.com/report", "calls30d": 8, "payers30d": 4}}, {"query": "research brief", "rank": 1, "of": 9, "leader": {"resource": "https://x402-seller-pmlm.onrender.com/report", "calls30d": 8, "payers30d": 4}}, {"query": "web research", "rank": null, "of": 11, "leader": {"resource": "https://market.datapackvibe.com/x402/demand-next-web-research-methods-researchers", "calls30d": 2, "payers30d": 2}}],
    "cdpValidator": {"valid": true, "simulation": "accepted", "indexed": true, "lastCrawledAt": "2026-10-06T05:32:45.591Z", "failedRequired": [], "failedAdvisory": []},
    "checkedAt": "2026-10-06T07:03:04.512Z",
    "totalMs": 1423,
    "note": "One unpaid probe from this service plus Coinbase's own free validator probe; nothing is ever paid to the target. Bazaar rank = relevance (name, tags,…",
  };

  const newsExample = {
    "query": "bitcoin ETF",
    "terms": ["bitcoin", "etf"],
    "hours": 72,
    "count": 3,
    "articles": [{"title": "Bitcoin ETFs notch third inflow week as Ether ETFs shed $138M", "url": "https://cointelegraph.com/markets/bitcoin-etf-third-inflow-week-ether-funds-red?utm_source=rss_feed&utm_medium=rss&utm_campaign=rss_partner_inbound", "source": "Cointelegraph", "publishedAt": "2026-10-05T08:00:49.000Z", "provider": "rss", "partialMatch": false, "score": 1.49}, {"title": "Bitcoin News Today: BTC Buyers Watch ETF Momentum as Remittix", "url": "https://www.openpr.com/news/4652365/bitcoin-news-today-btc-buyers-watch-etf-momentum-as-remittix", "source": "openpr.com", "publishedAt": "2026-10-06T00:45:00.000Z", "provider": "gdelt", "partialMatch": false, "score": 1.456}, {"title": "'Uptober' Starts Green as Bitcoin ETFs Draw $134 Million", "url": "https://decrypt.co/380007/uptober-starts-green-bitcoin-etfs-draw-134-million", "source": "Decrypt", "publishedAt": "2026-10-04T15:01:03.000Z", "provider": "rss", "partialMatch": false, "score": 1.372}],
    "outlets": ["Cointelegraph", "openpr.com", "Decrypt"],
    "providers": ["rss", "gdelt"],
    "totalMatches": 3,
    "providerStatus": {"gdeltIndex": {"articles": 23729, "hours": 24, "newest": "2026-10-06T07:00:00.000Z"}, "gdeltApi": "off", "hackernews": 0, "rssFeeds": "25/26", "rssPoolAgeSec": 14},
    "note": "Headlines and links only; open the url (or /read) for the full article. Sources: GDELT Project global news index (gdeltproject.org, last 24 h), ~26 major-outlet RSS feeds, Hacker News.",
    "latencyMs": 469,
    "generatedAt": "2026-10-06T07:03:25.003Z",
  };

  const priceExample = {
    "token": {"symbol": "WETH", "name": "Wrapped Ether", "address": "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", "decimals": 18, "chain": "ethereum"},
    "priceUsd": 2697.7325,
    "confidence": "high",
    "change24hPct": -0.99,
    "priceUsd24hAgo": 2724.2224,
    "change24h": {"pool": "0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640", "at": "2026-10-05T06:56:35.000Z", "method": "archive slot0 at block 26124517"},
    "totalSupply": 2116529.2,
    "fdvUsd": 5709829480,
    "supplyNote": "wrapped/bridged token: totalSupply is the amount on this chain only, so fdvUsd is not the asset's market cap",
    "poolSpreadPct": 0.58,
    "outlierPools": 0,
    "totalDepthUsd": 333868633,
    "pools": [{"dex": "uniswap-v3", "pool": "0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640", "feeTier": 500, "quote": "USDC", "priceUsd": 2697.2053, "depthUsd": 149287475, "explorer": "https://etherscan.io/address/0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640"}, {"dex": "uniswap-v3", "pool": "0x4e68Ccd3E89f51C3074ca5072bbAC773960dFa36", "feeTier": 3000, "quote": "USDT", "priceUsd": 2698.4682, "depthUsd": 111380489, "explorer": "https://etherscan.io/address/0x4e68Ccd3E89f51C3074ca5072bbAC773960dFa36"}],
    "block": {"number": 26131717, "timestamp": "2026-10-06T07:02:47.000Z"},
    "method": "Uniswap v3 spot price (slot0) from public RPC; depth-weighted across pools within 3% of the deepest; USDC/USDT treated as $1",
    "note": "priced as WETH",
    "generatedAt": "2026-10-06T07:02:53.811Z",
    "cached": false,
    "latencyMs": 950,
  };

  const solPriceExample = {
    "token": {"symbol": "JUP", "name": "Jupiter", "mint": "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN", "decimals": 6, "chain": "solana"},
    "priceUsd": 0.346897,
    "confidence": "medium",
    "totalSupply": 6861486300,
    "fdvUsd": 2380229716,
    "poolSpreadPct": 0.27,
    "outlierPools": 0,
    "totalDepthUsd": 1070052,
    "pools": [{"dex": "orca-whirlpool", "pool": "C1MgLojNLWBKADvu9BHdtgzz1oZX4dZ5zGdGcgvvW8Wz", "quote": "SOL", "priceUsd": 0.346944, "depthUsd": 936757, "explorer": "https://solscan.io/account/C1MgLojNLWBKADvu9BHdtgzz1oZX4dZ5zGdGcgvvW8Wz"}, {"dex": "raydium-clmm", "pool": "EZVkeboWeXygtq8LMyENHyXdF5wpYrtExRNH9UwB1qYw", "quote": "SOL", "priceUsd": 0.346859, "depthUsd": 52494, "explorer": "https://solscan.io/account/EZVkeboWeXygtq8LMyENHyXdF5wpYrtExRNH9UwB1qYw"}],
    "change24hPct": null,
    "change24hNote": "not available for Solana (public RPC keeps no historical account state)",
    "solUsd": 119.73926,
    "slot": 453828473,
    "method": "Orca Whirlpool + Raydium CLMM sqrt_price, PumpSwap reserves and pump.fun bonding curves read from public Solana RPC; depth-weighted across pools within 3% of the deepest; USDC/USDT treated as $1",
    "generatedAt": "2026-10-06T07:02:59.431Z",
    "cached": false,
    "latencyMs": 5619,
  };
  const balanceExample = {
    "address": "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
    "ens": "vitalik.eth",
    "chains": [{"chain": "ethereum", "block": 26131717, "native": {"symbol": "ETH", "balance": 5.753008903, "priceUsd": 2697.7011, "usd": 15519.9}, "tokens": [{"symbol": "WETH", "address": "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", "balance": 1.465109425, "usd": 3952.43, "priceUsd": 2697.7011}, {"symbol": "USDT", "address": "0xdAC17F958D2ee523a2206206994597C13D831ec7", "balance": 291.368219, "usd": 291.37, "priceUsd": 1, "priceSource": "stablecoin (assumed $1)"}], "totalUsd": 19839.17, "tokensChecked": 18}, {"chain": "base", "block": 52240416, "native": {"symbol": "ETH", "balance": 3.128821803, "priceUsd": 2697.8033, "usd": 8440.95}, "tokens": [{"symbol": "DEGEN", "address": "0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed", "balance": 3000574.185, "usd": 3154.8, "priceUsd": 0.0011}, {"symbol": "WETH", "address": "0x4200000000000000000000000000000000000006", "balance": 0.2003812866, "usd": 540.59, "priceUsd": 2697.8033}], "totalUsd": 12192.44, "tokensChecked": 11}, {"chain": "arbitrum", "block": 512172625, "native": {"symbol": "ETH", "balance": 0.1594117609, "priceUsd": 2696.8778, "usd": 429.91}, "tokens": [{"symbol": "USD₮0", "address": "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9", "balance": 253.338516, "usd": 253.34, "priceUsd": 1, "priceSource": "stablecoin (assumed $1)"}, {"symbol": "USDC", "address": "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", "balance": 158.021811, "usd": 158.02, "priceUsd": 1, "priceSource": "stablecoin (assumed $1)"}], "totalUsd": 1005.02, "tokensChecked": 9}, {"chain": "polygon", "block": 95043351, "native": {"symbol": "POL", "balance": 592.7197672, "priceUsd": 0.109, "usd": 64.6}, "tokens": [{"symbol": "USDT0", "address": "0xc2132D05D31c914a87C6611C10748AEb04B58e8F", "balance": 80.720892, "usd": 80.72, "priceUsd": 1, "priceSource": "stablecoin (assumed $1)"}, {"symbol": "USDC", "address": "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174", "balance": 76.687483, "usd": 76.69, "priceUsd": 1, "priceSource": "stablecoin (assumed $1)"}], "totalUsd": 245.29, "tokensChecked": 9}],
    "totalUsd": 33281.92,
    "note": "Balances read live from public RPC nodes. EVM: native coin + a curated list of major tokens per chain (add more with tokens=); Solana: SOL…",
    "generatedAt": "2026-10-06T07:03:01.443Z",
    "cached": false,
    "latencyMs": 2011,
  };
  const txExample = {
    "chain": "base",
    "status": "success",
    "hash": "0xa565aff51f0109d9a9c9028faa45338b3ebab49543fc25457e82326664ca8c52",
    "blockNumber": 52088549,
    "timestamp": "2026-10-02T18:40:45.000Z",
    "confirmations": 151869,
    "from": "0x8F5cB67B49555E614892b7233CFdDEBFB746E531",
    "to": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    "contractCreated": null,
    "value": {"amount": 0, "symbol": "ETH", "usd": 0},
    "method": {"selector": "0xe3ee160e", "name": "transferWithAuthorization (EIP-3009, used by x402 USDC payments)"},
    "gasUsed": 86518,
    "effectiveGasPriceGwei": 0.007335,
    "fee": {"amount": 6.346180088e-07, "symbol": "ETH", "usd": 0.0017, "note": "L2 execution fee; any L1 data fee is charged separately by the rollup"},
    "tokenTransfers": [{"token": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", "symbol": "USDC", "standard": "erc20", "from": "0x4C29Ec4F680CA88d0019edBfe3A8FF5c80499494", "to": "0x079471E6F43b6feeF80895E19cBFcBB496904852", "amount": 0.01, "raw": "10000"}],
    "logCount": 2,
    "explorer": "https://basescan.org/tx/0xa565aff51f0109d9a9c9028faa45338b3ebab49543fc25457e82326664ca8c52",
    "generatedAt": "2026-10-06T07:03:02.147Z",
    "cached": false,
    "latencyMs": 703,
  };
  const gasExample = {
    "chains": [{"chain": "ethereum", "block": 26131718, "baseFeeGwei": 0.129579, "priorityFeeGwei": {"slow": 0.001, "standard": 0.050912, "fast": 1}, "maxFeePerGasGwei": {"slow": 0.260158, "standard": 0.31007, "fast": 1.25916}, "gasUsedRatio": 0.529, "nativeSymbol": "ETH", "nativeUsd": 2697.7, "costStandard": {"nativeTransfer": {"native": 3.79031e-06, "usd": 0.01023}, "erc20Transfer": {"native": 1.17319e-05, "usd": 0.03165}, "swap": {"native": 3.24884e-05, "usd": 0.08764}}}, {"chain": "base", "block": 52240417, "baseFeeGwei": 0.005, "priorityFeeGwei": {"slow": 0, "standard": 0.0011, "fast": 0.00292}, "maxFeePerGasGwei": {"slow": 0.01, "standard": 0.0111, "fast": 0.01292}, "gasUsedRatio": 0.089, "nativeSymbol": "ETH", "nativeUsd": 2697.8, "costStandard": {"nativeTransfer": {"native": 1.281e-07, "usd": 0.00035}, "erc20Transfer": {"native": 3.965e-07, "usd": 0.00107}, "swap": {"native": 1.098e-06, "usd": 0.00296}}, "note": "L2 execution cost only; the rollup adds a small L1 data fee per tx"}, {"chain": "arbitrum", "block": 512172634, "baseFeeGwei": 0.020016, "priorityFeeGwei": {"slow": 0, "standard": 0, "fast": 0}, "maxFeePerGasGwei": {"slow": 0.040032, "standard": 0.040032, "fast": 0.040032}, "gasUsedRatio": 0.08, "nativeSymbol": "ETH", "nativeUsd": 2696.88, "costStandard": {"nativeTransfer": {"native": 4.20336e-07, "usd": 0.00113}, "erc20Transfer": {"native": 1.30104e-06, "usd": 0.00351}, "swap": {"native": 3.60288e-06, "usd": 0.00972}}, "note": "L2 execution cost only; the rollup adds a small L1 data fee per tx"}, {"chain": "polygon", "block": 95043353, "baseFeeGwei": 246.188, "priorityFeeGwei": {"slow": 30, "standard": 85.1987, "fast": 288.274}, "maxFeePerGasGwei": {"slow": 522.376, "standard": 577.574, "fast": 780.65}, "gasUsedRatio": 0.178, "nativeSymbol": "POL", "nativeUsd": 0.10899, "costStandard": {"nativeTransfer": {"native": 0.00695912, "usd": 0.00076}, "erc20Transfer": {"native": 0.0215401, "usd": 0.00235}, "swap": {"native": 0.0596496, "usd": 0.0065}}}, {"chain": "solana", "slot": 453828503, "baseFeeLamportsPerSignature": 5000, "priorityFeeMicroLamportsPerCu": {"slow": 0, "standard": 0, "fast": 0}, "sampleSlots": 150, "nativeSymbol": "SOL", "nativeUsd": 119.7404, "costFor200kCu": {"slow": {"sol": 5e-06, "usd": 0.0006}, "standard": {"sol": 5e-06, "usd": 0.0006}, "fast": {"sol": 5e-06, "usd": 0.0006}}, "note": "Per-slot minimum priority fees paid by txs touching the busiest SOL/USDC pool over the last ~150 slots (a swap-competitive estimate); 1 signature"}],
    "cheapestEvmForErc20Transfer": "base",
    "generatedAt": "2026-10-06T07:03:03.088Z",
    "cached": false,
    "latencyMs": 940,
  };

  pinAnswer("example-rag", reportExample); // the permalink shown in the /report example resolves

  const strArr = { type: "array", items: { type: "string" } };
  const routes = {
    "GET /report": {
      accepts: accept(REPORT_PRICE),
      description:
        `Research brief with citations: web research on any question or topic in one call. Use to summarize a topic, get a Wikipedia summary, or answer with sources before writing or deciding. Pass q. Returns a direct answer, key points with citation ids, 3-5 vetted sources (official docs, .gov/.edu, journals, Wikipedia as backup) with publisher, date and supporting quote, confidence with reason, and a shareable permalink. ${perCall(REPORT_PRICE)}`,
      mimeType: "application/json",
      serviceName: "Research Brief with Citations",
      tags: ["research brief", "web research", "summarize a topic", "wikipedia summary", "answer a question with sources"],
      iconUrl: ICON_URL,
      extensions: {
        ...declareDiscoveryExtension({
          input: { q: "What is retrieval-augmented generation?" },
          inputSchema: {
            properties: {
              q: { type: "string", minLength: 2, maxLength: 300, description: "Question or topic in plain words, e.g. 'history of the transistor', 'summarize photosynthesis', 'wikipedia summary of Mount Hood'" },
              depth: { type: "string", enum: ["quick", "standard"], description: "quick = encyclopedia + instant answer only (faster); standard (default) adds official docs, Stack Overflow, GitHub, articles linked from Hacker News, and scholarly papers" },
              lang: { type: "string", pattern: "^[a-z]{2,3}$", description: "Wikipedia language code, default en" },
            },
            required: ["q"],
          },
          output: {
            example: reportExample,
            schema: {
              properties: {
                answer: { type: "string", description: "1-3 sentence direct answer (plain text; ids in answer_citations)" },
                answer_citations: { type: "array", items: { type: "integer" }, description: "source ids supporting the answer" },
                key_points: { type: "array", description: "Key points, each tied to the source ids that support it", items: { type: "object", properties: { text: { type: "string" }, citations: { type: "array", items: { type: "integer" } } }, required: ["text", "citations"] } },
                confidence_why: { type: "string", description: "One line: why this confidence level" },
                checked_at: { type: "string", description: "ISO time the sources were checked" },
                permalink: { type: "string", description: "Free shareable page for this answer (/a/<id>; add ?format=json). Kept in memory, may reset on redeploy" },
                query: { type: "string" },
                topic: { type: "string", description: "Topic extracted from q (request words like 'summarize' removed)" },
                summary: { type: "string", description: "Same answer with inline [n] citations" },
                bullets: { ...strArr, description: "Key points, each with [n] citations" },
                sources: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      id: { type: "integer" },
                      type: { type: "string", enum: ["encyclopedia", "instant_answer", "discussion", "paper", "web_page"] },
                      provider: { type: "string" },
                      title: { type: "string" },
                      url: { type: "string" },
                      snippet: { type: "string" },
                      publishedAt: { type: ["string", "null"] },
                      publisher: { type: "string" },
                      published: { type: ["string", "null"], description: "YYYY-MM-DD when known" },
                      quote: { type: "string", description: "Sentence from this source that supports the cited claim" },
                    },
                    required: ["id", "title", "url"],
                  },
                },
                sourceCount: { type: "integer" },
                providers: strArr,
                confidence: { type: "string", enum: ["high", "medium", "low"], description: "high = 3+ cited sources from 2+ providers or 2+ primary/authoritative publishers" },
                confidenceBasis: { type: "string" },
                wikipedia: {
                  type: ["object", "null"],
                  description: "Wikipedia summary card for the topic, when one matches",
                  properties: { title: { type: "string" }, description: { type: ["string", "null"] }, extract: { type: "string" }, url: { type: "string" }, thumbnail: { type: ["string", "null"] }, lastEdited: { type: ["string", "null"] }, wikidataId: { type: ["string", "null"] } },
                },
                next: { type: "array", description: "Suggested follow-up calls", items: { type: "object", properties: { endpoint: { type: "string" }, call: { type: "string" }, why: { type: "string" } } } },
                method: { type: "string", description: "extractive, extractive (Wikipedia lead + ranked sentences), or llm-synthesis:<model>" },
                depth: { type: "string" },
                lang: { type: "string" },
                cached: { type: "boolean" },
                latencyMs: { type: "integer" },
                generatedAt: { type: "string" },
              },
              required: ["answer", "key_points", "sources", "confidence", "checked_at", "query"],
            },
          },
        }),
      },
    },
    "GET /read": {
      accepts: accept(READ_PRICE),
      description:
        `URL to markdown: read any web page as clean, LLM-ready markdown. Use when an agent has a URL (article, docs, blog, product page) and needs the text without HTML, scripts or menus, e.g. to scrape article text or feed a page to an LLM. Pass url (https). Returns title, description, publish date, markdown, word count, headings and links. ${perCall(READ_PRICE)}`,
      mimeType: "application/json",
      serviceName: "URL to Markdown",
      tags: ["url to markdown", "web page to markdown", "read url", "scrape article text", "html to markdown"],
      iconUrl: ICON_URL,
      extensions: {
        ...declareDiscoveryExtension({
          input: { url: "https://en.wikipedia.org/wiki/HTTP_402" },
          inputSchema: {
            properties: {
              url: { type: "string", description: "Public https URL of the page to read" },
              maxChars: { type: "integer", minimum: 1000, maximum: 100000, description: "Max markdown characters to return (default 20000)" },
            },
            required: ["url"],
          },
          output: {
            example: readExample,
            schema: {
              properties: {
                url: { type: "string" },
                finalUrl: { type: "string" },
                status: { type: "integer" },
                title: { type: ["string", "null"] },
                description: { type: ["string", "null"] },
                publishedAt: { type: ["string", "null"] },
                markdown: { type: "string" },
                wordCount: { type: "integer" },
                truncated: { type: "boolean" },
                headings: { type: "array", items: { type: "object" } },
                links: { type: "array", items: { type: "object" } },
                fetchedAt: { type: "string" },
              },
              required: ["url", "markdown"],
            },
          },
        }),
      },
    },
    "GET /check": {
      accepts: accept(CHECK_PRICE),
      description:
        `x402 endpoint check: validate an x402 endpoint and audit its Bazaar listing before you pay for it or list it. One unpaid probe (never pays the target) grades the 402 challenge, schemas, examples, name, tags and latency, and adds Coinbase's validator verdict, the live Bazaar listing (30-day calls, payers, stale metadata) and search rank for its own name and tags. Returns score, grade and prioritized fixes. ${perCall(CHECK_PRICE)}`,
      mimeType: "application/json",
      serviceName: "x402 Endpoint Checker",
      tags: ["x402 endpoint check", "validate x402 endpoint", "x402 bazaar ranking", "x402 listing audit", "api testing"],
      iconUrl: ICON_URL,
      extensions: {
        ...declareDiscoveryExtension({
          input: { url: "https://x402-seller-pmlm.onrender.com/report" },
          inputSchema: {
            properties: {
              url: { type: "string", description: "Public https URL of an x402-protected endpoint (yours or one you are about to pay)" },
              method: { type: "string", enum: ["GET", "POST"], description: "HTTP method to probe (default GET)" },
            },
            required: ["url"],
          },
          output: {
            example: checkExample,
            schema: {
              properties: {
                target: { type: "string" },
                score: { type: "integer", minimum: 0, maximum: 100 },
                grade: { type: "string", enum: ["A", "B", "C", "D", "F"] },
                passed: { type: "integer" },
                total: { type: "integer" },
                indexable: { type: "boolean" },
                serviceName: { type: ["string", "null"] },
                priceUsdIfUsdc: { type: ["number", "null"] },
                networks: strArr,
                latencyMs: { type: "integer" },
                checks: { type: "array", items: { type: "object", properties: { id: { type: "string" }, pass: { type: "boolean" }, severity: { type: "string", enum: ["required", "ranking", "advisory"] }, detail: { type: "string" }, fix: { type: "string" } } } },
                fixes: { ...strArr, description: "Failed checks, required first, each with a concrete fix" },
                bazaarListing: { type: "object", description: "Live CDP Bazaar entry: listed, calls30d, uniquePayers30d, lastCalledAt, indexed name/tags, metadataStale" },
                searchRanks: { type: "array", description: "Bazaar search position for the endpoint's own serviceName and first tags", items: { type: "object", properties: { query: { type: "string" }, rank: { type: ["integer", "null"] }, of: { type: "integer" }, leader: { type: ["object", "null"] } } } },
                cdpValidator: { type: ["object", "null"], description: "Coinbase /x402/validate verdict: valid, simulation, indexed, failed checks" },
                checkedAt: { type: "string" },
                totalMs: { type: "integer" },
              },
              required: ["target", "score", "grade", "checks", "fixes"],
            },
          },
        }),
      },
    },
    "GET /news": {
      accepts: accept(NEWS_PRICE),
      description:
        `News search: latest news headlines on any topic from thousands of outlets, updated every 15 minutes. Use when an agent needs what happened in the last 1-7 days (companies, crypto, politics, sports, tech). Pass q (keywords). Returns deduplicated headlines with outlet, link, publish time and match score from the GDELT global news index, major outlets and Hacker News. ${perCall(NEWS_PRICE)}`,
      mimeType: "application/json",
      serviceName: "News Search & Headlines",
      tags: ["news search", "news headlines", "latest news", "crypto news", "breaking news"],
      iconUrl: ICON_URL,
      extensions: {
        ...declareDiscoveryExtension({
          input: { q: "bitcoin ETF" },
          inputSchema: {
            properties: {
              q: { type: "string", minLength: 2, maxLength: 200, description: "Keywords, e.g. 'bitcoin ETF', 'OpenAI', 'Federal Reserve rate cut'" },
              hours: { type: "integer", minimum: 1, maximum: 168, description: "Look-back window in hours (default 72, max 168)" },
              limit: { type: "integer", minimum: 1, maximum: 25, description: "Max articles (default 10, max 25)" },
            },
            required: ["q"],
          },
          output: {
            example: newsExample,
            schema: {
              properties: {
                query: { type: "string" },
                terms: strArr,
                hours: { type: "integer" },
                count: { type: "integer" },
                articles: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      title: { type: "string" },
                      url: { type: "string" },
                      source: { type: "string", description: "Outlet or domain" },
                      publishedAt: { type: ["string", "null"] },
                      provider: { type: "string", enum: ["gdelt", "hackernews", "rss"] },
                      score: { type: "number", description: "0-1 keyword match (IDF-weighted)" },
                      partialMatch: { type: "boolean", description: "true if not every keyword matched" },
                    },
                    required: ["title", "url", "source"],
                  },
                },
                outlets: strArr,
                providers: strArr,
                providerStatus: { type: "object" },
                latencyMs: { type: "integer" },
                generatedAt: { type: "string" },
              },
              required: ["query", "count", "articles"],
            },
          },
        }),
      },
    },
    "GET /price": {
      accepts: accept(TOKEN_PRICE),
      description:
        `Crypto token price: live USD price, 24h change, total supply and FDV for any token, read onchain from DEX pools (Uniswap v3 on Ethereum, Base, Arbitrum, Polygon; Orca, Raydium, PumpSwap on Solana), so every number is verifiable. Pass token (ETH, BTC, SOL, PEPE... or contract/mint address), optional chain. Returns price, change, pools, depth, spread, confidence, block. ${perCall(TOKEN_PRICE)}`,
      mimeType: "application/json",
      serviceName: "Crypto Token Price",
      tags: ["token price", "crypto price", "price change 24h", "onchain price", "fully diluted valuation"],
      iconUrl: ICON_URL,
      extensions: {
        ...declareDiscoveryExtension({
          input: { token: "ETH" },
          inputSchema: {
            properties: {
              token: { type: "string", minLength: 1, maxLength: 42, description: `Symbol (${PRICE_SYMBOLS.slice(0, 12).join(", ")}, ...) or ERC-20 contract address` },
              chain: { type: "string", enum: PRICE_CHAINS, description: "Chain for an address (default ethereum); symbols use their deepest chain" },
            },
            required: ["token"],
          },
          output: {
            example: priceExample,
            schema: {
              properties: {
                token: { type: "object", properties: { symbol: { type: ["string", "null"] }, name: { type: ["string", "null"] }, address: { type: "string" }, decimals: { type: "integer" }, chain: { type: "string" } } },
                priceUsd: { type: "number" },
                change24hPct: { type: ["number", "null"], description: "% change vs ~24 h ago (EVM: pool oracle or archive node; null on Solana)" },
                priceUsd24hAgo: { type: "number" },
                totalSupply: { type: "number", description: "Token total supply read from the contract / mint" },
                fdvUsd: { type: "number", description: "Fully diluted valuation = price x total supply (not circulating market cap)" },
                confidence: { type: "string", enum: ["high", "medium", "low"] },
                poolSpreadPct: { type: "number" },
                totalDepthUsd: { type: "number" },
                pools: { type: "array", items: { type: "object" } },
                block: { type: "object", properties: { number: { type: "integer" }, timestamp: { type: "string" } } },
                method: { type: "string" },
                generatedAt: { type: "string" },
              },
              required: ["token", "priceUsd", "pools", "block"],
            },
          },
        }),
      },
    },
    "GET /solana-price": {
      accepts: accept(SOL_PRICE),
      description:
        `Solana token price: live USD price of any SPL token or memecoin by symbol or mint, incl. pump.fun tokens, read onchain from Orca, Raydium CLMM, PumpSwap and pump.fun bonding curves (no third-party API). Pass token (SOL, JUP, BONK, WIF... or mint). Returns price, supply, FDV, pools with depth, spread, confidence, slot. ${perCall(SOL_PRICE)}`,
      mimeType: "application/json",
      serviceName: "Solana Token Price",
      tags: ["solana token price", "sol price", "spl token price", "pump.fun price", "memecoin price"],
      iconUrl: ICON_URL,
      extensions: {
        ...declareDiscoveryExtension({
          input: { token: "JUP" },
          inputSchema: {
            properties: { token: { type: "string", minLength: 1, maxLength: 44, description: `Symbol (${SOLANA_PRICE_SYMBOLS.slice(0, 10).join(", ")}, ...) or SPL mint address (incl. pump.fun mints)` } },
            required: ["token"],
          },
          output: {
            example: solPriceExample,
            schema: {
              properties: {
                token: { type: "object", properties: { symbol: { type: ["string", "null"] }, name: { type: ["string", "null"] }, mint: { type: "string" }, decimals: { type: "integer" }, chain: { type: "string" } } },
                priceUsd: { type: "number" },
                confidence: { type: "string", enum: ["high", "medium", "low"] },
                thinLiquidity: { type: "boolean" },
                totalSupply: { type: "number" },
                fdvUsd: { type: "number", description: "price x mint supply" },
                poolSpreadPct: { type: "number" },
                totalDepthUsd: { type: "number" },
                pools: { type: "array", items: { type: "object" } },
                solUsd: { type: "number" },
                slot: { type: "integer" },
                generatedAt: { type: "string" },
              },
              required: ["token", "priceUsd", "pools", "slot"],
            },
          },
        }),
      },
    },
    "GET /balance": {
      accepts: accept(BALANCE_PRICE),
      description:
        `Wallet balance: token balances and USD portfolio value for any wallet, read live onchain. EVM (Ethereum, Base, Arbitrum, Polygon in one call; ENS names work) or Solana (SOL + SPL tokens). Use to check a wallet before paying, trading or airdrops. Pass address, optional chain and tokens. Returns per-chain native + ERC-20/SPL balances, prices and total USD. ${perCall(BALANCE_PRICE)}`,
      mimeType: "application/json",
      serviceName: "Wallet Balance",
      tags: ["wallet balance", "erc20 balance", "token balances", "portfolio value", "solana wallet"],
      iconUrl: ICON_URL,
      extensions: {
        ...declareDiscoveryExtension({
          input: { address: "vitalik.eth" },
          inputSchema: {
            properties: {
              address: { type: "string", minLength: 3, maxLength: 64, description: "0x EVM address, ENS name (name.eth) or Solana address" },
              chain: { type: "string", enum: ["all", "ethereum", "base", "arbitrum", "polygon", "solana"], description: "EVM: one chain or all (default). Solana addresses are detected automatically" },
              tokens: { type: "string", description: "Optional extra token contracts (EVM, single chain) or SPL mints, comma-separated, max 20" },
            },
            required: ["address"],
          },
          output: {
            example: balanceExample,
            schema: {
              properties: {
                address: { type: "string" },
                ens: { type: "string" },
                chains: { type: "array", items: { type: "object", properties: { chain: { type: "string" }, native: { type: "object" }, tokens: { type: "array", items: { type: "object" } }, totalUsd: { type: "number" } } } },
                totalUsd: { type: "number" },
                generatedAt: { type: "string" },
              },
              required: ["address", "chains", "totalUsd"],
            },
          },
        }),
      },
    },
    "GET /tx": {
      accepts: accept(TX_PRICE),
      description:
        `Decode transaction: status, receipt and decoded token transfers for any tx hash or Solana signature, read onchain. EVM (auto-detects Ethereum, Base, Arbitrum, Polygon): success/reverted, block time, confirmations, from/to, method, fee in USD, every ERC-20/NFT transfer; flags x402 USDC payments. Solana: status, fee, SOL + token balance changes. Use to verify a payment landed. ${perCall(TX_PRICE)}`,
      mimeType: "application/json",
      serviceName: "Decode Transaction Receipt",
      tags: ["transaction receipt", "decode transaction", "tx status", "verify payment", "token transfers"],
      iconUrl: ICON_URL,
      extensions: {
        ...declareDiscoveryExtension({
          input: { hash: "0xa565aff51f0109d9a9c9028faa45338b3ebab49543fc25457e82326664ca8c52" },
          inputSchema: {
            properties: {
              hash: { type: "string", minLength: 64, maxLength: 90, description: "0x tx hash (EVM) or base58 transaction signature (Solana)" },
              chain: { type: "string", enum: ["ethereum", "base", "arbitrum", "polygon", "solana"], description: "Optional; EVM hashes are searched on all four chains when omitted" },
            },
            required: ["hash"],
          },
          output: {
            example: txExample,
            schema: {
              properties: {
                chain: { type: "string" },
                status: { type: "string", enum: ["success", "reverted", "failed", "pending"] },
                timestamp: { type: ["string", "null"] },
                from: { type: "string" },
                to: { type: ["string", "null"] },
                method: { type: "object" },
                fee: { type: "object" },
                tokenTransfers: { type: "array", items: { type: "object" } },
                tokenChanges: { type: "array", items: { type: "object" } },
                explorer: { type: "string" },
              },
              required: ["chain", "status", "explorer"],
            },
          },
        }),
      },
    },
    "GET /gas": {
      accepts: accept(GAS_PRICE),
      description:
        `Gas price: live gas fees for Ethereum, Base, Arbitrum, Polygon and Solana in one call. Use before sending a transaction to pick a fee or the cheapest chain. Returns base fee, slow/standard/fast priority fees, max fee, congestion, and the USD cost of a transfer, an ERC-20 transfer and a swap per chain, plus Solana priority fees. Optional chain. ${perCall(GAS_PRICE)}`,
      mimeType: "application/json",
      serviceName: "Gas Price",
      tags: ["gas price", "gas fees", "ethereum gas", "estimate gas", "solana priority fee"],
      iconUrl: ICON_URL,
      extensions: {
        ...declareDiscoveryExtension({
          input: { chain: "all" },
          inputSchema: {
            properties: { chain: { type: "string", enum: ["all", "ethereum", "base", "arbitrum", "polygon", "solana"], description: "One chain or all (default)" } },
          },
          output: {
            example: gasExample,
            schema: {
              properties: {
                chains: { type: "array", items: { type: "object", properties: { chain: { type: "string" }, baseFeeGwei: { type: "number" }, priorityFeeGwei: { type: "object" }, costStandard: { type: "object" } } } },
                cheapestEvmForErc20Transfer: { type: ["string", "null"] },
                generatedAt: { type: "string" },
              },
              required: ["chains"],
            },
          },
        }),
      },
    },
  };
  for (const [k, r] of Object.entries(routes)) if (r.description.length > 500) console.warn(`description too long (${r.description.length}) for ${k}`);

  // Facilitators: CDP first so it wins every network it supports (Bazaar indexing);
  // PayAI picks up the rest (Avalanche, Sei). First facilitator listing a network wins.
  const needPayai = NETWORKS.some((n) => NETWORK_INFO[n]!.facilitator === "payai");
  const facilitators = [
    createCdpFacilitatorClient({ apiKeyId: process.env.CDP_API_KEY_ID, apiKeySecret: process.env.CDP_API_KEY_SECRET }),
    ...(needPayai ? [new HTTPFacilitatorClient({ url: PAYAI_FACILITATOR_URL })] : []),
  ];
  const resourceServer = new x402ResourceServer(facilitators);
  for (const scheme of getCdpDefaultSchemes()) resourceServer.register(scheme.network as any, scheme.server as any);
  for (const ext of getCdpExtensionRegistrations()) resourceServer.registerExtension(ext as any);
  const hasEvm = NETWORKS.some((n) => NETWORK_INFO[n]!.family === "evm");
  const resolvedRoutes = Object.fromEntries(
    Object.entries(routes).map(([k, r]) => [k, { ...r, extensions: { ...(hasEvm ? CDP_SUPPORTED_EXTENSIONS : {}), ...r.extensions } }]),
  );
  const server = new x402HTTPResourceServer(resourceServer, resolvedRoutes as any);
  await server.initialize(); // fetches /supported from each facilitator and fails fast on an unsupported network
  const payToAddr = PAY_TO_EVM;
  const payToSolana = NETWORKS.some((n) => NETWORK_INFO[n]!.family === "svm") ? PAY_TO_SVM : null;
  app.use(paymentMiddlewareFromHTTPServer(server as any));

  // ---------- free discovery surface ----------
  const catalog = () =>
    (Object.keys(PAID) as PaidPath[]).map((p) => {
      const r = (routes as any)[`GET ${p}`];
      return {
        method: "GET",
        path: p,
        url: `${PUBLIC_URL}${p}`,
        price: PAID[p],
        priceUsd: parsePriceUsd(PAID[p]),
        network: NETWORKS[0],
        networks: NETWORKS,
        asset: "USDC",
        description: r.description,
        tags: r.tags,
        exampleInput: r.extensions.bazaar.info.input.queryParams,
      };
    });

  app.get("/health", (_req, res) => {
    res.json({
      ok: true,
      env: X402_ENV,
      networks: NETWORKS,
      prices: PAID,
      price: REPORT_PRICE,
      dailySpendCapUsd: DAILY_SPEND_CAP_USD,
      settledTodayUsd: sumSettledTodayUsd(),
      spentTodayUsd: sumSettledTodayUsd(),
      circuitOpen: circuitOpen(),
      sinceStart: { startedAt, ...counters },
      payToEvmAddress: payToAddr,
      payToSolanaAddress: payToSolana,
      facilitators: Object.fromEntries(NETWORKS.map((n) => [n, NETWORK_INFO[n]!.facilitator])),
      news: newsStatus(),
      traffic: { ...trafficStats(Object.keys(PAID), false), full: `${PUBLIC_URL}/stats` },
      memoryMb: Math.round(process.memoryUsage().rss / 1048576),
    });
  });

  // Free: one real example response per paid route (same data as the Bazaar output examples), so agents
  // and people can see exactly what they get before paying.
  app.get("/examples", (_req, res) => {
    const r = routes as any;
    res.set("Cache-Control", "public, max-age=3600").json({
      service: SERVICE_NAME,
      note: "Real responses captured Oct 6, 2026 for exactly the input shown (values change; long text and arrays trimmed so the 402 header stays small). Call any route without payment to get its 402 challenge.",
      examples: Object.keys(r).map((k) => ({
        route: k,
        url: `${PUBLIC_URL}${k.split(" ")[1]}`,
        priceUsd: Number(usd(PAID[k.split(" ")[1] as PaidPath])),
        serviceName: r[k].serviceName,
        input: r[k].extensions.bazaar.info.input.queryParams ?? null,
        output: r[k].extensions.bazaar.info.output.example,
      })),
    });
  });

  app.get("/a/:id", (req, res) => {
    const a = getAnswer(String(req.params.id));
    const json = req.query.format === "json" || req.accepts(["html", "json"]) === "json";
    res.set("Cache-Control", "public, max-age=300").vary("Accept");
    if (!a) {
      const msg = "Answer not found. Permalinks are kept in memory and reset when the server restarts or redeploys.";
      res.status(404);
      if (json) res.json({ error: "not_found", message: msg });
      else res.type("html").send(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><p style="font:17px system-ui;max-width:640px;margin:40px auto;padding:0 16px">${msg} <a href="${PUBLIC_URL}/">${SERVICE_NAME}</a></p>`);
      return;
    }
    if (json) res.json(a);
    else res.type("html").send(answerHtml(a, `${PUBLIC_URL}/llms.txt`, "Research Brief with Citations"));
  });

  app.get("/stats", (req, res) => {
    const data = { service: SERVICE_NAME, generatedAt: new Date().toISOString(), ...trafficStats(Object.keys(PAID), true) };
    res.set("Cache-Control", "no-store").vary("Accept");
    const wantsHtml = req.query.view === "simple" || (req.query.format !== "json" && req.accepts(["json", "html"]) === "html");
    if (wantsHtml) res.type("html").send(statsHtml(data as Parameters<typeof statsHtml>[0], Object.keys(PAID)));
    else res.json(data);
  });

  app.get("/", (req, res) => {
    if ((req.headers.accept ?? "").includes("text/html")) {
      res.type("text/plain").send(llmsTxt());
      return;
    }
    res.json({ name: SERVICE_NAME, description: `Pay-per-call research and onchain data tools for AI agents over x402 (${ON_NETWORKS}): cited research briefs, URL to markdown, news search, token prices (EVM + Solana), wallet balances, transaction lookup, gas prices, x402 endpoint checks.`, docs: `${PUBLIC_URL}/llms.txt`, openapi: `${PUBLIC_URL}/openapi.json`, resources: catalog() });
  });

  const llmsTxt = () =>
    [
      `# ${SERVICE_NAME} (x402)`,
      "",
      `> Pay-per-call research tools for autonomous AI agents. No API key, no signup: pay per request in ${ON_NETWORKS}`,
      `> (${NETWORKS.join(", ")}) with the x402 protocol (HTTP 402 + PAYMENT-REQUIRED / PAYMENT-SIGNATURE headers; CDP facilitator, PayAI for Avalanche/Sei).`,
      `> Pay to: ${payToAddr} (EVM chains)${payToSolana ? `, ${payToSolana} (Solana)` : ""}. ${ERRORS_DOC}`,
      "",
      "## Paid endpoints",
      `- GET ${PUBLIC_URL}/report?q=<question or topic>  (${REPORT_PRICE}) — research brief with citations / web research / topic summary: summary, cited bullets, sources from official docs, Wikipedia, Stack Overflow, GitHub, HN-linked articles, Crossref (off-topic sources dropped), Wikipedia summary card, confidence, suggested follow-up calls. Optional depth=quick|standard, lang=en.`,
      `- GET ${PUBLIC_URL}/read?url=<https url>  (${READ_PRICE}) — web page to clean LLM-ready markdown with title, description, publish date, headings, links. Optional maxChars (default 20000).`,
      `- GET ${PUBLIC_URL}/check?url=<https x402 endpoint>  (${CHECK_PRICE}) — x402 endpoint check + Bazaar listing audit: one unpaid probe, score, grade, prioritized fixes, Coinbase validator verdict, live Bazaar listing (30-day calls/payers, stale metadata) and search rank for its own name and tags. Optional method=GET|POST.`,
      `- GET ${PUBLIC_URL}/news?q=<keywords>  (${NEWS_PRICE}) — news search: recent headlines (outlet, link, publish time, match score) from the GDELT global news index (15-min updates), major publisher feeds and Hacker News. Optional hours=1-168 (default 72), limit=1-25 (default 10). Headlines + links only; use /read for full text.`,
      `- GET ${PUBLIC_URL}/price?token=<symbol|address>  (${TOKEN_PRICE}) — crypto token price read onchain: USD price + 24h change + total supply + FDV from Uniswap v3 pools (ethereum, base, arbitrum, polygon) or Orca/Raydium/PumpSwap (solana): pools, depth, cross-pool spread, confidence, block. Optional chain=. Pools under $25k depth -> 422 (not charged).`,
      `- GET ${PUBLIC_URL}/solana-price?token=<symbol|mint>  (${SOL_PRICE}) — Solana token price by symbol or SPL mint from Orca Whirlpool, Raydium CLMM, PumpSwap and pump.fun bonding curves (public RPC): price, pools, depth, spread, confidence, slot. Pools under $5k depth -> 422; under $25k flagged thinLiquidity.`,
      `- GET ${PUBLIC_URL}/balance?address=<0x|name.eth|solana address>  (${BALANCE_PRICE}) — wallet balance: native + major tokens with USD values on ethereum, base, arbitrum, polygon (all in one call) or Solana. Optional chain=, tokens=<comma-separated contracts or mints>.`,
      `- GET ${PUBLIC_URL}/tx?hash=<0x hash|solana signature>  (${TX_PRICE}) — transaction lookup: status, block time, from/to, method, fee in USD, decoded token transfers (EVM chains auto-detected) or SOL/token balance changes (Solana). Optional chain=.`,
      `- GET ${PUBLIC_URL}/gas  (${GAS_PRICE}) — gas price tracker: base fee, slow/standard/fast priority fees, USD cost of a transfer, ERC-20 transfer and swap on ethereum, base, arbitrum, polygon + Solana priority fees. Optional chain=.`,
      "",
      "## How to pay",
      `1. Call the endpoint without payment -> HTTP 402 with base64 JSON in the PAYMENT-REQUIRED header (x402Version 2, scheme exact; one accepts entry per network: ${NETWORKS.map((n) => `${NETWORK_INFO[n]!.name} USDC ${NETWORK_INFO[n]!.usdc}`).join("; ")}).`,
      "2. Pick one accepts entry. EVM: sign an EIP-3009 USDC authorization for `amount` (atomic units, 6 decimals) to `payTo`. Solana: partially sign a USDC TransferChecked (facilitator is fee payer). Retry with the PAYMENT-SIGNATURE header.",
      "3. Response 200 + JSON body + PAYMENT-RESPONSE header (settlement tx). Any x402 client works: @x402/fetch, @x402/axios, x402 Python, Coinbase Agentic Wallet / CDP MCP.",
      "",
      "## Free",
      `- ${PUBLIC_URL}/examples — one real sample response per paid route`,
      `- ${PUBLIC_URL}/stats — traffic: unpaid 402s, paid calls and unique visitors per route (bots and crawlers split out)`,
      `- ${PUBLIC_URL}/openapi.json — OpenAPI 3.1 with x-payment-info`,
      `- ${PUBLIC_URL}/.well-known/x402 — x402 discovery document`,
      `- ${PUBLIC_URL}/health — status`,
      "",
      "## Example",
      `curl -i "${PUBLIC_URL}/report?q=history+of+the+transistor"   # 402 challenge`,
      "",
    ].join("\n");

  app.get("/llms.txt", (_req, res) => res.type("text/plain").send(llmsTxt()));

  app.get("/robots.txt", (_req, res) => {
    res.type("text/plain").send(["User-agent: *", "Allow: /", "Disallow: /report", "Disallow: /read", "Disallow: /check", "Disallow: /news", "Disallow: /price", "Disallow: /solana-price", "Disallow: /balance", "Disallow: /tx", "Disallow: /gas", `Sitemap: ${PUBLIC_URL}/openapi.json`, ""].join("\n"));
  });

  const ICON_PNG = (() => { try { return fs.readFileSync(path.join(__dirname, "assets", "icon.png")); } catch { return null; } })();
  app.get("/icon.png", (_req, res) => {
    if (!ICON_PNG) return res.redirect(302, "/icon.svg");
    res.type("image/png").set("Cache-Control", "public, max-age=86400").send(ICON_PNG);
  });

  app.get("/icon.svg", (_req, res) => {
    res.type("image/svg+xml").set("Cache-Control", "public, max-age=86400").send(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#0052FF"/><circle cx="28" cy="28" r="13" fill="none" stroke="#fff" stroke-width="5"/><path d="M38 38l12 12" stroke="#fff" stroke-width="6" stroke-linecap="round"/></svg>',
    );
  });

  // x402scan-style discovery doc (compat) + richer legacy JSON
  const wellKnown = () => ({
    version: 1,
    name: SERVICE_NAME,
    description: `Pay-per-call research and onchain data tools for AI agents: cited research briefs, URL to markdown, news search, token prices (EVM + Solana), wallet balances, transaction lookup, gas prices, x402 endpoint checks. ${ON_NETWORKS} via x402.`,
    resources: catalog().map((c) => c.url),
    items: catalog(),
    network: NETWORKS[0],
    networks: NETWORKS,
    payTo: payToAddr,
    payToSolana,
    openapi: `${PUBLIC_URL}/openapi.json`,
    llms: `${PUBLIC_URL}/llms.txt`,
    free: ["/health", "/stats", "/examples", "/a/<id>", "/llms.txt", "/openapi.json", "/.well-known/x402", "/robots.txt"],
  });
  // 402 Index domain verification (public SHA-256 hash of the claim token, not the token itself)
  app.get("/.well-known/402index-verify.txt", (_req, res) =>
    res.type("text/plain").send(process.env.INDEX402_VERIFY_HASH ?? "95632cdce38229948423be81cdaefe38e617bdffe5177f3ff38d3439ff63ee65"),
  );
  app.get("/.well-known/x402", (_req, res) => res.json(wellKnown()));
  app.get("/.well-known/x402.json", (_req, res) => res.json(wellKnown()));

  app.get("/openapi.json", (_req, res) => {
    const qp = (name: string, schema: any, required: boolean, description: string) => ({ name, in: "query", required, description, schema });
    const errs = {
      "400": { description: "Missing or invalid input (not charged)" },
      "402": { description: "Payment required: x402 v2 challenge in PAYMENT-REQUIRED header" },
      "422": { description: "Nothing usable found / target unreachable (not charged)" },
      "503": { description: "Temporarily unavailable (not charged)" },
    };
    const pay = (price: string) => ({
      "x-payment-info": {
        protocols: NETWORKS.map((network) => ({ x402: { version: 2, scheme: "exact", network, asset: NETWORK_INFO[network]!.usdc, payTo: payToFor(network) } })),
        price: { mode: "fixed", currency: "USD", amount: usd(price) },
      },
    });
    const r = routes as any;
    res.json({
      openapi: "3.1.0",
      info: {
        title: SERVICE_NAME,
        version: "2.0.0",
        description: `Pay-per-call research and onchain data tools for AI agents over x402 (${ON_NETWORKS}). ` + ERRORS_DOC,
        "x-guidance":
          "Use /report for a cited answer to a question, /read to turn a known URL into markdown, /news for recent headlines on a topic, /price or /solana-price for a verifiable onchain token price (+24h change on EVM), /balance for wallet holdings, /tx to check or decode a transaction, /gas for current fees, /check to validate an x402 endpoint. Call without payment to get the 402 challenge, then retry with PAYMENT-SIGNATURE.",
      },
      servers: [{ url: PUBLIC_URL }],
      paths: {
        "/health": { get: { operationId: "health", summary: "Service status (free)", security: [], responses: { "200": { description: "Status JSON" } } } },
        "/llms.txt": { get: { operationId: "llmsTxt", summary: "Agent-readable usage guide (free)", security: [], responses: { "200": { description: "text/plain" } } } },
        "/report": {
          get: {
            operationId: "researchBrief",
            summary: "Research brief with citations",
            description: r["GET /report"].description,
            tags: ["Research"],
            parameters: [
              qp("q", { type: "string", minLength: 2, maxLength: 300 }, true, "Research question or topic"),
              qp("depth", { type: "string", enum: ["quick", "standard"] }, false, "quick or standard (default)"),
              qp("lang", { type: "string" }, false, "Wikipedia language code (default en)"),
            ],
            ...pay(REPORT_PRICE),
            responses: { "200": { description: "Research brief", content: { "application/json": { schema: r["GET /report"].extensions.bazaar.schema.properties.output.properties.example, example: reportExample } } }, ...errs },
          },
        },
        "/read": {
          get: {
            operationId: "readPage",
            summary: "Web page to clean markdown",
            description: r["GET /read"].description,
            tags: ["Web"],
            parameters: [qp("url", { type: "string", format: "uri" }, true, "Public https URL"), qp("maxChars", { type: "integer", minimum: 1000, maximum: 100000 }, false, "Max markdown chars (default 20000)")],
            ...pay(READ_PRICE),
            responses: { "200": { description: "Page content", content: { "application/json": { schema: r["GET /read"].extensions.bazaar.schema.properties.output.properties.example, example: readExample } } }, ...errs },
          },
        },
        "/check": {
          get: {
            operationId: "checkX402Endpoint",
            summary: "x402 endpoint readiness + Bazaar ranking check",
            description: r["GET /check"].description,
            tags: ["Developer"],
            parameters: [qp("url", { type: "string", format: "uri" }, true, "x402 endpoint URL"), qp("method", { type: "string", enum: ["GET", "POST"] }, false, "Probe method")],
            ...pay(CHECK_PRICE),
            responses: { "200": { description: "Score and fixes", content: { "application/json": { schema: r["GET /check"].extensions.bazaar.schema.properties.output.properties.example, example: checkExample } } }, ...errs },
          },
        },
        "/news": {
          get: {
            operationId: "newsSearch",
            summary: "Recent news headlines on a topic",
            description: r["GET /news"].description,
            tags: ["News"],
            parameters: [
              qp("q", { type: "string", minLength: 2, maxLength: 200 }, true, "Keywords"),
              qp("hours", { type: "integer", minimum: 1, maximum: 168 }, false, "Look-back window in hours (default 72)"),
              qp("limit", { type: "integer", minimum: 1, maximum: 25 }, false, "Max articles (default 10)"),
            ],
            ...pay(NEWS_PRICE),
            responses: { "200": { description: "Headlines", content: { "application/json": { schema: r["GET /news"].extensions.bazaar.schema.properties.output.properties.example, example: newsExample } } }, ...errs },
          },
        },
        "/price": {
          get: {
            operationId: "tokenPrice",
            summary: "Token price + 24h change, read onchain (EVM Uniswap v3, Solana DEXs)",
            description: r["GET /price"].description,
            tags: ["Crypto"],
            parameters: [
              qp("token", { type: "string", minLength: 1, maxLength: 44 }, true, "Symbol, ERC-20 address or Solana mint"),
              qp("chain", { type: "string", enum: PRICE_CHAINS }, false, "Chain for an address (default ethereum; mints use solana)"),
            ],
            ...pay(TOKEN_PRICE),
            responses: { "200": { description: "Price with pool evidence", content: { "application/json": { schema: r["GET /price"].extensions.bazaar.schema.properties.output.properties.example, example: priceExample } } }, ...errs },
          },
        },
        "/solana-price": {
          get: {
            operationId: "solanaTokenPrice",
            summary: "Solana token price by symbol or mint (Orca, Raydium, PumpSwap, pump.fun)",
            description: r["GET /solana-price"].description,
            tags: ["Crypto"],
            parameters: [qp("token", { type: "string", minLength: 1, maxLength: 44 }, true, "Symbol (SOL, JUP, BONK...) or SPL mint address")],
            ...pay(SOL_PRICE),
            responses: { "200": { description: "Price with pool evidence", content: { "application/json": { schema: r["GET /solana-price"].extensions.bazaar.schema.properties.output.properties.example, example: solPriceExample } } }, ...errs },
          },
        },
        "/balance": {
          get: {
            operationId: "walletBalance",
            summary: "Wallet balances with USD values (EVM chains or Solana)",
            description: r["GET /balance"].description,
            tags: ["Crypto"],
            parameters: [
              qp("address", { type: "string", minLength: 3, maxLength: 64 }, true, "0x address, ENS name or Solana address"),
              qp("chain", { type: "string", enum: ["all", "ethereum", "base", "arbitrum", "polygon", "solana"] }, false, "Default all EVM chains"),
              qp("tokens", { type: "string" }, false, "Extra token contracts or mints, comma-separated (max 20)"),
            ],
            ...pay(BALANCE_PRICE),
            responses: { "200": { description: "Balances", content: { "application/json": { schema: r["GET /balance"].extensions.bazaar.schema.properties.output.properties.example, example: balanceExample } } }, ...errs },
          },
        },
        "/tx": {
          get: {
            operationId: "transactionLookup",
            summary: "Transaction status + decoded token transfers (EVM or Solana)",
            description: r["GET /tx"].description,
            tags: ["Crypto"],
            parameters: [
              qp("hash", { type: "string", minLength: 64, maxLength: 90 }, true, "0x tx hash or Solana signature"),
              qp("chain", { type: "string", enum: ["ethereum", "base", "arbitrum", "polygon", "solana"] }, false, "Optional; auto-detected"),
            ],
            ...pay(TX_PRICE),
            responses: { "200": { description: "Transaction", content: { "application/json": { schema: r["GET /tx"].extensions.bazaar.schema.properties.output.properties.example, example: txExample } } }, ...errs },
          },
        },
        "/gas": {
          get: {
            operationId: "gasPrice",
            summary: "Live gas / priority fees with USD cost per transaction type",
            description: r["GET /gas"].description,
            tags: ["Crypto"],
            parameters: [qp("chain", { type: "string", enum: ["all", "ethereum", "base", "arbitrum", "polygon", "solana"] }, false, "Default all")],
            ...pay(GAS_PRICE),
            responses: { "200": { description: "Fees", content: { "application/json": { schema: r["GET /gas"].extensions.bazaar.schema.properties.output.properties.example, example: gasExample } } }, ...errs },
          },
        },
      },
    });
  });

  // ---------- paid handlers (only reached after a verified payment) ----------
  app.get("/report", async (req, res) => {
    res.locals.paidHandlerRan = true;
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    if (q.length < 2 || q.length > 300) {
      res.status(400).json({ error: "bad_input", message: "q is required (2-300 chars). You were not charged." });
      return;
    }
    const body = await researchBrief(q, { lang: String(req.query.lang ?? "en"), depth: req.query.depth === "quick" ? "quick" : "standard" });
    if (!body) {
      res.status(422).json({ error: "no_sources", message: "No sources found for this query; try rephrasing. You were not charged." });
      return;
    }
    // Shareable permalink (free page). Removed again if the payment does not settle.
    const id = newAnswerId();
    const out = { ...body, permalink: `${PUBLIC_URL}/a/${id}` };
    saveAnswer(id, out);
    res.on("finish", () => { if (!decodeB64Json(res.getHeader("payment-response"))?.success) deleteAnswer(id); });
    res.json(out);
  });

  app.get("/read", async (req, res) => {
    res.locals.paidHandlerRan = true;
    const url = typeof req.query.url === "string" ? req.query.url.trim() : "";
    const maxChars = Math.min(100_000, Math.max(1000, Number(req.query.maxChars ?? 20_000) || 20_000));
    if (!url) {
      res.status(400).json({ error: "bad_input", message: "url is required (https). You were not charged." });
      return;
    }
    try {
      const out = await readPage(url, maxChars);
      if ("error" in out) {
        res.status(422).json({ ...out, message: `${(out as any).message ?? "Page could not be read"}. You were not charged.` });
        return;
      }
      res.json(out);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (err instanceof InputError) res.status(400).json({ error: "bad_input", message: `${msg}. You were not charged.` });
      else res.status(422).json({ error: "read_failed", message: `Could not fetch the page (${/timeout|abort/i.test(msg) ? "timed out after 12 s" : msg}); retry or try another URL. You were not charged.` });
    }
  });

  app.get("/check", async (req, res) => {
    res.locals.paidHandlerRan = true;
    const target = typeof req.query.url === "string" ? req.query.url.trim() : "";
    const method = req.query.method === "POST" ? "POST" : "GET";
    if (!target) {
      res.status(400).json({ error: "bad_input", message: "url is required (https). You were not charged." });
      return;
    }
    try {
      res.json(await checkX402Endpoint(target, method));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(err instanceof InputError ? 400 : 422).json({ error: err instanceof InputError ? "bad_input" : "check_failed", message: `${msg}. You were not charged.` });
    }
  });

  app.get("/news", async (req, res) => {
    res.locals.paidHandlerRan = true;
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    if (q.length < 2 || q.length > 200) {
      res.status(400).json({ error: "bad_input", message: "q is required (2-200 chars). You were not charged." });
      return;
    }
    const num = (v: unknown) => (v === undefined || v === "" ? undefined : Number(v));
    try {
      const out: any = await newsSearch(q, { hours: num(req.query.hours), limit: num(req.query.limit) });
      if (out.error === "no_search_terms") {
        res.status(400).json({ ...out, message: "q has no searchable keywords. You were not charged." });
        return;
      }
      if (out.error) {
        res.status(422).json({ ...out, message: "No matching headlines in the window; try broader keywords or more hours. You were not charged." });
        return;
      }
      res.json(out);
    } catch (err) {
      res.status(503).json({ error: "news_unavailable", message: `${err instanceof Error ? err.message : String(err)}. You were not charged.` });
    }
  });

  app.get("/price", async (req, res) => {
    res.locals.paidHandlerRan = true;
    const token = typeof req.query.token === "string" ? req.query.token.trim() : "";
    if (!token || token.length > 44) {
      res.status(400).json({ error: "bad_input", message: "token is required (symbol like ETH, an 0x ERC-20 address or a Solana mint). You were not charged." });
      return;
    }
    try {
      const out: any = await tokenPrice(token, typeof req.query.chain === "string" ? req.query.chain : undefined);
      if (out.error) {
        res.status(422).json({ ...out, message: `${out.message}. You were not charged.` });
        return;
      }
      res.json(out);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (err instanceof PriceInputError || err instanceof SolanaInputError) res.status(400).json({ error: "bad_input", message: `${msg}. You were not charged.` });
      else res.status(503).json({ error: "rpc_unavailable", message: "Public RPC nodes did not answer; retry shortly. You were not charged." });
    }
  });

  /** Shared handler shape: input errors -> 400, { error } results -> 422, anything else -> 503. Never charged on non-2xx. */
  const onchainHandler =
    (run: (req: Request) => Promise<any>, inputErrors: Array<new (...a: any[]) => Error>, unavailable: string) =>
    async (req: Request, res: Response) => {
      res.locals.paidHandlerRan = true;
      try {
        const out = await run(req);
        if (out?.error) {
          res.status(422).json({ ...out, message: `${out.message ?? out.error}. You were not charged.` });
          return;
        }
        res.json(out);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (inputErrors.some((E) => err instanceof E)) res.status(400).json({ error: "bad_input", message: `${msg}. You were not charged.` });
        else {
          console.warn(`[${req.path}] ${msg.slice(0, 200)}`);
          res.status(503).json({ error: "rpc_unavailable", message: `${unavailable}; retry shortly. You were not charged.` });
        }
      }
    };
  const qs = (v: unknown) => (typeof v === "string" ? v.trim() : "");

  app.get(
    "/solana-price",
    onchainHandler(
      async (req) => {
        const token = qs(req.query.token);
        if (!token || token.length > 44) throw new SolanaInputError("token is required (symbol like SOL/JUP/BONK or an SPL mint address)");
        return solanaTokenPrice(token);
      },
      [SolanaInputError],
      "Public Solana RPC nodes did not answer",
    ),
  );
  app.get(
    "/balance",
    onchainHandler(
      async (req) => {
        const address = qs(req.query.address);
        if (!address || address.length > 64) throw new WalletInputError("address is required (0x address, ENS name or Solana address)");
        return walletBalances(address, { chain: qs(req.query.chain) || undefined, tokens: qs(req.query.tokens) || undefined });
      },
      [WalletInputError],
      "Public RPC nodes did not answer",
    ),
  );
  app.get(
    "/tx",
    onchainHandler(
      async (req) => {
        const hash = qs(req.query.hash);
        if (!hash || hash.length > 100) throw new TxInputError("hash is required (0x transaction hash or Solana signature)");
        return txLookup(hash, qs(req.query.chain) || undefined);
      },
      [TxInputError],
      "Public RPC nodes did not answer",
    ),
  );
  app.get(
    "/gas",
    onchainHandler(async (req) => gasNow(qs(req.query.chain) || undefined), [GasInputError], "Public RPC nodes did not answer"),
  );

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const message = err instanceof Error ? err.message : String(err);
    appendPaymentLog({ type: "error", kind: "express_error", message });
    if (!res.headersSent) res.status(502).json({ error: "payment_or_server_error", message });
  });

  app.listen(PORT, "0.0.0.0", () => {
    startTraffic();
    warmNews();
    console.log(`x402 seller listening on http://localhost:${PORT}  env=${X402_ENV} networks=${NETWORKS.join(",")} (${NETWORK_LABEL})`);
    console.log(`  paid: /report ${REPORT_PRICE}, /read ${READ_PRICE}, /check ${CHECK_PRICE}, /news ${NEWS_PRICE}, /price ${TOKEN_PRICE}, /solana-price ${SOL_PRICE}, /balance ${BALANCE_PRICE}, /tx ${TX_PRICE}, /gas ${GAS_PRICE}; payTo=${payToAddr}${payToSolana ? ` solana=${payToSolana}` : ""}`);
  });
}

main().catch((err) => {
  console.error("Failed to start x402 seller:", err);
  process.exit(1);
});
