/**
 * Oct 18: durable history for offline research (paper bots only; free data only, never Helius).
 *  - coin trades: every trade list the bots already pull for a coin (pump.fun swap-api or the Solana backup), merged per coin,
 *    max 150 trades per coin, written once the coin goes quiet (no new lookups for 3 min) or after 15 min.
 *    Row: [unixSec, "b"|"s", wallet, sol, priceSol, txOrId]
 *  - launches: every new coin the free PumpPortal feed sends (mint, creator, time, name/symbol, initial buy, socials flags from the
 *    metadata the bots already fetch: twitter/telegram/website present, description length; null when metadata was not fetched).
 *  - market: once a minute, SOL/USD (Coinbase + Kraken) and pump.fun activity seen by the feeds (launches/min, trades/min).
 * Everything is buffered in memory (capped) and written as one gzip JSONL file per batch (every 10 min) into the paper store.
 */
import { writeBatch } from "./store.js";
const sig5 = (x: number) => (isFinite(x) && x !== 0 ? Number(x.toPrecision(5)) : 0);
type Row = [number, "b" | "s", string, number, number, string];
type CoinBuf = { first: number; last: number; rows: Map<string, Row> };
const coins = new Map<string, CoinBuf>();
const MAX_COINS = Number(process.env.PAPER_HIST_MAX_COINS ?? 800), PER_COIN = 150;
const QUIET_MS = 180_000, MAX_AGE_MS = 15 * 60_000;
let readyCoins: { m: string; n: number; t: Row[] }[] = [];
export const histStat = { coinsWritten: 0, tradesWritten: 0, launchesWritten: 0, marketWritten: 0, files: 0, lastFile: null as string | null, buffered: 0, tradesSeenMin: 0, launchesMin: 0, lastError: null as string | null };
let newTradesThisMin = 0;

function finish(mint: string, b: CoinBuf) {
  coins.delete(mint);
  const t = [...b.rows.values()].sort((x, y) => x[0] - y[0]).slice(-PER_COIN);
  if (t.length) readyCoins.push({ m: mint, n: t.length, t });
}
/** Note a trade list (newest first, pump.fun swap-api shape) the bots just pulled for a coin. */
export function noteCoinTrades(mint: string, trades: any[] | null | undefined) {
  if (!mint || !Array.isArray(trades) || !trades.length) return;
  const now = Date.now(); let b = coins.get(mint);
  if (!b) { if (coins.size >= MAX_COINS) { const [m0, b0] = coins.entries().next().value!; finish(m0, b0); } b = { first: now, last: now, rows: new Map() }; coins.set(mint, b); }
  b.last = now;
  for (const t of trades) {
    const ts = Math.floor(Date.parse(t.timestamp ?? "") / 1000) || 0, id = String(t.signature ?? t.tx ?? t.slotIndexId ?? "");
    const key = id || `${ts}:${t.userAddress}:${t.amountSol}`;
    if (b.rows.has(key)) continue;
    b.rows.set(key, [ts, t.type === "sell" ? "s" : "b", String(t.userAddress ?? ""), +Number(t.amountSol || 0).toFixed(4), sig5(Number(t.priceSol || 0)), id]); newTradesThisMin++;
  }
  if (b.rows.size > PER_COIN + 50) { const keep = [...b.rows.entries()].sort((x, y) => y[1][0] - x[1][0]).slice(0, PER_COIN); b.rows = new Map(keep); }
}

// ---- launches (PumpPortal create events) ----
type Launch = { t: number; m: string; c: string; n: string; s: string; ibTok: number | null; ibSol: number | null; mcSol: number | null; uri: boolean };
let pendingLaunches: Launch[] = []; let readyLaunches: any[] = []; let launchesThisMin = 0;
export function noteLaunch(m: any) {
  launchesThisMin++;
  if (pendingLaunches.length > 5000) pendingLaunches.shift();
  pendingLaunches.push({ t: Date.now(), m: String(m.mint), c: String(m.traderPublicKey ?? ""), n: String(m.name ?? "").slice(0, 64), s: String(m.symbol ?? "").slice(0, 24),
    ibTok: m.initialBuy != null ? Number(m.initialBuy) : null, ibSol: m.solAmount != null ? +Number(m.solAmount).toFixed(4) : null, mcSol: m.marketCapSol != null ? +Number(m.marketCapSol).toFixed(3) : null, uri: !!m.uri });
}
/** Finalize launches older than 20 s (metadata fetch has had time), using the bots' own metadata cache. */
function settleLaunches(meta: (mint: string) => any) {
  const cut = Date.now() - 20_000; const keep: Launch[] = [];
  for (const l of pendingLaunches) {
    if (l.t > cut) { keep.push(l); continue; }
    const x = meta(l.m);
    readyLaunches.push({ ...l, tw: x ? !!x.twitter : null, tg: x ? !!x.telegram : null, web: x ? !!x.website : null, descLen: x ? (x.descLen ?? null) : null, meta: !!x });
  }
  pendingLaunches = keep;
}

// ---- market snapshots ----
let readyMarket: any[] = [];
async function solUsd(): Promise<{ usd: number | null; src: string }> {
  const j = (u: string) => fetch(u, { signal: AbortSignal.timeout(3000), headers: { accept: "application/json" } }).then((r) => (r.ok ? r.json() : null)).catch(() => null) as Promise<any>;
  const [cb, kr] = await Promise.all([j("https://api.coinbase.com/v2/prices/SOL-USD/spot"), j("https://api.kraken.com/0/public/Ticker?pair=SOLUSD")]);
  const a = Number(cb?.data?.amount), b = Number(Object.values<any>(kr?.result ?? {})[0]?.c?.[0]); const ok = (x: number) => isFinite(x) && x > 1;
  if (ok(a) && ok(b)) return { usd: +((a + b) / 2).toFixed(3), src: "coinbase+kraken" };
  return ok(a) ? { usd: a, src: "coinbase" } : ok(b) ? { usd: b, src: "kraken" } : { usd: null, src: "none" };
}
export async function marketTick(extra: () => Record<string, unknown>) {
  const p = await solUsd();
  histStat.tradesSeenMin = newTradesThisMin; histStat.launchesMin = launchesThisMin;
  readyMarket.push({ t: Math.floor(Date.now() / 1000), solUsd: p.usd, src: p.src, launchesPerMin: launchesThisMin, newTradesSeenPerMin: newTradesThisMin, ...extra() });
  newTradesThisMin = 0; launchesThisMin = 0;
  if (readyMarket.length > 200) readyMarket.shift();
}

/** Move finished coins/launches into files (one gzip file per kind per batch). Called every 10 min and on shutdown. */
export async function flushHistory(meta: (mint: string) => any, all = false) {
  try {
    const now = Date.now();
    for (const [m, b] of [...coins.entries()]) if (all || now - b.last > QUIET_MS || now - b.first > MAX_AGE_MS) finish(m, b);
    settleLaunches(meta);
    const out: [string, any[], boolean][] = [["coin-trades", readyCoins, true], ["launches", readyLaunches, true], ["market", readyMarket, false]];
    readyCoins = []; readyLaunches = []; readyMarket = []; // Oct 18: taken before the async writes, so rows added meanwhile wait for the next batch
    for (const [kind, rows, gz] of out) {
      if (!rows.length) continue;
      const f = await writeBatch(kind, rows, gz); if (!f) continue;
      histStat.files++; histStat.lastFile = f;
      if (kind === "coin-trades") { histStat.coinsWritten += rows.length; histStat.tradesWritten += rows.reduce((a, r) => a + r.n, 0); }
      else if (kind === "launches") histStat.launchesWritten += rows.length; else histStat.marketWritten += rows.length;
    }
  } catch (e) { histStat.lastError = String((e as Error).message ?? e).slice(0, 120); }
  histStat.buffered = coins.size;
}
