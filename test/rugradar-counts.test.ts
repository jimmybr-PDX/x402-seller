import { test } from "node:test";
import assert from "node:assert/strict";
import { countRugradar, rugradarStats, attachCounts, saveCounts, _resetCounts, ptDay } from "../src/lib/rugradar-counts.js";
import { statsHtml } from "../src/lib/stats-page.js";

test("rugradar counts: free/paid/owner, total excludes owner, save adds deltas onto remote", async () => {
  _resetCounts();
  let remote: any = { v: 1, savedAt: "", days: { "2026-01-01": { free: 5, paid: 2, owner: 9 } } };
  await attachCounts("mem", { load: async () => remote, sync: async () => {}, write: async (d) => { remote = JSON.parse(JSON.stringify(d)); } }, 1e9);
  countRugradar("free"); countRugradar("free"); countRugradar("paid"); countRugradar("owner");
  let s = rugradarStats();
  assert.deepEqual([s.today.rugradarFreeChecks, s.today.rugradarPaidReports, s.today.rugradarTotal, s.today.rugradarOwnerChecks], [2, 1, 3, 1]);
  assert.equal(s.allTime.rugradarTotal, 10);
  remote.days["2026-01-02"] = { free: 1, paid: 0, owner: 0 }; // another instance saved meanwhile
  await saveCounts();
  assert.deepEqual(remote.days[ptDay()], { free: 2, paid: 1, owner: 1 });
  s = rugradarStats();
  assert.equal(s.allTime.rugradarFreeChecks, 8);
  const html = statsHtml({ trackingSince: new Date().toISOString(), generatedAt: new Date().toISOString(), allTime: { totals: { unpaid402Client: 0, paid200: 0, settleFailed: 0 }, routes: {} }, last24h: { totals: { unpaid402Client: 0, paid200: 0, settleFailed: 0 }, routes: {} }, persistence: { mode: "memory" }, rugradar: s }, []);
  assert.match(html, /RugRadar checks/);
  _resetCounts();
});

test("rugradar counts: rejected free-check attempts by reason, persisted", async () => {
  _resetCounts();
  const { countRugradarRejected } = await import("../src/lib/rugradar-counts.js");
  let remote: any = { v: 1, savedAt: "", days: { "2026-01-01": { free: 0, paid: 0, owner: 0, rej: { error: 2 } } } };
  await attachCounts("mem", { load: async () => remote, sync: async () => {}, write: async (d) => { remote = JSON.parse(JSON.stringify(d)); } }, 1e9);
  countRugradarRejected("invalidInput"); countRugradarRejected("freeUsedUp"); countRugradarRejected("freeUsedUp");
  let s: any = rugradarStats();
  assert.equal(s.today.rugradarRejected, 3);
  assert.deepEqual(s.today.rugradarRejectedByReason, { freeUsedUp: 2, rateLimited: 0, invalidInput: 1, error: 0 });
  assert.equal(s.allTime.rugradarRejected, 5);
  assert.equal(s.today.rugradarTotal, 0);
  await saveCounts();
  assert.deepEqual(remote.days[ptDay()].rej, { freeUsedUp: 2, invalidInput: 1 });
  _resetCounts();
});
