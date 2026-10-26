/**
 * Oct 16: Helius FREE plan (1M credits/month, 10 req/s) as first choice for the paper bots' Solana reads; free public RPCs as fallback.
 * Budget: 30,000 credits/day (≈ 0.93M/month), spread across the day (pro-rated + 3,000 slack); HTTP capped at 8 req/s.
 * Credits: 1 per HTTP call, 1 per websocket connect, 2 per 0.1 MB of websocket data (Helius LaserStream WSS metering).
 * The key comes from HELIUS_API_KEY and is never logged or shown.
 */
const KEY = process.env.HELIUS_API_KEY ?? "";
export const DAILY_BUDGET = Number(process.env.HELIUS_DAILY_CREDITS ?? 30_000);
const PUBLIC_HTTP = process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";
const day = () => new Date().toISOString().slice(0, 10);
export let heliusDaily: Record<string, { http: number; wsBytes: number; wsConnects: number; fallbacks: number; since?: number }> = {};
const today = () => (heliusDaily[day()] ??= { http: 0, wsBytes: 0, wsConnects: 0, fallbacks: 0, since: Date.now() });
const procStart = Date.now();
const creditsOf = (d: { http: number; wsBytes: number; wsConnects: number }) => d.http + d.wsConnects + Math.ceil(d.wsBytes / 100_000) * 2;
export function loadHelius(x: any) { if (x && typeof x === "object") heliusDaily = x; }
export const heliusEnabled = () => !!KEY;
/** Within today's pro-rated budget (spread evenly over the day) and the hard daily cap? */
export function budgetOk(reserve = 0) {
  if (!KEY) return false; const used = creditsOf(today()) + reserve;
  const now = new Date(); const frac = (now.getUTCHours() * 3600 + now.getUTCMinutes() * 60 + now.getUTCSeconds()) / 86400;
  return used < Math.min(DAILY_BUDGET, DAILY_BUDGET * frac + 3000);
}
const calls: number[] = [];
function rateOk() { const now = Date.now(); while (calls.length && now - calls[0] > 1000) calls.shift(); return calls.length < 8; }
/** RPC URL for one HTTP call: Helius when budget and rate allow, else the public RPC. Counts the credit. */
let publicBadUntil = 0;
/** Oct 18: the public RPC just failed (error / rate limit): use Helius for the next 60 s. */
export function markPublicBad() { publicBadUntil = Date.now() + 60_000; }
/** RPC URL for one HTTP call. preferPublic (free-feed mode): the free public RPC first, Helius only while it is failing. */
export function rpcUrl(preferPublic = false): string {
  if (preferPublic && Date.now() >= publicBadUntil) return PUBLIC_HTTP;
  if (KEY && budgetOk() && rateOk()) { calls.push(Date.now()); today().http++; return `https://mainnet.helius-rpc.com/?api-key=${KEY}`; }
  if (KEY) today().fallbacks++; return PUBLIC_HTTP;
}
export const heliusWsUrl = () => (KEY ? `wss://mainnet.helius-rpc.com/?api-key=${KEY}` : null);
export const isHeliusUrl = (u: string) => u.includes("helius-rpc.com");
export const PUBLIC_RPC_HTTP = PUBLIC_HTTP;
export function noteWs(bytes: number) { today().wsBytes += bytes; }
/** Extra HTTP credits spent outside rpcUrl() (RugRadar fallback) so the daily/monthly totals stay true. */
export function noteHttp(n = 1) { today().http += n; }
export function noteWsConnect() { today().wsConnects++; }
export function heliusStatus() {
  const days = Object.entries(heliusDaily).sort().slice(-31);
  const month = day().slice(0, 7); const monthUsed = days.filter(([d]) => d.startsWith(month)).reduce((a, [, v]) => a + creditsOf(v), 0);
  const t = today(); const now = new Date(); const startMs = Math.max(t.since ?? procStart, Date.parse(day() + "T00:00:00Z")); const frac = Math.max(0.002, (Date.now() - startMs) / 86_400_000); // projection from the rate since counting began today
  const dim = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
  return { enabled: !!KEY, plan: "Helius free (1M credits/month, 10 req/s)", dailyBudget: DAILY_BUDGET, withinBudgetNow: budgetOk(), todayCredits: creditsOf(t),
    todayDetail: { httpCalls: t.http, websocketMB: +(t.wsBytes / 1e6).toFixed(2), websocketConnects: t.wsConnects, callsSentToPublicRpcInstead: t.fallbacks },
    projectedTodayCredits: Math.round(creditsOf(t) / frac), monthToDateCredits: monthUsed, projectedMonthCredits: Math.round(monthUsed - creditsOf(t) + (creditsOf(t) / frac) * (dim - now.getUTCDate() + 1)),
    perDay: Object.fromEntries(days.map(([d, v]) => [d, creditsOf(v)])) };
}
