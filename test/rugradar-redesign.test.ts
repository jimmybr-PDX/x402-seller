import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "node:net";
import { registerRugradarWeb, limitedReport, freeFacts, warningsOf, shownLevel, WARN, __resetEmbed } from "../src/lib/rugradar-web.js";
import { isDeadToken, geckoMarket } from "../src/lib/rug.js";
import { swapConfig, SWAP_RULE_JS } from "../src/lib/swap.js";

const DEAD = "DDDvFkQzF9KrxiqDYuHpMGi6LeZuNeCsM5VVtStTgA2E", CLEAN = "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN", REF = "D2hNoZ1Y5BnLzPpX2TfrYvmG6yRyD9fF5V4Hk3q7pump";
const deadFull = () => ({ product: "RugRadar", chain: "solana", token: DEAD, riskScore: 60, riskLevel: "high", confidence: "medium", unknownSignals: [],
  checks: [{ check: "dead_token", points: 15, detail: "Dead token: no liquidity left and no way to sell, over a week old (rated high regardless of other checks)." }, { check: "mint_authority", points: 25, detail: "Mint authority is still active" }, { check: "liquidity", points: 15, detail: "No DEX pool found" }, { check: "no_socials", points: 5, detail: "No website or social links listed." }, { check: "deployer_history", points: 20, detail: "Creator wallet launched 9 other token(s); 8 never graduated" }, { check: "freeze_authority", points: 0, detail: "Freeze authority is revoked." }, { check: "age", points: 0, detail: "300 days old." }],
  facts: { mintAuthority: "Abc", freezeAuthority: null, ageHours: 7200, liquidityUsd: null, creator: "Cr8", priorDead: 8 }, buyer: { socialLinks: [], lpBurnPct: [{ dex: "raydium", tvlUsd: 10, burnPct: 99.6 }] } });

test("free check counts the dead-token rule: the dead coin rates high, not medium", () => {
  const l = limitedReport(deadFull());
  assert.equal(l.riskLevel, "high"); assert.equal(l.riskScore, 60); assert.equal(l.checks[0]!.check, "dead_token");
  const noDead = deadFull(); noDead.checks.shift(); assert.equal(limitedReport(noDead).riskLevel, "medium", "without the rule it was medium (40)");
  assert.equal(l.hiddenWarnings, 1, "no_socials is full-report only; creator history is never counted or shown");
  assert.ok(!JSON.stringify({ ...l, lockedSignals: null }).includes("graduat"));
});
test("Solana free check adds one plain line: mint authority and LP burn", () => {
  assert.deepEqual(freeFacts(deadFull()), ["Mint authority: still on", "Liquidity: 100% burned"]);
  const c = deadFull(); c.facts.mintAuthority = null as any; c.buyer.lpBurnPct = [{ dex: "a", tvlUsd: 5, burnPct: 3 }, { dex: "b", tvlUsd: 900, burnPct: 41.4 }];
  assert.deepEqual(freeFacts(c), ["Mint authority: off", "Liquidity: 41% burned"]);
  assert.deepEqual(freeFacts({ ...c, chain: "base" }), []);
  assert.deepEqual(limitedReport(c).freeFacts, ["Mint authority: off", "Liquidity: 41% burned"]);
});
test("warnings: one-line titles, worst first, creator history never shown", () => {
  const w = warningsOf(deadFull().checks);
  assert.deepEqual(w.map((x) => x.title), ["Creator can mint more", "Dead token: no way to sell", "Thin liquidity", "No website or socials"]);
  assert.deepEqual(w.map((x) => x.sev), ["DANGER", "DANGER", "DANGER", "CAUTION"]);
  for (const [t, l] of Object.values(WARN) as [string, string][]) { assert.ok(t.length <= 32, t); assert.ok(l.length <= 60, l); }
});

const PRIVATE = [/inflow/i, /graduat/i, /winn(er|ing)/i, /known[- ]?good/i, /family/i, /name history/i, /coinFactory/i, /funder|funded by/i, /account age/i, /domain age/i, /reused/i, /named wallet/i, /wallet name/i, /earlier launches|past launches|launched \d/i, /creator'?s? (earlier|other) coins/i, /\bsafe\b/i];
async function start(report: (t: string) => any, swap = swapConfig({})) {
  const app = express(); app.set("trust proxy", 1); const srv = app.listen(0); const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  registerRugradarWeb(app, { publicUrl: base, port: 0, priceUsd: "0.01", speed: { creditS: 2.3, paidS: 4, x: 1.8 }, rugCheck: async (t) => report(t), spend: async () => 5, refund: async () => {}, swap, detectChain: async () => "bnb" });
  return { srv, base };
}
test("v5 page: paste box, Auto chip, free line, credits copy, folded agents with embed snippet; no private signal or method text", async () => {
  for (const sw of [swapConfig({}), swapConfig({ RUGRADAR_SWAP_ENABLED: "1", JUP_REFERRAL_ACCOUNT: REF })]) {
    const { srv, base } = await start(() => deadFull(), sw);
    try {
      const h = await (await fetch(`${base}/rugradar`)).text();
      for (const s of ['id="tok"', '<option value="auto">Auto', "Free \u00b7 no sign-up", "Prepaid credits finish checks ~2x faster", "Buy credits: results ~2x faster", "don't wait on a payment for each check (measured ~1.8x faster)", "Strong rug warning signs.", "No danger warnings found. Not a guarantee.", "No socials found", "more warning", '<details class="fold agents" id="agents">', 'id="developers"', "For developers", "#developers", "/rugradar/embed?token=", "/rugradar/embed.json?token="]) assert.ok(h.includes(s), s);
      assert.equal((h.match(/<select id="chain"/g) ?? []).length, 1, "a single chain chip");
      assert.ok(!/id="watch"|More tools|Watch this token/.test(h), "no Watch feature or paid tool list in this release");
      assert.ok(h.includes("Watch token: coming soon") && h.includes("mo.id='more'"), "static coming-soon note in the More section");
      assert.ok(!/\/rugradar\/fw|rr_alerts/.test(h), "no watch requests or alert storage");
      const visible = h.replace(SWAP_RULE_JS, ""); // the unchanged swap rule reads report field names; it prints nothing
      for (const re of PRIVATE) assert.ok(!re.test(visible), `page must not match ${re}`);
      for (const k of ["deployer_history", "known_pattern", "shared_funder"]) assert.ok(!new RegExp(`"${k}":\\[`).test(h), `${k} has no copy on the page`);
      assert.equal(h.includes("Opens swap in your wallet"), sw.enabled, "swap line only ships when the swap is on");
      assert.ok(Buffer.byteLength(h) < 58_400, `page ${Buffer.byteLength(h)} bytes`);
      for (const m of h.matchAll(/<script>([\s\S]*?)<\/script>/g)) new Function(m[1]!);
    } finally { srv.closeAllConnections(); srv.close(); }
  }
});
test("embed card + JSON: ring, verdict, max 3 collapsed warnings, unlock link, credit; dead coin high; framable; bad input 400", async () => {
  __resetEmbed();
  const { srv, base } = await start((t) => (t === DEAD ? deadFull() : { product: "RugRadar", chain: t.startsWith("0x") ? "bnb" : "solana", token: t, riskScore: 0, riskLevel: "low", checks: [{ check: "mint_authority", points: 0, detail: "x" }], facts: { mintAuthority: null } }));
  try {
    const r = await fetch(`${base}/rugradar/embed?token=${DEAD}`); const h = await r.text();
    assert.equal(r.status, 200); assert.match(r.headers.get("content-security-policy") ?? "", /frame-ancestors \*/);
    assert.match(h, /class="gauge g-high"/); assert.match(h, /HIGH RISK/); assert.match(h, /Strong rug warning signs\./);
    assert.equal((h.match(/<details class="wc/g) ?? []).length, 3); assert.ok(!/<details[^>]* open/.test(h), "collapsed");
    assert.match(h, /Unlock live chart \+ full report - \$0\.01 \u203a/); assert.match(h, /Not a guarantee \u00b7 <b>RugRadar<\/b>/); assert.match(h, /width:360px/);
    assert.ok(!/<script/i.test(h), "no scripts in the embed"); assert.ok(!/Buy this token|swap/i.test(h));
    for (const re of PRIVATE) assert.ok(!re.test(h), `embed must not match ${re}`);
    const j = await (await fetch(`${base}/rugradar/embed.json?token=${DEAD}`)).json();
    assert.equal(j.riskLevel, "high"); assert.equal(j.riskScore, 60); assert.equal(j.warnings.length, 3); assert.equal(j.warnings[0].title, "Creator can mint more"); assert.match(j.reportUrl, /\/rugradar\?token=DDDv.*&chain=solana$/); assert.equal(j.moreWarnings, 1);
    const low = await (await fetch(`${base}/rugradar/embed.json?token=${CLEAN}`)).json(); assert.equal(low.verdict, "No danger warnings found. Not a guarantee."); assert.equal(low.warnings.length, 0);
    const evm = await (await fetch(`${base}/rugradar/embed.json?token=0x${"a".repeat(40)}`)).json(); assert.equal(evm.chain, "bnb", "auto-detects the EVM chain");
    assert.equal((await fetch(`${base}/rugradar/embed?token=nope`)).status, 400); assert.equal((await fetch(`${base}/rugradar/embed.json`)).status, 400);
    assert.deepEqual(await (await fetch(`${base}/rugradar/api/chain?token=0x${"b".repeat(40)}`)).json(), { chain: "bnb" });
  } finally { srv.closeAllConnections(); srv.close(); }
});

test("shown level never says LOW RISK while a warning is shown", () => {
  assert.equal(shownLevel("low", []), "low"); assert.equal(shownLevel("low", [{ sev: "CAUTION" }]), "medium"); assert.equal(shownLevel("low", [{ sev: "CAUTION" }, { sev: "DANGER" }]), "high");
  assert.equal(shownLevel("medium", []), "medium"); assert.equal(shownLevel("high", [{ sev: "CAUTION" }]), "high");
});
test("dead-token rule: accepts an age lower bound when the full history can't be read; still needs market data", () => {
  const base = { marketUnknown: false, liquidityUsd: null, ageHours: null };
  assert.equal(isDeadToken({ ...base, ageMinHours: 24 * 30 }, {}), true);
  assert.equal(isDeadToken({ ...base, ageMinHours: 24 * 2 }, {}), false);
  assert.equal(isDeadToken({ ...base }, {}), false, "no age at all: no rule");
  assert.equal(isDeadToken({ ...base, marketUnknown: true, ageMinHours: 24 * 30 }, {}), false);
  assert.equal(isDeadToken({ ...base, ageMinHours: 24 * 30 }, { canSell: "yes (Jupiter route)" }), false);
});
test("market fallback: GeckoTerminal 404 = no pool (market known), pools summed, errors = unknown", async () => {
  const mk = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
  assert.deepEqual(await geckoMarket("M", mk(404, {})), { liquidityUsd: null, priceUsd: null, createdAt: null });
  const g = await geckoMarket("M", mk(200, { data: [{ attributes: { reserve_in_usd: "40.5", pool_created_at: "2026-01-01T00:00:00Z", base_token_price_usd: "0.001" } }, { attributes: { reserve_in_usd: "9.5", pool_created_at: "2025-12-01T00:00:00Z" } }] }));
  assert.equal(g!.liquidityUsd, 50); assert.equal(g!.createdAt, Date.parse("2025-12-01T00:00:00Z"));
  assert.equal(await geckoMarket("M", mk(429, {})), null);
});
test("free check page: free line under the ring, no quota line above, quiet credits, key as a small link; embed matches", async () => {
  __resetEmbed();
  const lowWithCaution = (t: string) => ({ product: "RugRadar", chain: "solana", token: t, riskScore: 10, riskLevel: "low", checks: [{ check: "age", points: 10, detail: "Very new" }], facts: { mintAuthority: null, ageHours: 5 } });
  const { srv, base } = await start(lowWithCaution);
  try {
    const h = await (await fetch(`${base}/rugradar`)).text();
    assert.match(h, /<small id="quota"><\/small>/); assert.ok(h.includes("Your free daily check: basic warnings only."));
    assert.match(h, /class="linkbtn" id="buyc"/); assert.match(h, /Prepaid credits finish checks ~2x faster/); assert.match(h, /<details class="keyd" id="keyd"><summary>Have a credit key\?<\/summary>/);
    assert.ok(!h.includes("dev history"));
    const e = await (await fetch(`${base}/rugradar/embed?token=${CLEAN}`)).text();
    assert.match(e, /class="gauge g-medium"/); assert.match(e, />CAUTION</); assert.ok(!e.includes("LOW RISK")); assert.match(e, /Free check: basic warnings only\. Full report unlocks more\./); assert.match(e, /Unlock live chart \+ full report - \$0\.01 \u203a/);
  } finally { srv.closeAllConnections(); srv.close(); }
});

test("share text: free score, label and top warning titles only; X intent URL; under 270 chars; never safety wording; no locked fields", async () => {
  const { SHARE_JS } = await import("../src/lib/rugradar-web.js");
  const { rrShareText, rrReportText, rrLink } = new Function(SHARE_JS + "; return {rrShareText,rrReportText,rrLink};")() as Record<string, (...a: any[]) => string>;
  const O = "https://x402-seller-pmlm.onrender.com", titles = warningsOf(deadFull().checks).map((w) => w.title);
  const t = rrShareText!(60, "HIGH RISK", titles, DEAD, "solana", O, "0.01");
  assert.equal(t, `Checked this token on RugRadar \u2014 60 HIGH RISK. Creator can mint more + Dead token: no way to sell. Full report $0.01. ${O}/rugradar?t=${DEAD}&s=x`);
  assert.ok(t.length <= 270);
  assert.equal(rrLink!(O, "0xAbC0000000000000000000000000000000000001", "base"), `${O}/rugradar?t=0xAbC0000000000000000000000000000000000001&chain=base&s=x`);
  const long = rrShareText!(15, "CAUTION", ["x".repeat(400), "y"], DEAD, "solana", O, "0.01");
  assert.ok(long.length <= 270 && long.includes("\u2026") && long.endsWith("&s=x"), long.length + "");
  assert.equal(rrShareText!(0, "LOW RISK", [], DEAD, "solana", O, "0.01"), `Checked this token on RugRadar \u2014 0 LOW RISK. Full report $0.01. ${O}/rugradar?t=${DEAD}&s=x`);
  const r = rrReportText!(60, "HIGH RISK", titles, DEAD, "solana", O);
  assert.equal(r.split("\n").length, 2 + titles.length - 1 + 2 > 0 ? 2 + Math.min(titles.length, 3) + 1 : 0);
  for (const x of [t, r, long]) for (const re of [...PRIVATE, /\bclean\b|\bgood\b|sniper|dev (sold|holding)|can.you.sell|chart|wallet/i]) assert.ok(!re.test(x.replace(/rugradar\?token=\S+/g, "")), `${re} in ${x}`);
});
test("page ships the share buttons for free AND full results, free-only auto-run from ?token=, same 1200x630 preview image, within the size caps", async () => {
  const { srv, base } = await start(() => deadFull());
  try {
    const h = await (await fetch(`${base}/rugradar?token=${DEAD}&s=x2`)).text();
    for (const s of ["Share on X", "https://x.com/intent/post?text=", "Copy report", "Copy link", "function shotMode", "navigator.share", "execCommand('copy')", "shareBar(j,ws)", "f.dataset.free", "preview-x402-v2.png", 'content="1200"', 'content="630"']) assert.ok(h.includes(s), s);
    assert.ok(/c\.append\(lockedPanel\(null,'Unlock for \$'\+CFG\.p\)\);c\.append\(shareBar\(j,ws\)\)\}/.test(h), "free branch unchanged: share bar under the free result");
    assert.ok(/else\{if\(ws\.length>3\)[\s\S]*?if\(Array\.isArray\(j\.checks\)\)\{const fr=rrFree\(j\.checks,CFG\.lim,CFG\.warn\);c\.append\(shareBar\(\{riskScore:fr\.sc,riskLevel:fr\.lv,token:j\.token,chain:j\.chain,facts:fa\},fr\.ws\)\)\}\}/.test(h), "full-report branch shows the share bar, built from the free score and warnings only");
    assert.ok(h.includes('"lim":["mint_authority","freeze_authority","mint_function","holders","liquidity","age","dead_token"]'), "page config carries the free check list");
    assert.ok(Buffer.byteLength(h) < 58_400, `page ${Buffer.byteLength(h)} bytes`);
    for (const re of PRIVATE) assert.ok(!re.test(h.replace(SWAP_RULE_JS, "")), `${re}`);
  } finally { srv.closeAllConnections(); srv.close(); }
});
