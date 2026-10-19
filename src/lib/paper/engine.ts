/**
 * PAPER-TRADING ONLY engine. No wallets, no keys, no transactions are ever signed or sent.
 * Watches new pump.fun launches and simulates 3 strategies with real-time Jupiter quotes for fills.
 * Costs: pool fees (inside Jupiter quote), base fee, priority fee (+ tip for sniper), ATA rent (refunded on close),
 * measured latency (detection + RPC round-trips + 1 slot) with a re-quote at the simulated landing time,
 * simulated failed buys/sells, and write-off when no sell route exists. No LLM calls.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import { jupFetch } from "../jup-gate.js";
import { monitorEventLoopDelay } from "node:perf_hooks";
const loopLag = monitorEventLoopDelay({ resolution: 20 }); loopLag.enable();
import { getProgramDerivedAddress, getAddressEncoder, getAddressDecoder, address } from "@solana/kit";
import { familyOf, type Family } from "./family.js";
import { namedWallet, type Named } from "./named.js";
import { rpcUrl, heliusWsUrl, isHeliusUrl, noteWs, noteWsConnect, budgetOk, heliusStatus, loadHelius, heliusDaily, heliusEnabled, markPublicBad, PUBLIC_RPC_HTTP } from "./helius.js";
import { track, pin, chainTrades, curveState, setOn, isOn, chainStat } from "./chain-trades.js";
import { privateSignals, noteLaunchMeta, launchMeta, type Priv } from "./private-signals.js";
import { startLagWatch, track as lagTrack, lagStatus } from "../lag.js";
import { initStore, loadState, loadTrades, appendTrade, saveState, storeStatus, loadFile, writeFile, appendLine, takeHistoryDirty } from "./store.js";
import { noteCoinTrades, noteLaunch, marketTick, flushHistory, histStat } from "./history.js";
import { freeFeedOn, freeFeedStatus } from "./free-feed.js";

const SOL = "So11111111111111111111111111111111111111112";
const UA = { "user-agent": "Mozilla/5.0 (paper-trader)", accept: "application/json" };
const LAMPORTS = 1e9;
const SIZE_SOL = Number(process.env.PAPER_SIZE_SOL ?? 0.1);
const RPC = process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";
const BASE_FEE = 5000, ATA_RENT = 2039280;
export type Strat = string; // "sniper", or "<copy|edge>_r<maxRugScore>" threshold variants
type Base = "copy" | "sniper" | "edge" | "inflow" | "early";
// Oct 15 re-tune: copy_r40 stays as the CONTROL; r25/r60 retired (same coins, no better on held-out trades); edge keeps r25 only.
export const RUG_VARIANTS: Record<"copy" | "edge", number[]> = { copy: [40], edge: [25] };
/** Oct 15 test variants (see "What we learned"). v2 = entry filter that held up on held-out trades; v2ff = v2 + faster exits (untested idea). */
export const V2 = { minWinners: 2, minBuyers: 12, maxRug: 49 };
const V2_STRATS = ["copy_v2", "copy_v2ff", "copy_v2cp", "copy_v2cs"];
/** Oct 15 (11 PM): sniper paused (no new buys; history stays). copy_v2cp = v2 + crash-protect exits. */
export const PAUSED: Record<string, string> = { sniper: "paused Oct 15 (−10.06 SOL / 178 trades)" };
export const CP = { dropPct: 15, windowS: 10, creatorSellSol: 0.3, holderSellFrac: 0.4, holderSellMinSol: 0.5 };
export const TEST_RULE = "After about 50 trades each, compare every test with the control (copy_r40) on total SOL, average gain/loss per trade, win rate and average loss. Keep it if clearly better, adjust once if mixed, kill it if worse.";
export const TESTS = [
  { strat: "copy_r40", rule: "Control: copy the winners, RugRadar score 40 or lower, normal sell rules", startedAt: "2026-10-15T11:20:00Z" },
  { strat: "copy_v2", rule: "Buy only with 2+ winner wallets, 12+ buyers, RugRadar under 50; normal sell rules", startedAt: "2026-10-16T04:52:07Z" },
  { strat: "copy_v2ff", rule: "Same entry as v2; sell after 90 s if never above break-even; stop loss 20%", startedAt: "2026-10-16T04:52:07Z" },
  { strat: "copy_v2cs", rule: "Same entry as v2; skip the coin if the creator sold any amount before we buy; sell at once if the creator sells any amount after we buy; normal sell rules otherwise", startedAt: "" },
  { strat: "inflow_v1", rule: "Buy 0.2 SOL 30-60 s after launch when 5+ SOL net has flowed in, the creator has not sold and no single buyer made more than half of the early buying; sell at once when the creator or a followed winning wallet sells, otherwise after 5 minutes; -25% stop as backstop", startedAt: "" },
  { strat: "early_v1", rule: "Oct 18 test: buy 0.2 SOL the moment the launch shows up on the Helius/Solana chain feed when the creator's first buy is 1+ SOL, the creator has not sold and no other buyer has more than half of the non-creator buying seen so far; normal copy sell rules; latency recorded (feed receive -> decision -> simulated fill, plus launch block time -> fill when the block time is known)", startedAt: "2026-10-18T22:00:00Z" },
  { strat: "tp20", rule: "Oct 18 test: same entry as the control (copy_r40); take profit at +20%, trailing stop (arms at +10%, sells 8 points below the high; both kept above break-even), other sell rules as the control", startedAt: "2026-10-18T22:00:00Z" },
  { strat: "inflow_tp", rule: "Oct 18 test: same entry as inflow_v1; exits are tp20's (take profit +20%, trailing stop, control's stop loss / stall / time stop) instead of inflow_v1's creator-sell and 5-min exits", startedAt: "2026-10-18T22:00:00Z" },
  { strat: "inflow_fx25", rule: "Oct 18 test: same entries as inflow_v1 (opened alongside it, only when inflow_v1 has room); sell at 25 s after entry if the price has never been above break-even (+3.5% incl. fees); otherwise inflow_v1's exits", startedAt: "2026-10-18T23:00:00Z" },
  { strat: "inflow_x10", rule: "Oct 18 test (from the offline replay): same entries as inflow_v1 (opened alongside it, only when inflow_v1 has room); sell at 10 s after entry if the price has never been above +5% (exact per-position timer); -15% stop; trailing stop 20% below the highest price; creator / followed-wallet sells and the 5-minute time stop as inflow_v1; 0.0001 SOL priority fee per transaction; stop and trail also checked every 1 s from free price reads", startedAt: "2026-10-19T01:00:00Z" },
  { strat: "copy_v2cp", rule: "Same entry as v2; also sell at once on a 15%+ drop within about 10 s, when the creator sells 0.3+ SOL, or when a top-5 early buyer sells 40%+ of what they bought (0.5+ SOL); normal stop too", startedAt: "" },
];
export const TP20: Partial<Cfg> = { tp: 0.2, trailArm: 0.1, trail: 0.08, sl: -0.3, stallS: 300, maxHoldS: 600 };
export const FX25 = { afterS: 25, bePct: 3.5 };
/** Oct 18 inflow_x10: replay winner on inflow_v1 entries (still a loss-cutter, not profitable in the replay holdout). */
export const X10 = { afterS: 10, minPeakPct: 5, trailPct: 20, sl: -0.15, prio: 100_000, fastMs: 1000 };
const VARIANT_CFG: Record<string, Partial<Cfg>> = { copy_v2ff: { stallS: 90, sl: -0.2 }, tp20: TP20, inflow_tp: TP20, inflow_fx25: { maxOpen: 99 }, inflow_x10: { maxOpen: 99, sl: X10.sl, prio: X10.prio } /* entries gated by inflow_v1's room, so the two see the same coins */ }; // max RugRadar score allowed
export const STRATS: Strat[] = ["sniper", "inflow_v1", "early_v1", "tp20", "inflow_tp", "inflow_fx25", "inflow_x10", ...RUG_VARIANTS.copy.map((t) => `copy_r${t}`), ...V2_STRATS, ...RUG_VARIANTS.edge.map((t) => `edge_r${t}`)];
// Oct 18: new tests whose names don't start with their base (cost model / size come from the base)
const BASE_OF: Record<string, Base> = { early_v1: "early", tp20: "copy", inflow_tp: "inflow", inflow_fx25: "inflow", inflow_x10: "inflow" };
const baseOf = (s: Strat) => (BASE_OF[s.split("@")[0]] ?? s.split(/[_@]/)[0]) as Base;
type Cfg = { size: number; prio: number; tip: number; buyFail: number; sellFail: number; maxOpen: number; tp: number; trailArm: number; trail: number; sl: number; maxHoldS: number; stallS: number; maxBePct: number };
export const cfgOf = (s: Strat): Cfg => ({ ...CFG[baseOf(s)], ...(VARIANT_CFG[s.split("@")[0]] ?? {}) });
export const CFG: Record<Base, Cfg> = {
  // sniper: contested launch block via public RPC, no Jito bundle -> high buy-failure rate, quick exits (snipers hold seconds-minutes)
  sniper: { size: 0.4, stallS: 60, maxBePct: 8, prio: 3_000_000, tip: 2_000_000, buyFail: 0.25, sellFail: 0.05, maxOpen: 3, tp: 0.4, trailArm: 0.2, trail: 0.15, sl: -0.25, maxHoldS: 120 },
  // copy: rules inferred from profitable early wallets (enter ~20-180 s, ~0.5 SOL, hold ~5-20 min, take profit / trail)
  copy: { size: 0.2, stallS: 300, maxBePct: 8, prio: 1_000_000, tip: 0, buyFail: 0.05, sellFail: 0.05, maxOpen: 3, tp: 1.0, trailArm: 0.3, trail: 0.25, sl: -0.3, maxHoldS: 600 },
  // edge: momentum + RugRadar low risk only
  // Oct 16 inflow_v1 (private test from the RED-PUMP / RPC backtest): exits are creator sell, followed-wallet sell, 5-min time stop, -25% backstop; no take-profit/trailing
  inflow: { size: 0.2, stallS: 1e9, maxBePct: 8, prio: 1_000_000, tip: 0, buyFail: 0.05, sellFail: 0.05, maxOpen: 3, tp: 1e9, trailArm: 1e9, trail: 1, sl: -0.25, maxHoldS: 300 },
  // Oct 18 early_v1: copy's cost model and sell rules, 0.2 SOL
  early: { size: 0.2, stallS: 300, maxBePct: 8, prio: 1_000_000, tip: 0, buyFail: 0.05, sellFail: 0.05, maxOpen: 3, tp: 1.0, trailArm: 0.3, trail: 0.25, sl: -0.3, maxHoldS: 600 },
  edge: { size: 0.1, stallS: 300, maxBePct: 8, prio: 1_000_000, tip: 0, buyFail: 0.05, sellFail: 0.05, maxOpen: 3, tp: 1.0, trailArm: 0.3, trail: 0.25, sl: -0.25, maxHoldS: 900 },
};
type Pos = { id: string; strat: Strat; mint: string; symbol: string; entryAt: number; entryAgeS: number; latencyMs: number; costLamports: number; tokens: string; entryPriceSol: number;
  forceExit?: string; bePct?: number; buyDriftLamports?: number; sellDriftLamports?: number; buyFeeLamports?: number; sizeSol?: number; sizeMult?: number; family?: Family | null; priv?: Priv | null; named?: Named | null; marks?: [number, number][]; cpTop?: Record<string, number>; cpSeen?: string[]; peakAt?: number; minP?: number; minAt?: number; at?: Record<string, [number, number]>; path?: [number, number][]; peakRoi: number; lastMarkRoi: number; sellFails: number; noRouteSince: number | null; rug: any; signals: any };
type State = { v: 1; open: Pos[]; counters: Record<string, number>; startedAt: string };
let state: State = { v: 1, open: [], counters: {}, startedAt: new Date().toISOString() };
let closed: any[] = [];
const seen = new Map<string, { mint: string; symbol: string; creator: string; createdMs: number; seenMs: number; checked: Set<string>; devBuyPct: number | null }>();
const creatorLaunches = new Map<string, number[]>(); // in-session creator history (launch times)
const preMs: number[] = [];
const preLog: { ms: number; at: number; authority: string; uptimeS: number }[] = [];
let flagged: () => Record<string, any> = () => ({});
const lat = { detectMs: [] as number[], rpcMs: [] as number[] };
let winners = new Set<string>();
let rugCheckFn: ((m: string) => Promise<any>) | null = null;
let lastRugAt = 0; let started = false; let dirty = false; let lastErr: string | null = null;
const bump = (k: string) => { state.counters[k] = (state.counters[k] ?? 0) + 1; };
const med = (a: number[]) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : 0);
const push = (a: number[], v: number) => { a.push(v); if (a.length > 200) a.shift(); };
const rng = (seed: string) => parseInt(createHash("sha256").update(seed).digest("hex").slice(0, 8), 16) / 0xffffffff; // deterministic
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// Oct 16: record pump.fun response codes/headers (diagnostics for blocks vs rate limits), per endpoint
let swapBlockedUntil = 0;
export const pumpDiag: Record<string, { ok: number; fail: number; codes: Record<string, number>; last: any }> = {};
function noteHttp(u: string, r: Response | null, err?: string) {
  const host = /swap-api/.test(u) ? "swap-api trades" : /frontend-api/.test(u) ? "frontend-api coins list" : null; if (!host) return;
  const d = (pumpDiag[host] ??= { ok: 0, fail: 0, codes: {}, last: null }); const code = r ? String(r.status) : `error:${(err ?? "").slice(0, 40)}`;
  d.codes[code] = (d.codes[code] ?? 0) + 1; if (r?.ok) d.ok++; else d.fail++;
  if (host === "swap-api trades" && r?.status === 429) { const ra = Number(r.headers.get("retry-after") ?? 60); swapBlockedUntil = Date.now() + Math.min(600, Math.max(10, ra || 60)) * 1000; setOn(true); }
  if (!r?.ok) d.last = { at: new Date().toISOString(), code, server: r?.headers.get("server") ?? null, cfRay: r?.headers.get("cf-ray") ? "present" : null, cfMitigated: r?.headers.get("cf-mitigated") ?? null, retryAfter: r?.headers.get("retry-after") ?? null, rateLimitRemaining: r?.headers.get("x-ratelimit-remaining") ?? null, contentType: r?.headers.get("content-type") ?? null };
}
const getJ = (u: string, ms = 5000) => fetch(u, { headers: UA, signal: AbortSignal.timeout(ms) }).then((r) => { noteHttp(u, r); return r; }, (e) => { noteHttp(u, null, String(e?.name ?? e)); throw e; }).then((r) => (r.ok ? r.json() : null)).catch(() => null) as Promise<any>;

let noRouteFlag = false;
/** Jupiter quote. null = no fill; noRouteFlag tells a genuine NO_ROUTES_FOUND apart from a rate limit / outage. */
async function quote(input: string, output: string, amount: string | number): Promise<{ out: bigint; impact: number } | null> {
  noRouteFlag = false;
  const r = await jupFetch(`https://lite-api.jup.ag/swap/v1/quote?inputMint=${input}&outputMint=${output}&amount=${amount}&slippageBps=2000`, { headers: UA, signal: AbortSignal.timeout(5000) }).catch(() => null);
  const q: any = r ? await r.json().catch(() => null) : null;
  if (q && /NO_ROUTE|COULD_NOT_FIND/i.test(String(q.errorCode ?? q.error ?? ""))) noRouteFlag = true;
  if (!q?.outAmount) { // Oct 16: Jupiter gave nothing (not a genuine no-route) and the Solana backup is on -> price against the bonding curve
    if (noRouteFlag || !isOn() || (input !== SOL && output !== SOL)) return null;
    const mint = input === SOL ? output : input; const cs = (await curveState([mint]))[mint]; if (!cs || cs.complete) return null;
    const amt = BigInt(amount); const net = amt * 99n / 100n; // ~1% pump.fun fee
    const out = input === SOL ? cs.vtok * net / (cs.vsol + net) : (cs.vsol * amt / (cs.vtok + amt)) * 99n / 100n;
    const spot = input === SOL ? Number(cs.vtok) / Number(cs.vsol) * Number(amt) : Number(cs.vsol) / Number(cs.vtok) * Number(amt);
    return { out, impact: spot > 0 ? Math.max(0, 1 - Number(out) / spot) : 0 };
  }
  return { out: BigInt(q.outAmount), impact: Number(q.priceImpactPct ?? 0) };
}
/** Fallback when Jupiter drops a dead pump.fun coin from routing: price a sell straight against the bonding curve account
 * (constant product on virtual reserves, minus ~1.25% pump.fun fees). Returns null if the curve is complete/unreadable. */
async function curveSell(mint: string, tokens: bigint): Promise<bigint | null> {
  try {
    const [pda] = await getProgramDerivedAddress({ programAddress: address("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"), seeds: ["bonding-curve", getAddressEncoder().encode(address(mint))] });
    const ask = (u: string) => fetch(u, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getAccountInfo", params: [pda, { encoding: "base64" }] }), signal: AbortSignal.timeout(5000) }).then((x) => x.json()).catch(() => null);
    const u0 = rpcUrl(freeFeedOn()); let r: any = await ask(u0); // Oct 18: free public RPC first in free-feed mode
    if (r?.result === undefined && !isHeliusUrl(u0)) { markPublicBad(); r = await ask(rpcUrl(true)); }
    const b = Buffer.from(r?.result?.value?.data?.[0] ?? "", "base64"); if (b.length < 49 || b[48] === 1) return null;
    const vtok = b.readBigUInt64LE(8), vsol = b.readBigUInt64LE(16);
    return (vsol * tokens / (vtok + tokens)) * 9875n / 10000n;
  } catch { return null; }
}
/** Sniper fast pre-check (instant signals only, 250 ms budget): mint/freeze authority (one RPC read),
 * RugRadar's flagged-deployer list + in-session creator launch count (memory), creator's launch buy (from the launch event). */
async function preCheck(mint: string, creator: string, devBuyPct: number | null) {
  const t0 = Date.now(); const red: string[] = [];
  if (creator && flagged()[creator]) red.push("flagged_deployer");
  const launches1h = creatorLaunches.get(creator)?.length ?? 0;
  if (launches1h >= 2) red.push(`creator_${launches1h}_launches_1h`);
  if (devBuyPct != null && devBuyPct > 10) red.push(`creator_bought_${devBuyPct.toFixed(0)}pct`);
  // Mint/freeze authority: brand-new mints are often not visible yet on one node, so ask two free RPCs at once
  // ("processed" commitment) and retry every ~50 ms until the 240 ms budget. Still unknown = skip, never buy blind.
  let authority: string = "unknown"; let tries = 0;
  const RPC2 = [RPC, "https://solana-rpc.publicnode.com"];
  const ask = (u: string) => fetch(u, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getAccountInfo", params: [mint, { encoding: "jsonParsed", commitment: "processed" }] }), signal: AbortSignal.timeout(Math.max(30, Math.min(120, 240 - (Date.now() - t0)))) })
    .then((x) => x.json()).then((r: any) => { const info = r?.result?.value?.data?.parsed?.info; if (!info) throw new Error("not visible"); return info; });
  while (Date.now() - t0 < 200 && authority === "unknown") {
    tries++;
    try {
      const info: any = await Promise.race([Promise.any(RPC2.map(ask)), sleep(Math.max(20, 240 - (Date.now() - t0))).then(() => { throw new Error("budget"); })]);
      authority = "ok"; if (info.mintAuthority) red.push("mint_authority"); if (info.freezeAuthority) red.push("freeze_authority");
    } catch { if (Date.now() - t0 < 190) await sleep(50); }
  }
  if (authority !== "ok") red.push("authority_unknown");
  const ms = Date.now() - t0; push(preMs, ms); push(preLog as any, { ms, at: Date.now(), authority, tries, uptimeS: Math.round(process.uptime()) } as any);
  return { ms, red, authority, tries, devBuyPct, creatorLaunches1h: launches1h };
}
async function rpcPing(): Promise<number> {
  const t = Date.now();
  await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getLatestBlockhash", params: [{ commitment: "processed" }] }), signal: AbortSignal.timeout(5000) }).catch(() => null);
  const ms = Date.now() - t; push(lat.rpcMs, ms); return ms;
}
/** Simulated time from "decide" to "landed": blockhash fetch + send round-trip (measured) + ~1 slot. */
const execLatencyMs = () => 2 * (med(lat.rpcMs) || 300) + 400;

// Oct 16: trade lookups fall back to Solana (chain-trades.ts) when pump.fun's swap-api fails or is limited; switched off again when it recovers.
const apiWin: boolean[] = []; const apiCalls: number[] = []; let probeN = 0;
export const dataSource = () => ({ trades: isOn() ? "Solana backup (bonding-curve events + reserves)" : "pump.fun swap-api", recentApiOkPct: apiWin.length ? Math.round(apiWin.filter(Boolean).length / apiWin.length * 100) : null, chain: chainStat, swapApiPausedForS: Math.max(0, Math.round((swapBlockedUntil - Date.now()) / 1000)), pumpFun: pumpDiag, pumpPortalWs: wsDiag });
function apiResult(ok: boolean) {
  apiWin.push(ok); if (apiWin.length > 30) apiWin.shift();
  const fails = apiWin.filter((x) => !x).length;
  if (!isOn() && apiWin.length >= 10 && fails / apiWin.length >= 0.5) setOn(true);
  else if (isOn() && apiWin.length >= 20 && apiWin.slice(-20).every(Boolean) && Date.now() > swapBlockedUntil + 300_000) setOn(false); // off only after 20 clean probes and 5 min without a 429
}
const FORCE_CHAIN = process.env.PAPER_FORCE_CHAIN === "1"; // test switch: use only the Solana backup
export const SWAP_API_PER_MIN = Number(process.env.PAPER_SWAPAPI_PER_MIN ?? 25);
/** Oct 18: every trade list the bots pull is also kept for the durable coin-trades history (no extra lookups). */
async function trades(mint: string, limit = 100): Promise<any[] | null> { const r = await tradesLive(mint, limit); if (r) noteCoinTrades(mint, r); return r; }
async function tradesLive(mint: string, limit = 100): Promise<any[] | null> {
  if (FORCE_CHAIN) { const c = chainTrades(mint, limit); if (!c) track(mint, 120).catch(() => {}); return c; }
  // pump.fun said "slow down" (429 + Retry-After): respect it, use only the Solana backup until then
  if (Date.now() < swapBlockedUntil) { const c = chainTrades(mint, limit); if (!c) track(mint, 120).catch(() => {}); return c; }
  // stay under pump.fun's limit: Oct 18 at most ~25 trade lookups a minute from us (was 90); above that, the Solana backup answers
  const now = Date.now(); while (apiCalls.length && now - apiCalls[0] > 60_000) apiCalls.shift();
  if (apiCalls.length >= SWAP_API_PER_MIN) { setOn(true); const c = chainTrades(mint, limit); if (!c) track(mint, 120).catch(() => {}); return c; }
  if (isOn() && chainTrades(mint, 0) && probeN++ % 4 !== 0) return chainTrades(mint, limit); // backup on: only probe the API on every 4th call
  apiCalls.push(now); if (limit >= 100) await sleep(Math.floor(Math.random() * 400)); // Oct 18: jitter on scan lookups (open-position price checks are never delayed)
  const d = await getJ(`https://swap-api.pump.fun/v2/coins/${mint}/trades?limit=${limit}`, 5000);
  const tr = d?.trades ?? null; apiResult(tr != null);
  if (tr != null) return tr;
  if (isOn()) { const c = chainTrades(mint, limit); if (c) return c; track(mint, 120).catch(() => {}); }
  return null;
}
function flow(tr: any[], creator: string) {
  const buys = tr.filter((t) => t.type === "buy"), sells = tr.filter((t) => t.type === "sell");
  const sum = (xs: any[]) => xs.reduce((a, t) => a + Number(t.amountSol || 0), 0);
  return { trades: tr.length, uniqueBuyers: new Set(buys.map((t) => t.userAddress)).size, buySol: +sum(buys).toFixed(3), sellSol: +sum(sells).toFixed(3),
    devSold: sells.some((t) => t.userAddress === creator), winnerBuyers: [...new Set(buys.map((t) => t.userAddress).filter((w) => winners.has(w)))],
    priceSol: tr[0] ? Number(tr[0].priceSol) : null, mcapUsd: tr[0] ? Number(tr[0].priceUsd) * 1e9 : null };
}

export const GOOD_DEV_MULTS: number[] = []; // Oct 15: retired; "known good dev" coins died MORE often (42-46% vs 21-30%), small sample // extra test positions on "Known good dev" coins
async function enter(strat: Strat, c: { mint: string; symbol: string; createdMs: number }, signals: any, mult = 1) {
  const SIZE = +(CFG[baseOf(strat)].size * mult).toFixed(4); // copy 0.2 SOL, sniper/edge 0.1 SOL; trusted-dev multipliers on top
  if (mult === 1) { // trusted-dev coin: also open bigger test positions, tracked as their own variants ("<strategy>@2x")
    const fam = await Promise.race([familyFor(c.mint) ?? Promise.resolve(null), sleep(baseOf(strat) === "sniper" || baseOf(strat) === "early" ? 0 : 1000).then(() => null)]).catch(() => null);
    const tr = trustFor(c.mint, fam as any); if (fam) signals = { ...signals, familyKnown: fam };
    if (tr?.knownGood) for (const m of GOOD_DEV_MULTS) enter(`${strat}@${m}x`, c, { ...signals, trust: tr }, m).catch(() => {});
    if (tr) signals = { ...signals, trust: tr };
  }
  const cfg = cfgOf(strat);
  if (state.open.filter((p) => p.strat === strat).length >= cfg.maxOpen) { bump(`${strat}.skipFull`); return; }
  if (state.open.some((p) => p.strat === strat && p.mint === c.mint)) return;
  const tDecide = Date.now();
  const q1 = await buyQuote(strat, c.mint, Math.round(SIZE * LAMPORTS));
  if (!q1) { bump(`${strat}.noBuyRoute`); return; }
  // Oct 15: skip when costs alone need more than maxBePct to break even (fixed fees + ~2.5% pump.fun + price impact)
  const fixedRT = (2 * (BASE_FEE + cfg.prio + cfg.tip) + BASE_FEE) / LAMPORTS;
  const beEst = (fixedRT / SIZE + 0.025 + Math.abs(q1.impact || 0)) * 100;
  if (beEst > cfg.maxBePct) { bump(`${strat}.skippedBreakEven`); return; }
  const famNow = signals.trust ? null : null; void famNow;
  if (signals.family?.serialRugger || signals.familyKnown?.serialRugger) { bump(`${strat}.skippedSerialRugger`); return; }
  const lms = execLatencyMs(); await sleep(lms);
  const q2 = await buyQuote(strat, c.mint, Math.round(SIZE * LAMPORTS)); // price at simulated landing
  const fill = q2 && q2.out < q1.out ? q2.out : q1.out; // worse of the two (never flatter)
  const fees = BASE_FEE + cfg.prio + cfg.tip;
  const id = `${strat}:${c.mint}`;
  if (rng(id + ":buy") < cfg.buyFail) { // failed buy: fees burned, no position
    bump(`${strat}.buyFailed`);
    const t = { id, strat, mint: c.mint, symbol: c.symbol, result: "buy_failed", entryAt: new Date(tDecide).toISOString(), pnlSol: -fees / LAMPORTS, roi: -fees / (SIZE * LAMPORTS), sizeSol: SIZE, sizeMult: mult, signals };
    closed.push(t); if (closed.length > 2500) closed.splice(0, 500); appendTrade(t); dirty = true; return;
  }
  const latencyMs = Date.now() - tDecide;
  const pos: Pos = { id, strat, mint: c.mint, symbol: c.symbol, entryAt: Date.now(), entryAgeS: Math.round((Date.now() - c.createdMs) / 1000), latencyMs,
    costLamports: Math.round(SIZE * LAMPORTS) + fees + ATA_RENT, tokens: fill.toString(), entryPriceSol: SIZE / (Number(fill) / 1e6), bePct: beEst, sizeSol: SIZE, sizeMult: mult, buyFeeLamports: fees, buyDriftLamports: q1.out > 0n ? Math.round(Number(q1.out - fill) / Number(q1.out) * SIZE * LAMPORTS) : 0,
    peakRoi: 0, lastMarkRoi: 0, sellFails: 0, noRouteSince: null, rug: null, signals: { ...signals, impactPct: q2?.impact ?? q1.impact } };
  state.open.push(pos); bump(`${strat}.entries`); dirty = true; pin(c.mint, true);
  if (strat === "inflow_x10") x10Arm(pos);
  if (strat === "copy_v2cp") trades(c.mint, 100).then((tr) => { const m: Record<string, number> = {}; const cr = seen.get(c.mint)?.creator;
    for (const t of tr ?? []) if (t.type === "buy" && t.userAddress !== cr) m[t.userAddress] = (m[t.userAddress] ?? 0) + Number(t.amountSol || 0);
    pos.cpTop = Object.fromEntries(Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, 5)); dirty = true; }).catch(() => {});
  // Oct 15: 5 private signals, async and queued (never delays the entry). One computation per coin, shared by all variants.
  privFor(c.mint, c.createdMs).then((pv) => { pos.priv = pv; dirty = true; }).catch(() => {});
  // Oct 15: private "named wallet" signal (SNS .sol name / public label for creator or first funder). Waits up to 20 s for the family trace's funder, then looks up.
  (async () => { const cr = seen.get(c.mint)?.creator; if (!cr) return; const f = await Promise.race([familyFor(c.mint) ?? Promise.resolve(null), sleep(20_000).then(() => null)]).catch(() => null) as Family | null;
    pos.named = await namedWallet(cr, f?.hops?.[0]?.wallet ?? null); dirty = true; })().catch(() => {});
  // Private creator-family trace: async for the sniper (never on its critical path); copy/edge wait up to 1 s, else it fills in later.
  const famP = familyFor(c.mint);
  if (famP) { famP.then((f) => { pos.family = f; noteFunding(f); dirty = true; }).catch(() => {}); if (baseOf(strat) !== "sniper" && baseOf(strat) !== "early") await Promise.race([famP, sleep(1000)]).catch(() => {}); }
  // Record RugRadar's full signals at the moment of the buy, for every strategy (sniper: right after, never delays entry).
  if (!signals.rug) pendingRug.set(pos.id, rugSnapshot(c.mint).then((r) => { pos.rug = r; dirty = true; pendingRug.delete(pos.id); if (strat === "sniper" && r?.riskLevel === "high") pos.forceExit = "rugradar_high_risk_after_entry"; return r; }));
  else pos.rug = signals.rug;
  if (strat === "early_v1" && signals.slot) launchBlockTime(signals.slot).then((bt) => { if (bt) { pos.signals.launchBlockTimeMs = bt; pos.signals.launchToFillMs = pos.entryAt - bt; pos.signals.launchToFillNote = "block time has 1 s resolution"; dirty = true; } }).catch(() => {});
}
/** Oct 18: early_v1 may buy before Jupiter routes a brand-new coin; then price against the bonding curve (same constant-product math as quote()). Other strategies unchanged. */
async function buyQuote(strat: Strat, mint: string, lamports: number) {
  const q = await quote(SOL, mint, lamports); if (q || strat !== "early_v1" || noRouteFlag) return q;
  const cs = (await curveState([mint]).catch(() => ({} as any)))[mint]; if (!cs || cs.complete) return null;
  const amt = BigInt(lamports), net = amt * 99n / 100n, out = cs.vtok * net / (cs.vsol + net), spot = Number(cs.vtok) / Number(cs.vsol) * Number(amt);
  return { out, impact: spot > 0 ? Math.max(0, 1 - Number(out) / spot) : 0 };
}
/** Launch block time from a free public RPC (never Helius credits). */
async function launchBlockTime(slot: number): Promise<number | null> {
  for (let i = 0; i < 3; i++) { await sleep(4000);
    const r: any = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getBlockTime", params: [slot] }), signal: AbortSignal.timeout(4000) }).then((x) => x.json()).catch(() => null);
    if (typeof r?.result === "number") return r.result * 1000; }
  return null;
}
// ---------------- PRIVATE "coinFactoryFunder" flag (paper trades only; never part of RugRadar) ----------------
// A wallet (creator or a funder up its chain) that funded 5+ different coin creators within 24 h. Counts come from our own creator-family
// traces (each traced creator's funding chain) plus the funder's sampled recent transfers that went to wallets we saw launch a coin. Lower bound.
export const COIN_FACTORY = { minCreators: 5, windowMs: 86_400_000, names: ["helpmegetcamaro"] };
const fundedBy = new Map<string, Map<string, number>>(); // funder -> creator -> when seen
function noteFunded(funder: string, creator: string, at: number) { if (!funder || !creator || funder === creator) return; let m = fundedBy.get(funder); if (!m) { m = new Map(); fundedBy.set(funder, m); if (fundedBy.size > 20000) fundedBy.delete(fundedBy.keys().next().value!); } m.set(creator, at); if (m.size > 200) m.delete(m.keys().next().value!); }
const launchedRecently = (w: string, now: number) => (creatorMints[w] ?? []).some(([, t]) => now - t < COIN_FACTORY.windowMs);
function noteFunding(f: Family | null | undefined) {
  if (!f?.creator) return; const now = Date.now(); const chain = [f.creator, ...(f.hops ?? []).filter((h) => !h.label).map((h) => h.wallet)];
  if (chain[1]) noteFunded(chain[1], chain[0]!, now); // the direct funder of a coin creator
  for (const w of (f as any).siblings ?? []) if (chain[1] && launchedRecently(w, now)) noteFunded(chain[1], w, now);
}
export function coinFactoryOf(f: Family | null | undefined, named: Named | null | undefined) {
  const now = Date.now(); const wallets = f ? [f.creator, ...(f.hops ?? []).filter((h) => !h.label).map((h) => h.wallet)] : [];
  let best: { wallet: string; fundedCreators24h: number } | null = null;
  for (const w of wallets) { const n = [...(fundedBy.get(w)?.values() ?? [])].filter((t) => now - t < COIN_FACTORY.windowMs).length; if (!best || n > best.fundedCreators24h) best = { wallet: w, fundedCreators24h: n }; }
  const nm = JSON.stringify(named ?? "").toLowerCase(); const byName = COIN_FACTORY.names.find((x) => nm.includes(x)) ?? null;
  return { flag: (best?.fundedCreators24h ?? 0) >= COIN_FACTORY.minCreators || !!byName, wallet: best?.wallet ?? null, fundedCreators24h: best?.fundedCreators24h ?? 0, knownName: byName, traced: !!f };
}
const pendingRug = new Map<string, Promise<any>>();
let rugChain: Promise<unknown> = Promise.resolve();
/** RugRadar's own internal check, strictly one at a time and >= 15 s apart, so live RugRadar traffic keeps priority. */
function rugSnapshot(mint: string): Promise<any> {
  const p = rugChain.then(async () => { const r = await rugSnapshotNow(mint); await sleep(15_000); return r; });
  rugChain = p.catch(() => {}); return p;
}
async function rugSnapshotNow(mint: string) {
  if (!rugCheckFn) return null;
  try { const r = await rugCheckFn(mint); bump("rugChecksTotal"); scRecord(mint, r).catch(() => {}); return { riskScore: r.riskScore, riskLevel: r.riskLevel, confidence: r.confidence, unknownSignals: r.unknownSignals, checks: r.checks, buyer: r.buyer, facts: r.facts }; }
  catch (e) { return { error: String((e as Error).message ?? e).slice(0, 100) }; }
}

/** One manage() at a time per position, and never on a closed one (the inflow_x10 fast checks run beside the 5 s loop). */
const managing = new Set<string>();
async function manageOnce(p: Pos) {
  if (managing.has(p.id) || !state.open.includes(p)) return; managing.add(p.id);
  try { await manage(p); } finally { managing.delete(p.id); }
}
/** inflow_x10 exit rules on the current mark (ROI vs our all-in buy price, like every strategy). */
export function x10Reason(p: { peakRoi: number; lastMarkRoi: number }, holdS: number): string | null {
  if (holdS >= X10.afterS && p.peakRoi * 100 <= X10.minPeakPct) return "x10_never_above_5pct";
  if (p.lastMarkRoi <= (1 + p.peakRoi) * (1 - X10.trailPct / 100) - 1) return "trailing_stop_20pct";
  if (p.lastMarkRoi <= X10.sl) return "stop_loss";
  return null;
}
/** Free price read for inflow_x10: newest on-chain trade from the public chain websocket if tracked, else one batched
 * getMultipleAccounts on the bonding curves via the free public RPC. Never Helius: on failure the position just waits. */
const x10Curve = new Map<string, string>();
async function x10Prices(mints: string[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {}; const need: string[] = [];
  for (const m of mints) { const t = chainTrades(m, 1)?.[0]; if (t && Date.now() - Date.parse(t.timestamp) < 2000 && Number(t.priceSol) > 0) out[m] = Number(t.priceSol); else need.push(m); }
  if (!need.length) return out;
  try {
    const keys = await Promise.all(need.map(async (m) => { let k = x10Curve.get(m); if (!k) { const [pda] = await getProgramDerivedAddress({ programAddress: address("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"), seeds: ["bonding-curve", getAddressEncoder().encode(address(m))] }); k = String(pda); x10Curve.set(m, k); if (x10Curve.size > 500) x10Curve.delete(x10Curve.keys().next().value!); } return k; }));
    const r: any = await fetch(PUBLIC_RPC_HTTP, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getMultipleAccounts", params: [keys, { encoding: "base64", commitment: "confirmed" }] }), signal: AbortSignal.timeout(2500) }).then((x) => x.json()).catch(() => null);
    const vals = r?.result?.value; if (!Array.isArray(vals)) { bump("inflow_x10.freePriceMiss"); return out; }
    need.forEach((m, i) => { const b = Buffer.from(vals[i]?.data?.[0] ?? "", "base64"); if (b.length < 49 || b[48] === 1) return; const vtok = Number(b.readBigUInt64LE(8)), vsol = Number(b.readBigUInt64LE(16)); if (vtok > 0) out[m] = (vsol / 1e9) / (vtok / 1e6); });
  } catch { bump("inflow_x10.freePriceMiss"); }
  return out;
}
function x10Mark(p: Pos, price: number) {
  p.lastMarkRoi = price / p.entryPriceSol - 1; if (p.lastMarkRoi > p.peakRoi) { p.peakRoi = p.lastMarkRoi; p.peakAt = Date.now(); }
}
/** Check one or all open inflow_x10 positions now; a hit sets forceExit and sells through the normal manage() path (Jupiter quote + latency). */
async function x10Check(only?: Pos) {
  // Oct 18 fix: a triggered exit that lost the race with the slow 5 s loop (its cycle over all open positions runs ~90 s) is retried here every second
  for (const p of [...state.open]) if (p.strat === "inflow_x10" && p.forceExit && !managing.has(p.id)) await manageOnce(p);
  const ps = only ? [only].filter((p) => state.open.includes(p) && !p.forceExit) : state.open.filter((p) => p.strat === "inflow_x10" && !p.forceExit);
  if (!ps.length) return;
  const px = await x10Prices([...new Set(ps.map((p) => p.mint))]);
  for (const p of ps) {
    const price = px[p.mint]; if (price) { x10Mark(p, price); bump("inflow_x10.fastMarks"); }
    const holdS = (Date.now() - p.entryAt) / 1000; const why = p.forceExit ? null : x10Reason(p, holdS);
    if (why) { p.forceExit = why; (p as any).x10TriggerS = Math.round(holdS * 10) / 10; (p as any).x10TriggerAt = Date.now(); dirty = true; await manageOnce(p); }
  }
}
const x10Tick = () => x10Check();
/** Exact 10 s check per position (the 5 s loop alone would act anywhere from 10 to 15 s). */
function x10Arm(p: Pos) { setTimeout(() => { x10Check(p).catch(() => {}); }, Math.max(0, p.entryAt + X10.afterS * 1000 - Date.now()) + 20).unref?.(); }
async function manage(p: Pos) {
  const cfg = cfgOf(p.strat);
  const isCp = p.strat.split("@")[0] === "copy_v2cp", isCs = p.strat.split("@")[0] === "copy_v2cs", isIn = p.strat === "inflow_v1" || p.strat === "inflow_fx25" || p.strat === "inflow_x10"; // Oct 18: inflow_fx25 keeps inflow_v1's exits
  const x10Go = p.strat === "inflow_x10" && !!p.forceExit; // Oct 18: inflow_x10 already decided from its 1 s free price read -> straight to the sell
  const tr = x10Go ? null : await trades(p.mint, isCp || isCs || isIn ? 30 : 5);
  let price = tr?.[0] ? Number(tr[0].priceSol) : null;
  if (isOn() && !x10Go) { const cs = (await curveState([p.mint]))[p.mint]; if (cs && !cs.complete && cs.priceSol > 0) price = cs.priceSol; }
  const holdS = (Date.now() - p.entryAt) / 1000;
  let cpReason: string | null = null;
  if (isCp && tr) { // crash-protect (paper test): fast drop, or the creator / a top-5 early buyer dumping
    const now = Date.now();
    if (price) { (p.marks ??= []).push([now, price]); p.marks = p.marks.filter(([t]) => now - t <= (CP.windowS + 6) * 1000); }
    const hi = Math.max(...(p.marks ?? []).filter(([t]) => now - t <= (CP.windowS + 6) * 1000).map(([, v]) => v));
    if (price && hi > 0 && price <= hi * (1 - CP.dropPct / 100)) cpReason = "crash_exit_fast_drop";
    const creator = seen.get(p.mint)?.creator; const seenSet = new Set(p.cpSeen ?? []);
    for (const t of tr) {
      const key = String(t.signature ?? t.slotIndexId ?? `${t.timestamp}:${t.userAddress}:${t.amountSol}`);
      if (seenSet.has(key) || t.type !== "sell" || Date.parse(t.timestamp) < p.entryAt) { seenSet.add(key); continue; }
      seenSet.add(key); const sol = Number(t.amountSol || 0);
      if (creator && t.userAddress === creator && sol >= CP.creatorSellSol) cpReason ??= "crash_exit_creator_sold";
      const bought = p.cpTop?.[t.userAddress]; if (bought && sol >= CP.holderSellMinSol && sol >= bought * CP.holderSellFrac) cpReason ??= "crash_exit_top_holder_sold";
    }
    p.cpSeen = [...seenSet].slice(-200);
  }
  if (price) { p.lastMarkRoi = (price / p.entryPriceSol) - 1; if (p.lastMarkRoi > p.peakRoi) { p.peakRoi = p.lastMarkRoi; p.peakAt = Date.now(); } notePriceMark(p, price); }
  const r = p.lastMarkRoi;
  if (isCs && tr) { // creator-sell guard (paper test): any creator sell after our entry -> exit now
    const creator = seen.get(p.mint)?.creator;
    if (creator && tr.some((t) => t.type === "sell" && t.userAddress === creator && Date.parse(t.timestamp) >= p.entryAt)) cpReason = "creator_sold_exit";
  }
  if (isIn && tr) { // inflow_v1: creator sells or a followed winning wallet sells after our entry -> exit now
    const creator = seen.get(p.mint)?.creator;
    for (const t of tr) { if (t.type !== "sell" || Date.parse(t.timestamp) < p.entryAt) continue;
      if (creator && t.userAddress === creator) { cpReason ??= "creator_sold_exit"; } else if (winners.has(t.userAddress)) cpReason ??= "winner_wallet_sold_exit"; }
  }
  let reason: string | null = p.forceExit ?? cpReason;
  if (!reason && p.strat === "inflow_x10") reason = x10Reason(p, holdS);
  if (!reason && p.strat === "inflow_fx25" && holdS >= FX25.afterS && p.peakRoi * 100 <= FX25.bePct) reason = "fx25_never_above_breakeven"; // Oct 18 test
  // Oct 15: mark is vs our all-in buy price, so selling costs (~1.25% + sell fees) still apply; keep every profit exit above break-even
  const be = (p.bePct ?? 5) / 100, arm = Math.max(cfg.trailArm, be + cfg.trail + 0.02), tp = Math.max(cfg.tp, be + 0.1);
  if (reason) {}
  else if (r >= tp) reason = "take_profit";
  else if (p.peakRoi >= arm && r <= p.peakRoi - cfg.trail) reason = "trailing_stop";
  else if (holdS >= cfg.stallS && p.peakRoi < be) reason = "stalled";
  else if (r <= cfg.sl) reason = "stop_loss";
  else if (holdS >= cfg.maxHoldS) reason = "time_stop";
  if (!reason) return;
  const xd = x10Go ? ((p as any).x10Diag ??= { tries: 0, last: "" }) : null; if (xd) { xd.tries++; xd.last = "quote"; } // Oct 18: where does a decided x10 exit wait?
  const q = await quote(p.mint, SOL, p.tokens);
  const fees = BASE_FEE + cfg.prio + cfg.tip;
  if (!q || q.out === 0n) {
    if (!noRouteFlag && q == null) { bump("quoteErrors"); if (xd) xd.last = "quote_error"; return; } // API error/rate limit: retry, do not count as unsellable
    const direct = await curveSell(p.mint, BigInt(p.tokens));
    if (direct != null && direct > 0n) { await sleep(execLatencyMs()); return close(p, reason + "_via_curve", direct, fees); }
    p.noRouteSince ??= Date.now();
    if (Date.now() - p.noRouteSince > 10 * 60_000) return close(p, "no_sell_route_writeoff", 0n, fees);
    return;
  }
  p.noRouteSince = null;
  if (rng(`${p.id}:sell:${p.sellFails}`) < cfg.sellFail) { if (xd) xd.last = "sim_sell_fail"; p.sellFails++; bump(`${p.strat}.sellFailed`); p.costLamports += fees; dirty = true; return; } // retry next tick at the new price
  await sleep(execLatencyMs());
  const q2 = await quote(p.mint, SOL, p.tokens);
  const out = q2 && q2.out < q.out ? q2.out : q.out;
  p.sellDriftLamports = Number(q.out - out);
  close(p, reason, out, fees);
}
let creatorMints: Record<string, [string, number][]> = {}; let cmAdds = 0, nlAdds = 0;
const famCtx = { coinsBy: (w: string) => (creatorMints[w] ?? []).map(([mint, t]) => ({ mint, t })),
  rugged: (m: string) => { const x = sc.find((y) => y.mint === m); const a = x && (x.after["24h"] ?? x.after["1h"] ?? x.after["10m"]); return a ? isRugged(a) : null; },
  flagged: (w: string) => !!flagged()[w] };
// ---------------- PRIVATE "trusted creator" flag (paper + scorecard only) ----------------
let trustedManual: Record<string, string> = {};
try { trustedManual = JSON.parse(fs.readFileSync(new URL("./trusted-creators.json", import.meta.url), "utf8")).wallets ?? {}; } catch {}
let devStats: Record<string, { launches: number; graduated: number; at: number }> = {}; // from Jupiter dev stats seen in RugRadar snapshots
export type Trust = { knownGood: boolean; reason: string | null; wallet: string | null };
function noteDev(creator: string, rug: any) { const b = rug?.buyer; if (creator && typeof b?.devLaunches === "number") { devStats[creator] = { launches: b.devLaunches, graduated: b.devGraduated ?? 0, at: Date.now() }; } }
function trustOf(wallets: string[]): Trust {
  for (const [i, w] of wallets.entries()) {
    const who = i === 0 ? "Creator" : `Funder ${i} hop${i > 1 ? "s" : ""} back`;
    if (trustedManual[w]) return { knownGood: true, reason: `${who} is a known team: ${trustedManual[w]}`, wallet: w };
    const d = devStats[w];
    if (d && d.graduated >= 2 && d.graduated / Math.max(1, d.launches) >= 0.3) return { knownGood: true, reason: `${who} had ${d.graduated} of ${d.launches} earlier coins graduate on pump.fun`, wallet: w };
    const ours = (creatorMints[w] ?? []).map(([m]) => famCtx.rugged(m)).filter((v) => v != null);
    if (ours.length >= 2 && ours.every((v) => v === false)) return { knownGood: true, reason: `${who}'s ${ours.length} earlier coins we tracked all survived`, wallet: w };
  }
  return { knownGood: false, reason: null, wallet: null };
}
const trustFor = (mint: string, f: Family | null | undefined) => { const c = seen.get(mint)?.creator ?? f?.creator; return c ? trustOf([c, ...(f?.hops ?? []).filter((h) => !h.label).map((h) => h.wallet)]) : null; };
const privCache = new Map<string, Promise<Priv>>();
function privFor(mint: string, createdMs: number): Promise<Priv> {
  const hit = privCache.get(mint); if (hit) return hit;
  const c = seen.get(mint); const creator = c?.creator ?? "", now = Date.now();
  const prior = (creatorMints[creator] ?? []).filter(([m, t]) => m !== mint && t < createdMs);
  const rows = prior.map(([m]) => sc.find((x) => x.mint === m)).filter(Boolean) as Sc[];
  const lastOf = (x: Sc) => x.after["24h"] ?? x.after["1h"] ?? x.after["10m"];
  const dev = { launches24h: prior.filter(([, t]) => now - t < 86_400_000).length + 1, priorTracked: rows.length,
    priorGraduated: rows.filter((x) => lastOf(x)?.graduated).length, priorDead: rows.filter((x) => lastOf(x) && isRugged(lastOf(x))).length };
  const p = trades(mint, 100).then((tr) => privateSignals(mint, createdMs, creator, tr, dev));
  privCache.set(mint, p); if (privCache.size > 500) privCache.delete(privCache.keys().next().value!);
  return p;
}
function familyFor(mint: string) { const c = seen.get(mint); return c?.creator ? familyOf(c.creator, c.createdMs, famCtx) : null; }
async function close(p: Pos, reason: string, outLamports: bigint, fees: number) {
  const soldAt = Date.now(); // Oct 18: the sell happens now; exitAt/holdS were stamped after the up-to-90 s wait for the RugRadar snapshot below
  state.open = state.open.filter((x) => x !== p); pin(p.mint, false); (p as any).dataSource = isOn() ? "solana_backup" : "pump.fun";
  const pr = pendingRug.get(p.id); // trade log must carry RugRadar's snapshot taken at buy time
  if (pr) await Promise.race([pr, sleep(90_000)]);
  const proceeds = Number(outLamports) - fees - BASE_FEE + ATA_RENT; // sell tx + close-account tx refunds rent
  const pnl = (proceeds - p.costLamports) / LAMPORTS;
  // Fee breakdown (SOL). pump.fun's ~1.25% per side is already inside Jupiter's quotes; shown here as an estimate.
  const size = p.sizeSol ?? 0.5 /* positions opened before sizes were stored were 0.5 SOL */, PUMP = 0.0125;
  const net = ((p.buyFeeLamports ?? 0) + fees + BASE_FEE) / LAMPORTS; // buy tx + sell tx (+ tip) + close-account tx
  const pumpFee = size * PUMP + (Number(outLamports) / LAMPORTS) * PUMP / (1 - PUMP);
  const slip = ((p.buyDriftLamports ?? 0) + (p.sellDriftLamports ?? 0)) / LAMPORTS;
  const fixed = net + (p.costLamports - Math.round(size * LAMPORTS) - ATA_RENT - (p.buyFeeLamports ?? 0)) / LAMPORTS; // + failed-sell fees
  const feesPaid = { pumpFunSol: +pumpFee.toFixed(6), networkAndPrioritySol: +fixed.toFixed(6), slippageSol: +slip.toFixed(6), totalSol: +(pumpFee + fixed + slip).toFixed(6) };
  const breakEvenPct = +(((fixed + slip) / size + PUMP * 2 + PUMP * PUMP) * 100).toFixed(2);
  const t = { id: p.id, strat: p.strat, mint: p.mint, symbol: p.symbol, result: pnl > 0 ? "win" : "loss", exitReason: reason,
    entryAt: new Date(p.entryAt).toISOString(), exitAt: new Date(soldAt).toISOString(), holdS: Math.round((soldAt - p.entryAt) / 1000), entryAgeS: p.entryAgeS, latencyMs: p.latencyMs, ...((p as any).x10TriggerS != null ? { x10TriggerS: (p as any).x10TriggerS, x10DecideToCloseMs: soldAt - (p as any).x10TriggerAt, x10Diag: (p as any).x10Diag ?? null } : {}),
    sizeSol: p.sizeSol ?? 0.5 /* positions opened before sizes were stored were 0.5 SOL */, sizeMult: p.sizeMult ?? 1, costSol: +(p.costLamports / LAMPORTS).toFixed(6), proceedsSol: +(proceeds / LAMPORTS).toFixed(6), pnlSol: +pnl.toFixed(6), roi: +(pnl / (p.sizeSol ?? 0.5 /* positions opened before sizes were stored were 0.5 SOL */)).toFixed(4),
    entryPriceSol: p.entryPriceSol, exitPriceSol: Number(outLamports) / LAMPORTS / (Number(p.tokens) / 1e6), peakMarkRoi: +p.peakRoi.toFixed(3), peakAfterS: p.peakAt ? Math.round((p.peakAt - p.entryAt) / 1000) : null, exitMarkRoi: +p.lastMarkRoi.toFixed(3), sellFails: p.sellFails, signals: p.signals, rug: p.rug, family: p.family ?? null, priv: p.priv ?? null, named: p.named ?? null, dataSource: (p as any).dataSource ?? null, trust: trustFor(p.mint, p.family), coinFactoryFunder: coinFactoryOf(p.family, p.named), feesPaid, breakEvenPct, ...markFields(p) };
  followCheckpoints(p);
  state.open = state.open.filter((x) => x !== p); closed.push(t); if (closed.length > 2500) closed.splice(0, 500); appendTrade(t); dirty = true; bump(`${p.strat}.exits`);
}

function onNewCoin(c: any, via: string) {
  // a feed counts as fresh only while it reports coins launched in the last 2 minutes (a stuck list keeps returning old coins)
  const fresh = Date.now() - Number(c.created_timestamp ?? Date.now()) < 120_000;
  if (fresh) { if (via === "ws") feed.lastWsAt = Date.now(); else if (via === "poll") feed.lastPollAt = Date.now(); else feed.lastChainAt = Date.now(); }
  const mint = c.mint; if (!mint || seen.has(mint)) return;
  if (via === "chain") feed.chainNew++;
  if (isOn()) track(mint, 120).catch(() => {});
  const createdMs = Number(c.created_timestamp ?? Date.now());
  const now = Date.now();
  const creator = c.creator ?? c.traderPublicKey ?? "";
  seen.set(mint, { mint, symbol: String(c.symbol ?? "").slice(0, 16), creator, createdMs, seenMs: now, checked: new Set(), devBuyPct: c.devBuyPct ?? null });
  nameLog(mint, String(c.name ?? ""), String(c.symbol ?? ""), createdMs);
  noteLaunchMeta(mint, c.uri ?? c.metadata_uri);
  if (creator) { const a = (creatorMints[creator] ??= []); if (!a.some((x) => x[0] === mint)) a.push([mint, createdMs]); if (a.length > 100) a.shift(); if (++cmAdds % 500 === 0) { const ks = Object.keys(creatorMints); for (const k of ks.slice(0, Math.max(0, ks.length - 20000))) delete creatorMints[k]; } } /* Oct 16: batched trim (was a 50k-key scan per coin) */
  if (creator) { const xs = (creatorLaunches.get(creator) ?? []).filter((t) => now - t < 3_600_000); xs.push(now); creatorLaunches.set(creator, xs); if (creatorLaunches.size > 5000) creatorLaunches.delete(creatorLaunches.keys().next().value!); }
  if (seen.size > 3000) seen.delete(seen.keys().next().value!);
  if (createdMs < now) push(lat.detectMs, now - createdMs);
  bump(`seen.${via}`);
  // SNIPER: earliest realistic entry = the moment we detect it (+ measured exec latency inside enter()). One sniper buy per 60 s max (leaves RugRadar snapshot queue room for every trade).
  // Warm-up: the first ~3 minutes after a restart the server is busy starting (event-loop delays up to seconds),
  // which made the pre-check overrun its 250 ms budget; no sniper buys until it settles.
  if (PAUSED.sniper) { bump("sniper.skippedPaused"); return; }
  if (process.uptime() < 180) { bump("sniper.skippedWarmup"); return; }
  if (now - createdMs < 30_000 && now - (state.counters.lastSnipeMs ?? 0) > 60_000) {
    state.counters.lastSnipeMs = now;
    (async () => {
      let pre: any = await preCheck(mint, creator, c.devBuyPct ?? null);
      // Brand-new mints often are not visible on public nodes for ~1 s: if authority was the only unknown, look once more 0.7 s later
      if (pre.red.length === 1 && pre.red[0] === "authority_unknown") { await sleep(700); const p2: any = await preCheck(mint, creator, c.devBuyPct ?? null); p2.firstPass = { ms: pre.ms, authority: pre.authority }; pre = p2; bump("sniper.authoritySecondLook"); }
      if (pre.red.includes("authority_unknown")) bump("sniper.skippedAuthorityUnknown");
      if (pre.red.length) { bump("sniper.skippedByPrecheck"); return; }
      await enter("sniper", { mint, symbol: String(c.symbol ?? ""), createdMs }, { detectLatencyMs: now - createdMs, via, precheck: pre });
    })().catch((e) => { lastErr = String(e).slice(0, 120); });
  }
}
/** Oct 18: pump.fun's coin list is a fallback only: polled at most every 30-60 s, only while PumpPortal and the chain feed are both
 * quiet (no fresh launch for 60+ s), and not for 10-15 min after a Cloudflare 403/429. */
export const pollDiag = { polls: 0, skippedFeedsLive: 0, skippedBackoff: 0, backoffUntil: null as string | null };
let pollNextAt = 0, pollBlockedUntil = 0;
async function pollNew() {
  const now = Date.now();
  if (now < pollBlockedUntil) { pollDiag.skippedBackoff++; return; }
  if (now - feed.lastWsAt < 60_000 || now - feed.lastChainAt < 60_000) { pollDiag.skippedFeedsLive++; return; }
  if (now < pollNextAt) return;
  pollNextAt = now + 30_000 + Math.floor(Math.random() * 30_000); pollDiag.polls++;
  const before = pumpDiag["frontend-api coins list"]?.fail ?? 0;
  const d = await getJ("https://frontend-api-v3.pump.fun/coins?offset=0&limit=30&sort=created_timestamp&order=DESC&includeNsfw=true");
  const last = pumpDiag["frontend-api coins list"];
  if (!d && (last?.fail ?? 0) > before && /^(403|429)$/.test(String(last?.last?.code))) { pollBlockedUntil = Date.now() + 600_000 + Math.floor(Math.random() * 300_000); pollDiag.backoffUntil = new Date(pollBlockedUntil).toISOString(); }
  for (const c of (d ?? []).reverse()) onNewCoin(c, "poll");
}
let ws: any = null; let wsBackoff = 30_000;
export const wsDiag = { opens: 0, closes: 0, lastClose: null as any, lastError: null as string | null };
// Oct 16: free backup feed. Watches Solana directly (logsSubscribe on pump.fun's mint-authority account, which only appears in create
// transactions) and decodes the CreateEvent from the logs: no extra RPC calls. Only runs while PumpPortal AND pump.fun's list are stale 60+ s.
const PUMP_MINT_AUTH = "TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM";
const CHAIN_WS = [process.env.SOLANA_WS_URL, "wss://api.mainnet-beta.solana.com", "wss://solana-rpc.publicnode.com"].filter(Boolean) as string[];
const CREATE_DISC = createHash("sha256").update("event:CreateEvent").digest().subarray(0, 8);
export const feed = { lastWsAt: 0, lastWsMsgAt: 0, lastPollAt: 0, lastChainAt: 0, chainNew: 0, chainOn: false, chainUrl: "", chainSwitches: 0 };
let chainWs: any = null, chainIdx = 0, heliusWsFails = 0;
const heliusWsBad = () => heliusWsFails >= 3;
const b58 = getAddressDecoder();
export function chainStart() {
  const W = (globalThis as any).WebSocket; if (!W || chainWs) return; const openedAt = Date.now();
  // Oct 16: Helius websocket first (cheap here: only pump.fun create transactions, ~2-4k credits/day), public RPCs as fallback
  // Oct 18: free-feed mode (default for 5 days): public Solana websockets only; Helius only while the free feeds have dropped
  const hw = heliusWsUrl(); const list = hw && budgetOk(2000) && !heliusWsBad() && (!freeFeedOn() || freeFeedDropped()) ? [hw, ...CHAIN_WS] : CHAIN_WS;
  const url = list[chainIdx % list.length]; const helius = isHeliusUrl(url); feed.chainUrl = helius ? "Helius websocket" : url.replace(/\?.*$/, ""); feed.chainOn = true; feed.chainSwitches++; if (helius) noteWsConnect();
  try {
    const w = new W(url); chainWs = w;
    w.onopen = () => w.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "logsSubscribe", params: [{ mentions: [PUMP_MINT_AUTH] }, { commitment: "confirmed" }] }));
    w.onmessage = (ev: any) => { const recvMs = Date.now(); try {
      if (helius) noteWs(String(ev.data).length);
      const logs: string[] | undefined = JSON.parse(String(ev.data)).params?.result?.value?.logs; if (!logs) return;
      for (const l of logs) { if (!l.startsWith("Program data: ")) continue; const b = Buffer.from(l.slice(14), "base64"); if (b.length < 120 || !b.subarray(0, 8).equals(CREATE_DISC)) continue;
        let o = 8; const rs = () => { const n = b.readUInt32LE(o); o += 4; const v = b.subarray(o, o + n).toString("utf8"); o += n; return v; };
        const name = rs(), symbol = rs(), uri = rs(); const mint = b58.decode(b.subarray(o, o + 32)); o += 64; const user = b58.decode(b.subarray(o, o + 32));
        const slot = Number(JSON.parse(String(ev.data)).params?.result?.context?.slot ?? 0) || null;
        onNewCoin({ mint, symbol, name, creator: user, created_timestamp: Date.now() - 1000, uri }, "chain");
        earlyV1(mint, symbol, user, logs, slot, helius ? "Helius websocket" : feed.chainUrl, recvMs); }
    } catch {} };
    w.onopen = ((o) => () => { if (helius) heliusWsFails = 0; o?.(); })(w.onopen);
    w.onclose = () => { if (helius && Date.now() - openedAt < 30_000) heliusWsFails++; if (chainWs === w) { chainWs = null; chainIdx = helius ? chainIdx : chainIdx + 1; if (helius && heliusWsFails >= 3) chainIdx++; } };
    w.onerror = () => {};
  } catch { chainWs = null; chainIdx++; }
}
function chainStop() { feed.chainOn = false; if (chainWs) { const w = chainWs; chainWs = null; try { w.close(); } catch {} } }
async function feedWatch() {
  const now = Date.now(), stale = now - feed.lastWsAt > 60_000 && now - feed.lastPollAt > 60_000;
  // With Helius available the chain feed stays on all the time (fastest launch detection); it drops to public RPCs when the daily budget runs low
  // free-feed mode: keep the chain feed on (public websockets, free) so early_v1 still sees every launch; Helius only as fallback
  const keepOn = freeFeedOn() ? true : heliusEnabled() && budgetOk(2000);
  if (chainWs && feed.chainUrl === "Helius websocket" && !budgetOk(500)) chainStop();
  if (chainWs && feed.chainUrl === "Helius websocket" && freeFeedOn() && !freeFeedDropped()) { chainStop(); chainIdx = 0; } // free feed is back: leave Helius
  if (stale || keepOn) chainStart(); else if (chainWs && now - Math.max(feed.lastWsAt, feed.lastPollAt) < 30_000) chainStop();
}
/** Free feed dropped = no fresh launch from PumpPortal / pump.fun list or a public chain websocket for 2+ minutes. */
const feedStartMs = Date.now();
/** Never true in the first 3 minutes after a start (feeds are still connecting); then both free feeds must have been silent 2+ min. */
const freeFeedDropped = () => { const now = Date.now(); if (now - feedStartMs < 180_000) return false;
  return now - Math.max(feed.lastWsAt, feed.lastPollAt, feedStartMs) > 120_000 && (feed.chainUrl === "Helius websocket" || now - Math.max(feed.lastChainAt, feedStartMs) > 120_000); };
export const activeFeed = () => { const now = Date.now(); return { active: [now - feed.lastWsAt < 60_000 && "PumpPortal websocket", now - feed.lastPollAt < 60_000 && "pump.fun list", feed.chainOn && "Solana chain backup"].filter(Boolean),
  pumpPortalLastCoinSAgo: feed.lastWsAt ? Math.round((now - feed.lastWsAt) / 1000) : null, pumpFunListLastSAgo: feed.lastPollAt ? Math.round((now - feed.lastPollAt) / 1000) : null,
  freeFeed: { ...freeFeedStatus(), freeFeedDroppedNow: freeFeedDropped() }, pumpFunListPoll: pollDiag, swapApiCapPerMin: SWAP_API_PER_MIN, chainBackup: { on: feed.chainOn, rpc: feed.chainUrl || null, lastCoinSAgo: feed.lastChainAt ? Math.round((now - feed.lastChainAt) / 1000) : null, newCoinsFromBackup: feed.chainNew, connects: feed.chainSwitches } }; };
function startWs() {
  const W = (globalThis as any).WebSocket; if (!W) return;
  try {
    ws = new W("wss://pumpportal.fun/api/data");
    ws.onopen = () => { wsDiag.opens++; wsBackoff = 30_000; ws.send(JSON.stringify({ method: "subscribeNewToken" })); };
    ws.onmessage = (ev: any) => { feed.lastWsMsgAt = Date.now();
       try { const m = JSON.parse(String(ev.data)); if (m.mint && m.txType === "create") noteLaunch(m); if (m.mint && m.txType === "create") onNewCoin({ mint: m.mint, symbol: m.symbol, name: m.name, creator: m.traderPublicKey, created_timestamp: Date.now() - 1000, devBuyPct: m.initialBuy != null ? Number(m.initialBuy) / 1e7 : null, uri: m.uri }, "ws"); } catch {} };
    // PumpPortal bans clients that reconnect too often (bans last ~1 h): back off 30 s -> 10 min
    ws.onclose = (ev: any) => { ws = null; wsDiag.closes++; wsDiag.lastClose = { at: new Date().toISOString(), code: ev?.code ?? null }; setTimeout(startWs, wsBackoff).unref?.(); wsBackoff = Math.min(600_000, wsBackoff * 2); };
    ws.onerror = (ev: any) => { wsDiag.lastError = String(ev?.message ?? ev?.error?.message ?? "error").slice(0, 80); };
  } catch { ws = null; }
}
/** Oct 18 early_v1: decide on the chain create event itself (no extra RPC call). The creator's first buy is the TradeEvent in the same
 * transaction. "No buyer over 50%" = no single non-creator wallet holds more than half of the non-creator buy SOL seen so far
 * (launch transaction + any trades already visible); the creator is covered by the 1 SOL rule. */
const TRADE_DISC = createHash("sha256").update("event:TradeEvent").digest().subarray(0, 8);
const earlyDone = new Set<string>();
export const earlyDiag = { events: 0, entries: 0, noCreatorBuy: 0, smallCreatorBuy: 0, creatorSold: 0, concentrated: 0, decideMsRecent: [] as number[] };
function earlyV1(mint: string, symbol: string, creator: string, logs: string[], slot: number | null, source: string, recvMs: number) {
  if (earlyDone.has(mint)) return; earlyDone.add(mint); if (earlyDone.size > 5000) earlyDone.delete(earlyDone.values().next().value!);
  earlyDiag.events++;
  const ev: { user: string; sol: number; buy: boolean }[] = [];
  for (const l of logs) { if (!l.startsWith("Program data: ")) continue; const b = Buffer.from(l.slice(14), "base64"); if (b.length < 129 || !b.subarray(0, 8).equals(TRADE_DISC)) continue;
    try { if (b58.decode(b.subarray(8, 40)) !== mint) continue; ev.push({ user: b58.decode(b.subarray(57, 89)), sol: Number(b.readBigUInt64LE(40)) / 1e9, buy: b[56] === 1 }); } catch {} }
  const vis = (chainTrades(mint, 100) ?? []).map((t) => ({ user: t.userAddress, sol: Number(t.amountSol || 0), buy: t.type === "buy" }));
  const all = [...ev, ...vis];
  const first = ev.find((e) => e.buy && e.user === creator);
  if (!first) { earlyDiag.noCreatorBuy++; bump("early_v1.noCreatorBuy"); return; }
  if (first.sol < 1) { earlyDiag.smallCreatorBuy++; bump("early_v1.smallCreatorBuy"); return; }
  if (all.some((e) => !e.buy && e.user === creator)) { earlyDiag.creatorSold++; bump("early_v1.creatorSold"); return; }
  const by: Record<string, number> = {}; for (const e of all) if (e.buy && e.user !== creator) by[e.user] = (by[e.user] ?? 0) + e.sol;
  const tot = Object.values(by).reduce((a, x) => a + x, 0), top = Math.max(0, ...Object.values(by)), topShare = tot > 0 ? top / tot : 0;
  if (Object.keys(by).length >= 2 && topShare > 0.5) { earlyDiag.concentrated++; bump("early_v1.concentrated"); return; }
  const c = seen.get(mint); const createdMs = c?.createdMs ?? recvMs - 1000;
  const decideMs = Date.now() - recvMs; earlyDiag.decideMsRecent.push(decideMs); if (earlyDiag.decideMsRecent.length > 30) earlyDiag.decideMsRecent.shift();
  earlyDiag.entries++;
  enter("early_v1", { mint, symbol: String(symbol ?? "").slice(0, 16), createdMs }, { rule: "early_creator_buy_1sol", source, slot, feedRecvAt: new Date(recvMs).toISOString(), recvToDecideMs: decideMs,
    creatorFirstBuySol: +first.sol.toFixed(3), otherBuyersSeen: Object.keys(by).length, topOtherBuyerSharePct: Math.round(topShare * 100), latencyNote: "latencyMs = decision -> simulated landing (measured RPC round-trips + 1 slot); launchToFillMs = launch block time -> fill" }).catch((e) => { lastErr = String(e).slice(0, 120); });
}
/** Oct 16 inflow_v1: its own fast loop (the copy scan waits on RugRadar snapshots and would miss the 30-60 s window). */
const inflowDiag = { scans: 0, lastCands: 0, seen: 0, noTrades: 0, lastScanAt: "" };
async function scanInflow() {
  const now = Date.now();
  const cands = [...seen.values()].filter((c) => now - c.createdMs >= 30_000 && now - c.createdMs <= 75_000 && !c.checked.has("inflow"));
  inflowDiag.scans++; inflowDiag.lastCands = cands.length; inflowDiag.seen = seen.size; inflowDiag.lastScanAt = new Date().toISOString();
  for (const c of cands) {
    const age = (Date.now() - c.createdMs) / 1000; if (age > 80) { c.checked.add("inflow"); bump("inflow_v1.missedWindow"); continue; }
    const tr = await trades(c.mint, 100); if (!tr) { inflowDiag.noTrades++; continue; }
      const early = tr.filter((t) => Date.parse(t.timestamp) - c.createdMs <= 60_000);
      const buys = early.filter((t) => t.type === "buy"), sells = early.filter((t) => t.type === "sell");
      const sol = (xs: any[]) => xs.reduce((a, t) => a + Number(t.amountSol || 0), 0);
      const net = sol(buys) - sol(sells), by: Record<string, number> = {}; for (const t of buys) by[t.userAddress] = (by[t.userAddress] ?? 0) + Number(t.amountSol || 0);
      const top = Math.max(0, ...Object.values(by)), topShare = sol(buys) > 0 ? top / sol(buys) : 1;
      const creatorSold = tr.some((t) => t.type === "sell" && t.userAddress === c.creator);
      if (net >= 5 && !creatorSold && topShare <= 0.5) {
        c.checked.add("inflow");
        const devBuy = [...tr].reverse().find((t) => t.type === "buy" && t.userAddress === c.creator); const m = launchMeta(c.mint);
        const sigIn = { ageS: Math.round(age), rule: "inflow_5sol_60s", netInflowSol: +net.toFixed(2), topBuyerSharePct: Math.round(topShare * 100), earlyBuyers: Object.keys(by).length,
          privateInflow: { telegram: m ? !!m.telegram : null, allThreeSocials: m ? m.socials === 3 : null, creatorFirstBuySol: devBuy ? +Number(devBuy.amountSol || 0).toFixed(3) : null, creatorFirstBuy1SolPlus: devBuy ? Number(devBuy.amountSol || 0) >= 1 : null } };
        enter("inflow_tp", c, { ...sigIn, entryOf: "inflow_v1" }).catch(() => {}); // Oct 18: same entry, tp20 exits
        if (state.open.filter((p) => p.strat === "inflow_v1").length < cfgOf("inflow_v1").maxOpen && !state.open.some((p) => p.strat === "inflow_v1" && p.mint === c.mint)) enter("inflow_fx25", c, { ...sigIn, entryOf: "inflow_v1" }).catch(() => {}); // Oct 18: same entries as inflow_v1, 25 s break-even exit
        if (state.open.filter((p) => p.strat === "inflow_v1").length < cfgOf("inflow_v1").maxOpen && !state.open.some((p) => p.strat === "inflow_v1" && p.mint === c.mint)) enter("inflow_x10", c, { ...sigIn, entryOf: "inflow_v1" }).catch(() => {}); // Oct 18: same entries as inflow_v1, 10 s / -15% / 20% trail exits
        await enter("inflow_v1", c, sigIn);
      } else { bump(net < 5 ? "inflow_v1.lowInflow" : creatorSold ? "inflow_v1.creatorSold" : "inflow_v1.concentrated"); if (age > 60) c.checked.add("inflow"); }
  }
}
async function scanCandidates() {
  const now = Date.now();
  // Only coins still needing a decision (the old slice(-25) of all seen coins dropped everything older than ~2 min, so edge never ran).
  const cands = [...seen.values()].filter((c) => now - c.createdMs > 20_000 && now - c.createdMs < 600_000 && !(c.checked.has("copy") && c.checked.has("edge"))).slice(-40);
  for (const c of cands) {
    const age = (now - c.createdMs) / 1000;
    const wantCopy = age <= 180 && !c.checked.has("copy");
    const wantEdge = age >= 120 && !c.checked.has("edge");
    if (!wantCopy && !wantEdge) continue;
    const tr = await trades(c.mint, 100); if (!tr) continue;
    const f = flow(tr, c.creator);
    // edge looks later (2-10 min) when sell flow is normal, so it uses a looser flow test; RugRadar is its main filter
    const edgeFlow = f.uniqueBuyers >= 20 && f.buySol >= f.sellSol && !f.devSold && (f.mcapUsd ?? 0) >= 7000 && (f.mcapUsd ?? 0) <= 80000;
    const momentum = f.uniqueBuyers >= 15 && f.buySol >= 1.5 * Math.max(0.5, f.sellSol) && !f.devSold && (f.mcapUsd ?? 0) >= 6000 && (f.mcapUsd ?? 0) <= 60000;
    if (wantCopy) {
      if (momentum || f.winnerBuyers.length >= 1 && !f.devSold) {
        track(c.mint, 600).catch(() => {}); // passed the early filter: keep it on the Solana backup longer (no-op when backup is off)
        c.checked.add("copy"); const rug = await rugSnapshot(c.mint); bump("copy.rugChecks");
        const v2ok = f.winnerBuyers.length >= V2.minWinners && f.uniqueBuyers >= V2.minBuyers && rug?.riskScore != null && rug.riskScore <= V2.maxRug;
        const devSoldBefore = f.devSold || Number(rug?.buyer?.devSells ?? 0) > 0 || rug?.buyer?.creatorFirstSellAfterSec != null;
        for (const s of V2_STRATS) { if (s === "copy_v2cs" && v2ok && devSoldBefore) { bump("copy_v2cs.skippedCreatorSold"); continue; } if (v2ok) await enter(s, c, { ...f, ageS: Math.round(age), rule: "v2_two_winner_wallets", rug, rugMax: V2.maxRug }); else bump(`${s}.filteredOut`); }
        for (const t of RUG_VARIANTS.copy) { if (t === 40) { if (rug?.riskScore != null && rug.riskScore <= 40) enter("tp20", c, { ...f, ageS: Math.round(age), rule: f.winnerBuyers.length ? "winner_wallet_bought" : "momentum", rug, rugMax: 40, entryOf: "copy_r40" }).catch(() => {}); else bump("tp20.rejectedByRugRadar"); } /* Oct 18: tp20 = control's entry, started alongside it */ if (rug?.riskScore != null && rug.riskScore <= t) await enter(`copy_r${t}`, c, { ...f, ageS: Math.round(age), rule: f.winnerBuyers.length ? "winner_wallet_bought" : "momentum", rug, rugMax: t }); else bump(`copy_r${t}.rejectedByRugRadar`); }
      }
      else if (age > 150) c.checked.add("copy");
    }
    if (wantEdge) {
      if (!edgeFlow) { if (age > 540) c.checked.add("edge"); continue; }
      if (now - lastRugAt < 45_000) continue; // throttle
      lastRugAt = now; c.checked.add("edge");
      const rug = await rugSnapshot(c.mint);
      bump("edge.rugChecks");
      for (const t of RUG_VARIANTS.edge) { if (rug?.riskScore != null && rug.riskScore <= t && rug.confidence !== "low") await enter(`edge_r${t}`, c, { ...f, ageS: Math.round(age), rug, rugMax: t }); else bump(`edge_r${t}.rejectedByRugRadar`); }
    }
  }
}
async function loadWinners() {
  try { const d = JSON.parse(fs.readFileSync(new URL("./winners.json", import.meta.url), "utf8")); winners = new Set((d.top ?? []).map((w: any) => w.wallet)); } catch {}
}

export async function startPaper(opts: { rugCheck: (m: string) => Promise<any>; flagged?: () => Record<string, any> }) {
  if (started || process.env.PAPER_ENABLED === "0") return; started = true;
  rugCheckFn = opts.rugCheck; if (opts.flagged) flagged = opts.flagged;
  await initStore();
  state = loadState<State>(state); (state as any).cpStartedAt ??= new Date().toISOString(); (state as any).csStartedAt ??= new Date().toISOString(); (state as any).inflowStartedAt ??= new Date().toISOString(); state.open ??= []; state.counters ??= {}; state.startedAt ??= new Date().toISOString();
  closed = loadTrades(2000); await new Promise((r) => setImmediate(r)); // Oct 16: 2,000 in memory (memory limit); full history stays in the repo
  await loadWinners();
  startWs();
  if (process.env.PAPER_FORCE_CHAIN === "1") setOn(true); // test switch
  startLagWatch();
  const loop = async (fn: () => Promise<unknown>, ms: number, label = fn.name || "paper loop") => { for (;;) { await new Promise((r) => setImmediate(r)); try { await lagTrack(label, fn); } catch (e) { lastErr = String((e as Error).message ?? e).slice(0, 160); } await sleep(ms); } };
  process.once("SIGTERM", () => { flushHistory(launchMeta, true).catch(() => {}); saveState(state, "paper: flush on shutdown").catch(() => {}); });
  const tick = () => new Promise((r) => setTimeout(r, 50)); // Oct 18: let the loop (health checks) breathe between the multi-MB parses
  loadHelius((state as any).heliusDaily); sc = loadFile<Sc[]>("scorecard.json", []); await tick(); nlog = loadFile("names.json", {}); await tick(); creatorMints = loadFile("creators.json", {}); await tick(); devStats = loadFile("devstats.json", {});
  if (!sc.length) for (const t of closed) if (t.rug?.riskScore != null && !sc.some((x) => x.mint === t.mint)) sc.push({ mint: t.mint, symbol: t.symbol, checkedAt: Date.parse(t.entryAt), score: t.rug.riskScore, level: t.rug.riskLevel, priceSol: t.entryPriceSol, liqUsd: t.rug.facts?.liquidityUsd ?? null, backfilled: true, after: {} });
  loop(scRecheck, 60_000);
  loop(() => marketTick(() => ({ chainTradesSeenTotal: chainStat.tradesSeen, seenCoins: seen.size, openPositions: state.open.length, feeds: activeFeed().active })), 60_000, "market snapshot"); // Oct 18: market snapshot
  loop(async () => { await flushHistory(launchMeta); }, 600_000, "history flush"); // Oct 18: history batch files every 10 min
  loop(pollNew, 5000); loop(rpcPing, 60_000); loop(scanCandidates, 8000); loop(scanInflow, 4000); loop(feedWatch, 15_000);
  loop(async () => { if (isOn() && state.open.length) await curveState([...new Set(state.open.map((p) => p.mint))]).catch(() => null); /* one batched price read for all open positions */ for (const p of [...state.open]) { await manageOnce(p); await new Promise((r) => setImmediate(r)); } }, 5_000, "open-position checks");
  loop(x10Tick, X10.fastMs, "inflow_x10 fast checks"); // Oct 18 inflow_x10: 1 s stop/trail checks from free price reads (no requests when it has no open position) // Oct 15: 10 s -> 5 s price checks
  loop(async () => { for (const [n, o] of [["scorecard.json", sc], ["names.json", nlog], ["creators.json", creatorMints], ["devstats.json", devStats]] as const) { await writeFile(n, o); await new Promise((r) => setImmediate(r)); } (state as any).heliusDaily = heliusDaily; if (takeHistoryDirty() || dirty || scDirty) { scDirty = false; dirty = false; await saveState(state, `paper: ${closed.length} trades, ${state.open.length} open`); } }, 180_000, "paper save loop");
}

export function paperSummary() {
  const by: Record<string, any> = {};
  for (const s of [...new Set([...STRATS, ...closed.map((t) => t.strat)])]) {
    const xs = closed.filter((t) => t.strat === s);
    const done = xs.filter((t) => t.result !== "buy_failed");
    const pnl = xs.reduce((a, t) => a + t.pnlSol, 0);
    by[s] = { closedTrades: done.length, failedBuys: xs.length - done.length, wins: done.filter((t) => t.result === "win").length,
      winRate: done.length ? +(done.filter((t) => t.result === "win").length / done.length).toFixed(3) : null,
      totalPnlSol: +pnl.toFixed(4), avgRoi: done.length ? +(done.reduce((a, t) => a + t.roi, 0) / done.length).toFixed(4) : null,
      open: state.open.filter((p) => p.strat === s).map((p) => ({ symbol: p.symbol, mint: p.mint, ageS: Math.round((Date.now() - p.entryAt) / 1000), markRoi: +p.lastMarkRoi.toFixed(3) })) };
  }
  const tests = TESTS.map((t) => { const start = Date.parse(t.startedAt || (t.strat === "inflow_v1" ? (state as any).inflowStartedAt : t.strat === "copy_v2cs" ? (state as any).csStartedAt : (state as any).cpStartedAt) || new Date().toISOString());
    const xs = closed.filter((x) => x.strat === t.strat && x.result !== "buy_failed" && Date.parse(x.entryAt) >= start); const losses = xs.filter((x) => x.pnlSol <= 0);
    return { ...t, startedAt: new Date(start).toISOString(), trades: xs.length, totalPnlSol: +xs.reduce((a, x) => a + x.pnlSol, 0).toFixed(4), avgRoi: xs.length ? +(xs.reduce((a, x) => a + x.roi, 0) / xs.length).toFixed(4) : null,
      winRate: xs.length ? +(xs.filter((x) => x.pnlSol > 0).length / xs.length).toFixed(3) : null, avgLossRoi: losses.length ? +(losses.reduce((a, x) => a + x.roi, 0) / losses.length).toFixed(4) : null }; });
  const mu = process.memoryUsage(); const mb = (x: number) => Math.round(x / 1048576); // Oct 18: memory on the free plan (512 MB)
  return { process: { rssMB: mb(mu.rss), heapUsedMB: mb(mu.heapUsed), heapTotalMB: mb(mu.heapTotal), externalMB: mb(mu.external), uptimeS: Math.round(process.uptime()), eventLoopLag: lagStatus() }, helius: heliusStatus(), dataSource: dataSource(), feed: activeFeed(), inflowDiag, earlyDiag, coinFactoryFunder: { rule: `private paper flag: a creator or funder that funded ${COIN_FACTORY.minCreators}+ coin creators in 24 h (lower bound from our traces), or a known coin-factory name`, flaggedTrades: closed.filter((t) => t.coinFactoryFunder?.flag).length, fundersTracked: fundedBy.size }, paused: PAUSED, tests, testDecisionRule: TEST_RULE, paperOnly: true, sizeSolPerTrade: "copy 0.2 SOL (control and v2 tests), edge-finder 0.1 SOL; sniper paused (was 0.4 SOL)", startedAt: state.startedAt, strategies: by,
    latency: { precheckRecent: preLog.slice(-30), eventLoopDelayMs: { p50: Math.round(loopLag.percentile(50) / 1e6), p99: Math.round(loopLag.percentile(99) / 1e6), max: Math.round(loopLag.max / 1e6) }, sniperPrecheckMedianMs: med(preMs), sniperPrecheckP90Ms: preMs.length ? [...preMs].sort((a, b) => a - b)[Math.floor(preMs.length * 0.9)] : 0, medianDetectMs: med(lat.detectMs), detectNote: "websocket launches have no on-chain timestamp in the feed; counted as 1000 ms (conservative floor). Poll-detected launches are measured.", medianRpcRoundTripMs: med(lat.rpcMs), simulatedExecMs: execLatencyMs() },
    counters: state.counters, store: storeStatus(), history: histStat, websocket: !!ws, winnersTracked: winners.size, lastError: lastErr,
    recent: closed.slice(-40).reverse().map(({ signals, rug, markPath, ...t }) => ({ ...t, rugScore: rug?.riskScore ?? null, precheckMs: signals?.precheck?.ms ?? null, rugMax: signals?.rugMax ?? null, rugLevel: rug?.riskLevel ?? null })) };
}
export const paperTrades = () => closed;
/** Smallest buy where fixed network + priority fees stay under ~5% of the trade, given pump.fun's ~2.5% round-trip fee (slippage excluded; it grows with size). */
export const minSizes = () => Object.fromEntries((Object.keys(CFG) as Base[]).map((k) => { const c = CFG[k]; const F = (2 * (BASE_FEE + c.prio + c.tip) + BASE_FEE) / LAMPORTS; return [k, { roundTripFixedFeesSol: +F.toFixed(6), minSizeSol: +(F / 0.025).toFixed(3) }]; }));

// ---------------- RugRadar scorecard: every coin RugRadar checked, re-checked at +10 min, +1 h, +24 h ----------------
type After = { at: number; changePct: number | null; priceSol: number | null; liqUsd: number | null; sellable: boolean | null; graduated: boolean; late: boolean };
export type Sc = { mint: string; symbol: string; checkedAt: number; score: number; level: string; priceSol: number | null; liqUsd: number | null; backfilled?: boolean; names?: Names | null; family?: Family | null; trust?: Trust | null; after: Record<string, After> };
// ---------------- name / ticker history (paper + scorecard only) ----------------
type Names = { nameKey: string; tickerKey: string; sameBefore: number; sameBeforeOurLog: number; sameBeforeDexScreener: number; rank: number; firstMover: boolean; launches1h: number; trend: boolean; priorScored: number; priorRugged: number };
/** Normalize for "same or very similar": lowercase, letters+digits only, drop a leading "the", trailing digits and common filler suffixes. */
export const normName = (x: string) => x.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]/g, "").replace(/^the/, "").replace(/(coin|token|inu|onsol|sol|ai)$/, "").replace(/\d+$/, "") || x.toLowerCase();
let nlog: Record<string, [string, number][]> = {}; // key -> [mint, launchMs][] from our own launch log
const meta = new Map<string, { nameKey: string; tickerKey: string; t: number }>();
function nameLog(mint: string, name: string, ticker: string, t: number) {
  const nk = "n:" + normName(name), tk = "t:" + normName(ticker); meta.set(mint, { nameKey: nk, tickerKey: tk, t }); if (meta.size > 20000) meta.delete(meta.keys().next().value!);
  for (const k of new Set([nk, tk])) { const a = (nlog[k] ??= []); if (!a.some((x) => x[0] === mint)) a.push([mint, t]); if (a.length > 200) a.shift(); }
  if (++nlAdds % 500 === 0) { const ks = Object.keys(nlog); for (const k of ks.slice(0, Math.max(0, ks.length - 20000))) delete nlog[k]; } // Oct 16: batched trim, 20k names
}
const dsCache = new Map<string, { at: number; v: { mint: string; t: number }[] }>();
/** Free DexScreener search for older same-name Solana coins (cached 6 h). Only coins that ever got a pool show up. */
async function dsSame(q: string, key: (x: string) => string, want: string) {
  const c = dsCache.get(want); if (c && Date.now() - c.at < 6 * 3_600_000) return c.v;
  const d = await getJ(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(q)}`, 5000);
  const v = ((d?.pairs ?? []) as any[]).filter((p) => p.chainId === "solana" && (key(p.baseToken?.symbol ?? "") === want || key(p.baseToken?.name ?? "") === want)).map((p) => ({ mint: p.baseToken.address, t: p.pairCreatedAt ?? 0 }));
  dsCache.set(want, { at: Date.now(), v }); if (dsCache.size > 2000) dsCache.delete(dsCache.keys().next().value!); return v;
}
async function nameHistory(mint: string): Promise<Names | null> {
  const m = meta.get(mint); if (!m) return null;
  const ours = [...new Map([...(nlog[m.nameKey] ?? []), ...(nlog[m.tickerKey] ?? [])].filter((x) => x[0] !== mint)).entries()];
  const raw = seen.get(mint)?.symbol ?? m.tickerKey.slice(2);
  const ds = (await dsSame(raw, normName, m.tickerKey.slice(2))).filter((x) => x.mint !== mint && !ours.some((o) => o[0] === x.mint));
  const before = [...ours.filter(([, t]) => t < m.t).map(([mm]) => mm), ...ds.filter((x) => x.t && x.t < m.t).map((x) => x.mint)];
  const launches1h = ours.filter(([, t]) => Math.abs(m.t - t) < 3_600_000).length + 1;
  const prior = sc.filter((x) => before.includes(x.mint));
  const latest = (x: Sc) => x.after["24h"] ?? x.after["1h"] ?? x.after["10m"];
  return { nameKey: m.nameKey, tickerKey: m.tickerKey, sameBefore: before.length, sameBeforeOurLog: ours.filter(([, t]) => t < m.t).length, sameBeforeDexScreener: ds.filter((x) => x.t && x.t < m.t).length,
    rank: before.length + 1, firstMover: before.length === 0, launches1h, trend: launches1h >= 5, priorScored: prior.length, priorRugged: prior.filter((x) => isRugged(latest(x))).length };
}
let sc: Sc[] = []; let scDirty = false;
export const scorecard = () => sc;
const OFFSETS: [string, number][] = [["10m", 600_000], ["1h", 3_600_000], ["24h", 86_400_000]];
/** Current price in SOL per whole token, from free sources: pump.fun bonding curve account (RPC) or DexScreener after graduation. */
async function nowState(mint: string): Promise<{ priceSol: number | null; liqUsd: number | null; graduated: boolean; sellable: boolean | null }> {
  try {
    const [pda] = await getProgramDerivedAddress({ programAddress: address("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"), seeds: ["bonding-curve", getAddressEncoder().encode(address(mint))] });
    const r: any = await (await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getAccountInfo", params: [pda, { encoding: "base64" }] }), signal: AbortSignal.timeout(5000) })).json();
    const b = Buffer.from(r?.result?.value?.data?.[0] ?? "", "base64");
    if (b.length >= 49 && b[48] === 0) { const vtok = Number(b.readBigUInt64LE(8)), vsol = Number(b.readBigUInt64LE(16)); return { priceSol: (vsol / 1e9) / (vtok / 1e6), liqUsd: null, graduated: false, sellable: true }; }
  } catch {}
  const d = await getJ(`https://api.dexscreener.com/tokens/v1/solana/${mint}`, 5000);
  const pairs = (Array.isArray(d) ? d : []).filter((x: any) => x.baseToken?.address === mint);
  const best = pairs.sort((a: any, b: any) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
  const q = await quote(mint, SOL, 1_000_000_000); // 1,000 tokens: does any sell route exist?
  const sellable = q ? true : noRouteFlag ? false : null;
  return { priceSol: best?.priceNative ? Number(best.priceNative) : (q ? Number(q.out) / 1e9 / 1000 : null), liqUsd: best ? (best.liquidity?.usd ?? 0) : null, graduated: true, sellable };
}
async function scRecord(mint: string, r: any) {
  if (sc.some((x) => x.mint === mint && Date.now() - x.checkedAt < 3_600_000)) return; // one scorecard row per coin per hour
  const s0 = await nowState(mint);
  const names = await nameHistory(mint).catch(() => null);
  sc.push({ mint, symbol: String(r?.facts?.symbol ?? seen.get(mint)?.symbol ?? "").slice(0, 16), checkedAt: Date.now(), score: r.riskScore, level: r.riskLevel, priceSol: s0.priceSol, liqUsd: s0.liqUsd ?? r?.facts?.liquidityUsd ?? null, names, after: {} });
  if (sc.length > 5000) sc.shift();
  scDirty = true;
  const row = sc[sc.length - 1]; const cr = seen.get(mint)?.creator; if (cr) noteDev(cr, r);
  row.trust = trustFor(mint, null);
  familyFor(mint)?.then((f) => { noteFunding(f); row.family = f; row.trust = trustFor(mint, f); scDirty = true; }).catch(() => {});
}
async function scRecheck() {
  const now = Date.now(); let n = 0;
  for (const x of sc) {
    for (const [k, off] of OFFSETS) {
      if (x.after[k] || now - x.checkedAt < off || n >= 20) continue; // at most 20 lookups/min, free sources only
      n++; const st = await nowState(x.mint);
      const changePct = st.priceSol != null && x.priceSol ? +(((st.priceSol / x.priceSol) - 1) * 100).toFixed(1) : null;
      x.after[k] = { at: now, changePct, priceSol: st.priceSol, liqUsd: st.liqUsd, sellable: st.sellable, graduated: st.graduated, late: now - x.checkedAt > off * 1.5 + 120_000 };
      scDirty = true;
    }
  }
}
export const isRugged = (a?: After) => !!a && ((a.changePct != null && a.changePct <= -90) || a.sellable === false || (a.graduated && a.liqUsd != null && a.liqUsd < 500));

// ---------------- Oct 18: per-trade price marks for offline exit replay (paper only; uses prices manage() already reads) ----------------
export const CHECKPOINTS = [10, 20, 30, 60];
const p5 = (x: number) => Number(x.toPrecision(5));
function notePriceMark(p: Pos, price: number) {
  const now = Date.now(), s = Math.round((now - p.entryAt) / 100) / 10;
  if (p.minP == null || price < p.minP) { p.minP = price; p.minAt = now; }
  const at = (p.at ??= {}); for (const k of CHECKPOINTS) if (!at[k] && s >= k) at[k] = [s, p5(price)];
  const path = (p.path ??= []); const last = path[path.length - 1];
  if (!last || s - last[0] >= (s <= 120 ? 4.5 : 29.5)) { path.push([s, p5(price)]); if (path.length > 80) path.splice(24, 1); } // ~5 s steps for 2 min, then 30 s
}
function markFields(p: Pos) {
  const roi = (x: number) => +((x / p.entryPriceSol) - 1).toFixed(4);
  return { minPriceSol: p.minP != null ? p5(p.minP) : null, minMarkRoi: p.minP != null ? roi(p.minP) : null, minAfterS: p.minAt ? Math.round((p.minAt - p.entryAt) / 100) / 10 : null,
    priceAfter: Object.fromEntries(CHECKPOINTS.map((k) => { const v = p.at?.[k]; return [String(k), v ? { atS: v[0], priceSol: v[1], roi: roi(v[1]) } : null]; })),
    markPath: p.path ?? [], marksNote: "marks every ~5 s (manage loop); priceAfter = first mark at/after each checkpoint; checkpoints after the exit go to data/trade-marks.jsonl" };
}
/** Checkpoints (10/20/30/60 s after entry) not reached before the exit: sample once each later and log to data/trade-marks.jsonl. */
function followCheckpoints(p: Pos) {
  for (const k of CHECKPOINTS) {
    if (p.at?.[k]) continue; const wait = p.entryAt + k * 1000 - Date.now(); if (wait < -5000) continue;
    setTimeout(async () => { try {
      const tr = await tradesLive(p.mint, 5); let price = tr?.[0] ? Number(tr[0].priceSol) : null;
      if (isOn()) { const cs = (await curveState([p.mint]))[p.mint]; if (cs && !cs.complete && cs.priceSol > 0) price = cs.priceSol; }
      if (price) appendLine("trade-marks.jsonl", { id: p.id, strat: p.strat, mint: p.mint, entryAt: new Date(p.entryAt).toISOString(), checkpointS: k, atS: Math.round((Date.now() - p.entryAt) / 100) / 10, priceSol: p5(price), roi: +((price / p.entryPriceSol) - 1).toFixed(4), afterExit: true });
    } catch {} }, Math.max(0, wait)).unref?.();
  }
}
