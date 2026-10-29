import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { createHash } from "node:crypto";
const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cro-")), "credits.json");
process.env.CREDITS_FILE = f; delete process.env.RENDER;
const K1 = "rr_owner_test_one", K2 = "rr_owner_test_two";
const h = (k: string) => createHash("sha256").update(k).digest("hex");
process.env.RUGRADAR_OWNER_KEY_HASHES = ` ${h(K1)} ,${h(K2).toUpperCase()}`;
process.env.RUGRADAR_OWNER_DAILY_CAP = "3";
const c = await import("../src/lib/credits.js");
test("owner keys: no credit record, daily cap, refunds, never written to disk", async () => {
  assert.ok(c.isOwnerKey(K1) && c.isOwnerKey(K2)); assert.ok(!c.isOwnerKey("rr_nope")); assert.ok(!c.isOwnerKey(""));
  assert.equal(await c.balance(K1), 3);
  assert.equal(await c.spend(K1), 2); assert.equal(await c.spendN(K1, 2), 0); assert.equal(await c.spend(K1), null);
  await c.refund(K1); assert.equal(await c.balance(K1), 1);
  await c.refundN(K1, 5); assert.equal(await c.balance(K1), 3);
  assert.equal(await c.spendN(K2, 4), null); assert.equal(await c.spend(K2), 2); // per-key cap
  await c.issueKey(1, "t-owner"); await c.flushCredits();
  const disk = fs.readFileSync(f, "utf8"); assert.ok(!disk.includes(h(K1)) && !disk.includes(K1));
});
test("owner keys off when env unset", async () => {
  const s = process.env.RUGRADAR_OWNER_KEY_HASHES; delete process.env.RUGRADAR_OWNER_KEY_HASHES;
  assert.equal(await c.spend(K1), null); assert.equal(await c.balance(K1), null);
  process.env.RUGRADAR_OWNER_KEY_HASHES = s;
});
