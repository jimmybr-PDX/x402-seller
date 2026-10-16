/**
 * Oct 16: free backup for pump.fun trade lookups (paper bots only). Reads each coin's buys/sells straight from Solana:
 * one websocket to a free public RPC, one logsSubscribe per tracked coin's bonding-curve account, TradeEvents decoded from the logs
 * (buyer/seller wallet, SOL amount, price from the curve's virtual reserves). Current price = bonding-curve reserves (batched getMultipleAccounts, cached 3 s).
 * Load control: at most MAX coins tracked at once; open positions pinned, coins that passed early filters kept longer, others dropped after ~2 min.
 */
import { createHash } from "node:crypto";
import { rpcUrl, heliusWsUrl, budgetOk, noteWs, noteWsConnect, isHeliusUrl } from "./helius.js";
import { address, getAddressDecoder, getAddressEncoder, getProgramDerivedAddress } from "@solana/kit";
const RPC = process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";
const WS_URLS = [process.env.SOLANA_WS_URL, "wss://api.mainnet-beta.solana.com", "wss://solana-rpc.publicnode.com"].filter(Boolean) as string[];
const TD = createHash("sha256").update("event:TradeEvent").digest().subarray(0, 8);
const b58 = getAddressDecoder(), enc = getAddressEncoder();
const MAX = Number(process.env.PAPER_CHAIN_MAX_COINS ?? 80);
export type T = { type: "buy" | "sell"; userAddress: string; amountSol: number; priceSol: number; timestamp: string; tx: string; slotIndexId: string };
type Coin = { mint: string; curve: string; trades: T[]; until: number; pinned: number; sub: number | null; reqId: number | null; added: number };
const coins = new Map<string, Coin>(), bySub = new Map<number, string>(), byReq = new Map<number, string>();
let ws: any = null, wsIdx = 0, reqN = 10, on = false;
export const chainStat = { on: false, since: null as string | null, tracked: 0, tradesSeen: 0, served: 0, priced: 0, connects: 0, dropped: 0, rpc: "" };
async function curveOf(mint: string) { const [pda] = await getProgramDerivedAddress({ programAddress: address("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"), seeds: ["bonding-curve", enc.encode(address(mint))] }); return String(pda); }
function send(o: unknown) { try { if (ws?.readyState === 1) ws.send(JSON.stringify(o)); } catch {} }
function subscribe(c: Coin) { if (c.sub != null || c.reqId != null || ws?.readyState !== 1) return; c.reqId = ++reqN; byReq.set(c.reqId, c.mint); send({ jsonrpc: "2.0", id: c.reqId, method: "logsSubscribe", params: [{ mentions: [c.curve] }, { commitment: "confirmed" }] }); }
function connect() {
  const W = (globalThis as any).WebSocket; if (!W || ws) return;
  // trade streams are heavy (~1+ GB/day), so public RPCs come first; Helius only as last resort while the budget allows
  const hw = heliusWsUrl(); const list = hw && budgetOk(5000) ? [...WS_URLS, hw] : WS_URLS;
  const url = list[wsIdx % list.length]; const helius = isHeliusUrl(url); chainStat.rpc = helius ? "Helius websocket" : url.replace(/\?.*$/, ""); chainStat.connects++; if (helius) noteWsConnect();
  const w = new W(url); ws = w;
  w.onopen = () => { for (const c of coins.values()) { c.sub = null; c.reqId = null; subscribe(c); } };
  w.onmessage = (ev: any) => { try {
    if (helius) { noteWs(String(ev.data).length); if (!budgetOk(500)) { try { w.close(); } catch {} return; } }
    const j = JSON.parse(String(ev.data));
    if (j.id && byReq.has(j.id)) { const m = byReq.get(j.id)!; byReq.delete(j.id); const c = coins.get(m); if (c && typeof j.result === "number") { c.sub = j.result; c.reqId = null; bySub.set(j.result, m); } return; }
    const v = j.params?.result?.value; const m = bySub.get(j.params?.subscription); if (!v?.logs || !m) return; const c = coins.get(m); if (!c) return;
    for (const l of v.logs as string[]) { if (!l.startsWith("Program data: ")) continue; const b = Buffer.from(l.slice(14), "base64"); if (b.length < 129 || !b.subarray(0, 8).equals(TD)) continue;
      if (b58.decode(b.subarray(8, 40)) !== m) continue;
      const sol = Number(b.readBigUInt64LE(40)) / 1e9, buy = b[56] === 1, user = b58.decode(b.subarray(57, 89)), ts = Number(b.readBigInt64LE(89)), vs = Number(b.readBigUInt64LE(97)), vt = Number(b.readBigUInt64LE(105));
      c.trades.unshift({ type: buy ? "buy" : "sell", userAddress: user, amountSol: sol, priceSol: vt > 0 ? (vs / 1e9) / (vt / 1e6) : 0, timestamp: new Date(ts * 1000).toISOString(), tx: String(v.signature ?? ""), slotIndexId: String(j.params?.result?.context?.slot ?? "").padStart(13, "0") });
      if (c.trades.length > 400) c.trades.length = 400; chainStat.tradesSeen++; }
  } catch {} };
  w.onclose = () => { if (ws === w) { ws = null; wsIdx++; for (const c of coins.values()) { c.sub = null; c.reqId = null; } bySub.clear(); byReq.clear(); if (on) setTimeout(connect, 3000).unref?.(); } };
  w.onerror = () => {};
}
function drop(m: string) { const c = coins.get(m); if (!c) return; if (c.sub != null) { send({ jsonrpc: "2.0", id: ++reqN, method: "logsUnsubscribe", params: [c.sub] }); bySub.delete(c.sub); } coins.delete(m); chainStat.dropped++; }
/** Start tracking a coin. keepS = how long to keep it; pin for open positions. */
export async function track(mint: string, keepS = 120, curve?: string) {
  if (!on) return; const now = Date.now(); const c0 = coins.get(mint);
  if (c0) { c0.until = Math.max(c0.until, now + keepS * 1000); return; }
  if (coins.size >= MAX) { // evict the unpinned coin closest to expiry
    const v = [...coins.values()].filter((c) => !c.pinned).sort((a, b) => a.until - b.until)[0]; if (!v) return; drop(v.mint); }
  const c: Coin = { mint, curve: curve ?? await curveOf(mint), trades: [], until: now + keepS * 1000, pinned: 0, sub: null, reqId: null, added: now };
  coins.set(mint, c); subscribe(c);
}
export function pin(mint: string, yes: boolean) { const c = coins.get(mint); if (c) c.pinned = Math.max(0, c.pinned + (yes ? 1 : -1)); else if (yes && on) track(mint, 600).then(() => pin(mint, true)).catch(() => {}); }
/** Trades newest first in pump.fun's swap-api shape, or null if we are not tracking this coin. */
export function chainTrades(mint: string, limit = 100): T[] | null { const c = coins.get(mint); if (!c) return null; chainStat.served++; return c.trades.slice(0, limit); }
const priceCache = new Map<string, { at: number; v: { priceSol: number; vsol: bigint; vtok: bigint; complete: boolean } | null }>();
/** Current price from bonding-curve reserves (batched, cached 3 s). */
export async function curveState(mints: string[]) {
  const now = Date.now(), need = mints.filter((m) => !(priceCache.get(m) && now - priceCache.get(m)!.at < 3000));
  for (let i = 0; i < need.length; i += 50) {
    const part = need.slice(i, i + 50); const keys = await Promise.all(part.map((m) => coins.get(m)?.curve ?? curveOf(m)));
    const r: any = await fetch(rpcUrl(), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getMultipleAccounts", params: [keys, { encoding: "base64", commitment: "confirmed" }] }), signal: AbortSignal.timeout(5000) }).then((x) => x.json()).catch(() => null);
    const vals = r?.result?.value; if (!Array.isArray(vals)) continue;
    part.forEach((m, k) => { const b = Buffer.from(vals[k]?.data?.[0] ?? "", "base64"); if (b.length < 49) { priceCache.set(m, { at: now, v: null }); return; }
      const vtok = b.readBigUInt64LE(8), vsol = b.readBigUInt64LE(16); priceCache.set(m, { at: now, v: { priceSol: Number(vtok) > 0 ? (Number(vsol) / 1e9) / (Number(vtok) / 1e6) : 0, vsol, vtok, complete: b[48] === 1 } }); chainStat.priced++; });
  }
  if (priceCache.size > 3000) for (const k of [...priceCache.keys()].slice(0, 1000)) priceCache.delete(k);
  return Object.fromEntries(mints.map((m) => [m, priceCache.get(m)?.v ?? null]));
}
export function setOn(v: boolean) {
  if (v === on) return; on = v; chainStat.on = v; chainStat.since = new Date().toISOString();
  if (v) connect(); else { for (const m of [...coins.keys()]) if (!coins.get(m)!.pinned) drop(m); if (!coins.size && ws) { const w = ws; ws = null; try { w.close(); } catch {} } }
}
export const isOn = () => on;
setInterval(() => { const now = Date.now(); for (const c of [...coins.values()]) if (!c.pinned && now > c.until) drop(c.mint); chainStat.tracked = coins.size; }, 10_000).unref?.();
