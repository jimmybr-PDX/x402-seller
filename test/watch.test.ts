import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { evaluate, snapOf, createWatcher, verifySignature, checkWebhookUrl, type Snap, type Watch } from "../src/lib/watch.js";
import { createWithCredits, parseWatchInput } from "../src/lib/watch-routes.js";

const MINT = "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN";
const snap = (o: Partial<Snap> = {}): Snap => ({ at: 0, score: 10, level: "low", mintAuthority: false, freezeAuthority: false, liquidityUsd: 10000, canSell: "yes (Jupiter route)", devSells: 0, devSoldPct: 0, devHoldingPct: 5, priceUsd: 1, ...o });
const st = (base = snap()) => ({ base, peakLiq: base.liquidityUsd, noSell: 0, sent: [] as string[] });
const keys = (r: { alerts: { key: string }[] }) => r.alerts.map((a) => a.key).sort();

test("triggers: dev sells, liquidity drop vs peak, authorities, score worsening, can't sell", () => {
  assert.deepEqual(keys(evaluate(st(), snap())), []);
  assert.deepEqual(keys(evaluate(st(), snap({ devSells: 1, devSoldPct: 40 }))), ["dev_sold"]);
  assert.deepEqual(keys(evaluate(st(), snap({ devHoldingPct: 2 }))), ["dev_sold"]);
  assert.deepEqual(keys(evaluate(st(), snap({ devSells: 3, devSoldPct: 95, devHoldingPct: 0 }))), ["dev_sold", "dev_sold_all"]);
  assert.deepEqual(keys(evaluate(st(), snap({ liquidityUsd: 7500 }))), []); // -25%: no alert
  { const a = st(); const r = evaluate(a, snap({ liquidityUsd: 6900 })); assert.deepEqual(keys(r), [], "one low reading is not enough"); assert.deepEqual(keys(evaluate({ ...a, lowLiq: r.lowLiq }, snap({ liquidityUsd: 6900 }))), ["liq_30"]); }
  assert.deepEqual(keys(evaluate({ ...st(), lowLiq: 1 }, snap({ liquidityUsd: 3000 }))), ["liq_30", "liq_60"]);
  assert.equal(evaluate({ ...st(), lowLiq: 1 }, snap({ liquidityUsd: 9000 })).lowLiq, 0, "recovery resets the streak");
  const w = st(); const r1 = evaluate(w, snap({ liquidityUsd: 20000 })); assert.equal(r1.peakLiq, 20000); w.peakLiq = r1.peakLiq;
  assert.deepEqual(keys(evaluate({ ...w, lowLiq: 1 }, snap({ liquidityUsd: 12000 }))), ["liq_30"], "drop measured from the peak seen during the watch");
  assert.deepEqual(keys(evaluate(st(snap({ liquidityUsd: 400 })), snap({ liquidityUsd: 10 }))), [], "tiny pools are ignored");
  assert.deepEqual(keys(evaluate(st(), snap({ mintAuthority: true, freezeAuthority: true }))), ["freeze_authority", "mint_authority"]);
  assert.deepEqual(keys(evaluate(st(snap({ mintAuthority: true })), snap({ mintAuthority: true }))), [], "already present at start: no alert");
  assert.deepEqual(keys(evaluate(st(), snap({ score: 29 }))), []);
  assert.deepEqual(keys(evaluate(st(), snap({ score: 30, level: "medium" }))), ["score_20"]);
  assert.deepEqual(keys(evaluate(st(), snap({ score: 55, level: "high" }))), ["score_20", "score_40"]);
  const c = st(); const n1 = evaluate(c, snap({ canSell: "no route found" })); assert.deepEqual(keys(n1), []); c.noSell = n1.noSell;
  assert.deepEqual(keys(evaluate(c, snap({ canSell: "no route found" }))), ["cant_sell"], "two checks in a row");
  assert.equal(evaluate(c, snap({ canSell: "unknown" })).noSell, 0, "unknown resets the streak");
});
test("partial checks (buyer signals missing) never trigger dev/score/can't-sell alerts; first complete check becomes the start", () => {
  const pb = snap({ score: 5, partial: true, devSells: null, devHoldingPct: null, canSell: null });
  const r = evaluate(st(pb), snap({ score: 40, devSells: 2 })); assert.deepEqual(keys(r), []); assert.equal(r.rebase, true);
  assert.deepEqual(keys(evaluate(st(), snap({ score: 60, partial: true, devSells: 5 }))), []);
  assert.deepEqual(keys(evaluate({ ...st(), lowLiq: 1 }, snap({ score: 0, partial: true, mintAuthority: true, liquidityUsd: 1000 }))), ["liq_30", "liq_60", "mint_authority"]);
});
test("leaving new-coin scoring re-bases the score instead of alerting", () => {
  const r = evaluate(st(snap({ score: 10, young: true })), snap({ score: 45 })); assert.deepEqual(keys(r), []); assert.equal(r.rescore, true);
  assert.deepEqual(keys(evaluate(st(snap({ score: 10, young: true })), snap({ score: 45, young: true }))), ["score_20"], "still young: a real jump alerts");
});
test("dedupe: each trigger alerts once", () => {
  const w = st(); const r = evaluate(w, snap({ score: 35, devSells: 1 })); w.sent.push(...r.alerts.map((a) => a.key));
  assert.deepEqual(keys(evaluate(w, snap({ score: 36, devSells: 2 }))), []);
  assert.deepEqual(keys(evaluate(w, snap({ score: 52, devSells: 2 }))), ["score_40"]);
});
test("snapOf: liquidity 0 with a live sell route, or a failed market source, counts as unknown", () => {
  assert.equal(snapOf({ facts: { liquidityUsd: 0 }, buyer: { canSell: "yes (pump.fun curve)" } }).liquidityUsd, null);
  assert.equal(snapOf({ facts: { liquidityUsd: 900, marketUnknown: true }, buyer: {} }).liquidityUsd, null);
  assert.equal(snapOf({ facts: { liquidityUsd: 0 }, buyer: { canSell: "no route found" } }).liquidityUsd, 0);
});
test("snapOf reads the RugRadar report", () => {
  const s = snapOf({ riskScore: 42, riskLevel: "medium", facts: { mintAuthority: null, freezeAuthority: "F", liquidityUsd: 1234, priceUsd: 0.1 }, buyer: { canSell: "yes (pump.fun curve)", devSells: 2, devSoldPctOfBought: 50, devHoldingPct: 3 } }, 5);
  assert.deepEqual(s, { at: 5, score: 42, level: "medium", mintAuthority: false, freezeAuthority: true, liquidityUsd: 1234, canSell: "yes (pump.fun curve)", devSells: 2, devSoldPct: 50, devHoldingPct: 3, priceUsd: 0.1 });
});
test("webhook URL rules", () => {
  assert.equal(checkWebhookUrl("https://example.com/h"), null);
  assert.match(String(checkWebhookUrl("http://example.com/h")), /https/);
  for (const u of ["https://127.0.0.1/x", "https://10.0.0.2/x", "https://localhost/x", "https://[::1]/x", "https://192.168.1.1/", "https://169.254.169.254/latest"]) assert.ok(checkWebhookUrl(u), u);
  assert.throws(() => parseWatchInput({ token: MINT, hours: "12", webhook: "https://e.com" }), /24 or 48/);
  assert.throws(() => parseWatchInput({ token: MINT }), /destination/);
});

function harness(o: { report?: () => any; env?: Record<string, string> } = {}) {
  let t = 1_000_000_000_000; let saved: Watch[] = []; let saves = 0; let report = o.report ?? (() => ({ riskScore: 10, riskLevel: "low", facts: { liquidityUsd: 10000 }, buyer: { canSell: "yes (Jupiter route)", devSells: 0, devSoldPctOfBought: 0, devHoldingPct: 5 } }));
  const mk = () => createWatcher({ rugCheck: async () => report(), load: async () => JSON.parse(JSON.stringify(saved)), save: async (ws) => { saved = JSON.parse(JSON.stringify(ws)); saves++; }, publicUrl: "https://x", now: () => t, env: { WATCH_ALLOW_PRIVATE: "1", WATCH_MAX_ACTIVE: "2", ...(o.env ?? {}) } as any });
  return { mk, adv: (ms: number) => { t += ms; }, setReport: (f: () => any) => { report = f; }, saved: () => saved, saves: () => saves };
}
async function receiver() {
  const got: { body: string; sig: string; event: string }[] = [];
  const srv = http.createServer((req, res) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { got.push({ body: b, sig: String(req.headers["x-rugradar-signature"]), event: String(req.headers["x-rugradar-event"]) }); res.end("ok"); }); }).listen(0);
  await new Promise((r) => srv.once("listening", r));
  return { got, url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}/hook`, close: () => srv.close() };
}

test("watch lifecycle: persists, re-checks on interval, signed alert once, survives restart, expires on time", async () => {
  const h = harness(), rx = await receiver();
  try {
    const w1 = h.mk();
    const { watch } = await w1.create({ token: MINT, plan: "24", dest: { type: "webhook", url: rx.url }, paidWith: "credits" });
    assert.equal(h.saved().length, 1, "durable before returning");
    await w1.tick(); assert.equal(rx.got.length, 1); assert.equal(rx.got[0].event, "watch.started");
    assert.ok(verifySignature(watch.secret, rx.got[0].body, rx.got[0].sig), "signature verifies");
    assert.ok(!verifySignature(watch.secret, rx.got[0].body + " ", rx.got[0].sig), "tampered body fails");
    h.adv(5 * 60_000); await w1.tick(); assert.equal(w1._all()[0].checks, 1, "not due before the interval");
    h.setReport(() => ({ riskScore: 45, riskLevel: "medium", facts: { liquidityUsd: 5000 }, buyer: { canSell: "yes", devSells: 2, devSoldPctOfBought: 60, devHoldingPct: 1 } }));
    h.adv(5 * 60_000); await w1.tick();
    assert.equal(rx.got.length, 2); const a = JSON.parse(rx.got[1].body); assert.equal(a.event, "watch.alert");
    assert.deepEqual(a.alerts.map((x: any) => x.kind).sort(), ["dev_sold", "score_worse"]);
    h.adv(10 * 60_000); await w1.tick(); assert.equal(rx.got.length, 3, "liquidity drop confirmed on the 2nd low reading");
    assert.deepEqual(JSON.parse(rx.got[2].body).alerts.map((x: any) => x.kind), ["liquidity_drop"]);
    await new Promise((r) => setTimeout(r, 5200)); assert.ok(h.saved()[0].sent.includes("score_20"), "alerts persisted");
    // restart: a new watcher loads the store and does not repeat alerts
    const w2 = h.mk(); h.adv(10 * 60_000); await w2.tick(); assert.equal(rx.got.length, 3, "no duplicate after restart"); assert.equal(w2._all()[0].status, "active");
    h.adv(24 * 3600_000); await w2.tick(); assert.equal(w2._all()[0].status, "expired");
    assert.equal(JSON.parse(rx.got.at(-1)!.body).event, "watch.expired");
    const before = w2._all()[0].checks; h.adv(60 * 60_000); await w2.tick(); assert.equal(w2._all()[0].checks, before, "expired watches are not re-checked");
  } finally { rx.close(); }
});
test("cap, telegram coming soon, failed delivery retries then gives up", async () => {
  const h = harness(); const w = h.mk();
  await assert.rejects(w.create({ token: MINT, plan: "24", dest: { type: "telegram", chatId: "12345" }, paidWith: "x" }), /coming soon/);
  await assert.rejects(w.create({ token: "nope", plan: "24", dest: { type: "webhook", url: "https://e.com" }, paidWith: "x" }), /Solana mint/);
  await w.create({ token: MINT, plan: "24", dest: { type: "webhook", url: "http://127.0.0.1:1/dead" }, paidWith: "x" });
  await w.create({ token: MINT, plan: "48", dest: { type: "webhook", url: "http://127.0.0.1:1/dead" }, paidWith: "x" });
  await assert.rejects(w.create({ token: MINT, plan: "24", dest: { type: "webhook", url: "https://e.com" }, paidWith: "x" }), (e: any) => e.code === "watch_capacity" && e.status === 503);
  for (let i = 0; i < 6; i++) { await w.tick(); h.adv(20 * 60_000); }
  assert.equal(w._all()[0].outbox.length, 0); assert.equal(w._all()[0].deliveryFails, 4);
  const w48 = w._all()[1]; assert.equal(w48.expiresAt - w48.createdAt, 48 * 3600_000);
});
test("credits path: validates before charging, charges 5/10, refunds on failure", async () => {
  const h = harness(); const w = h.mk(); const bal: Record<string, number> = { k: 7 };
  const d = { watcher: w, publicUrl: "https://x", spendN: async (k: string, n: number) => (bal[k] >= n ? (bal[k] -= n) : null), refundN: async (k: string, n: number) => { bal[k] += n; } };
  await assert.rejects(createWithCredits(d, "k", { token: "bad", webhook: "https://e.com" }), /Solana mint/); assert.equal(bal.k, 7);
  await assert.rejects(createWithCredits(d, "k", { token: MINT, hours: "48", webhook: "http://127.0.0.1:9/h" }), (e: any) => e.code === "insufficient_credits"); assert.equal(bal.k, 7);
  const r: any = await createWithCredits(d, "k", { token: MINT, hours: "24", webhook: "http://127.0.0.1:9/h" }); assert.equal(r.creditsSpent, 5); assert.equal(r.credits_remaining, 2); assert.equal(bal.k, 2); assert.match(r.secret, /^whsec_/);
  bal.k = 10; h.setReport(() => { throw new Error("rpc down"); });
  await assert.rejects(createWithCredits(d, "k", { token: MINT, hours: "48", webhook: "http://127.0.0.1:9/h" }), /refunded/); assert.equal(bal.k, 10);
});
