#!/usr/bin/env node
/** Credits vs paid x402, cache bypassed (nocache=1). Each token measured ROUNDS times in each mode.
 *  Also times the free unpaid 402 round trip. Spend: tokens x ROUNDS x $0.02 (credits + paid). No secrets printed. */
import { readFileSync } from "node:fs";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";
const B = process.env.ORIGIN ?? "https://x402-seller-pmlm.onrender.com";
const ROUNDS = Number(process.env.ROUNDS ?? 2);
const tokens = (process.env.TOKENS ?? "").split(",").filter(Boolean);
const pk = JSON.parse(readFileSync(new URL("../.buyer.json", import.meta.url), "utf8")).privateKey;
const c = new x402Client(); c.register("eip155:*", new ExactEvmScheme(privateKeyToAccount(pk.startsWith("0x") ? pk : `0x${pk}`)));
const pay = wrapFetchWithPayment(fetch, c);
const need = tokens.length * ROUNDS;
const bj = await (await pay(`${B}/credits/buy?credits=${need}`)).json();
if (!bj.key) { console.log("buy failed"); process.exit(1); }
console.log("bought", bj.credits, "credits");
const url = (t) => `${B}/rug-check?token=${t}&nocache=1`;
const rows = [];
for (let r = 0; r < ROUNDS; r++) for (const t of tokens) {
  // alternate order each round so neither mode always goes first
  const modes = (r + tokens.indexOf(t)) % 2 ? ["paid", "credit"] : ["credit", "paid"];
  const row = { round: r + 1, token: t.slice(0, 8) };
  for (const m of modes) {
    const s = Date.now();
    const res = m === "paid" ? await pay(url(t)) : await fetch(url(t), { headers: { "X-RugRadar-Key": bj.key } });
    const j = await res.json(); const ms = Date.now() - s;
    Object.assign(row, { [m + "Ms"]: ms, [m + "Status"]: res.status, [m + "Server"]: j.facts?.timingsMs?.total ?? null, [m + "Score"]: j.riskScore, [m + "Conf"]: j.confidence });
  }
  const s = Date.now(); const u = await fetch(url(t)); await u.text(); row.unpaid402Ms = Date.now() - s; row.unpaidStatus = u.status;
  rows.push(row);
}
console.table(rows.map((r) => ({ r: r.round, token: r.token, credit: r.creditMs, paid: r.paidMs, s402: r.unpaid402Ms, srvC: r.creditServer, srvP: r.paidServer, scoreC: r.creditScore, scoreP: r.paidScore, conf: r.creditConf, ok: r.creditStatus === 200 && r.paidStatus === 200 })));
const avg = (k) => rows.reduce((a, r) => a + (r[k] ?? 0), 0) / rows.length;
const med = (k) => { const v = rows.map((r) => r[k]).sort((a, b) => a - b); return v[Math.floor(v.length / 2)]; };
const overhead = rows.map((r) => r.paidMs - r.paidServer - (r.creditMs - r.creditServer));
console.log(JSON.stringify({ n: rows.length, avgCreditMs: Math.round(avg("creditMs")), avgPaidMs: Math.round(avg("paidMs")), medCreditMs: med("creditMs"), medPaidMs: med("paidMs"),
  avgUnpaid402Ms: Math.round(avg("unpaid402Ms")), avgServerCheckMsCredit: Math.round(avg("creditServer")), avgServerCheckMsPaid: Math.round(avg("paidServer")),
  avgPaymentOverheadMs: Math.round(overhead.reduce((a, b) => a + b, 0) / overhead.length), paidFasterCount: rows.filter((r) => r.paidMs < r.creditMs).length }));
const byTok = {}; for (const r of rows) (byTok[r.token] ??= new Set()).add(r.creditScore).add(r.paidScore);
console.log("distinctScoresPerToken", JSON.stringify(Object.fromEntries(Object.entries(byTok).map(([k, v]) => [k, [...v]]))));
