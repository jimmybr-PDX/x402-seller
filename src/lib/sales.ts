/**
 * Sales history that survives deploys with no disk and no paid service: rebuilt at startup (and every 30 min)
 * from public sources only: on-chain USDC transfers to the payTo wallets on Solana (public RPC, last 30d) and
 * Base (Blockscout, falling back to public Base RPC for the last 48h), plus the Coinbase Bazaar per-tool
 * 30-day call counts. A failed source is reported as unknown (null), never as 0. Other EVM chains are not
 * fully scanned (public getLogs limits); Solana is where most recent tool payments have been settling.
 */
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const USDC_SOL = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const CDP = "https://api.cdp.coinbase.com/platform/v2/x402/discovery";
const RPCS = (process.env.BASE_RPCS ?? "https://base.gateway.tenderly.co|https://base-rpc.publicnode.com|https://mainnet.base.org").split("|");
const SOL_RPCS = (process.env.SOLANA_RPCS ?? "https://api.mainnet-beta.solana.com").split("|");
const OWN = (process.env.OWN_ADDRS ?? "0x4862dac2c03fAA8B36A23D176932945193B04940").toLowerCase().split(",");
export type Sale = { at: string; from: string; usd: number; tx: string; chain?: "base" | "solana" };
export type PayTos = { evm: string[]; svm: string[] };
type State = { refreshedAt: string | null; onchain: { source: string | null; error: string | null; sales: Sale[] }; bazaar: { error: string | null; tools: Record<string, { calls30d: number | null; payers30d: number | null; lastCalledAt: string | null }> } };
let state: State = { refreshedAt: null, onchain: { source: null, error: null, sales: [] }, bazaar: { error: null, tools: {} } };
export const isSale = (from: string, usd: number) => !OWN.includes(from.toLowerCase()) && usd > 0 && usd <= 1; // top-ups > $1 are not sales

async function getJson(url: string, init?: RequestInit): Promise<any> {
  const r = await fetch(url, { ...init, headers: { "user-agent": "x402-seller-sales/1 (self)", "content-type": "application/json", ...(init?.headers ?? {}) }, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}
async function rpc(url: string, method: string, params: unknown[]) {
  const j = await getJson(url, { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  if (j.error) throw new Error(j.error.message ?? "rpc error");
  return j.result;
}
function uniqAddrs(xs: string[]) { return [...new Set(xs.map((a) => a.trim()).filter(Boolean))]; }

async function onchainBase(payTos: string[]): Promise<{ source: string | null; error: string | null; sales: Sale[] }> {
  const addrs = uniqAddrs(payTos);
  let err = "";
  const all: Sale[] = [];
  let source: string | null = null;
  try {
    for (const payTo of addrs) {
      const b = await getJson(`https://base.blockscout.com/api/v2/addresses/${payTo}/token-transfers?type=ERC-20&filter=to&token=${USDC_BASE}`);
      if (!Array.isArray(b?.items)) continue;
      source = "blockscout (50 most recent USDC transfers on Base)";
      all.push(...b.items.filter((t: any) => t.to?.hash?.toLowerCase() === payTo.toLowerCase()).map((t: any) => ({ at: t.timestamp, from: t.from.hash, usd: Number(t.total.value) / 1e6, tx: t.transaction_hash, chain: "base" as const })).filter((s: Sale) => isSale(s.from, s.usd)));
    }
    if (source) return { source, error: null, sales: all };
  } catch (e) { err = `blockscout: ${String((e as Error).message).slice(0, 60)}`; }
  for (const url of RPCS) {
    try {
      const latest = parseInt(await rpc(url, "eth_blockNumber", []), 16);
      const chunks: [number, number][] = [];
      for (let b = latest - 86400; b <= latest; b += 500) chunks.push([b, Math.min(b + 499, latest)]);
      const logs: { payTo: string; log: any }[] = [];
      for (const payTo of addrs) {
        const topic = "0x" + payTo.slice(2).toLowerCase().padStart(64, "0");
        for (let i = 0; i < chunks.length; i += 6) for (const g of await Promise.all(chunks.slice(i, i + 6).map(([f, t]) => rpc(url, "eth_getLogs", [{ address: USDC_BASE, fromBlock: "0x" + f.toString(16), toBlock: "0x" + t.toString(16), topics: ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef", null, topic] }])))) logs.push(...g.map((log: any) => ({ payTo, log })));
      }
      const sales: Sale[] = [];
      const blkCache = new Map<string, any>();
      for (const { log: l } of logs) {
        const from = "0x" + l.topics[1].slice(-40), usd = parseInt(l.data, 16) / 1e6;
        if (!isSale(from, usd)) continue;
        const blk = blkCache.get(l.blockNumber) ?? await rpc(url, "eth_getBlockByNumber", [l.blockNumber, false]);
        blkCache.set(l.blockNumber, blk);
        sales.push({ at: new Date(parseInt(blk.timestamp, 16) * 1000).toISOString(), from, usd, tx: l.transactionHash, chain: "base" });
      }
      return { source: `base rpc ${new URL(url).host}, last 48h`, error: err || null, sales: sales.sort((a, b) => Date.parse(b.at) - Date.parse(a.at)) };
    } catch (e) { err += `; ${new URL(url).host}: ${String((e as Error).message).slice(0, 60)}`; }
  }
  return { source: null, error: err, sales: [] };
}

async function onchainSolana(payTos: string[]): Promise<{ source: string | null; error: string | null; sales: Sale[] }> {
  const addrs = uniqAddrs(payTos);
  if (!addrs.length) return { source: null, error: null, sales: [] };
  const cutoff = Math.floor(Date.now() / 1000) - 30 * 86400;
  let err = "";
  for (const url of SOL_RPCS) {
    try {
      const sales: Sale[] = [];
      for (const owner of addrs) {
        const accs = await rpc(url, "getTokenAccountsByOwner", [owner, { mint: USDC_SOL }, { encoding: "jsonParsed" }]);
        const atas: string[] = (accs?.value ?? []).map((a: any) => a.pubkey).filter(Boolean);
        for (const ata of atas) {
          const sigs: { signature: string; blockTime?: number }[] = [];
          let before: string | undefined;
          for (let n = 0; n < 20; n++) {
            const page: any[] = await rpc(url, "getSignaturesForAddress", [ata, { limit: 100, ...(before ? { before } : {}) }]);
            if (!page?.length) break;
            sigs.push(...page);
            const oldest = page[page.length - 1];
            if ((oldest?.blockTime ?? Date.now() / 1000) < cutoff || page.length < 100) break;
            before = oldest.signature;
          }
          const recent = sigs.filter((s) => (s.blockTime ?? 0) >= cutoff);
          for (let i = 0; i < recent.length; i += 3) {
            const batch = recent.slice(i, i + 3);
            const txs = await Promise.all(batch.map((s) => rpc(url, "getTransaction", [s.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }])));
            for (let j = 0; j < batch.length; j++) {
              const tx = txs[j], s = batch[j];
              if (!tx?.meta || tx.meta.err) continue;
              const pre = new Map<string, number>((tx.meta.preTokenBalances ?? []).filter((b: any) => b.mint === USDC_SOL).map((b: any) => [String(b.owner), Number(b.uiTokenAmount?.uiAmount ?? 0)]));
              const post = new Map<string, number>((tx.meta.postTokenBalances ?? []).filter((b: any) => b.mint === USDC_SOL).map((b: any) => [String(b.owner), Number(b.uiTokenAmount?.uiAmount ?? 0)]));
              const usd = (post.get(owner) ?? 0) - (pre.get(owner) ?? 0);
              let from = "";
              for (const k of new Set([...pre.keys(), ...post.keys()])) {
                if (k === owner) continue;
                const d = (post.get(k) ?? 0) - (pre.get(k) ?? 0);
                if (d < 0 && (!from || Math.abs(d + usd) < 1e-9)) from = k;
              }
              if (!isSale(from || "unknown", usd)) continue;
              sales.push({ at: new Date((tx.blockTime ?? s.blockTime ?? 0) * 1000).toISOString(), from: from || "unknown", usd: Math.round(usd * 1e6) / 1e6, tx: s.signature, chain: "solana" });
            }
          }
        }
      }
      return { source: `solana rpc ${new URL(url).host}, last 30d`, error: err || null, sales: sales.sort((a, b) => Date.parse(b.at) - Date.parse(a.at)) };
    } catch (e) { err += `${err ? "; " : ""}${new URL(url).host}: ${String((e as Error).message).slice(0, 60)}`; }
  }
  return { source: null, error: err, sales: [] };
}

function mergeSales(...lists: Sale[][]) {
  const seen = new Set<string>(), out: Sale[] = [];
  for (const list of lists) for (const s of list) { const k = `${s.chain ?? ""}:${s.tx}`; if (seen.has(k)) continue; seen.add(k); out.push(s); }
  return out.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

async function onchain(payTos: PayTos): Promise<State["onchain"]> {
  const [base, sol] = await Promise.all([onchainBase(payTos.evm).catch((e) => ({ source: null, error: String(e), sales: [] as Sale[] })), onchainSolana(payTos.svm).catch((e) => ({ source: null, error: String(e), sales: [] as Sale[] }))]);
  const parts = [base.source, sol.source].filter(Boolean);
  const errs = [base.error, sol.error].filter(Boolean).join("; ") || null;
  if (!parts.length) return { source: null, error: errs, sales: [] };
  // A failed chain is named in error (and in source) so a 48h Base-only result is never presented as a 30d total.
  const source = [sol.source ?? (sol.error ? "solana: unavailable" : null), base.source ?? (base.error ? "base: unavailable" : null)].filter(Boolean).join(" + ");
  return { source, error: errs, sales: mergeSales(sol.sales, base.sales) };
}

async function bazaar(payTos: string[], origin: string): Promise<State["bazaar"]> {
  try {
    const tools: State["bazaar"]["tools"] = {};
    let err: string | null = null;
    for (const payTo of uniqAddrs(payTos)) {
      try {
        const m = await getJson(`${CDP}/merchant?payTo=${payTo}&limit=50`);
        for (const r of m?.resources ?? []) { if (!String(r.resource).startsWith(origin)) continue; const path = new URL(r.resource).pathname; const row = { calls30d: r.quality?.l30DaysTotalCalls ?? null, payers30d: r.quality?.l30DaysUniquePayers ?? null, lastCalledAt: r.quality?.lastCalledAt ?? null }; if (!tools[path] || (row.calls30d ?? 0) > (tools[path]!.calls30d ?? 0)) tools[path] = row; }
      } catch (e) { err = String((e as Error).message).slice(0, 80); }
    }
    if (!Object.keys(tools).length && err) return { error: err, tools };
    return { error: err, tools };
  } catch (e) { return { error: String((e as Error).message).slice(0, 80), tools: {} }; }
}
export async function refreshSales(payTos: PayTos, origin: string) {
  const evm = uniqAddrs(payTos.evm), svm = uniqAddrs(payTos.svm);
  const [o, b] = await Promise.all([onchain({ evm, svm }).catch((e) => ({ source: null, error: String(e), sales: [] })), bazaar([...evm, ...svm], origin)]);
  state = { refreshedAt: new Date().toISOString(), onchain: o, bazaar: b };
}
let timer: NodeJS.Timeout | undefined;
export function startSales(payTos: PayTos, origin: string) {
  if (process.env.SALES_REBUILD === "off" || timer) return;
  refreshSales(payTos, origin).catch(() => {});
  timer = setInterval(() => refreshSales(payTos, origin).catch(() => {}), 30 * 60_000); timer.unref();
}
export function summarize(sales: Sale[], now = Date.now()) {
  const win = (h: number) => { const s = sales.filter((x) => now - Date.parse(x.at) <= h * 3600e3); return { payments: s.length, usd: Math.round(s.reduce((a, x) => a + x.usd, 0) * 1e6) / 1e6, payers: new Set(s.map((x) => x.from.toLowerCase())).size }; };
  return { last24h: win(24), last7d: win(168), last30d: win(720) };
}
export function salesStats() {
  const calls = Object.values(state.bazaar.tools).map((t) => t.calls30d ?? 0);
  const sales = state.onchain.sales;
  const by = (chain: "base" | "solana") => summarize(sales.filter((s) => s.chain === chain));
  const windowsNote = "Solana window is last 30d; Base window is last 48h on the public RPC fallback (Blockscout is often blocked). last7d/last30d Base figures only include what that Base window covered. Other EVM chains are not fully scanned.";
  return {
    note: "Rebuilt from public on-chain data (Solana + Base payTo wallets, tools and RugRadar) and the Coinbase Bazaar at startup and every 30 min, so it survives deploys (the traffic counters above do not).",
    refreshedAt: state.refreshedAt,
    onchain: state.onchain.source ? { source: state.onchain.source, error: state.onchain.error, windows: windowsNote, ...summarize(sales), byChain: { solana: by("solana"), base: by("base") }, recent: sales.slice(0, 10) } : { source: null, error: state.onchain.error, unknown: true },
    // Kept so older readers still have the key; numbers are the Base slice only, not all settlements.
    onchainBase: state.onchain.source ? { source: state.onchain.source, note: "Base slice only. Prefer sales.onchain for combined Solana+Base totals.", ...by("base"), recent: sales.filter((s) => s.chain === "base").slice(0, 10) } : { source: null, error: state.onchain.error, unknown: true },
    bazaarCalls30d: state.bazaar.error && !Object.keys(state.bazaar.tools).length ? { error: state.bazaar.error, unknown: true } : { total: calls.reduce((a, b) => a + b, 0), byTool: state.bazaar.tools, ...(state.bazaar.error ? { error: state.bazaar.error } : {}) },
  };
}
