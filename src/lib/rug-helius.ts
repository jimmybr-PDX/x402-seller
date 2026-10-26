/**
 * RugRadar paid report: on-chain launch-trade fallback through Helius (free plan, 1 credit per call).
 * Used only when pump.fun's public trade API gave nothing (it returns HTTP 403 to Render's IP). Reads the OLDEST
 * signatures of the pump.fun bonding-curve account (<= 3 pages), then the first 15 transactions in ONE batched
 * getTransaction call, and derives buyer wallet / side / SOL / token amount / slot / time. At most 18 credits per
 * uncached check (the caller's per-mint cache makes repeats free). Daily guard: fallback spend over 5,000 credits
 * (or the shared Helius day / month budget) skips the fallback. The key is never logged. Public on-chain data only.
 */
import type { CTrade } from "./rug-paid.js";
import { heliusStatus, noteHttp } from "./paper/helius.js";

const PUMP_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
export const FALLBACK_DAILY_CREDITS = Number(process.env.RUG_HELIUS_DAILY_CREDITS ?? 5000);
export const MAX_PAGES = 3, FIRST_TXS = 15, PAGE = 1000;
const key = () => process.env.HELIUS_API_KEY || process.env.GROKBOT_API_KEY || "";
const day = () => new Date().toISOString().slice(0, 10);
let spent = { day: day(), n: 0 };
export const fallbackSpent = () => (spent.day === day() ? spent.n : 0);
export function __resetHeliusGuard() { spent = { day: day(), n: 0 }; }
export function __spendForTest(n: number) { spent = { day: day(), n: spent.n + n }; }
function charge(n: number) { if (spent.day !== day()) spent = { day: day(), n: 0 }; spent.n += n; try { noteHttp(n); } catch {} }
/** Can the fallback run now? Own 5k/day guard plus the shared Helius day (30k) and month (1M) budgets. */
export function fallbackAllowed(): boolean {
  if (!key() || fallbackSpent() >= FALLBACK_DAILY_CREDITS) return false;
  try { const s = heliusStatus(); if (s.todayCredits + 25 > 30_000 || s.monthToDateCredits + 25 > 950_000) return false; } catch {}
  return true;
}
let lastWarn = 0;
const warn = (m: string) => { if (Date.now() - lastWarn > 5000) { lastWarn = Date.now(); console.warn(`[rug-paid] helius ${m}`); } };

async function call(body: unknown, credits: number): Promise<any> {
  charge(credits);
  const r = await fetch(`https://mainnet.helius-rpc.com/?api-key=${key()}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(2800) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

export async function curvePda(mint: string): Promise<string> {
  const { getProgramDerivedAddress, getAddressEncoder, address } = await import("@solana/kit");
  const [pda] = await getProgramDerivedAddress({ programAddress: address(PUMP_PROGRAM), seeds: ["bonding-curve", getAddressEncoder().encode(address(mint))] });
  return pda;
}

/** Pure parser: jsonParsed getTransaction results (oldest first) -> trades. Owners other than the curve whose token balance of `mint` changed are the traders. */
export function parseTrades(txs: any[], mint: string, curve: string): CTrade[] {
  const out: CTrade[] = [];
  for (const t of txs) {
    if (!t || t.meta?.err) continue;
    const m = t.meta ?? {}, keys: any[] = t.transaction?.message?.accountKeys ?? [];
    const ci = keys.findIndex((k) => (k?.pubkey ?? k) === curve);
    const lam = ci >= 0 ? Number(m.postBalances?.[ci]) - Number(m.preBalances?.[ci]) : NaN;
    const delta = new Map<string, number>();
    const add = (xs: any[] | undefined, sign: number) => { for (const b of xs ?? []) if (b?.mint === mint && b.owner && b.owner !== curve) delta.set(b.owner, (delta.get(b.owner) ?? 0) + sign * Number(b.uiTokenAmount?.uiAmountString ?? b.uiTokenAmount?.uiAmount ?? 0)); };
    add(m.postTokenBalances, 1); add(m.preTokenBalances, -1);
    const movers = [...delta].filter(([, d]) => isFinite(d) && Math.abs(d) > 0);
    const total = movers.reduce((a, [, d]) => a + Math.abs(d), 0);
    const ts = Number(t.blockTime) * 1000;
    if (!movers.length || !isFinite(ts)) continue;
    for (const [w, d] of movers) out.push({ w, k: d > 0 ? "buy" : "sell", sol: isFinite(lam) && total > 0 ? Math.abs(lam) / 1e9 * (Math.abs(d) / total) : 0, usd: null, amt: Math.abs(d), ts, slot: String(t.slot) });
  }
  return out;
}

export type HeliusRead = { trades: CTrade[]; complete: boolean; credits: number } | null;
/** First trades of a pump.fun coin straight from chain. null = unavailable (guard, no key, error, launch beyond 3 pages). Never throws. */
export async function heliusLaunchTrades(mint: string): Promise<HeliusRead> {
  if (!fallbackAllowed()) return null;
  let credits = 0;
  try {
    const curve = await curvePda(mint);
    let sigs: any[] = [], before: string | undefined, reached = false;
    for (let p = 0; p < MAX_PAGES; p++) {
      const d = await call({ jsonrpc: "2.0", id: 1, method: "getSignaturesForAddress", params: [curve, { limit: PAGE, commitment: "confirmed", ...(before ? { before } : {}) }] }, 1); credits++;
      if (!Array.isArray(d?.result)) throw new Error(`sigs ${d?.error?.code ?? "bad"}`);
      sigs = d.result; if (sigs.length < PAGE) { reached = true; break; }
      before = sigs[sigs.length - 1].signature;
    }
    if (!reached) { warn(`launch beyond ${MAX_PAGES * PAGE} signatures`); return { trades: [], complete: false, credits }; }
    const first = sigs.filter((s) => !s.err).slice(-FIRST_TXS).reverse(); // oldest first
    if (!first.length) return { trades: [], complete: false, credits };
    const arr = await call(first.map((s, i) => ({ jsonrpc: "2.0", id: i, method: "getTransaction", params: [s.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 255, commitment: "confirmed" }] })), first.length); credits += first.length;
    if (!Array.isArray(arr)) throw new Error("batch");
    const txs = arr.sort((a, b) => a.id - b.id).map((x) => x.result).filter(Boolean);
    if (!txs.length) throw new Error(`no transactions (${String(arr.find((x: any) => x?.error)?.error?.code ?? "null")})`);
    return { trades: parseTrades(txs, mint, curve), complete: true, credits };
  } catch (e: any) {
    warn(`read failed: ${String(e?.message ?? e).replace(/api-key=[^&\s"]+/gi, "").slice(0, 60)}`);
    return null;
  }
}
