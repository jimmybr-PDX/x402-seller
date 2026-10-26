import test from "node:test";
import assert from "node:assert/strict";
import { walletRows, riskBlock, chartUrl, stashTrades, liveReport, __clearPaid } from "../src/lib/rug-paid.js";
import { LIVE_JS } from "../src/lib/rugradar-live.js";

const A = (c: string) => c.repeat(44).slice(0, 44);
const tr = (w: string, k: "buy" | "sell", amt: number, ts: number, slot = "0001") => ({ w, k, sol: 1, usd: 150, amt, ts, slot });
test("wallet rows: dev sold = sold, sniper holding vs sold, share start vs now, capped list", () => {
  const dev = A("D"), s1 = A("E"), s2 = A("F");
  const t = [tr(dev, "buy", 100, 0), tr(s1, "buy", 50, 1000), tr(s2, "buy", 30, 2000), tr(dev, "sell", 100, 5000), tr(s2, "sell", 30, 6000), tr(A("G"), "buy", 10, 20000, "0009")];
  const r = walletRows(t, true, dev, 1000, null);
  assert.equal(r.dev![0]!.status, "sold"); assert.equal(r.dev![0]!.holdingPct, 0);
  assert.equal(r.sn.count, 2); assert.equal(r.sn.startPct, 8); assert.equal(r.sn.nowPct, 5); assert.equal(r.sn.stillHolding, 1);
  assert.deepEqual(r.sn.shown.map((x: any) => [x.address === s1, x.status]), [[true, "holding"], [false, "sold"]]);
  const withBal = walletRows(t, true, dev, 1000, new Map([[dev, 20]]));
  assert.equal(withBal.dev![0]!.status, "holding"); assert.equal(withBal.dev![0]!.holdingPct, 2);
  const many = Array.from({ length: 15 }, (_, i) => tr(A(String.fromCharCode(97 + i)), "buy", 10 + i, 1000 + i));
  assert.equal(walletRows([tr(dev, "buy", 5, 0), ...many], true, dev, 1000, null).sn.shown.length, 10);
});
test("incomplete history: no sniper block; unknown balance is omitted, not a warning", () => {
  const dev = A("D"), t = [tr(dev, "buy", 100, 0), tr(A("E"), "buy", 5, 500)];
  assert.equal(walletRows(t, false, dev, 1000, null).sn, null);
  assert.equal(walletRows([], false, dev, 1000, null).dev, null);
});
test("risk block: failed sell lookup is 'unknown', not 'no'", () => {
  const r = riskBlock({ facts: { mintAuthority: null, freezeAuthority: "X", top10Pct: 12 }, buyer: { canSell: "unknown", transferFeePct: 0 } });
  assert.equal(r.canSell, "unknown"); assert.equal(r.mintAuthority, "off"); assert.equal(r.freezeAuthority, "on"); assert.equal(r.taxPct, 0);
  assert.equal(riskBlock({}).mintAuthority, "unknown");
});
test("liveReport never throws and keeps risk when lookups fail; chart url is the 1m embed", async () => {
  __clearPaid();
  const o = await liveReport("not-a-mint", { facts: { creator: "bad", supply: 1 } });
  assert.ok(o.risk && o.generatedAt);
  assert.match(chartUrl(A("P")), /^https:\/\/www\.geckoterminal\.com\/solana\/pools\/P+\?embed=1&info=0&swaps=0&grayscale=0&light_chart=0&chart_type=price&resolution=1m$/);
  stashTrades("x", [], true);
});
test("live.js: parses, no wallet names, advice-free", () => {
  new Function(LIVE_JS);
  assert.ok(!/\b(buy now|sell now|safe)\b/i.test(LIVE_JS));
});
