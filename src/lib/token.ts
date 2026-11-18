/**
 * Thin token-metadata wrapper over free public RPCs (no Helius).
 * Returns name, symbol, decimals, totalSupply and chain for an ERC-20 or SPL mint.
 * Supply is chain-local for bridged/wrapped tokens. Native coins have no fixed supply.
 */
import { formatUnits, getAddress, isAddress, parseAbi, type Address } from "viem";
import { CHAINS, EVM_CHAINS, client, evmSymbol, type ChainKey } from "./price.js";
import { SOL_SYMBOLS, rpc as solRpc } from "./solana.js";
import { cleanTokenText } from "./token-name.js";

export class TokenInputError extends Error {}

const BYTES32_ABI = parseAbi([
  "function name() view returns (bytes32)",
  "function symbol() view returns (bytes32)",
]);
const ERC20_ABI = parseAbi([
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function name() view returns (string)",
  "function totalSupply() view returns (uint256)",
]);

const NATIVE: Record<string, { name: string; symbol: string; decimals: number; chain: string; explorer: string }> = {
  ETH: { name: "Ether", symbol: "ETH", decimals: 18, chain: "ethereum", explorer: "https://etherscan.io/" },
  SOL: { name: "Solana", symbol: "SOL", decimals: 9, chain: "solana", explorer: "https://solscan.io/" },
  POL: { name: "Polygon", symbol: "POL", decimals: 18, chain: "polygon", explorer: "https://polygonscan.com/" },
  MATIC: { name: "Polygon", symbol: "POL", decimals: 18, chain: "polygon", explorer: "https://polygonscan.com/" },
};

const CHAIN_LOCAL = new Set(["USDC", "USDT", "WETH", "WBTC", "CBBTC", "WPOL", "WMATIC"]);
const SOL_EXPLORER = "https://solscan.io/token/";

function parseChain(raw?: string): ChainKey | "solana" | undefined {
  if (!raw) return undefined;
  const k = raw.trim().toLowerCase();
  if (k === "solana" || k === "sol") return "solana";
  if (k === "eth") return "ethereum";
  if (k === "arb") return "arbitrum";
  if (k === "matic" || k === "poly") return "polygon";
  if ((EVM_CHAINS as string[]).includes(k)) return k as ChainKey;
  throw new TokenInputError(`unknown chain: ${raw}. Use ethereum, base, arbitrum, polygon or solana`);
}

function looksSolMint(t: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(t);
}

function decodeBytes32(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const hex = v.startsWith("0x") ? v.slice(2) : v;
  if (!/^[0-9a-fA-F]*$/.test(hex) || hex.length > 64) return null;
  const s = Buffer.from(hex, "hex").toString("utf8").replace(/\0+$/g, "").trim();
  return s || null;
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([p.catch(() => null), new Promise<null>((r) => setTimeout(() => r(null), ms))]);
}

async function hasCode(k: ChainKey, address: Address): Promise<boolean> {
  try {
    const code = await client(k).getCode({ address });
    return !!code && code !== "0x";
  } catch {
    return false;
  }
}

async function pickEvmChain(address: Address, prefer?: ChainKey): Promise<{ chain: ChainKey; alsoOn?: string[] }> {
  if (prefer) {
    if (!(await hasCode(prefer, address))) {
      throw new TokenInputError(`no ERC-20 contract at ${address} on ${prefer}`);
    }
    return { chain: prefer };
  }
  const hits: ChainKey[] = [];
  const checks = await Promise.all(EVM_CHAINS.map(async (k) => ((await withTimeout(hasCode(k, address), 4000)) ? k : null)));
  for (const k of checks) if (k) hits.push(k);
  if (!hits.length) throw new TokenInputError(`no ERC-20 contract at ${address} on ethereum, base, arbitrum or polygon (pass chain= if it lives elsewhere)`);
  const preferOrder: ChainKey[] = ["ethereum", "base", "arbitrum", "polygon"];
  const chain = preferOrder.find((k) => hits.includes(k)) ?? hits[0]!;
  const alsoOn = hits.filter((k) => k !== chain);
  return alsoOn.length ? { chain, alsoOn } : { chain };
}

async function evmMeta(address: Address, chain: ChainKey) {
  const c = client(chain);
  const [nameS, symbolS, decimals, totalSupply] = await Promise.all([
    c.readContract({ address, abi: ERC20_ABI, functionName: "name" }).catch(() => null),
    c.readContract({ address, abi: ERC20_ABI, functionName: "symbol" }).catch(() => null),
    c.readContract({ address, abi: ERC20_ABI, functionName: "decimals" }),
    c.readContract({ address, abi: ERC20_ABI, functionName: "totalSupply" }),
  ]);
  let name = typeof nameS === "string" ? nameS : null;
  let symbol = typeof symbolS === "string" ? symbolS : null;
  if (!name || !symbol) {
    const [nameB, symbolB] = await Promise.all([
      c.readContract({ address, abi: BYTES32_ABI, functionName: "name" }).catch(() => null),
      c.readContract({ address, abi: BYTES32_ABI, functionName: "symbol" }).catch(() => null),
    ]);
    name = name || decodeBytes32(nameB);
    symbol = symbol || decodeBytes32(symbolB);
  }
  const dec = Number(decimals);
  if (!Number.isFinite(dec) || dec < 0 || dec > 36) throw new TokenInputError(`token at ${address} on ${chain} returned an invalid decimals value`);
  const raw = totalSupply as bigint;
  const supply = Number(formatUnits(raw, dec));
  return {
    name: cleanTokenText(name, 32) || null,
    symbol: cleanTokenText(symbol, 20) || null,
    decimals: dec,
    totalSupply: Number.isFinite(supply) ? supply : null,
    totalSupplyRaw: raw.toString(),
  };
}

async function solanaMeta(mint: string) {
  const supply = await solRpc<{ value?: { amount?: string; decimals?: number; uiAmount?: number | null; uiAmountString?: string } }>(
    "getTokenSupply",
    [mint],
    { timeoutMs: 6000 },
  ).catch(() => null);
  const val = supply?.value;
  if (!val || val.decimals == null) throw new TokenInputError(`not a Solana mint (or public RPC could not read it): ${mint}`);
  const decimals = Number(val.decimals);
  const totalSupply = val.uiAmount != null && Number.isFinite(val.uiAmount)
    ? val.uiAmount
    : val.uiAmountString
      ? Number(val.uiAmountString)
      : val.amount
        ? Number(val.amount) / 10 ** decimals
        : null;
  let name: string | null = null;
  let symbol: string | null = null;
  const ds = await withTimeout(
    fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, { signal: AbortSignal.timeout(4000) })
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null),
    4500,
  );
  const base = (ds as any)?.pairs?.[0]?.baseToken;
  if (base) {
    name = cleanTokenText(base.name, 32) || null;
    symbol = cleanTokenText(base.symbol, 20) || null;
  }
  return { name, symbol, decimals, totalSupply: totalSupply != null && Number.isFinite(totalSupply) ? totalSupply : null, totalSupplyRaw: val.amount ?? null };
}

const cache = new Map<string, { at: number; value: any }>();
const TTL = 60_000;

function nativeResult(n: (typeof NATIVE)[string], generatedAt: string, started: number, cached: boolean) {
  return {
    token: { name: n.name, symbol: n.symbol, address: null, mint: null, decimals: n.decimals, chain: n.chain, kind: "native" as const },
    totalSupply: null,
    explorer: n.explorer,
    method: "native currency (no fixed total supply); public chain metadata",
    note: "Native coin has no fixed total supply. For the wrapped token pass WETH, WSOL or the contract.",
    generatedAt,
    cached,
    latencyMs: Date.now() - started,
  };
}

export async function tokenInfo(tokenRaw: string, chainRaw?: string) {
  const started = Date.now();
  const t = (tokenRaw ?? "").trim();
  if (!t) throw new TokenInputError("token is required (symbol, 0x ERC-20 address, or Solana mint)");
  if (t.length > 64) throw new TokenInputError("token is too long");
  const chain = parseChain(chainRaw);
  const key = `${t.toLowerCase()}|${chain ?? ""}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return { ...hit.value, cached: true, latencyMs: Date.now() - started };

  const sym = t.toUpperCase().replace(/^\$/, "");
  if (NATIVE[sym] && (chain === undefined || chain === NATIVE[sym]!.chain || (sym === "ETH" && (chain === "ethereum" || chain === "base" || chain === "arbitrum")))) {
    const n = { ...NATIVE[sym]! };
    if (sym === "ETH" && (chain === "base" || chain === "arbitrum")) {
      n.chain = chain;
      n.explorer = chain === "base" ? "https://basescan.org/" : "https://arbiscan.io/";
    }
    const value = nativeResult(n, new Date().toISOString(), started, false);
    // don't cache under a different generatedAt each time for natives — cheap
    cache.set(key, { at: Date.now(), value: { ...value, cached: undefined, latencyMs: undefined } });
    return value;
  }

  const evmHit = evmSymbol(t);
  if (chain === "solana" || (!chain && !isAddress(t) && !evmHit && (SOL_SYMBOLS[sym] || looksSolMint(t)))) {
    let mint = SOL_SYMBOLS[sym] ?? t;
    if (SOL_SYMBOLS[sym]) mint = SOL_SYMBOLS[sym]!;
    else if (!looksSolMint(t)) throw new TokenInputError(`unknown_symbol: ${sym}. Pass a 0x contract, an SPL mint, or a known ticker`);
    const meta = await solanaMeta(mint);
    const value = {
      token: { name: meta.name, symbol: meta.symbol ?? (SOL_SYMBOLS[sym] ? sym : null), address: null, mint, decimals: meta.decimals, chain: "solana", kind: "spl" as const },
      totalSupply: meta.totalSupply,
      totalSupplyRaw: meta.totalSupplyRaw,
      explorer: SOL_EXPLORER + mint,
      method: "Solana getTokenSupply from public RPC; name/symbol from DexScreener when available",
      generatedAt: new Date().toISOString(),
    };
    cache.set(key, { at: Date.now(), value });
    if (cache.size > 2000) cache.delete(cache.keys().next().value!);
    return { ...value, cached: false, latencyMs: Date.now() - started };
  }

  let address: Address;
  let picked: { chain: ChainKey; alsoOn?: string[] };
  const known = evmHit;
  if (isAddress(t)) {
    address = getAddress(t);
    picked = await pickEvmChain(address, chain);
  } else if (known) {
    address = known.address;
    picked = { chain: chain ?? known.chain };
    if (chain && chain !== known.chain) {
      picked = await pickEvmChain(address, chain);
    }
  } else {
    throw new TokenInputError(`unknown_symbol: ${sym}. Pass a 0x contract, an SPL mint, or a known ticker (${Object.keys(NATIVE).slice(0, 3).join(", ")}, USDC, …)`);
  }

  const meta = await evmMeta(address, picked.chain);
  const symbol = meta.symbol;
  const chainLocal = CHAIN_LOCAL.has((symbol ?? "").toUpperCase()) || !!picked.alsoOn?.length;
  const value = {
    token: { name: meta.name, symbol, address, mint: null, decimals: meta.decimals, chain: picked.chain, kind: "erc20" as const },
    totalSupply: meta.totalSupply,
    totalSupplyRaw: meta.totalSupplyRaw,
    explorer: CHAINS[picked.chain].explorer + address,
    method: "ERC-20 name/symbol/decimals/totalSupply from public RPC",
    ...(chainLocal ? { supplyNote: "totalSupply is the amount on this chain only, not the asset's global supply" } : {}),
    ...(picked.alsoOn?.length ? { alsoDeployedOn: picked.alsoOn, note: `Also found on ${picked.alsoOn.join(", ")}. Pass chain= to pick one.` } : {}),
    generatedAt: new Date().toISOString(),
  };
  cache.set(key, { at: Date.now(), value });
  if (cache.size > 2000) cache.delete(cache.keys().next().value!);
  return { ...value, cached: false, latencyMs: Date.now() - started };
}

export const TOKEN_CHAINS = [...EVM_CHAINS, "solana"] as const;
