import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  mountTvWebhook, attachTvAlerts, resetTvAlertsForTests, flushTvAlerts,
  parseTvAlertQuery, holdTvAlerts, tvAlertsStatus, type TvAlertStore,
} from "../src/lib/tv-webhook.js";

const SECRET = "tv-test-secret-xxxxxxxx";
process.env.TV_WEBHOOK_SECRET = SECRET;

function memStore(files: Record<string, string> = {}): TvAlertStore & { files: Record<string, string> } {
  return {
    name: "memory",
    files,
    async load() {
      const raw = files["tv-alerts-meta.json"];
      const meta = raw ? JSON.parse(raw) : null;
      const jsonl: Record<string, string> = {};
      for (const [n, b] of Object.entries(files)) if (n.endsWith(".jsonl")) jsonl[n] = b;
      return { meta, files: jsonl };
    },
    async write(docs) {
      for (const [n, b] of Object.entries(docs)) {
        if (b === null) delete files[n];
        else files[n] = b;
      }
    },
  };
}

async function withServer<T>(fn: (url: string) => Promise<T>): Promise<T> {
  const app = express();
  mountTvWebhook(app);
  const srv = http.createServer(app);
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const { port } = srv.address() as AddressInfo;
  try { return await fn(`http://127.0.0.1:${port}`); }
  finally { await new Promise<void>((r, j) => srv.close((e) => e ? j(e) : r())); }
}

async function post(url: string, body: unknown, key = SECRET) {
  const r = await fetch(`${url}/tv/webhook?key=${encodeURIComponent(key)}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  return { status: r.status, json: await r.json() as any };
}
async function get(url: string, q: Record<string, string | number> = {}, key = SECRET) {
  const qs = new URLSearchParams({ key, ...Object.fromEntries(Object.entries(q).map(([k, v]) => [k, String(v)])) });
  const r = await fetch(`${url}/tv/alerts.json?${qs}`);
  return { status: r.status, json: await r.json() as any };
}

beforeEach(() => {
  delete process.env.TV_ALERTS_MAX;
  delete process.env.TV_ALERTS_MAX_AGE_MS;
  resetTvAlertsForTests();
  process.env.TV_WEBHOOK_SECRET = SECRET;
});

test("parseTvAlertQuery reads since and afterId", () => {
  assert.deepEqual(parseTvAlertQuery({ since: "100", afterId: "9" }), { since: 100, afterId: 9 });
  assert.deepEqual(parseTvAlertQuery({ since: "2010-01-01T00:00:00.000Z", after_id: "3" }), { since: Date.parse("2010-01-01T00:00:00.000Z"), afterId: 3 });
  assert.deepEqual(parseTvAlertQuery({}), { since: 0, afterId: 0 });
});

test("POST stores an alert and GET returns it; bad key is 401", async () => {
  await withServer(async (url) => {
    const p = await post(url, { symbol: "ETHUSD", pattern: "Bat" });
    assert.equal(p.status, 200);
    assert.equal(p.json.ok, true);
    assert.equal(typeof p.json.id, "number");
    const bad = await get(url, {}, "wrong-length");
    assert.equal(bad.status, 401);
    const g = await get(url);
    assert.equal(g.status, 200);
    assert.equal(g.json.alerts.length, 1);
    assert.equal(g.json.alerts[0].id, p.json.id);
    assert.equal(g.json.alerts[0].body.symbol, "ETHUSD");
    assert.equal(typeof g.json.cursor.id, "number");
    assert.equal(g.json.persist.rows, 1);
  });
});

test("since and afterId cursors filter correctly", async () => {
  await withServer(async (url) => {
    const a = await post(url, { n: 1 });
    const b = await post(url, { n: 2 });
    const c = await post(url, { n: 3 });
    const all = await get(url);
    assert.equal(all.json.alerts.length, 3);
    const after = await get(url, { afterId: a.json.id });
    assert.deepEqual(after.json.alerts.map((x: any) => x.id), [b.json.id, c.json.id]);
    const since = await get(url, { since: all.json.alerts[1].receivedMs });
    assert.deepEqual(since.json.alerts.map((x: any) => x.id), [c.json.id]);
  });
});

test("flush + attach restores alerts and continues ids after a simulated restart", async () => {
  const store = memStore();
  await withServer(async (url) => {
    await attachTvAlerts(store, { persistEveryMs: 0, signals: false });
    const p = await post(url, { symbol: "BTCUSD", pattern: "Shark" });
    await flushTvAlerts("test flush");
    assert.ok(store.files["tv-alerts-meta.json"]);
    assert.ok(Object.keys(store.files).some((n) => n.endsWith(".jsonl") && store.files[n].includes("Shark")));
    const id = p.json.id;
    resetTvAlertsForTests();
    process.env.TV_WEBHOOK_SECRET = SECRET;
    assert.equal(tvAlertsStatus().inMemory, 0);
    await attachTvAlerts(store, { persistEveryMs: 0, signals: false });
    const g = await get(url);
    assert.equal(g.json.alerts.length, 1);
    assert.equal(g.json.alerts[0].id, id);
    assert.equal(g.json.persist.restoredRows, 1);
    assert.equal(g.json.persist.store, "memory");
    const p2 = await post(url, { symbol: "ETHUSD" });
    assert.ok(p2.json.id > id, "ids continue after restore");
  });
});

test("age and count caps drop old rows", async () => {
  process.env.TV_ALERTS_MAX = "2";
  process.env.TV_ALERTS_MAX_AGE_MS = String(60_000);
  const store = memStore();
  const old = { id: 10, received: "2020-01-01T00:00:00.000Z", receivedMs: Date.parse("2020-01-01T00:00:00.000Z"), body: { old: true } };
  const mid = { id: 11, received: new Date().toISOString(), receivedMs: Date.now() - 1000, body: { mid: true } };
  const newer = { id: 12, received: new Date().toISOString(), receivedMs: Date.now(), body: { newer: true } };
  store.files["tv-alerts-compact.jsonl"] = [old, mid, newer].map((a) => JSON.stringify(a)).join("\n") + "\n";
  store.files["tv-alerts-meta.json"] = JSON.stringify({ v: 1, nextId: 13, savedAt: new Date().toISOString(), savedThroughId: 12 }) + "\n";
  await attachTvAlerts(store, { persistEveryMs: 0, signals: false });
  await withServer(async (url) => {
    const g = await get(url);
    assert.equal(g.json.alerts.length, 2);
    assert.deepEqual(g.json.alerts.map((x: any) => x.id), [11, 12]);
  });
});

test("holdTvAlerts blocks GET until released", async () => {
  const release = holdTvAlerts();
  const pending = withServer(async (url) => get(url));
  let done = false;
  pending.then(() => { done = true; });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(done, false, "should wait while held");
  release();
  const g = await pending;
  assert.equal(g.status, 200);
});
