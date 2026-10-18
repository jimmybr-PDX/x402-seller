import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "node:net";
import { redact, leaksPrivate, isAdmin, PRIVATE_RULE } from "../src/lib/paper/privacy.js";
import { registerPaper } from "../src/lib/paper/page.js";

const trade = { id: "inflow_v1:M", strat: "inflow_v1", pnlSol: -0.01, roi: -0.05, exitReason: "winner_wallet_sold_exit", exits: { stop_loss: 1, winner_wallet_sold_exit: 2 }, family: { creator: "C", hops: [{ wallet: "F" }] }, priv: { meta: 1 }, named: { name: "x.sol" }, trust: { knownGood: true, reason: "Creator had 3 graduate" }, coinFactoryFunder: { flag: true },
  signals: { rule: "inflow_5sol_60s", netInflowSol: 7, privateInflow: { telegram: true }, winnerBuyers: ["W"], familyKnown: {}, trust: {}, buySol: 3 }, rug: { riskScore: 20, buyer: { devGraduated: 2, devLaunches: 5, devSoldPctOfBought: 0 } } };
test("redact strips every private field, keeps performance", () => {
  const r: any = redact({ tests: [{ strat: "inflow_v1", rule: "sell when a followed winning wallet sells", trades: 3 }, { strat: "copy_r40", rule: "Control: copy, RugRadar score 40 or lower", trades: 2 }], counters: { "inflow_v1.lowInflow": 3, "copy.rugChecks": 4 }, winnersTracked: 30, coinFactoryFunder: { flaggedTrades: 1 }, inflowDiag: {}, recent: [trade] });
  assert.equal(leaksPrivate(r), null); assert.equal(r.tests[0].rule, PRIVATE_RULE); assert.equal(r.tests[1].rule, "Control: copy, RugRadar score 40 or lower");
  assert.equal(r.tests[0].trades, 3); assert.deepEqual(r.counters, { "copy.rugChecks": 4 }); assert.equal(r.recent[0].pnlSol, -0.01); assert.equal(r.recent[0].signals.buySol, 3); assert.equal(r.recent[0].rug.riskScore, 20); assert.equal(r.recent[0].exitReason, "private_signal_exit"); assert.deepEqual(r.recent[0].exits, { stop_loss: 1 });
  const txt = JSON.stringify(r); for (const bad of ["x.sol", "knownGood", "winnerBuyers", "privateInflow", "netInflowSol", "devGraduated", "hops", "coinFactoryFunder", "graduate", "winner_wallet"]) assert.ok(!txt.includes(bad), bad);
});
test("admin key: off when unset or short, timing-safe match otherwise", () => {
  const req = (h?: string) => ({ header: (n: string) => (n.toLowerCase() === "x-paper-admin-key" ? h : undefined) }) as any;
  assert.equal(isAdmin(req("x"), {} as any), false); assert.equal(isAdmin(req("short"), { PAPER_ADMIN_KEY: "short" } as any), false);
  const k = "k".repeat(32); assert.equal(isAdmin(req(k), { PAPER_ADMIN_KEY: k } as any), true); assert.equal(isAdmin(req(k + "x"), { PAPER_ADMIN_KEY: k } as any), false); assert.equal(isAdmin(req(), { PAPER_ADMIN_KEY: k } as any), false);
});
test("public paper endpoints carry no private fields or sections", async () => {
  delete process.env.PAPER_ADMIN_KEY;
  const app = express(); registerPaper(app); const srv = app.listen(0); const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  try {
    for (const p of ["/paper.json", "/paper/trades.json", "/paper/rugradar.json"]) { const r = await fetch(base + p); assert.equal(r.status, 200); const j = await r.json(); assert.equal(leaksPrivate(j), null, p); assert.ok(!("privateSignals" in (j as any)) && !("namedWallet" in (j as any)), p); }
    for (const p of ["/paper", "/paper/rugradar"]) { const h = await (await fetch(base + p)).text(); for (const bad of [/Creator family/i, /private signal/i, /Named wallet/i, /known good dev/i, /winner wallet/i, /Name and ticker history/i]) assert.ok(!bad.test(h), `${p} ${bad}`); }
  } finally { srv.closeAllConnections(); srv.close(); }
});
