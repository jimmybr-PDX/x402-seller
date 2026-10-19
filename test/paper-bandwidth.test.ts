import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";

test("trades: new trades go to small hourly files; loadTrades reads legacy + hourly in order", async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "pt-")); process.env.PAPER_DIR = d; delete process.env.PAPER_STORE_REPO;
  const st = await import("../src/lib/paper/store.js"); await st.initStore();
  fs.writeFileSync(path.join(d, "data", "trades.jsonl"), [1, 2, 3].map((i) => JSON.stringify({ i })).join("\n") + "\n");
  st.appendTrade({ i: 4 }, new Date("2026-10-19T18:10:00Z")); st.appendTrade({ i: 5 }, new Date("2026-10-19T19:10:00Z")); st.appendTrade({ i: 6 }, new Date("2026-10-19T19:20:00Z"));
  assert.ok(fs.existsSync(path.join(d, "data", "trades", "2026-10-19", "19.jsonl")));
  assert.equal(fs.readFileSync(path.join(d, "data", "trades.jsonl"), "utf8").split("\n").filter(Boolean).length, 3); // legacy untouched
  assert.deepEqual(st.loadTrades().map((t: any) => t.i), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(st.loadTrades(2).map((t: any) => t.i), [5, 6]);
  assert.deepEqual(st.loadTrades(4).map((t: any) => t.i), [3, 4, 5, 6]);

  // multi-MB caches: written at most every 6 h unless forced
  const f = path.join(d, "data", "names.json"), t0 = 1_800_000_000_000;
  await st.writeFile("names.json", { a: 1 }, false, t0); assert.deepEqual(JSON.parse(fs.readFileSync(f, "utf8")), { a: 1 });
  await st.writeFile("names.json", { a: 2 }, false, t0 + 60_000); assert.deepEqual(JSON.parse(fs.readFileSync(f, "utf8")), { a: 1 });
  await st.writeFile("names.json", { a: 3 }, false, t0 + st.BIG_EVERY_MS + 1); assert.deepEqual(JSON.parse(fs.readFileSync(f, "utf8")), { a: 3 });
  await st.writeFile("names.json", { a: 4 }, true, t0 + st.BIG_EVERY_MS + 2); assert.deepEqual(JSON.parse(fs.readFileSync(f, "utf8")), { a: 4 });
  await st.writeFile("state-small.json", { b: 1 }); await st.writeFile("state-small.json", { b: 2 });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(d, "data", "state-small.json"), "utf8")), { b: 2 }); // small files unaffected
});
