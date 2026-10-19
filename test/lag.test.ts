import { test } from "node:test";
import assert from "node:assert/strict";
import { stringifyChunked, trackSync, lagStatus, track } from "../src/lib/lag.js";
test("stringifyChunked matches JSON.stringify", async () => {
  const obj: Record<string, unknown> = {}; for (let i = 0; i < 5003; i++) obj["k" + i] = { a: i, b: [i, "x"], u: undefined };
  obj.skip = undefined; const arr = Array.from({ length: 4321 }, (_, i) => (i % 7 ? { i } : undefined));
  assert.equal(await stringifyChunked(obj, 1000), JSON.stringify(obj));
  assert.equal(await stringifyChunked(arr, 1000), JSON.stringify(arr));
  assert.equal(await stringifyChunked({}), "{}"); assert.equal(await stringifyChunked([]), "[]"); assert.equal(await stringifyChunked(3), "3");
});
test("track/trackSync record slow jobs", async () => {
  trackSync("busy", () => { const t = Date.now(); while (Date.now() - t < 220); });
  await track("wait", () => new Promise((r) => setTimeout(r, 210)));
  const s = lagStatus(); assert.ok(s.slowJobs.some((j) => j.label === "busy" && j.sync)); assert.ok(s.slowJobs.some((j) => j.label === "wait" && !j.sync));
});
