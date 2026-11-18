import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "node:net";
import { registerRugradarWeb, __resetFree } from "../src/lib/rugradar-web.js";
import { rugradarStats, _resetCounts } from "../src/lib/rugradar-counts.js";

const MINT = "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN";

test("each successful free check on /rugradar/api/check counts once; rejects stay in rugradarRejected", async () => {
  _resetCounts();
  __resetFree();
  const app = express(); app.use(express.json()); app.set("trust proxy", 1);
  const srv = app.listen(0);
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  registerRugradarWeb(app, {
    publicUrl: base, port: 0, priceUsd: "0.01", speed: null,
    rugCheck: async (t) => ({ product: "RugRadar", chain: "solana", token: t, riskScore: 10, riskLevel: "medium", reasons: [], checks: [], facts: {}, disclaimer: "d" }),
    spend: async () => null, refund: async () => {},
  });
  const call = (method: string, tok: string, ip: string) =>
    fetch(`${base}/rugradar/api/check?token=${encodeURIComponent(tok)}&chain=solana`, { method, headers: { "x-forwarded-for": ip } });
  try {
    const bad = await call("POST", "not-a-mint", "1.1.1.1");
    assert.equal(bad.status, 400);
    let s = rugradarStats();
    assert.equal(s.today.rugradarFreeChecks, 0);
    assert.equal(s.today.rugradarRejectedByReason.invalidInput, 1);

    const okPost = await call("POST", MINT, "2.2.2.2");
    assert.equal(okPost.status, 200);
    s = rugradarStats();
    assert.equal(s.today.rugradarFreeChecks, 1);
    assert.equal(s.today.rugradarOwnerChecks, 0);
    assert.equal(s.today.rugradarPaidReports, 0);

    const okGet = await call("GET", MINT, "3.3.3.3");
    assert.equal(okGet.status, 200);
    s = rugradarStats();
    assert.equal(s.today.rugradarFreeChecks, 2, "GET uses the same handler and counts once");

    const used = await call("POST", MINT, "2.2.2.2"); // same IP, no wait: either rateLimited or freeUsedUp
    assert.ok(used.status === 429 || used.status === 402);
    s = rugradarStats();
    assert.equal(s.today.rugradarFreeChecks, 2);
    assert.ok(s.today.rugradarRejected >= 2);
  } finally {
    srv.closeAllConnections();
    srv.close();
    _resetCounts();
    __resetFree();
  }
});
