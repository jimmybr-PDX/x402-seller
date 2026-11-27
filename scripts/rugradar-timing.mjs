#!/usr/bin/env node
/** Buys N RugRadar credits once, then times paid x402 checks vs credit-key checks of the same tokens.
 *  Spends (N + tokens) x $0.01 from .buyer.json on Base. Never prints the private key or the credit key. */
import { readFileSync, writeFileSync } from "node:fs";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";
const B = process.env.ORIGIN ?? "https://x402-seller-pmlm.onrender.com";
const pk = JSON.parse(readFileSync(new URL("../.buyer.json", import.meta.url), "utf8")).privateKey;
const client = new x402Client(); client.register("eip155:*", new ExactEvmScheme(privateKeyToAccount(pk.startsWith("0x") ? pk : `0x${pk}`)));
const pay = wrapFetchWithPayment(fetch, client);
const tokens = (process.env.TOKENS ?? "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN,DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263,0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed").split(",");
const buyN = tokens.length + Number(process.env.EXTRA ?? 0);
const r = await pay(`${B}/credits/buy?credits=${buyN}`); const j = await r.json();
if (!j.key) { console.log("buy failed", r.status, JSON.stringify(j).slice(0, 200)); process.exit(1); }
writeFileSync("/tmp/rugradar-test-key", j.key, { mode: 0o600 });
console.log("bought", j.credits, "credits for $", j.priceUsd, "status", r.status, "store", j.store);
const q = (t) => `${B}/rug-check?token=${t}`;
const rows = tokens.map((t) => ({ token: t.slice(0, 8) }));
// Credit checks first, then wait past RugRadar's 60 s per-token cache so paid checks are not served from cache.
for (const [i, t] of tokens.entries()) {
  const s = Date.now(); const c = await fetch(q(t), { headers: { "X-RugRadar-Key": j.key } }); const cj = await c.json();
  Object.assign(rows[i], { credStatus: c.status, credMs: Date.now() - s, credCached: cj.cached, left: cj.credits_remaining, credScore: cj.riskScore });
}
await new Promise((r) => setTimeout(r, 65000));
for (const [i, t] of tokens.entries()) {
  const s = Date.now(); const a = await pay(q(t)); const aj = await a.json();
  Object.assign(rows[i], { paidStatus: a.status, paidMs: Date.now() - s, paidCached: aj.cached, paidTip: aj.tip ? "yes" : "no", sameScore: aj.riskScore === rows[i].credScore });
}
console.table(rows);
const avg = (k) => Math.round(rows.reduce((x, r) => x + r[k], 0) / rows.length);
console.log("avgPaidMs", avg("paidMs"), "avgCreditMs", avg("credMs"), "gapMs", avg("paidMs") - avg("credMs"), "ratio", (avg("paidMs") / avg("credMs")).toFixed(2));
const bal = await (await fetch(`${B}/credits/balance`, { headers: { "X-RugRadar-Key": j.key } })).json();
console.log("balance", bal.credits, bal.store);
const empty = await fetch(q(tokens[0]), { headers: { "X-RugRadar-Key": j.key } });
console.log("afterEmptyKey status", empty.status, "credits header", empty.headers.get("x-rugradar-credits"));
