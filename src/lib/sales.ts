/**
 * Sales history that survives deploys with no disk and no paid service: rebuilt at startup (and every 30 min)
 * from public sources only: on-chain USDC transfers to the payTo wallet on Base (Blockscout, falling back to
 * public Base RPC for the last 48h) and the Coinbase Bazaar per-tool 30-day call counts. A failed source is
 * reported as unknown (null), never as 0.
 */
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const CDP = "https://api.cdp.coinbase.com/platform/v2/x402/discovery";
const RPCS = (process.env.BASE_RPCS ?? "https://base.gateway.tenderly.co|https://base-rpc.publicnode.com|https://mainnet.base.org").split("|");
const OWN = (process.env.OWN_ADDRS ?? "0x4862dac2c03fAA8B36A23D176932945193B04940").toLowerCase().split(",");
export type Sale = { at: string; from: string; usd: number; tx: string };
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
async function onchain(payTo: string): Promise<State["onchain"]> {
  let err = "";
  try {
    const b = await getJson(`https://base.blockscout.com/api/v2/addresses/${payTo}/token-transfers?type=ERC-20&filter=to&token=${USDC}`);
    if (Array.isArray(b?.items)) return { source: "blockscout (50 most recent USDC transfers on Base)", error: null,
      sales: b.items.filter((t: any) => t.to?.hash?.toLowerCase() === payTo.toLowerCase()).map((t: any) => ({ at: t.timestamp, from: t.from.hash, usd: Number(t.total.value) / 1e6, tx: t.transaction_hash })).filter((s: Sale) => isSale(s.from, s.usd)) };
  } catch (e) { err = `blockscout: ${String((e as Error).message).slice(0, 60)}`; }
  const topic = "0x" + payTo.slice(2).toLowerCase().padStart(64, "0");
  for (const url of RPCS) {
    try {
      const latest = parseInt(await rpc(url, "eth_blockNumber", []), 16);
      const chunks: [number, number][] = [];
      for (let b = latest - 86400; b <= latest; b += 500) chunks.push([b, Math.min(b + 499, latest)]);
      const logs: any[] = [];
      for (let i = 0; i < chunks.length; i += 6) for (const g of await Promise.all(chunks.slice(i, i + 6).map(([f, t]) => rpc(url, "eth_getLogs", [{ address: USDC, fromBlock: "0x" + f.toString(16), toBlock: "0x" + t.toString(16), topics: ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef", null, topic] }])))) logs.push(...g);
      const sales: Sale[] = [];
      for (const l of logs) {
        const from = "0x" + l.topics[1].slice(-40), usd = parseInt(l.data, 16) / 1e6;
        if (!isSale(from, usd)) continue;
        const blk = await rpc(url, "eth_getBlockByNumber", [l.blockNumber, false]);
        sales.push({ at: new Date(parseInt(blk.timestamp, 16) * 1000).toISOString(), from, usd, tx: l.transactionHash });
      }
      return { source: `base rpc ${new URL(url).host}, last 48h`, error: err || null, sales: sales.reverse() };
    } catch (e) { err += `; ${new URL(url).host}: ${String((e as Error).message).slice(0, 60)}`; }
  }
  return { source: null, error: err, sales: [] };
}
async function bazaar(payTo: string, origin: string): Promise<State["bazaar"]> {
  try {
    const m = await getJson(`${CDP}/merchant?payTo=${payTo}&limit=50`);
    const tools: State["bazaar"]["tools"] = {};
    for (const r of m?.resources ?? []) { if (!String(r.resource).startsWith(origin)) continue; tools[new URL(r.resource).pathname] = { calls30d: r.quality?.l30DaysTotalCalls ?? null, payers30d: r.quality?.l30DaysUniquePayers ?? null, lastCalledAt: r.quality?.lastCalledAt ?? null }; }
    return { error: null, tools };
  } catch (e) { return { error: String((e as Error).message).slice(0, 80), tools: {} }; }
}
export async function refreshSales(payTo: string, origin: string) {
  const [o, b] = await Promise.all([onchain(payTo).catch((e) => ({ source: null, error: String(e), sales: [] })), bazaar(payTo, origin)]);
  state = { refreshedAt: new Date().toISOString(), onchain: o, bazaar: b };
}
let timer: NodeJS.Timeout | undefined;
export function startSales(payTo: string, origin: string) {
  if (process.env.SALES_REBUILD === "off" || timer) return;
  refreshSales(payTo, origin).catch(() => {});
  timer = setInterval(() => refreshSales(payTo, origin).catch(() => {}), 30 * 60_000); timer.unref();
}
export function summarize(sales: Sale[], now = Date.now()) {
  const win = (h: number) => { const s = sales.filter((x) => now - Date.parse(x.at) <= h * 3600e3); return { payments: s.length, usd: Math.round(s.reduce((a, x) => a + x.usd, 0) * 1e6) / 1e6, payers: new Set(s.map((x) => x.from.toLowerCase())).size }; };
  return { last24h: win(24), last7d: win(168), last30d: win(720) };
}
export function salesStats() {
  const calls = Object.values(state.bazaar.tools).map((t) => t.calls30d ?? 0);
  return {
    note: "Rebuilt from public on-chain data and the Coinbase Bazaar at startup and every 30 min, so it survives deploys (the traffic counters above do not).",
    refreshedAt: state.refreshedAt,
    onchainBase: state.onchain.source ? { source: state.onchain.source, ...summarize(state.onchain.sales), recent: state.onchain.sales.slice(0, 10) } : { source: null, error: state.onchain.error, unknown: true },
    bazaarCalls30d: state.bazaar.error ? { error: state.bazaar.error, unknown: true } : { total: calls.reduce((a, b) => a + b, 0), byTool: state.bazaar.tools },
  };
}
