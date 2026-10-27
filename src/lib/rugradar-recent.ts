/**
 * RugRadar "Recent" checks for credit-key users. When a FULL report is unlocked with a credit key, the report is kept
 * against that key (stored under the key's SHA-256 hash, never the key): last 20, newest first, one per chain+address,
 * expiring after 30 days. Reloading a saved report costs nothing. Free checks are never saved.
 * Storage: one small JSON document per key in the same durable store as the credits (credits.ts loadDoc/saveDoc), written
 * in a debounced batch so a burst of unlocks is one commit. Nothing is held in memory except writes not yet flushed.
 */
import { hashKey } from "./credits.js";
import { cleanTokenText } from "./token-name.js";

export const RECENT_MAX = 20, RECENT_TTL_MS = 30 * 86_400_000, RECENT_ENTRY_BYTES = 32_000, RECENT_FLUSH_MS = 15_000;
export type RecentItem = { address: string; chain: string; name: string; score: number; at: number; report: unknown };
type Doc = { v: 1; items: RecentItem[] };
export type RecentStore = { load: (name: string) => Promise<Doc | null>; save: (docs: Record<string, Doc | null>, msg: string) => Promise<void> };

const docName = (key: string) => `recent-${hashKey(key).slice(0, 32)}.json`;
export const recentId = (chain: string, address: string) => `${chain}:${address.startsWith("0x") ? address.toLowerCase() : address}`;
const shortAddr = (a: string) => (a.length > 14 ? `${a.slice(0, 4)}\u2026${a.slice(-6)}` : a);

export function createRecent(store: RecentStore, opts: { flushMs?: number; now?: () => number } = {}) {
  const now = opts.now ?? Date.now, flushMs = opts.flushMs ?? RECENT_FLUSH_MS;
  const pending = new Map<string, Doc | null>(); // doc name -> latest content not yet written
  let timer: NodeJS.Timeout | null = null, lane: Promise<unknown> = Promise.resolve();
  const serial = <T>(f: () => Promise<T>): Promise<T> => { const p = lane.then(f, f); lane = p.catch(() => {}); return p; };
  const fresh = (items: RecentItem[]) => items.filter((i) => i && typeof i.at === "number" && now() - i.at < RECENT_TTL_MS);
  const read = async (name: string): Promise<RecentItem[]> => {
    if (pending.has(name)) return pending.get(name)?.items ?? [];
    const d = await store.load(name).catch(() => null);
    return Array.isArray(d?.items) ? d!.items : [];
  };
  const stage = (name: string, items: RecentItem[]) => {
    pending.set(name, items.length ? { v: 1, items } : null);
    if (pending.size > 200) pending.delete(pending.keys().next().value!);
    if (!timer) { timer = setTimeout(() => { timer = null; flush().catch(() => {}); }, flushMs); timer.unref?.(); }
  };
  async function flush() {
    if (timer) { clearTimeout(timer); timer = null; }
    await serial(async () => {
      if (!pending.size) return;
      const batch = new Map(pending);
      try {
        await store.save(Object.fromEntries(batch), "recent");
        for (const [n, v] of batch) if (pending.get(n) === v) pending.delete(n);
      } catch { if (!timer) { timer = setTimeout(() => { timer = null; flush().catch(() => {}); }, flushMs * 4); timer.unref?.(); } }
    });
  }
  /** Save one unlocked full report. Never throws; returns whether it was kept. */
  function save(key: string, report: any): Promise<boolean> {
    return serial(async () => {
      try {
        const address = String(report?.token ?? ""), chain = String(report?.chain ?? ""), score = Number(report?.riskScore);
        if (!address || address.length > 64 || !chain || !Number.isFinite(score)) return false;
        let body: any = report;
        if (Buffer.byteLength(JSON.stringify(body)) > RECENT_ENTRY_BYTES) { body = { ...report }; delete body.liveReport; if (Buffer.byteLength(JSON.stringify(body)) > RECENT_ENTRY_BYTES) return false; }
        const fx = report?.facts, sym = cleanTokenText(fx?.tokenSymbol ?? fx?.token, 20), nm = cleanTokenText(fx?.tokenName, 32), name = sym ? (/\s/.test(sym) ? sym : `$${sym}`) : nm || shortAddr(address);
        const name_ = docName(key), id = recentId(chain, address);
        const items = fresh(await read(name_)).filter((i) => recentId(i.chain, i.address) !== id);
        items.unshift({ address, chain, name, score: Math.round(score), at: now(), report: body });
        stage(name_, items.slice(0, RECENT_MAX));
        return true;
      } catch { return false; }
    });
  }
  /** List (no reports) for a key. */
  const list = (key: string) => serial(async () => {
    const name = docName(key), all = await read(name), items = fresh(all);
    if (items.length !== all.length) stage(name, items); // drop expired entries from the store
    return items.map((i) => ({ id: recentId(i.chain, i.address), name: i.name, address: i.address, shortAddress: shortAddr(i.address), chain: i.chain, score: i.score, at: i.at }));
  });
  /** One saved report, only from this key's own document. */
  async function get(key: string, chain: string, address: string): Promise<RecentItem | null> {
    const id = recentId(chain, address);
    return fresh(await read(docName(key))).find((i) => recentId(i.chain, i.address) === id) ?? null;
  }
  return { save, list, get, flush, pendingCount: () => pending.size };
}
export type Recent = ReturnType<typeof createRecent>;
