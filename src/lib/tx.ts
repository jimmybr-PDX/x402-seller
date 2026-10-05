/**
 * Transaction lookup + decode from public RPC nodes. EVM (Ethereum, Base, Arbitrum, Polygon):
 * status, block/time, from/to, value, gas + fee in USD, method name for common selectors,
 * and every ERC-20/721 Transfer log decoded with token symbol/decimals. Solana: status,
 * slot/time, fee, signers, SOL and token balance changes, programs invoked.
 * Without chain=, EVM hashes are looked up on all four chains in parallel.
 */
import { formatUnits, getAddress, parseAbi, type Address, type Hash } from "viem";
import { CHAINS, EVM_CHAINS, client, tokenPrice, wethUsd, type ChainKey } from "./price.js";
import { SOL_SYMBOLS, rpc as solRpc, solanaTokenPrice } from "./solana.js";

export class TxInputError extends Error {}

const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const SELECTORS: Record<string, string> = {
  "0xa9059cbb": "transfer(address,uint256)",
  "0x095ea7b3": "approve(address,uint256)",
  "0x23b872dd": "transferFrom(address,address,uint256)",
  "0xe3ee160e": "transferWithAuthorization (EIP-3009, used by x402 USDC payments)",
  "0xef55bec6": "receiveWithAuthorization (EIP-3009)",
  "0x3593564c": "execute (Uniswap Universal Router)",
  "0x24856bc3": "execute (Uniswap Universal Router)",
  "0x414bf389": "exactInputSingle (Uniswap v3)",
  "0x04e45aaf": "exactInputSingle (Uniswap v3 Router02)",
  "0xc04b8d59": "exactInput (Uniswap v3)",
  "0xb858183f": "exactInput (Uniswap v3 Router02)",
  "0x5ae401dc": "multicall(uint256,bytes[])",
  "0xac9650d8": "multicall(bytes[])",
  "0x7ff36ab5": "swapExactETHForTokens (Uniswap v2)",
  "0x38ed1739": "swapExactTokensForTokens (Uniswap v2)",
  "0x18cbafe5": "swapExactTokensForETH (Uniswap v2)",
  "0xd0e30db0": "deposit() (wrap)",
  "0x2e1a7d4d": "withdraw(uint256) (unwrap)",
  "0x6a761202": "execTransaction (Safe multisig)",
  "0x1249c58b": "mint()",
  "0xa0712d68": "mint(uint256)",
  "0x40c10f19": "mint(address,uint256)",
  "0x42842e0e": "safeTransferFrom (ERC-721)",
  "0xb88d4fde": "safeTransferFrom (ERC-721, data)",
  "0xf242432a": "safeTransferFrom (ERC-1155)",
  "0x12aa3caf": "swap (1inch)",
  "0x0b86a4c1": "swap (1inch)",
  "0x415565b0": "transformERC20 (0x)",
  "0x617ba037": "supply (Aave v3)",
  "0xa415bcad": "borrow (Aave v3)",
  "0x573ade81": "repay (Aave v3)",
  "0x69328dec": "withdraw (Aave v3)",
};
const erc20 = parseAbi(["function decimals() view returns (uint8)", "function symbol() view returns (string)"]);
const EXPLORER_TX: Record<ChainKey, string> = { ethereum: "https://etherscan.io/tx/", base: "https://basescan.org/tx/", arbitrum: "https://arbiscan.io/tx/", polygon: "https://polygonscan.com/tx/" };
const NATIVE: Record<ChainKey, string> = { ethereum: "ETH", base: "ETH", arbitrum: "ETH", polygon: "POL" };
const amt = (n: number) => Number(n.toPrecision(10));
const round = (n: number, d = 4) => Math.round(n * 10 ** d) / 10 ** d;
async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([p.catch(() => null), new Promise<null>((r) => setTimeout(() => r(null), ms))]);
}
const topicAddr = (t: string | undefined) => (t ? getAddress(`0x${t.slice(26)}`) : null);

async function evmTx(k: ChainKey, hash: Hash) {
  const c = client(k);
  const receipt = await c.getTransactionReceipt({ hash }).catch(() => null);
  if (!receipt) {
    const pending = await c.getTransaction({ hash }).catch(() => null);
    return pending ? { chain: k, status: "pending" as const, hash, from: pending.from, to: pending.to, explorer: EXPLORER_TX[k] + hash } : null;
  }
  const [tx, block, head] = await Promise.all([c.getTransaction({ hash }), c.getBlock({ blockNumber: receipt.blockNumber }), c.getBlockNumber()]);
  const transfers = receipt.logs.filter((l) => l.topics[0] === TRANSFER && l.topics.length >= 3).slice(0, 50);
  const tokens = [...new Set(transfers.map((l) => l.address.toLowerCase()))].slice(0, 20).map((a) => getAddress(a));
  const meta = tokens.length
    ? await c.multicall({ contracts: tokens.flatMap((t) => [{ address: t, abi: erc20, functionName: "symbol" }, { address: t, abi: erc20, functionName: "decimals" }]) as any[], allowFailure: true })
    : [];
  const tmeta = new Map(tokens.map((t, i) => [t.toLowerCase(), { symbol: meta[i * 2]?.status === "success" ? String(meta[i * 2]!.result) : null, decimals: meta[i * 2 + 1]?.status === "success" ? Number(meta[i * 2 + 1]!.result) : null }]));
  const decoded = transfers.map((l) => {
    const m = tmeta.get(l.address.toLowerCase());
    const isNft = l.topics.length === 4;
    const raw = isNft ? null : BigInt(l.data === "0x" ? 0 : l.data);
    return {
      token: getAddress(l.address),
      symbol: m?.symbol ?? null,
      standard: isNft ? "erc721" : "erc20",
      from: topicAddr(l.topics[1]),
      to: topicAddr(l.topics[2]),
      ...(isNft ? { tokenId: BigInt(l.topics[3]!).toString() } : { amount: m?.decimals != null && raw !== null ? amt(Number(formatUnits(raw, m.decimals))) : null, raw: raw?.toString() }),
    };
  });
  const nativeUsd = (await withTimeout(k === "polygon" ? tokenPrice("0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270", "polygon").then((r: any) => r.priceUsd ?? null) : wethUsd(k), 4000)) ?? null;
  const feeWei = receipt.gasUsed * receipt.effectiveGasPrice;
  const fee = Number(formatUnits(feeWei, 18));
  const value = Number(formatUnits(tx.value, 18));
  const sel = tx.input && tx.input.length >= 10 ? tx.input.slice(0, 10).toLowerCase() : null;
  return {
    chain: k,
    status: receipt.status === "success" ? ("success" as const) : ("reverted" as const),
    hash,
    blockNumber: Number(receipt.blockNumber),
    timestamp: new Date(Number(block.timestamp) * 1000).toISOString(),
    confirmations: Number(head - receipt.blockNumber) + 1,
    from: getAddress(tx.from),
    to: tx.to ? getAddress(tx.to) : null,
    contractCreated: receipt.contractAddress ?? null,
    value: { amount: amt(value), symbol: NATIVE[k], usd: nativeUsd !== null ? round(value * nativeUsd, 2) : null },
    method: sel ? { selector: sel, name: SELECTORS[sel] ?? null } : { selector: null, name: "native transfer" },
    gasUsed: Number(receipt.gasUsed),
    effectiveGasPriceGwei: round(Number(formatUnits(receipt.effectiveGasPrice, 9)), 6),
    fee: { amount: amt(fee), symbol: NATIVE[k], usd: nativeUsd !== null ? round(fee * nativeUsd, 4) : null, note: k === "base" || k === "arbitrum" ? "L2 execution fee; any L1 data fee is charged separately by the rollup" : undefined },
    tokenTransfers: decoded,
    logCount: receipt.logs.length,
    explorer: EXPLORER_TX[k] + hash,
  };
}

async function solanaTx(sig: string) {
  const r = await solRpc<any>("getTransaction", [sig, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "confirmed" }], { timeoutMs: 12000, nullIsMiss: true });
  if (!r) return null;
  const keys: string[] = (r.transaction?.message?.accountKeys ?? []).map((k: any) => (typeof k === "string" ? k : k.pubkey));
  const signers: string[] = (r.transaction?.message?.accountKeys ?? []).filter((k: any) => k.signer).map((k: any) => k.pubkey);
  const pre: number[] = r.meta?.preBalances ?? [];
  const post: number[] = r.meta?.postBalances ?? [];
  const solChanges = keys
    .map((k, i) => ({ account: k, changeSol: amt(((post[i] ?? 0) - (pre[i] ?? 0)) / 1e9) }))
    .filter((x) => x.changeSol !== 0)
    .slice(0, 20);
  const tb = new Map<string, { mint: string; owner: string | null; pre: number; post: number }>();
  for (const [side, list] of [["pre", r.meta?.preTokenBalances ?? []], ["post", r.meta?.postTokenBalances ?? []]] as const) {
    for (const b of list) {
      const key = `${b.accountIndex}`;
      const e = tb.get(key) ?? { mint: b.mint, owner: b.owner ?? null, pre: 0, post: 0 };
      e[side] = Number(b.uiTokenAmount?.uiAmountString ?? 0);
      tb.set(key, e);
    }
  }
  const symByMint = new Map(Object.entries(SOL_SYMBOLS).filter(([s]) => s !== "WSOL").map(([s, m]) => [m, s]));
  const tokenChanges = [...tb.values()]
    .map((e) => ({ mint: e.mint, symbol: symByMint.get(e.mint) ?? null, owner: e.owner, change: amt(e.post - e.pre) }))
    .filter((x) => x.change !== 0)
    .slice(0, 30);
  const programs = [...new Set((r.transaction?.message?.instructions ?? []).map((ix: any) => ix.program ?? ix.programId).filter(Boolean))].slice(0, 15);
  const sol: any = await withTimeout(solanaTokenPrice("SOL"), 4000);
  const fee = (r.meta?.fee ?? 0) / 1e9;
  return {
    chain: "solana",
    status: r.meta?.err ? "failed" : "success",
    error: r.meta?.err ?? null,
    signature: sig,
    slot: r.slot,
    timestamp: r.blockTime ? new Date(r.blockTime * 1000).toISOString() : null,
    signers,
    fee: { amount: amt(fee), symbol: "SOL", usd: sol?.priceUsd ? round(fee * sol.priceUsd, 4) : null },
    computeUnits: r.meta?.computeUnitsConsumed ?? null,
    solChanges,
    tokenChanges,
    programs,
    explorer: `https://solscan.io/tx/${sig}`,
  };
}

const cache = new Map<string, { at: number; value: any }>();

export async function txLookup(hashRaw: string, chainRaw?: string) {
  const started = Date.now();
  const h = hashRaw.trim();
  const chainIn = chainRaw?.trim().toLowerCase();
  const key = `${h}|${chainIn ?? ""}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 60_000) return { ...hit.value, cached: true, latencyMs: Date.now() - started };
  let value: any = null;
  if (/^0x[0-9a-fA-F]{64}$/.test(h)) {
    if (chainIn && !EVM_CHAINS.includes(chainIn as ChainKey)) throw new TxInputError(`chain must be one of ${EVM_CHAINS.join(", ")} for a 0x hash`);
    const chains = chainIn ? [chainIn as ChainKey] : EVM_CHAINS;
    const results = await Promise.all(chains.map((k) => evmTx(k, h as Hash).catch(() => null)));
    const found = results.filter(Boolean);
    value = found.find((f: any) => f.status !== "pending") ?? found[0] ?? null;
  } else if (/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(h)) {
    if (chainIn && chainIn !== "solana") throw new TxInputError("a base58 signature is a Solana transaction (chain=solana)");
    value = await solanaTx(h);
  } else throw new TxInputError("hash must be a 0x-prefixed 32-byte EVM tx hash or a base58 Solana signature");
  if (!value) return { error: "tx_not_found" as const, message: `Transaction not found on ${chainIn ?? (h.startsWith("0x") ? EVM_CHAINS.join("/") : "solana")}` };
  value = { ...value, generatedAt: new Date().toISOString() };
  if (value.status !== "pending") cache.set(key, { at: Date.now(), value });
  if (cache.size > 2000) cache.delete(cache.keys().next().value!);
  return { ...value, cached: false, latencyMs: Date.now() - started };
}
export { CHAINS };
