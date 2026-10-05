/**
 * Onchain token price: Uniswap v3 spot prices read directly from public RPC nodes
 * (Ethereum, Base, Arbitrum, Polygon). No third-party price API, so no data-licensing
 * restrictions: every number is public chain state, verifiable from the returned
 * pool addresses and block number. Cached 30 s per token.
 */
import { createPublicClient, fallback, http, getAddress, isAddress, parseAbi, type Address, type PublicClient } from "viem";
import { arbitrum, base, mainnet, polygon } from "viem/chains";
import { SOL_SYMBOLS, SolanaInputError, solanaTokenPrice } from "./solana.js";

export type ChainKey = "ethereum" | "base" | "arbitrum" | "polygon";
type ChainCfg = { chain: any; rpcs: string[]; factory: Address; usdc: Address; usdt?: Address; weth: Address; explorer: string };

export const CHAINS: Record<ChainKey, ChainCfg> = {
  ethereum: {
    chain: mainnet,
    rpcs: ["https://ethereum-rpc.publicnode.com", "https://eth.drpc.org", "https://eth-pokt.nodies.app"],
    factory: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
    usdc: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    usdt: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
    weth: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
    explorer: "https://etherscan.io/address/",
  },
  base: {
    chain: base,
    rpcs: ["https://base-rpc.publicnode.com", "https://mainnet.base.org"],
    factory: "0x33128a8fC17869897dcE68Ed026d694621f6FDfD",
    usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    weth: "0x4200000000000000000000000000000000000006",
    explorer: "https://basescan.org/address/",
  },
  arbitrum: {
    chain: arbitrum,
    rpcs: ["https://arbitrum-one-rpc.publicnode.com", "https://arb1.arbitrum.io/rpc"],
    factory: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
    usdc: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    usdt: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9",
    weth: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
    explorer: "https://arbiscan.io/address/",
  },
  polygon: {
    chain: polygon,
    rpcs: ["https://polygon-bor-rpc.publicnode.com", "https://polygon.drpc.org"],
    factory: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
    usdc: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
    usdt: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
    weth: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619",
    explorer: "https://polygonscan.com/address/",
  },
};

/** Curated symbols -> deepest-liquidity ERC-20 (verified onchain via symbol()). */
const SYMBOLS: Record<string, { chain: ChainKey; address: Address; note?: string }> = {
  ETH: { chain: "ethereum", address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", note: "priced as WETH" },
  WETH: { chain: "ethereum", address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2" },
  BTC: { chain: "ethereum", address: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599", note: "priced as WBTC" },
  WBTC: { chain: "ethereum", address: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599" },
  CBBTC: { chain: "base", address: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf" },
  USDC: { chain: "ethereum", address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" },
  USDT: { chain: "ethereum", address: "0xdAC17F958D2ee523a2206206994597C13D831ec7" },
  DAI: { chain: "ethereum", address: "0x6B175474E89094C44Da98b954EedeAC495271d0F" },
  LINK: { chain: "ethereum", address: "0x514910771AF9Ca656af840dff83E8264EcF986CA" },
  UNI: { chain: "ethereum", address: "0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984" },
  AAVE: { chain: "ethereum", address: "0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9" },
  PEPE: { chain: "ethereum", address: "0x6982508145454Ce325dDbE47a25d4ec3d2311933" },
  SHIB: { chain: "ethereum", address: "0x95aD61b0a150d79219dCF64E1E6Cc01f0B64C4cE" },
  MKR: { chain: "ethereum", address: "0x9f8F72aA9304c8B593d555F12eF6589cC3A579A2" },
  LDO: { chain: "ethereum", address: "0x5A98FcBEA516Cf06857215779Fd812CA3beF1B32" },
  ENA: { chain: "ethereum", address: "0x57e114B691Db790C35207b2e685D4A43181e6061" },
  ONDO: { chain: "ethereum", address: "0xfAbA6f8e4a5E8Ab82F62fe7C39859FA577269BE3" },
  WLD: { chain: "ethereum", address: "0x163f8C2467924be0ae7B5347228CabF260318753" },
  CRV: { chain: "ethereum", address: "0xD533a949740bb3306d119CC777fa900bA034cd52" },
  POL: { chain: "ethereum", address: "0x455e53CBB86018Ac2B8092FdCd39d8444aFFC3F6" },
  ARB: { chain: "arbitrum", address: "0x912CE59144191C1204E64559FE8253a0e49E6548" },
  GMX: { chain: "arbitrum", address: "0xfc5A1A6EB076a2C7aD06eD22C90d7E710E35ad0a" },
  AERO: { chain: "base", address: "0x940181a94A35A4569E4529A3CDfB74e38FD98631", note: "most AERO liquidity is on Aerodrome; Uniswap pools may be thinner" },
  DEGEN: { chain: "base", address: "0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed" },
  BRETT: { chain: "base", address: "0x532f27101965dd16442E59d40670FaF5eBB142E4" },
  VIRTUAL: { chain: "base", address: "0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b" },
};
const NON_EVM = new Set(["XRP", "ADA", "DOGE", "TRX", "TON", "DOT", "AVAX", "BNB", "LTC", "BCH", "XLM", "ATOM", "NEAR", "APT", "SUI", "HBAR", "XMR", "ALGO", "SEI", "CSPR", "TAO"]);

const FEES = [100, 500, 3000, 10000] as const;
const MIN_DEPTH_USD = 25_000;
const factoryAbi = parseAbi(["function getPool(address,address,uint24) view returns (address)"]);
const poolAbi = parseAbi([
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)",
  "function observe(uint32[] secondsAgos) view returns (int56[] tickCumulatives, uint160[] secondsPerLiquidityCumulativeX128s)",
]);
// Free public nodes that serve historical state (archive), used when a pool's onchain oracle
// doesn't reach back 24 h. Block counts per day are approximate; the real block time is reported.
const ARCHIVE: Record<string, string[]> = {
  ethereum: ["https://eth.drpc.org", "https://eth-pokt.nodies.app"],
  base: ["https://mainnet.base.org", "https://base.drpc.org"],
  arbitrum: ["https://arbitrum-one.public.blastapi.io", "https://arb-pokt.nodies.app"],
  polygon: ["https://polygon.drpc.org"],
};
const BLOCKS_PER_DAY: Record<string, bigint> = { ethereum: 7200n, base: 43200n, arbitrum: 345600n, polygon: 43200n };
const erc20Abi = parseAbi([
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function name() view returns (string)",
  "function balanceOf(address) view returns (uint256)",
]);
const ZERO = "0x0000000000000000000000000000000000000000";

const clients = new Map<ChainKey, PublicClient>();
export function client(k: ChainKey): PublicClient {
  let c = clients.get(k);
  if (!c) {
    const cfg = CHAINS[k];
    c = createPublicClient({
      chain: cfg.chain,
      transport: fallback(cfg.rpcs.map((u) => http(u, { timeout: 6000, retryCount: 1 }))),
      batch: { multicall: true },
    }) as unknown as PublicClient;
    clients.set(k, c);
  }
  return c;
}

export class PriceInputError extends Error {}

const cache = new Map<string, { at: number; value: any }>();
const TTL = 30_000;

type PoolQuote = { pool: Address; feeTier: number; quote: string; priceUsd: number; depthUsd: number; tokenIs0: boolean; d0: number; d1: number; quoteUsd: number };

/** Raw Uniswap v3 quotes for `token` against USDC/USDT/WETH on one chain. */
async function poolQuotes(k: ChainKey, token: Address, tokenDec: number, wethUsd: number | null) {
  const cfg = CHAINS[k];
  const c = client(k);
  const quotes: { addr: Address; sym: string; usd: number | null; dec: number }[] = [
    { addr: cfg.usdc, sym: "USDC", usd: 1, dec: 6 },
    ...(cfg.usdt ? [{ addr: cfg.usdt, sym: "USDT", usd: 1, dec: 6 }] : []),
    { addr: cfg.weth, sym: "WETH", usd: wethUsd, dec: 18 },
  ].filter((q) => q.addr.toLowerCase() !== token.toLowerCase() && q.usd !== null);
  const combos = quotes.flatMap((q) => FEES.map((fee) => ({ q, fee })));
  const pools = await c.multicall({
    contracts: combos.map(({ q, fee }) => ({ address: cfg.factory, abi: factoryAbi, functionName: "getPool", args: [token, q.addr, fee] })),
    allowFailure: true,
  });
  const live = combos
    .map((cmb, i) => ({ ...cmb, pool: (pools[i]?.status === "success" ? pools[i]!.result : ZERO) as Address }))
    .filter((x) => x.pool !== ZERO);
  if (!live.length) return [];
  const reads = await c.multicall({
    contracts: live.flatMap((x) => [
      { address: x.pool, abi: poolAbi, functionName: "slot0" },
      { address: token, abi: erc20Abi, functionName: "balanceOf", args: [x.pool] },
      { address: x.q.addr, abi: erc20Abi, functionName: "balanceOf", args: [x.pool] },
    ]),
    allowFailure: true,
  });
  const out: PoolQuote[] = [];
  live.forEach((x, i) => {
    const s0 = reads[i * 3];
    const bt = reads[i * 3 + 1];
    const bq = reads[i * 3 + 2];
    if (s0?.status !== "success" || bt?.status !== "success" || bq?.status !== "success") return;
    const sqrt = (s0.result as any)[0] as bigint;
    if (sqrt === 0n) return;
    const tokenIs0 = token.toLowerCase() < x.q.addr.toLowerCase();
    const [d0, d1] = tokenIs0 ? [tokenDec, x.q.dec] : [x.q.dec, tokenDec];
    const sq = Number(sqrt) / 2 ** 96;
    const p1per0 = sq * sq * 10 ** (d0 - d1); // token1 per token0, human units
    const tokenInQuote = tokenIs0 ? p1per0 : 1 / p1per0;
    const priceUsd = tokenInQuote * x.q.usd!;
    // Depth = quote-side reserves x2. Valuing the token side at the pool's own price would let a
    // junk/out-of-range pool with a wild price look "deep"; quote reserves can't be faked that way.
    const quoteUsd = (Number(bq.result as unknown as bigint) / 10 ** x.q.dec) * x.q.usd!;
    const tokenUnits = Number(bt.result as unknown as bigint) / 10 ** tokenDec;
    if (tokenUnits <= 0) return;
    const depthUsd = 2 * quoteUsd;
    if (Number.isFinite(priceUsd) && priceUsd > 0) out.push({ pool: x.pool, feeTier: x.fee, quote: x.q.sym, priceUsd, depthUsd, tokenIs0, d0, d1, quoteUsd: x.q.usd! });
  });
  return out;
}

const wethCache = new Map<ChainKey, { at: number; usd: number; best: PoolQuote }>();
export async function wethUsd(k: ChainKey): Promise<number | null> {
  const hit = wethCache.get(k);
  if (hit && Date.now() - hit.at < TTL) return hit.usd;
  const qs = (await poolQuotes(k, CHAINS[k].weth, 18, null)).filter((q) => q.depthUsd >= 1_000_000);
  if (!qs.length) return null;
  const usd = weighted(qs);
  wethCache.set(k, { at: Date.now(), usd, best: qs.reduce((a, b) => (b.depthUsd > a.depthUsd ? b : a)) });
  return usd;
}

/** Token price in quote units ~24 h ago for one pool: Uniswap v3 oracle first, archive node second. */
const agoCache = new Map<string, { at: number; v: { tokenInQuote: number; at: string; method: string } | null }>();
async function tokenInQuoteAgo(k: ChainKey, q: PoolQuote): Promise<{ tokenInQuote: number; at: string; method: string } | null> {
  const key = `${k}:${q.pool}:${q.tokenIs0}`;
  const hit = agoCache.get(key);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.v;
  const toTokenInQuote = (p1per0: number) => (q.tokenIs0 ? p1per0 : 1 / p1per0);
  let v: { tokenInQuote: number; at: string; method: string } | null = null;
  try {
    const r = (await client(k).readContract({ address: q.pool, abi: poolAbi, functionName: "observe", args: [[86400, 86100]] })) as unknown as [bigint[], bigint[]];
    const avgTick = Number(r[0][1]! - r[0][0]!) / 300;
    v = { tokenInQuote: toTokenInQuote(1.0001 ** avgTick * 10 ** (q.d0 - q.d1)), at: new Date(Date.now() - 86_250_000).toISOString(), method: "uniswap-v3-oracle (5-min TWAP ending ~24h ago)" };
  } catch {
    for (const url of ARCHIVE[k] ?? []) {
      try {
        const c = createPublicClient({ chain: CHAINS[k].chain, transport: http(url, { timeout: 6000, retryCount: 0 }) });
        const head = await client(k).getBlockNumber();
        const bn = head - BLOCKS_PER_DAY[k]!;
        const [s0, blk] = await Promise.all([c.readContract({ address: q.pool, abi: poolAbi, functionName: "slot0", blockNumber: bn }), c.getBlock({ blockNumber: bn })]);
        const sq = Number((s0 as any)[0] as bigint) / 2 ** 96;
        if (!sq) continue;
        v = { tokenInQuote: toTokenInQuote(sq * sq * 10 ** (q.d0 - q.d1)), at: new Date(Number(blk.timestamp) * 1000).toISOString(), method: `archive slot0 at block ${bn}` };
        break;
      } catch {
        /* try next archive node */
      }
    }
  }
  agoCache.set(key, { at: Date.now(), v });
  if (agoCache.size > 2000) agoCache.delete(agoCache.keys().next().value!);
  return v;
}

/** ~24 h change for the deepest pool, in USD (WETH-quoted pools also use WETH's own 24 h move). */
async function change24h(k: ChainKey, best: PoolQuote) {
  try {
    const ago = await tokenInQuoteAgo(k, best);
    if (!ago) return { change24hPct: null, change24hNote: "no onchain history reachable for this pool" };
    let quoteUsdAgo = 1;
    if (best.quote === "WETH") {
      const w = wethCache.get(k)?.best;
      const wAgo = w ? await tokenInQuoteAgo(k, w) : null;
      if (!wAgo) return { change24hPct: null, change24hNote: "WETH history unavailable" };
      quoteUsdAgo = wAgo.tokenInQuote;
    }
    const usdAgo = ago.tokenInQuote * quoteUsdAgo;
    return { change24hPct: Math.round((best.priceUsd / usdAgo - 1) * 10000) / 100, priceUsd24hAgo: sig(usdAgo), change24h: { pool: best.pool, at: ago.at, method: ago.method } };
  } catch {
    return { change24hPct: null, change24hNote: "history lookup failed" };
  }
}

/** Depth-weighted price of pools within 3% of the deepest pool (drops stale/manipulated thin pools). */
function weighted(qs: PoolQuote[]): number {
  const best = qs.reduce((a, b) => (b.depthUsd > a.depthUsd ? b : a));
  const near = qs.filter((q) => Math.abs(q.priceUsd / best.priceUsd - 1) <= 0.03);
  const w = near.reduce((a, q) => a + q.depthUsd, 0);
  return near.reduce((a, q) => a + q.priceUsd * q.depthUsd, 0) / w;
}

function sig(n: number): number {
  return Number(n.toPrecision(n >= 1 ? 8 : 6));
}

export async function tokenPrice(tokenRaw: string, chainRaw?: string) {
  const started = Date.now();
  const t = tokenRaw.trim();
  const chainIn = chainRaw?.trim().toLowerCase();
  // Solana: chain=solana, a Solana-only symbol (SOL, JUP, BONK...), or a base58 mint address.
  const symU = t.toUpperCase().replace(/^\$/, "");
  if (chainIn === "solana" || (!chainIn && !SYMBOLS[symU] && SOL_SYMBOLS[symU]) || (!chainIn && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(t))) {
    try {
      return await solanaTokenPrice(t);
    } catch (e) {
      if (e instanceof SolanaInputError) throw new PriceInputError(e.message);
      throw e;
    }
  }
  if (chainIn && !(chainIn in CHAINS)) throw new PriceInputError(`unsupported_chain (use ${Object.keys(CHAINS).join(", ")})`);
  let k: ChainKey;
  let address: Address;
  let note: string | undefined;
  if (isAddress(t)) {
    address = getAddress(t);
    k = (chainIn as ChainKey) ?? "ethereum";
  } else {
    const sym = t.toUpperCase().replace(/^\$/, "");
    if (!/^[A-Z0-9.]{1,12}$/.test(sym)) throw new PriceInputError("token must be a symbol (e.g. ETH) or an ERC-20 address");
    const m = SYMBOLS[sym];
    if (!m) {
      if (NON_EVM.has(sym)) throw new PriceInputError(`non_evm_asset: ${sym} has no native ERC-20 here; this endpoint prices ERC-20 tokens onchain (pass a bridged token address + chain if one exists)`);
      throw new PriceInputError(`unknown_symbol: ${sym}. Pass the ERC-20 contract address and chain instead (supported symbols: ${Object.keys(SYMBOLS).join(", ")})`);
    }
    address = getAddress(m.address.toLowerCase());
    k = m.chain;
    note = m.note;
    if (chainIn && chainIn !== m.chain) throw new PriceInputError(`symbol ${sym} is priced on ${m.chain}; pass an address to price it on ${chainIn}`);
  }
  const key = `${k}:${address.toLowerCase()}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return { ...hit.value, cached: true, latencyMs: Date.now() - started };

  const c = client(k);
  const [meta, blk] = await Promise.all([
    c.multicall({
      contracts: [
        { address, abi: erc20Abi, functionName: "decimals" },
        { address, abi: erc20Abi, functionName: "symbol" },
        { address, abi: erc20Abi, functionName: "name" },
      ],
      allowFailure: true,
    }),
    c.getBlock(),
  ]);
  if (meta[0]?.status !== "success") return { error: "not_an_erc20" as const, message: `No ERC-20 at ${address} on ${k}` };
  const decimals = Number(meta[0].result);
  const curated = isAddress(t) ? null : t.toUpperCase().replace(/^\$/, "");
  const symbol = meta[1]?.status === "success" ? String(meta[1].result) : curated;
  const name = meta[2]?.status === "success" ? String(meta[2].result) : null;

  const isWeth = address.toLowerCase() === CHAINS[k].weth.toLowerCase();
  const weth = isWeth ? null : await wethUsd(k);
  const qs = await poolQuotes(k, address, decimals, weth);
  const deep = qs.filter((q) => q.depthUsd >= MIN_DEPTH_USD);
  if (!deep.length) {
    return {
      error: "insufficient_onchain_liquidity" as const,
      message: `No Uniswap v3 pool for ${symbol ?? address} on ${k} with >= $${MIN_DEPTH_USD.toLocaleString()} depth against USDC/USDT/WETH`,
      poolsSeen: qs.length,
    };
  }
  const priceUsd = weighted(deep);
  const best = deep.reduce((a, b) => (b.depthUsd > a.depthUsd ? b : a));
  const used = deep.filter((q) => Math.abs(q.priceUsd / best.priceUsd - 1) <= 0.03);
  const spread = used.length > 1 ? Math.max(...used.map((q) => q.priceUsd)) / Math.min(...used.map((q) => q.priceUsd)) - 1 : 0;
  const chg = await change24h(k, best);
  const value = {
    token: { symbol, name, address, decimals, chain: k },
    priceUsd: sig(priceUsd),
    confidence: spread <= 0.01 && best.depthUsd >= 1_000_000 ? "high" : spread <= 0.03 && best.depthUsd >= 100_000 ? "medium" : "low",
    ...chg,
    poolSpreadPct: Math.round(spread * 10000) / 100,
    outlierPools: deep.length - used.length,
    totalDepthUsd: Math.round(used.reduce((a, q) => a + q.depthUsd, 0)),
    pools: used
      .sort((a, b) => b.depthUsd - a.depthUsd)
      .slice(0, 5)
      .map((q) => ({ dex: "uniswap-v3", pool: q.pool, feeTier: q.feeTier, quote: q.quote, priceUsd: sig(q.priceUsd), depthUsd: Math.round(q.depthUsd), explorer: CHAINS[k].explorer + q.pool })),
    ...(weth ? { wethUsd: sig(weth) } : {}),
    block: { number: Number(blk.number), timestamp: new Date(Number(blk.timestamp) * 1000).toISOString() },
    method: "Uniswap v3 spot price (slot0) from public RPC; depth-weighted across pools within 3% of the deepest; USDC/USDT treated as $1",
    ...(note ? { note } : {}),
    generatedAt: new Date().toISOString(),
  };
  cache.set(key, { at: Date.now(), value });
  if (cache.size > 2000) cache.delete(cache.keys().next().value!);
  return { ...value, cached: false, latencyMs: Date.now() - started };
}

export const PRICE_SYMBOLS = Object.keys(SYMBOLS);
export const PRICE_CHAINS = [...Object.keys(CHAINS), "solana"];

export const EVM_CHAINS = Object.keys(CHAINS) as ChainKey[];
