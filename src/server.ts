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
const ICON_URL = `${PUBLIC_URL}/icon.svg`;

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

  const reportExample = {
    query: "What is retrieval-augmented generation?",
    summary:
      "Retrieval-augmented generation (RAG) is a technique that lets large language models retrieve and incorporate new information from external sources before answering. [1]",
    bullets: [
      "The term retrieval-augmented generation (RAG) was introduced in a 2020 paper that described combining a parametric language model with a non-parametric external memory accessed through retrieval at inference time. [1]",
      "Retrieval-augmented generation is a technique for enhancing the accuracy and reliability of generative AI models with information fetched from specific and relevant data sources. [2]",
    ],
    sources: [
      {
        id: 1,
        type: "encyclopedia",
        provider: "wikipedia",
        title: "Retrieval-augmented generation",
        url: "https://en.wikipedia.org/wiki/Retrieval-augmented_generation",
        snippet: "Retrieval-augmented generation (RAG) is a technique that enables large language models to retrieve and incorporate new information...",
        publishedAt: "2026-09-20T10:00:00Z",
      },
    ],
    sourceCount: 3,
    providers: ["wikipedia", "hackernews"],
    method: "extractive",
    depth: "standard",
    lang: "en",
    latencyMs: 1450,
    generatedAt: "2026-10-03T18:00:00.000Z",
  };

  const readExample = {
    url: "https://example.com/blog/post",
    finalUrl: "https://example.com/blog/post",
    status: 200,
    contentType: "text/html; charset=utf-8",
    title: "Example post title",
    description: "Meta description of the page.",
    lang: "en",
    publishedAt: "2026-09-30T12:00:00Z",
    markdown: "# Example post title\n\nFirst paragraph of the article as clean markdown with [links](https://example.com/x).",
    wordCount: 812,
    truncated: false,
    headings: [{ level: 1, text: "Example post title" }],
    links: [{ text: "links", url: "https://example.com/x" }],
    fetchMs: 420,
    fetchedAt: "2026-10-03T18:00:00.000Z",
  };

  const checkExample = {
    target: "https://api.example.com/paid",
    method: "GET",
    score: 82,
    passed: 14,
    total: 17,
    indexable: true,
    priceUsdIfUsdc: 0.01,
    network: "eip155:8453",
    latencyMs: 180,
    checks: [{ id: "status_402", pass: true, severity: "required", detail: "HTTP 402 (unpaid probe must return 402)" }],
    fixes: ["tags_set: missing (resource.tags, up to 5)"],
    checkedAt: "2026-10-03T18:00:00.000Z",
    note: "One unpaid probe; this service never pays the target.",
  };

  const newsExample = {
    query: "bitcoin ETF",
    terms: ["bitcoin", "etf"],
    hours: 72,
    count: 2,
    articles: [
      { title: "Bitcoin ETFs kick off 'Uptober' with $103M inflow", url: "https://cointelegraph.com/news/example", source: "Cointelegraph", publishedAt: "2026-10-02T08:20:00.000Z", provider: "rss", score: 1 },
      { title: "Spot bitcoin ETFs log $2.7 billion in September inflows", url: "https://www.theblock.co/post/example", source: "The Block", publishedAt: "2026-10-02T05:50:00.000Z", provider: "rss", score: 1 },
    ],
    outlets: ["Cointelegraph", "The Block"],
    providers: ["rss"],
    providerStatus: { gdelt: "ok", hackernews: 0, rssFeeds: "25/26" },
    note: "Headlines and links only; open the url (or use /read) for full text.",
    latencyMs: 410,
    generatedAt: "2026-10-03T18:00:00.000Z",
  };

  const priceExample = {
    token: { symbol: "WETH", name: "Wrapped Ether", address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", decimals: 18, chain: "ethereum" },
    priceUsd: 2690.6431,
    change24hPct: 1.45,
    priceUsd24hAgo: 2652.18,
    change24h: { pool: "0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640", at: "2026-10-02T18:00:11.000Z", method: "archive slot0 at block 26116021" },
    confidence: "high",
    poolSpreadPct: 0.54,
    totalDepthUsd: 330722389,
    pools: [{ dex: "uniswap-v3", pool: "0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640", feeTier: 500, quote: "USDC", priceUsd: 2690.12, depthUsd: 120000000, explorer: "https://etherscan.io/address/0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640" }],
    block: { number: 23500000, timestamp: "2026-10-03T18:00:00.000Z" },
    method: "Uniswap v3 spot price (slot0) from public RPC; depth-weighted across pools within 3% of the deepest; USDC/USDT treated as $1",
    note: "priced as WETH",
    cached: false,
    latencyMs: 470,
    generatedAt: "2026-10-03T18:00:00.000Z",
  };

  const solPriceExample = {
    token: { symbol: "JUP", name: "Jupiter", mint: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN", decimals: 6, chain: "solana" },
    priceUsd: 0.331471,
    confidence: "medium",
    poolSpreadPct: 0.49,
    outlierPools: 0,
    totalDepthUsd: 814354,
    pools: [{ dex: "orca-whirlpool", pool: "C1MgLojNLWBKADvu9BHdtgzz1oZX4dZ5zGdGcgvvW8Wz", quote: "SOL", priceUsd: 0.33162, depthUsd: 512000, explorer: "https://solscan.io/account/C1MgLojNLWBKADvu9BHdtgzz1oZX4dZ5zGdGcgvvW8Wz" }],
    change24hPct: null,
    solUsd: 121.2119,
    slot: 453447029,
    method: "Orca Whirlpool + Raydium CLMM sqrt_price, PumpSwap reserves and pump.fun bonding curves read from public Solana RPC",
    cached: false,
    latencyMs: 440,
    generatedAt: "2026-10-05T02:30:00.000Z",
  };
  const balanceExample = {
    address: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
    ens: "vitalik.eth",
    chains: [
      {
        chain: "ethereum",
        block: 26123221,
        native: { symbol: "ETH", balance: 5.749318263, priceUsd: 2731.4, usd: 15703.67 },
        tokens: [{ symbol: "WETH", address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", balance: 1.465109425, priceUsd: 2731.4, usd: 4001.8 }],
        totalUsd: 20072.13,
      },
    ],
    totalUsd: 33703.46,
    generatedAt: "2026-10-05T02:30:00.000Z",
  };
  const txExample = {
    chain: "base",
    status: "success",
    hash: "0xa565aff51f0109d9a9c9028faa45338b3ebab49543fc25457e82326664ca8c52",
    blockNumber: 52088549,
    timestamp: "2026-10-02T18:40:45.000Z",
    from: "0x8F5cB67B49555E614892b7233CFdDEBFB746E531",
    to: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    method: { selector: "0xe3ee160e", name: "transferWithAuthorization (EIP-3009, used by x402 USDC payments)" },
    fee: { amount: 6.346e-7, symbol: "ETH", usd: 0.0017 },
    tokenTransfers: [{ token: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", symbol: "USDC", standard: "erc20", from: "0x4C29Ec4F680CA88d0019edBfe3A8FF5c80499494", to: "0x079471E6F43b6feeF80895E19cBFcBB496904852", amount: 0.01 }],
    explorer: "https://basescan.org/tx/0xa565aff51f0109d9a9c9028faa45338b3ebab49543fc25457e82326664ca8c52",
  };
  const gasExample = {
    chains: [
      { chain: "ethereum", block: 26123258, baseFeeGwei: 0.0714, priorityFeeGwei: { slow: 0.00001, standard: 0.0109, fast: 1 }, nativeUsd: 2732.59, costStandard: { nativeTransfer: { native: 0.0000017, usd: 0.0047 }, erc20Transfer: { native: 0.0000054, usd: 0.0146 }, swap: { native: 0.0000148, usd: 0.0405 } } },
      { chain: "solana", slot: 453448050, baseFeeLamportsPerSignature: 5000, priorityFeeMicroLamportsPerCu: { slow: 0, standard: 796, fast: 2936 }, nativeUsd: 121.4 },
    ],
    cheapestEvmForErc20Transfer: "base",
    generatedAt: "2026-10-05T02:30:00.000Z",
  };

  const strArr = { type: "array", items: { type: "string" } };
  const routes = {
    "GET /report": {
      accepts: accept(REPORT_PRICE),
      description:
        `Research brief with citations: a quick, sourced answer to any question or topic. Use before writing, deciding, or searching deeper. Pass q (question). Returns a summary, 3-6 cited bullets and sources (official docs, Wikipedia, Stack Overflow, GitHub, papers) with URLs and dates; off-topic sources dropped. ${usd(REPORT_PRICE)} ${ON_NETWORKS_SHORT}. ${ERRORS_DOC}`,
      mimeType: "application/json",
      serviceName: "Research Brief with Citations",
      tags: ["research brief", "web research", "answer with sources", "citations", "summarize topic"],
      iconUrl: ICON_URL,
      extensions: {
        ...declareDiscoveryExtension({
          input: { q: "What is retrieval-augmented generation?" },
          inputSchema: {
            properties: {
              q: { type: "string", minLength: 2, maxLength: 300, description: "Natural-language research question or topic, e.g. 'history of the transistor' or 'pros and cons of RAG'" },
              depth: { type: "string", enum: ["quick", "standard"], description: "quick = encyclopedia + instant answer only (faster); standard (default) adds official docs, Stack Overflow, GitHub, articles linked from Hacker News, and scholarly papers" },
              lang: { type: "string", pattern: "^[a-z]{2,3}$", description: "Wikipedia language code, default en" },
            },
            required: ["q"],
          },
          output: {
            example: reportExample,
            schema: {
              properties: {
                query: { type: "string" },
                summary: { type: "string", description: "2-4 sentence answer with [n] citations" },
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
                    },
                    required: ["id", "title", "url"],
                  },
                },
                sourceCount: { type: "integer" },
                providers: strArr,
                method: { type: "string", description: "extractive or llm-synthesis:<model>" },
                depth: { type: "string" },
                lang: { type: "string" },
                latencyMs: { type: "integer" },
                generatedAt: { type: "string" },
              },
              required: ["query", "summary", "bullets", "sources"],
            },
          },
        }),
      },
    },
    "GET /read": {
      accepts: accept(READ_PRICE),
      description:
        `URL to markdown: read any public web page as clean, LLM-ready markdown. Use when an agent has a URL (article, docs, blog, product page) and needs its text without HTML, scripts or nav clutter. Pass url (https). Returns title, description, publish date, markdown, word count, headings and links. ${usd(READ_PRICE)} ${ON_NETWORKS_SHORT}. ${ERRORS_DOC}`,
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
        `x402 endpoint readiness and Bazaar ranking check. Use before paying for or listing an x402 API. Makes one unpaid probe (never pays the target) and grades the 402 challenge: PAYMENT-REQUIRED header, accepts, amount, payTo, network, description, mimeType, serviceName, tags, bazaar schemas and examples, latency. Returns a score and fixes. ${usd(CHECK_PRICE)} ${ON_NETWORKS_SHORT}. ${ERRORS_DOC}`,
      mimeType: "application/json",
      serviceName: "x402 Endpoint Checker",
      tags: ["x402 endpoint check", "validate x402 endpoint", "x402", "bazaar listing", "api testing"],
      iconUrl: ICON_URL,
      extensions: {
        ...declareDiscoveryExtension({
          input: { url: "https://x402-seller-pmlm.onrender.com/report" },
          inputSchema: {
            properties: {
              url: { type: "string", description: "Public https URL of an x402-protected endpoint" },
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
                passed: { type: "integer" },
                total: { type: "integer" },
                indexable: { type: "boolean" },
                priceUsdIfUsdc: { type: ["number", "null"] },
                network: { type: ["string", "null"] },
                latencyMs: { type: "integer" },
                checks: { type: "array", items: { type: "object" } },
                fixes: strArr,
                checkedAt: { type: "string" },
              },
              required: ["target", "score", "checks", "fixes"],
            },
          },
        }),
      },
    },
    "GET /news": {
      accepts: accept(NEWS_PRICE),
      description:
        `News search: recent headlines on any topic from 1,000s of outlets. Use when an agent needs what happened in the last 1-7 days. Pass q (keywords). Returns deduplicated headlines with outlet, link, publish time and match score, from the GDELT global news index, major-outlet feeds and Hacker News. ${usd(NEWS_PRICE)} ${ON_NETWORKS_SHORT}. ${ERRORS_DOC}`,
      mimeType: "application/json",
      serviceName: "News Search",
      tags: ["news search", "news headlines", "crypto news", "current events", "breaking news"],
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
        `Token price: live USD price + 24h change for a crypto token, read onchain (Uniswap v3 on Ethereum/Base/Arbitrum/Polygon; Orca, Raydium, PumpSwap on Solana). Pass token (ETH, BTC, SOL, PEPE... or contract/mint address), optional chain. Returns price, 24h change, pools, depth, spread, confidence, block. ${usd(TOKEN_PRICE)} ${ON_NETWORKS_SHORT}. ${ERRORS_DOC}`,
      mimeType: "application/json",
      serviceName: "Token Price (Onchain)",
      tags: ["token price", "crypto price", "onchain price", "dex price", "price change 24h"],
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
        `Solana token price: live USD price of any SPL token by symbol or mint, read onchain from Orca Whirlpool, Raydium CLMM, PumpSwap and pump.fun bonding curves (no third-party API). Pass token (SOL, JUP, BONK, WIF... or mint). Returns price, pools with depth, spread, confidence, slot. ${usd(SOL_PRICE)} ${ON_NETWORKS_SHORT}. ${ERRORS_DOC}`,
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
        `Wallet balance: native coin + token balances with USD values for any wallet, read live onchain. EVM (Ethereum, Base, Arbitrum, Polygon in one call; ENS names work) or Solana (SOL + SPL tokens). Pass address, optional chain and tokens. Returns per-chain balances, prices and total USD. ${usd(BALANCE_PRICE)} ${ON_NETWORKS_SHORT}. ${ERRORS_DOC}`,
      mimeType: "application/json",
      serviceName: "Wallet Balance (EVM + Solana)",
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
        `Transaction lookup: status and decoded details for any tx hash or Solana signature, read onchain. EVM (auto-detects Ethereum, Base, Arbitrum, Polygon): success/reverted, block time, from/to, method, fee in USD, every token transfer decoded; flags x402/EIP-3009 USDC payments. Solana: status, fee, SOL + token balance changes. ${usd(TX_PRICE)} ${ON_NETWORKS_SHORT}. ${ERRORS_DOC}`,
      mimeType: "application/json",
      serviceName: "Transaction Lookup & Decode",
      tags: ["transaction receipt", "tx status", "decode transaction", "token transfers", "verify payment"],
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
        `Gas price tracker: live gas and priority fees for Ethereum, Base, Arbitrum, Polygon and Solana in one call, from public nodes. Returns base fee, slow/standard/fast tips, max fee, block congestion, and the USD cost of a transfer, an ERC-20 transfer and a swap, plus the cheapest chain. Optional chain. ${usd(GAS_PRICE)} ${ON_NETWORKS_SHORT}. ${ERRORS_DOC}`,
      mimeType: "application/json",
      serviceName: "Gas Price Tracker",
      tags: ["gas price", "gas fees", "estimate gas", "network fees", "solana priority fee"],
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
      memoryMb: Math.round(process.memoryUsage().rss / 1048576),
    });
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
      `- GET ${PUBLIC_URL}/report?q=<question>  (${REPORT_PRICE}) — research brief with citations: summary, 3-6 cited bullets, sources from official docs, Wikipedia, Stack Overflow, GitHub, HN-linked articles, Crossref (off-topic sources dropped). Optional depth=quick|standard, lang=en.`,
      `- GET ${PUBLIC_URL}/read?url=<https url>  (${READ_PRICE}) — web page to clean LLM-ready markdown with title, description, publish date, headings, links. Optional maxChars (default 20000).`,
      `- GET ${PUBLIC_URL}/check?url=<https x402 endpoint>  (${CHECK_PRICE}) — x402 readiness + Bazaar ranking check; one unpaid probe, score + fixes. Optional method=GET|POST.`,
      `- GET ${PUBLIC_URL}/news?q=<keywords>  (${NEWS_PRICE}) — news search: recent headlines (outlet, link, publish time, match score) from the GDELT global news index (15-min updates), major publisher feeds and Hacker News. Optional hours=1-168 (default 72), limit=1-25 (default 10). Headlines + links only; use /read for full text.`,
      `- GET ${PUBLIC_URL}/price?token=<symbol|address>  (${TOKEN_PRICE}) — token price read onchain: USD price + 24h change from Uniswap v3 pools (ethereum, base, arbitrum, polygon) or Orca/Raydium/PumpSwap (solana): pools, depth, cross-pool spread, confidence, block. Optional chain=. Pools under $25k depth -> 422 (not charged).`,
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
    free: ["/health", "/llms.txt", "/openapi.json", "/.well-known/x402", "/robots.txt"],
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
    res.json(body);
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
        res.status(422).json({ ...out, message: "Page could not be read. You were not charged." });
        return;
      }
      res.json(out);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(err instanceof InputError ? 400 : 422).json({ error: "read_failed", message: `${msg}. You were not charged.` });
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
      res.status(err instanceof InputError ? 400 : 422).json({ error: "check_failed", message: `${msg}. You were not charged.` });
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
    warmNews();
    console.log(`x402 seller listening on http://localhost:${PORT}  env=${X402_ENV} networks=${NETWORKS.join(",")} (${NETWORK_LABEL})`);
    console.log(`  paid: /report ${REPORT_PRICE}, /read ${READ_PRICE}, /check ${CHECK_PRICE}, /news ${NEWS_PRICE}, /price ${TOKEN_PRICE}, /solana-price ${SOL_PRICE}, /balance ${BALANCE_PRICE}, /tx ${TX_PRICE}, /gas ${GAS_PRICE}; payTo=${payToAddr}${payToSolana ? ` solana=${payToSolana}` : ""}`);
  });
}

main().catch((err) => {
  console.error("Failed to start x402 seller:", err);
  process.exit(1);
});
