import { rugCheck } from "../src/lib/rug.js";
import fs from "node:fs";
const toks = fs.readFileSync("/tmp/toks.txt","utf8").trim().split("\n").map(l=>l.split(" "));
const out: any = {};
await Promise.all(toks.map(async ([n,m]) => { const t=Date.now(); try { out[n] = await rugCheck(m!, "solana", { noCache: true }); out[n].ms = Date.now()-t; } catch (e) { out[n] = { error: String(e) }; } }));
fs.writeFileSync("/tmp/rr5.json", JSON.stringify(out));
for (const [n] of toks) { const r = out[n!]; console.log(n, r.riskScore, r.riskLevel, r.ms+"ms", JSON.stringify(r.buyer)?.slice(0,700), "\n  ", r.buyerSummary, "\n   unknown:", r.unknownSignals); }
process.exit(0);
