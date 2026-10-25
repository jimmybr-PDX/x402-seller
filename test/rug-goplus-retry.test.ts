/** GoPlus transient failures on EVM chains: retry (shared cooldown), plain-English busy message, nothing cached. No network. */
import { test, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { rugCheck, __clearRugCaches, __setGoplusBackoff, RugBusyError } from "../src/lib/rug.js";
import { SolanaInputError } from "../src/lib/solana.js";
const PEPE = "0x6982508145454Ce325dDbE47a25d4ec3d2311933";
const realFetch = globalThis.fetch;
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
const GOOD = { code: 1, result: { [PEPE.toLowerCase()]: { token_symbol: "PEPE", holder_count: "500000", is_open_source: "1" } } };
/** plan: GoPlus responses in order (last one repeats). */
function mock(plan: Array<() => Response | Promise<Response>>) {
  const calls = { goplus: 0 };
  globalThis.fetch = (async (input: any) => {
    const url = String(typeof input === "string" ? input : input.url);
    if (url.includes("gopluslabs")) { const f = plan[Math.min(calls.goplus, plan.length - 1)]!; calls.goplus++; return f(); }
    return json([{ liquidityUsd: 1, liquidity: { usd: 5_000_000 }, priceUsd: "0.00001", pairCreatedAt: Date.parse("2023-04-01") }]);
  }) as typeof fetch;
  return calls;
}
beforeEach(() => { __clearRugCaches(); __setGoplusBackoff([5, 10]); });
afterEach(() => { globalThis.fetch = realFetch; __clearRugCaches(); __setGoplusBackoff([600, 1500]); });

test("one empty/busy GoPlus answer is retried and the check succeeds", async () => {
  const calls = mock([() => json({ code: 4029, message: "rate limited", result: null }), () => json(GOOD)]);
  const r: any = await rugCheck(PEPE, "ethereum");
  assert.equal(r.facts.token, "PEPE"); assert.equal(calls.goplus, 2);
});
test("HTTP 429, then network error, then success (2 retries max)", async () => {
  const calls = mock([() => json({}, 429), () => { throw new Error("timeout"); }, () => json(GOOD)]);
  const r: any = await rugCheck(PEPE, "ethereum");
  assert.equal(r.facts.token, "PEPE"); assert.equal(calls.goplus, 3);
});
test("still busy after retries: plain-English busy error, not cached, and the next call recovers", async () => {
  const calls = mock([() => json({}, 503)]);
  await assert.rejects(() => rugCheck(PEPE, "ethereum"), (e: any) => e instanceof RugBusyError && !(e instanceof SolanaInputError) && e.message === "The data source is busy. Try again in a few seconds");
  assert.equal(calls.goplus, 3);
  mock([() => json(GOOD)]); // failure must not have been cached (neither stable nor result cache)
  const r: any = await rugCheck(PEPE, "ethereum");
  assert.equal(r.facts.token, "PEPE"); assert.notEqual(r.cached, true);
});
test("shared cooldown: after a full failure, the next requests make a single attempt (no retry storm)", async () => {
  const calls = mock([() => json({}, 503)]);
  await assert.rejects(() => rugCheck(PEPE, "ethereum"), RugBusyError);
  const before = calls.goplus;
  await Promise.all([1, 2, 3, 4, 5].map((i) => rugCheck(`0x${String(i).repeat(40)}`, "base").catch(() => null)));
  assert.equal(calls.goplus - before, 5);
});
test("GoPlus answers OK but has no data: distinct 'doesn't look like a token' message (after retries)", async () => {
  const calls = mock([() => json({ code: 1, message: "OK", result: {} })]);
  await assert.rejects(() => rugCheck(PEPE, "ethereum"), (e: any) => e instanceof SolanaInputError && e.message === "This doesn't look like a token on ethereum");
  assert.equal(calls.goplus, 3);
});
