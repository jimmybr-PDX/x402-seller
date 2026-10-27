import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "node:net";
import { cleanTokenText, safeTokenImage, pickTokenMeta, CLEAN_JS } from "../src/lib/token-name.js";
import { dsMeta } from "../src/lib/rug.js";
import { registerRugradarWeb, limitedReport, warningsOf, shownLevel, SHARE_JS, WARN, __resetFree } from "../src/lib/rugradar-web.js";
import { createRecent, type RecentStore } from "../src/lib/rugradar-recent.js";

const O = "https://x402-seller-pmlm.onrender.com", ADDR = "EMwtbpHaNqMbjUMZguuazhuZUVLWG3z4aPaPSqxS1234";
const js = new Function(SHARE_JS + "; return {rrClean,rrImg,rrTok,rrShareText,rrReportText,rrFree,rrLink};")() as Record<string, (...a: any[]) => any>;

test("sanitize: URLs, domains, @mentions, hashtags, control and invisible chars are stripped; trimmed to 32", () => {
  assert.equal(cleanTokenText("Pepe Coin"), "Pepe Coin");
  assert.equal(cleanTokenText("PEPE", 20), "PEPE");
  for (const bad of ["Buy at https://evil.com/x now", "Claim http://scam.io", "visit www.scam.xyz", "pepe.com", "t.me/scamgroup", "go to evil.io/airdrop?x=1", "ＰＥＰＥ \uff20elonmusk", "Pepe @elonmusk free", "x\u200b.com", "ipfs://Qm123", "javascript:alert(1)", "evil\u3002com/a"]) {
    const c = cleanTokenText(bad);
    assert.ok(!/https?:|www\.|\.com|\.io|\.xyz|t\.me|@|\uff20|ipfs:|javascript:|\//i.test(c), `${bad} -> ${c}`);
  }
  assert.equal(cleanTokenText("Pepe @elonmusk free"), "Pepe free");
  assert.equal(cleanTokenText("Buy at https://evil.com/x now"), "Buy at now");
  assert.equal(cleanTokenText("A\u0000B\u0007C\n\tD\u202eE\u200bF"), "A B C DEF");
  assert.ok(!/[#$<>]/.test(cleanTokenText("#PEPE $PEPE <b>x</b>")));
  assert.equal(cleanTokenText("x".repeat(100)).length, 32);
  assert.equal(cleanTokenText("   ").length, 0); assert.equal(cleanTokenText(null), ""); assert.equal(cleanTokenText(42), ""); assert.equal(cleanTokenText("@everyone"), "");
  assert.equal(Array.from(cleanTokenText("\u{1F438}".repeat(50))).length, 32, "cut by characters, no broken emoji");
  assert.equal(js.rrClean!("Pepe @x https://a.b/c"), "Pepe", "the page uses the same sanitizer");
});
test("images: https token-image CDNs only, resized; anything else is dropped", () => {
  assert.equal(safeTokenImage("https://static.jup.ag/jup/icon.png"), "https://static.jup.ag/jup/icon.png");
  assert.match(safeTokenImage("https://cdn.dexscreener.com/cms/images/ab?width=800&height=800&quality=95&format=auto"), /width=96&height=96/);
  for (const u of ["http://static.jup.ag/a.png", "https://evil.com/a.png", "https://static.jup.ag.evil.com/a.png", "https://u:p@static.jup.ag/a.png", "data:image/png;base64,AAAA", "javascript:alert(1)", "", null, 5]) assert.equal(safeTokenImage(u), "", String(u));
  assert.equal(js.rrImg!("https://evil.com/a.png"), "");
});
test("pickTokenMeta: first usable source wins per field; dirty names cleaned; nothing usable -> nulls", () => {
  assert.deepEqual(pickTokenMeta([{ name: "Pepe Coin https://x.io", symbol: "@PEPE", image: "https://evil.com/a.png" }, { name: "Other", symbol: "PEPE2", image: "https://static.jup.ag/a.png" }]),
    { tokenName: "Pepe Coin", tokenSymbol: "PEPE2", tokenImage: "https://static.jup.ag/a.png" });
  assert.deepEqual(pickTokenMeta([{}, { name: "", symbol: null }]), { tokenName: null, tokenSymbol: null, tokenImage: null });
  assert.deepEqual(pickTokenMeta([]), { tokenName: null, tokenSymbol: null, tokenImage: null });
});
test("dsMeta reads name/symbol/image of the checked token from pairs already fetched (base or quote side, best liquidity first)", () => {
  const pairs = [
    { baseToken: { address: "ADDR", name: "Small", symbol: "SM" }, quoteToken: { address: "SOL", name: "Wrapped SOL", symbol: "SOL" }, liquidity: { usd: 10 } },
    { baseToken: { address: "ADDR", name: "Big", symbol: "BG" }, quoteToken: { address: "SOL" }, liquidity: { usd: 9000 }, info: { imageUrl: "https://cdn.dexscreener.com/x" } },
    { baseToken: { address: "OTHER", name: "No", symbol: "NO" }, quoteToken: { address: "ADDR", name: "Quote Side", symbol: "QS" }, liquidity: { usd: 5 } }];
  const m = dsMeta("addr", pairs); assert.equal(m[0]!.name, "Big"); assert.equal(m[0]!.image, "https://cdn.dexscreener.com/x"); assert.equal(m.length, 3);
  assert.equal(pickTokenMeta(m).tokenSymbol, "BG"); assert.deepEqual(dsMeta("x", null), []);
});
test("header/share line: 'Name · $SYM', symbol only, name only, or nothing", () => {
  const t = js.rrTok!;
  assert.equal(t({ tokenName: "Pepe Coin", tokenSymbol: "PEPE" }).line, "Pepe Coin \u00b7 $PEPE"); assert.equal(t({ tokenName: "Pepe Coin", tokenSymbol: "PEPE" }).share, "$PEPE");
  assert.equal(t({ token: "WETH" }).line, "$WETH", "older EVM report with only facts.token");
  assert.equal(t({ tokenName: "pepe", tokenSymbol: "PEPE" }).line, "$PEPE");
  assert.equal(t({ tokenName: "Just Name" }).line, "Just Name"); assert.equal(t({ tokenName: "Just Name" }).share, "Just Name");
  assert.equal(t({}).line, ""); assert.equal(t(null).share, "");
  const evil = t({ tokenName: "Win https://evil.com @bob", tokenSymbol: "@bob.com", tokenImage: "https://evil.com/i.png" });
  assert.equal(evil.line, "Win"); assert.equal(evil.img, "");
});
test("share text with name: 'Checked $PEPE on RugRadar — ...'; no name -> unchanged wording; hostile name never yields a link or mention; stays under 270", () => {
  const titles = ["Creator can mint more", "Thin liquidity"];
  const t = js.rrShareText!(72, "HIGH RISK", titles, ADDR, "solana", O, "0.01", "$PEPE");
  assert.equal(t, `Checked $PEPE on RugRadar \u2014 72 HIGH RISK. Creator can mint more + Thin liquidity. Full report $0.01. ${O}/rugradar?token=${ADDR}&s=x2`);
  assert.equal(js.rrShareText!(72, "HIGH RISK", [], ADDR, "solana", O, "0.01"), `Checked this token on RugRadar \u2014 72 HIGH RISK. Full report $0.01. ${O}/rugradar?token=${ADDR}&s=x2`);
  assert.equal(js.rrShareText!(1, "CAUTION", [], ADDR, "solana", O, "0.01", "$PE PE").slice(0, 27), "Checked PE PE on RugRadar \u2014");
  const hostile = js.rrShareText!(72, "HIGH RISK", titles, ADDR, "solana", O, "0.01", "Free airdrop https://evil.com/claim @elonmusk t.me/x scam.io");
  const noOwn = hostile.replace(`${O}/rugradar?token=${ADDR}&s=x2`, "");
  assert.ok(!/evil|@|t\.me|scam\.io|https?:/.test(noOwn), noOwn);
  assert.equal((hostile.match(/https?:\/\//g) ?? []).length, 1, "only our own link");
  assert.ok(hostile.length <= 270);
  const long = js.rrShareText!(72, "HIGH RISK", ["x".repeat(300)], ADDR, "solana", O, "0.01", "N".repeat(80));
  assert.ok(long.length <= 270 && long.endsWith("&s=x2"), String(long.length));
  assert.match(js.rrReportText!(72, "HIGH RISK", titles, ADDR, "solana", O, "$PEPE"), /^RugRadar \u2014 \$PEPE \u2014 72 HIGH RISK\n/);
  assert.match(js.rrReportText!(72, "HIGH RISK", titles, ADDR, "solana", O), /^RugRadar \u2014 72 HIGH RISK\n/);
});

const fullReport = () => ({ product: "RugRadar", chain: "solana", token: ADDR, riskScore: 95, riskLevel: "high", report: undefined,
  checks: [
    { check: "dev_sold", points: 30, detail: "Dev sold 95% (secret)" }, { check: "snipers", points: 25, detail: "Snipers 40% (secret)" }, { check: "sell_route", points: 20, detail: "no route (secret)" },
    { check: "mint_authority", points: 25, detail: "Mint authority is still active" }, { check: "holders", points: 20, detail: "Top holders own 80%" }, { check: "liquidity", points: 7, detail: "Modest" }, { check: "age", points: 5, detail: "New" }, { check: "freeze_authority", points: 0, detail: "revoked" }],
  facts: { tokenName: "Pepe Coin", tokenSymbol: "PEPE", ageHours: 24 * 60 } });
test("full report share data is the FREE score/label/warnings only (matches the free result), never paid details", () => {
  const full = fullReport(), lim = limitedReport(full), lw = warningsOf(lim.checks);
  const fr = js.rrFree!(full.checks, ["mint_authority", "freeze_authority", "mint_function", "holders", "liquidity", "age", "dead_token"], WARN);
  assert.equal(fr.sc, lim.riskScore); assert.equal(fr.lv, lim.riskLevel); assert.deepEqual(fr.ws.map((w: any) => w.t), lw.map((w) => w.title));
  assert.notEqual(fr.sc, full.riskScore, "free score differs from the full score");
  const label = ({ high: "HIGH RISK", medium: "CAUTION", low: "LOW RISK" } as any)[shownLevel(fr.lv, fr.ws.map((w: any) => ({ sev: w.d ? "DANGER" : "CAUTION" })))];
  const txt = js.rrShareText!(fr.sc, label, fr.ws.map((w: any) => w.t), ADDR, "solana", O, "0.01", js.rrTok!(full.facts).share);
  assert.ok(txt.startsWith(`Checked $PEPE on RugRadar \u2014 ${lim.riskScore} ${label}.`), txt);
  assert.ok(txt.includes("Creator can mint more"), txt);
  for (const re of [/dev/i, /sniper/i, /sell/i, /secret/i, /95/, /safe/i, /wrong/i, /chart/i]) assert.ok(!re.test(txt.replace(/https:\/\/\S+/, "")), `${re} in ${txt}`);
  const dead = js.rrFree!([{ check: "dead_token", points: 15 }, { check: "mint_authority", points: 25 }, { check: "dev_sold", points: 30 }], ["mint_authority", "dead_token"], WARN);
  assert.equal(dead.sc, 60); assert.deepEqual([...dead.ws.map((w: any) => w.t)], ["Dead token: no way to sell", "Creator can mint more"]);
  assert.equal(JSON.stringify(js.rrFree!(undefined, [], WARN)), JSON.stringify({ sc: 0, lv: "low", ws: [] }));
});

async function start(rugCheck: (t: string, c: string) => Promise<any>) {
  const app = express(); app.set("trust proxy", 1);
  const srv = app.listen(0), base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  registerRugradarWeb(app, { publicUrl: base, port: 0, priceUsd: "0.01", speed: null, rugCheck, spend: async () => null, refund: async () => {} });
  return { srv, base };
}
test("free API result carries the sanitized name/symbol/image and not the paid details; share bar code is on the page", async () => {
  __resetFree();
  const { srv, base } = await start(async (t) => ({ ...fullReport(), token: t, facts: { ...fullReport().facts, mintAuthority: "x", creator: "Cr8" } }));
  try {
    const r = await (await fetch(`${base}/rugradar/api/check?token=${ADDR}&chain=solana`, { method: "POST" })).json();
    assert.equal(r.facts.tokenName, "Pepe Coin"); assert.equal(r.facts.tokenSymbol, "PEPE"); assert.ok(!("creator" in r.facts));
    const h = await (await fetch(`${base}/rugradar`)).text();
    for (const s of ["function rrTok", "function rrClean", "function rrFree", "rrTok(fa)", "rrTok(j.facts).share"]) assert.ok(h.includes(s), s);
  } finally { srv.closeAllConnections(); srv.close(); }
});
test("Recent entry uses the token's name: $SYMBOL, else name, else short address; hostile names are cleaned", async () => {
  const m = new Map<string, any>(), s: RecentStore = { load: async (n) => m.get(n) ?? null, save: async (docs) => { for (const [n, d] of Object.entries(docs)) d === null ? m.delete(n) : m.set(n, JSON.parse(JSON.stringify(d))); } };
  const r = createRecent(s), rep = (token: string, facts: any) => ({ product: "RugRadar", chain: "solana", token, riskScore: 40, facts });
  const A = (n: number) => `Mint${String(n).padStart(40, "0")}`;
  await r.save("k", rep(A(1), { tokenName: "Pepe Coin", tokenSymbol: "PEPE" }));
  await r.save("k", rep(A(2), { tokenName: "Only Name" }));
  await r.save("k", rep(A(3), {}));
  await r.save("k", rep(A(4), { tokenName: "https://a.io", tokenSymbol: "@evil https://a.io" }));
  await r.save("k", rep(A(5), { token: "WETH" }));
  const l = await r.list("k");
  assert.deepEqual(l.map((x) => x.name).reverse(), ["$PEPE", "Only Name", "Mint\u2026000003", "Mint\u2026000004", "$WETH"]);
});
test("EVM facts keep `token` as the cleaned symbol and add name/symbol", async () => {
  assert.ok(CLEAN_JS.includes("rrClean"));
  const m = pickTokenMeta([{ name: "Wrapped Ether", symbol: "WETH" }, ...dsMeta("0xabc", [{ baseToken: { address: "0xABC", name: "x", symbol: "y" } }])]);
  assert.equal(m.tokenSymbol, "WETH"); assert.equal(m.tokenName, "Wrapped Ether");
});
