import { test } from "node:test";
import assert from "node:assert/strict";
import { recordRequest, trafficStats, mergeSaved, attachDurable, saveDurable, refreshDurable, OWN_FILE } from "../src/lib/traffic.js";

const hk = new Date().toISOString().slice(0, 13) + ":00Z", dk = new Date().toISOString().slice(0, 10);
const counts = (unpaid: number, paid: number) => ({ requests: { client: unpaid + paid, crawler: 0, pinger: 0, bot: 0, head: 0, self: 0 }, unpaid402: { client: unpaid, crawler: 0, pinger: 0, bot: 0, head: 0, self: 0 }, paid200: paid, settleFailed: 0, paymentInvalid: 0, uncharged: 0, visitors: { client: 1, crawler: 0, pinger: 0, bot: 0, head: 0, self: 0 } });
const doc = (unpaid: number, paid: number, extra: object = {}) => ({ v: 1, savedAt: new Date().toISOString(), trackingSince: "2026-10-01T00:00:00.000Z", hourly: [{ start: hk, routes: { "/rug-check": counts(unpaid, paid) }, agents: {} }], daily: [{ start: dk, routes: { "/rug-check": counts(unpaid, paid) }, agents: { "client:node": 1 } }], rejections: [], rejectionReasons: {}, ...extra });
const unpaid = () => (trafficStats(["/rug-check"], true) as any).today.routes["/rug-check"].unpaid402.client;

test("durable traffic: per-instance files, restore = base + other instances, own file holds only own counts, refresh picks up the old instance's final save and folds it", async () => {
  // remote store: compacted base + an old instance that is still running (not final yet)
  const files: Record<string, any> = { "traffic.json": doc(4, 2), "traffic-old.json": doc(3, 0, { instance: "old" }) };
  const writes: string[][] = [];
  const store = { name: "test", load: async () => structuredClone(files), sync: async () => {}, write: async (d: Record<string, unknown>) => { writes.push(Object.keys(d)); for (const [n, v] of Object.entries(d)) { if (v === null) delete files[n]; else files[n] = structuredClone(v); } } };
  recordRequest("/rug-check", "GET", "node", "1.1.1.1", "unpaid402", false); // counted before restore
  await attachDurable(store, 3_600_000, 3_600_000, 3_600_000);
  const s: any = trafficStats(["/rug-check"], true);
  assert.equal(s.trackingSince, "2026-10-01T00:00:00.000Z");
  assert.equal(s.persistence.durable.restoredFiles, 2);
  assert.equal(unpaid(), 4 + 3 + 1);
  const f = s.toolFunnel.allTime.find((x: any) => x.tool === "/rug-check");
  assert.deepEqual([f.views, f.paid200], [10, 2]);
  // own save holds only this instance's 1 request, never the restored 7
  await saveDurable();
  assert.deepEqual(writes.at(-1), [OWN_FILE]);
  assert.equal(files[OWN_FILE].daily[0].routes["/rug-check"].unpaid402.client, 1);
  await saveDurable(); assert.equal(writes.length, 1); // unchanged -> no write
  // the old instance gets 2 more calls and saves final on SIGTERM after we booted
  files["traffic-old.json"] = doc(5, 0, { instance: "old", final: true });
  await refreshDurable();
  assert.equal(unpaid(), 4 + 5 + 1); // late counts recovered
  assert.equal(files["traffic-old.json"], undefined); // folded
  assert.equal(files["traffic.json"].daily[0].routes["/rug-check"].unpaid402.client, 9);
  assert.equal(files[OWN_FILE].daily[0].routes["/rug-check"].unpaid402.client, 1); // own file untouched
  await refreshDurable(); assert.equal(unpaid(), 10); // idempotent
  recordRequest("/rug-check", "GET", "node", "1.1.1.2", "unpaid402", false); await saveDurable();
  assert.equal(files[OWN_FILE].daily[0].routes["/rug-check"].unpaid402.client, 2);
  assert.equal(mergeSaved({ v: 2 }), 0);
});
