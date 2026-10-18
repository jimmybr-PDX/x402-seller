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
    rugCheck: async (t) => { if (t.endsWith("Fail1111111111111111111111111111111")) throw new Error("not an SPL token mint address"); return { product: "RugRadar", chain: "solana", token: t, riskScore: 48, riskLevel: "medium", buyerSummary: "FULL", buyer: { devSoldPctOfBought: 95, sniperSupplyPct10s: 30, organicLabel: "low" }, reasons: ["Dev sold 95%"], checks: [{ check: "mint_authority", points: 0, detail: "Mint authority is revoked: supply is fixed." }, { check: "age", points: 10, detail: "Very new" }, { check: "dev_sold", points: 10, detail: "Dev sold 95%" }, { check: "deployer_history", points: 20, detail: "Creator launched 5" }, { check: "snipers", points: 8, detail: "Snipers 30%" }], facts: { mintAuthority: null, freezeAuthority: null, top1Pct: 5, top10Pct: 20, ageHours: 0.2, liquidityUsd: 9000, priorLaunches: 5, priorDead: 4, extra: 1 }, disclaimer: "Automated heuristic, may be wrong. Not financial advice. Do your own research." }; },
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

test("page has SEO title, description, JSON-LD, disclaimer; sitemap lists /rugradar", async () => {
  const { srv, base } = await start();
  try {
    const h = await (await fetch(`${base}/rugradar`)).text();
    assert.match(h, /<title>RugRadar: Free Solana Rug Check & Honeypot Checker/); assert.match(h, /name="description"/); assert.match(h, /application\/ld\+json/); assert.match(h, /FAQPage/);
    assert.match(h, /Do your own research/); assert.match(h, /1\.8x faster/); assert.match(h, /1 free limited check per visitor, then credits for the full report\./); assert.match(h, /function lockedPanel/); assert.match(h, /function walletPacks/); assert.match(h, /\/rugradar\/pay\/config/); assert.match(h, /j\.report==='limited'&&j\.checks/); assert.match(h, /Unlock full report \u2014 10 credits for \$0\.10/); assert.match(h, /credits\/buy\?credits=10/); assert.ok(!/scammer/i.test(h));
    assert.match(await (await fetch(`${base}/sitemap.xml`)).text(), /\/rugradar<\/loc>/);
  } finally { srv.closeAllConnections(); srv.close(); }
});

test("MCP: initialize, tools/list, tools/call with credit key, and payment_required without", async () => {
  const { srv, base } = await start();
  try {
    const rpc = (body: object, h: Record<string, string> = {}) => fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...h }, body: JSON.stringify(body) }).then((r) => r.json() as any);
    assert.equal((await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } })).result.serverInfo.name, "rugradar");
    assert.deepEqual((await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" })).result.tools.map((t: any) => t.name), ["rug_check", "token_safety", "honeypot_check"]);
    const paid = await rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "rug_check", arguments: { token: MINT } } }, { "x-rugradar-key": "rr_good" });
    assert.equal(paid.result.isError, false); assert.equal(paid.result.structuredContent.buyerSummary, "FULL"); assert.equal(paid.result.structuredContent.riskScore, 48); assert.equal(paid.result.structuredContent.credits_remaining, 1);
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
