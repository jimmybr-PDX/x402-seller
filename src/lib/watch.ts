/**
 * RugRadar Watch + Alert (paid). One Solana mint watched for 24 h ($0.05 / 5 credits) or 48 h ($0.10 / 10 credits).
 * Every ~10 min the same public RugRadar engine re-checks the coin (public RPC + keyless APIs; no Helius, no private
 * signals) and alerts once per trigger: dev sells, liquidity drop (30%, then 60%), mint/freeze authority appearing,
 * risk score +20 (and +40) vs. the start, can't-sell (2 checks in a row). Alerts go to a webhook (JSON POST signed with
 * HMAC-SHA256: X-RugRadar-Signature: t=<unix>,v1=<hex of HMAC(secret, "<t>.<body>")>) or Telegram (only when
 * TELEGRAM_BOT_TOKEN is set; otherwise "coming soon"). Watches persist in the private credit store (watches.json) so they
 * survive restarts; concurrent watches are capped; watches expire on time.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { lookup } from "node:dns/promises";
import net from "node:net";

export const WATCH_PLANS = { "24": { hours: 24, credits: 5, priceUsd: "0.05" }, "48": { hours: 48, credits: 10, priceUsd: "0.10" } } as const;
export type Plan = keyof typeof WATCH_PLANS;
export const planOf = (h: unknown): Plan | null => (String(h ?? "24") === "48" ? "48" : String(h ?? "24") === "24" ? "24" : null);
const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export type Snap = { at: number; score: number; level: string; mintAuthority: boolean; freezeAuthority: boolean; liquidityUsd: number | null; canSell: string | null;
  devSells: number | null; devSoldPct: number | null; devHoldingPct: number | null; priceUsd: number | null; partial?: boolean; young?: boolean };
export type Dest = { type: "webhook"; url: string } | { type: "telegram"; chatId: string };
export type Alert = { kind: string; key: string; message: string; at: number };
export type Watch = { id: string; token: string; chain: "solana"; plan: Plan; createdAt: number; expiresAt: number; dest: Dest; secret: string; paidWith: string;
  status: "active" | "expired" | "cancelled"; base: Snap; last: Snap; peakLiq: number | null; noSell: number; lowLiq?: number; checks: number; fails: number; lastCheckAt: number;
  sent: string[]; alerts: Alert[]; outbox: { body: string; tries: number; next: number }[]; delivered: number; deliveryFails: number };

export function snapOf(r: any, at = Date.now()): Snap {
  const f = r?.facts ?? {}, b = r?.buyer ?? {};
  const n = (v: unknown) => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
  // Liquidity is "unknown" when the market source failed, or reads 0 while a sell route exists (flaky source, not a drained pool).
  const sellable = b.canSell != null && /^yes/i.test(String(b.canSell));
  const liq = f.marketUnknown || (n(f.liquidityUsd) === 0 && sellable) ? null : n(f.liquidityUsd);
  return { at, score: Number(r?.riskScore ?? 0), level: String(r?.riskLevel ?? "?"), mintAuthority: !!f.mintAuthority, freezeAuthority: !!f.freezeAuthority, liquidityUsd: liq,
    canSell: b.canSell == null ? null : String(b.canSell), devSells: n(b.devSells), devSoldPct: n(b.devSoldPctOfBought), devHoldingPct: n(b.devHoldingPct), priceUsd: n(f.priceUsd), ...(r?.buyer ? {} : { partial: true }), ...(r?.scoring ? { young: true } : {}) };
}

/** Pure trigger logic. Returns new alerts (deduped by key against w.sent) and the updated per-watch counters. */
export function evaluate(w: Pick<Watch, "base" | "peakLiq" | "noSell" | "sent"> & { lowLiq?: number }, s: Snap): { alerts: Alert[]; peakLiq: number | null; noSell: number; lowLiq: number; rebase?: boolean; rescore?: boolean } {
  const out: Alert[] = [], b = w.base, sent = new Set(w.sent);
  // Buyer signals (dev, can-sell, full score) missing in either check: compare only facts (authorities, liquidity).
  // A partial start is replaced by the first complete check, so a missing signal never looks like a worsening.
  const full = !s.partial && !b.partial, rebase = !!b.partial && !s.partial;
  // New-coin scoring (under 10 min) weights some checks down; when a coin leaves it the score jumps by design, so the
  // first normal-scored check becomes the score baseline instead of counting as a worsening.
  const rescore = !rebase && !!b.young && !s.young;
  const add = (kind: string, key: string, message: string) => { if (!sent.has(key)) { sent.add(key); out.push({ kind, key, message, at: s.at }); } };
  // dev sells: more dev sells than at the start, or the dev wallet's share fell by 2+ points
  const devSoldMore = (s.devSells ?? 0) > (b.devSells ?? 0) || (s.devSoldPct != null && s.devSoldPct >= (b.devSoldPct ?? 0) + 10);
  const holdDrop = b.devHoldingPct != null && s.devHoldingPct != null && b.devHoldingPct >= 1 && s.devHoldingPct <= b.devHoldingPct - 2;
  if (full && (devSoldMore || holdDrop)) add("dev_sold", "dev_sold", `Dev sold${s.devSoldPct != null ? ` (now ${s.devSoldPct}% of what they bought)` : ""}${holdDrop ? `; dev wallet holds ${s.devHoldingPct}% (was ${b.devHoldingPct}%)` : ""}.`);
  if (full && (s.devSoldPct != null && s.devSoldPct >= 90 && (b.devSoldPct ?? 0) < 90) || (b.devHoldingPct != null && b.devHoldingPct >= 1 && s.devHoldingPct != null && s.devHoldingPct < 0.1))
    add("dev_sold", "dev_sold_all", "Dev sold (almost) everything.");
  // liquidity drop vs. the highest liquidity seen during the watch
  // liquidity drop vs. the highest liquidity seen during the watch; confirmed on 2 checks in a row (one bad reading never alerts)
  let peak = w.peakLiq, lowLiq = w.lowLiq ?? 0;
  if (s.liquidityUsd != null) {
    const drop = peak != null && peak >= 1000 ? 1 - s.liquidityUsd / peak : 0;
    lowLiq = drop >= 0.3 ? lowLiq + 1 : 0;
    if (lowLiq >= 2) {
      if (drop >= 0.3) add("liquidity_drop", "liq_30", `Liquidity dropped ${Math.round(drop * 100)}% (from $${Math.round(peak ?? 0).toLocaleString("en-US")} to $${Math.round(s.liquidityUsd).toLocaleString("en-US")}).`);
      if (drop >= 0.6) add("liquidity_drop", "liq_60", `Liquidity dropped ${Math.round(drop * 100)}% (from $${Math.round(peak ?? 0).toLocaleString("en-US")} to $${Math.round(s.liquidityUsd).toLocaleString("en-US")}).`);
    }
    if (drop < 0.3) peak = Math.max(peak ?? 0, s.liquidityUsd);
  }
  if (s.mintAuthority && !b.mintAuthority) add("mint_authority", "mint_authority", "Mint authority appeared: more tokens can now be created.");
  if (s.freezeAuthority && !b.freezeAuthority) add("freeze_authority", "freeze_authority", "Freeze authority appeared: holders' tokens can now be frozen.");
  const d = s.score - b.score;
  if (full && !rescore && d >= 20) add("score_worse", "score_20", `Risk score worsened ${b.score} -> ${s.score} (${s.level}).`);
  if (full && !rescore && d >= 40) add("score_worse", "score_40", `Risk score worsened ${b.score} -> ${s.score} (${s.level}).`);
  const noRoute = s.canSell != null && /^no\b/i.test(s.canSell), wasSellable = b.canSell != null && /^yes/i.test(b.canSell);
  const noSell = s.partial ? w.noSell : noRoute ? w.noSell + 1 : 0;
  if (noSell >= 2 && wasSellable) add("cant_sell", "cant_sell", "Can't sell: no sell route found on two checks in a row (was sellable at the start).");
  return { alerts: out, peakLiq: peak, noSell, lowLiq, ...(rebase ? { rebase } : {}), ...(rescore ? { rescore } : {}) };
}

export const sign = (secret: string, body: string, t = Math.floor(Date.now() / 1000)) => `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}`;
export function verifySignature(secret: string, body: string, header: string, toleranceS = 300, now = Math.floor(Date.now() / 1000)): boolean {
  const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(header ?? ""); if (!m) return false;
  if (Math.abs(now - Number(m[1])) > toleranceS) return false;
  const want = Buffer.from(sign(secret, body, Number(m[1])).split("v1=")[1], "hex"), got = Buffer.from(m[2], "hex");
  return want.length === got.length && timingSafeEqual(want, got);
}

// ---------- webhook safety: https only, public addresses only, no redirects, 5 s timeout ----------
function privateIp(ip: string): boolean {
  if (net.isIPv4(ip)) { const [a, b] = ip.split(".").map(Number); return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224; }
  const x = ip.toLowerCase(); if (x.startsWith("::ffff:")) return privateIp(x.slice(7));
  return x === "::1" || x === "::" || x.startsWith("fc") || x.startsWith("fd") || x.startsWith("fe80");
}
export function checkWebhookUrl(raw: string, allowPrivate = false): string | null {
  let u: URL; try { u = new URL(raw); } catch { return "webhook must be a full https:// URL"; }
  if (u.protocol !== "https:" && !(allowPrivate && u.protocol === "http:")) return "webhook must use https://";
  if (u.username || u.password) return "webhook URL must not contain credentials";
  if (raw.length > 500) return "webhook URL too long";
  if (!allowPrivate && (/^(localhost|.*\.local|.*\.internal)$/i.test(u.hostname) || (net.isIP(u.hostname.replace(/^\[|\]$/g, "")) && privateIp(u.hostname.replace(/^\[|\]$/g, ""))))) return "webhook must be a public address";
  return null;
}
export async function postWebhook(url: string, secret: string, body: string, event: string, allowPrivate = false): Promise<{ ok: boolean; status: number | null; error?: string }> {
  const bad = checkWebhookUrl(url, allowPrivate); if (bad) return { ok: false, status: null, error: bad };
  if (!allowPrivate) { try { const as = await lookup(new URL(url).hostname, { all: true }); if (!as.length || as.some((a) => privateIp(a.address))) return { ok: false, status: null, error: "webhook resolves to a private address" }; } catch { return { ok: false, status: null, error: "webhook host not found" }; } }
  try {
    const r = await fetch(url, { method: "POST", redirect: "manual", signal: AbortSignal.timeout(5000), body,
      headers: { "content-type": "application/json", "user-agent": "RugRadar-Watch/1.0", "x-rugradar-event": event, "x-rugradar-signature": sign(secret, body), "x-rugradar-delivery": randomBytes(8).toString("hex") } });
    await r.arrayBuffer().catch(() => {});
    return { ok: r.status >= 200 && r.status < 300, status: r.status };
  } catch (e) { return { ok: false, status: null, error: String((e as Error).message ?? e).slice(0, 80) }; }
}
async function postTelegram(token: string, chatId: string, text: string) {
  try { const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }), signal: AbortSignal.timeout(5000) }); return { ok: r.ok, status: r.status }; }
  catch { return { ok: false, status: null }; }
}

// ---------- manager ----------
export type WatchDeps = {
  rugCheck: (mint: string) => Promise<any>;
  load: () => Promise<Watch[]>; save: (ws: Watch[], msg: string) => Promise<void>;
  publicUrl: string; now?: () => number; env?: NodeJS.ProcessEnv;
};
export class WatchError extends Error { constructor(public code: string, public status: number, msg: string) { super(msg); } }
const pub = (s: Snap) => ({ riskScore: s.score, riskLevel: s.level, liquidityUsd: s.liquidityUsd, priceUsd: s.priceUsd, mintAuthorityActive: s.mintAuthority, freezeAuthorityActive: s.freezeAuthority, canSell: s.canSell, devSells: s.devSells, devSoldPctOfBought: s.devSoldPct, devHoldingPct: s.devHoldingPct, checkedAt: new Date(s.at).toISOString() });

export function createWatcher(d: WatchDeps) {
  const env = d.env ?? process.env, now = d.now ?? Date.now;
  const MAX = Number(env.WATCH_MAX_ACTIVE ?? 30), INTERVAL = Number(env.WATCH_INTERVAL_MS ?? 10 * 60_000), allowPrivate = env.WATCH_ALLOW_PRIVATE === "1";
  const tgToken = () => env.TELEGRAM_BOT_TOKEN?.trim() || "";
  let ws: Watch[] = [], lastSnapSave = 0, loaded = false, dirty = false, saving: Promise<void> | null = null, running = false;
  const stat = { checks: 0, checkFails: 0, alerts: 0, delivered: 0, deliveryFails: 0, avgCheckMs: 0, lastTick: 0, lastError: null as string | null };
  const active = () => ws.filter((w) => w.status === "active");
  // Each check = 4 public-RPC + 2 Jupiter + 1 DexScreener + up to 4 pump.fun calls (0 Helius). Keep the total to ~3 checks/min.
  const interval = () => Math.max(INTERVAL, active().length * 20_000);
  async function ensure() { if (!loaded) { ws = (await d.load().catch(() => [])) ?? []; loaded = true; } }
  async function persist(msg: string) { dirty = false; const keep = ws.filter((w) => w.status === "active" || now() - w.expiresAt < 3 * 86400_000); ws = keep; await d.save(keep, msg); }
  function persistSoon(msg: string) { dirty = true; if (saving) return; saving = new Promise<void>((r) => setTimeout(r, 5000)).then(() => (dirty ? persist(msg) : undefined)).catch((e) => { stat.lastError = String(e).slice(0, 100); }).finally(() => { saving = null; }); }
  const destinations = () => ({ webhook: true, telegram: !!tgToken(), email: false });

  function payload(w: Watch, event: string, extra: object) {
    return JSON.stringify({ product: "RugRadar", event, watchId: w.id, token: w.token, chain: w.chain, plan: `${WATCH_PLANS[w.plan].hours}h`, expiresAt: new Date(w.expiresAt).toISOString(),
      chart: `https://dexscreener.com/solana/${w.token}`, ...extra, disclaimer: "Automated heuristic, may be wrong. Not financial advice." });
  }
  function enqueue(w: Watch, body: string) { w.outbox.push({ body, tries: 0, next: now() }); if (w.outbox.length > 20) w.outbox.shift(); }
  async function deliver(w: Watch) {
    for (const m of [...w.outbox]) {
      if (m.next > now()) continue;
      const ev = JSON.parse(m.body).event;
      const r = w.dest.type === "webhook" ? await postWebhook(w.dest.url, w.secret, m.body, ev, allowPrivate)
        : tgToken() ? await postTelegram(tgToken(), w.dest.chatId, tgText(JSON.parse(m.body))) : { ok: false, status: null };
      m.tries++;
      if (r.ok) { w.outbox.splice(w.outbox.indexOf(m), 1); w.delivered++; stat.delivered++; }
      else { stat.deliveryFails++; w.deliveryFails++; if (m.tries >= 4) w.outbox.splice(w.outbox.indexOf(m), 1); else m.next = now() + [60_000, 5 * 60_000, 15 * 60_000][m.tries - 1]; }
    }
  }
  const tgText = (p: any) => p.event === "watch.alert" ? `RugRadar alert for ${p.token}:\n${p.alerts.map((a: any) => "- " + a.message).join("\n")}\nNow: score ${p.now?.riskScore} (${p.now?.riskLevel})\n${p.chart}` : `RugRadar: ${p.event} for ${p.token}`;

  async function check(w: Watch) {
    const t0 = now();
    try {
      const s = snapOf(await d.rugCheck(w.token), now());
      stat.checks++; w.checks++; stat.avgCheckMs = Math.round(stat.avgCheckMs * 0.9 + (now() - t0) * 0.1);
      const e = evaluate(w, s); w.peakLiq = e.peakLiq; w.noSell = e.noSell; w.lowLiq = e.lowLiq; w.last = s; if (e.rebase) w.base = s; else if (e.rescore) w.base = { ...w.base, score: s.score, level: s.level, young: false };
      if (e.alerts.length) { w.sent.push(...e.alerts.map((a) => a.key)); w.alerts.push(...e.alerts); stat.alerts += e.alerts.length; enqueue(w, payload(w, "watch.alert", { alerts: e.alerts.map(({ kind, message }) => ({ kind, message })), now: pub(s), atStart: pub(w.base) })); persistSoon("watch alert"); }
    } catch (err) { w.fails++; stat.checkFails++; stat.lastError = String((err as Error).message ?? err).slice(0, 100); }
    w.lastCheckAt = now();
  }
  /** One scheduler pass: expire, re-check due watches (one at a time, at most `maxChecks`), deliver queued alerts. */
  async function tick(maxChecks = 6) {
    if (running) return; running = true; stat.lastTick = now();
    try {
      await ensure();
      for (const w of active()) if (now() >= w.expiresAt) { w.status = "expired"; enqueue(w, payload(w, "watch.expired", { alertsSent: w.alerts.length, last: pub(w.last) })); persistSoon("watch expired"); }
      const due = active().filter((w) => now() - w.lastCheckAt >= interval()).sort((a, b) => a.lastCheckAt - b.lastCheckAt).slice(0, maxChecks);
      for (const w of due) await check(w);
      for (const w of ws) if (w.outbox.length) await deliver(w);
      if (due.length && now() - lastSnapSave > 10 * 60_000) { lastSnapSave = now(); persistSoon("watch checks"); } // latest snapshots, at most every 10 min
    } finally { running = false; }
  }

  async function create(input: { token: string; plan: Plan; dest: Dest; paidWith: string }, preflightOnly = false): Promise<{ watch: Watch; publicView: object }> {
    await ensure();
    const token = input.token.trim();
    if (!B58.test(token)) throw new WatchError("invalid_input", 400, "token must be a Solana mint address");
    if (input.dest.type === "webhook") { const bad = checkWebhookUrl(input.dest.url, allowPrivate); if (bad) throw new WatchError("invalid_input", 400, bad); }
    else if (!tgToken()) throw new WatchError("telegram_coming_soon", 400, "Telegram alerts are coming soon; use a webhook for now.");
    else if (!/^-?\d{4,20}$/.test(input.dest.chatId)) throw new WatchError("invalid_input", 400, "telegram chat id must be numeric");
    if (active().length >= MAX) throw new WatchError("watch_capacity", 503, "All watch slots are in use right now; try again later.");
    if (preflightOnly) return { watch: null as any, publicView: {} };
    let r: any;
    try { r = await d.rugCheck(token); if (!r?.buyer) { const r2 = await d.rugCheck(token).catch(() => null); if (r2?.buyer) r = r2; } } catch (e) { throw new WatchError("check_failed", 422, `Could not check this token: ${String((e as Error).message ?? e).slice(0, 120)}`); }
    const s = snapOf(r, now()), t = now(), p = WATCH_PLANS[input.plan];
    const w: Watch = { id: "w_" + randomBytes(9).toString("base64url"), token, chain: "solana", plan: input.plan, createdAt: t, expiresAt: t + p.hours * 3600_000, dest: input.dest,
      secret: "whsec_" + randomBytes(24).toString("base64url"), paidWith: input.paidWith, status: "active", base: s, last: s, peakLiq: s.liquidityUsd, noSell: 0, checks: 1, fails: 0,
      lastCheckAt: t, sent: [], alerts: [], outbox: [], delivered: 0, deliveryFails: 0 };
    ws.push(w);
    enqueue(w, payload(w, "watch.started", { atStart: pub(s) }));
    await persist("watch created"); // "watch.started" goes out on the next tick (after x402 settlement)
    return { watch: w, publicView: view(w, true) };
  }
  function view(w: Watch, withSecret = false) {
    return { watchId: w.id, token: w.token, chain: w.chain, status: w.status, hours: WATCH_PLANS[w.plan].hours, createdAt: new Date(w.createdAt).toISOString(), expiresAt: new Date(w.expiresAt).toISOString(),
      destination: w.dest.type === "webhook" ? { type: "webhook", url: w.dest.url.replace(/(\?|#).*$/, "$1…") } : { type: "telegram" }, ...(withSecret ? { secret: w.secret, signature: "X-RugRadar-Signature: t=<unix>,v1=HMAC_SHA256(secret, `${t}.${rawBody}`) hex" } : {}),
      checks: w.checks, checkEveryMin: Math.round(interval() / 60000), atStart: pub(w.base), latest: pub(w.last), alerts: w.alerts.map(({ kind, message, at }) => ({ kind, message, at: new Date(at).toISOString() })), delivered: w.delivered, pendingDeliveries: w.outbox.length };
  }
  async function get(id: string, secret: string) {
    await ensure(); const w = ws.find((x) => x.id === id);
    if (!w || !secret || w.secret.length !== secret.length || !timingSafeEqual(Buffer.from(w.secret), Buffer.from(secret))) return null;
    return w;
  }
  async function cancel(w: Watch) { w.status = "cancelled"; await persist("watch cancelled"); }
  async function remove(id: string) { await ensure(); ws = ws.filter((w) => w.id !== id); await persist("watch revoked (unpaid)"); }
  async function flush() { if (dirty) await persist("watch flush"); }
  const status = () => ({ costPerCheck: { helius: 0, publicSolanaRpc: 4, jupiter: 2, dexscreener: 1, pumpFun: "up to 4" }, active: active().length, max: MAX, checkEveryMin: Math.round(interval() / 60000), destinations: destinations(), ...stat });
  return { create, tick, get, view, cancel, remove, flush, status, destinations, _all: () => ws, payload };
}
export type Watcher = ReturnType<typeof createWatcher>;
