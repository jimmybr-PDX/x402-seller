import test from "node:test";
import assert from "node:assert/strict";
import { parseTrades, heliusLaunchTrades, fallbackAllowed, fallbackSpent, curvePda, __resetHeliusGuard, __spendForTest, FALLBACK_DAILY_CREDITS } from "../src/lib/rug-helius.js";
import { walletRows } from "../src/lib/rug-paid.js";

const MINT = "CKPQco1aa1piwuMCWEyUHDz4UrY8nZUT4XXnPsmhpump", CURVE = "4oVNsq2WJbd7W3yqDnq3Sp4ZsXj875D8BQvrrF8wZqLu";
const DEV = "EDRnjSjSLSeNJY88S2Q7vtJ2gXr6CrFvwFLj4tQeaTAw", S1 = "AMDEmVAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA".slice(0, 44), S2 = "8fN6NyBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB".slice(0, 44);
const tb = (owner: string, ui: number) => ({ mint: MINT, owner, uiTokenAmount: { uiAmountString: String(ui), uiAmount: ui, decimals: 6 } });
// trimmed jsonParsed getTransaction shape (fixture): [curve lamports pre, post], token balances of the mint
const tx = (slot: number, bt: number, lam: [number, number], pre: any[], post: any[], err: any = null) => ({ slot, blockTime: bt, meta: { err, preBalances: [5e9, lam[0]], postBalances: [5e9, lam[1]], preTokenBalances: pre, postTokenBalances: post }, transaction: { message: { accountKeys: [{ pubkey: DEV, signer: true }, { pubkey: CURVE, signer: false }] } } });
const FIX = [
  tx(100, 1000, [0, 280_000_000], [], [tb(CURVE, 990e6), tb(DEV, 10e6)]),                         // create + dev buy 0.28 SOL
  tx(101, 1000, [280_000_000, 880_000_000], [tb(CURVE, 990e6), tb(DEV, 10e6)], [tb(CURVE, 970e6), tb(DEV, 10e6), tb(S1, 20e6)]), // sniper S1 buys 0.6 SOL
  tx(101, 1001, [880_000_000, 1_370_000_000], [tb(CURVE, 970e6)], [tb(CURVE, 955e6), tb(S2, 15e6)]), // sniper S2 buys 0.49 SOL, same slot
  tx(130, 1030, [1_370_000_000, 740_000_000], [tb(CURVE, 955e6), tb(S1, 20e6)], [tb(CURVE, 975e6), tb(S1, 0)]), // S1 sells everything
  tx(131, 1031, [740_000_000, 740_000_000], [], [], { InstructionError: 1 }),                   // failed tx ignored
];

test("helius parsing: buyer, side, SOL, slot and time come from the curve and token balance changes", () => {
  const t = parseTrades(FIX, MINT, CURVE);
  assert.deepEqual(t.map((x) => [x.w === DEV ? "dev" : x.w === S1 ? "s1" : "s2", x.k, +x.sol.toFixed(2), x.slot, x.ts]), [["dev", "buy", 0.28, "100", 1_000_000], ["s1", "buy", 0.6, "101", 1_000_000], ["s2", "buy", 0.49, "101", 1_001_000], ["s1", "sell", 0.63, "130", 1_030_000]]);
  assert.equal(t[1]!.amt, 20e6);
  assert.deepEqual(parseTrades([null as any, {}], MINT, CURVE), []);
});
test("helius trades feed the existing wallet rows: snipers marked holding or sold, bundle = launch slot, dev excluded", () => {
  const t = parseTrades(FIX, MINT, CURVE);
  const r = walletRows(t, true, DEV, 1e9, new Map([[DEV, 10e6], [S1, 0], [S2, 15e6]]));
  assert.equal(r.sn.count, 2); assert.equal(r.sn.snipers, 2); assert.equal(r.sn.bundled, 0);
  assert.deepEqual(r.sn.shown.map((w: any) => [w.address === S1 ? "s1" : "s2", w.status]), [["s1", "sold"], ["s2", "holding"]]);
  assert.equal(r.sn.stillHolding, 1); assert.equal(r.sn.nowPct, 1.5); assert.equal(r.dev![0]!.status, "holding");
  assert.ok(!JSON.stringify(r).match(/name|inflow|graduat|funder/i));
});
test("curve PDA derivation matches the on-chain bonding curve for the fixture mint", async () => { assert.equal(await curvePda(MINT), CURVE); });
test("helius read: 1 sigs call + 1 batched tx call = 1 + N credits, oldest first; daily guard skips and failures return null", async () => {
  const realFetch = globalThis.fetch, oldKey = process.env.HELIUS_API_KEY; process.env.HELIUS_API_KEY = "test-key"; __resetHeliusGuard();
  const bodies: any[] = [];
  globalThis.fetch = (async (_u: any, init: any) => {
    const b = JSON.parse(init.body); bodies.push(b);
    if (!Array.isArray(b)) return new Response(JSON.stringify({ result: [...FIX].reverse().map((x, i) => ({ signature: `sig${i}`, err: x.meta.err ? {} : null })) }));
    return new Response(JSON.stringify(b.map((q: any, i: number) => ({ id: q.id, result: FIX[FIX.length - 1 - Number(q.params[0].slice(3))] })).reverse()));
  }) as any;
  try {
    const r = await heliusLaunchTrades(MINT);
    assert.equal(r!.credits, 1 + 4); assert.equal(fallbackSpent(), 5); assert.equal(r!.complete, true); assert.equal(r!.trades.length, 4);
    assert.equal(bodies[0].method, "getSignaturesForAddress"); assert.equal(bodies[0].params[0], CURVE); assert.equal(bodies[1].length, 4);
    assert.ok(JSON.stringify(bodies).indexOf("test-key") < 0);
    // failure (HTTP 429) -> plain unavailable (null), logged with the [rug-paid] prefix and no key
    __resetHeliusGuard(); const warn = console.warn; const logged: string[] = []; console.warn = (m: string) => { logged.push(String(m)); };
    try { globalThis.fetch = (async () => new Response("no", { status: 429 })) as any; assert.equal(await heliusLaunchTrades(MINT), null); } finally { console.warn = warn; }
    assert.ok(logged[0]!.startsWith("[rug-paid] helius") && !logged.join("").includes("test-key"));
    // daily guard: fallback spend over the cap skips the fallback without any request
    __spendForTest(FALLBACK_DAILY_CREDITS); assert.equal(fallbackAllowed(), false);
    globalThis.fetch = (async () => { throw new Error("must not be called"); }) as any;
    assert.equal(await heliusLaunchTrades(MINT), null); assert.ok(FALLBACK_DAILY_CREDITS <= 5000);
  } finally { globalThis.fetch = realFetch; if (oldKey === undefined) delete process.env.HELIUS_API_KEY; else process.env.HELIUS_API_KEY = oldKey; }
});
test("no key -> fallback not allowed (plain unavailable)", () => {
  const old = [process.env.HELIUS_API_KEY, process.env.GROKBOT_API_KEY]; delete process.env.HELIUS_API_KEY; delete process.env.GROKBOT_API_KEY;
  try { assert.equal(fallbackAllowed(), false); } finally { if (old[0] !== undefined) process.env.HELIUS_API_KEY = old[0]; if (old[1] !== undefined) process.env.GROKBOT_API_KEY = old[1]; }
});
