import { test } from "node:test";
import assert from "node:assert/strict";
import { gunzipSync } from "node:zlib";
import http from "node:http";
import fs from "node:fs";
import express from "express";
import type { AddressInfo } from "node:net";
import { gzipMiddleware, acceptsGzip } from "../src/lib/gzip.js";
import { robotsTxt } from "../src/lib/robots.js";
import { paymentsSnapshot, RUG_PAID_ROUTES } from "../src/lib/payments-snapshot.js";

const PAY = "eyJ4NDAyVmVyc2lvbiI6MiwicmVzb3VyY2UiOnsidXJsIjoiaHR0cHM6L2V4YW1wbGUvdGVzdCJ9fQ==";
const BODY = {
  error: "Payment required",
  priceUsd: 0.01,
  accepts: [{ scheme: "exact", network: "eip155:8453", amount: "10000", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", payTo: "0xa4096858C850Fe94C96e6A5c5B548b98f185Aa68" }],
  more: "x".repeat(800),
};

function rawGet(url: string, headers: Record<string, string> = {}, method = "GET"): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c as Buffer));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.end();
  });
}

async function withApp(setup: (app: express.Express) => void, fn: (base: string) => Promise<void>) {
  const app = express();
  app.use(gzipMiddleware);
  setup(app);
  const srv = app.listen(0);
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  try {
    await fn(base);
  } finally {
    await new Promise<void>((r) => srv.close(() => r()));
  }
}

test("acceptsGzip honors q-values", () => {
  assert.equal(acceptsGzip(undefined), false);
  assert.equal(acceptsGzip(""), false);
  assert.equal(acceptsGzip("identity"), false);
  assert.equal(acceptsGzip("gzip"), true);
  assert.equal(acceptsGzip("br, gzip;q=1.0"), true);
  assert.equal(acceptsGzip("gzip;q=0"), false);
  assert.equal(acceptsGzip("*;q=0.5"), true);
});

test("gzip middleware compresses 402 JSON when the client asks, and leaves payment headers intact", async () => {
  await withApp((app) => {
    app.get("/rug-check", (_req, res) => {
      res.status(402)
        .set("PAYMENT-REQUIRED", PAY)
        .set("Cache-Control", "no-store")
        .type("application/json")
        .json(BODY);
    });
  }, async (base) => {
    const gz = await rawGet(`${base}/rug-check`, { "Accept-Encoding": "gzip" });
    assert.equal(gz.status, 402);
    assert.equal(gz.headers["content-encoding"], "gzip");
    assert.match(String(gz.headers.vary ?? ""), /Accept-Encoding/i);
    assert.equal(gz.headers["payment-required"], PAY);
    assert.equal(gz.headers["cache-control"], "no-store");
    const decoded = JSON.parse(gunzipSync(gz.body).toString("utf8"));
    assert.deepEqual(decoded, BODY);
    assert.ok(gz.body.length < Buffer.byteLength(JSON.stringify(BODY)), "gzipped body should be smaller");

    const raw = await rawGet(`${base}/rug-check`);
    assert.equal(raw.status, 402);
    assert.equal(raw.headers["content-encoding"], undefined);
    assert.match(String(raw.headers.vary ?? ""), /Accept-Encoding/i);
    assert.equal(raw.headers["payment-required"], PAY);
    assert.deepEqual(JSON.parse(raw.body.toString("utf8")), BODY);
  });
});

test("gzip middleware does not compress tiny bodies or clients that omit gzip", async () => {
  await withApp((app) => {
    app.get("/health", (_req, res) => { res.set("Cache-Control", "no-store").type("application/json").end('{"ok":true}'); });
    app.get("/big", (_req, res) => { res.type("application/json").json({ pad: "n".repeat(2000) }); });
  }, async (base) => {
    const health = await rawGet(`${base}/health`, { "Accept-Encoding": "gzip" });
    assert.equal(health.status, 200);
    assert.equal(health.headers["content-encoding"], undefined);
    assert.equal(health.body.toString(), '{"ok":true}');

    const big = await rawGet(`${base}/big`, { "Accept-Encoding": "gzip" });
    assert.equal(big.status, 200);
    assert.equal(big.headers["content-encoding"], "gzip");
    assert.equal(JSON.parse(gunzipSync(big.body).toString("utf8")).pad.length, 2000);
  });
});

test("robots.txt keeps product/discovery crawlable and blocks fat or paid paths", () => {
  const txt = robotsTxt("https://x402-seller-pmlm.onrender.com");
  assert.match(txt, /^User-agent: \*\n/m);
  assert.match(txt, /^Allow: \/$/m);
  assert.match(txt, /^Allow: \/rugradar$/m);
  assert.match(txt, /^Allow: \/\.well-known\/x402$/m);
  assert.match(txt, /^Allow: \/skill\.md$/m);
  assert.match(txt, /^Allow: \/agents\.md$/m);
  for (const path of ["/stats", "/openapi.json", "/paper", "/rug-check", "/price", "/mcp", "/credits/", "/rugradar/api/"]) {
    assert.match(txt, new RegExp(`^Disallow: ${path.replace(/[./]/g, "\\$&")}$`, "m"), path);
  }
  assert.match(txt, /^Sitemap: https:\/\/x402-seller-pmlm\.onrender\.com\/sitemap\.xml$/m);
  assert.doesNotMatch(txt, /Disallow: \/$/);
  assert.doesNotMatch(txt, /Disallow: \/rugradar$/);
  assert.doesNotMatch(txt, /Disallow: \/skill\.md/);
  assert.doesNotMatch(txt, /Disallow: \/agents\.md/);
  assert.doesNotMatch(txt, /Disallow: \/\.well-known\/x402$/);
});

test("paymentsSnapshot is a tiny object extract_snapshot can read, with no payer addresses", () => {
  const snap = paymentsSnapshot(["/rug-check", "/token-safety", "/honeypot-check", "/credits/buy", "/price"]);
  assert.equal(typeof snap.rugradar.allTime.rugradarPaidReports, "number");
  assert.equal(typeof snap.rugradar.today.day, "string");
  assert.equal(typeof snap.rugradar.today.rugradarPaidReports, "number");
  for (const path of RUG_PAID_ROUTES) {
    assert.equal(typeof snap.allTime.routes[path]?.paid200, "number");
  }
  assert.ok(Array.isArray(snap.sales.onchain.recent));
  const blob = JSON.stringify(snap);
  assert.doesNotMatch(blob, /"from"/);
  assert.ok(Buffer.byteLength(blob) < 4096, `snapshot too large: ${blob.length}`);
});

test("server wires gzip middleware, robotsTxt, payments snapshot, and cache headers", () => {
  const server = fs.readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");
  const web = fs.readFileSync(new URL("../src/lib/rugradar-web.ts", import.meta.url), "utf8");
  assert.match(server, /app\.use\(gzipMiddleware\)/);
  assert.match(server, /robotsTxt\(PUBLIC_URL\)/);
  assert.match(server, /app\.get\("\/stats\/payments"/);
  assert.match(server, /paymentsSnapshot\(Object\.keys\(PAID\)\)/);
  assert.match(server, /app\.get\("\/openapi\.json"[\s\S]*Cache-Control", "public, max-age=3600"/);
  assert.match(server, /\/robots\.txt"[\s\S]*Cache-Control", "public, max-age=3600"/);
  assert.match(server, /\/\.well-known\/x402"[\s\S]*Cache-Control", "public, max-age=300"/);
  assert.match(web, /Cache-Control", "public, max-age=3600"\)\.send\(skillMd\)/);
  assert.match(web, /Cache-Control", "public, max-age=3600"\)\.type\("application\/xml"\)/);
});
