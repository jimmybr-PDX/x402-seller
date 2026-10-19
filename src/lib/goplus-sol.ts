// Keyless GoPlus Solana token security (free tier): LP burn %, closable mint, balance-changing authority, mutable metadata.
// Cached 30 min (failures never cached), 4 s timeout, and callers race it against their own budget so a slow or
// down GoPlus never holds a check: the fetch keeps going in the background and warms the cache for the next call.
const TTL = Number(process.env.GOPLUS_SOL_CACHE_MS ?? 30 * 60_000);
const cache = new Map<string, { at: number; p: Promise<GoPlusSol | null> }>();
export type GoPlusSol = { closable: boolean; balanceMutable: boolean; metadataMutable: boolean; pools: { dex: string; type: string; tvlUsd: number; lpBurnPct: number | null }[] };
export function parseGoPlusSol(r: any): GoPlusSol | null {
  if (!r || typeof r !== "object") return null;
  const on = (x: any) => String(x?.status ?? "0") === "1";
  return { closable: on(r.closable), balanceMutable: on(r.balance_mutable_authority), metadataMutable: on(r.metadata_mutable),
    pools: (Array.isArray(r.dex) ? r.dex : []).map((d: any) => ({ dex: String(d.dex_name ?? ""), type: String(d.type ?? ""), tvlUsd: Number(d.tvl) || 0, lpBurnPct: d.burn_percent == null ? null : Number(d.burn_percent) })) };
}
export let __goplusFetch: (url: string, init: any) => Promise<any> = (u, i) => fetch(u, i);
export function __setGoplusFetch(f: typeof __goplusFetch) { __goplusFetch = f; cache.clear(); }
export function goplusSol(mint: string): Promise<GoPlusSol | null> {
  const h = cache.get(mint);
  if (h && Date.now() - h.at < TTL) return h.p;
  const p = __goplusFetch(`https://api.gopluslabs.io/api/v1/solana/token_security?contract_addresses=${mint}`, { signal: AbortSignal.timeout(4000) })
    .then((r: any) => (r.ok ? r.json() : null)).then((j: any) => parseGoPlusSol(j?.result?.[mint])).catch(() => null);
  cache.set(mint, { at: Date.now(), p });
  p.then((v) => { if (!v) cache.delete(mint); });
  if (cache.size > 3000) cache.delete(cache.keys().next().value!);
  return p;
}
/** Danger checks from GoPlus data (warnings only). LP check only for pools that issue LP tokens (not concentrated/CLMM, not pump.fun). */
export function goplusChecks(g: GoPlusSol): { check: string; points: number; detail: string }[] {
  const out: { check: string; points: number; detail: string }[] = [];
  if (g.balanceMutable) out.push({ check: "balance_mutable", points: 30, detail: "An authority can change holders' balances directly (can take or burn anyone's tokens)." });
  if (g.closable) out.push({ check: "closable", points: 10, detail: "Mint can be closed by an authority (token can be shut down)." });
  if (g.metadataMutable) out.push({ check: "metadata_mutable", points: 3, detail: "Token name/image metadata can still be changed by its update authority." });
  const lp = g.pools.filter((p) => p.lpBurnPct != null && !/concentrated|clmm|dlmm/i.test(p.type) && !/pump/i.test(p.dex)).sort((a, b) => b.tvlUsd - a.tvlUsd)[0];
  if (lp && lp.lpBurnPct! < 50 && lp.tvlUsd >= 1000) out.push({ check: "lp_unlocked", points: lp.lpBurnPct! < 10 ? 15 : 8, detail: `Main ${lp.dex} pool: only ${lp.lpBurnPct!.toFixed(1)}% of LP burned (rest can be pulled).` });
  return out;
}
