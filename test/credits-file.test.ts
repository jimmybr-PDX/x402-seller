import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cr-")), "credits.json");
process.env.CREDITS_FILE = f; delete process.env.RENDER;
const c = await import("../src/lib/credits.js");
test("issue, spend to zero, refund, hashes only on disk", async () => {
  const { key, credits } = await c.issueKey(2, "t1");
  assert.equal(credits, 2); assert.match(key, /^rr_/);
  assert.equal(await c.spend(key), 1); assert.equal(await c.spend(key), 0); assert.equal(await c.spend(key), null);
  await c.refund(key); assert.equal(await c.balance(key), 1);
  await c.flushCredits();
  const disk = fs.readFileSync(f, "utf8");
  assert.ok(!disk.includes(key) && disk.includes(c.hashKey(key)));
  assert.equal(await c.spend("rr_unknown"), null);
});

test("issueKeyOnce: refs are durable and a second redeem is refused", async () => {
  const { key, credits } = await c.issueKeyOnce(10, ["wallet:ref:R1", "wallet:sig:S1"]);
  assert.equal(credits, 10); assert.equal(await c.balance(key), 10);
  assert.equal(await c.isRedeemed("wallet:sig:S1"), true); assert.equal(await c.isRedeemed("wallet:sig:S2"), false);
  await assert.rejects(c.issueKeyOnce(10, ["wallet:ref:R2", "wallet:sig:S1"]), /already_redeemed/);
  assert.ok(fs.readFileSync(f, "utf8").includes("wallet:sig:S1"));
});
