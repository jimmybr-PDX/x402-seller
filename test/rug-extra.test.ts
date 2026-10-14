import { test } from "node:test";
import assert from "node:assert/strict";
import { evmExtra, buyerSummary, solanaExtra, RUG_EDGE } from "../src/lib/rug-extra.js";

test("evmExtra maps GoPlus + DexScreener into buyer fields", () => {
  const e = evmExtra({ is_honeypot: "0", buy_tax: "0.05", sell_tax: "0.1", is_mintable: "1", creator_percent: "0.12", lp_holders: [{ address: "0x000000000000000000000000000000000000dead", percent: "0.9" }] },
    [{ marketCap: 1_000_000, fdv: 1_000_000, liquidity: { usd: 50_000 }, volume: { h24: 20_000 }, txns: { h24: { buys: 10, sells: 4 } }, priceChange: { h1: 1, h24: -5 }, info: { socials: [{ type: "twitter" }], websites: [{}] } }]);
  assert.equal(e.sellTaxPct, 10); assert.equal(e.mintable, true); assert.equal(e.creatorHoldingPct, 12); assert.equal(e.lpLockedOrBurnedPct, 90);
  assert.equal(e.liquidityToMcapPct, 5); assert.equal(e.buys24h, 10); assert.deepEqual(e.socials.sort(), ["twitter", "website"]);
});

test("buyer summary uses high-risk-pattern wording, never 'scammer'", () => {
  for (const l of ["high", "medium", "low"]) { const s = buyerSummary(l, ["x."], "medium"); assert.ok(!/scam/i.test(s)); }
  assert.match(buyerSummary("high", [], "high"), /high-risk patterns/);
  assert.match(RUG_EDGE, /^\$0\.01 per check/);
});

test("solanaExtra flags permanent delegate and missing sell route; unknowns when sources fail", async () => {
  const real = globalThis.fetch;
  globalThis.fetch = (async () => ({ ok: true, json: async () => ({ errorCode: "COULD_NOT_FIND_ANY_ROUTE" }) })) as any; // Jupiter: no route
  try {
    const x = await solanaExtra("Mint1111111111111111111111111111111111111", { jup: { usdPrice: 1, mcap: 100000, audit: { devBalancePercentage: 30 } }, mintInfo: { extensions: [{ extension: "permanentDelegate", state: { delegate: "D" } }] }, dsPairs: [], supply: 1e9, decimals: 6, liquidityUsd: 20000 });
    const c = x.checks.map((k) => k.check);
    assert.ok(c.includes("permanent_delegate")); assert.ok(c.includes("sell_route")); assert.ok(c.includes("dev_holding"));
    globalThis.fetch = (async () => { throw new Error("down"); }) as any;
    const y = await solanaExtra("Mint1111111111111111111111111111111111111", { jup: null, mintInfo: {}, dsPairs: [], supply: 1e9, decimals: 6, liquidityUsd: null });
    assert.ok(y.unknown.includes("sell route")); assert.ok(!y.checks.some((k) => k.check === "sell_route"));
  } finally { globalThis.fetch = real; }
});
