/** Same token, flaky free sources: the score must not move. No network: fetch is mocked. */
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { rugCheck, __clearRugCaches } from "../src/lib/rug.js";
const MINT = "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN", DEV = "DevWa11et1111111111111111111111111111111111";
const realFetch = globalThis.fetch;
const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
function mock(failFirst: Set<string>, alwaysDown = new Set<string>()) {
  const seen = new Set<string>();
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = String(typeof input === "string" ? input : input.url);
    const kind = url.includes("jup.ag") ? "jupiter" : url.includes("dexscreener") ? "dexscreener" : "rpc";
    if (alwaysDown.has(kind) || (failFirst.has(kind) && !seen.has(kind))) { seen.add(kind); throw new Error("timeout"); }
    if (kind === "jupiter") return json([{ id: MINT, dev: DEV, createdAt: "2024-01-01T00:00:00Z", holderCount: 900000, launchpad: null, audit: { topHoldersPercentage: 35, devMints: 1, devMigrations: 0 } }]);
    if (kind === "dexscreener") return json([{ baseToken: { address: MINT }, quoteToken: { address: "So11111111111111111111111111111111111111112" }, dexId: "orca", liquidity: { usd: 2_000_000 }, priceUsd: "0.5", pairCreatedAt: Date.parse("2024-01-02") }]);
    const m = JSON.parse(String(init?.body)).method;
    if (m === "getAccountInfo") return json({ jsonrpc: "2.0", id: 1, result: { value: { owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", data: { parsed: { type: "mint", info: { decimals: 6, supply: "1000000000000000", mintAuthority: null, freezeAuthority: null } } } } } });
    if (m === "getSignaturesForAddress") return json({ jsonrpc: "2.0", id: 1, result: [{ signature: "sig1", blockTime: 1700000000 }] });
    return json({ jsonrpc: "2.0", id: 1, result: { transaction: { message: { accountKeys: [DEV], instructions: [{ parsed: { type: "transfer", info: { source: "Funder111", destination: DEV } } }] } }, meta: {} } });
  }) as typeof fetch;
}
afterEach(() => { globalThis.fetch = realFetch; __clearRugCaches(); });

test("same score across repeated runs while Jupiter / DexScreener fail once each (retry)", async () => {
  const scores: number[] = [];
  const flaky = [new Set<string>(), new Set(["jupiter"]), new Set(["dexscreener"]), new Set(["jupiter", "dexscreener"]), new Set<string>(), new Set(["dexscreener"])];
  for (const f of flaky) { __clearRugCaches(); mock(f); const r: any = await rugCheck(MINT); scores.push(r.riskScore); assert.equal(r.confidence, "high"); }
  assert.equal(new Set(scores).size, 1, `scores varied: ${scores}`);
});

test("market source fully down: liquidity is unknown and neutral (no +15), confidence drops", async () => {
  mock(new Set()); const ok: any = await rugCheck(MINT); __clearRugCaches();
  mock(new Set(), new Set(["dexscreener"])); const down: any = await rugCheck(MINT);
  assert.equal(down.riskScore, ok.riskScore);
  assert.equal(down.confidence, "medium");
  assert.ok(down.unknownSignals.includes("liquidity"));
});
