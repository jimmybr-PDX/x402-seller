/** Oct 29: RugRadar running totals for /stats: free web checks, paid full reports (x402 or credits), owner checks (kept apart).
 * Tiny: one {free,paid,owner} row per PT day (kept 400 days). Durable like traffic.json: stored as rugradar-counts.json in the
 * private GitHub store; each save re-reads the remote doc and adds only this instance's unsaved deltas, so overlapping
 * instances during a deploy never overwrite each other. Saves ~8 s after any change (debounced, non-blocking), every 6 h
 * as a backstop, and on SIGTERM. */
export type Kind = "free" | "paid" | "owner";
export type RejectReason = "freeUsedUp" | "rateLimited" | "invalidInput" | "error";
const REASONS: RejectReason[] = ["freeUsedUp", "rateLimited", "invalidInput", "error"];
type Row = { free: number; paid: number; owner: number; rej?: Partial<Record<RejectReason, number>> };
type Doc = { v: 1; savedAt: string; days: Record<string, Row> };
export type CountsStore = { load: () => Promise<unknown>; sync: () => Promise<void>; write: (doc: Doc) => Promise<void> };

const KEEP_DAYS = 400;
const blank = (): Row => ({ free: 0, paid: 0, owner: 0 });
let base: Record<string, Row> = {};     // last known durable copy
let pending: Record<string, Row> = {};  // this instance's increments not yet saved
let inflight: Record<string, Row> = {}; // being written right now
let store: CountsStore | null = null;
const DEBOUNCE_MS = 8000;
let timer: ReturnType<typeof setTimeout> | null = null;
let saving = false;
function schedule() { if (!store || timer) return; timer = setTimeout(() => { timer = null; void saveCounts(); }, DEBOUNCE_MS); timer.unref?.(); }
let status: { store: string | null; restored: boolean; lastSavedAt: string | null; error?: string } = { store: null, restored: false, lastSavedAt: null };

export const ptDay = (d = new Date()) => d.toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) && x > 0 ? Math.floor(x) : 0);
function clean(j: unknown): Record<string, Row> {
  const out: Record<string, Row> = {};
  const days = (j as Doc | null)?.days;
  if (days && typeof days === "object") for (const [k, r] of Object.entries(days)) if (/^\d{4}-\d{2}-\d{2}$/.test(k)) { out[k] = { free: num(r?.free), paid: num(r?.paid), owner: num(r?.owner) }; const rj: Partial<Record<RejectReason, number>> = {}; for (const x of REASONS) if (num(r?.rej?.[x])) rj[x] = num(r?.rej?.[x]); if (Object.keys(rj).length) out[k].rej = rj; }
  return out;
}
function add(into: Record<string, Row>, from: Record<string, Row>) {
  for (const [k, r] of Object.entries(from)) { const t = (into[k] ??= blank()); t.free += r.free; t.paid += r.paid; t.owner += r.owner; addRej(t, r); }
}
function addRej(t: Row, r: Row) { for (const x of REASONS) if (r.rej?.[x]) { t.rej ??= {}; t.rej[x] = (t.rej[x] ?? 0) + r.rej[x]!; } }
function trim(m: Record<string, Row>) { const ks = Object.keys(m).sort(); for (const k of ks.slice(0, Math.max(0, ks.length - KEEP_DAYS))) delete m[k]; }

export function countRugradar(kind: Kind): void { (pending[ptDay()] ??= blank())[kind]++; schedule(); }

/** Rejected free-check attempts (non-owner, /rugradar/api/check). */
export function countRugradarRejected(reason: RejectReason): void { const r = (pending[ptDay()] ??= blank()); r.rej ??= {}; r.rej[reason] = (r.rej[reason] ?? 0) + 1; schedule(); }

export function rugradarStats() {
  const all: Record<string, Row> = {}; add(all, base); add(all, inflight); add(all, pending);
  const today = all[ptDay()] ?? blank();
  const tot = blank(); for (const r of Object.values(all)) { tot.free += r.free; tot.paid += r.paid; tot.owner += r.owner; addRej(tot, r); }
  const shape = (r: Row) => ({ rugradarFreeChecks: r.free, rugradarPaidReports: r.paid, rugradarTotal: r.free + r.paid, rugradarOwnerChecks: r.owner, rugradarRejected: REASONS.reduce((a, x) => a + (r.rej?.[x] ?? 0), 0), rugradarRejectedByReason: Object.fromEntries(REASONS.map((x) => [x, r.rej?.[x] ?? 0])) });
  return { today: { day: ptDay(), ...shape(today) }, allTime: shape(tot), persistence: status, note: "free = daily free web checks (/rugradar/api/check); paid = full reports via x402 or credit keys; total = free + paid; owner-key and self-paid checks counted separately. Days are Pacific time." };
}

export async function saveCounts(): Promise<void> {
  if (!store || !Object.keys(pending).length) return;
  if (saving) { schedule(); return; }
  saving = true;
  const mine = pending; pending = {}; inflight = mine;
  try {
    await store.sync();
    const remote = clean(await store.load()); add(remote, mine); trim(remote);
    await store.write({ v: 1, savedAt: new Date().toISOString(), days: remote });
    base = remote; status.lastSavedAt = new Date().toISOString(); delete status.error;
  } catch (e) { add(pending, mine); status.error = String((e as Error)?.message ?? e).slice(0, 200); }
  finally { inflight = {}; saving = false; if (Object.keys(pending).length) schedule(); }
}

export async function attachCounts(name: string, s: CountsStore, everyMs = 6 * 3600e3): Promise<void> {
  store = s; status.store = name;
  try { base = clean(await s.load()); status.restored = true; } catch (e) { status.error = String((e as Error)?.message ?? e).slice(0, 200); }
  setInterval(() => void saveCounts(), everyMs).unref();
  schedule();
  // runs before traffic's SIGTERM handler; the store serializes writes, so this commit lands before traffic's final save exits.
  process.prependListener("SIGTERM", () => void saveCounts());
}

/** Tests only. */
export function _resetCounts() { base = {}; pending = {}; store = null; saving = false; if (timer) clearTimeout(timer); timer = null; status = { store: null, restored: false, lastSavedAt: null }; }
