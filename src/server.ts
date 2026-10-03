/**
 * x402 research tools for AI agents — Coinbase CDP createX402Server + Express.
 * Pattern: https://docs.cdp.coinbase.com/x402/quickstart-for-sellers
 *
 * Paid (USDC on Base via x402, CDP facilitator):
 *   GET /report?q=   cited research brief (Wikipedia, DuckDuckGo, Hacker News, Crossref; optional LLM synthesis)
 *   GET /read?url=   any public web page -> clean LLM-ready markdown + title, headings, links
 *   GET /check?url=  x402 endpoint readiness + Bazaar ranking check (one unpaid probe)
 *
 * Buyers are only charged on HTTP 2xx: @x402/express skips settlement when the handler
 * answers >= 400, so bad input, no sources, or an unreachable target cost nothing.
 *
 * Settlements are logged only after the facilitator confirms (PAYMENT-RESPONSE header),
 * with the real tx hash and payer. No invented hashes.
 */

import { createX402Server } from "@coinbase/cdp-sdk/x402";
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
const SERVICE_NAME = "Agent Research Tools"; // <= 32 printable ASCII (Bazaar rule)
const ICON_URL = `${PUBLIC_URL}/icon.svg`;

const NETWORKS =
  X402_ENV === "production"
    ? (["eip155:8453"] as const) // Base mainnet
    : (["eip155:84532"] as const); // Base Sepolia
const NETWORK_LABEL = X402_ENV === "production" ? "Base mainnet" : "Base Sepolia";

const PAID = {
  "/report": REPORT_PRICE,
  "/read": READ_PRICE,
  "/check": CHECK_PRICE,
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
  "Errors are never charged: 400 bad/missing input, 422 nothing usable found or target unreachable, 503 temporarily unavailable.";

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

  const payTo = process.env.X402_PAY_TO?.trim();

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
          query: String(req.query.q ?? req.query.url ?? "").slice(0, 200),
        });
      }
    });
    next();
  });

  const accept = (price: string) => ({
    scheme: "exact",
    price,
    network: NETWORKS[0],
    payTo: payTo ?? "",
    maxTimeoutSeconds: 300,
  });

  const reportExample = {
    query: "What is retrieval-augmented generation?",
    summary:
      "Retrieval-augmented generation (RAG) is a technique that lets large language models retrieve and incorporate new information from external sources before answering. [1]",
    bullets: [
      "RAG pairs a retriever (search or vector index) with a generator model so answers can cite current documents. [1]",
      'Scholarly: "Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks" (2020) [3]',
      'Discussion: "Show HN: RAG pipeline in 100 lines" (412 HN points) [4]',
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
    sourceCount: 7,
    providers: ["wikipedia", "duckduckgo", "hackernews", "crossref"],
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

  const strArr = { type: "array", items: { type: "string" } };
  const routes = {
    "GET /report": {
      accepts: accept(REPORT_PRICE),
      description:
        `Research brief with citations for any question or topic. Use when an agent needs a quick, sourced answer or background before writing, deciding, or searching deeper. Pass q (question). Returns summary, 3-6 cited bullets, and a source list (Wikipedia, DuckDuckGo, Hacker News, Crossref papers) with URLs and dates. ${usd(REPORT_PRICE)} USDC on Base. ${ERRORS_DOC}`,
      mimeType: "application/json",
      serviceName: SERVICE_NAME,
      tags: ["research", "web-search", "citations", "summarization", "knowledge"],
      iconUrl: ICON_URL,
      extensions: {
        ...declareDiscoveryExtension({
          input: { q: "What is retrieval-augmented generation?" },
          inputSchema: {
            properties: {
              q: { type: "string", minLength: 2, maxLength: 300, description: "Natural-language research question or topic, e.g. 'history of the transistor' or 'pros and cons of RAG'" },
              depth: { type: "string", enum: ["quick", "standard"], description: "quick = encyclopedia + instant answer only (faster); standard (default) adds Hacker News discussions and scholarly papers" },
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
                      type: { type: "string", enum: ["encyclopedia", "instant_answer", "discussion", "paper"] },
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
        `Read any public web page and get clean, LLM-ready markdown. Use when an agent has a URL (article, docs, blog, product page) and needs its text without HTML, scripts, or nav clutter. Pass url (https). Returns title, meta description, publish date, markdown, word count, headings, and outbound links. ${usd(READ_PRICE)} USDC on Base. ${ERRORS_DOC}`,
      mimeType: "application/json",
      serviceName: SERVICE_NAME,
      tags: ["web-scraping", "html-to-markdown", "web-reader", "content-extraction", "llm-ready"],
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
        `x402 endpoint readiness and Bazaar ranking check. Use before paying for or listing an x402 API. Makes one unpaid probe (never pays the target) and grades the 402 challenge: PAYMENT-REQUIRED header, accepts, amount, payTo, network, description, mimeType, serviceName, tags, bazaar schemas and examples, latency. Returns a score and fixes. ${usd(CHECK_PRICE)} USDC on Base. ${ERRORS_DOC}`,
      mimeType: "application/json",
      serviceName: SERVICE_NAME,
      tags: ["x402", "api-testing", "validation", "bazaar", "developer-tools"],
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
  };

  const serverConfig: Parameters<typeof createX402Server>[0] = {
    environment: X402_ENV,
    routes: routes as any,
  };
  if (payTo) serverConfig.payToConfig = { type: "address", evm: payTo as `0x${string}` };
  // else: CDP provisions a receiver wallet (requires CDP_WALLET_SECRET + API keys)

  const server = await createX402Server(serverConfig);
  const payToAddr = server.payToEvmAddress ?? payTo ?? null;
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
      payToMode: payTo ? "address" : "cdp-provisioned",
    });
  });

  app.get("/", (req, res) => {
    if ((req.headers.accept ?? "").includes("text/html")) {
      res.type("text/plain").send(llmsTxt());
      return;
    }
    res.json({ name: SERVICE_NAME, description: "Pay-per-call research tools for AI agents over x402 (USDC on Base).", docs: `${PUBLIC_URL}/llms.txt`, openapi: `${PUBLIC_URL}/openapi.json`, resources: catalog() });
  });

  const llmsTxt = () =>
    [
      `# ${SERVICE_NAME} (x402)`,
      "",
      "> Pay-per-call research tools for autonomous AI agents. No API key, no signup: pay per request in USDC on Base",
      `> (${NETWORKS[0]}) with the x402 protocol (HTTP 402 + PAYMENT-REQUIRED / PAYMENT-SIGNATURE headers, CDP facilitator).`,
      `> Pay to: ${payToAddr ?? "(see /health)"}. ${ERRORS_DOC}`,
      "",
      "## Paid endpoints",
      `- GET ${PUBLIC_URL}/report?q=<question>  (${REPORT_PRICE}) — research brief with citations: summary, 3-6 cited bullets, sources from Wikipedia, DuckDuckGo, Hacker News, Crossref. Optional depth=quick|standard, lang=en.`,
      `- GET ${PUBLIC_URL}/read?url=<https url>  (${READ_PRICE}) — web page to clean LLM-ready markdown with title, description, publish date, headings, links. Optional maxChars (default 20000).`,
      `- GET ${PUBLIC_URL}/check?url=<https x402 endpoint>  (${CHECK_PRICE}) — x402 readiness + Bazaar ranking check; one unpaid probe, score + fixes. Optional method=GET|POST.`,
      "",
      "## How to pay",
      "1. Call the endpoint without payment -> HTTP 402 with base64 JSON in the PAYMENT-REQUIRED header (x402Version 2, scheme exact, USDC 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913).",
      "2. Sign an EIP-3009 USDC authorization for `amount` (atomic units, 6 decimals) to `payTo`; retry with the PAYMENT-SIGNATURE header.",
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
    res.type("text/plain").send(["User-agent: *", "Allow: /", "Disallow: /report", "Disallow: /read", "Disallow: /check", `Sitemap: ${PUBLIC_URL}/openapi.json`, ""].join("\n"));
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
    description: "Pay-per-call research tools for AI agents: cited research briefs, web page to markdown, x402 endpoint checks. USDC on Base via x402.",
    resources: catalog().map((c) => c.url),
    items: catalog(),
    network: NETWORKS[0],
    payTo: payToAddr,
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
        protocols: [{ x402: { version: 2, scheme: "exact", network: NETWORKS[0], asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", payTo: payToAddr } }],
        price: { mode: "fixed", currency: "USD", amount: usd(price) },
      },
    });
    const r = routes as any;
    res.json({
      openapi: "3.1.0",
      info: {
        title: SERVICE_NAME,
        version: "2.0.0",
        description: "Pay-per-call research tools for AI agents over x402 (USDC on Base). " + ERRORS_DOC,
        "x-guidance":
          "Use /report for a cited answer to a question, /read to turn a known URL into markdown, /check to validate an x402 endpoint. Call without payment to get the 402 challenge, then retry with PAYMENT-SIGNATURE.",
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

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const message = err instanceof Error ? err.message : String(err);
    appendPaymentLog({ type: "error", kind: "express_error", message });
    if (!res.headersSent) res.status(502).json({ error: "payment_or_server_error", message });
  });

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`x402 seller listening on http://localhost:${PORT}  env=${X402_ENV} networks=${NETWORKS.join(",")} (${NETWORK_LABEL})`);
    console.log(`  paid: /report ${REPORT_PRICE}, /read ${READ_PRICE}, /check ${CHECK_PRICE}; payTo=${payToAddr}`);
  });
}

main().catch((err) => {
  console.error("Failed to start x402 seller:", err);
  process.exit(1);
});
