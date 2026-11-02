// Nov 2: TradingView webhook receiver (paper only). Shared secret TV_WEBHOOK_SECRET via ?key= or JSON "key".
// Alerts kept in memory (cap 500); box pulls them via GET /tv/alerts.json?key=&since=.
import express, { type Express, type Request, type Response } from "express";
import { timingSafeEqual } from "node:crypto";

type Alert = { id: number; received: string; receivedMs: number; body: unknown };
const CAP = 500;
const alerts: Alert[] = [];
let nextId = 1;
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

export function mountTvWebhook(app: Express): void {
  const text = express.text({ type: () => true, limit: "16kb" });
  app.post("/tv/webhook", text, (req: Request, res: Response) => {
    if (limited("w:" + req.ip, 30)) return void res.status(429).json({ error: "rate limited" });
    const raw = typeof req.body === "string" ? req.body : "";
    let body: unknown = raw;
    try { const j = JSON.parse(raw); if (j && typeof j === "object") body = j; } catch { /* plain text */ }
    const key = (req.query.key as string) ?? (body && typeof body === "object" ? (body as Record<string, unknown>).key : undefined);
    if (!okKey(key)) return void res.status(401).json({ error: "bad key" });
    if (body && typeof body === "object") delete (body as Record<string, unknown>).key;
    const now = Date.now();
    alerts.push({ id: nextId++, received: new Date(now).toISOString(), receivedMs: now, body });
    if (alerts.length > CAP) alerts.splice(0, alerts.length - CAP);
    res.json({ ok: true, id: nextId - 1 });
  });
  app.get("/tv/alerts.json", (req: Request, res: Response) => {
    if (limited("r:" + req.ip, 60)) return void res.status(429).json({ error: "rate limited" });
    if (!okKey(req.query.key)) return void res.status(401).json({ error: "bad key" });
    const s = String(req.query.since ?? "0");
    const since = /^\d+$/.test(s) ? Number(s) : Date.parse(s) || 0;
    res.set("Cache-Control", "no-store").json({ now: Date.now(), alerts: alerts.filter((a) => a.receivedMs > since) });
  });
}
