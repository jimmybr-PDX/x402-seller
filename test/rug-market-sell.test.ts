import { test } from "node:test";
import assert from "node:assert/strict";
import { dsStats, fillMarketFacts, geckoMarket } from "../src/lib/rug.js";
import { evmSellAmount, evmSellQuote, applyEvmSellWarnings } from "../src/lib/evm-sell.js";
import { limitedReport, freeFacts } from "../src/lib/rugradar-web.js";
import { marketFactLine, shareData } from "../src/lib/rugradar-share.js";
import { riskBlock } from "../src/lib/rug-paid.js";
import { LIVE_JS } from "../src/lib/rugradar-live.js";

test("dsStats sums 24h volume and buys/sells; price change from the deepest pair", () => {
  const st = dsStats([
    { liquidity: { usd: 100 }, volume: { h24: 20 }, txns: { h24: { buys: 1, sells: 2 } }, priceChange: { h24: 1 } },
    { liquidity: { usd: 900 }, volume: { h24: 80 }, txns: { h24: { buys: 7, sells: 3 } }, priceChange: { h24: -6.46 } },
  ]);
  assert.deepEqual(st, { volume24hUsd: 100, buys24h: 8, sells24h: 5, priceChange24hPct: -6.46 });
  assert.deepEqual(dsStats([]), { volume24hUsd: null, buys24h: null, sells24h: null, priceChange24hPct: null });
});

test("fillMarketFacts prefers DexScreener facts and fills gaps from Jupiter-style stats", () => {
  assert.deepEqual(fillMarketFacts({ volume24hUsd: 10, buys24h: 1 }, { volume24hUsd: 99, buys24h: 8, sells24h: 3, priceChange24hPct: 2 }),
    { volume24hUsd: 10, buys24h: 1, sells24h: 3, priceChange24hPct: 2 });
});

test("geckoMarket copies 24h volume and price change from the same pools response", async () => {
  const mk = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
  const g = await geckoMarket("M", mk(200, { data: [{ attributes: { reserve_in_usd: "40", volume_usd: { h24: "12" }, price_change_percentage: { h24: "-1.5" } } }, { attributes: { reserve_in_usd: "10", volume_usd: { h24: "8" }, price_change_percentage: { h24: "9" } } }] }));
  assert.equal(g!.volume24hUsd, 20);
  assert.equal(g!.priceChange24hPct, -1.5);
});

test("evmSellAmount is exact for 18-decimal tokens; quote maps no-route and impact; warnings only on failure", async () => {
  const amt = evmSellAmount(0.02, 18);
  assert.ok(amt != null && amt === 5000n * 10n ** 18n);
  const no = await evmSellQuote("base", "0x" + "11".repeat(20), 1n, { fetch: (async () => new Response("{}", { status: 400 })) as typeof fetch });
  assert.deepEqual(no, { noRoute: true, impactPct: null });
  const ok = await evmSellQuote("base", "0x" + "11".repeat(20), 1n, { fetch: (async () => new Response(JSON.stringify({ code: 0, data: { routeSummary: { amountOut: "1", amountInUsd: "100", amountOutUsd: "70", gasUsd: "0.1" } } }), { status: 200 })) as typeof fetch });
  assert.equal(ok!.noRoute, false);
  assert.ok(Math.abs((ok!.impactPct ?? 0) - 29.9) < 0.05);
  const none = await evmSellQuote("base", "0x" + "11".repeat(20), 1n, { fetch: (async () => { throw new Error("timeout"); }) as typeof fetch });
  assert.equal(none, null);
  const r = applyEvmSellWarnings([{ check: "liquidity", points: 3, detail: "ok" }], { noRoute: true, impactPct: null }, 5000);
  assert.ok(r.some((x) => x.check === "sell_route" && x.points === 30));
  const skip = applyEvmSellWarnings([{ check: "honeypot", points: 40, detail: "blocked" }], { noRoute: true, impactPct: null }, 5000);
  assert.ok(!skip.some((x) => x.check === "sell_route"));
  assert.deepEqual(applyEvmSellWarnings([], null, 5000), []);
  const imp = applyEvmSellWarnings([{ check: "age", points: 0, detail: "" }], { noRoute: false, impactPct: 21 }, 5000);
  assert.ok(imp.some((x) => x.check === "sell_impact" && x.points === 10));
  assert.ok(!JSON.stringify(r).toLowerCase().includes("kyber") && !JSON.stringify(r).toLowerCase().includes("safe"));
});

test("limited free results include sell-fail warnings and 24h facts; never safe/sellable OK", () => {
  const full = { chain: "base", token: "0xabc", riskScore: 40,
    checks: [{ check: "honeypot", points: 40, detail: "internal" }, { check: "liquidity", points: 0, detail: "ok" }],
    facts: { volume24hUsd: 678, buys24h: 35, sells24h: 86, priceChange24hPct: -4.05 } };
  const lr: any = limitedReport(full);
  assert.ok(lr.checks.some((c: any) => c.check === "honeypot" && c.points === 40));
  assert.equal(lr.checks.find((c: any) => c.check === "honeypot").detail, "Selling looks blocked for holders.");
  assert.ok(lr.freeFacts[0].includes("24h"));
  assert.ok(lr.freeFacts[0].includes("35 buys / 86 sells"));
  const body = JSON.stringify(lr).toLowerCase();
  assert.ok(!body.includes("safe") && !body.includes("sellable ok") && !body.includes("based"));
});

test("share card carries a compact 24h fact when present", () => {
  assert.equal(marketFactLine({ volume24hUsd: 5400868, buys24h: 10, sells24h: 12, priceChange24hPct: -6.46 }), "24h $5.4M · 10 buys / 12 sells · -6.5%");
  const d = shareData({ riskScore: 10, facts: { tokenSymbol: "JUP", top10Pct: 40, liquidityUsd: 1_200_000, ageHours: 100, volume24hUsd: 5400868, buys24h: 10, sells24h: 12, priceChange24hPct: -6.4 } }, [], "low", "T", "solana");
  assert.ok(d.facts[0].startsWith("24h $5.4M"));
  assert.ok(d.facts.includes("Top 10 hold 40%"));
  assert.ok(d.facts.includes("Liquidity $1.2M"));
  assert.ok(!d.facts.some((x) => x.startsWith("Age ")));
});

test("paid risk block exposes 24h facts; live script warns only when the sell test fails", () => {
  const r = riskBlock({ facts: { volume24hUsd: 100, buys24h: 2, sells24h: 3, priceChange24hPct: 1.2, mintAuthority: null }, buyer: { canSell: "yes (Jupiter route)", sellPriceImpactPct: 0.2, transferFeePct: 0 } });
  assert.equal(r.volume24hUsd, 100);
  assert.equal(r.canSell, "yes");
  assert.ok(LIVE_JS.includes("if(R.canSell==='no')"));
  assert.ok(!/Can you sell\?/.test(LIVE_JS));
  assert.ok(LIVE_JS.includes("24h volume"));
  assert.ok(!/\b(sellable ok|safe|SAFE|BASED)\b/.test(LIVE_JS));
});
