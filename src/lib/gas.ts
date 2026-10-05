/**
 * Live gas / fee estimates from public RPC nodes for Ethereum, Base, Arbitrum, Polygon
 * (eth_feeHistory over the last 20 blocks -> slow/standard/fast priority tips + base fee) and
 * Solana (base fee + recent prioritization-fee percentiles). Includes the USD cost of a
 * native transfer, an ERC-20 transfer and a DEX swap. Cached 12 s.
 */
import { formatUnits } from "viem";
import { EVM_CHAINS, client, tokenPrice, wethUsd, type ChainKey } from "./price.js";
import { rpc as solRpc, solanaTokenPrice } from "./solana.js";

export class GasInputError extends Error {}
const GAS = { nativeTransfer: 21000, erc20Transfer: 65000, swap: 180000 };
const NATIVE: Record<ChainKey, string> = { ethereum: "ETH", base: "ETH", arbitrum: "ETH", polygon: "POL" };
const r6 = (n: number) => Number(n.toPrecision(6));
async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([p.catch(() => null), new Promise<null>((r) => setTimeout(() => r(null), ms))]);
}
const pct = (arr: bigint[], p: number) => {
  if (!arr.length) return 0n;
  const s = [...arr].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!;
};

async function evmGas(k: ChainKey) {
  const c = client(k);
  const [hist, block, nativeUsd] = await Promise.all([
    c.getFeeHistory({ blockCount: 20, rewardPercentiles: [10, 50, 90], blockTag: "latest" }),
    c.getBlock({ blockTag: "latest" }),
    withTimeout(k === "polygon" ? tokenPrice("0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270", "polygon").then((r: any) => r.priceUsd ?? null) : wethUsd(k), 4000),
  ]);
  const base = hist.baseFeePerGas.at(-1) ?? block.baseFeePerGas ?? 0n; // next block's base fee
  const rewards = hist.reward ?? [];
  const tip = (i: number) => pct(rewards.map((r) => r[i] ?? 0n), 50);
  const tiers = { slow: tip(0), standard: tip(1), fast: tip(2) };
  const gwei = (w: bigint) => r6(Number(formatUnits(w, 9)));
  const cost = (gas: number, tipWei: bigint) => {
    const native = Number(formatUnits((base + tipWei) * BigInt(gas), 18));
    return { native: r6(native), usd: nativeUsd !== null ? Math.round(native * nativeUsd * 1e5) / 1e5 : null };
  };
  return {
    chain: k,
    block: Number(block.number),
    baseFeeGwei: gwei(base),
    priorityFeeGwei: { slow: gwei(tiers.slow), standard: gwei(tiers.standard), fast: gwei(tiers.fast) },
    maxFeePerGasGwei: { slow: gwei(base * 2n + tiers.slow), standard: gwei(base * 2n + tiers.standard), fast: gwei(base * 2n + tiers.fast) },
    gasUsedRatio: Math.round((hist.gasUsedRatio.reduce((a, b) => a + b, 0) / Math.max(1, hist.gasUsedRatio.length)) * 1000) / 1000,
    nativeSymbol: NATIVE[k],
    nativeUsd: nativeUsd !== null ? r6(nativeUsd) : null,
    costStandard: { nativeTransfer: cost(GAS.nativeTransfer, tiers.standard), erc20Transfer: cost(GAS.erc20Transfer, tiers.standard), swap: cost(GAS.swap, tiers.standard) },
    ...(k === "base" || k === "arbitrum" ? { note: "L2 execution cost only; the rollup adds a small L1 data fee per tx" } : {}),
  };
}

async function solanaGas() {
  const [fees, sol] = await Promise.all([solRpc<any[]>("getRecentPrioritizationFees", [["Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE"]]), withTimeout(solanaTokenPrice("SOL"), 5000)]);
  const vals = (fees ?? []).map((f) => BigInt(f.prioritizationFee ?? 0));
  const p = (q: number) => Number(pct(vals, q));
  const solUsd = (sol as any)?.priceUsd ?? null;
  const CU = 200_000; // typical compute units for a swap-sized tx
  const cost = (microLamportsPerCu: number) => {
    const lamports = 5000 + (microLamportsPerCu * CU) / 1e6;
    const s = lamports / 1e9;
    return { sol: r6(s), usd: solUsd ? Math.round(s * solUsd * 1e5) / 1e5 : null };
  };
  return {
    chain: "solana",
    slot: Math.max(...(fees ?? []).map((f) => f.slot ?? 0)),
    baseFeeLamportsPerSignature: 5000,
    priorityFeeMicroLamportsPerCu: { slow: p(25), standard: p(50), fast: p(90) },
    sampleSlots: vals.length,
    nativeSymbol: "SOL",
    nativeUsd: solUsd,
    costFor200kCu: { slow: cost(p(25)), standard: cost(p(50)), fast: cost(p(90)) },
    note: "Per-slot minimum priority fees paid by txs touching the busiest SOL/USDC pool over the last ~150 slots (a swap-competitive estimate); 1 signature",
  };
}

let cache: { at: number; key: string; value: any } | null = null;
export async function gasNow(chainRaw?: string) {
  const started = Date.now();
  const chainIn = chainRaw?.trim().toLowerCase() || "all";
  const all = [...EVM_CHAINS, "solana"];
  if (chainIn !== "all" && !all.includes(chainIn)) throw new GasInputError(`chain must be one of ${all.join(", ")} or all (default)`);
  if (cache && cache.key === chainIn && Date.now() - cache.at < 12_000) return { ...cache.value, cached: true, latencyMs: Date.now() - started };
  const chains = chainIn === "all" ? all : [chainIn];
  const results = await Promise.allSettled(chains.map((k) => (k === "solana" ? solanaGas() : evmGas(k as ChainKey))));
  const ok = results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
  if (!ok.length) throw new Error("rpc_unavailable");
  const failed = chains.filter((_, i) => results[i]!.status === "rejected");
  const evm = ok.filter((c: any) => c.costStandard?.erc20Transfer?.usd != null) as any[];
  const cheapest = evm.length ? evm.reduce((a, b) => (b.costStandard.erc20Transfer.usd < a.costStandard.erc20Transfer.usd ? b : a)).chain : null;
  const value = { chains: ok, ...(failed.length ? { chainsFailed: failed } : {}), cheapestEvmForErc20Transfer: cheapest, generatedAt: new Date().toISOString() };
  cache = { at: Date.now(), key: chainIn, value };
  return { ...value, cached: false, latencyMs: Date.now() - started };
}
