/**
 * Local quality check for every paid tool (no payments, no server): calls the same library functions the
 * paid handlers call, maps results to the HTTP status the buyer would get (400 input / 422 nothing found /
 * 503 upstream), and records latency + output. Usage:
 *   npx tsx scripts/qa-local.ts [tool ...]      # tools: report read check news price solana balance tx gas
 * Writes full outputs to $QA_OUT (default ./qa-out). Free: only public RPC / public APIs are called.
 */
import fs from "node:fs";
import path from "node:path";
import { researchBrief } from "../src/lib/research.js";
import { readPage } from "../src/lib/read.js";
import { checkX402Endpoint } from "../src/lib/check.js";
import { newsSearch, warmNews } from "../src/lib/news.js";
import { PriceInputError, tokenPrice } from "../src/lib/price.js";
import { SolanaInputError, solanaTokenPrice } from "../src/lib/solana.js";
import { WalletInputError, walletBalances } from "../src/lib/wallet.js";
import { TxInputError, txLookup } from "../src/lib/tx.js";
import { GasInputError, gasNow } from "../src/lib/gas.js";
import { InputError } from "../src/lib/net.js";

const OUT = process.env.QA_OUT ?? "qa-out";
fs.mkdirSync(OUT, { recursive: true });
const INPUT_ERRORS = [PriceInputError, SolanaInputError, WalletInputError, TxInputError, GasInputError, InputError];
type Case = { tool: string; name: string; run: () => Promise<any> };
const rpcJson = async (url: string, method: string, params: unknown[]) =>
  (await (await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json() as any).result;

async function recentEvmTx(rpc: string): Promise<string> {
  const b = await rpcJson(rpc, "eth_getBlockByNumber", ["latest", false]);
  return b.transactions[Math.min(3, b.transactions.length - 1)];
}
async function recentSolSig(): Promise<string> {
  const r = await rpcJson("https://api.mainnet-beta.solana.com", "getSignaturesForAddress", ["JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4", { limit: 5 }]);
  return r.find((x: any) => !x.err)?.signature ?? r[0].signature;
}

const cases: Case[] = [];
const add = (tool: string, name: string, run: () => Promise<any>) => cases.push({ tool, name, run });
const report = (q: string) => () => {
  if (q.trim().length < 2 || q.length > 300) throw new InputError("q is required (2-300 chars)");
  return researchBrief(q).then((b) => b ?? { error: "no_sources" });
};
for (const q of (process.env.QA_REPORT_QS ?? "What causes inflation?|Why is the sky blue?|How does a heat pump work?|What is retrieval-augmented generation?|history of the transistor|Why do leaves change color in autumn?|What causes earthquakes?|qzxv wkjh plorf|x").split("|")) add("report", q, report(q));
for (const u of ["https://en.wikipedia.org/wiki/HTTP_402", "https://www.coinbase.com/developer-platform/products/x402", "https://docs.cdp.coinbase.com/x402/welcome", "http://example.com", "https://localhost/", "https://no-such-host-x402qa.invalid/", "not a url", "https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf"]) add("read", u, () => readPage(u, 20000));
for (const u of ["https://x402-seller-pmlm.onrender.com/report", "https://api.anchor-x402.com/v1/price/token", "https://example.com", "http://example.com/x", "nope"]) add("check", u, () => checkX402Endpoint(u, "GET"));
for (const [q, o] of [["bitcoin ETF", {}], ["Federal Reserve interest rates", {}], ["OpenAI", { hours: 24, limit: 5 }], ["the and of", {}], ["zzqxv flormp", {}], ["solana", { hours: 9999, limit: 0 }]] as const) add("news", `${q} ${JSON.stringify(o)}`, () => newsSearch(q, o as any));
for (const [t, c] of [["ETH", undefined], ["BTC", undefined], ["PEPE", undefined], ["USDC", undefined], ["0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed", "base"], ["ARB", "arbitrum"], ["POL", "polygon"], ["SOL", undefined], ["FOOBARCOIN", undefined], ["0x1234", undefined], ["ETH", "dogechain"]] as const) add("price", `${t} ${c ?? ""}`, () => tokenPrice(t, c));
for (const t of ["SOL", "JUP", "BONK", "WIF", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", "NOTATOKEN", "1111111111111111111111111111111111"]) add("solana", t, () => solanaTokenPrice(t));
for (const [a, c] of [["vitalik.eth", undefined], ["0x079471E6F43b6feeF80895E19cBFcBB496904852", "base"], ["0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045", "polygon"], ["787RZwDGpjmRsG5wgnyBeWQHBuARax8Qo6P7dmDuqKeW", undefined], ["0x1234", undefined], ["thisnamedoesnotexist-qa-x402.eth", undefined], ["vitalik.eth", "avalanche"]] as const) add("balance", `${a} ${c ?? ""}`, () => walletBalances(a, { chain: c }));
add("tx", "base x402 payment", () => txLookup("0xa565aff51f0109d9a9c9028faa45338b3ebab49543fc25457e82326664ca8c52"));
add("tx", "ethereum recent", async () => txLookup(await recentEvmTx("https://ethereum-rpc.publicnode.com")));
add("tx", "arbitrum recent", async () => txLookup(await recentEvmTx("https://arbitrum-one-rpc.publicnode.com"), "arbitrum"));
add("tx", "polygon recent", async () => txLookup(await recentEvmTx("https://polygon-bor-rpc.publicnode.com")));
add("tx", "solana recent", async () => txLookup(await recentSolSig()));
add("tx", "not found", () => txLookup("0x" + "ab".repeat(32)));
add("tx", "bad hash", () => txLookup("0x1234"));
add("tx", "wrong chain for sig", () => txLookup("5".repeat(88), "base"));
for (const c of [undefined, "ethereum", "base", "arbitrum", "polygon", "solana", "avalanche"]) add("gas", c ?? "all", () => gasNow(c));

const want = new Set(process.argv.slice(2));
const summarize = (tool: string, o: any): string => {
  if (!o || typeof o !== "object") return String(o);
  if (o.error) return `${o.error}: ${o.message ?? ""}`;
  switch (tool) {
    case "report": return `[${o.confidence}] ${o.answer}\n      KP: ${(o.key_points ?? []).map((k: any) => k.text.slice(0, 110)).join(" | ")}\n      SRC: ${(o.sources ?? []).map((s: any) => s.publisher).join(", ")}`;
    case "read": return `${o.title} | words=${o.wordCount} | md=${String(o.markdown).slice(0, 160).replace(/\n/g, " ")}`;
    case "check": return `score=${o.score} grade=${o.grade} ${o.passed}/${o.total} fixes=${(o.fixes ?? []).length}: ${(o.fixes ?? []).slice(0, 3).join(" | ").slice(0, 300)}`;
    case "news": return `count=${o.count} hours=${o.hours} | ${(o.articles ?? []).slice(0, 3).map((a: any) => `${a.title} (${a.source}, ${a.publishedAt})`).join(" | ")}`;
    case "price": case "solana": return `${o.token?.symbol} ${o.token?.chain} $${o.priceUsd} conf=${o.confidence} 24h=${o.change24hPct} pools=${o.pools?.length} depth=${o.totalDepthUsd} ${o.note ?? ""}`;
    case "balance": return `total=$${o.totalUsd} ${(o.chains ?? []).map((c: any) => `${c.chain}:${c.native?.symbol}=${c.native?.balance} tok=${c.tokens?.length} $${c.totalUsd}${c.error ? " ERR " + c.error : ""}`).join("; ")}`;
    case "tx": return `${o.chain} ${o.status} ${o.method?.name ?? ""} fee=${JSON.stringify(o.fee ?? null).slice(0, 100)} transfers=${(o.tokenTransfers ?? o.tokenChanges ?? []).length}`;
    case "gas": return (o.chains ?? []).map((c: any) => `${c.chain}: base=${c.baseFeeGwei ?? c.baseFeeLamportsPerSignature} prio=${JSON.stringify(c.priorityFeeGwei ?? c.priorityFeeMicroLamportsPerCu)} erc20$=${c.costStandard?.erc20Transfer?.usd ?? ""}`).join("\n      ");
  }
  return JSON.stringify(o).slice(0, 200);
};
warmNews();
if (!want.size || want.has("news")) await new Promise((r) => setTimeout(r, 15000)); // let the news index load
const rows: any[] = [];
for (const c of cases) {
  if (want.size && !want.has(c.tool)) continue;
  const t = Date.now();
  let status = 200, out: any;
  try {
    out = await c.run();
    if (out?.error) status = out.error === "no_search_terms" ? 400 : 422;
  } catch (e: any) {
    status = INPUT_ERRORS.some((E) => e instanceof E) ? 400 : 503;
    out = { error: status === 400 ? "bad_input" : "upstream", message: e?.message ?? String(e) };
  }
  const ms = Date.now() - t;
  rows.push({ tool: c.tool, name: c.name, status, ms });
  fs.writeFileSync(path.join(OUT, `${c.tool}-${c.name.replace(/[^a-z0-9]+/gi, "_").slice(0, 60)}.json`), JSON.stringify(out, null, 2));
  console.log(`[${c.tool}] ${c.name} -> ${status} in ${ms} ms\n      ${summarize(c.tool, out)}`);
}
fs.writeFileSync(path.join(OUT, "summary.json"), JSON.stringify(rows, null, 2));
process.exit(0);
