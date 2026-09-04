/**
 * Minimal x402 seller — Coinbase CDP createX402Server + Express middleware.
 * Pattern: https://docs.cdp.coinbase.com/x402/quickstart-for-sellers
 *
 * If X402_PAY_TO is set → payToConfig { type: "address", evm }
 * If unset → omit payToConfig so CDP provisions a receiver wallet (needs CDP_WALLET_SECRET)
 *
 * Does not invent payment hashes. Settlements/errors append to payments.jsonl.
 */

import { createX402Server } from "@coinbase/cdp-sdk/x402";
import { paymentMiddlewareFromHTTPServer } from "@x402/express";
import express, { type Request, type Response, type NextFunction } from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const PAYMENTS_LOG = path.join(ROOT, "payments.jsonl");

type EnvMode = "development" | "production";

const PORT = Number(process.env.PORT ?? 8402);
const X402_ENV = (process.env.X402_ENV ?? "development") as EnvMode;
const DAILY_SPEND_CAP_USD = Number(process.env.DAILY_SPEND_CAP_USD ?? 50);

const DEFAULT_PRICE =
  process.env.REPORT_PRICE ??
  (X402_ENV === "production" ? "$1.25" : "$0.01");

const NETWORKS =
  X402_ENV === "production"
    ? (["eip155:8453"] as const) // Base mainnet
    : (["eip155:84532"] as const); // Base Sepolia

const FAIL_WINDOW_MS = 10 * 60 * 1000;
const FAIL_THRESHOLD = 3;
const settleFailures: number[] = [];

function appendPaymentLog(entry: Record<string, unknown>): void {
  const line = JSON.stringify({ ...entry, at: new Date().toISOString() }) + "\n";
  fs.appendFileSync(PAYMENTS_LOG, line, "utf8");
}

function parsePriceUsd(price: string): number {
  const n = Number(String(price).replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function utcDayKey(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}

function sumSettledTodayUsd(): number {
  if (!fs.existsSync(PAYMENTS_LOG)) return 0;
  const day = utcDayKey();
  let sum = 0;
  const lines = fs.readFileSync(PAYMENTS_LOG, "utf8").split("\n").filter(Boolean);
  for (const line of lines) {
    try {
      const row = JSON.parse(line) as {
        type?: string;
        priceUsd?: number;
        at?: string;
      };
      if (row.type === "settlement" && row.at?.startsWith(day) && typeof row.priceUsd === "number") {
        sum += row.priceUsd;
      }
    } catch {
      /* ignore bad lines */
    }
  }
  return sum;
}

function circuitOpen(): boolean {
  const cutoff = Date.now() - FAIL_WINDOW_MS;
  while (settleFailures.length && settleFailures[0]! < cutoff) {
    settleFailures.shift();
  }
  return settleFailures.length >= FAIL_THRESHOLD;
}

function recordSettleFailure(detail: Record<string, unknown>): void {
  settleFailures.push(Date.now());
  appendPaymentLog({ type: "error", kind: "settle_failure", ...detail });
}

function recordSettlement(detail: Record<string, unknown>): void {
  appendPaymentLog({ type: "settlement", ...detail });
}

/** Synthetic outline labeled for testing (no LLM keys). */
function syntheticReport(query: string) {
  return {
    query,
    summary: `[TEST SYNTHETIC] Outline for "${query || "(empty query)"}". No LLM key configured.`,
    bullets: [
      "This response is synthetic and labeled for local/testing use.",
      "Set OPENAI_API_KEY or GROK_API_KEY to enable optional live generation.",
      "x402 payment gating is independent of report content.",
    ],
    generatedAt: new Date().toISOString(),
    note: "synthetic-outline-for-testing",
  };
}

async function optionalLlmReport(query: string) {
  const grokKey = process.env.GROK_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;
  if (!grokKey && !openaiKey) return syntheticReport(query);

  const base = grokKey
    ? (process.env.GROK_API_BASE ?? "https://api.x.ai/v1")
    : "https://api.openai.com/v1";
  const key = grokKey ?? openaiKey!;
  const model = grokKey ? "grok-2-latest" : "gpt-4o-mini";

  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        temperature: 0.3,
        messages: [
          {
            role: "system",
            content:
              "Return a concise JSON object with keys: summary (string), bullets (string array of 3-5 items). No markdown.",
          },
          { role: "user", content: `Research outline for: ${query}` },
        ],
        response_format: { type: "json_object" },
      }),
    });
    if (!res.ok) {
      appendPaymentLog({
        type: "error",
        kind: "llm_http",
        status: res.status,
        body: await res.text().catch(() => ""),
      });
      return syntheticReport(query);
    }
    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const raw = data.choices?.[0]?.message?.content ?? "{}";
    const parsed = JSON.parse(raw) as { summary?: string; bullets?: string[] };
    return {
      query,
      summary: parsed.summary ?? "No summary",
      bullets: Array.isArray(parsed.bullets) ? parsed.bullets : [],
      generatedAt: new Date().toISOString(),
      note: grokKey ? "generated-via-grok" : "generated-via-openai",
    };
  } catch (err) {
    appendPaymentLog({
      type: "error",
      kind: "llm_exception",
      message: err instanceof Error ? err.message : String(err),
    });
    return syntheticReport(query);
  }
}

async function main() {
  const app = express();
  app.use(express.json());

  const payTo = process.env.X402_PAY_TO?.trim();
  const priceUsd = parsePriceUsd(DEFAULT_PRICE);

  // Guard rails before payment middleware: daily cap + circuit breaker
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.method === "GET" && req.path === "/report") {
      if (circuitOpen()) {
        appendPaymentLog({
          type: "error",
          kind: "circuit_open",
          path: req.path,
          failuresInWindow: settleFailures.length,
        });
        res.status(503).json({
          error: "circuit_open",
          message:
            "Circuit breaker open: 3 settle failures within 10 minutes. Retry later.",
        });
        return;
      }
      const spent = sumSettledTodayUsd();
      if (spent + priceUsd > DAILY_SPEND_CAP_USD) {
        appendPaymentLog({
          type: "error",
          kind: "daily_cap",
          spentUsd: spent,
          capUsd: DAILY_SPEND_CAP_USD,
          attemptedUsd: priceUsd,
        });
        res.status(503).json({
          error: "daily_spend_cap",
          message: `Daily spend cap reached ($${DAILY_SPEND_CAP_USD}). Settled today: $${spent.toFixed(2)}.`,
        });
        return;
      }
    }
    next();
  });

  const serverConfig: Parameters<typeof createX402Server>[0] = {
    environment: X402_ENV,
    routes: {
      "GET /report": {
        price: DEFAULT_PRICE,
        networks: [...NETWORKS],
        description: "Generate a concise research report",
      },
    },
  };

  // Documented dual path: address vs CDP-provisioned wallet
  if (payTo) {
    serverConfig.payToConfig = {
      type: "address",
      evm: payTo as `0x${string}`,
    };
  }
  // else: omit payToConfig → CDP provisions (requires CDP_WALLET_SECRET + API keys)

  const server = await createX402Server(serverConfig);

  app.use(paymentMiddlewareFromHTTPServer(server));

  // Free health check (not in routes map)
  app.get("/health", (_req, res) => {
    res.json({
      ok: true,
      env: X402_ENV,
      networks: NETWORKS,
      price: DEFAULT_PRICE,
      dailySpendCapUsd: DAILY_SPEND_CAP_USD,
      spentTodayUsd: sumSettledTodayUsd(),
      circuitOpen: circuitOpen(),
      payToEvmAddress: server.payToEvmAddress ?? null,
      payToMode: payTo ? "address" : "cdp-provisioned",
    });
  });

  app.get("/report", async (req, res) => {
    const q = typeof req.query.q === "string" ? req.query.q : "";
    try {
      const body = await optionalLlmReport(q);
      // Log settlement after successful paid response; do not invent on-chain hashes.
      recordSettlement({
        route: "GET /report",
        price: DEFAULT_PRICE,
        priceUsd,
        query: q,
        network: NETWORKS[0],
        payTo: server.payToEvmAddress ?? payTo ?? null,
        paymentHash: null,
        note: "settlement logged after successful paid response; no invented tx hash",
      });
      res.json(body);
    } catch (err) {
      recordSettleFailure({
        route: "GET /report",
        message: err instanceof Error ? err.message : String(err),
      });
      res.status(500).json({ error: "report_failed" });
    }
  });

  app.use(
    (err: unknown, _req: Request, res: Response, _next: NextFunction) => {
      const message = err instanceof Error ? err.message : String(err);
      recordSettleFailure({ message, source: "express_error" });
      if (!res.headersSent) {
        res.status(502).json({ error: "payment_or_server_error", message });
      }
    },
  );

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`x402 seller listening on http://localhost:${PORT}`);
    console.log(`  X402_ENV=${X402_ENV}  networks=${NETWORKS.join(",")}  price=${DEFAULT_PRICE}`);
    console.log(
      `  payTo mode=${payTo ? "address (" + payTo + ")" : "cdp-provisioned"}`,
    );
    if (server.payToEvmAddress) {
      console.log(`  Receiving EVM payments at ${server.payToEvmAddress}`);
    }
    console.log(`  Free: GET /health`);
    console.log(`  Paid: GET /report?q=...`);
    console.log(
      `  Guard: daily cap $${DAILY_SPEND_CAP_USD}; circuit after ${FAIL_THRESHOLD} settle failures / 10m`,
    );
    console.log(`  Log: ${PAYMENTS_LOG}`);
  });
}

main().catch((err) => {
  console.error("Failed to start x402 seller:", err);
  process.exit(1);
});
