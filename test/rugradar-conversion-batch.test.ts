import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "node:net";
import { registerRugradarWeb, freeAllowance, useFree, __resetFree, SHARE_JS } from "../src/lib/rugradar-web.js";
import { attachCounts, countRugradar, publicChecksRun, rugradarStats, _resetCounts, ptDay } from "../src/lib/rugradar-counts.js";

const MINT = "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN";

async function start(opts?: { seed?: { free: number; paid: number; owner: number } }) {
  _resetCounts();
  __resetFree();
  if (opts?.seed) {
    await attachCounts("mem", {
      load: async () => ({ v: 1, savedAt: "", days: { "2026-01-01": opts.seed } }),
      sync: async () => {},
      write: async () => {},
    }, 1e9);
  }
  const app = express();
  const srv = app.listen(0);
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  registerRugradarWeb(app, {
    publicUrl: base, port: 0, priceUsd: "0.01", speed: null,
    rugCheck: async (t) => ({ product: "RugRadar", chain: "solana", token: t, riskScore: 10, riskLevel: "medium", reasons: [], checks: [{ check: "age", points: 10, detail: "Very new" }], facts: {}, disclaimer: "d" }),
    spend: async () => null, refund: async () => {},
  });
  return { srv, base };
}

test("free allowance resets at Pacific midnight, not UTC, and still limits by IP and cookie", () => {
  __resetFree();
  // 27 Nov 2026 is PST (UTC-8)
  const first = Date.parse("2026-11-27T15:30:00-08:00");
  const afterUtcMidnight = Date.parse("2026-11-28T00:01:00Z"); // 4:01 PM PT Nov 27
  const beforePtMidnight = Date.parse("2026-11-27T23:59:00-08:00");
  const afterPtMidnight = Date.parse("2026-11-28T00:01:00-08:00");
  assert.equal(ptDay(new Date(first)), "2026-11-27");
  assert.equal(ptDay(new Date(afterUtcMidnight)), "2026-11-27");
  assert.equal(ptDay(new Date(beforePtMidnight)), "2026-11-27");
  assert.equal(ptDay(new Date(afterPtMidnight)), "2026-11-28");

  assert.equal(freeAllowance("10.0.0.1", "vidA", first).ok, true);
  useFree("10.0.0.1", "vidA", first);
  const still = freeAllowance("10.0.0.1", "vidA", afterUtcMidnight);
  assert.equal(still.ok, false);
  assert.equal(still.reason, "free_checks_used");
  assert.equal(freeAllowance("10.0.0.1", "vidA", beforePtMidnight).reason, "free_checks_used");
  assert.equal(freeAllowance("10.0.0.2", "vidB", beforePtMidnight).ok, true, "a different visitor still has their daily check");
  const nextDay = freeAllowance("10.0.0.1", "vidA", afterPtMidnight);
  assert.equal(nextDay.ok, true, "same visitor gets a new check after Pacific midnight");

  // July PDT: UTC midnight is 5:00 PM PT and must not reset
  __resetFree();
  const jul = Date.parse("2026-07-15T15:59:00-07:00");
  const afterUtcJul = Date.parse("2026-07-16T00:01:00Z");
  assert.equal(ptDay(new Date(jul)), "2026-07-15");
  assert.equal(ptDay(new Date(afterUtcJul)), "2026-07-15");
  assert.equal(freeAllowance("10.0.0.1", "vidA", jul).ok, true);
  useFree("10.0.0.1", "vidA", jul);
  assert.equal(freeAllowance("10.0.0.1", "vidA", afterUtcJul).ok, false);
  __resetFree();
});

test("public checks-run counter is free+paid all-time, never includes owner or invented fields", async () => {
  _resetCounts();
  assert.equal(publicChecksRun(), null, "no number until the store is restored or a real check lands");
  await attachCounts("mem", {
    load: async () => ({ v: 1, savedAt: "", days: { "2026-01-01": { free: 27, paid: 40, owner: 9 } } }),
    sync: async () => {},
    write: async () => {},
  }, 1e9);
  const pub = publicChecksRun();
  assert.deepEqual(pub, { checksRun: 67 });
  assert.equal(rugradarStats().allTime.rugradarOwnerChecks, 9);
  assert.equal(pub!.checksRun, rugradarStats().allTime.rugradarTotal);
  countRugradar("owner");
  assert.equal(publicChecksRun()!.checksRun, 67, "later owner checks still excluded");
  countRugradar("free");
  assert.equal(publicChecksRun()!.checksRun, 68);
  _resetCounts();
});

test("cached /rugradar/api/checks and inlined page counter use the real total", async () => {
  const { srv, base } = await start({ seed: { free: 27, paid: 40, owner: 9 } });
  try {
    const r = await fetch(`${base}/rugradar/api/checks`);
    assert.equal(r.status, 200);
    const cc = r.headers.get("cache-control") || "";
    assert.match(cc, /public/);
    assert.match(cc, /max-age=600/);
    const j = await r.json();
    assert.deepEqual(j, { checksRun: 67 });
    assert.equal("high-risk" in j || "highRiskFlagged" in j || "owner" in j, false);
    const h = await (await fetch(`${base}/rugradar`)).text();
    assert.match(h, /67 checks run/);
    assert.ok(!h.includes("high-risk flagged"));
    assert.ok(!h.includes("9 checks")); // owner total must not appear
  } finally {
    srv.closeAllConnections();
    srv.close();
    _resetCounts();
    __resetFree();
  }
});

test("Copy embed snippet is an iframe for websites; Copy link stays a permalink", () => {
  const { rrEmbed, rrLink } = new Function(SHARE_JS + "; return {rrEmbed,rrLink};")() as Record<string, (...a: any[]) => string>;
  const o = "https://x402-seller-pmlm.onrender.com";
  const iframe = rrEmbed!(o, MINT, "solana");
  assert.match(iframe, /^<iframe /);
  assert.ok(iframe.includes(`/rugradar/embed?token=${MINT}&chain=solana`));
  assert.ok(iframe.includes('title="RugRadar token risk"'));
  assert.ok(iframe.includes("loading=\"lazy\""));
  assert.equal(rrLink!(o, MINT, "solana"), `${o}/rugradar/c/solana/${MINT}`);
  assert.ok(!iframe.includes("/rugradar/c/"), "embed is the site iframe, not the Discord permalink");
});

test("free result copy stays warnings-only and includes the new lines", async () => {
  const { srv, base } = await start({ seed: { free: 1, paid: 1, owner: 0 } });
  try {
    const h = await (await fetch(`${base}/rugradar`)).text();
    for (const s of ["1 free check used today, full report is $", "Copy embed", "Copy link (Discord)", "Copy embed (website)", "For bots & tools:", "MCP, x402, or a credit key", "href='#developers'", "2 checks run"]) {
      assert.ok(h.includes(s), s);
    }
    for (const re of [/\bsafe\b/i, /\bclean\b/i, /\bguarantee\b/i, /sniper share/i, /organic\/bot/i, /creator's past launches/i]) {
      assert.ok(!re.test(h.replace(/https?:\/\/\S+/g, "")), String(re));
    }
  } finally {
    srv.closeAllConnections();
    srv.close();
    _resetCounts();
    __resetFree();
  }
});
