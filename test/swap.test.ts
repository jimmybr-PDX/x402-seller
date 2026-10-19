import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import express from "express";
import type { AddressInfo } from "node:net";
import { swapConfig, swapEligible, swapClientJs, SWAP_RULE_JS, JUP_PLUGIN_SRC, SWAP_LABEL } from "../src/lib/swap.js";
import { registerRugradarWeb } from "../src/lib/rugradar-web.js";

const MINT = "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN", REF = "DkiqsTrw1u1bYFumumC7sCG2S8K25qc2vemJFHyW2wJc";
const lowRisk = () => ({
  product: "RugRadar", chain: "solana", token: MINT, riskScore: 5, riskLevel: "low", confidence: "high", unknownSignals: [] as string[],
  buyer: { canSell: "yes (Jupiter route)", sellRoute: true as unknown, sellPriceImpactPct: 0.4 as unknown },
  checks: [{ check: "mint_authority", points: 0, detail: "revoked" }, { check: "deployer_history", points: 0, detail: "ok" }, { check: "age", points: 0, detail: "400 days" }],
  facts: { mintAuthority: null as unknown, freezeAuthority: null as unknown, creator: "6m2CDdhRgxpH4WjvdzxAYbGxwdGUz5MziiL5jek2kBma" as unknown, creatorFlagged: false, funderFlagged: false, priorDead: 0, ageHours: 9600 as unknown },
}) as any;

test("swap config: OFF by default; needs RUGRADAR_SWAP_ENABLED=1 AND a valid JUP_REFERRAL_ACCOUNT", () => {
  assert.equal(swapConfig({}).enabled, false);
  assert.equal(swapConfig({ JUP_REFERRAL_ACCOUNT: REF }).enabled, false, "account alone does not switch it on");
  assert.equal(swapConfig({ RUGRADAR_SWAP_ENABLED: "1" }).enabled, false, "flag alone (no account) stays off");
  assert.equal(swapConfig({ RUGRADAR_SWAP_ENABLED: "1", JUP_REFERRAL_ACCOUNT: "not-an-address" }).enabled, false);
  assert.equal(swapConfig({ RUGRADAR_SWAP_ENABLED: "true", JUP_REFERRAL_ACCOUNT: REF }).enabled, false);
  assert.equal(swapConfig({ RUGRADAR_SWAP_ENABLED: "0", JUP_REFERRAL_ACCOUNT: REF }).enabled, false);
  const on = swapConfig({ RUGRADAR_SWAP_ENABLED: "1", JUP_REFERRAL_ACCOUNT: ` ${REF} ` }); assert.deepEqual([on.enabled, on.referralAccount, on.feeBps], [true, REF, 50]);
  assert.equal(swapClientJs(swapConfig({})), "", "no client code at all when off");
});

test("low-risk rule: shown only on a clean, sellable, older, full Solana report; hidden on every risk or unknown", () => {
  assert.equal(swapEligible(lowRisk()), true);
  const hide: [string, (r: any) => void][] = [
    ["medium risk", (r) => { r.riskLevel = "medium"; r.riskScore = 30; }], ["high risk", (r) => { r.riskLevel = "high"; r.riskScore = 80; }],
    ["score 25 but labelled low", (r) => { r.riskScore = 25; }], ["limited free report", (r) => { r.report = "limited"; }],
    ["medium confidence", (r) => { r.confidence = "medium"; }], ["unknown signals", (r) => { r.unknownSignals = ["deployer_history"]; }],
    ["mint authority", (r) => { r.facts.mintAuthority = "Abc"; }], ["freeze authority", (r) => { r.facts.freezeAuthority = "Abc"; }],
    ["authority not reported", (r) => { delete r.facts.mintAuthority; }], ["bad-deployer list", (r) => { r.facts.creatorFlagged = true; }],
    ["flagged funder", (r) => { r.facts.funderFlagged = true; }], ["earlier dead launches", (r) => { r.facts.priorDead = 1; }],
    ["unknown creator", (r) => { r.facts.creator = null; }], ["very new (5 h)", (r) => { r.facts.ageHours = 5; }], ["age unknown", (r) => { r.facts.ageHours = null; }],
    ["new-coin scoring", (r) => { r.scoring = "new-coin scoring (under 10 minutes old)"; }],
    ["pump.fun curve only", (r) => { r.buyer.sellRoute = "pump.fun curve only"; r.buyer.canSell = "yes (pump.fun curve)"; }],
    ["no sell route", (r) => { r.buyer.sellRoute = false; r.buyer.canSell = "no route found"; }], ["sell unknown", (r) => { r.buyer.canSell = "unknown"; }],
    ["thin exit 15%", (r) => { r.buyer.sellPriceImpactPct = 15; }], ["impact missing", (r) => { r.buyer.sellPriceImpactPct = null; }],
    ["deployer points", (r) => { r.checks.push({ check: "deployer_history", points: 8, detail: "x" }); }], ["honeypot points", (r) => { r.checks.push({ check: "honeypot", points: 40, detail: "x" }); }],
    ["no checks", (r) => { delete r.checks; }], ["EVM chain", (r) => { r.chain = "base"; }], ["bad token", (r) => { r.token = "0xabc"; }],
  ];
  for (const [name, mut] of hide) { const r = lowRisk(); mut(r); assert.equal(swapEligible(r), false, name); }
  assert.equal(swapEligible(null), false); assert.equal(swapEligible({}), false);
});

async function start(env: Record<string, string | undefined>, report: any) {
  const app = express(); const srv = app.listen(0); const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  registerRugradarWeb(app, { publicUrl: base, port: 0, priceUsd: "0.01", speed: null, rugCheck: async () => report, spend: async () => 5, refund: async () => {}, swap: swapConfig(env) });
  return { srv, base };
}
test("page: flag off -> no Jupiter code, no referral, no label; flag on -> ships the tested rule, label and lazy loader", async () => {
  for (const env of [{}, { JUP_REFERRAL_ACCOUNT: REF }, { RUGRADAR_SWAP_ENABLED: "1" }] as Record<string, string>[]) {
    const { srv, base } = await start(env, lowRisk());
    try { const h = await (await fetch(`${base}/rugradar`)).text(); for (const s of ["plugin.jup.ag", "swapBox", "swapOk", "referralFee", REF, "earns 0.5%"]) assert.ok(!h.includes(s), `${JSON.stringify(env)} must not include ${s}`); }
    finally { srv.closeAllConnections(); srv.close(); }
  }
  const { srv, base } = await start({ RUGRADAR_SWAP_ENABLED: "1", JUP_REFERRAL_ACCOUNT: REF }, lowRisk());
  try {
    const h = await (await fetch(`${base}/rugradar`)).text();
    assert.ok(h.includes(SWAP_RULE_JS), "page runs exactly the tested rule"); assert.ok(h.includes(JUP_PLUGIN_SRC)); assert.ok(h.includes(SWAP_LABEL)); assert.ok(h.includes(REF));
    assert.ok(!/<script[^>]+plugin\.jup\.ag/.test(h), "never loaded up front; only injected when the button is shown");
    assert.match(h, /if\(!swapOk\(j\)\)return null/); assert.match(h, /referralFee:SWAP\.bps/); assert.match(h, /"bps":50/);
    for (const m of h.matchAll(/<script>([\s\S]*?)<\/script>/g)) new Function(m[1]!);
  } finally { srv.closeAllConnections(); srv.close(); }
});

test("never in watches, alerts, webhooks or MCP/x402 output", () => {
  for (const f of ["src/lib/watch.ts", "src/lib/watch-routes.ts", "src/lib/rug.ts", "src/lib/rug-extra.ts"]) {
    const s = readFileSync(f, "utf8"); for (const w of ["swap.js", "plugin.jup.ag", "referralFee", "swapBox"]) assert.ok(!s.includes(w), `${f} must not reference ${w}`);
  }
  const web = readFileSync("src/lib/rugradar-web.ts", "utf8"), a = web.indexOf("function page("), b = web.indexOf("</html>`;", a);
  const uses = [...web.matchAll(/d\.swap/g)].map((m) => m.index!); assert.ok(uses.length >= 2);
  for (const i of uses) assert.ok(i > a && i < b, "swap is only used inside the human web page, not MCP/x402/watch code");
});
