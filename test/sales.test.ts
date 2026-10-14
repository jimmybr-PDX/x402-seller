import { test } from "node:test";
import assert from "node:assert/strict";
import { summarize, isSale } from "../src/lib/sales.js";
test("sales summary windows and self/top-up filter", () => {
  const now = Date.parse("2026-10-14T00:00:00Z");
  const s = [{ at: "2026-10-13T22:00:00Z", from: "0xA", usd: 0.002, tx: "1" }, { at: "2026-10-10T00:00:00Z", from: "0xb", usd: 0.01, tx: "2" }, { at: "2026-09-01T00:00:00Z", from: "0xa", usd: 0.01, tx: "3" }];
  const r = summarize(s, now);
  assert.deepEqual(r.last24h, { payments: 1, usd: 0.002, payers: 1 });
  assert.deepEqual(r.last7d, { payments: 2, usd: 0.012, payers: 2 });
  assert.equal(r.last30d.payments, 2);
  assert.ok(!isSale("0x4862dac2c03fAA8B36A23D176932945193B04940", 0.01));
  assert.ok(!isSale("0xabc", 5));
});
