// Nov 25 2026 scoring recalibration: hard stops, high-danger tier, capped soft flags, 15 zero-cost signals, free-check hard stops.
import { test } from "node:test";
import assert from "node:assert/strict";
import { scoreFacts, scoreEvm, scoreSolana, finishEvm, finalizeReport, marketWarnings, lpShortLock, lockEndMs, type Facts } from "../src/lib/rug.js";
import { applyEvmSellWarnings } from "../src/lib/evm-sell.js";
import { goplusChecks, parseGoPlusSol } from "../src/lib/goplus-sol.js";
import { solanaExtra } from "../src/lib/rug-extra.js";
import { totalScore, SOFT_CAP, levelOf } from "../src/lib/rug-score.js";
import { limitedReport, WARN, HONEYPOT_BANNER, SHARE_JS } from "../src/lib/rugradar-web.js";

const base: Facts = { mint: "M", decimals: 6, supply: 1e9, mintAuthority: null, freezeAuthority: null, token2022: false, top1Pct: 5, top10Pct: 20, liquidityUsd: 500000, priceUsd: 1, pairs: 2, lpNote: null, ageHours: 2000, creator: "C", funder: null, priorLaunches: 0, priorDead: 0, creatorFlagged: false, funderFlagged: false, unknown: [] };
const ex = (checks: { check: string; points: number; detail: string }[], signals: Record<string, unknown> = {}) => ({ signals, checks, unknown: [], ms: 1 });
const c = (check: string, points: number) => ({ check, points, detail: check });
const pts = (r: { reasons: { check: string; points: number }[] }, k: string) => r.reasons.filter((x) => x.check === k).reduce((a, x) => a + x.points, 0);
const rrFree = new Function(SHARE_JS + "; return rrFree;")() as (ch: any[], L: string[], W: any) => { sc: number; lv: string };

test("thresholds unchanged: Low < 25, Medium 25-49, High >= 50, cap 100", () => {
  assert.equal(levelOf(24), "low"); assert.equal(levelOf(25), "medium"); assert.equal(levelOf(49), "medium"); assert.equal(levelOf(50), "high");
  assert.equal(totalScore([c("honeypot", 100), c("tax", 80)]), 100);
});

test("confirmed honeypot = 100 (alone), full-red ring banner text, never 'Do not buy'", () => {
  const r = scoreEvm({ is_honeypot: "1", holder_count: "30" }, 50000, 2000);
  assert.equal(pts(r, "honeypot"), 100); assert.equal(r.score, 100); assert.equal(r.level, "high");
  assert.equal(scoreEvm({ cannot_sell_all: "1" }, 50000, 2000).score, 100);
  assert.equal(HONEYPOT_BANNER, "Cannot sell \u2014 honeypot detected");
  assert.equal(WARN.honeypot![0], HONEYPOT_BANNER);
  for (const [t, l] of Object.values(WARN)) assert.ok(!/do not buy|don't buy|safe/i.test(t + " " + l), t);
  // even an established-looking honeypot is not down-weighted
  assert.equal(scoreEvm({ is_honeypot: "1", is_in_cex: "1", is_mintable: "1" }, 5e6, 1000 * 24).score, 100);
});

test("50%+ sell tax / transfer fee = 80 (replaces the 10-49% tier); 10-49% = 25", async () => {
  assert.equal(pts(scoreEvm({ sell_tax: "0.5" }, 50000, 2000), "tax"), 80);
  assert.equal(pts(scoreEvm({ sell_tax: "0.99", buy_tax: "0" }, 50000, 2000), "tax"), 80);
  assert.equal(pts(scoreEvm({ sell_tax: "0.2" }, 50000, 2000), "tax"), 25);
  assert.equal(pts(scoreEvm({ sell_tax: "0.05" }, 50000, 2000), "tax"), 0);
  const fee = async (bps: number) => (await solEx({ extensions: [{ extension: "transferFeeConfig", state: { newerTransferFee: { transferFeeBasisPoints: bps } } }] })).checks.filter((x) => x.check === "transfer_fee").map((x) => x.points);
  assert.deepEqual(await fee(6000), [80]); assert.deepEqual(await fee(5000), [80]); assert.deepEqual(await fee(1500), [25]); assert.deepEqual(await fee(300), [5]); assert.deepEqual(await fee(0), []);
});

// solanaExtra with every network call answered 404 (no quote, no GoPlus): only mint-account + Jupiter-object checks fire.
async function solEx(mintInfo: any, jup: any = { usdPrice: 1, audit: {}, stats24h: {} }) {
  const of = globalThis.fetch; process.env.GOPLUS_SOL_WAIT_MS = "50";
  globalThis.fetch = (async () => new Response("{}", { status: 404 })) as typeof fetch;
  try { return await solanaExtra("TestMint1111111111111111111111111111111111", { jup, mintInfo, supply: 1e9, decimals: 6, liquidityUsd: 100000, dsAnswered: true, dsPairs: [] }); } finally { globalThis.fetch = of; }
}

test("no sell route = 60 on EVM (not stacked on a honeypot) and Solana", () => {
  const r = applyEvmSellWarnings([c("liquidity", 0)], { noRoute: true, impactPct: null }, 5000);
  assert.equal(pts({ reasons: r }, "sell_route"), 60);
  assert.equal(totalScore(r), 60);
  assert.equal(pts({ reasons: applyEvmSellWarnings([c("honeypot", 100)], { noRoute: true, impactPct: null }, 5000) }, "sell_route"), 0);
  assert.equal(scoreSolana({ ...base, extra: ex([c("sell_route", 60)]) }).level, "high");
});

test("Solana permanent_delegate + balance_mutable count 60 total, not 120", () => {
  const gp = goplusChecks(parseGoPlusSol({ balance_mutable_authority: { status: "1" }, closable: { status: "0" }, metadata_mutable: { status: "0" }, dex: [] })!);
  assert.equal(gp.find((x) => x.check === "balance_mutable")!.points, 60);
  const r = scoreSolana({ ...base, extra: ex([{ check: "permanent_delegate", points: 60, detail: "pd" }, ...gp]) });
  assert.equal(r.score, 60); assert.equal(r.level, "high");
  assert.equal(r.reasons.filter((x) => ["permanent_delegate", "balance_mutable"].includes(x.check)).reduce((a, x) => a + x.points, 0), 60);
  assert.ok(r.reasons.some((x) => x.check === "balance_mutable"), "second reason stays visible (0 points)");
  // raw totals dedupe even if a caller forgot to zero one
  assert.equal(totalScore([c("permanent_delegate", 60), c("balance_mutable", 60)]), 60);
  // each one alone forces high
  assert.equal(scoreSolana({ ...base, extra: ex([c("balance_mutable", 60)]) }).score, 60);
});

test("Token-2022 hard stops and high-danger extensions", async () => {
  const e = await solEx({ extensions: [{ extension: "permanentDelegate", state: { delegate: "D" } }, { extension: "transferHook", state: { programId: "H" } }, { extension: "defaultAccountState", state: { accountState: "frozen" } }] });
  const p = (k: string) => e.checks.find((x) => x.check === k)?.points;
  assert.equal(p("permanent_delegate"), 60); assert.equal(p("transfer_hook"), 15); assert.equal(p("transfer_control"), 50);
  assert.equal(scoreSolana({ ...base, extra: ex([c("transfer_control", 50)]) }).level, "high");
});

test("Jupiter suspicious flag = 20 only when isSus === true", async () => {
  assert.equal((await solEx({ extensions: [] }, { usdPrice: 1, audit: { isSus: true }, stats24h: {} })).checks.find((x) => x.check === "jupiter_sus")?.points, 20);
  assert.equal((await solEx({ extensions: [] }, { usdPrice: 1, audit: {}, stats24h: {} })).checks.find((x) => x.check === "jupiter_sus"), undefined);
});

test("Solana base weights: mint 40, freeze 35, holders 25/12, liquidity 20/10, age 8/4, history 25/12, repeat-rug 35, funder 30", () => {
  const p = (f: Partial<Facts>, k: string) => pts(scoreFacts({ ...base, ...f }), k);
  assert.equal(p({ mintAuthority: "X" }, "mint_authority"), 40); assert.equal(p({ freezeAuthority: "X" }, "freeze_authority"), 35);
  assert.equal(p({ top1Pct: 35, top10Pct: 50 }, "holders"), 25); assert.equal(p({ top10Pct: 45 }, "holders"), 12);
  assert.equal(p({ liquidityUsd: null }, "liquidity"), 20); assert.equal(p({ liquidityUsd: 3000 }, "liquidity"), 20); assert.equal(p({ liquidityUsd: 20000 }, "liquidity"), 10);
  assert.equal(p({ liquidityUsd: null, marketUnknown: true }, "liquidity"), 0);
  assert.equal(p({ ageHours: 5 }, "age"), 8); assert.equal(p({ ageHours: 48 }, "age"), 4);
  assert.equal(p({ priorLaunches: 5, priorDead: 4 }, "deployer_history"), 25); assert.equal(p({ priorLaunches: 5, priorDead: 1 }, "deployer_history"), 12);
  assert.equal(p({ creatorFlagged: true }, "known_pattern"), 35); assert.equal(p({ funderFlagged: true }, "shared_funder"), 30);
});

test("dead-token floor = 50 on Solana and EVM; never on unknown market", () => {
  const dead = scoreSolana({ ...base, liquidityUsd: null, ageHours: 24 * 30, extra: ex([], { canSell: "no route found" }) });
  assert.ok(dead.reasons.some((x) => x.check === "dead_token")); assert.equal(dead.score, 50); assert.equal(dead.level, "high");
  const evmDead = finishEvm(scoreEvm({ is_open_source: "1" }, 40, 24 * 30).reasons, { liquidityUsd: 40, ageHours: 24 * 30, volume24hUsd: 0, quote: null });
  assert.ok(evmDead.reasons.some((x) => x.check === "dead_token")); assert.equal(evmDead.score, 50); assert.equal(evmDead.level, "high");
  // unknown market, young, live volume, or a live sell route: no floor
  assert.ok(!finishEvm([], { marketUnknown: true, liquidityUsd: null, ageHours: 24 * 30 }).reasons.some((x) => x.check === "dead_token"));
  assert.ok(!finishEvm([], { liquidityUsd: 40, ageHours: 24 * 3, volume24hUsd: 0 }).reasons.some((x) => x.check === "dead_token"));
  assert.ok(!finishEvm([], { liquidityUsd: 40, ageHours: 24 * 30, volume24hUsd: 5000 }).reasons.some((x) => x.check === "dead_token"));
  assert.ok(!finishEvm([], { liquidityUsd: 40, ageHours: 24 * 30, volume24hUsd: 0, quote: { noRoute: false } }).reasons.some((x) => x.check === "dead_token"));
  assert.ok(!scoreSolana({ ...base, liquidityUsd: null, marketUnknown: true, ageHours: 24 * 30, extra: ex([]) }).reasons.some((x) => x.check === "dead_token"));
});

test("soft flags capped at 15 total; medium standalone flags are not capped", () => {
  const soft = [c("age", 8), c("no_socials", 3), c("metadata_mutable", 3), c("inorganic_volume", 3), c("first_minute_selling", 6), c("heavy_selling", 5), c("thin_trading", 3), c("known_snipers", 3), c("first_minute_thin", 3), c("proxy", 8), c("trading_cooldown", 10)];
  assert.equal(totalScore(soft), SOFT_CAP); assert.equal(SOFT_CAP, 15);
  const medium = [c("unverified", 10), c("closable", 10), c("sell_impact", 10), c("snipers", 12), c("snipers_holding", 10), c("liquidity_vs_mcap", 8)];
  assert.equal(totalScore(medium), 60);
  assert.equal(totalScore([...soft, ...medium]), 75);
  const noise = scoreSolana({ ...base, ageHours: 3, extra: ex([c("no_socials", 3), c("metadata_mutable", 3), c("inorganic_volume", 3), c("first_minute_selling", 6), c("first_minute_thin", 3)]) });
  assert.equal(noise.score, 15); assert.equal(noise.level, "low", "soft noise alone stays Low");
  // finalizeReport re-totals with the cap too
  const fin = finalizeReport({ chain: "solana", token: "T", riskScore: 14, riskLevel: "low", checks: [c("age", 8), c("no_socials", 3), c("metadata_mutable", 3)], reasons: [], facts: { volume24hUsd: 100, buys24h: 2, sells24h: 40, ageHours: 5, marketCapUsd: 1e6 } });
  assert.ok(fin.checks.some((x: any) => x.check === "thin_trading"));
  assert.equal(fin.riskScore, 15);
});

test("only_buys guard: 15+ buys, 0 sells, and 15+ min old or $1k+ volume; never on unknown counts or brand-new low-volume coins", () => {
  const w = (facts: any) => marketWarnings({ facts, checks: [] }).find((x) => x.check === "only_buys");
  assert.equal(w({ buys24h: 40, sells24h: 0, ageHours: 2, volume24hUsd: 500 })?.points, 40);
  assert.equal(w({ buys24h: 15, sells24h: 0, ageHours: 0.05, volume24hUsd: 1500 })?.points, 40);
  assert.equal(w({ buys24h: 20, sells24h: 0, ageHours: 2 / 60, volume24hUsd: 300 }), undefined, "2-minute low-volume coin");
  assert.equal(w({ buys24h: 14, sells24h: 0, ageHours: 5, volume24hUsd: 5000 }), undefined);
  assert.equal(w({ buys24h: 40, sells24h: 1, ageHours: 5, volume24hUsd: 5000 }), undefined);
  assert.equal(w({ buys24h: null, sells24h: 0, ageHours: 5, volume24hUsd: 5000 }), undefined);
  assert.equal(w({ buys24h: 40, sells24h: null, ageHours: 5, volume24hUsd: 5000 }), undefined);
  assert.equal(w({ buys24h: 40, sells24h: 0, ageHours: 5, volume24hUsd: 5000, marketUnknown: true }), undefined);
});

test("15 zero-cost EVM signals score as approved", () => {
  const p = (g: any, k: string) => pts(scoreEvm({ is_open_source: "1", holder_count: "50", ...g }, 50000, 2000), k);
  assert.equal(p({ owner_change_balance: "1" }, "owner_change_balance"), 60);
  assert.equal(p({ is_true_token: "0" }, "fake_token"), 50);
  assert.equal(p({ is_true_token: "1" }, "fake_token"), 0); assert.equal(p({}, "fake_token"), 0);
  assert.equal(p({ personal_slippage_modifiable: "1" }, "personal_tax"), 40);
  assert.equal(p({ selfdestruct: "1" }, "selfdestruct"), 40);
  assert.equal(p({ is_airdrop_scam: "1" }, "airdrop_scam"), 40);
  assert.equal(p({ cannot_buy: "1" }, "cannot_buy"), 30);
  assert.equal(p({ is_whitelisted: "1" }, "whitelist"), 25);
  assert.equal(p({ creator_percent: "0.25", creator_address: "0xabc" }, "dev_holding"), 25);
  assert.equal(p({ owner_percent: "0.3", owner_address: "0x000000000000000000000000000000000000dEaD" }, "dev_holding"), 0, "burn/zero owner ignored");
  assert.equal(p({ owner_percent: "0.3", owner_address: "0x0000000000000000000000000000000000000000" }, "dev_holding"), 0);
  assert.equal(p({ anti_whale_modifiable: "1" }, "anti_whale"), 15);
  assert.equal(p({ external_call: "1" }, "external_call"), 15);
  assert.equal(p({ trading_cooldown: "1" }, "trading_cooldown"), 10);
  assert.equal(p({ is_mintable: "1" }, "mint_function"), 40);
  assert.equal(p({ hidden_owner: "1", transfer_pausable: "1" }, "owner_control"), 60);
  assert.equal(p({ honeypot_with_same_creator: "2" }, "deployer_history"), 35);
  assert.equal(p({ is_proxy: "1" }, "proxy"), 8);
  assert.equal(p({ is_open_source: "0" }, "unverified"), 10);
  const soon = Math.floor(Date.now() / 1000) + 5 * 86400;
  assert.equal(p({ lp_holders: [{ address: "0xlocker", percent: "0.9", is_locked: 1, locked_detail: [{ amount: "100", end_time: String(soon) }] }, { address: "0xdead", percent: "0.1", is_locked: 1 }] }, "lp_short_lock"), 15);
  assert.equal(p({ lp_holders: [{ address: "0xlocker", percent: "0.9", is_locked: 1, locked_detail: [{ amount: "100", end_time: new Date(Date.now() + 365 * 864e5).toISOString() }] }] }, "lp_short_lock"), 0);
  // every hard stop alone is High
  for (const g of [{ owner_change_balance: "1" }, { is_true_token: "0" }, { sell_tax: "0.6" }]) assert.equal(scoreEvm({ is_open_source: "1", ...g }, 50000, 2000).level, "high", JSON.stringify(g));
});

test("LP lock end time parsing: unix s, unix ms, ISO; >50% of locked LP within 30 days", () => {
  const t = Date.UTC(2027, 0, 1);
  assert.equal(lockEndMs(t / 1000), t); assert.equal(lockEndMs(t), t); assert.equal(lockEndMs(String(t / 1000)), t); assert.equal(lockEndMs(new Date(t).toISOString()), t);
  assert.equal(lockEndMs(""), null); assert.equal(lockEndMs("nope"), null);
  const now = Date.UTC(2026, 11, 20);
  const r = lpShortLock([{ address: "0xa", percent: "0.6", is_locked: 1, locked_detail: [{ amount: "1", end_time: t / 1000 }] }, { address: "0xb", percent: "0.4", is_locked: 1, locked_detail: [{ amount: "1", end_time: t / 1000 + 400 * 86400 }] }], now)!;
  assert.ok(Math.abs(r.shortShare - 0.6) < 1e-9);
  assert.equal(lpShortLock([{ address: "0xa", percent: "1", is_locked: 1 }], now), null, "no lock dates -> unknown, not flagged");
});

test("established USDC/WETH/USDT-style tokens stay Low; admin flags 1/4, issuer balance control not scored", () => {
  const usdt = scoreEvm({ is_honeypot: "0", is_mintable: "1", is_blacklisted: "1", transfer_pausable: "1", slippage_modifiable: "1", owner_change_balance: "1", external_call: "1", is_open_source: "1", is_in_cex: { listed: "1", cex_list: ["Binance"] }, holder_count: "15974001" }, 2e8, 24 * 2000);
  assert.equal(usdt.level, "low", `USDT-style ${usdt.score}`);
  assert.equal(pts(usdt, "mint_function"), 10); assert.equal(pts(usdt, "owner_change_balance"), 0);
  assert.ok(usdt.reasons.find((x) => x.check === "owner_change_balance")!.detail.includes("established"));
  assert.equal(scoreEvm({ is_proxy: "1", is_open_source: "1", is_in_cex: { listed: "1" }, holder_count: "9484760" }, 3e8, 24 * 1500).level, "low");
  assert.equal(scoreEvm({ is_open_source: "1", holder_count: "5377196" }, 1e8, 24 * 1500).score, 0);
  const all = scoreEvm({ is_in_cex: "1", personal_slippage_modifiable: "1", is_whitelisted: "1", anti_whale_modifiable: "1", external_call: "1", trading_cooldown: "1", creator_percent: "0.3", creator_address: "0xabc" }, 1e8, 24 * 1000);
  for (const k of ["personal_tax", "whitelist", "anti_whale", "external_call", "trading_cooldown", "dev_holding"]) assert.ok(all.reasons.find((x) => x.check === k)!.detail.includes("down-weighted"), k);
  // airdrop scams and fake copies never get the established discount, even with huge holder counts
  const scam = scoreEvm({ is_airdrop_scam: "1", is_true_token: "0", holder_count: "500000", is_mintable: "1" }, 20000, 24 * 30);
  assert.ok(!scam.reasons.some((x) => x.check === "established")); assert.equal(scam.score, 100);
});

test("free check (limitedReport) counts every hard stop and trap: never Low on a steal/trap token", () => {
  const full = (chain: string, checks: any[]) => ({ chain, token: "T", riskScore: totalScore(checks), checks, facts: {} });
  const cases: [string, any[]][] = [
    ["base", [c("honeypot", 100)]], ["base", [c("sell_route", 60)]], ["base", [c("owner_change_balance", 60)]], ["base", [c("fake_token", 50)]], ["base", [c("tax", 80)]],
    ["solana", [c("permanent_delegate", 60)]], ["solana", [c("balance_mutable", 60)]], ["solana", [c("transfer_control", 50)]], ["solana", [c("transfer_fee", 80)]],
    ["solana", [c("dead_token", 50)]], ["base", [c("only_buys", 40), c("liquidity", 20)]], ["base", [c("selfdestruct", 40), c("age", 8)]], ["base", [c("airdrop_scam", 40)]],
  ];
  for (const [chain, checks] of cases) {
    const l: any = limitedReport(full(chain, checks));
    assert.notEqual(l.riskLevel, "low", JSON.stringify(checks));
    const fr = rrFree(checks, [...new Set(["mint_authority", "freeze_authority", "mint_function", "holders", "liquidity", "age", "dead_token", "sell_route", "sell_impact", "honeypot", "tax", "heavy_selling", "thin_trading", "liquidity_vs_mcap", "permanent_delegate", "balance_mutable", "owner_change_balance", "transfer_control", "fake_token", "transfer_fee", "owner_control", "only_buys", "selfdestruct", "airdrop_scam", "cannot_buy"])], WARN);
    assert.equal(fr.sc, l.riskScore, "share-card free score matches the free report " + JSON.stringify(checks));
  }
  for (const k of ["honeypot", "sell_route", "owner_change_balance", "fake_token", "permanent_delegate", "balance_mutable", "transfer_control"]) assert.equal(limitedReport(full("base", [c(k, k === "honeypot" ? 100 : 60)])).riskLevel, "high", k);
  assert.equal(limitedReport(full("base", [c("cannot_buy", 30)])).riskLevel, "medium");
  assert.equal(limitedReport(full("base", [c("owner_control", 30)])).riskLevel, "medium");
  // dedupe + soft cap carried into the free score
  assert.equal(limitedReport(full("solana", [c("permanent_delegate", 60), c("balance_mutable", 60)])).riskScore, 60);
  assert.equal(limitedReport(full("base", [c("age", 8), c("heavy_selling", 5), c("thin_trading", 3)])).riskScore, 15);
  // honeypot card shows the banner wording
  const hp: any = limitedReport(full("base", [c("honeypot", 100)]));
  assert.equal(hp.riskScore, 100); assert.ok(hp.reasons.includes(WARN.honeypot![1]));
  // paid-only signals stay locked out of the free score
  assert.equal(limitedReport(full("solana", [c("dev_sold", 20), c("bundled", 15)])).riskScore, 0);
});
