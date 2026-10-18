/**
 * PRIVATE paper-test signals (Oct 15). Not used by RugRadar's paid checks or any public API; free data only.
 * Recorded at buy time, always async (never on the sniper's critical path), one coin at a time so live traffic keeps priority.
 *  1. curve: bonding-curve velocity: SOL raised so far, SOL/minute since launch, % of the way to graduation (~85 SOL)
 *  2. fresh: share of the earliest buyers that are fresh wallets (fewer than 10 transactions ever)
 *  3. conc: top-5 buyers' share of buy volume, early (first 30 trades) vs now -> is concentration growing?
 *  4. meta: metadata quality: socials present, X link is a single post (borrowed) vs a profile, image/X link reused by other launches
 *  5. dev: creator track record in our own launch log (launches in the past 24 h, earlier coins that graduated/died) + creator SOL balance
 */
import { address, getAddressEncoder, getProgramDerivedAddress } from "@solana/kit";
const RPC = process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";
const UA = { "user-agent": "Mozilla/5.0 paper-test" };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function rpc(method: string, params: unknown[]): Promise<any> {
  const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(4000) }).catch(() => null);
  return r ? (await r.json().catch(() => null))?.result : null;
}
export type Priv = { at: number; ms: number;
  curve: { solRaised: number; solPerMin: number; pctToGrad: number } | null;
  fresh: { checked: number; freshPct: number } | null;
  conc: { top5EarlyPct: number; top5NowPct: number; growthPts: number } | null;
  meta: { socials: number; xIsPost: boolean | null; imageReused: number; xReused: number } | null;
  dev: { launches24h: number; priorTracked: number; priorGraduated: number; priorDead: number; solBalance: number | null } | null };
const imageSeen = new Map<string, number>(), xSeen = new Map<string, number>();
const bump = (m: Map<string, number>, k: string) => { const v = (m.get(k) ?? 0) + 1; m.set(k, v); if (m.size > 20000) m.delete(m.keys().next().value!); return v - 1; };
/** Called on every new launch with its metadata URI so reuse counts cover all launches, not only the ones we buy. */
const metaCache = new Map<string, any>();
let metaQ: Promise<unknown> = Promise.resolve(); let metaPending = 0;
export function noteLaunchMeta(mint: string, uri: string | undefined) {
  if (!uri || metaPending > 30) return; metaPending++;
  metaQ = metaQ.then(async () => {
    try {
      const u = uri.replace(/^ipfs:\/\//, "https://ipfs.io/ipfs/");
      const j: any = await fetch(u, { headers: UA, signal: AbortSignal.timeout(3000) }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
      if (!j) return;
      const img = String(j.image ?? "").replace(/^https?:\/\/[^/]+\/ipfs\//, "").slice(0, 120);
      const x = String(j.twitter ?? "").toLowerCase().replace(/^https?:\/\/(www\.)?(x|twitter)\.com\//, "").replace(/[?#].*$/, "").slice(0, 120);
      metaCache.set(mint, { twitter: !!(j.twitter && String(j.twitter).length > 3), website: !!(j.website && String(j.website).length > 3), descLen: String(j.description ?? "").length, telegram: !!(j.telegram && String(j.telegram).length > 3), socials: [j.twitter, j.website, j.telegram].filter((v) => v && String(v).length > 3).length, xIsPost: x ? /\/status\//.test(x) : null,
        imageReused: img ? bump(imageSeen, img) : 0, xReused: x ? bump(xSeen, x) : 0 });
      if (metaCache.size > 4000) metaCache.delete(metaCache.keys().next().value!);
    } finally { metaPending--; }
  }).catch(() => {});
}
export const launchMeta = (mint: string) => metaCache.get(mint) ?? null;
let chain: Promise<unknown> = Promise.resolve();
export function privateSignals(mint: string, createdMs: number, creator: string, trades: any[] | null,
  dev: { launches24h: number; priorTracked: number; priorGraduated: number; priorDead: number }): Promise<Priv> {
  const p = chain.then(() => compute(mint, createdMs, creator, trades, dev)); chain = p.catch(() => {}); return p;
}
async function compute(mint: string, createdMs: number, creator: string, trades: any[] | null, devIn: any): Promise<Priv> {
  const t0 = Date.now();
  let curve: Priv["curve"] = null;
  try {
    const [pda] = await getProgramDerivedAddress({ programAddress: address("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"), seeds: ["bonding-curve", getAddressEncoder().encode(address(mint))] });
    const v = await rpc("getAccountInfo", [pda, { encoding: "base64", commitment: "confirmed" }]);
    const b = Buffer.from(v?.value?.data?.[0] ?? "", "base64");
    if (b.length >= 49) { const sol = Number(b.readBigUInt64LE(32)) / 1e9, mins = Math.max(0.25, (Date.now() - createdMs) / 60000);
      curve = { solRaised: +sol.toFixed(2), solPerMin: +(sol / mins).toFixed(2), pctToGrad: b[48] === 1 ? 100 : +Math.min(100, sol / 85 * 100).toFixed(1) }; }
  } catch {}
  let fresh: Priv["fresh"] = null, conc: Priv["conc"] = null;
  if (trades?.length) {
    const old = [...trades].reverse(); // API returns newest first
    const buys = old.filter((t) => t.type === "buy" && t.userAddress !== creator);
    const share = (xs: any[]) => { const m = new Map<string, number>(); let tot = 0; for (const t of xs) { const s = Number(t.amountSol || 0); tot += s; m.set(t.userAddress, (m.get(t.userAddress) ?? 0) + s); }
      return tot > 0 ? [...m.values()].sort((a, b) => b - a).slice(0, 5).reduce((a, v) => a + v, 0) / tot * 100 : 0; };
    if (buys.length >= 5) { const e = share(buys.slice(0, 30)), n = share(buys); conc = { top5EarlyPct: +e.toFixed(1), top5NowPct: +n.toFixed(1), growthPts: +(n - e).toFixed(1) }; }
    const early = [...new Set(buys.map((t) => t.userAddress))].slice(0, 8);
    let f = 0, c = 0;
    for (const w of early) { const s = await rpc("getSignaturesForAddress", [w, { limit: 10 }]); if (Array.isArray(s)) { c++; if (s.length < 10) f++; } await sleep(120); }
    if (c) fresh = { checked: c, freshPct: Math.round(f / c * 100) };
  }
  const bal = creator ? await rpc("getBalance", [creator, { commitment: "confirmed" }]) : null;
  const dev = { ...devIn, solBalance: bal?.value != null ? +(bal.value / 1e9).toFixed(2) : null };
  return { at: Date.now(), ms: Date.now() - t0, curve, fresh, conc, meta: metaCache.get(mint) ?? null, dev };
}
/** Bucket each signal for the scorecard: [label, test] pairs. */
export const PRIV_BUCKETS: [string, string, (p: Priv) => boolean | null][] = [
  ["Curve velocity", "raised under 1 SOL/min", (p) => (p.curve ? p.curve.solPerMin < 1 : null)],
  ["Curve velocity", "1-4 SOL/min", (p) => (p.curve ? p.curve.solPerMin >= 1 && p.curve.solPerMin < 4 : null)],
  ["Curve velocity", "4+ SOL/min", (p) => (p.curve ? p.curve.solPerMin >= 4 : null)],
  ["Fresh early buyers", "under 25% fresh wallets", (p) => (p.fresh ? p.fresh.freshPct < 25 : null)],
  ["Fresh early buyers", "25-60% fresh", (p) => (p.fresh ? p.fresh.freshPct >= 25 && p.fresh.freshPct < 60 : null)],
  ["Fresh early buyers", "60%+ fresh (likely farmed)", (p) => (p.fresh ? p.fresh.freshPct >= 60 : null)],
  ["Top-5 buyer share", "spreading out (falling)", (p) => (p.conc ? p.conc.growthPts < -5 : null)],
  ["Top-5 buyer share", "steady", (p) => (p.conc ? Math.abs(p.conc.growthPts) <= 5 : null)],
  ["Top-5 buyer share", "concentrating (rising)", (p) => (p.conc ? p.conc.growthPts > 5 : null)],
  ["Metadata", "no socials", (p) => (p.meta ? p.meta.socials === 0 : null)],
  ["Metadata", "X link is someone's post", (p) => (p.meta ? p.meta.xIsPost === true : null)],
  ["Metadata", "image or X link reused", (p) => (p.meta ? p.meta.imageReused > 0 || p.meta.xReused > 0 : null)],
  ["Metadata", "own socials, nothing reused", (p) => (p.meta ? p.meta.socials > 0 && !p.meta.xIsPost && !p.meta.imageReused && !p.meta.xReused : null)],
  ["Dev record", "3+ launches in 24 h", (p) => (p.dev ? p.dev.launches24h >= 3 : null)],
  ["Dev record", "earlier coin died", (p) => (p.dev ? p.dev.priorDead > 0 : null)],
  ["Dev record", "first launch we've seen", (p) => (p.dev ? p.dev.priorTracked === 0 && p.dev.launches24h <= 1 : null)],
  ["Dev record", "dev wallet under 1 SOL", (p) => (p.dev?.solBalance != null ? p.dev.solBalance < 1 : null)],
];
