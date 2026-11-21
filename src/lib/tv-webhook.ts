// Nov 2: TradingView webhook receiver (paper only). Shared secret TV_WEBHOOK_SECRET via ?key= or JSON "key".
// Box pulls via GET /tv/alerts.json?key=&since=&afterId=.
// Nov 21: alerts persist in the already-configured RugRadar GitHub store (no Render disk on the free plan).
// Append-only JSONL batches + meta; cap 30 days or 20k rows; load on boot; ids stay unique across restarts.
import express, { type Express, type Request, type Response } from "express";
import { timingSafeEqual } from "node:crypto";

export type TvAlert = { id: number; received: string; receivedMs: number; body: unknown };
export type TvAlertMeta = { v: 1; nextId: number; savedAt: string; savedThroughId: number };
export type TvAlertStore = {
  name: string;
  load: () => Promise<{ meta?: TvAlertMeta | null; files: Record<string, string> }>;
  write: (docs: Record<string, string | null>, msg: string) => Promise<void>;
};

const MAX_ROWS_DEFAULT = 20_000;
const MAX_AGE_DEFAULT = 30 * 24 * 3600e3;
function maxRows() { const n = Number(process.env.TV_ALERTS_MAX); return Number.isFinite(n) && n > 0 ? Math.floor(n) : MAX_ROWS_DEFAULT; }
function maxAgeMs() { const n = Number(process.env.TV_ALERTS_MAX_AGE_MS); return Number.isFinite(n) && n > 0 ? n : MAX_AGE_DEFAULT; }

const alerts: TvAlert[] = [];
let nextId = 1;
let savedThroughId = 0;
let instanceFile = "";
let store: TvAlertStore | null = null;
let loaded: Promise<void> = Promise.resolve();
let lastSavedAt: string | null = null;
let restoredFrom: string | null = null;
let restoredRows = 0;
const hits = new Map<string, number[]>();

function okKey(k: unknown): boolean {
  const s = process.env.TV_WEBHOOK_SECRET || "";
  if (!s || typeof k !== "string" || k.length !== s.length) return false;
  return timingSafeEqual(Buffer.from(k), Buffer.from(s));
}
function limited(ip: string, max: number): boolean {
  const now = Date.now(); const a = (hits.get(ip) || []).filter((t) => now - t < 60_000);
  a.push(now); hits.set(ip, a);
  if (hits.size > 2000) hits.clear();
  return a.length > max;
}

function parseJsonl(s: string): TvAlert[] {
  const out: TvAlert[] = [];
  for (const line of s.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const a = JSON.parse(t) as TvAlert;
      if (a && typeof a.id === "number" && Number.isFinite(a.id) && typeof a.receivedMs === "number") out.push(a);
    } catch { /* skip bad line */ }
  }
  return out;
}
function trimAlerts(now = Date.now()) {
  const age = maxAgeMs(), cap = maxRows(), floor = now - age;
  let i = 0;
  while (i < alerts.length && (alerts[i]!.receivedMs < floor || alerts.length - i > cap)) i++;
  if (i) alerts.splice(0, i);
}
function allocId(now = Date.now()): number {
  // Timestamp-based so overlapping instances during a deploy cannot reuse a short counter.
  // *1000 leaves room for several receipts in the same millisecond; always ahead of anything already stored.
  const id = Math.max(nextId, now * 1000);
  nextId = id + 1;
  return id;
}
function cursorOf(): { id: number; receivedMs: number } {
  const last = alerts[alerts.length - 1];
  return { id: last?.id ?? nextId - 1, receivedMs: last?.receivedMs ?? 0 };
}
function persistInfo() {
  return {
    store: store?.name ?? null,
    rows: alerts.length,
    restoredRows,
    restoredFrom,
    lastSavedAt,
    savedThroughId,
  };
}
function filterAlerts(since: number, afterId: number): TvAlert[] {
  return alerts.filter((a) => a.id > afterId && (afterId > 0 || a.receivedMs > since));
}

export function parseTvAlertQuery(q: Request["query"]): { since: number; afterId: number } {
  const s = String(q.since ?? "0");
  const since = /^\d+$/.test(s) ? Number(s) : Date.parse(s) || 0;
  const a = String(q.afterId ?? q.after_id ?? "0");
  const afterId = /^\d+$/.test(a) ? Number(a) : 0;
  return { since, afterId };
}

export async function flushTvAlerts(msg = "tv alerts"): Promise<void> {
  if (!store) return;
  const unsaved = alerts.filter((a) => a.id > savedThroughId);
  if (!unsaved.length && lastSavedAt) return;
  if (!instanceFile) instanceFile = `tv-alerts-${Date.now().toString(36)}.jsonl`;
  const docs: Record<string, string | null> = {};
  if (unsaved.length) {
    instanceBody += unsaved.map((a) => JSON.stringify(a)).join("\n") + "\n";
    docs[instanceFile] = instanceBody;
  }
  const through = alerts.length ? alerts[alerts.length - 1]!.id : savedThroughId;
  const meta: TvAlertMeta = { v: 1, nextId, savedAt: new Date().toISOString(), savedThroughId: through };
  docs["tv-alerts-meta.json"] = JSON.stringify(meta) + "\n";
  // Compact when over cap or holding many batch files: fold into one JSONL and drop old batches.
  await maybeCompact(docs);
  await store.write(docs, msg);
  savedThroughId = through;
  lastSavedAt = meta.savedAt;
}

let instanceBody = "";
let compactNames: string[] = [];

async function maybeCompact(docs: Record<string, string | null>) {
  if (!store) return;
  const cap = maxRows();
  const over = alerts.length >= cap || compactNames.length >= 12;
  if (!over) return;
  const body = alerts.map((a) => JSON.stringify(a)).join("\n") + (alerts.length ? "\n" : "");
  docs["tv-alerts-compact.jsonl"] = body;
  for (const n of compactNames) if (n !== "tv-alerts-compact.jsonl") docs[n] = null;
  if (instanceFile) docs[instanceFile] = null;
  instanceFile = `tv-alerts-${Date.now().toString(36)}.jsonl`;
  instanceBody = "";
  compactNames = ["tv-alerts-compact.jsonl"];
}

/** Hold GET/POST until attachTvAlerts finishes (or this is released). Prevents empty-id assignment before load. */
export function holdTvAlerts(): () => void {
  let release = () => {};
  const prev = loaded;
  loaded = new Promise<void>((r) => { release = () => { void prev.then(r, r); }; });
  return release;
}

export async function attachTvAlerts(s: TvAlertStore, opts?: { persistEveryMs?: number; signals?: boolean }): Promise<void> {
  store = s;
  loaded = (async () => {
    try {
      const { meta, files } = await s.load();
      const byId = new Map<number, TvAlert>();
      compactNames = Object.keys(files);
      for (const body of Object.values(files)) for (const a of parseJsonl(body)) if (!byId.has(a.id)) byId.set(a.id, a);
      const incoming = alerts.slice(); // any receipts that arrived before load finished
      const restored = [...byId.values()].sort((a, b) => a.id - b.id || a.receivedMs - b.receivedMs);
      alerts.length = 0;
      alerts.push(...restored);
      restoredRows = restored.length;
      restoredFrom = meta?.savedAt ?? (restored.length ? restored[restored.length - 1]!.received : null);
      const maxId = restored.reduce((m, a) => Math.max(m, a.id), 0);
      nextId = Math.max(nextId, meta?.nextId ?? 0, maxId + 1, Date.now() * 1000);
      savedThroughId = Math.max(savedThroughId, meta?.savedThroughId ?? maxId, maxId);
      // Re-apply alerts received during load with fresh unique ids if they collided, else keep them.
      for (const a of incoming) {
        if (byId.has(a.id)) { a.id = allocId(a.receivedMs); }
        else nextId = Math.max(nextId, a.id + 1);
        alerts.push(a);
      }
      trimAlerts();
    } catch { /* stay with whatever is in memory */ }
  })();
  await loaded;
  const every = opts?.persistEveryMs ?? 5 * 60_000;
  if (every > 0) { const t = setInterval(() => void flushTvAlerts("tv alerts").catch(() => {}), every); t.unref?.(); }
  if (opts?.signals !== false) {
    const onExit = () => { void flushTvAlerts("tv alerts shutdown").catch(() => {}); };
    process.on("SIGTERM", onExit);
    process.on("SIGINT", onExit);
  }
}

export function tvAlertsStatus() {
  return { ...persistInfo(), nextId, inMemory: alerts.length };
}

/** Test-only: wipe module state. */
export function resetTvAlertsForTests() {
  alerts.length = 0;
  nextId = 1;
  savedThroughId = 0;
  instanceFile = "";
  instanceBody = "";
  compactNames = [];
  store = null;
  loaded = Promise.resolve();
  lastSavedAt = null;
  restoredFrom = null;
  restoredRows = 0;
  hits.clear();
}

export function mountTvWebhook(app: Express): void {
  const text = express.text({ type: () => true, limit: "16kb" });
  app.post("/tv/webhook", text, (req: Request, res: Response) => {
    void (async () => {
      await loaded;
      if (limited("w:" + req.ip, 30)) return void res.status(429).json({ error: "rate limited" });
      const raw = typeof req.body === "string" ? req.body : "";
      let body: unknown = raw;
      try { const j = JSON.parse(raw); if (j && typeof j === "object") body = j; } catch { /* plain text */ }
      const key = (req.query.key as string) ?? (body && typeof body === "object" ? (body as Record<string, unknown>).key : undefined);
      if (!okKey(key)) return void res.status(401).json({ error: "bad key" });
      if (body && typeof body === "object") delete (body as Record<string, unknown>).key;
      const now = Date.now();
      const alert: TvAlert = { id: allocId(now), received: new Date(now).toISOString(), receivedMs: now, body };
      alerts.push(alert);
      trimAlerts();
      res.json({ ok: true, id: alert.id });
    })();
  });
  app.get("/tv/alerts.json", (req: Request, res: Response) => {
    void (async () => {
      await loaded;
      if (limited("r:" + req.ip, 60)) return void res.status(429).json({ error: "rate limited" });
      if (!okKey(req.query.key)) return void res.status(401).json({ error: "bad key" });
      const { since, afterId } = parseTvAlertQuery(req.query);
      res.set("Cache-Control", "no-store").json({
        now: Date.now(),
        alerts: filterAlerts(since, afterId),
        cursor: cursorOf(),
        persist: persistInfo(),
      });
    })();
  });
}
