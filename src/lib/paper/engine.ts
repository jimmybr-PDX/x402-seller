/**
 * PAPER-TRADING ONLY engine. No wallets, no keys, no transactions are ever signed or sent.
 * Watches new pump.fun launches and simulates 3 strategies with real-time Jupiter quotes for fills.
 * Costs: pool fees (inside Jupiter quote), base fee, priority fee (+ tip for sniper), ATA rent (refunded on close),
 * measured latency (detection + RPC round-trips + 1 slot) with a re-quote at the simulated landing time,
 * simulated failed buys/sells, and write-off when no sell route exists. No LLM calls.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import { initStore, loadState, loadTrades, appendTrade, saveState, storeStatus } from "./store.js";

const SOL = "So11111111111111111111111111111111111111112";
const UA = { "user-agent": "Mozilla/5.0 (paper-trader)", accept: "application/json" };
const LAMPORTS = 1e9;
const SIZE_SOL = Number(process.env.PAPER_SIZE_SOL ?? 0.5);
const RPC = process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";
const BASE_FEE = 5000, ATA_RENT = 2039280;
export type Strat = "copy" | "sniper" | "edge";
type Cfg = { prio: number; tip: number; buyFail: number; sellFail: number; maxOpen: number; tp: number; trailArm: number; trail: number; sl: number; maxHoldS: number };
export const CFG: Record<Strat, Cfg> = {
  // sniper: contested launch block via public RPC, no Jito bundle -> high buy-failure rate, quick exits (snipers hold seconds-minutes)
  sniper: { prio: 1_000_000, tip: 1_000_000, buyFail: 0.25, sellFail: 0.05, maxOpen: 3, tp: 0.4, trailArm: 0.2, trail: 0.15, sl: -0.25, maxHoldS: 120 },
  // copy: rules inferred from profitable early wallets (enter ~20-180 s, ~0.5 SOL, hold ~5-20 min, take profit / trail)
  copy: { prio: 300_000, tip: 0, buyFail: 0.05, sellFail: 0.05, maxOpen: 3, tp: 1.0, trailArm: 0.3, trail: 0.25, sl: -0.3, maxHoldS: 1200 },
  // edge: momentum + RugRadar low risk only
  edge: { prio: 300_000, tip: 0, buyFail: 0.05, sellFail: 0.05, maxOpen: 3, tp: 1.0, trailArm: 0.3, trail: 0.25, sl: -0.25, maxHoldS: 1800 },
};
type Pos = { id: string; strat: Strat; mint: string; symbol: string; entryAt: number; entryAgeS: number; latencyMs: number; costLamports: number; tokens: string; entryPriceSol: number;
  peakRoi: number; lastMarkRoi: number; sellFails: number; noRouteSince: number | null; rug: any; signals: any };
type State = { v: 1; open: Pos[]; counters: Record<string, number>; startedAt: string };
let state: State = { v: 1, open: [], counters: {}, startedAt: new Date().toISOString() };
let closed: any[] = [];
const seen = new Map<string, { mint: string; symbol: string; creator: string; createdMs: number; seenMs: number; checked: Set<Strat> }>();
const lat = { detectMs: [] as number[], rpcMs: [] as number[] };
let winners = new Set<string>();
let rugCheckFn: ((m: string) => Promise<any>) | null = null;
let lastRugAt = 0; let started = false; let dirty = false; let lastErr: string | null = null;
const bump = (k: string) => { state.counters[k] = (state.counters[k] ?? 0) + 1; };
const med = (a: number[]) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : 0);
const push = (a: number[], v: number) => { a.push(v); if (a.length > 200) a.shift(); };
const rng = (seed: string) => parseInt(createHash("sha256").update(seed).digest("hex").slice(0, 8), 16) / 0xffffffff; // deterministic
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const getJ = (u: string, ms = 5000) => fetch(u, { headers: UA, signal: AbortSignal.timeout(ms) }).then((r) => (r.ok ? r.json() : null)).catch(() => null) as Promise<any>;

let noRouteFlag = false;
/** Jupiter quote. null = no fill; noRouteFlag tells a genuine NO_ROUTES_FOUND apart from a rate limit / outage. */
async function quote(input: string, output: string, amount: string | number): Promise<{ out: bigint; impact: number } | null> {
  noRouteFlag = false;
  const r = await fetch(`https://lite-api.jup.ag/swap/v1/quote?inputMint=${input}&outputMint=${output}&amount=${amount}&slippageBps=2000`, { headers: UA, signal: AbortSignal.timeout(5000) }).catch(() => null);
  const q: any = r ? await r.json().catch(() => null) : null;
  if (q && /NO_ROUTE|COULD_NOT_FIND/i.test(String(q.errorCode ?? q.error ?? ""))) noRouteFlag = true;
  if (!q?.outAmount) return null;
  return { out: BigInt(q.outAmount), impact: Number(q.priceImpactPct ?? 0) };
}
async function rpcPing(): Promise<number> {
  const t = Date.now();
  await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getLatestBlockhash", params: [{ commitment: "processed" }] }), signal: AbortSignal.timeout(5000) }).catch(() => null);
  const ms = Date.now() - t; push(lat.rpcMs, ms); return ms;
}
/** Simulated time from "decide" to "landed": blockhash fetch + send round-trip (measured) + ~1 slot. */
const execLatencyMs = () => 2 * (med(lat.rpcMs) || 300) + 400;

async function trades(mint: string, limit = 100): Promise<any[] | null> {
  const d = await getJ(`https://swap-api.pump.fun/v2/coins/${mint}/trades?limit=${limit}`, 5000);
  return d?.trades ?? null;
}
function flow(tr: any[], creator: string) {
  const buys = tr.filter((t) => t.type === "buy"), sells = tr.filter((t) => t.type === "sell");
  const sum = (xs: any[]) => xs.reduce((a, t) => a + Number(t.amountSol || 0), 0);
  return { trades: tr.length, uniqueBuyers: new Set(buys.map((t) => t.userAddress)).size, buySol: +sum(buys).toFixed(3), sellSol: +sum(sells).toFixed(3),
    devSold: sells.some((t) => t.userAddress === creator), winnerBuyers: [...new Set(buys.map((t) => t.userAddress).filter((w) => winners.has(w)))],
    priceSol: tr[0] ? Number(tr[0].priceSol) : null, mcapUsd: tr[0] ? Number(tr[0].priceUsd) * 1e9 : null };
}

async function enter(strat: Strat, c: { mint: string; symbol: string; createdMs: number }, signals: any) {
  const cfg = CFG[strat];
  if (state.open.filter((p) => p.strat === strat).length >= cfg.maxOpen) { bump(`${strat}.skipFull`); return; }
  if (state.open.some((p) => p.strat === strat && p.mint === c.mint)) return;
  const tDecide = Date.now();
  const q1 = await quote(SOL, c.mint, Math.round(SIZE_SOL * LAMPORTS));
  if (!q1) { bump(`${strat}.noBuyRoute`); return; }
  const lms = execLatencyMs(); await sleep(lms);
  const q2 = await quote(SOL, c.mint, Math.round(SIZE_SOL * LAMPORTS)); // price at simulated landing
  const fill = q2 && q2.out < q1.out ? q2.out : q1.out; // worse of the two (never flatter)
  const fees = BASE_FEE + cfg.prio + cfg.tip;
  const id = `${strat}:${c.mint}`;
  if (rng(id + ":buy") < cfg.buyFail) { // failed buy: fees burned, no position
    bump(`${strat}.buyFailed`);
    const t = { id, strat, mint: c.mint, symbol: c.symbol, result: "buy_failed", entryAt: new Date(tDecide).toISOString(), pnlSol: -fees / LAMPORTS, roi: -fees / (SIZE_SOL * LAMPORTS), signals };
    closed.push(t); appendTrade(t); dirty = true; return;
  }
  const latencyMs = Date.now() - tDecide;
  const pos: Pos = { id, strat, mint: c.mint, symbol: c.symbol, entryAt: Date.now(), entryAgeS: Math.round((Date.now() - c.createdMs) / 1000), latencyMs,
    costLamports: Math.round(SIZE_SOL * LAMPORTS) + fees + ATA_RENT, tokens: fill.toString(), entryPriceSol: SIZE_SOL / (Number(fill) / 1e6),
    peakRoi: 0, lastMarkRoi: 0, sellFails: 0, noRouteSince: null, rug: null, signals: { ...signals, impactPct: q2?.impact ?? q1.impact } };
  state.open.push(pos); bump(`${strat}.entries`); dirty = true;
  // Record RugRadar's full signals at the moment of the buy, for every strategy (sniper: right after, never delays entry).
  if (!signals.rug) rugSnapshot(c.mint).then((r) => { pos.rug = r; dirty = true; });
  else pos.rug = signals.rug;
}
let rugChain: Promise<unknown> = Promise.resolve();
/** RugRadar's own internal check, strictly one at a time and >= 15 s apart, so live RugRadar traffic keeps priority. */
function rugSnapshot(mint: string): Promise<any> {
  const p = rugChain.then(async () => { const r = await rugSnapshotNow(mint); await sleep(15_000); return r; });
  rugChain = p.catch(() => {}); return p;
}
async function rugSnapshotNow(mint: string) {
  if (!rugCheckFn) return null;
  try { const r = await rugCheckFn(mint); return { riskScore: r.riskScore, riskLevel: r.riskLevel, confidence: r.confidence, unknownSignals: r.unknownSignals, checks: r.checks, buyer: r.buyer, facts: r.facts }; }
  catch (e) { return { error: String((e as Error).message ?? e).slice(0, 100) }; }
}

async function manage(p: Pos) {
  const cfg = CFG[p.strat];
  const tr = await trades(p.mint, 5);
  const price = tr?.[0] ? Number(tr[0].priceSol) : null;
  const holdS = (Date.now() - p.entryAt) / 1000;
  if (price) { p.lastMarkRoi = (price / p.entryPriceSol) - 1; p.peakRoi = Math.max(p.peakRoi, p.lastMarkRoi); }
  const r = p.lastMarkRoi;
  let reason: string | null = null;
  if (r >= cfg.tp) reason = "take_profit";
  else if (p.peakRoi >= cfg.trailArm && r <= p.peakRoi - cfg.trail) reason = "trailing_stop";
  else if (r <= cfg.sl) reason = "stop_loss";
  else if (holdS >= cfg.maxHoldS) reason = "time_stop";
  if (!reason) return;
  const q = await quote(p.mint, SOL, p.tokens);
  const fees = BASE_FEE + cfg.prio + cfg.tip;
  if (!q || q.out === 0n) {
    if (!noRouteFlag && q == null) { bump("quoteErrors"); return; } // API error/rate limit: retry, do not count as unsellable
    p.noRouteSince ??= Date.now();
    if (Date.now() - p.noRouteSince > 10 * 60_000) return close(p, "no_sell_route_writeoff", 0n, fees);
    return;
  }
  p.noRouteSince = null;
  if (rng(`${p.id}:sell:${p.sellFails}`) < cfg.sellFail) { p.sellFails++; bump(`${p.strat}.sellFailed`); p.costLamports += fees; dirty = true; return; } // retry next tick at the new price
  await sleep(execLatencyMs());
  const q2 = await quote(p.mint, SOL, p.tokens);
  const out = q2 && q2.out < q.out ? q2.out : q.out;
  close(p, reason, out, fees);
}
function close(p: Pos, reason: string, outLamports: bigint, fees: number) {
  const proceeds = Number(outLamports) - fees - BASE_FEE + ATA_RENT; // sell tx + close-account tx refunds rent
  const pnl = (proceeds - p.costLamports) / LAMPORTS;
  const t = { id: p.id, strat: p.strat, mint: p.mint, symbol: p.symbol, result: pnl > 0 ? "win" : "loss", exitReason: reason,
    entryAt: new Date(p.entryAt).toISOString(), exitAt: new Date().toISOString(), holdS: Math.round((Date.now() - p.entryAt) / 1000), entryAgeS: p.entryAgeS, latencyMs: p.latencyMs,
    sizeSol: SIZE_SOL, costSol: +(p.costLamports / LAMPORTS).toFixed(6), proceedsSol: +(proceeds / LAMPORTS).toFixed(6), pnlSol: +pnl.toFixed(6), roi: +(pnl / SIZE_SOL).toFixed(4),
    entryPriceSol: p.entryPriceSol, exitPriceSol: Number(outLamports) / LAMPORTS / (Number(p.tokens) / 1e6), peakMarkRoi: +p.peakRoi.toFixed(3), sellFails: p.sellFails, signals: p.signals, rug: p.rug };
  state.open = state.open.filter((x) => x !== p); closed.push(t); appendTrade(t); dirty = true; bump(`${p.strat}.exits`);
}

function onNewCoin(c: any, via: string) {
  const mint = c.mint; if (!mint || seen.has(mint)) return;
  const createdMs = Number(c.created_timestamp ?? Date.now());
  const now = Date.now();
  seen.set(mint, { mint, symbol: String(c.symbol ?? "").slice(0, 16), creator: c.creator ?? c.traderPublicKey ?? "", createdMs, seenMs: now, checked: new Set() });
  if (seen.size > 3000) seen.delete(seen.keys().next().value!);
  if (createdMs < now) push(lat.detectMs, now - createdMs);
  bump(`seen.${via}`);
  // SNIPER: earliest realistic entry = the moment we detect it (+ measured exec latency inside enter()). One sniper buy per 20 s max.
  if (now - createdMs < 30_000 && now - (state.counters.lastSnipeMs ?? 0) > 20_000) {
    state.counters.lastSnipeMs = now;
    enter("sniper", { mint, symbol: String(c.symbol ?? ""), createdMs }, { detectLatencyMs: now - createdMs, via }).catch((e) => { lastErr = String(e).slice(0, 120); });
  }
}
async function pollNew() {
  const d = await getJ("https://frontend-api-v3.pump.fun/coins?offset=0&limit=30&sort=created_timestamp&order=DESC&includeNsfw=true");
  for (const c of (d ?? []).reverse()) onNewCoin(c, "poll");
}
let ws: any = null;
function startWs() {
  const W = (globalThis as any).WebSocket; if (!W) return;
  try {
    ws = new W("wss://pumpportal.fun/api/data");
    ws.onopen = () => ws.send(JSON.stringify({ method: "subscribeNewToken" }));
    ws.onmessage = (ev: any) => { try { const m = JSON.parse(String(ev.data)); if (m.mint && m.txType === "create") onNewCoin({ mint: m.mint, symbol: m.symbol, creator: m.traderPublicKey, created_timestamp: Date.now() - 1000 }, "ws"); } catch {} };
    ws.onclose = () => { ws = null; setTimeout(startWs, 30_000).unref?.(); };
    ws.onerror = () => {};
  } catch { ws = null; }
}
async function scanCandidates() {
  const now = Date.now();
  const cands = [...seen.values()].filter((c) => now - c.createdMs > 20_000 && now - c.createdMs < 600_000).slice(-25);
  for (const c of cands) {
    const age = (now - c.createdMs) / 1000;
    const wantCopy = age <= 180 && !c.checked.has("copy");
    const wantEdge = age >= 120 && !c.checked.has("edge");
    if (!wantCopy && !wantEdge) continue;
    const tr = await trades(c.mint, 100); if (!tr) continue;
    const f = flow(tr, c.creator);
    const momentum = f.uniqueBuyers >= 15 && f.buySol >= 1.5 * Math.max(0.5, f.sellSol) && !f.devSold && (f.mcapUsd ?? 0) >= 6000 && (f.mcapUsd ?? 0) <= 60000;
    if (wantCopy) {
      if (momentum || f.winnerBuyers.length >= 1 && !f.devSold) { c.checked.add("copy"); await enter("copy", c, { ...f, ageS: Math.round(age), rule: f.winnerBuyers.length ? "winner_wallet_bought" : "momentum" }); }
      else if (age > 150) c.checked.add("copy");
    }
    if (wantEdge) {
      if (!momentum) { if (age > 540) c.checked.add("edge"); continue; }
      if (now - lastRugAt < 45_000) continue; // throttle
      lastRugAt = now; c.checked.add("edge");
      const rug = await rugSnapshot(c.mint);
      bump("edge.rugChecks");
      if (rug?.riskLevel === "low" && rug.confidence !== "low") await enter("edge", c, { ...f, ageS: Math.round(age), rug });
      else bump("edge.rejectedByRugRadar");
    }
  }
}
async function loadWinners() {
  try { const d = JSON.parse(fs.readFileSync(new URL("./winners.json", import.meta.url), "utf8")); winners = new Set((d.top ?? []).map((w: any) => w.wallet)); } catch {}
}

export async function startPaper(opts: { rugCheck: (m: string) => Promise<any> }) {
  if (started || process.env.PAPER_ENABLED === "0") return; started = true;
  rugCheckFn = opts.rugCheck;
  await initStore();
  state = loadState<State>(state); state.open ??= []; state.counters ??= {}; state.startedAt ??= new Date().toISOString();
  closed = loadTrades().slice(-5000);
  await loadWinners();
  startWs();
  const loop = async (fn: () => Promise<unknown>, ms: number) => { for (;;) { try { await fn(); } catch (e) { lastErr = String((e as Error).message ?? e).slice(0, 160); } await sleep(ms); } };
  loop(pollNew, 6000); loop(rpcPing, 60_000); loop(scanCandidates, 8000);
  loop(async () => { for (const p of [...state.open]) await manage(p); }, 10_000);
  loop(async () => { if (dirty) { dirty = false; await saveState(state, `paper: ${closed.length} trades, ${state.open.length} open`); } }, 180_000);
}

export function paperSummary() {
  const by: Record<string, any> = {};
  for (const s of ["copy", "sniper", "edge"] as Strat[]) {
    const xs = closed.filter((t) => t.strat === s);
    const done = xs.filter((t) => t.result !== "buy_failed");
    const pnl = xs.reduce((a, t) => a + t.pnlSol, 0);
    by[s] = { closedTrades: done.length, failedBuys: xs.length - done.length, wins: done.filter((t) => t.result === "win").length,
      winRate: done.length ? +(done.filter((t) => t.result === "win").length / done.length).toFixed(3) : null,
      totalPnlSol: +pnl.toFixed(4), avgRoi: done.length ? +(done.reduce((a, t) => a + t.roi, 0) / done.length).toFixed(4) : null,
      open: state.open.filter((p) => p.strat === s).map((p) => ({ symbol: p.symbol, mint: p.mint, ageS: Math.round((Date.now() - p.entryAt) / 1000), markRoi: +p.lastMarkRoi.toFixed(3) })) };
  }
  return { paperOnly: true, sizeSolPerTrade: SIZE_SOL, startedAt: state.startedAt, strategies: by,
    latency: { medianDetectMs: med(lat.detectMs), medianRpcRoundTripMs: med(lat.rpcMs), simulatedExecMs: execLatencyMs() },
    counters: state.counters, store: storeStatus(), websocket: !!ws, winnersTracked: winners.size, lastError: lastErr,
    recent: closed.slice(-40).reverse().map(({ signals, rug, ...t }) => ({ ...t, rugScore: rug?.riskScore ?? null, rugLevel: rug?.riskLevel ?? null })) };
}
export const paperTrades = () => closed;
