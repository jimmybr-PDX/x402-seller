import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "node:net";
import { registerRugradarWeb, __resetFree } from "../src/lib/rugradar-web.js";

async function start() {
  const app = express(); app.use(express.json()); app.set("trust proxy", 1);
  let base = "";
  const keys = new Map([["rr_good", 2]]);
  app.get("/rug-check", (_q, r) => { r.set("payment-required", Buffer.from(JSON.stringify({ x402Version: 2, accepts: [{ amount: "10000" }] })).toString("base64")).status(402).json({}); });
  const srv = app.listen(0); base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  registerRugradarWeb(app, { publicUrl: base, port: 0, priceUsd: "0.01", speed: { creditS: 2.3, paidS: 4, x: 1.8 },
    rugCheck: async (t) => { if (t.endsWith("Fail1111111111111111111111111111111")) throw new Error("not an SPL token mint address"); return { product: "RugRadar", chain: "solana", token: t, riskScore: 48, riskLevel: "medium", buyerSummary: "FULL", buyer: { devSoldPctOfBought: 95, sniperSupplyPct10s: 30, organicLabel: "low" }, reasons: ["Dev sold 95%"], checks: [{ check: "mint_authority", points: 0, detail: "Mint authority is revoked: supply is fixed." }, { check: "age", points: 10, detail: "Very new" }, { check: "dev_sold", points: 10, detail: "Dev sold 95%" }, { check: "deployer_history", points: 20, detail: "Creator launched 5" }, { check: "snipers", points: 8, detail: "Snipers 30%" }], facts: { mintAuthority: null, freezeAuthority: null, top1Pct: 5, top10Pct: 20, ageHours: 0.2, liquidityUsd: 9000, priorLaunches: 5, priorDead: 4, extra: 1 } }; },
    spend: async (k) => { const n = keys.get(k); if (!n) return null; keys.set(k, n - 1); return n - 1; }, refund: async () => {} });
  return { srv, base };
}
const MINT = "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN";

test("free web checks: 1 limited check per visitor, then 402; cookie and IP both count; bad input does not use a check", async () => {
  __resetFree(); const { srv, base } = await start();
  try {
    const call = (cookie?: string, tok = MINT, ip = "9.9.9.9") => fetch(`${base}/rugradar/api/check?token=${tok}&chain=solana`, { method: "POST", headers: { "x-forwarded-for": ip, ...(cookie ? { cookie } : {}) } });
    assert.equal((await call(undefined, "not-a-mint")).status, 400);
    let r = await call(); const ck = (r.headers.get("set-cookie") ?? "").split(";")[0]!; assert.equal(r.status, 200);
    const j = await r.json(); const txt = JSON.stringify({ ...j, lockedSignals: null });
    assert.equal(j.free_checks_left, 0); assert.equal(j.report, "limited"); assert.equal(j.riskScore, 10);
    assert.equal(j.facts.top10Pct, 20); assert.equal(j.facts.liquidityUsd, 9000); assert.equal(j.facts.mintAuthority, null);
    assert.equal(j.unlockOffer.credits, 10); assert.equal(j.unlockOffer.priceUsd, "0.10"); assert.equal(j.unlockOffer.label, "Unlock full report \u2014 10 credits for $0.10"); assert.match(j.unlockOffer.buy, /\/credits\/buy\?credits=10$/);
    for (const bad of ["buyerSummary", "\"buyer\"", "devSold", "sniper", "Dev sold", "Snipers", "Creator launched", "priorLaunches", "organic"]) assert.ok(!txt.includes(bad), bad);
    await new Promise((x) => setTimeout(x, 2600));
    const blocked = await call(ck, MINT, "8.8.8.8"); assert.equal(blocked.status, 402); const bj = await blocked.json(); assert.match(bj.buyCredits, /credits\/buy/); assert.equal(bj.error, "free_checks_used"); assert.equal(bj.lockedSignals.length, 7); assert.equal(bj.unlockOffer.credits, 10); // new IP, same cookie: still blocked
    const sameIp = await call(undefined, MINT, "9.9.9.9"); assert.equal(sameIp.status, 402); // same IP, no cookie: still blocked
  } finally { srv.closeAllConnections(); srv.close(); }
});

test("page has SEO title, description, JSON-LD; sitemap lists /rugradar", async () => {
  const { srv, base } = await start();
  try {
    const h = await (await fetch(`${base}/rugradar`)).text();
    assert.match(h, /<title>RugRadar: Free Solana Rug Check & Honeypot Checker/); assert.match(h, /name="description"/); assert.match(h, /application\/ld\+json/); assert.match(h, /FAQPage/);
    assert.match(h, /Danger warnings only/); assert.doesNotMatch(h, /Do your own research/); assert.doesNotMatch(h, /Not financial advice/); assert.match(h, /1\.8x faster/); assert.match(h, /1 free (limited check|full report) every day per visitor/); assert.match(h, /function lockedPanel/); assert.match(h, /function walletPacks/); assert.match(h, /\/rugradar\/pay\/config/); assert.match(h, /j\.report==='limited'&&j\.checks/); assert.match(h, /Unlock full report \u2014 10 credits for \$0\.10/); assert.match(h, /credits\/buy\?credits=10/); assert.ok(!/scammer/i.test(h));
    assert.match(await (await fetch(`${base}/sitemap.xml`)).text(), /\/rugradar<\/loc>/);
  } finally { srv.closeAllConnections(); srv.close(); }
});

test("MCP: initialize, tools/list, tools/call with credit key, and payment_required without", async () => {
  const { srv, base } = await start();
  try {
    const rpc = (body: object, h: Record<string, string> = {}) => fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...h }, body: JSON.stringify(body) }).then((r) => r.json() as any);
    assert.equal((await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } })).result.serverInfo.name, "rugradar");
    const names = (await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" })).result.tools.map((t: any) => t.name);
    assert.deepEqual(names, ["rug_check", "honeypot_check", "token_price"]);
    const listed = (await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" })).result.tools;
    const rug = listed.find((t: any) => t.name === "rug_check"), honey = listed.find((t: any) => t.name === "honeypot_check"), price = listed.find((t: any) => t.name === "token_price");
    assert.ok(rug.description.includes("full rug and safety report") && rug.description.includes("honeypot_check") && rug.description.includes("token_price") && !rug.description.includes("token_safety") && !rug.description.includes("45+ data points"));
    assert.ok(honey.description.includes("can I sell") && honey.description.includes("rug_check") && honey.description.includes("token_price") && !honey.description.includes("token_safety") && !honey.description.includes("45+ data points"));
    assert.ok(price.description.includes("USD price") && price.description.includes("rug_check") && price.description.includes("honeypot_check") && !price.description.includes("news_search"));
    for (const t of listed) {
      assert.ok(t.outputSchema && t.outputSchema.properties && t.outputSchema.properties.payWith, t.name);
      assert.equal(t.annotations.readOnlyHint, true, t.name);
      assert.equal(t.annotations.destructiveHint, false, t.name);
      assert.equal(t.annotations.idempotentHint, true, t.name);
      assert.match(t.description, /not charged/i);
    }
    assert.match(rug.description, /1 free check every day/);
    assert.match(rug.inputSchema.properties.chain.description, /base for 0x addresses/);
    assert.match(listed.find((t: any) => t.name === "token_price").inputSchema.properties.chain.description, /more than one chain/);
    for (const gone of ["token_safety", "research_brief", "read_page", "news_search", "list_recent_reports"]) {
      assert.ok(!names.includes(gone), gone);
      const miss = await rpc({ jsonrpc: "2.0", id: 20, method: "tools/call", params: { name: gone, arguments: { q: "what is MCP", token: MINT, url: "https://example.com" } } });
      assert.equal(miss.error.code, -32602, gone);
    }
    const priced = await rpc({ jsonrpc: "2.0", id: 21, method: "tools/call", params: { name: "token_price", arguments: { token: "JUP" } } });
    assert.equal(priced.result.isError, true); assert.equal(priced.result.structuredContent.error, "payment_required");
    assert.match(String(priced.result.structuredContent.payWith.x402.url), /\/price\?token=/);
    assert.equal(priced.result.structuredContent.priceUsd, "$0.001");
    const paid = await rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "rug_check", arguments: { token: MINT } } }, { "x-rugradar-key": "rr_good" });
    assert.equal(paid.result.isError, false); assert.equal(paid.result.structuredContent.buyerSummary, "FULL"); assert.equal(paid.result.structuredContent.riskScore, 48); assert.equal(paid.result.structuredContent.credits_remaining, 1); assert.match(paid.result.structuredContent.shareUrl, /\/rugradar\/c\/solana\//);
    const unpaid = await rpc({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "honeypot_check", arguments: { token: MINT, api_key: "rr_bad" } } });
    assert.equal(unpaid.result.isError, true); assert.equal(unpaid.result.structuredContent.error, "payment_required");
  } finally { srv.closeAllConnections(); srv.close(); }
});

test("RugRadar code path never reads paper-bot or private signals", async () => {
  const fs = await import("node:fs");
  for (const f of ["src/lib/rug.ts", "src/lib/rug-extra.ts", "src/lib/rugradar-web.ts"]) {
    const src = fs.readFileSync(f, "utf8");
    for (const bad of [/paper\//, /winners\.json/, /knownWinners/, /coinFactory/i, /inflow/i, /creatorFamily|family\.js/i, /nameHistory|named\.js/i, /private-signals/, /trusted-creators/, /knownGood/i]) assert.ok(!bad.test(src), `${f} matches ${bad}`);
  }
});

test("buy box: Phantom/Solflare packs live in #credits (one copy), SOL default, saved-key control, desktop QR + phone deep links", async () => {
  const { srv, base } = await start();
  try {
    const h = await (await fetch(`${base}/rugradar`)).text();
    const credits = h.slice(h.indexOf('<h2 id="credits">'), h.indexOf('<h2 id="credits">') + 1000);
    assert.match(credits, /Buy credits: results ~2x faster.*measured ~1\.8x faster.*<div id="wpayHome"><\/div>.*x402 client/s, "pack box sits in Buy credits, x402 text kept for agents");
    assert.match(h, /document\.getElementById\('wpayHome'\)\.append\(walletPacks\(\)\)/); assert.equal((h.match(/append\(walletPacks\(\)\)/g) ?? []).length, 1, "only one pack box (no duplicate ids)");
    assert.match(h, /\[\['sol','SOL'\],\['usdc','USDC'\]\]/, "SOL first = default, USDC selectable");
    assert.match(h, /id="keybox" hidden/); assert.match(h, /localStorage\.setItem\('rr_key',k\)/); assert.match(h, /bt\('Show'/); assert.match(h, /bt\('Copy'/); assert.match(h, /bt\('Forget'/); assert.match(h, /KS\.set\(kk\)/);
    assert.match(h, /\/rugradar\/pay\/qr\.svg\?order=/); assert.match(h, /pollClaim\(od\.order,null,ws,240,5000,true\)/, "auto-confirm polls the existing claim endpoint");
    assert.match(h, /https:\/\/phantom\.com\/ul\/browse\//); assert.match(h, /https:\/\/solflare\.com\/ul\/v1\/browse\//);
    assert.ok(!/<script[^>]+src=/i.test(h), "no external scripts");
    for (const m of h.matchAll(/<script>([\s\S]*?)<\/script>/g)) new Function(m[1]!); // page JS parses
  } finally { srv.closeAllConnections(); srv.close(); }
});

test("MCP watch_token is listed with non-idempotent annotations, outputSchema, and hour prices", async () => {
  const app = express(); app.use(express.json()); app.set("trust proxy", 1);
  const keys = new Map([["rr_good", 2]]);
  const srv = app.listen(0); const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  registerRugradarWeb(app, { publicUrl: base, port: 0, priceUsd: "0.02", speed: null,
    rugCheck: async (t) => ({ product: "RugRadar", chain: "solana", token: t, riskScore: 1, riskLevel: "low", buyerSummary: "x", reasons: [], checks: [], facts: {} }),
    spend: async (k) => { const n = keys.get(k); if (!n) return null; keys.set(k, n - 1); return n - 1; }, refund: async () => {},
    watch: { create: async () => ({ watchId: "w_test", hours: 24, status: "active" }), config: () => ({ priceUsd: "0.05" }) } });
  try {
    const listed = (await (await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) })).json()).result.tools;
    const w = listed.find((t: any) => t.name === "watch_token");
    assert.ok(w); assert.equal(w.annotations.readOnlyHint, false); assert.equal(w.annotations.idempotentHint, false); assert.equal(w.annotations.destructiveHint, false);
    assert.ok(w.outputSchema.properties.watchId && w.outputSchema.properties.payWith);
    assert.match(w.description, /hours=24 costs \$0\.05/); assert.match(w.description, /hours=48 costs \$0\.10/);
    assert.match(w.inputSchema.properties.hours.description, /24 = \$0\.05/);
    assert.match(w.description, /not charged/);
  } finally { srv.closeAllConnections(); srv.close(); }
});

test("HTTP x402 routes for token-safety, report, read, and news stay registered (not only MCP)", async () => {
  const fs = await import("node:fs");
  const src = fs.readFileSync("src/server.ts", "utf8");
  assert.match(src, /const RUG_PATHS = new Set\(\["\/rug-check", "\/token-safety", "\/honeypot-check"\]\)/);
  for (const route of ['app.get("/report"', 'app.get("/read"', 'app.get("/news"', '"/token-safety": RUG_PRICE']) {
    assert.ok(src.includes(route), route);
  }
});
