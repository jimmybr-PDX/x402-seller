/**
 * Short-timeout public EVM sell quote (aggregator). Callers warn only when a sale
 * cannot be routed or impact is extreme; timeout/error returns null (unknown).
 */
const WETH: Record<string, string> = {
  base: "0x4200000000000000000000000000000000000006",
  ethereum: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
  arbitrum: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
  bnb: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
};
const SLUG: Record<string, string> = { base: "base", ethereum: "ethereum", arbitrum: "arbitrum", bnb: "bsc" };
const RPC: Record<string, string[]> = {
  base: ["https://mainnet.base.org", "https://base-rpc.publicnode.com"],
  ethereum: ["https://ethereum-rpc.publicnode.com", "https://eth.drpc.org"],
  arbitrum: ["https://arb1.arbitrum.io/rpc", "https://arbitrum-one-rpc.publicnode.com"],
  bnb: ["https://bsc-rpc.publicnode.com", "https://bsc-dataseed.binance.org"],
};

export type EvmSellQuote = { noRoute: boolean; impactPct: number | null };

/** Integer token units worth about $100, using BigInt so 18-decimal prices stay exact. */
export function evmSellAmount(priceUsd: number | null, decimals: number | null): bigint | null {
  if (!(Number(priceUsd) > 0) || decimals == null || decimals < 0 || decimals > 36) return null;
  const px = BigInt(Math.round(Number(priceUsd) * 1e8));
  if (px <= 0n) return null;
  const amt = (100n * (10n ** BigInt(decimals)) * 100_000_000n) / px;
  return amt > 0n ? amt : null;
}

/** decimals() via public RPC; first success wins, short timeout, no extra keys. */
export async function evmDecimals(chain: string, token: string, f: typeof fetch = fetch, timeoutMs = 1500): Promise<number | null> {
  const urls = RPC[chain];
  if (!urls?.length || !/^0x[0-9a-fA-F]{40}$/.test(token)) return null;
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: token, data: "0x313ce567" }, "latest"] });
  const one = async (url: string) => {
    const r = await f(url, { method: "POST", headers: { "content-type": "application/json" }, body, signal: AbortSignal.timeout(timeoutMs) });
    const j: any = await r.json();
    const n = parseInt(String(j?.result ?? ""), 16);
    if (Number.isFinite(n) && n >= 0 && n <= 36) return n;
    return null;
  };
  const hits = await Promise.all(urls.slice(0, 2).map((u) => one(u).catch(() => null)));
  return hits.find((n) => n != null) ?? null;
}

/**
 * Public aggregator quote token -> wrapped native. null = unknown (timeout/error).
 * noRoute is only set when the aggregator answers that no path exists.
 */
export async function evmSellQuote(chain: string, token: string, amountIn: bigint, opts: { fetch?: typeof fetch; timeoutMs?: number } = {}): Promise<EvmSellQuote | null> {
  const slug = SLUG[chain], out = WETH[chain], f = opts.fetch ?? fetch;
  const addr = token.toLowerCase();
  if (!slug || !out || amountIn <= 0n) return null;
  if (addr === out.toLowerCase()) return { noRoute: false, impactPct: 0 };
  const url = `https://aggregator-api.kyberswap.com/${slug}/api/v1/routes?tokenIn=${token}&tokenOut=${out}&amountIn=${amountIn.toString()}&gasInclude=true`;
  try {
    const r = await f(url, { headers: { accept: "application/json", "user-agent": "Mozilla/5.0 (RugRadar)" }, signal: AbortSignal.timeout(opts.timeoutMs ?? 2500) });
    if (r.status === 404 || r.status === 400) return { noRoute: true, impactPct: null };
    if (!r.ok) return null;
    const j: any = await r.json();
    const s = j?.data?.routeSummary;
    if (!s || j?.code && Number(j.code) !== 0) {
      const msg = String(j?.message ?? j?.data?.message ?? "").toLowerCase();
      if (r.status >= 400 || /route|not (found|exist)|no (path|route)/i.test(msg)) return { noRoute: true, impactPct: null };
      return null;
    }
    const outAmt = s.amountOut ?? s.outputAmount;
    if (outAmt == null || String(outAmt) === "0") return { noRoute: true, impactPct: null };
    const inUsd = Number(s.amountInUsd), outUsd = Number(s.amountOutUsd), gasUsd = Number(s.gasUsd) || 0;
    let impactPct: number | null = null;
    if (inUsd > 0 && Number.isFinite(outUsd)) {
      impactPct = +(((inUsd - outUsd - gasUsd) / inUsd) * 100).toFixed(2);
    }
    return { noRoute: false, impactPct: impactPct != null && Number.isFinite(impactPct) ? impactPct : null };
  } catch {
    return null;
  }
}

/** Add danger-only sell warnings. Unknown quotes add nothing; do not stack on an existing honeypot. */
export function applyEvmSellWarnings<T extends { check: string; points: number; detail: string }>(reasons: T[], quote: EvmSellQuote | null, liquidityUsd: number | null): T[] {
  if (!quote) return reasons;
  const hasHp = reasons.some((x) => x.check === "honeypot" && x.points > 0);
  const r = reasons.filter((x) => x.check !== "sell_route" && x.check !== "sell_impact") as T[];
  if (quote.noRoute && (liquidityUsd ?? 0) > 1000 && !hasHp) {
    r.push({ check: "sell_route", points: 60, detail: "No way to sell this token was found." } as T);
  }
  if (!quote.noRoute && quote.impactPct != null && quote.impactPct > 20) {
    r.push({ check: "sell_impact", points: 10, detail: "A ~$100 sale moves the price over 20%." } as T);
  }
  return r;
}
