import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The GitHub store over a local bare repo: a push rejected because another instance changed the SAME file must not leave a
// half-done rebase; this instance resets to the remote, re-applies its documents (credits merged, so no paid key is lost) and pushes.
test("store: concurrent writer on the same file -> no stuck rebase, our docs land, remote-only credit keys survive", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "store-test-"));
  const g = (cwd: string, ...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd, stdio: "pipe" }).toString();
  const bare = path.join(tmp, "remote.git"), seed = path.join(tmp, "seed"), other = path.join(tmp, "other");
  g(tmp, "init", "-q", "--bare", "-b", "main", bare);
  g(tmp, "clone", "-q", bare, seed);
  fs.writeFileSync(path.join(seed, "credits.json"), JSON.stringify({ v: 1, keys: { a: { credits: 5, bought: 5, createdAt: "x", lastUsedAt: null } }, purchases: { r1: "a" } }));
  g(seed, "add", "-A"); g(seed, "commit", "-q", "-m", "seed"); g(seed, "push", "-q", "origin", "HEAD:main");
  process.env.RUGRADAR_STORE_REPO = bare; process.env.RUGRADAR_STORE_SSH_KEY_B64 = Buffer.from("unused").toString("base64"); delete process.env.CREDITS_FILE;
  const c = await import("../src/lib/credits.js");
  await c.initCredits();
  assert.equal(c.creditsStatus().store, "github");
  await c.saveDoc("w.json", { n: 1 }, "ours 1");
  // another instance pushes a different w.json and a newly bought credit key
  g(tmp, "clone", "-q", bare, other);
  fs.writeFileSync(path.join(other, "w.json"), JSON.stringify({ n: 99 }));
  fs.writeFileSync(path.join(other, "credits.json"), JSON.stringify({ v: 1, keys: { a: { credits: 5, bought: 5, createdAt: "x", lastUsedAt: null }, b: { credits: 10, bought: 10, createdAt: "y", lastUsedAt: null } }, purchases: { r1: "a", r2: "b" } }));
  g(other, "add", "-A"); g(other, "commit", "-q", "-m", "other"); g(other, "push", "-q", "origin", "HEAD:main");
  // our next writes collide on both files
  await c.saveDoc("w.json", { n: 2 }, "ours 2");
  assert.equal(await c.spend("unknown-key"), null);
  await c.flushCredits();
  const check = path.join(tmp, "check"); g(tmp, "clone", "-q", bare, check);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(check, "w.json"), "utf8")), { n: 2 });
  const cr = JSON.parse(fs.readFileSync(path.join(check, "credits.json"), "utf8"));
  assert.ok(cr.keys.b && cr.purchases.r2, "key bought on the other instance kept");
  // deletion + listing
  await c.saveDocs({ "traffic-x.json": { v: 1 }, "traffic.json": { v: 1 } }, "t");
  assert.deepEqual(await c.listDocs("traffic"), ["traffic-x.json", "traffic.json"]);
  await c.saveDocs({ "traffic-x.json": null }, "rm"); await c.syncStore();
  assert.deepEqual(await c.listDocs("traffic"), ["traffic.json"]);
  fs.rmSync(tmp, { recursive: true, force: true });
});
