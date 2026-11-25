import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "node:net";
import { registerRugradarWeb, __resetFree, __resetEmbed } from "../src/lib/rugradar-web.js";
import { __resetShare, shareSvg, shareData } from "../src/lib/rugradar-share.js";

const MINT = "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN";
const FULL = (t: string) => ({ product: "RugRadar", chain: "solana", token: t, riskScore: 48, riskLevel: "medium", buyer: { devSoldPctOfBought: 95 },
  checks: [{ check: "age", points: 10, detail: "Very new" }, { check: "liquidity", points: 20, detail: "thin" }, { check: "dev_sold", points: 10, detail: "Dev sold 95%" }, { check: "deployer_history", points: 20, detail: "Creator launched 5" }],
  facts: { tokenName: "SafeMoon Inu", tokenSymbol: "SMI", top10Pct: 20, ageHours: 0.2, liquidityUsd: 9000, priorLaunches: 5 } });

async function start() {
  const app = express(); let calls = 0;
  const srv = app.listen(0), base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  registerRugradarWeb(app, { publicUrl: base, port: 0, priceUsd: "0.01", speed: null, rugCheck: async (t) => { calls++; return FULL(t); }, spend: async () => null, refund: async () => {} });
  return { srv, base, calls: () => calls };
}

test("share: permalink and PNG render from a stored check only; views never start a new check", async () => {
  __resetFree(); __resetEmbed(); __resetShare(); const s = await start();
  try {
    const empty = await (await fetch(`${s.base}/rugradar/c/solana/${MINT}`)).text();
    assert.match(empty, /<meta name="twitter:card" content="summary">/);
    assert.ok(empty.includes("No saved danger warnings")); assert.ok(empty.includes("/rugradar/rug-radar-512.png"));
    assert.ok(!/safe|good|clean|guarantee/i.test(empty));
    assert.equal(s.calls(), 0, "permalink view never runs a check");
    const miss = await fetch(`${s.base}/rugradar/share/solana/${MINT}.png`, { redirect: "manual" });
    assert.equal(miss.status, 302); assert.equal(s.calls(), 0, "uncached PNG never runs a check");
    const chk = await fetch(`${s.base}/rugradar/api/check?token=${MINT}&chain=solana`, { method: "POST" });
    assert.equal(chk.status, 200); const body = await chk.json(); assert.match(body.shareUrl, new RegExp(`/rugradar/c/solana/${MINT}`));
    assert.equal(s.calls(), 1);
    const h = await (await fetch(`${s.base}/rugradar/c/solana/${MINT}`)).text();
    assert.match(h, /<meta name="twitter:card" content="summary">/);
    assert.ok(h.includes(`/rugradar/share/solana/${MINT}.png`)); assert.ok(h.includes("Thin liquidity") || h.includes("Very new") || h.includes("warning"));
    assert.ok(!/safe|guarantee/i.test(h));
    assert.equal(s.calls(), 1, "permalink after a check does not check again");
    const r = await fetch(`${s.base}/rugradar/share/solana/${MINT}.png`); assert.equal(r.status, 200); assert.equal(r.headers.get("content-type"), "image/png");
    const png = Buffer.from(await r.arrayBuffer()); assert.equal(png.subarray(1, 4).toString(), "PNG");
    await fetch(`${s.base}/rugradar/share/solana/${MINT}.png`); assert.equal(s.calls(), 1, "cached PNG does not check again");
    const r2 = await fetch(`${s.base}/rugradar/share/solana/not-a-mint.png`, { redirect: "manual" }); assert.equal(r2.status, 302);
    const plain = await (await fetch(`${s.base}/rugradar`)).text(); assert.match(plain, /summary_large_image/);
  } finally { s.srv.closeAllConnections(); s.srv.close(); }
});

test("share card: free data only, never 'safe', no paid signals", () => {
  const l = { riskScore: 30, riskLevel: "medium", hiddenWarnings: 2, facts: { tokenName: "SafeMoon", tokenSymbol: "SAFE", top10Pct: 40, liquidityUsd: 1200, ageHours: 3 } };
  const svg = shareSvg(shareData(l, [{ sev: "DANGER", title: "Thin liquidity" }], "medium", MINT, "solana"), "example.com");
  assert.ok(!/safe/i.test(svg)); assert.ok(!/guarantee/i.test(svg)); assert.ok(svg.includes("Danger warnings only")); assert.ok(svg.includes("Thin liquidity")); assert.ok(svg.includes("Top 10 hold 40%")); assert.ok(svg.includes("+2 more warnings"));
  for (const bad of ["Dev sold", "Creator launched", "sniper"]) assert.ok(!svg.includes(bad));
});
