/**
 * RugRadar paid-report extras ($0.01 full report, Solana only): live chart pool, dev wallet and sniper/bundle wallet
 * status, biggest buys/sells and a risk summary. Built from data the check already fetched (pump.fun public trades kept
 * in a small per-mint stash) plus at most: 1 market lookup (DexScreener, fallback GeckoTerminal), 1 GeckoTerminal trades
 * call for non-pump coins, and 1 getMultipleAccounts RPC call for balances. Cached 10 min per mint, concurrency capped.
 * A failed or slow lookup omits its block (never an error, never a warning, never a charge). Unlabeled wallets only.
 */
import { rugCheck } from "./rug.js";
import { rpc } from "./solana.js";

const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const WSOL = "So11111111111111111111111111111111111111112";
const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const UA = { "user-agent": "Mozilla/5.0 (RugRadar)", accept: "application/json" };
const CACHE_MS = Number(process.env.RUG_PAID_CACHE_MS ?? 10 * 60_000), BUDGET_MS = Number(process.env.RUG_PAID_BUDGET_MS ?? 4500), MAX_BUSY = 3;
const r2 = (n: unknown, d = 2) => (n == null || n === "" || !isFinite(Number(n)) ? null : +Number(n).toFixed(d));
const j = (u: string, ms = 2500) => fetch(u, { headers: UA, signal: AbortSignal.timeout(ms) }).then((r) => (r.ok ? r.json() : null)).catch(() => null) as Promise<any>;

// ---------- pump.fun trade stash (filled by pumpLaunch, no extra fetches) ----------
export type CTrade = { w: string; k: "buy" | "sell"; sol: number; usd: number | null; amt: number; ts: number; slot: string };
type Stash = { at: number; trades: CTrade[]; complete: boolean };
const stash = new Map<string, Stash>();
export function stashTrades(mint: string, raw: any[], complete: boolean) {
  const trades: CTrade[] = raw.map((t) => ({ w: String(t.userAddress), k: t.type === "sell" ? "sell" : "buy", sol: Number(t.amountSol || 0), usd: t.amountUsd != null ? Number(t.amountUsd) : null, amt: Number(t.baseAmount || 0), ts: Date.parse(t.timestamp), slot: String(t.slotIndexId ?? "").slice(0, 13) } as CTrade)).filter((t) => isFinite(t.ts) && B58.test(t.w));
  stash.delete(mint); stash.set(mint, { at: Date.now(), trades, complete });
  if (stash.size > 60) stash.delete(stash.keys().next().value!);
}
export function __clearPaid() { stash.clear(); cache.clear(); }

// ---------- lookups ----------
async function findPool(mint: string): Promise<string | null> {
  const d = await j(`https://api.dexscreener.com/token-pairs/v1/solana/${mint}`, 3000);
  if (Array.isArray(d) && d.length) {
    const best = [...d].filter((p) => B58.test(String(p?.pairAddress ?? ""))).sort((a, b) => (Number(b.liquidity?.usd) || 0) - (Number(a.liquidity?.usd) || 0))[0];
    if (best) return best.pairAddress;
  }
  const g = await j(`https://api.geckoterminal.com/api/v2/networks/solana/tokens/${mint}/pools?page=1`, 3000);
  const a = g?.data?.[0]?.attributes?.address;
  return typeof a === "string" && B58.test(a) ? a : null;
}
export type Fill = { side: "buy" | "sell"; sol: number | null; usd: number | null; at: string };
async function geckoFills(pool: string): Promise<Fill[] | null> {
  const d = await j(`https://api.geckoterminal.com/api/v2/networks/solana/pools/${pool}/trades`, 3000);
  if (!Array.isArray(d?.data)) return null;
  return d.data.map((x: any): Fill | null => {
    const a = x?.attributes; if (!a || (a.kind !== "buy" && a.kind !== "sell")) return null;
    const sol = a.kind === "buy" ? (a.from_token_address === WSOL ? a.from_token_amount : null) : (a.to_token_address === WSOL ? a.to_token_amount : null);
    const t = Date.parse(a.block_timestamp); if (!isFinite(t)) return null;
    return { side: a.kind, sol: r2(sol, 3), usd: r2(a.volume_in_usd, 2), at: new Date(t).toISOString() };
  }).filter(Boolean) as Fill[];
}
async function ata(owner: string, mint: string, prog: string): Promise<string> {
  const { getProgramDerivedAddress, getAddressEncoder, address } = await import("@solana/kit");
  const e = getAddressEncoder();
  const [pda] = await getProgramDerivedAddress({ programAddress: address(ATA_PROGRAM), seeds: [e.encode(address(owner)), e.encode(address(prog)), e.encode(address(mint))] });
  return pda;
}
/** wallet -> current token balance (ui units); null map when the lookup failed (balances unknown). One RPC call. */
async function balances(wallets: string[], mint: string, token2022: boolean): Promise<Map<string, number> | null> {
  if (!wallets.length) return new Map();
  try {
    const prog = token2022 ? TOKEN_2022 : TOKEN_PROGRAM;
    const addrs = await Promise.all(wallets.map((w) => ata(w, mint, prog)));
    const v: any = await rpc<any>("getMultipleAccounts", [addrs, { encoding: "jsonParsed" }], { timeoutMs: 2500 });
    if (!Array.isArray(v?.value)) return null;
    return new Map(wallets.map((w, i) => [w, Number(v.value[i]?.data?.parsed?.info?.tokenAmount?.uiAmount ?? 0) || 0]));
  } catch { return null; }
}

// ---------- block builders ----------
export type WalletRow = { address: string; holdingPct: number | null; status: "holding" | "sold" | "unknown"; tags?: string[] };
const SOLD_BELOW = 0.05; // sold = holds under 5% of what it bought
export function walletRows(trades: CTrade[], complete: boolean, creator: string | null, supply: number, bal: Map<string, number> | null) {
  const out: { dev: WalletRow[] | null; sn: any | null } = { dev: null, sn: null };
  const amtOf = (xs: CTrade[]) => xs.reduce((a, t) => a + t.amt, 0);
  const net = (w: string) => Math.max(0, trades.filter((t) => t.w === w).reduce((a, t) => a + (t.k === "buy" ? 1 : -1) * t.amt, 0));
  const nowOf = (w: string): number | null => (bal?.has(w) ? bal.get(w)! : complete ? net(w) : null);
  const pct = (n: number | null) => (n == null || !(supply > 0) ? null : r2((n / supply) * 100, 4));
  if (creator) {
    const mine = trades.filter((t) => t.w === creator), bought = amtOf(mine.filter((t) => t.k === "buy")), sells = mine.filter((t) => t.k === "sell").length;
    const now = nowOf(creator);
    if (now != null && (now > 0 || bought > 0 || sells > 0)) out.dev = [{ address: creator, holdingPct: pct(now), status: bought > 0 ? (now < bought * SOLD_BELOW ? "sold" : "holding") : now > 0 ? "holding" : "sold" }];
  }
  if (complete && trades.length && supply > 0) {
    const asc = [...trades].sort((a, b) => a.ts - b.ts), t0 = asc[0]!.ts, slot0 = asc[0]!.slot;
    const buys = asc.filter((t) => t.k === "buy" && t.w !== creator);
    const sniper = new Set(buys.filter((t) => t.ts - t0 <= 10_000).map((t) => t.w)), bundle = new Set(buys.filter((t) => t.slot === slot0).map((t) => t.w));
    const early = buys.filter((t) => t.ts - t0 <= 10_000 || t.slot === slot0);
    const ws = [...new Set(early.map((t) => t.w))];
    if (ws.length) {
      const start = (w: string) => amtOf(early.filter((t) => t.w === w));
      const sorted = ws.sort((a, b) => start(b) - start(a));
      const shown = sorted.slice(0, 10);
      const rows: WalletRow[] = shown.map((w) => { const now = nowOf(w), s = start(w); return { address: w, holdingPct: pct(now), status: now != null && now < s * SOLD_BELOW ? "sold" : "holding", tags: [sniper.has(w) ? "sniper" : "", bundle.has(w) ? "bundle" : ""].filter(Boolean) } as WalletRow; });
      const shownSet = new Set(shown);
      const nowTotal = ws.reduce((a, w) => a + (shownSet.has(w) ? nowOf(w) ?? net(w) : net(w)), 0);
      out.sn = { count: ws.length, snipers: sniper.size, bundled: bundle.size, startPct: pct(amtOf(early)), nowPct: pct(nowTotal), stillHolding: ws.filter((w) => (shownSet.has(w) ? nowOf(w) ?? net(w) : net(w)) >= start(w) * SOLD_BELOW).length, shown: rows };
    }
  }
  return out;
}
function topFills(fills: Fill[], side: "buy" | "sell") {
  return fills.filter((f) => f.side === side && ((f.usd ?? 0) > 0 || (f.sol ?? 0) > 0)).sort((a, b) => (b.usd ?? (b.sol ?? 0) * 150) - (a.usd ?? (a.sol ?? 0) * 150)).slice(0, 5);
}
/** Risk summary from the existing check; unknown stays "unknown", never a warning. */
export function riskBlock(full: any) {
  const f = full?.facts ?? {}, b = full?.buyer ?? {};
  const cs = String(b.canSell ?? ""), sell = cs.startsWith("yes") ? "yes" : cs === "no route found" ? "no" : "unknown";
  return { canSell: sell, canSellVia: cs.startsWith("yes") ? cs.replace(/^yes \(|\)$/g, "") : null, sellImpactPct: typeof b.sellPriceImpactPct === "number" ? b.sellPriceImpactPct : null, taxPct: typeof b.transferFeePct === "number" ? b.transferFeePct : null,
    mintAuthority: "mintAuthority" in f ? (f.mintAuthority ? "on" : "off") : "unknown", freezeAuthority: "freezeAuthority" in f ? (f.freezeAuthority ? "on" : "off") : "unknown", top10Pct: typeof f.top10Pct === "number" ? f.top10Pct : null };
}
export const chartUrl = (pool: string) => `https://www.geckoterminal.com/solana/pools/${pool}?embed=1&info=0&swaps=0&grayscale=0&light_chart=0&chart_type=price&resolution=1m`;

// ---------- build (cached 10 min per mint, concurrency capped, deduped) ----------
const cache = new Map<string, { at: number; p: Promise<any> }>();
let busy = 0;
async function build(mint: string, full: any) {
  const f = full?.facts ?? {}, supply = Number(f.supply) || 0, creator = typeof f.creator === "string" && B58.test(f.creator) ? f.creator : null;
  const st = stash.get(mint) && Date.now() - stash.get(mint)!.at < CACHE_MS ? stash.get(mint)! : null;
  const poolP = findPool(mint).catch(() => null);
  const fillsP: Promise<Fill[] | null> = st?.trades.length ? Promise.resolve(st.trades.map((t) => ({ side: t.k, sol: r2(t.sol, 3), usd: t.usd != null ? r2(t.usd, 2) : null, at: new Date(t.ts).toISOString() }))) : poolP.then((p) => (p ? geckoFills(p) : null)).catch(() => null);
  const wallets = new Set<string>();
  if (creator) wallets.add(creator);
  if (st?.complete) { const pre = walletRows(st.trades, true, creator, supply, null); for (const r of [...(pre.dev ?? []), ...(pre.sn?.shown ?? [])]) wallets.add(r.address); }
  const balP = st ? balances([...wallets], mint, !!f.token2022) : creator ? balances([creator], mint, !!f.token2022) : Promise.resolve(null);
  const [pool, fills, bal] = await Promise.all([poolP, fillsP, balP]);
  const rows = st ? walletRows(st.trades, st.complete, creator, supply, bal) : (creator && bal && (bal.get(creator) ?? 0) > 0 ? { dev: [{ address: creator, holdingPct: supply > 0 ? r2((bal.get(creator)! / supply) * 100, 4) : null, status: "holding" as const }], sn: null } : { dev: null, sn: null });
  return {
    chart: pool ? { pool, embedUrl: chartUrl(pool) } : null,
    devWallets: rows.dev ?? (creator ? [{ address: creator, holdingPct: null, status: "unknown" }] : null), sniperBundle: rows.sn,
    biggestBuys: fills?.length ? topFills(fills, "buy") : null, biggestSells: fills?.length ? topFills(fills, "sell") : null,
    tradesBasis: fills?.length ? (st ? `last ${st.trades.length} trades` : "recent pool trades") : null,
  };
}
export async function liveReport(mint: string, full: any): Promise<Record<string, unknown>> {
  const risk = riskBlock(full), base = { risk, generatedAt: new Date().toISOString() };
  try {
    let h = cache.get(mint);
    if (!h || Date.now() - h.at > CACHE_MS) {
      if (busy >= MAX_BUSY) return base; // capped: omit blocks, never queue or error
      busy++;
      const p = build(mint, full).catch(() => null).finally(() => { busy--; });
      h = { at: Date.now(), p }; cache.set(mint, h); if (cache.size > 300) cache.delete(cache.keys().next().value!);
      p.then((v) => { if (v == null || (!v.chart && !v.devWallets && !v.sniperBundle && !v.biggestBuys)) { if (cache.get(mint) === h) cache.delete(mint); } }); // empty/failed results are not kept
    }
    const got = await Promise.race([h.p, new Promise<null>((r) => setTimeout(() => r(null), BUDGET_MS).unref?.())]);
    return got ? { ...base, ...got } : base;
  } catch { return base; }
}
/** rugCheck + live-report blocks for the paid paths (Solana only; other chains return the existing report unchanged). */
export async function paidRugCheck(token: string, chain: string, opts: { noCache?: boolean } = {}) {
  const out: any = await rugCheck(token, chain, opts);
  if (out?.chain !== "solana" || !out?.facts) return out;
  return { ...out, liveReport: await liveReport(out.token, out) };
}
