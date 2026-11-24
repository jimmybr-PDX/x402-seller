import { test } from "node:test";
import assert from "node:assert/strict";
import { limitedReport, primeFromLimited } from "../src/lib/rugradar-web.js";
import { cachedShare, __resetShare } from "../src/lib/rugradar-share.js";

test("basic free result: count + teaser only, no hidden warning text or sell test", () => {
  const full = { chain: "solana", token: "T", facts: { sellable: false }, sellTest: { ok: false, impactPct: 99 },
    checks: [
      { check: "mint_authority", points: 20, detail: "Mint on" },
      { check: "sell_route", points: 30, detail: "SECRET no sell route" },
      { check: "dev_sold", points: 15, detail: "SECRET dev sold 90%" },
    ] };
  const lr: any = limitedReport(full);
  assert.equal(lr.hiddenWarnings, 2);
  assert.equal(lr.lockedTeaser, "2 more warnings in the full report, includes live chart and can-you-sell");
  const body = JSON.stringify(lr);
  assert.ok(!body.includes("SECRET"));
  assert.ok(!body.includes("sellTest") && !body.includes("sell_route") && !body.includes("impactPct"));
});

test("limitedReport passes marketUnknown; primeFromLimited skips truly unknown market cards", () => {
  __resetShare();
  const token = "By81XtEg4sWJkzd5aMoDCY5H2u7mFusoYk9X39vBpump";
  const base = {
    product: "RugRadar", chain: "solana", token, riskScore: 25, riskLevel: "medium",
    checks: [
      { check: "liquidity", points: 15, detail: "Very thin liquidity ($3498)." },
      { check: "age", points: 10, detail: "Very new: 18.8 hours old." },
    ],
    facts: { tokenName: "Get The Fuck Outside", tokenSymbol: "GTFO", liquidityUsd: 3497.5, ageHours: 18.8, top10Pct: 7.5, marketUnknown: false },
  };
  const ok = limitedReport(base);
  assert.equal(ok.facts.marketUnknown, false);
  assert.equal(ok.facts.liquidityUsd, 3497.5);
  primeFromLimited(ok, token, "solana");
  assert.ok(cachedShare("solana", token), "known-liquidity free reports may prime the share cache");

  __resetShare();
  const bad = limitedReport({ ...base, checks: [{ check: "liquidity", points: 0, detail: "Liquidity unknown (market data source did not answer); scored neutral." }, { check: "age", points: 10, detail: "Very new: 18.8 hours old." }], facts: { ...base.facts, marketUnknown: true } });
  assert.equal(bad.facts.marketUnknown, true);
  primeFromLimited(bad, token, "solana");
  assert.equal(cachedShare("solana", token), null, "truly unknown market must not cache a share card");
});
