import { test } from "node:test";
import assert from "node:assert/strict";
import { recordRequest, trafficStats, mergeSaved, attachDurable, saveDurable } from "../src/lib/traffic.js";
test("durable traffic: restore adds saved counts onto live ones, save writes only on change, toolFunnel shows views vs paid", async () => {
  recordRequest("/rug-check", "GET", "node", "1.1.1.1", "unpaid402", false);
  const now = new Date(); const hk = now.toISOString().slice(0, 13) + ":00Z", dk = now.toISOString().slice(0, 10);
  const c = { requests: { client: 5, crawler: 0, pinger: 0, bot: 0, head: 0, self: 0 }, unpaid402: { client: 4, crawler: 0, pinger: 0, bot: 0, head: 0, self: 0 }, paid200: 2, settleFailed: 0, paymentInvalid: 0, uncharged: 0, visitors: { client: 3, crawler: 0, pinger: 0, bot: 0, head: 0, self: 0 } };
  const saved = { v: 1, savedAt: "2026-10-18T00:00:00Z", trackingSince: "2026-10-01T00:00:00.000Z", hourly: [{ start: hk, routes: { "/rug-check": c }, agents: {} }], daily: [{ start: dk, routes: { "/rug-check": c }, agents: { "client:node": 5 } }, { start: "2026-10-10", routes: { "/rug-check": c }, agents: {} }], rejections: [], rejectionReasons: {} };
  const writes: any[] = [];
  await attachDurable({ name: "test", load: async () => saved, save: async (d) => { writes.push(d); } }, 3_600_000);
  const s: any = trafficStats(["/rug-check"], true);
  assert.equal(s.trackingSince, "2026-10-01T00:00:00.000Z");
  assert.equal(s.persistence.durable.restoredBuckets, 3);
  assert.equal(s.today.routes["/rug-check"].unpaid402.client, 5); // 4 restored + 1 live
  const f = s.toolFunnel.allTime.find((x: any) => x.tool === "/rug-check");
  assert.deepEqual([f.views, f.paid200, f.conversionPct], [13, 4, 30.8]); // today (4+1 unpaid + 2 paid) + Oct 10 (4 + 2)
  await saveDurable(); await saveDurable();
  assert.equal(writes.length, 1); // unchanged -> no second write
  recordRequest("/rug-check", "GET", "node", "1.1.1.2", "unpaid402", false); await saveDurable();
  assert.equal(writes.length, 2);
  assert.equal(mergeSaved({ v: 2 }), 0);
});
