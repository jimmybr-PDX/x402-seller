import { test } from "node:test";
import assert from "node:assert/strict";
import { limitedReport } from "../src/lib/rugradar-web.js";

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
