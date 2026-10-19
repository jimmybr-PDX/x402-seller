import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import { gunzipSync } from "node:zlib";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ph-")); process.env.PAPER_DIR = dir; delete process.env.PAPER_STORE_REPO;
const store = await import("../src/lib/paper/store.js");
const h = await import("../src/lib/paper/history.js");
const ff = await import("../src/lib/paper/free-feed.js");
const { cfgOf, CFG, STRATS, TESTS, FX25, CHECKPOINTS } = await import("../src/lib/paper/engine.js");

test("inflow_fx25: inflow_v1 cost model and exits, own test entry; existing configs untouched", () => {
  assert.ok(STRATS.includes("inflow_fx25")); assert.ok(TESTS.some((t) => t.strat === "inflow_fx25"));
  const c = cfgOf("inflow_fx25"); assert.equal(c.size, CFG.inflow.size); assert.equal(c.sl, CFG.inflow.sl); assert.equal(c.maxHoldS, CFG.inflow.maxHoldS); assert.equal(c.tp, CFG.inflow.tp);
  assert.deepEqual(FX25, { afterS: 25, bePct: 3.5 }); assert.deepEqual(cfgOf("inflow_v1"), CFG.inflow); assert.deepEqual(CHECKPOINTS, [10, 20, 30, 60]);
});
test("free-feed mode: permanent by default, env can force off/on, optional until date", () => {
  delete process.env.PAPER_FREE_FEED; delete process.env.PAPER_FREE_FEED_UNTIL;
  assert.equal(ff.freeFeedOn(Date.parse("2026-10-19T00:00:00Z")), true);
  assert.equal(ff.freeFeedOn(Date.parse("2026-11-19T00:00:00Z")), true);
  assert.equal(ff.freeFeedStatus().until, "permanent");
  process.env.PAPER_FREE_FEED_UNTIL = "2026-10-23T23:00:00Z";
  assert.equal(ff.freeFeedOn(Date.parse("2026-10-19T00:00:00Z")), true);
  assert.equal(ff.freeFeedOn(Date.parse("2026-10-24T00:00:00Z")), false);
  delete process.env.PAPER_FREE_FEED_UNTIL;
  process.env.PAPER_FREE_FEED = "0"; assert.equal(ff.freeFeedOn(Date.parse("2026-10-19T00:00:00Z")), false);
  process.env.PAPER_FREE_FEED = "1"; assert.equal(ff.freeFeedOn(Date.parse("2026-11-19T00:00:00Z")), true); delete process.env.PAPER_FREE_FEED;
});
test("history: coin trades merged per coin (max 150, deduped), launches with socials flags, batched gzip files", async () => {
  await store.initStore();
  const tr = (i: number) => ({ type: i % 3 ? "buy" : "sell", userAddress: "W" + (i % 7), amountSol: 0.1 * i, priceSol: 2.81234567e-8, timestamp: new Date(1_760_000_000_000 + i * 1000).toISOString(), tx: "sig" + i });
  h.noteCoinTrades("MINT1", Array.from({ length: 100 }, (_, i) => tr(i)).reverse());
  h.noteCoinTrades("MINT1", Array.from({ length: 120 }, (_, i) => tr(i + 80)).reverse()); // overlap 80..99
  h.noteLaunch({ mint: "MINT2", traderPublicKey: "CR", name: "Name", symbol: "SYM", initialBuy: 1e6, solAmount: 1.234567, marketCapSol: 30.1, uri: "ipfs://x" });
  const meta = (m: string) => (m === "MINT2" ? { twitter: true, telegram: false, website: true, descLen: 42 } : null);
  const realNow = Date.now; Date.now = () => realNow() + 30 * 60_000; try { h.flushHistory(meta); } finally { Date.now = realNow; }
  const day = fs.readdirSync(path.join(dir, "data", "coin-trades"))[0]!; const f = fs.readdirSync(path.join(dir, "data", "coin-trades", day))[0]!;
  const coin = JSON.parse(gunzipSync(fs.readFileSync(path.join(dir, "data", "coin-trades", day, f))).toString().trim());
  assert.equal(coin.m, "MINT1"); assert.equal(coin.n, 150); assert.equal(coin.t.length, 150); assert.equal(coin.t.at(-1)[5], "sig199"); assert.equal(new Set(coin.t.map((r: any) => r[5])).size, 150);
  assert.deepEqual(coin.t.at(-1).slice(1, 5), ["buy" === tr(199).type ? "b" : "s", "W3", 19.9, 2.8123e-8]);
  const ld = fs.readdirSync(path.join(dir, "data", "launches", day))[0]!;
  const l = JSON.parse(gunzipSync(fs.readFileSync(path.join(dir, "data", "launches", day, ld))).toString().trim());
  assert.equal(l.m, "MINT2"); assert.equal(l.c, "CR"); assert.equal(l.ibSol, 1.2346); assert.equal(l.tw, true); assert.equal(l.tg, false); assert.equal(l.web, true); assert.equal(l.descLen, 42);
  assert.equal(store.takeHistoryDirty(), true); assert.equal(store.takeHistoryDirty(), false);
  assert.equal(h.histStat.coinsWritten, 1); assert.equal(h.histStat.launchesWritten, 1);
});
