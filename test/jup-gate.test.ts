import { test } from "node:test";
import assert from "node:assert/strict";
import { jupFetch, background, _resetGate, jupGateStat, RESERVE } from "../src/lib/jup-gate.js";

const real = globalThis.fetch;
const resp = (status: number, remaining: number, resetSec: number) =>
  new Response("[]", { status, headers: { "x-ratelimit-remaining": String(remaining), "x-ratelimit-reset": String(resetSec) } });

test("background work leaves the last requests in the window for people", async (t) => {
  t.after(() => { globalThis.fetch = real; });
  _resetGate(); let n = 0; const reset = Math.floor(Date.now() / 1000) + 8;
  globalThis.fetch = (async () => { n++; return resp(200, RESERVE, reset); }) as any;
  await background.run(true, () => jupFetch("https://lite-api.jup.ag/x")); // learns remaining = RESERVE
  const bg = await background.run(true, () => jupFetch("https://lite-api.jup.ag/x"));
  assert.equal(bg, null); assert.equal(jupGateStat.skippedBackground, 1); assert.equal(n, 1);
  const user = await jupFetch("https://lite-api.jup.ag/x"); // a person's check still goes through
  assert.ok(user?.ok); assert.equal(n, 2);
});

test("after a 429 a person's check waits for a short window instead of failing", async (t) => {
  t.after(() => { globalThis.fetch = real; });
  _resetGate(); let n = 0; const t0 = Date.now();
  globalThis.fetch = (async () => { n++; return n === 1 ? resp(429, 0, Math.ceil((t0 + 400) / 1000)) : resp(200, 4, Math.ceil(t0 / 1000) + 10); }) as any;
  const r1 = await jupFetch("https://lite-api.jup.ag/x"); assert.equal(r1?.status, 429);
  const r2 = await jupFetch("https://lite-api.jup.ag/x"); assert.equal(r2?.status, 200);
  assert.equal(jupGateStat.rateLimited, 1);
});
