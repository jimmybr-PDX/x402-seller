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
  assert.match(RUG_EDGE, /^\$0\.02 per check/);
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

import { mapPumpV3Trade, pumpLaunch, pumpTradesUrl, PUMP_CHAIN } from "../src/lib/rug-extra.js";
import { __clearPaid, __peekStash } from "../src/lib/rug-paid.js";

const DEV = "AZHiexsgs5XvzSvfqmGwsQ3dhU5FFTXaqNCEy3BVknX1";
const v3 = (o: any = {}) => ({
  trader: { address: DEV }, side: "buy",
  baseAmount: { raw: "5046880804", decimals: 6 },
  valueNative: "0.000255367584872224", valueUsd: "0.0182868727527",
  blockTimeMs: 1795486786000, blockId: "473174638",
  ...o,
});

test("mapPumpV3Trade maps schema, including non-SOL (WBTC) quote via valueNative", () => {
  const m = mapPumpV3Trade(v3())!;
  assert.equal(m.userAddress, DEV);
  assert.equal(m.type, "buy");
  assert.equal(m.baseAmount, 5046880804 / 1e6);
  assert.equal(m.amountSol, 0.000255367584872224);
  assert.equal(m.amountUsd, 0.0182868727527);
  assert.equal(m.timestamp, new Date(1795486786000).toISOString());
  assert.equal(m.slotIndexId, "473174638");
  assert.equal(mapPumpV3Trade({ side: "buy" }), null);
  assert.equal(mapPumpV3Trade(v3({ side: "sell" }))!.type, "sell");
});

test("pumpTradesUrl uses frontend-api-v3 and cursor paging", () => {
  const u = pumpTradesUrl("By81XtEg4sWJkzd5aMoDCY5H2u7mFusoYk9X39vBpump");
  assert.match(u, /^https:\/\/frontend-api-v3\.pump\.fun\/trades\//);
  assert.ok(u.includes(PUMP_CHAIN));
  assert.ok(u.includes("limit=100"));
  assert.ok(!u.includes("cursor="));
  const u2 = pumpTradesUrl("Mint11111111111111111111111111111111111111", "abc+def");
  assert.ok(u2.includes("cursor=abc%2Bdef"));
  assert.ok(!u.includes("swap-api.pump.fun"));
});

test("pumpLaunch pages with cursor, stashes mapped trades, does not retry HTTP 410", async () => {
  __clearPaid();
  const mint = "By81XtEg4sWJkzd5aMoDCY5H2u7mFusoYk9X39vBpump";
  const calls: string[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: any) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("cursor=")) {
      return { ok: true, status: 200, json: async () => ({ trades: [v3({ side: "sell", blockId: "473174500", blockTimeMs: 1795486700000, valueNative: "0.001", baseAmount: { raw: "1000000", decimals: 6 } })], cursor: null }) };
    }
    return { ok: true, status: 200, json: async () => ({ trades: [v3()], cursor: "page2" }) };
  }) as any;
  try {
    const out = await pumpLaunch(mint, DEV, 1_000_000_000);
    assert.ok(out);
    assert.equal(out!.tradesSeen, 2);
    assert.equal(out!.historyComplete, true);
    assert.equal(out!.devBuys, 1);
    assert.equal(out!.devSells, 1);
    assert.equal(calls.length, 2);
    assert.ok(calls[0]!.includes(`/trades/${PUMP_CHAIN}/${mint}?limit=100`));
    assert.ok(calls[1]!.includes("cursor=page2"));
    const st = __peekStash(mint);
    assert.ok(st);
    assert.equal(st!.complete, true);
    assert.equal(st!.trades.length, 2);
    assert.equal(st!.trades[0]!.w, DEV);
    assert.equal(st!.trades[0]!.k, "buy");
    assert.equal(st!.trades[0]!.sol, 0.000255367584872224);
    assert.equal(st!.trades[0]!.amt, 5046880804 / 1e6);
    assert.equal(st!.trades[0]!.slot, "473174638");
    assert.equal(st!.trades[1]!.k, "sell");
  } finally { globalThis.fetch = real; }

  __clearPaid();
  const t0 = Date.now();
  let n = 0;
  globalThis.fetch = (async () => { n++; return { ok: false, status: 410, json: async () => ({ statusCode: 410 }) }; }) as any;
  try {
    const out = await pumpLaunch(mint, DEV, 1e9);
    assert.equal(out, null);
    assert.equal(n, 1, "410 must not be retried");
    assert.ok(Date.now() - t0 < 300, "410 should fail fast without the 400ms retry sleep");
    assert.equal(__peekStash(mint), null);
  } finally { globalThis.fetch = real; }
});
