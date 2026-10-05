/**
 * Onchain Solana token price: reads Orca Whirlpool and Raydium CLMM pool accounts straight from
 * public Solana RPC nodes (no third-party price API). Pools are found by deterministic PDA
 * derivation (mint pair + fee tier), priced from sqrt_price, and weighted by quote-side vault
 * depth. Every number is verifiable from the returned pool addresses and slot. Cached 30 s.
 */
import { address as toAddress, getAddressEncoder, getProgramDerivedAddress, type Address } from "@solana/kit";

const RPCS = (process.env.SOLANA_RPC_URLS?.split(",").map((s) => s.trim()).filter(Boolean)) ?? [
  "https://api.mainnet-beta.solana.com",
  "https://solana-rpc.publicnode.com",
];
// An endpoint that errors or rate-limits is skipped for 2 minutes (unless every endpoint is down).
const badUntil = new Map<string, number>();
const ORCA = "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc";
const ORCA_CONFIG = "2LecshUwdy9xi7meFgHtFJQNSKk4KdTrcpvaB56dP2NQ";
const ORCA_TICK_SPACINGS = [1, 2, 4, 8, 16, 64, 96, 128, 256];
const RAYDIUM_CLMM = "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK";
const RAYDIUM_CONFIG_INDEXES = Array.from({ length: 21 }, (_, i) => i); // amm_config 0..20 exist onchain
const PUMP = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"; // pump.fun bonding curves
const PUMPSWAP = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA"; // pump.fun AMM (graduated tokens)
const METADATA_PROGRAM = "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s";

export const WSOL = "So11111111111111111111111111111111111111112";
export const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const USDT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";

/** Curated symbols -> mint (each verified against onchain Metaplex metadata in tests). */
export const SOL_SYMBOLS: Record<string, string> = {
  SOL: WSOL,
  WSOL: WSOL,
  USDC,
  USDT,
  JUP: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN",
  BONK: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
  WIF: "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm",
  JTO: "jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL",
  PYTH: "HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3",
  RAY: "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R",
  ORCA: "orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE",
  MSOL: "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So",
  JITOSOL: "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn",
  TRUMP: "6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN",
  RENDER: "rndrizKT3MK1iimdxRdWabcF7Zg7AR5T4nud4EkHBof",
  W: "85VBFQZC9TZkfaptBWjvUw7YbZjy52A6mjtPGjstQAmQ",
  PENGU: "2zMMhcVQEXDtdE6vsFS7S7D5oUodfJHE8vd1gnBouauv",
  FARTCOIN: "9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump",
  CBBTC: "cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij",
};

export class SolanaInputError extends Error {}

let rpcId = 0;
type RpcOpts = { timeoutMs?: number; nullIsMiss?: boolean };
export async function rpc<T>(method: string, params: unknown[], opts: RpcOpts = {}): Promise<T> {
  try {
    return await rpcOnce<T>(method, params, false, opts);
  } catch (e) {
    // Public nodes rate-limit bursts (HTTP 429); one short pause usually clears it.
    await new Promise((r) => setTimeout(r, 1200));
    return rpcOnce<T>(method, params, true, opts);
  }
}
async function rpcOnce<T>(method: string, params: unknown[], all = false, opts: RpcOpts = {}): Promise<T> {
  let sawNull = false;
  let last: unknown;
  const healthy = RPCS.filter((u) => (badUntil.get(u) ?? 0) < Date.now());
  for (const url of all || !healthy.length ? RPCS : healthy) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 4000),
      });
      if (!res.ok) throw new Error(`rpc ${res.status}`);
      const j: any = await res.json();
      if (j.error) throw new Error(j.error.message ?? "rpc error");
      // Some nodes keep little history: for lookups, a null answer means "ask the next node".
      if (opts.nullIsMiss && j.result == null) {
        sawNull = true;
        continue;
      }
      return j.result as T;
    } catch (e) {
      last = e;
      badUntil.set(url, Date.now() + 30_000);
    }
  }
  if (sawNull) return null as T;
  throw last instanceof Error ? last : new Error("solana rpc unavailable");
}

type Acct = { data: Buffer; owner: string } | null;
async function accounts(keys: string[]): Promise<{ slot: number; list: Acct[] }> {
  const out: Acct[] = [];
  let slot = 0;
  for (let i = 0; i < keys.length; i += 100) {
    const r = await rpc<any>("getMultipleAccounts", [keys.slice(i, i + 100), { encoding: "base64", commitment: "confirmed" }]);
    slot = Math.max(slot, r.context?.slot ?? 0);
    for (const v of r.value as any[]) out.push(v ? { data: Buffer.from(v.data[0], "base64"), owner: v.owner } : null);
  }
  return { slot, list: out };
}

const enc = getAddressEncoder();
const bytes = (a: string) => Buffer.from(enc.encode(toAddress(a)));
const b58 = (buf: Buffer, off: number) => {
  // Decode a 32-byte pubkey at `off` back to base58 via the codec (encode's inverse).
  return addrDecoder(buf.subarray(off, off + 32));
};
import { getAddressDecoder } from "@solana/kit";
const dec = getAddressDecoder();
const addrDecoder = (b: Uint8Array) => dec.decode(b) as string;
const u128 = (buf: Buffer, off: number) => buf.readBigUInt64LE(off) + (buf.readBigUInt64LE(off + 8) << 64n);
const cmpMints = (a: string, b: string) => Buffer.compare(bytes(a), bytes(b));

async function pda(program: string, seeds: (string | Buffer)[]): Promise<string> {
  const [a] = await getProgramDerivedAddress({ programAddress: program as Address, seeds: seeds.map((s) => (typeof s === "string" ? Buffer.from(s) : s)) });
  return a as string;
}

let raydiumConfigs: Promise<string[]> | null = null;
function raydiumConfigPdas(): Promise<string[]> {
  raydiumConfigs ??= Promise.all(
    RAYDIUM_CONFIG_INDEXES.map((i) => {
      const b = Buffer.alloc(2);
      b.writeUInt16BE(i);
      return pda(RAYDIUM_CLMM, ["amm_config", b]);
    }),
  );
  return raydiumConfigs;
}

type Cand = { dex: "orca-whirlpool" | "raydium-clmm" | "pumpswap" | "pumpfun-curve"; pool: string; quote: string };
async function candidatePools(mint: string, quotes: { mint: string; sym: string }[]): Promise<Cand[]> {
  const cfgs = await raydiumConfigPdas();
  const jobs: Promise<Cand>[] = [];
  for (const q of quotes) {
    const [a, b] = cmpMints(mint, q.mint) < 0 ? [mint, q.mint] : [q.mint, mint];
    for (const ts of ORCA_TICK_SPACINGS) {
      const t = Buffer.alloc(2);
      t.writeUInt16LE(ts);
      jobs.push(pda(ORCA, ["whirlpool", bytes(ORCA_CONFIG), bytes(a), bytes(b), t]).then((pool) => ({ dex: "orca-whirlpool" as const, pool, quote: q.sym })));
    }
    for (const c of cfgs) jobs.push(pda(RAYDIUM_CLMM, ["pool", bytes(c), bytes(a), bytes(b)]).then((pool) => ({ dex: "raydium-clmm" as const, pool, quote: q.sym })));
    if (q.sym === "SOL") {
      // pump.fun: the canonical PumpSwap pool (index 0, creator = pool-authority PDA) and the bonding curve.
      const idx = Buffer.alloc(2);
      jobs.push(
        pda(PUMP, ["pool-authority", bytes(mint)]).then((creator) =>
          pda(PUMPSWAP, ["pool", idx, bytes(creator), bytes(mint), bytes(WSOL)]).then((pool) => ({ dex: "pumpswap" as const, pool, quote: "SOL" })),
        ),
      );
      jobs.push(pda(PUMP, ["bonding-curve", bytes(mint)]).then((pool) => ({ dex: "pumpfun-curve" as const, pool, quote: "SOL" })));
    }
  }
  return Promise.all(jobs);
}

type Quote = { dex: string; pool: string; quote: string; priceUsd: number; depthUsd: number };

async function poolQuotes(mint: string, solUsdP: Promise<number | null> | null, withMeta = false) {
  const quotes = [
    { mint: USDC, sym: "USDC", usd: 1 as number | null },
    { mint: USDT, sym: "USDT", usd: 1 as number | null },
    ...(solUsdP ? [{ mint: WSOL, sym: "SOL", usd: null as number | null }] : []),
  ].filter((q) => q.mint !== mint);
  const cands = await candidatePools(mint, quotes);
  const metaKey = withMeta ? await pda(METADATA_PROGRAM, ["metadata", bytes(METADATA_PROGRAM), bytes(mint)]) : null;
  const { slot, list: all } = await accounts([...cands.map((c) => c.pool), ...(metaKey ? [metaKey] : [])]);
  const meta = metaKey ? parseMetadata(all[all.length - 1]?.data) : { name: null, symbol: null };
  const list = all.slice(0, cands.length);
  type Live = Cand & { mintA: string; mintB: string; vaultA: string; vaultB: string; sqrt: bigint; decA?: number; decB?: number; cp?: boolean };
  const live: Live[] = [];
  const curves: { pool: string; vSol: number; vTok: number; realSol: number }[] = [];
  list.forEach((acc, i) => {
    const c = cands[i]!;
    if (!acc) return;
    const d = acc.data;
    if (c.dex === "orca-whirlpool" && acc.owner === ORCA && d.length >= 245) {
      live.push({ ...c, sqrt: u128(d, 65), mintA: b58(d, 101), vaultA: b58(d, 133), mintB: b58(d, 181), vaultB: b58(d, 213) });
    } else if (c.dex === "raydium-clmm" && acc.owner === RAYDIUM_CLMM && d.length >= 269) {
      live.push({ ...c, mintA: b58(d, 73), mintB: b58(d, 105), vaultA: b58(d, 137), vaultB: b58(d, 169), decA: d[233], decB: d[234], sqrt: u128(d, 253) });
    } else if (c.dex === "pumpswap" && acc.owner === PUMPSWAP && d.length >= 203) {
      live.push({ ...c, mintA: b58(d, 43), mintB: b58(d, 75), vaultA: b58(d, 139), vaultB: b58(d, 171), sqrt: 0n, cp: true });
    } else if (c.dex === "pumpfun-curve" && acc.owner === PUMP && d.length >= 49 && d[48] === 0) {
      curves.push({ pool: c.pool, vTok: Number(d.readBigUInt64LE(8)), vSol: Number(d.readBigUInt64LE(16)), realSol: Number(d.readBigUInt64LE(32)) });
    }
  });
  if (!live.length && !curves.length) {
    const m = await accounts([mint]); // still report decimals so "no pool" and "not a mint" differ
    const md = m.list[0];
    if (!meta.symbol) Object.assign(meta, parseToken2022Meta(md?.data));
    return { slot, quotes: [] as Quote[], decimals: md && md.data.length >= 45 && md.data.length < 400 ? md.data[44]! : (md && md.data.length >= 45 ? md.data[44]! : null), meta };
  }
  const extra = [...new Set([mint, ...quotes.map((q) => q.mint)])];
  const [r2, solUsd] = await Promise.all([accounts([...live.flatMap((l) => [l.vaultA, l.vaultB]), ...extra]), solUsdP ?? Promise.resolve(null)]);
  for (const q of quotes) if (q.sym === "SOL") q.usd = solUsd;
  const mintDec = new Map<string, number>();
  extra.forEach((m, i) => {
    const a = r2.list[live.length * 2 + i];
    if (a && a.data.length >= 45) mintDec.set(m, a.data[44]!);
    if (m === mint && !meta.symbol) Object.assign(meta, parseToken2022Meta(a?.data));
  });
  const out: Quote[] = [];
  live.forEach((l, i) => {
    const va = r2.list[i * 2];
    const vb = r2.list[i * 2 + 1];
    if (!va || !vb || (l.sqrt === 0n && !l.cp)) return;
    const decA = l.decA ?? mintDec.get(l.mintA);
    const decB = l.decB ?? mintDec.get(l.mintB);
    if (decA === undefined || decB === undefined) return;
    const amtA = Number(va.data.readBigUInt64LE(64)) / 10 ** decA;
    const amtB = Number(vb.data.readBigUInt64LE(64)) / 10 ** decB;
    const sq = Number(l.sqrt) / 2 ** 64;
    const bPerA = l.cp ? amtB / amtA : sq * sq * 10 ** (decA - decB); // constant-product pools: reserve ratio
    const tokenIsA = l.mintA === mint;
    const q = quotes.find((x) => x.sym === l.quote)!;
    if (q.usd === null) return;
    const tokenInQuote = tokenIsA ? bPerA : 1 / bPerA;
    const priceUsd = tokenInQuote * q.usd!;
    const tokenUnits = tokenIsA ? amtA : amtB;
    const quoteUnits = tokenIsA ? amtB : amtA;
    if (!(tokenUnits > 0) || !Number.isFinite(priceUsd) || priceUsd <= 0) return;
    out.push({ dex: l.dex, pool: l.pool, quote: l.quote, priceUsd, depthUsd: 2 * quoteUnits * q.usd! });
  });
  const sq = quotes.find((x) => x.sym === "SOL");
  const dec = mintDec.get(mint);
  for (const c of curves) {
    if (!sq?.usd || dec === undefined || !c.vTok) continue;
    const priceUsd = (c.vSol / 1e9 / (c.vTok / 10 ** dec)) * sq.usd;
    if (Number.isFinite(priceUsd) && priceUsd > 0) out.push({ dex: "pumpfun-curve", pool: c.pool, quote: "SOL", priceUsd, depthUsd: 2 * (c.realSol / 1e9) * sq.usd });
  }
  return { slot, quotes: out, decimals: dec ?? null, meta };
}

function weighted(qs: Quote[]): number {
  const best = qs.reduce((a, b) => (b.depthUsd > a.depthUsd ? b : a));
  const near = qs.filter((q) => Math.abs(q.priceUsd / best.priceUsd - 1) <= 0.03);
  const w = near.reduce((a, q) => a + q.depthUsd, 0);
  return near.reduce((a, q) => a + q.priceUsd * q.depthUsd, 0) / w;
}
const sig = (n: number) => Number(n.toPrecision(n >= 1 ? 8 : 6));
const MIN_DEPTH_USD = 5_000; // below $25k the result is flagged thinLiquidity + low confidence
const THIN_DEPTH_USD = 25_000;

let solCache: { at: number; usd: number } | null = null;
async function solUsd(): Promise<number | null> {
  if (solCache && Date.now() - solCache.at < 30_000) return solCache.usd;
  const r = await poolQuotes(WSOL, null);
  const deep = r.quotes.filter((q) => q.depthUsd >= 1_000_000);
  if (!deep.length) return null;
  solCache = { at: Date.now(), usd: weighted(deep) };
  return solCache.usd;
}

/** Token-2022 mints can carry name/symbol in a TokenMetadata extension (TLV type 19). */
function parseToken2022Meta(d: Buffer | undefined): { name: string | null; symbol: string | null } {
  try {
    if (!d || d.length <= 170 || d[165] !== 1) return { name: null, symbol: null };
    let off = 166;
    while (off + 4 <= d.length) {
      const type = d.readUInt16LE(off);
      const len = d.readUInt16LE(off + 2);
      if (type === 19) {
        let p = off + 4 + 64;
        const str = () => {
          const n = d.readUInt32LE(p);
          const v = d.subarray(p + 4, p + 4 + n).toString("utf8").trim();
          p += 4 + n;
          return v || null;
        };
        const name = str();
        return { name, symbol: str() };
      }
      if (type === 0 && len === 0) break;
      off += 4 + len;
    }
  } catch {
    /* ignore */
  }
  return { name: null, symbol: null };
}

function parseMetadata(d: Buffer | undefined): { name: string | null; symbol: string | null } {
  try {
    if (!d || d.length < 100) return { name: null, symbol: null };
    let off = 1 + 32 + 32;
    const str = () => {
      const len = d.readUInt32LE(off);
      const s = d.subarray(off + 4, off + 4 + len).toString("utf8").replace(/\0+$/g, "").trim();
      off += 4 + len;
      return s || null;
    };
    const name = str();
    const symbol = str();
    return { name, symbol };
  } catch {
    return { name: null, symbol: null };
  }
}

const cache = new Map<string, { at: number; value: any }>();

export async function solanaTokenPrice(tokenRaw: string) {
  const started = Date.now();
  const t = tokenRaw.trim();
  let mint: string;
  const sym = t.toUpperCase().replace(/^\$/, "");
  if (SOL_SYMBOLS[sym]) mint = SOL_SYMBOLS[sym]!;
  else if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(t)) {
    try {
      toAddress(t);
    } catch {
      throw new SolanaInputError("token is not a valid Solana mint address");
    }
    mint = t;
  } else throw new SolanaInputError(`unknown_symbol: ${sym}. Pass the SPL mint address instead (symbols: ${Object.keys(SOL_SYMBOLS).join(", ")})`);

  const hit = cache.get(mint);
  if (hit && Date.now() - hit.at < 30_000) return { ...hit.value, cached: true, latencyMs: Date.now() - started };

  const isSol = mint === WSOL;
  const solP = isSol ? null : solUsd().catch(() => null);
  const [r, sol] = await Promise.all([poolQuotes(mint, solP, true), solP ?? Promise.resolve(null)]);
  const meta = r.meta;
  if (r.decimals === null) return { error: "not_a_token_mint" as const, message: `No SPL token mint at ${mint}` };
  // A pre-graduation pump.fun bonding curve is priced by formula, so a smaller floor applies (flagged low confidence).
  const deep = r.quotes.filter((q) => q.depthUsd >= (q.dex === "pumpfun-curve" ? 2_000 : MIN_DEPTH_USD));
  if (!deep.length) {
    return {
      error: "insufficient_onchain_liquidity" as const,
      message: `No Orca Whirlpool, Raydium CLMM or PumpSwap pool for ${meta.symbol ?? mint} with >= $${MIN_DEPTH_USD.toLocaleString()} depth against USDC/USDT/SOL (Raydium AMM v4 and Meteora pools are not covered yet)`,
      poolsSeen: r.quotes.length,
    };
  }
  const priceUsd = weighted(deep);
  const best = deep.reduce((a, b) => (b.depthUsd > a.depthUsd ? b : a));
  const used = deep.filter((q) => Math.abs(q.priceUsd / best.priceUsd - 1) <= 0.03);
  const outlierPools = deep.length - used.length;
  const spread = used.length > 1 ? Math.max(...used.map((q) => q.priceUsd)) / Math.min(...used.map((q) => q.priceUsd)) - 1 : 0;
  const value = {
    token: { symbol: meta.symbol ?? (SOL_SYMBOLS[sym] ? sym : null), name: meta.name, mint, decimals: r.decimals, chain: "solana" },
    priceUsd: sig(priceUsd),
    ...(best.depthUsd < THIN_DEPTH_USD ? { thinLiquidity: true } : {}),
    confidence: best.dex === "pumpfun-curve" || best.depthUsd < THIN_DEPTH_USD ? "low" : spread <= 0.01 && best.depthUsd >= 1_000_000 ? "high" : spread <= 0.03 && best.depthUsd >= 100_000 ? "medium" : "low",
    ...(best.dex === "pumpfun-curve" ? { note: "pump.fun bonding curve (token has not graduated to an AMM yet); price follows the curve formula" } : {}),
    poolSpreadPct: Math.round(spread * 10000) / 100,
    outlierPools,
    totalDepthUsd: Math.round(used.reduce((a, q) => a + q.depthUsd, 0)),
    pools: used
      .sort((a, b) => b.depthUsd - a.depthUsd)
      .slice(0, 5)
      .map((q) => ({ dex: q.dex, pool: q.pool, quote: q.quote, priceUsd: sig(q.priceUsd), depthUsd: Math.round(q.depthUsd), explorer: `https://solscan.io/account/${q.pool}` })),
    change24hPct: null,
    change24hNote: "not available for Solana (public RPC keeps no historical account state)",
    ...(sol ? { solUsd: sig(sol) } : {}),
    slot: r.slot,
    method: "Orca Whirlpool + Raydium CLMM sqrt_price, PumpSwap reserves and pump.fun bonding curves read from public Solana RPC; depth-weighted across pools within 3% of the deepest; USDC/USDT treated as $1",
    generatedAt: new Date().toISOString(),
  };
  cache.set(mint, { at: Date.now(), value });
  if (cache.size > 2000) cache.delete(cache.keys().next().value!);
  return { ...value, cached: false, latencyMs: Date.now() - started };
}
export const SOLANA_PRICE_SYMBOLS = Object.keys(SOL_SYMBOLS);
