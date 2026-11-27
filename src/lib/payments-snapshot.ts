/**
 * Tiny public JSON for the box health monitor: paid RugRadar counters only.
 * Same field paths as /stats that paid_check.extract_snapshot reads, without
 * the ~60 KB traffic dump. Never includes payer / from addresses.
 */
import { trafficStats } from "./traffic.js";
import { rugradarStats } from "./rugradar-counts.js";
import { salesStats } from "./sales.js";

export const RUG_PAID_ROUTES = ["/rug-check", "/token-safety", "/honeypot-check", "/credits/buy"] as const;

type RouteRow = { paid200?: number };
type Recent = { tx?: unknown; chain?: unknown; usd?: unknown; at?: unknown; from?: unknown };

export function paymentsSnapshot(paidRoutes: string[]) {
  const stats = trafficStats(paidRoutes, true) as { allTime?: { routes?: Record<string, RouteRow> } };
  const rr = rugradarStats();
  const sales = salesStats() as { onchain?: { recent?: Recent[] } };
  const allRoutes = stats.allTime?.routes ?? {};
  const routes: Record<string, { paid200: number }> = {};
  for (const path of RUG_PAID_ROUTES) {
    const n = Number(allRoutes[path]?.paid200 ?? 0);
    routes[path] = { paid200: Number.isFinite(n) && n > 0 ? n : 0 };
  }
  const recent = (sales.onchain?.recent ?? [])
    .filter((s) => typeof s?.tx === "string" && s.tx)
    .slice(0, 10)
    .map((s) => ({
      tx: s.tx as string,
      ...(typeof s.chain === "string" ? { chain: s.chain } : {}),
      ...(typeof s.usd === "number" ? { usd: s.usd } : {}),
      ...(typeof s.at === "string" ? { at: s.at } : {}),
    }));
  return {
    rugradar: {
      allTime: { rugradarPaidReports: rr.allTime.rugradarPaidReports },
      today: { day: rr.today.day, rugradarPaidReports: rr.today.rugradarPaidReports },
    },
    allTime: { routes },
    sales: { onchain: { recent } },
  };
}
