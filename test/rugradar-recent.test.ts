import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import express from "express";
import type { AddressInfo } from "node:net";
import { registerRugradarWeb, __resetFree } from "../src/lib/rugradar-web.js";
import { createRecent, RECENT_MAX, RECENT_TTL_MS, RECENT_ENTRY_BYTES, type RecentStore } from "../src/lib/rugradar-recent.js";
process.env.CREDITS_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "rec-")), "credits.json"); delete process.env.RENDER;
const credits = await import("../src/lib/credits.js");

const memStore = () => { const m = new Map<string, any>(); let saves = 0; const s: RecentStore = { load: async (n) => m.get(n) ?? null, save: async (docs) => { saves++; for (const [n, d] of Object.entries(docs)) { if (d === null) m.delete(n); else m.set(n, JSON.parse(JSON.stringify(d))); } } }; return { m, s, saves: () => saves }; };
const rep = (token: string, o: any = {}) => ({ product: "RugRadar", chain: "solana", token, riskScore: 40, riskLevel: "medium", facts: { token: "PEPE" }, liveReport: { trades: [1] }, ...o });
const A = (n: number) => `Mint${String(n).padStart(40, "0")}`;

test("save: stores name, address, chain, score, time; name falls back to short address; key never stored", async () => {
  const st = memStore(), r = createRecent(st.s, { now: () => 1000 });
  assert.equal(await r.save("rr_k1", rep(A(1))), true);
  assert.equal(await r.save("rr_k1", rep(A(2), { facts: {} })), true);
  const l = await r.list("rr_k1");
  assert.equal(l.length, 2); assert.equal(l[0]!.name, "Mint\u2026000002"); assert.equal(l[1]!.name, "$PEPE"); assert.equal(l[1]!.score, 40); assert.equal(l[1]!.at, 1000); assert.equal(l[1]!.chain, "solana");
  assert.ok(!("report" in l[0]!), "list carries no reports");
  await r.flush();
  assert.ok(!JSON.stringify([...st.m]).includes("rr_k1"));
  assert.deepEqual(await r.list("rr_other"), []);
});
test("cap 20, newest first; dedupe by chain+address (re-unlock moves to top, EVM case-insensitive)", async () => {
  const st = memStore(), r = createRecent(st.s);
  for (let i = 1; i <= 25; i++) await r.save("rr_k", rep(A(i)));
  let l = await r.list("rr_k"); assert.equal(l.length, RECENT_MAX); assert.equal(l[0]!.address, A(25)); assert.equal(l[19]!.address, A(6));
  await r.save("rr_k", rep(A(10), { riskScore: 77 }));
  l = await r.list("rr_k"); assert.equal(l.length, 20); assert.equal(l[0]!.address, A(10)); assert.equal(l[0]!.score, 77); assert.equal(l.filter((x) => x.address === A(10)).length, 1);
  await r.save("rr_k", rep(A(10), { chain: "base" })); assert.equal((await r.list("rr_k")).filter((x) => x.address === A(10)).length, 2, "other chain is a different entry");
  const ev = "0xAbCdEf0123456789aBcDeF0123456789AbCdEf01";
  await r.save("rr_e", rep(ev, { chain: "base" })); await r.save("rr_e", rep(ev.toLowerCase(), { chain: "base" })); assert.equal((await r.list("rr_e")).length, 1);
});
test("entries expire after 30 days and are removed from the store", async () => {
  const st = memStore(); let t = 1_000_000; const r = createRecent(st.s, { now: () => t });
  await r.save("rr_k", rep(A(1))); t += RECENT_TTL_MS - 1000; await r.save("rr_k", rep(A(2)));
  assert.equal((await r.list("rr_k")).length, 2);
  t += 2000; const l = await r.list("rr_k"); assert.deepEqual(l.map((x) => x.address), [A(2)]);
  assert.equal(await r.get("rr_k", "solana", A(1)), null);
  t += RECENT_TTL_MS; assert.deepEqual(await r.list("rr_k"), []); await r.flush(); assert.equal(st.m.size, 0, "empty doc deleted");
});
test("per-entry size cap: oversized live blocks are dropped, still-too-big reports are not saved", async () => {
  const st = memStore(), r = createRecent(st.s);
  assert.equal(await r.save("rr_k", rep(A(1), { liveReport: { x: "a".repeat(RECENT_ENTRY_BYTES) } })), true);
  const it = await r.get("rr_k", "solana", A(1)); assert.ok(it && !(it.report as any).liveReport);
  assert.equal(await r.save("rr_k", rep(A(2), { buyerSummary: "a".repeat(RECENT_ENTRY_BYTES) })), false);
  assert.equal(await r.save("rr_k", { token: A(3) }), false, "no score: not saved");
});
test("writes are batched into one debounced commit and survive a failed write", async () => {
  const st = memStore(); let fail = true; const s: RecentStore = { load: st.s.load, save: async (d, m) => { if (fail) throw new Error("x"); return st.s.save(d, m); } };
  const r = createRecent(s, { flushMs: 20 });
  for (let i = 1; i <= 5; i++) await r.save("rr_k", rep(A(i)));
  await new Promise((x) => setTimeout(x, 60)); assert.equal(st.saves(), 0); assert.equal(r.pendingCount(), 1); assert.equal((await r.list("rr_k")).length, 5, "unflushed data still readable");
  fail = false; await r.flush(); assert.equal(st.saves(), 1); assert.equal(r.pendingCount(), 0); assert.equal(st.m.size, 1);
  assert.equal((await createRecent(st.s).list("rr_k")).length, 5, "a fresh instance reads what was written");
});
test("durable store: same credits store, doc named by key hash, key never on disk", async () => {
  const { key } = await credits.issueKey(3, "recent-t1");
  const r = createRecent({ load: (n) => credits.loadDoc<any>(n, null), save: (d, m) => credits.saveDocs(d, m) });
  await r.save(key, rep(A(1))); await r.flush();
  const dir = path.dirname(process.env.CREDITS_FILE!), files = fs.readdirSync(dir).filter((n) => n.startsWith("recent-"));
  assert.equal(files.length, 1); assert.ok(files[0]!.includes(credits.hashKey(key).slice(0, 32)));
  for (const n of fs.readdirSync(dir)) assert.ok(!fs.readFileSync(path.join(dir, n), "utf8").includes(key), n);
  assert.equal((await createRecent({ load: (n) => credits.loadDoc<any>(n, null), save: (d, m) => credits.saveDocs(d, m) }).list(key)).length, 1);
});

async function start() {
  const app = express(); app.set("trust proxy", 1);
  const keys = new Map([["rr_good", 5], ["rr_other", 5], ["rr_empty", 0]]); let spends = 0;
  const recent = createRecent(memStore().s);
  const srv = app.listen(0), base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  registerRugradarWeb(app, { publicUrl: base, port: 0, priceUsd: "0.01", speed: null, recent, balance: async (k) => keys.get(k) ?? null,
    rugCheck: async (t) => ({ product: "RugRadar", chain: "solana", token: t, riskScore: 20, riskLevel: "low", checks: [], facts: {} }),
    spend: async (k) => { spends++; const n = keys.get(k); if (!n) return null; keys.set(k, n - 1); return n - 1; }, refund: async () => {} });
  return { srv, base, recent, spends: () => spends, keys };
}
test("endpoints: need a valid key every time; list and report are free and only for the owning key", async () => {
  __resetFree(); const { srv, base, recent, spends, keys } = await start();
  try {
    await recent.save("rr_good", rep(A(1), { riskScore: 61, buyerSummary: "FULL" }));
    const get = (p: string, k?: string) => fetch(`${base}${p}`, { headers: k ? { "x-rugradar-key": k } : {} });
    for (const p of ["/rugradar/api/recent", `/rugradar/api/recent/report?chain=solana&token=${A(1)}`]) {
      assert.equal((await get(p)).status, 401); assert.equal((await get(p, "rr_nope")).status, 401); assert.equal((await get(p, "rr_good".repeat(60))).status, 401);
    }
    assert.equal((await (await get("/rugradar/api/recent")).json()).error, "missing_key");
    const l = await (await get("/rugradar/api/recent", "rr_good")).json();
    assert.equal(l.items.length, 1); assert.equal(l.items[0].name, "$PEPE"); assert.equal(l.items[0].score, 61); assert.equal(l.items[0].shortAddress, "Mint\u2026000001");
    assert.ok(!JSON.stringify(l).includes("FULL"), "list has no report body");
    const r = await get(`/rugradar/api/recent/report?chain=solana&token=${A(1)}`, "rr_good"); assert.equal(r.status, 200); assert.equal(r.headers.get("cache-control"), "no-store");
    const j = await r.json(); assert.equal(j.buyerSummary, "FULL"); assert.equal(j.riskScore, 61); assert.equal(j.paidWith, "saved"); assert.equal(j.credits_remaining, 5);
    // no charge: balance and spend counter unchanged after 3 reloads
    for (let i = 0; i < 3; i++) await get(`/rugradar/api/recent/report?chain=solana&token=${A(1)}`, "rr_good");
    assert.equal(spends(), 0); assert.equal(keys.get("rr_good"), 5);
    // another valid key cannot read it; a known key with 0 credits can still read its own list
    assert.equal((await get(`/rugradar/api/recent/report?chain=solana&token=${A(1)}`, "rr_other")).status, 404);
    assert.deepEqual((await (await get("/rugradar/api/recent", "rr_other")).json()).items, []);
    assert.equal((await get("/rugradar/api/recent", "rr_empty")).status, 200);
    // key revoked/unknown later: reports unreadable
    keys.delete("rr_good"); assert.equal((await get(`/rugradar/api/recent/report?chain=solana&token=${A(1)}`, "rr_good")).status, 401);
  } finally { srv.closeAllConnections(); srv.close(); }
});
test("free checks are never saved and do not touch credits", async () => {
  __resetFree(); const { srv, base, recent, spends } = await start();
  try {
    const r = await fetch(`${base}/rugradar/api/check?token=JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN&chain=solana`, { method: "POST", headers: { "x-forwarded-for": "7.7.7.7" } });
    assert.equal(r.status, 200); assert.equal((await r.json()).report, "limited");
    assert.equal(recent.pendingCount(), 0); assert.equal(spends(), 0);
    assert.deepEqual(await recent.list("rr_good"), []); assert.equal(await recent.get("rr_good", "solana", "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN"), null);
  } finally { srv.closeAllConnections(); srv.close(); }
});
test("page: Recent dropdown is hidden by default, loads only with a key, reload path never posts or spends", async () => {
  const { srv, base } = await start();
  try {
    const h = await (await fetch(`${base}/rugradar`)).text();
    assert.ok(/<select id="recent"[^>]* hidden /.test(h)); assert.ok(h.includes("/rugradar/api/recent/report?chain=") && h.includes("No credit used."));
    assert.ok(h.includes("if(!k)return;fetch('/rugradar/api/recent'"), "no request without a key");
    const sel = h.slice(h.indexOf("RS.addEventListener('change'"), h.indexOf("$('key').addEventListener('change',recentLoad)"));
    assert.ok(!/method:'POST'|rug-check|api\/check/.test(sel), "selecting an entry cannot trigger a charge or a free check"); assert.ok(sel.includes("render(j,p[1])"));
    for (const m of h.matchAll(/<script>([\s\S]*?)<\/script>/g)) new Function(m[1]!);
  } finally { srv.closeAllConnections(); srv.close(); }
});
