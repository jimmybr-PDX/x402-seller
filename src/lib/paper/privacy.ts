/**
 * Oct 18: private paper signals never leave the server on public endpoints. Public /paper, /paper.json, /paper/trades.json,
 * /paper/rugradar(.json) show performance only; private fields (named wallets, inflow, graduation signs, winning-wallet tracking,
 * known-good dev, creator family, name history, coinFactoryFunder) are stripped. Full data: the private GitHub paper store
 * (data/trades.jsonl, data/scorecard.json), or these endpoints with header X-Paper-Admin-Key equal to env PAPER_ADMIN_KEY
 * (admin access is off while PAPER_ADMIN_KEY is unset).
 */
import { createHash, timingSafeEqual } from "node:crypto";
import type { Request } from "express";
export const PRIVATE_KEYS = new Set(["family", "familyKnown", "familyTests", "familySummary", "priv", "privateSignals", "named", "namedWallet", "trust", "coinFactoryFunder",
  "winnerBuyers", "winnersTracked", "privateInflow", "netInflowSol", "names", "nameTests", "cpTop", "cpSeen", "knownGood", "siblings", "inflowDiag", "hops", "funder", "ruggerHop", "devGraduated", "devLaunches", "priorGraduated", "graduated24h"]);
const PRIVATE_TEXT = /inflow|winner|wallet|known.?good|good dev|family|funder|name history|same.?name|graduat|coin.?factory|named/i;
const PRIVATE_KEYNAME = /winner|wallet|family|funder|named|known.?good|good.?dev/i; // any key naming a private signal (e.g. exit-reason counts)
const REASON_KEYS = new Set(["rule", "description", "reason", "exitReason", "entryReason", "why"]);
export const PRIVATE_EXIT = "private_signal_exit";
export const PRIVATE_RULE = "private test (rule details are not public)";
export function isAdmin(req: Request, env = process.env): boolean {
  const want = env.PAPER_ADMIN_KEY ?? "", got = String(req.header("x-paper-admin-key") ?? "");
  if (want.length < 16 || !got) return false;
  const a = createHash("sha256").update(want).digest(), b = createHash("sha256").update(got).digest();
  return timingSafeEqual(a, b);
}
/** Deep copy without private fields; rule/description text that names a private signal is replaced; private counters dropped. */
export function redact<T>(x: T): T {
  const walk = (v: any, key = ""): any => {
    if (Array.isArray(v)) return v.map((y) => walk(y));
    if (v && typeof v === "object") {
      const o: any = {};
      for (const [k, y] of Object.entries(v)) {
        if (PRIVATE_KEYS.has(k)) continue;
        if (key === "counters" && PRIVATE_TEXT.test(k)) continue;
        if (PRIVATE_KEYNAME.test(k)) continue;
        if (REASON_KEYS.has(k) && typeof y === "string" && PRIVATE_TEXT.test(y)) { o[k] = k === "rule" ? PRIVATE_RULE : /reason/i.test(k) ? PRIVATE_EXIT : "private"; continue; }
        o[k] = walk(y, k);
      }
      return o;
    }
    return v;
  };
  return walk(x);
}
/** True if any private key survives anywhere in the value (used by tests and as a guard). */
export function leaksPrivate(x: unknown): string | null {
  let hit: string | null = null;
  const walk = (v: any) => { if (hit) return; if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === "object") for (const [k, y] of Object.entries(v)) { if (PRIVATE_KEYS.has(k)) { hit = k; return; } walk(y); } };
  walk(x); return hit;
}
