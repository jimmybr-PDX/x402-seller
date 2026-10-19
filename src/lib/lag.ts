/**
 * Oct 18: event-loop lag watchdog. A 500 ms timer measures how late it fires; over 1 s it logs a warning naming the tracked
 * jobs that were running (or had just finished a long synchronous step), the last long GC pauses and memory. Render's health
 * check gives up after 5 s, so anything near that restarts the instance. Status (counts, worst lags) goes into /paper.json.
 */
import { monitorEventLoopDelay, performance, PerformanceObserver } from "node:perf_hooks";
const WARN_MS = Number(process.env.LAG_WARN_MS ?? 1000);
const active = new Map<number, { label: string; start: number }>(); let seq = 0;
const slow: { label: string; ms: number; at: number; sync: boolean }[] = [];
const gcs: { kind: string; ms: number; at: number }[] = [];
const warns: { at: string; lagMs: number; running: string[]; recentSlow: string[]; recentGc: string[]; rssMB: number; heapMB: number }[] = [];
const h = monitorEventLoopDelay({ resolution: 20 }); h.enable();
const MEM_WARN_MB = Number(process.env.MEM_WARN_MB ?? 440); const memWarns: { at: string; rssMB: number; running: string[] }[] = []; let peakRss = 0;
let count = 0, maxLag = 0, started = false, since = new Date().toISOString();
const keep = <T,>(a: T[], x: T, n = 30) => { a.push(x); if (a.length > n) a.shift(); };
const note = (label: string, ms: number, sync: boolean) => { if (ms >= 200) keep(slow, { label, ms: Math.round(ms), at: Date.now(), sync }); if (sync && ms >= WARN_MS) console.warn(`[lag] sync step ${label} took ${Math.round(ms)} ms`); };
/** Run (and label) an async job; its time shows up in lag warnings while it runs. */
export async function track<T>(label: string, fn: () => Promise<T> | T): Promise<T> {
  const id = ++seq, t0 = performance.now(); active.set(id, { label, start: t0 });
  try { return await fn(); } finally { active.delete(id); note(label, performance.now() - t0, false); }
}
/** Time a synchronous (blocking) step. */
export function trackSync<T>(label: string, fn: () => T): T { const t0 = performance.now(); try { return fn(); } finally { note(label, performance.now() - t0, true); } }
export function startLagWatch() {
  if (started) return; started = true; since = new Date().toISOString();
  try { const o = new PerformanceObserver((l) => { for (const e of l.getEntries()) if (e.duration >= 100) keep(gcs, { kind: String((e as any).detail?.kind ?? (e as any).kind ?? "gc"), ms: Math.round(e.duration), at: Date.now() }); }); o.observe({ entryTypes: ["gc"] }); } catch {}
  // Both Oct 18 restarts (3:16 and 6:20 PM PT) happened with no crash trace: log memory peaks and any exit so the next one names its cause.
  process.on("uncaughtExceptionMonitor", (e, origin) => console.error(`[lag] ${origin}: ${String((e as Error)?.stack ?? e).slice(0, 600)}`));
  process.on("exit", (code) => { const mu = process.memoryUsage(); console.error(`[lag] process exit code ${code}; rss ${Math.round(mu.rss / 1048576)} MB; running: ${[...active.values()].map((a) => a.label).join(", ") || "-"}`); });
  let lastMemWarn = 0;
  let last = performance.now();
  setInterval(() => {
    const now = performance.now(), lag = now - last - 500; last = now;
    const rss = process.memoryUsage.rss() / 1048576; if (rss > peakRss) peakRss = rss;
    if (rss > MEM_WARN_MB && Date.now() - lastMemWarn > 300_000) { lastMemWarn = Date.now(); keep(memWarns, { at: new Date().toISOString(), rssMB: Math.round(rss), running: [...active.values()].map((a) => a.label) }, 10); console.warn(`[lag] memory high: rss ${Math.round(rss)} MB; running: ${[...active.values()].map((a) => a.label).join(", ") || "-"}`); }
    if (lag < WARN_MS) return;
    count++; maxLag = Math.max(maxLag, lag); const t = Date.now(), mu = process.memoryUsage();
    const w = { at: new Date().toISOString(), lagMs: Math.round(lag), running: [...active.values()].map((a) => `${a.label} (${Math.round(now - a.start)} ms)`),
      recentSlow: slow.filter((s) => t - s.at < lag + 2000).map((s) => `${s.label}${s.sync ? " [sync]" : ""} ${s.ms} ms`),
      recentGc: gcs.filter((g) => t - g.at < lag + 2000).map((g) => `gc ${g.ms} ms`), rssMB: Math.round(mu.rss / 1048576), heapMB: Math.round(mu.heapUsed / 1048576) };
    keep(warns, w, 20); console.warn(`[lag] event loop blocked ${w.lagMs} ms; running: ${w.running.join(", ") || "-"}; slow: ${w.recentSlow.join(", ") || "-"}; ${w.recentGc.join(", ") || "no long GC"}; rss ${w.rssMB} MB heap ${w.heapMB} MB`);
  }, 500).unref?.();
}
export const lagStatus = () => ({ warnOverMs: WARN_MS, since, warnings: count, maxLagMs: Math.round(maxLag), delayMs: { p50: Math.round(h.percentile(50) / 1e6), p99: Math.round(h.percentile(99) / 1e6), max: Math.round(h.max / 1e6) },
  recentWarnings: warns.slice(-10), peakRssMB: Math.round(peakRss), memoryWarnings: memWarns, slowJobs: slow.slice(-15).map((s) => ({ ...s, at: new Date(s.at).toISOString() })), longGc: gcs.slice(-10).map((g) => ({ ...g, at: new Date(g.at).toISOString() })) });
/** JSON.stringify for big plain objects/arrays in slices, yielding between them so the event loop keeps answering. */
export async function stringifyChunked(v: unknown, slice = 2000): Promise<string> {
  const y = () => new Promise<void>((r) => setImmediate(r)); const parts: string[] = [];
  if (Array.isArray(v)) { parts.push("["); for (let i = 0; i < v.length; i += slice) { parts.push((i ? "," : "") + v.slice(i, i + slice).map((x) => JSON.stringify(x) ?? "null").join(",")); await y(); } parts.push("]"); return parts.join(""); }
  if (v && typeof v === "object") { const ks = Object.keys(v as object); parts.push("{"); for (let i = 0; i < ks.length; i += slice) { const s = ks.slice(i, i + slice).map((k) => { const x = JSON.stringify((v as any)[k]); return x === undefined ? null : JSON.stringify(k) + ":" + x; }).filter(Boolean).join(","); if (s) parts.push((parts.length > 1 ? "," : "") + s); await y(); } parts.push("}"); return parts.join(""); }
  return JSON.stringify(v);
}
