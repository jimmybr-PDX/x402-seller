/**
 * RugRadar score totals (shared by Solana, EVM, the free check and the share card).
 * Tiers: hard stops force High alone, high-danger flags push a coin over with one or two friends,
 * medium standalone flags count in full, and soft/noise flags are group-capped so they stay small.
 * Thresholds: Low < 25, Medium 25-49, High >= 50, cap 100.
 */
export type ScoredCheck = { check: string; points: number; detail: string; shownOnly?: boolean };

/** Soft / noise flags: their combined contribution is capped at SOFT_CAP. */
export const SOFT_CHECKS = ["trading_cooldown", "age", "proxy", "first_minute_selling", "heavy_selling", "first_minute_thin", "inorganic_volume", "no_socials", "known_snipers", "thin_trading", "metadata_mutable"] as const;
export const SOFT_CAP = 15;
const SOFT = new Set<string>(SOFT_CHECKS);
/** Same power described twice (an outside authority can take or edit holders' tokens): counted once, highest wins. */
export const STEAL_CHECKS = ["permanent_delegate", "balance_mutable"] as const;
const STEAL = new Set<string>(STEAL_CHECKS);
/** Hard stops: each one forces High by itself (also counted by the free check). */
export const HARD_STOP_CHECKS = ["honeypot", "sell_route", "permanent_delegate", "balance_mutable", "owner_change_balance", "transfer_control", "fake_token", "dead_token"] as const;
export const DEAD_FLOOR = 50;
/** Bumped when weights change, so watches re-baseline their score instead of alerting on a recalibration. v2 = Nov 25 2026. */
export const SCORE_VERSION = 2;

export const levelOf = (score: number): "low" | "medium" | "high" => (score >= 50 ? "high" : score >= 25 ? "medium" : "low");

/** 0-100 total: full points for hard/high/medium checks, the steal pair counted once, soft flags capped at SOFT_CAP. */
export function totalScore(checks: readonly { check?: string; points?: unknown; shownOnly?: boolean }[] | null | undefined): number {
  let main = 0, soft = 0, steal = 0;
  for (const c of Array.isArray(checks) ? checks : []) {
    if (!c || c.shownOnly) continue;
    const p = Number(c.points) || 0;
    if (p <= 0) continue;
    const k = String(c.check ?? "");
    if (STEAL.has(k)) steal = Math.max(steal, p);
    else if (SOFT.has(k)) soft += p;
    else main += p;
  }
  return Math.min(100, Math.round(main + steal + Math.min(SOFT_CAP, soft)));
}

/** When both steal-power checks fire, keep the higher one scored and show the other at 0 points (counted once). Mutates and returns. */
export function dedupeSteal<T extends { check: string; points: number; detail: string }>(checks: T[]): T[] {
  const hits = checks.filter((c) => STEAL.has(c.check) && c.points > 0).sort((a, b) => b.points - a.points);
  for (const c of hits.slice(1)) { c.points = 0; c.detail += " (counted once together with the other take-your-tokens warning)"; }
  return checks;
}

/** Points a dead_token reason needs so the total lands at the floor (at least 5, as before). */
export function deadTokenPoints(scoreWithoutDead: number): number {
  return Math.max(5, DEAD_FLOOR - scoreWithoutDead);
}
