// Jupiter's free lite-api allows only ~5 requests per 10 s per IP, shared by everything on this server.
// Background work (paper bot) leaves the last few for people running checks; people wait briefly for the window.
import { AsyncLocalStorage } from "node:async_hooks";

export const background = new AsyncLocalStorage<boolean>();
export const RESERVE = 2;
const win = { remaining: Infinity, resetAt: 0 };
export const jupGateStat = { calls: 0, rateLimited: 0, skippedBackground: 0, waitedMs: 0 };

export function _resetGate() { win.remaining = Infinity; win.resetAt = 0; Object.assign(jupGateStat, { calls: 0, rateLimited: 0, skippedBackground: 0, waitedMs: 0 }); }

/** fetch for lite-api.jup.ag. Returns null (no request made) when background work would eat the reserve. */
export async function jupFetch(url: string, init: RequestInit = {}, now = Date.now): Promise<Response | null> {
  const bg = background.getStore() === true;
  const t = now(); const inWindow = t < win.resetAt;
  if (inWindow && win.remaining <= (bg ? RESERVE : 0)) {
    if (bg) { jupGateStat.skippedBackground++; return null; }
    const wait = win.resetAt - t;
    if (wait <= 1500) { jupGateStat.waitedMs += wait; await new Promise((r) => setTimeout(r, wait + 30)); }
  } else if (inWindow) win.remaining--; // count our own in-flight calls inside the window
  jupGateStat.calls++;
  const r = await fetch(url, init);
  note(r, now());
  return r;
}
export function note(r: Response, t = Date.now()) {
  if (!r?.headers?.get) return;
  const rem = Number(r.headers.get("x-ratelimit-remaining")); const rs = Number(r.headers.get("x-ratelimit-reset"));
  if (r.headers.has("x-ratelimit-reset") && Number.isFinite(rs) && rs > 0) win.resetAt = rs > 1e12 ? rs : rs * 1000;
  if (r.headers.has("x-ratelimit-remaining") && Number.isFinite(rem)) win.remaining = rem;
  if (r.status === 429) { jupGateStat.rateLimited++; win.remaining = 0; if (win.resetAt <= t) win.resetAt = t + 2000; }
}
