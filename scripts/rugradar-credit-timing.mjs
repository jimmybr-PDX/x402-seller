#!/usr/bin/env node
/** Credit-key-only RugRadar timing. BUY=N buys N credits once (N x $0.01 from .buyer.json) and saves the key to
 *  /tmp/rugradar-test-key (0600, never printed); later runs reuse it. TOKENS=comma list. */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";
const B = process.env.ORIGIN ?? "https://x402-seller-pmlm.onrender.com";
const KF = "/tmp/rugradar-test-key";
if (process.env.BUY) {
  const pk = JSON.parse(readFileSync(new URL("../.buyer.json", import.meta.url), "utf8")).privateKey;
  const c = new x402Client(); c.register("eip155:*", new ExactEvmScheme(privateKeyToAccount(pk.startsWith("0x") ? pk : `0x${pk}`)));
  const j = await (await wrapFetchWithPayment(fetch, c)(`${B}/credits/buy?credits=${Number(process.env.BUY)}`)).json();
  if (!j.key) { console.log("buy failed"); process.exit(1); }
  writeFileSync(KF, j.key, { mode: 0o600 }); console.log("bought", j.credits, "credits");
}
if (!existsSync(KF)) { console.log("no key"); process.exit(1); }
const key = readFileSync(KF, "utf8").trim();
const tokens = (process.env.TOKENS ?? "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN,DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263").split(",");
const rows = [];
for (const t of tokens) {
  const s = Date.now(); const r = await fetch(`${B}/rug-check?token=${t}`, { headers: { "X-RugRadar-Key": key } }); const j = await r.json();
  rows.push({ token: t.slice(0, 8), status: r.status, ms: Date.now() - s, left: j.credits_remaining, score: j.riskScore, server: j.facts?.timingsMs ? JSON.stringify(j.facts.timingsMs) : "" });
}
console.table(rows);
console.log("avgCreditMs", Math.round(rows.reduce((a, r) => a + r.ms, 0) / rows.length));
