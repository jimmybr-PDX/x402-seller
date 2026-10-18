/** HTTP surface for RugRadar Watch + Alert. See watch.ts for the engine. */
import type { Express, Request, Response, NextFunction } from "express";
import { randomBytes } from "node:crypto";
import { WATCH_PLANS, planOf, postWebhook, WatchError, type Dest, type Plan, type Watcher } from "./watch.js";

export type WatchRouteDeps = { watcher: Watcher; spendN: (k: string, n: number) => Promise<number | null>; refundN: (k: string, n: number) => Promise<void>; publicUrl: string; allowPrivate?: boolean };
const s = (v: unknown) => (typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "");
export function parseWatchInput(src: any): { token: string; plan: Plan; dest: Dest } {
  const token = s(src?.token) || s(src?.mint);
  const plan = planOf(src?.hours ?? "24");
  if (!plan) throw new WatchError("invalid_input", 400, "hours must be 24 or 48");
  const hook = s(src?.webhook) || s(src?.webhook_url), tg = s(src?.telegram) || s(src?.telegram_chat_id);
  if (src?.email) throw new WatchError("invalid_input", 400, "Email alerts are not available; use a webhook.");
  if (!hook && !tg) throw new WatchError("invalid_input", 400, "Give a destination: webhook (https URL) or telegram (chat id; coming soon).");
  return { token, plan, dest: hook ? { type: "webhook", url: hook } : { type: "telegram", chatId: tg } };
}
const fail = (res: Response, e: unknown, extra: object = {}) => {
  if (e instanceof WatchError) { res.status(e.status).json({ error: e.code, message: e.message, ...extra }); return; }
  res.status(503).json({ error: "unavailable", message: `Watch service is temporarily unavailable. ${(extra as any).refunded ? "Your credits were refunded." : "You were not charged."}`, ...extra });
};

/** Pay with credits (X-RugRadar-Key): validate first, then spend 5/10 credits, refund on any failure. */
export async function createWithCredits(d: WatchRouteDeps, key: string, src: any) {
  const input = parseWatchInput(src);
  await d.watcher.create({ ...input, paidWith: "credits" }, true); // validation + capacity, nothing charged
  const n = WATCH_PLANS[input.plan].credits;
  const left = await d.spendN(key, n);
  if (left == null) throw new WatchError("insufficient_credits", 402, `A ${WATCH_PLANS[input.plan].hours}h watch costs ${n} credits; this key has fewer (or is unknown). Buy credits with Phantom/Solflare at /rugradar, or pay $${WATCH_PLANS[input.plan].priceUsd} with x402 at GET /watch.`);
  try { const { publicView } = await d.watcher.create({ ...input, paidWith: "credits" }); return { ...publicView, paidWith: "credits", creditsSpent: n, credits_remaining: left }; }
  catch (e) { await d.refundN(key, n); if (e instanceof WatchError) { e.message += " Your credits were refunded."; } throw e; }
}

export function watchConfig(d: WatchRouteDeps) {
  const st = d.watcher.status();
  return { product: "RugRadar Watch", plans: Object.values(WATCH_PLANS).map((p) => ({ hours: p.hours, priceUsd: p.priceUsd, credits: p.credits })), destinations: st.destinations,
    telegram: st.destinations.telegram ? "available" : "coming soon", email: "not available (use a webhook)", slotsLeft: Math.max(0, st.max - st.active), checkEveryMin: st.checkEveryMin,
    alertsOn: ["dev sells", "liquidity drop 30%+ (and 60%+)", "mint authority appears", "freeze authority appears", "risk score +20 (and +40) vs. start", "can't sell (2 checks in a row)"],
    pay: { credits: `POST ${d.publicUrl}/rugradar/watch with header X-RugRadar-Key (24h = 5 credits, 48h = 10)`, x402: `GET ${d.publicUrl}/watch?token=<mint>&hours=24|48&webhook=<https url>` , wallet: `buy a credit pack with Phantom/Solflare at ${d.publicUrl}/rugradar, then use the key` },
    usage: { activeWatches: st.active, maxWatches: st.max, checks: st.checks, checkFails: st.checkFails, avgCheckMs: st.avgCheckMs, alerts: st.alerts, delivered: st.delivered, deliveryFails: st.deliveryFails, costPerCheck: st.costPerCheck },
    signature: "X-RugRadar-Signature: t=<unix>,v1=hex(HMAC_SHA256(secret, `${t}.${rawBody}`)); the secret is returned once when the watch starts", disclaimer: "Automated heuristic, may be wrong. Not financial advice." };
}

/** Credit-key path for GET /watch; must run before the x402 payment middleware. */
export function watchKeyMiddleware(d: WatchRouteDeps) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const key = req.header("x-rugradar-key");
    if (!key || req.method !== "GET" || req.path !== "/watch") return next();
    try { res.set("Cache-Control", "no-store").json(await createWithCredits(d, key, req.query)); }
    catch (e) { if (e instanceof WatchError && e.code === "insufficient_credits") return next(); fail(res, e); }
  };
}
/** Paid (x402) GET /watch handler. The watch is removed again if settlement does not succeed. */
export function watchPaidHandler(d: WatchRouteDeps, decode: (h: unknown) => any) {
  return async (req: Request, res: Response) => {
    res.locals.paidHandlerRan = true;
    try {
      const input = parseWatchInput(req.query);
      const { watch, publicView } = await d.watcher.create({ ...input, paidWith: "x402" });
      res.on("finish", () => { const pr = decode(res.getHeader("payment-response")); if (!pr?.success) d.watcher.remove(watch.id).catch(() => {}); });
      res.set("Cache-Control", "no-store").json({ ...publicView, paidWith: "x402", priceUsd: Number(WATCH_PLANS[input.plan].priceUsd) });
    } catch (e) { fail(res, e); }
  };
}

const hits = new Map<string, number[]>();
const limited = (k: string, n: number, ms: number) => { const t = Date.now(), a = (hits.get(k) ?? []).filter((x) => t - x < ms); if (a.length >= n) { hits.set(k, a); return true; } a.push(t); hits.set(k, a); if (hits.size > 5000) hits.delete(hits.keys().next().value!); return false; };
const ipOf = (req: Request) => String(req.header("x-forwarded-for") ?? req.socket.remoteAddress ?? "").split(",")[0].trim();

export function registerWatchRoutes(app: Express, d: WatchRouteDeps) {
  app.get("/rugradar/watch/config", (_req, res) => { res.set("Cache-Control", "no-store").json(watchConfig(d)); });
  app.post("/rugradar/watch", async (req, res) => {
    res.set("Cache-Control", "no-store");
    const key = req.header("x-rugradar-key") || s(req.body?.api_key);
    if (!key) { res.status(402).json({ error: "payment_required", message: "Send a RugRadar credit key (X-RugRadar-Key). 24h watch = 5 credits ($0.05), 48h = 10 ($0.10). Agents can also pay with x402 at GET /watch.", config: `${d.publicUrl}/rugradar/watch/config` }); return; }
    if (limited("create:" + ipOf(req), 10, 60_000)) { res.status(429).json({ error: "slow_down", message: "Too many watch requests; wait a minute." }); return; }
    try { res.json(await createWithCredits(d, key, { ...req.query, ...(req.body ?? {}) })); } catch (e) { fail(res, e); }
  });
  app.post("/rugradar/watch/test", async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (limited("test:" + ipOf(req), 3, 10 * 60_000)) { res.status(429).json({ error: "slow_down", message: "3 test alerts per 10 minutes, please." }); return; }
    const url = s(req.body?.webhook) || s(req.query.webhook);
    const secret = "whsec_test_" + randomBytes(12).toString("base64url");
    const body = JSON.stringify({ product: "RugRadar", event: "watch.test", watchId: "w_test", token: "So11111111111111111111111111111111111111112", chain: "solana", alerts: [{ kind: "test", message: "This is a test alert from RugRadar Watch." }], sentAt: new Date().toISOString(), disclaimer: "Automated heuristic, may be wrong. Not financial advice." });
    const r = await postWebhook(url, secret, body, "watch.test", d.allowPrivate);
    res.status(r.ok ? 200 : r.status == null && r.error ? 400 : 502).json({ delivered: r.ok, status: r.status, ...(r.error ? { error: r.error } : {}), testSecret: secret, note: "Test alerts are signed with this one-off secret; real watches use the secret returned when the watch starts." });
  });
  const auth = async (req: Request) => d.watcher.get(String(req.params.id), req.header("x-watch-secret") || s(req.query.secret));
  app.get("/rugradar/watch/:id", async (req, res) => {
    res.set("Cache-Control", "no-store");
    const w = await auth(req); if (!w) { res.status(404).json({ error: "not_found", message: "Unknown watch id or wrong secret (send X-Watch-Secret)." }); return; }
    res.json(d.watcher.view(w));
  });
  app.delete("/rugradar/watch/:id", async (req, res) => {
    const w = await auth(req); if (!w) { res.status(404).json({ error: "not_found", message: "Unknown watch id or wrong secret (send X-Watch-Secret)." }); return; }
    await d.watcher.cancel(w); res.json({ ...d.watcher.view(w), message: "Watch cancelled (no refund)." });
  });
}
