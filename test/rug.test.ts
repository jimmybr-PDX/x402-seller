import { test } from "node:test";
import assert from "node:assert/strict";
import { scoreFacts, scoreEvm, DISCLAIMER, rugCheck, type Facts } from "../src/lib/rug.js";

const base: Facts = { mint: "M", decimals: 6, supply: 1e9, mintAuthority: null, freezeAuthority: null, token2022: false, top1Pct: 5, top10Pct: 20, liquidityUsd: 500000, priceUsd: 1, pairs: 2, lpNote: null, ageHours: 2000, creator: "C", funder: null, priorLaunches: 0, priorDead: 0, creatorFlagged: false, funderFlagged: false, unknown: [] };

test("clean established token scores low", () => { const r = scoreFacts(base); assert.equal(r.level, "low"); assert.equal(r.score, 0); });
test("active authorities + concentration + serial dead launches score high", () => {
  const r = scoreFacts({ ...base, mintAuthority: "X", freezeAuthority: "X", top1Pct: 60, top10Pct: 90, liquidityUsd: 1000, ageHours: 1, priorLaunches: 6, priorDead: 5 });
  assert.equal(r.level, "high"); assert.equal(r.score, 100);
  assert.ok(r.reasons.some((x) => /serial-launch high-risk pattern/.test(x.detail)));
});
test("wording: high-risk pattern, never 'scammer'", () => {
  const all = scoreFacts({ ...base, mintAuthority: "X", freezeAuthority: "X", creatorFlagged: true, funderFlagged: true, priorLaunches: 4, priorDead: 4 }).reasons.map((x) => x.detail).join(" ");
  assert.ok(!/scam/i.test(all)); assert.match(all, /high-risk pattern/);
  assert.equal(DISCLAIMER, "Automated heuristic, may be wrong. Not financial advice. Do your own research.");
});
test("base honeypot scores high", () => { const r = scoreEvm({ is_honeypot: "1", is_mintable: "1", sell_tax: "0.5" }, 2000, 3); assert.equal(r.level, "high"); });
test("rejects bad input and unknown chain", async () => {
  await assert.rejects(rugCheck("not-a-mint"), /mint is required/);
  await assert.rejects(rugCheck("JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN", "dogechain"), /chain must be one of/);
});
