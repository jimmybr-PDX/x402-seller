/**
 * Wallet balances read directly from public RPC nodes: native coin + common tokens on
 * Ethereum, Base, Arbitrum and Polygon (one Multicall per chain), or SOL + every SPL token
 * account for a Solana wallet. USD values use our own onchain prices (Uniswap v3 / Orca /
 * Raydium); stablecoins count as $1. ENS names (*.eth) are resolved onchain. Cached 20 s.
 */
import { formatUnits, getAddress, isAddress, parseAbi, type Address } from "viem";
import { normalize } from "viem/ens";
import { CHAINS, EVM_CHAINS, client, tokenPrice, wethUsd, type ChainKey } from "./price.js";
import { address as solAddress, getAddressEncoder, getProgramDerivedAddress, type Address as SolAddress } from "@solana/kit";
import { SOL_SYMBOLS, USDC as SOL_USDC, USDT as SOL_USDT, rpc as solRpc, solanaTokenPrice } from "./solana.js";

export class WalletInputError extends Error {}

const TOKENS: Record<ChainKey, string[]> = {
  ethereum: [
    "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", "0xdac17f958d2ee523a2206206994597c13d831ec7", "0x6b175474e89094c44da98b954eedeac495271d0f",
    "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2", "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599", "0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf",
    "0xae7ab96520de3a18e5e111b5eaab095312d7fe84", "0x514910771af9ca656af840dff83e8264ecf986ca", "0x1f9840a85d5af5bf1d1762f925bdaddc4201f984",
    "0x7fc66500c84a76ad7e9c93437bfc5ac33e2ddae9", "0x6982508145454ce325ddbe47a25d4ec3d2311933", "0x95ad61b0a150d79219dcf64e1e6cc01f0b64c4ce",
    "0x57e114b691db790c35207b2e685d4a43181e6061", "0xfaba6f8e4a5e8ab82f62fe7c39859fa577269be3", "0x5a98fcbea516cf06857215779fd812ca3bef1b32",
    "0x455e53cbb86018ac2b8092fdcd39d8444affc3f6", "0x4c9edd5852cd905f086c759e8383e09bff1e68b3", "0x6c3ea9036406852006290770bedfcaba0e23a0e8",
  ],
  base: [
    "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", "0x4200000000000000000000000000000000000006", "0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf",
    "0x2ae3f1ec7f1f5012cfeab0185bfc7aa3cf0dec22", "0x50c5725949a6f0c72e6c4a641f24049a917db0cb", "0x940181a94a35a4569e4529a3cdfb74e38fd98631",
    "0x4ed4e862860bed51a9570b96d89af5e1b0efefed", "0x532f27101965dd16442e59d40670faf5ebb142e4", "0x0b3e328455c4059eeb9e3f84b5543f74e24e7e1b",
    "0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca", "0x60a3e35cc302bfa44cb288bc5a4f316fdb1adb42",
  ],
  arbitrum: [
    "0xaf88d065e77c8cc2239327c5edb3a432268e5831", "0xff970a61a04b1ca14834a43f5de4533ebddb5cc8", "0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9",
    "0x82af49447d8a07e3bd95bd0d56f35241523fbab1", "0x2f2a2543b76a4166549f7aab2e75bef0aefc5b0f", "0x912ce59144191c1204e64559fe8253a0e49e6548",
    "0xfc5a1a6eb076a2c7ad06ed22c90d7e710e35ad0a", "0xda10009cbd5d07dd0cecc66161fc93d7c9000da1", "0xf97f4df75117a78c1a5a0dbb814af92458539fb4",
  ],
  polygon: [
    "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359", "0x2791bca1f2de4661ed88a30c99a7a9449aa84174", "0xc2132d05d31c914a87c6611c10748aeb04b58e8f",
    "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619", "0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270", "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6",
    "0x8f3cf7ad23cd3cadbd9735aff958023239c6a063", "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39", "0xd6df932a45c0f255f85145f286ea0b292b21c90b",
  ],
};
const NATIVE: Record<ChainKey, string> = { ethereum: "ETH", base: "ETH", arbitrum: "ETH", polygon: "POL" };
const STABLE = new Set(["USDC", "USDT", "DAI", "USDC.E", "USDBC", "PYUSD", "USDE", "USDT0", "USD₮0"]);
const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)", "function decimals() view returns (uint8)", "function symbol() view returns (string)"]);
const multicallAbi = parseAbi(["function getEthBalance(address) view returns (uint256)"]);
const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11" as Address;

const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
const amt = (n: number) => Number(n.toPrecision(10));

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([p.catch(() => null), new Promise<null>((r) => setTimeout(() => r(null), ms))]);
}

const metaCache = new Map<string, { symbol: string; decimals: number }>();

async function evmChainBalances(k: ChainKey, owner: Address, extra: Address[]) {
  const c = client(k);
  const list = [...new Set([...TOKENS[k], ...extra.map((a) => a.toLowerCase())])].map((a) => getAddress(a));
  const needMeta = list.filter((a) => !metaCache.has(`${k}:${a}`));
  const [res, meta, block] = await Promise.all([
    c.multicall({
      contracts: [
        { address: MULTICALL3, abi: multicallAbi, functionName: "getEthBalance", args: [owner] } as any,
        ...list.map((t) => ({ address: t, abi: erc20, functionName: "balanceOf", args: [owner] }) as any),
      ] as any[],
      allowFailure: true,
    }),
    needMeta.length
      ? c.multicall({ contracts: needMeta.flatMap((t) => [{ address: t, abi: erc20, functionName: "symbol" }, { address: t, abi: erc20, functionName: "decimals" }]) as any[], allowFailure: true })
      : Promise.resolve([]),
    c.getBlockNumber(),
  ]);
  needMeta.forEach((t, i) => {
    const s = meta[i * 2];
    const d = meta[i * 2 + 1];
    if (d?.status === "success") metaCache.set(`${k}:${t}`, { symbol: s?.status === "success" ? String(s.result) : "?", decimals: Number(d.result) });
  });
  const nativeWei = res[0]?.status === "success" ? (res[0].result as bigint) : 0n;
  const tokens: { symbol: string; address: string; balance: number; raw: string; usd: number | null; priceUsd: number | null; priceSource?: string }[] = [];
  list.forEach((t, i) => {
    const r = res[i + 1];
    const m = metaCache.get(`${k}:${t}`);
    if (r?.status !== "success" || !m) return;
    const raw = r.result as bigint;
    if (raw === 0n) return;
    tokens.push({ symbol: m.symbol, address: t, balance: amt(Number(formatUnits(raw, m.decimals))), raw: raw.toString(), usd: null, priceUsd: null });
  });
  // USD: native + WETH from the chain's WETH/USDC pools; stables $1; others via onchain token price.
  const nativeUsdP = k === "polygon" ? withTimeout(tokenPrice("0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270", "polygon").then((r: any) => r.priceUsd ?? null), 5000) : withTimeout(wethUsd(k), 5000);
  await Promise.all([
    nativeUsdP,
    ...tokens.map(async (t) => {
      if (STABLE.has(t.symbol.toUpperCase())) {
        t.priceUsd = 1;
        t.priceSource = "stablecoin (assumed $1)";
      } else if (t.address.toLowerCase() === CHAINS[k].weth.toLowerCase()) {
        t.priceUsd = await withTimeout(wethUsd(k), 5000);
      } else {
        const r: any = await withTimeout(tokenPrice(t.address, k), 5000);
        t.priceUsd = r && !r.error ? r.priceUsd : null;
      }
      t.usd = t.priceUsd !== null ? round(t.balance * t.priceUsd) : null;
    }),
  ]);
  const nativeUsd = await nativeUsdP;
  const nativeBal = Number(formatUnits(nativeWei, 18));
  const native = { symbol: NATIVE[k], balance: amt(nativeBal), raw: nativeWei.toString(), priceUsd: nativeUsd, usd: nativeUsd !== null ? round(nativeBal * nativeUsd) : null };
  tokens.sort((a, b) => (b.usd ?? -1) - (a.usd ?? -1));
  const totalUsd = round((native.usd ?? 0) + tokens.reduce((s, t) => s + (t.usd ?? 0), 0));
  return { chain: k, block: Number(block), native, tokens, totalUsd, tokensChecked: list.length };
}

async function solanaBalances(owner: string, extraMints: string[]) {
  // Public Solana RPC rejects "all token accounts by owner" scans, so we derive the owner's
  // associated token account (ATA) for each known mint and read them in one getMultipleAccounts.
  const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
  const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
  const enc = getAddressEncoder();
  const symByMint = new Map(Object.entries(SOL_SYMBOLS).filter(([s]) => s !== "WSOL").map(([s, m]) => [m, s]));
  const mints = [...new Set([...symByMint.keys(), ...extraMints])];
  const atas = await Promise.all(
    mints.map(async (m) => {
      const [a] = await getProgramDerivedAddress({ programAddress: ATA_PROGRAM as SolAddress, seeds: [enc.encode(solAddress(owner)), enc.encode(solAddress(TOKEN)), enc.encode(solAddress(m))] });
      return a as string;
    }),
  );
  const [bal, accs] = await Promise.all([
    solRpc<any>("getBalance", [owner, { commitment: "confirmed" }]),
    solRpc<any>("getMultipleAccounts", [[...atas, ...mints], { encoding: "base64", commitment: "confirmed" }]),
  ]);
  const vals: any[] = accs?.value ?? [];
  const solPriceP = withTimeout(solanaTokenPrice("SOL").then((r: any) => r.priceUsd ?? null), 6000);
  const held: { symbol: string | null; mint: string; ata: string; balance: number }[] = [];
  mints.forEach((m, i) => {
    const a = vals[i];
    const mintAcc = vals[mints.length + i];
    if (!a || !mintAcc) return;
    const d = Buffer.from(a.data[0], "base64");
    const md = Buffer.from(mintAcc.data[0], "base64");
    if (d.length < 72 || md.length < 45) return;
    const raw = d.readBigUInt64LE(64);
    if (raw === 0n) return;
    held.push({ symbol: symByMint.get(m) ?? null, mint: m, ata: atas[i]!, balance: amt(Number(raw) / 10 ** md[44]!) });
  });
  const tokens = await Promise.all(
    held.map(async (t) => {
      let priceUsd: number | null = null;
      if (t.mint === SOL_USDC || t.mint === SOL_USDT) priceUsd = 1;
      else {
        const r: any = await withTimeout(solanaTokenPrice(t.mint), 6000);
        priceUsd = r && !r.error ? r.priceUsd : null;
      }
      return { ...t, priceUsd, usd: priceUsd !== null ? round(t.balance * priceUsd) : null };
    }),
  );
  tokens.sort((a, b) => (b.usd ?? -1) - (a.usd ?? -1) || b.balance - a.balance);
  const solPrice = await solPriceP;
  const sol = Number(bal?.value ?? 0) / 1e9;
  const native = { symbol: "SOL", balance: amt(sol), raw: String(bal?.value ?? 0), priceUsd: solPrice, usd: solPrice !== null ? round(sol * solPrice) : null };
  return {
    chain: "solana",
    slot: bal?.context?.slot ?? null,
    native,
    tokens,
    tokensChecked: mints.length,
    totalUsd: round((native.usd ?? 0) + tokens.reduce((s, t) => s + (t.usd ?? 0), 0)),
  };
}

const cache = new Map<string, { at: number; value: any }>();

export async function walletBalances(addressRaw: string, opts: { chain?: string; tokens?: string } = {}) {
  const started = Date.now();
  const input = addressRaw.trim();
  const chainIn = opts.chain?.trim().toLowerCase() || "all";
  const key = `${input.toLowerCase()}|${chainIn}|${opts.tokens ?? ""}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 20_000) return { ...hit.value, cached: true, latencyMs: Date.now() - started };

  let value: any;
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(input) && !input.startsWith("0x")) {
    if (chainIn !== "all" && chainIn !== "solana") throw new WalletInputError("a Solana address needs chain=solana (or omit chain)");
    const extraMints = (opts.tokens ?? "").split(",").map((x) => x.trim()).filter(Boolean);
    if (extraMints.length > 20 || extraMints.some((m) => !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(m))) throw new WalletInputError("tokens must be up to 20 comma-separated SPL mint addresses");
    const s = await solanaBalances(input, extraMints);
    value = { address: input, chains: [s], totalUsd: s.totalUsd };
  } else {
    let owner: Address;
    let ens: string | null = null;
    if (isAddress(input, { strict: false })) owner = getAddress(input.toLowerCase());
    else if (/^[a-z0-9-]+(\.[a-z0-9-]+)*\.eth$/i.test(input)) {
      ens = normalize(input);
      const r = await client("ethereum").getEnsAddress({ name: ens });
      if (!r) return { error: "ens_not_found" as const, message: `${input} does not resolve to an address` };
      owner = r;
    } else throw new WalletInputError("address must be a 0x EVM address, an ENS name (name.eth) or a Solana address");
    const chains = chainIn === "all" ? EVM_CHAINS : ([chainIn] as ChainKey[]);
    if (chains.some((c) => !EVM_CHAINS.includes(c))) throw new WalletInputError(`chain must be one of ${EVM_CHAINS.join(", ")}, all (default) or solana`);
    const extra = (opts.tokens ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    if (extra.length > 20 || extra.some((a) => !isAddress(a, { strict: false }))) throw new WalletInputError("tokens must be up to 20 comma-separated 0x token addresses");
    if (extra.length && chains.length > 1) throw new WalletInputError("custom tokens need a single chain (chain=base, ...)");
    const results = await Promise.allSettled(chains.map((c) => evmChainBalances(c, owner, extra as Address[])));
    const ok = results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
    const failed = chains.filter((_, i) => results[i]!.status === "rejected");
    if (!ok.length) throw new Error("rpc_unavailable");
    value = { address: owner, ...(ens ? { ens } : {}), chains: ok, ...(failed.length ? { chainsFailed: failed } : {}), totalUsd: round(ok.reduce((s, c) => s + c.totalUsd, 0)) };
  }
  value = {
    ...value,
    note: "Balances read live from public RPC nodes. EVM: native coin + a curated list of major tokens per chain (add more with tokens=); Solana: SOL + the owner's associated token accounts for major SPL mints (add more with tokens=). USD from onchain DEX prices; stablecoins counted as $1; unpriced tokens have usd=null.",
    generatedAt: new Date().toISOString(),
  };
  cache.set(key, { at: Date.now(), value });
  if (cache.size > 1000) cache.delete(cache.keys().next().value!);
  return { ...value, cached: false, latencyMs: Date.now() - started };
}
