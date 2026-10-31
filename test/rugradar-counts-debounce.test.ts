import { test } from "node:test";
import assert from "node:assert";
import { attachCounts, countRugradarRejected, countRugradar, _resetCounts } from "../src/lib/rugradar-counts.js";

test("counts save ~8s after a change (debounced, one write per burst)", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  _resetCounts();
  const writes: any[] = []; let doc: unknown = null;
  await attachCounts("mem", { load: async () => doc, sync: async () => {}, write: async (d) => { writes.push(d); doc = d; } });
  countRugradarRejected("invalidInput"); countRugradar("free");
  t.mock.timers.tick(5000); await new Promise((r) => setImmediate(r));
  assert.equal(writes.length, 0);
  t.mock.timers.tick(4000); for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  assert.equal(writes.length, 1);
  const row = Object.values(writes[0].days)[0] as any;
  assert.equal(row.free, 1); assert.equal(row.rej.invalidInput, 1);
  _resetCounts();
});
