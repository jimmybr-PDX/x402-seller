/**
 * PAPER-TRADING ONLY engine. No wallets, no keys, no transactions are ever signed or sent.
 * Watches new pump.fun launches and simulates 3 strategies with real-time Jupiter quotes for fills.
 * Costs: pool fees (inside Jupiter quote), base fee, priority fee (+ tip for sniper), ATA rent (refunded on close),
 * measured latency (detection + RPC round-trips + 1 slot) with a re-quote at the simulated landing time,
 * simulated failed buys/sells, and write-off when no sell route exists. No LLM calls.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import { getProgramDerivedAddress, getAddressEncoder, address } from "@solana/kit";
import { familyOf, type Family } from "./family.js";
import { initStore, loadState, loadTrades, appendTrade, saveState, storeStatus, loadFile, writeFile } from "./store.js";

const SOL = "So11111111111111111111111111111111111111112";
const UA = { "user-agent": "Mozilla/5.0 (paper-trader)", accept: "application/json" };
const LAMPORTS = 1e9;
const SIZE_SOL = Number(process.env.PAPER_SIZE_SOL ?? 0.5);
const RPC = process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";
const BASE_FEE = 5000, ATA_RENT = 2039280;
export type Strat = string; // "sniper", or "<copy|edge>_r<maxRugScore>" threshold variants
type Base = "copy" | "sniper" | "edge";
export const RUG_VARIANTS: Record<"copy" | "edge", number[]> = { copy: [25, 40, 60], edge: [15, 25, 40] }; // max RugRadar score allowed
export const STRATS: Strat[] = ["sniper", ...RUG_VARIANTS.copy.map((t) => `copy_r${t}`), ...RUG_VARIANTS.edge.map((t) => `edge_r${t}`)];
const baseOf = (s: Strat) => s.split(/[_@]/)[0] as Base;
type Cfg = { prio: number; tip: number; buyFail: number; sellFail: number; maxOpen: number; tp: number; trailArm: number; trail: number; sl: number; maxHoldS: number };
export const CFG: Record<Base, Cfg> = {
  // sniper: contested launch block via public RPC, no Jito bundle -> high buy-failure rate, quick exits (snipers hold seconds-minutes)
  sniper: { prio: 1_000_000, tip: 1_000_000, buyFail: 0.25, sellFail: 0.05, maxOpen: 3, tp: 0.4, trailArm: 0.2, trail: 0.15, sl: -0.25, maxHoldS: 120 },
  // copy: rules inferred from profitable early wallets (enter ~20-180 s, ~0.5 SOL, hold ~5-20 min, take profit / trail)
  copy: { prio: 300_000, tip: 0, buyFail: 0.05, sellFail: 0.05, maxOpen: 3, tp: 1.0, trailArm: 0.3, trail: 0.25, sl: -0.3, maxHoldS: 1200 },
  // edge: momentum + RugRadar low risk only
  edge: { prio: 300_000, tip: 0, buyFail: 0.05, sellFail: 0.05, maxOpen: 3, tp: 1.0, trailArm: 0.3, trail: 0.25, sl: -0.25, maxHoldS: 1800 },
};
type Pos = { id: string; strat: Strat; mint: string; symbol: string; entryAt: number; entryAgeS: number; latencyMs: number; costLamports: number; tokens: string; entryPriceSol: number;
  forceExit?: string; sizeSol?: number; sizeMult?: number; family?: Family | null; peakAt?: number; peakRoi: number; lastMarkRoi: number; sellFails: number; noRouteSince: number | null; rug: any; signals: any };
type State = { v: 1; open: Pos[]; counters: Record<string, number>; startedAt: string };
let state: State = { v: 1, open: [], counters: {}, startedAt: new Date().toISOString() };
let closed: any[] = [];
const seen = new Map<string, { mint: string; symbol: string; creator: string; createdMs: number; seenMs: number; checked: Set<string>; devBuyPct: number | null }>();
const creatorLaunches = new Map<string, number[]>(); // in-session creator history (launch times)
const preMs: number[] = [];
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
/** Fallback when Jupiter drops a dead pump.fun coin from routing: price a sell straight against the bonding curve account
 * (constant product on virtual reserves, minus ~1.25% pump.fun fees). Returns null if the curve is complete/unreadable. */
async function curveSell(mint: string, tokens: bigint): Promise<bigint | null> {
  try {
    const [pda] = await getProgramDerivedAddress({ programAddress: address("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"), seeds: ["bonding-curve", getAddressEncoder().encode(address(mint))] });
    const r: any = await (await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getAccountInfo", params: [pda, { encoding: "base64" }] }), signal: AbortSignal.timeout(5000) })).json();
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
  if (launches1h >= 3) red.push(`creator_${launches1h}_launches_1h`);
  if (devBuyPct != null && devBuyPct > 15) red.push(`creator_bought_${devBuyPct.toFixed(0)}pct`);
  let authority: string = "unknown";
  try {
    const r: any = await Promise.race([
      fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getAccountInfo", params: [mint, { encoding: "jsonParsed", commitment: "processed" }] }), signal: AbortSignal.timeout(250) }).then((x) => x.json()),
      sleep(250).then(() => { throw new Error("budget"); }),
    ]);
    const info = r?.result?.value?.data?.parsed?.info;
    if (info) { authority = "ok"; if (info.mintAuthority) red.push("mint_authority"); if (info.freezeAuthority) red.push("freeze_authority"); }
  } catch { authority = "timeout"; } // over budget: proceed on the memory-only signals (logged)
  const ms = Date.now() - t0; push(preMs, ms);
  return { ms, red, authority, devBuyPct, creatorLaunches1h: launches1h };
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

export const GOOD_DEV_MULTS = [1.5, 2, 3]; // extra test positions on "Known good dev" coins
async function enter(strat: Strat, c: { mint: string; symbol: string; createdMs: number }, signals: any, mult = 1) {
  const SIZE = SIZE_SOL * mult;
  if (mult === 1) { // trusted-dev coin: also open bigger test positions, tracked as their own variants ("<strategy>@2x")
    const fam = await Promise.race([familyFor(c.mint) ?? Promise.resolve(null), sleep(baseOf(strat) === "sniper" ? 0 : 1000).then(() => null)]).catch(() => null);
    const tr = trustFor(c.mint, fam as any);
    if (tr?.knownGood) for (const m of GOOD_DEV_MULTS) enter(`${strat}@${m}x`, c, { ...signals, trust: tr }, m).catch(() => {});
    if (tr) signals = { ...signals, trust: tr };
  }
  const cfg = CFG[baseOf(strat)];
  if (state.open.filter((p) => p.strat === strat).length >= cfg.maxOpen) { bump(`${strat}.skipFull`); return; }
  if (state.open.some((p) => p.strat === strat && p.mint === c.mint)) return;
  const tDecide = Date.now();
  const q1 = await quote(SOL, c.mint, Math.round(SIZE * LAMPORTS));
  if (!q1) { bump(`${strat}.noBuyRoute`); return; }
  const lms = execLatencyMs(); await sleep(lms);
  const q2 = await quote(SOL, c.mint, Math.round(SIZE * LAMPORTS)); // price at simulated landing
  const fill = q2 && q2.out < q1.out ? q2.out : q1.out; // worse of the two (never flatter)
  const fees = BASE_FEE + cfg.prio + cfg.tip;
  const id = `${strat}:${c.mint}`;
  if (rng(id + ":buy") < cfg.buyFail) { // failed buy: fees burned, no position
    bump(`${strat}.buyFailed`);
    const t = { id, strat, mint: c.mint, symbol: c.symbol, result: "buy_failed", entryAt: new Date(tDecide).toISOString(), pnlSol: -fees / LAMPORTS, roi: -fees / (SIZE * LAMPORTS), sizeSol: SIZE, sizeMult: mult, signals };
    closed.push(t); appendTrade(t); dirty = true; return;
  }
  const latencyMs = Date.now() - tDecide;
  const pos: Pos = { id, strat, mint: c.mint, symbol: c.symbol, entryAt: Date.now(), entryAgeS: Math.round((Date.now() - c.createdMs) / 1000), latencyMs,
    costLamports: Math.round(SIZE * LAMPORTS) + fees + ATA_RENT, tokens: fill.toString(), entryPriceSol: SIZE / (Number(fill) / 1e6), sizeSol: SIZE, sizeMult: mult,
    peakRoi: 0, lastMarkRoi: 0, sellFails: 0, noRouteSince: null, rug: null, signals: { ...signals, impactPct: q2?.impact ?? q1.impact } };
  state.open.push(pos); bump(`${strat}.entries`); dirty = true;
  // Private creator-family trace: async for the sniper (never on its critical path); copy/edge wait up to 1 s, else it fills in later.
  const famP = familyFor(c.mint);
  if (famP) { famP.then((f) => { pos.family = f; dirty = true; }).catch(() => {}); if (baseOf(strat) !== "sniper") await Promise.race([famP, sleep(1000)]).catch(() => {}); }
  // Record RugRadar's full signals at the moment of the buy, for every strategy (sniper: right after, never delays entry).
  if (!signals.rug) pendingRug.set(pos.id, rugSnapshot(c.mint).then((r) => { pos.rug = r; dirty = true; pendingRug.delete(pos.id); if (strat === "sniper" && r?.riskLevel === "high") pos.forceExit = "rugradar_high_risk_after_entry"; return r; }));
  else pos.rug = signals.rug;
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

async function manage(p: Pos) {
  const cfg = CFG[baseOf(p.strat)];
  const tr = await trades(p.mint, 5);
  const price = tr?.[0] ? Number(tr[0].priceSol) : null;
  const holdS = (Date.now() - p.entryAt) / 1000;
  if (price) { p.lastMarkRoi = (price / p.entryPriceSol) - 1; if (p.lastMarkRoi > p.peakRoi) { p.peakRoi = p.lastMarkRoi; p.peakAt = Date.now(); } }
  const r = p.lastMarkRoi;
  let reason: string | null = p.forceExit ?? null;
  if (reason) {}
  else if (r >= cfg.tp) reason = "take_profit";
  else if (p.peakRoi >= cfg.trailArm && r <= p.peakRoi - cfg.trail) reason = "trailing_stop";
  else if (r <= cfg.sl) reason = "stop_loss";
  else if (holdS >= cfg.maxHoldS) reason = "time_stop";
  if (!reason) return;
  const q = await quote(p.mint, SOL, p.tokens);
  const fees = BASE_FEE + cfg.prio + cfg.tip;
  if (!q || q.out === 0n) {
    if (!noRouteFlag && q == null) { bump("quoteErrors"); return; } // API error/rate limit: retry, do not count as unsellable
    const direct = await curveSell(p.mint, BigInt(p.tokens));
    if (direct != null && direct > 0n) { await sleep(execLatencyMs()); return close(p, reason + "_via_curve", direct, fees); }
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
let creatorMints: Record<string, [string, number][]> = {};
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
function familyFor(mint: string) { const c = seen.get(mint); return c?.creator ? familyOf(c.creator, c.createdMs, famCtx) : null; }
async function close(p: Pos, reason: string, outLamports: bigint, fees: number) {
  state.open = state.open.filter((x) => x !== p);
  const pr = pendingRug.get(p.id); // trade log must carry RugRadar's snapshot taken at buy time
  if (pr) await Promise.race([pr, sleep(90_000)]);
  const proceeds = Number(outLamports) - fees - BASE_FEE + ATA_RENT; // sell tx + close-account tx refunds rent
  const pnl = (proceeds - p.costLamports) / LAMPORTS;
  const t = { id: p.id, strat: p.strat, mint: p.mint, symbol: p.symbol, result: pnl > 0 ? "win" : "loss", exitReason: reason,
    entryAt: new Date(p.entryAt).toISOString(), exitAt: new Date().toISOString(), holdS: Math.round((Date.now() - p.entryAt) / 1000), entryAgeS: p.entryAgeS, latencyMs: p.latencyMs,
    sizeSol: p.sizeSol ?? SIZE_SOL, sizeMult: p.sizeMult ?? 1, costSol: +(p.costLamports / LAMPORTS).toFixed(6), proceedsSol: +(proceeds / LAMPORTS).toFixed(6), pnlSol: +pnl.toFixed(6), roi: +(pnl / (p.sizeSol ?? SIZE_SOL)).toFixed(4),
    entryPriceSol: p.entryPriceSol, exitPriceSol: Number(outLamports) / LAMPORTS / (Number(p.tokens) / 1e6), peakMarkRoi: +p.peakRoi.toFixed(3), peakAfterS: p.peakAt ? Math.round((p.peakAt - p.entryAt) / 1000) : null, exitMarkRoi: +p.lastMarkRoi.toFixed(3), sellFails: p.sellFails, signals: p.signals, rug: p.rug, family: p.family ?? null, trust: trustFor(p.mint, p.family) };
  state.open = state.open.filter((x) => x !== p); closed.push(t); appendTrade(t); dirty = true; bump(`${p.strat}.exits`);
}

function onNewCoin(c: any, via: string) {
  const mint = c.mint; if (!mint || seen.has(mint)) return;
  const createdMs = Number(c.created_timestamp ?? Date.now());
  const now = Date.now();
  const creator = c.creator ?? c.traderPublicKey ?? "";
  seen.set(mint, { mint, symbol: String(c.symbol ?? "").slice(0, 16), creator, createdMs, seenMs: now, checked: new Set(), devBuyPct: c.devBuyPct ?? null });
  nameLog(mint, String(c.name ?? ""), String(c.symbol ?? ""), createdMs);
  if (creator) { const a = (creatorMints[creator] ??= []); if (!a.some((x) => x[0] === mint)) a.push([mint, createdMs]); if (a.length > 100) a.shift(); const ks = Object.keys(creatorMints); if (ks.length > 50000) delete creatorMints[ks[0]]; }
  if (creator) { const xs = (creatorLaunches.get(creator) ?? []).filter((t) => now - t < 3_600_000); xs.push(now); creatorLaunches.set(creator, xs); if (creatorLaunches.size > 5000) creatorLaunches.delete(creatorLaunches.keys().next().value!); }
  if (seen.size > 3000) seen.delete(seen.keys().next().value!);
  if (createdMs < now) push(lat.detectMs, now - createdMs);
  bump(`seen.${via}`);
  // SNIPER: earliest realistic entry = the moment we detect it (+ measured exec latency inside enter()). One sniper buy per 60 s max (leaves RugRadar snapshot queue room for every trade).
  if (now - createdMs < 30_000 && now - (state.counters.lastSnipeMs ?? 0) > 60_000) {
    state.counters.lastSnipeMs = now;
    (async () => {
      const pre = await preCheck(mint, creator, c.devBuyPct ?? null);
      if (pre.red.length) { bump("sniper.skippedByPrecheck"); return; }
      await enter("sniper", { mint, symbol: String(c.symbol ?? ""), createdMs }, { detectLatencyMs: now - createdMs, via, precheck: pre });
    })().catch((e) => { lastErr = String(e).slice(0, 120); });
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
    ws.onmessage = (ev: any) => { try { const m = JSON.parse(String(ev.data)); if (m.mint && m.txType === "create") onNewCoin({ mint: m.mint, symbol: m.symbol, name: m.name, creator: m.traderPublicKey, created_timestamp: Date.now() - 1000, devBuyPct: m.initialBuy != null ? Number(m.initialBuy) / 1e7 : null }, "ws"); } catch {} };
    ws.onclose = () => { ws = null; setTimeout(startWs, 30_000).unref?.(); };
    ws.onerror = () => {};
  } catch { ws = null; }
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
        c.checked.add("copy"); const rug = await rugSnapshot(c.mint); bump("copy.rugChecks");
        for (const t of RUG_VARIANTS.copy) { if (rug?.riskScore != null && rug.riskScore <= t) await enter(`copy_r${t}`, c, { ...f, ageS: Math.round(age), rule: f.winnerBuyers.length ? "winner_wallet_bought" : "momentum", rug, rugMax: t }); else bump(`copy_r${t}.rejectedByRugRadar`); }
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
  state = loadState<State>(state); state.open ??= []; state.counters ??= {}; state.startedAt ??= new Date().toISOString();
  closed = loadTrades().slice(-5000);
  await loadWinners();
  startWs();
  const loop = async (fn: () => Promise<unknown>, ms: number) => { for (;;) { try { await fn(); } catch (e) { lastErr = String((e as Error).message ?? e).slice(0, 160); } await sleep(ms); } };
  process.once("SIGTERM", () => { saveState(state, "paper: flush on shutdown").catch(() => {}); });
  sc = loadFile<Sc[]>("scorecard.json", []); nlog = loadFile("names.json", {}); creatorMints = loadFile("creators.json", {}); devStats = loadFile("devstats.json", {});
  if (!sc.length) for (const t of closed) if (t.rug?.riskScore != null && !sc.some((x) => x.mint === t.mint)) sc.push({ mint: t.mint, symbol: t.symbol, checkedAt: Date.parse(t.entryAt), score: t.rug.riskScore, level: t.rug.riskLevel, priceSol: t.entryPriceSol, liqUsd: t.rug.facts?.liquidityUsd ?? null, backfilled: true, after: {} });
  loop(scRecheck, 60_000);
  loop(pollNew, 6000); loop(rpcPing, 60_000); loop(scanCandidates, 8000);
  loop(async () => { for (const p of [...state.open]) await manage(p); }, 10_000);
  loop(async () => { writeFile("scorecard.json", sc); writeFile("names.json", nlog); writeFile("creators.json", creatorMints); writeFile("devstats.json", devStats); if (dirty || scDirty) { scDirty = false; dirty = false; await saveState(state, `paper: ${closed.length} trades, ${state.open.length} open`); } }, 180_000);
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
  return { paperOnly: true, sizeSolPerTrade: SIZE_SOL, startedAt: state.startedAt, strategies: by,
    latency: { sniperPrecheckMedianMs: med(preMs), sniperPrecheckP90Ms: preMs.length ? [...preMs].sort((a, b) => a - b)[Math.floor(preMs.length * 0.9)] : 0, medianDetectMs: med(lat.detectMs), detectNote: "websocket launches have no on-chain timestamp in the feed; counted as 1000 ms (conservative floor). Poll-detected launches are measured.", medianRpcRoundTripMs: med(lat.rpcMs), simulatedExecMs: execLatencyMs() },
    counters: state.counters, store: storeStatus(), websocket: !!ws, winnersTracked: winners.size, lastError: lastErr,
    recent: closed.slice(-40).reverse().map(({ signals, rug, ...t }) => ({ ...t, rugScore: rug?.riskScore ?? null, precheckMs: signals?.precheck?.ms ?? null, rugMax: signals?.rugMax ?? null, rugLevel: rug?.riskLevel ?? null })) };
}
export const paperTrades = () => closed;

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
  const ks = Object.keys(nlog); if (ks.length > 30000) delete nlog[ks[0]];
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
  familyFor(mint)?.then((f) => { row.family = f; row.trust = trustFor(mint, f); scDirty = true; }).catch(() => {});
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
