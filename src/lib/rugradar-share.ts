/**
 * Per-token share preview for RugRadar. /rugradar/c/<chain>/<token> is the share permalink (og/twitter tags);
 * /rugradar/share/<chain>/<token>.png is a 600x600 card (twitter:card "summary"): token name + short address, the
 * score dial, up to 3 free-check danger warnings and free facts (top-10 %, liquidity, age).
 * Only free-check data (limitedReport): never paid/unlocked details or private signals, and never the word "safe".
 * Results are cached per chain:mint (6 h) and primed by a completed check. Views render from that cache only and
 * never start a new check.
 */
import { Resvg } from "@resvg/resvg-js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { cleanTokenText } from "./token-name.js";

export type ShareData = { token: string; chain: string; name: string; score: number; level: "high" | "medium" | "low"; label: string;
  warnings: { severity: "DANGER" | "CAUTION"; title: string }[]; more: number; facts: string[]; tension?: string | null };

const asset = (p: string) => fileURLToPath(new URL(`../assets/${p}`, import.meta.url));
const FONTS = [asset("fonts/DejaVuSans.ttf"), asset("fonts/DejaVuSans-Bold.ttf")];
let LOGO = "";
try { LOGO = "data:image/png;base64," + readFileSync(asset("rugradar/rug-radar-192.png")).toString("base64"); } catch {}
const CHAIN: Record<string, string> = { solana: "Solana", base: "Base", bnb: "BNB", ethereum: "Ethereum", arbitrum: "Arbitrum" };
const LABEL = { high: "HIGH RISK", medium: "CAUTION", low: "NO WARNINGS" } as const;
const COLOR = { high: "#EF4444", medium: "#F59E0B", low: "#9AA4B8" } as const;

/** Never show the word "safe" anywhere on the card (token names are attacker-controlled). */
export const noSafe = (s: string) => s.replace(/s(a)fe/gi, (m) => m[0] + "\u2022" + m.slice(2));
const esc = (s: string) => noSafe(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const fit = (s: string, n: number) => (Array.from(s).length > n ? Array.from(s).slice(0, n - 1).join("").trim() + "\u2026" : s);
export const shortAddr = (t: string) => (t.length > 12 ? `${t.slice(0, 4)}\u2026${t.slice(-4)}` : t);
const usdK = (n: number) => (n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(1)}K` : `$${Math.round(n)}`);
const ageTxt = (h: number) => (h < 1 ? `${Math.max(1, Math.round(h * 60))}m` : h < 48 ? `${Math.round(h)}h` : `${Math.round(h / 24)}d`);


/** One compact 24h line for free facts and the share card, when the data is present. */
export function marketFactLine(f: any): string | null {
  if (!f) return null;
  const bits: string[] = [];
  const mk = (n: number) => (n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(1)}K` : `$${Math.round(n)}`);
  if (Number.isFinite(f.volume24hUsd)) bits.push(`24h ${mk(Number(f.volume24hUsd))}`);
  if (Number.isFinite(f.buys24h) || Number.isFinite(f.sells24h)) bits.push(`${Number.isFinite(f.buys24h) ? f.buys24h : "?"} buys / ${Number.isFinite(f.sells24h) ? f.sells24h : "?"} sells`);
  if (Number.isFinite(f.priceChange24hPct)) {
    const n = Number(f.priceChange24hPct);
    const t = Math.abs(n) < 10 ? n.toFixed(1).replace(/\.0$/, "") : String(Math.round(n));
    bits.push(`${n > 0 ? "+" : ""}${t}%`);
  }
  return bits.length ? bits.join(" · ") : null;
}

/** Build card data from a limitedReport() result plus its warnings (warningsOf) and shown level. Free data only. */
export function shareData(l: any, ws: { sev: "DANGER" | "CAUTION"; title: string }[], level: string, token: string, chain: string): ShareData {
  const f = l?.facts ?? {}, sym = cleanTokenText(f.tokenSymbol, 20), nm = cleanTokenText(f.tokenName, 32);
  const name = nm && sym && nm.toLowerCase() !== sym.toLowerCase() ? `${nm} \u00b7 $${sym}` : sym ? `$${sym}` : nm;
  const lv = (level === "high" || level === "medium" || level === "low" ? level : "medium") as ShareData["level"];
  const facts: string[] = [];
  const market = marketFactLine(f);
  if (market) facts.push(market);
  if (Number.isFinite(f.top10Pct)) facts.push(`Top 10 hold ${Math.round(f.top10Pct)}%`); else if (Number.isFinite(f.top1Pct)) facts.push(`Top holder ${Math.round(f.top1Pct)}%`);
  if (Number.isFinite(f.liquidityUsd)) facts.push(`Liquidity ${usdK(f.liquidityUsd)}`);
  if (facts.length < 3 && Number.isFinite(f.ageHours)) facts.push(`Age ${ageTxt(f.ageHours)}`);
  return { token, chain, name, score: Math.max(0, Math.min(100, Math.round(Number(l?.riskScore) || 0))), level: lv, label: LABEL[lv],
    warnings: ws.slice(0, 3).map((w) => ({ severity: w.sev, title: w.title })), more: Math.max(0, ws.length - 3) + (Number(l?.hiddenWarnings) || 0), facts,
    tension: ws.length && typeof l?.tensionLine === "string" && l.tensionLine ? fit(l.tensionLine, 140) : null };
}

/** Greedy word wrap to at most `lines` lines of ~`width` chars (last line gets an ellipsis if cut). */
export function wrapText(t: string, width: number, lines: number): string[] {
  const out: string[] = []; let cur = "";
  for (const w of t.split(/\s+/).filter(Boolean)) {
    if (!cur) cur = w; else if ((cur + " " + w).length <= width) cur += " " + w; else { out.push(cur); cur = w; if (out.length === lines) break; }
  }
  if (out.length < lines && cur) out.push(cur);
  const used = out.join(" ").length;
  if (used < t.trim().length && out.length) out[out.length - 1] = fit(out[out.length - 1]! + " …", width);
  return out.slice(0, lines);
}
/** Wrap every word onto as many lines as needed. Never ellipsize. A single over-long word stays on its own line. */
export function wrapAll(t: string, width: number): string[] {
  const out: string[] = []; let cur = "";
  for (const w of t.split(/\s+/).filter(Boolean)) {
    if (!cur) cur = w; else if ((cur + " " + w).length <= width) cur += " " + w; else { out.push(cur); cur = w; }
  }
  if (cur) out.push(cur);
  return out;
}
export type TensionLayout = { font: number; lineH: number; lines: string[] };
/** Fit a tension line (max 140 chars) in the share-card slot: wrap first, shrink font if needed, never truncate. */
export function layoutTension(t: string): TensionLayout {
  const attempts = [
    { font: 19, lineH: 24, width: 30, maxLines: 4 },
    { font: 17, lineH: 21, width: 33, maxLines: 5 },
    { font: 16, lineH: 20, width: 36, maxLines: 5 },
    { font: 15, lineH: 19, width: 38, maxLines: 5 },
  ];
  for (const a of attempts) {
    const lines = wrapAll(t, a.width);
    if (lines.length <= a.maxLines) return { font: a.font, lineH: a.lineH, lines };
  }
  const last = attempts[attempts.length - 1]!;
  return { font: last.font, lineH: last.lineH, lines: wrapAll(t, last.width) };
}
/** 600x600 SVG in the site's look (dark card, conic score dial, warning cards with red/amber bars). */
export function shareSvg(v: ShareData, host: string): string {
  const c = COLOR[v.level], p = v.level === "low" ? Math.max(4, v.score) : Math.max(4, v.score), W = 600;
  const cx = 112, cy = 246, r = 74, a = (p / 100) * 2 * Math.PI, ex = cx + r * Math.sin(a), ey = cy - r * Math.cos(a);
  const arc = p >= 100 ? `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${c}" stroke-width="22"/>`
    : `<path d="M${cx} ${cy - r} A${r} ${r} 0 ${p > 50 ? 1 : 0} 1 ${ex.toFixed(2)} ${ey.toFixed(2)}" fill="none" stroke="${c}" stroke-width="22"/>`;
  const sub = v.level === "high" ? "Strong rug warning signs." : v.level === "medium" ? "Some rug warning signs." : "No danger warnings found.";
  let y = 362; const rows = v.warnings.map((w) => {
    const d = w.severity === "DANGER", col = d ? "#EF4444" : "#F59E0B", out = `<g transform="translate(32 ${y})"><rect width="536" height="50" rx="12" fill="#0F1628" stroke="#232C47"/><rect width="7" height="50" rx="3" fill="${col}"/>
<rect x="20" y="13" width="${d ? 84 : 92}" height="24" rx="6" fill="${col}" fill-opacity=".18"/><text x="${d ? 62 : 66}" y="30" font-size="14" font-weight="700" fill="${col}" text-anchor="middle">${w.severity}</text>
<text x="${d ? 118 : 126}" y="33" font-size="21" font-weight="700" fill="#EEF2F8">${esc(fit(w.title, 30))}</text></g>`; y += 58; return out; }).join("");
  const tail = v.more > 0 ? `+${v.more} more warning${v.more > 1 ? "s" : ""} in the full report` : v.warnings.length ? "" : "No danger warnings in the free check.";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${W}" viewBox="0 0 ${W} ${W}" font-family="DejaVu Sans">
<rect width="${W}" height="${W}" fill="#0B1020"/><rect x="12" y="12" width="576" height="576" rx="26" fill="#131A2E" stroke="#232C47" stroke-width="2"/>
${LOGO ? `<image href="${LOGO}" x="32" y="30" width="40" height="40"/>` : ""}<text x="82" y="61" font-size="27" font-weight="700" fill="#EEF2F8">RugRadar</text>
<text x="568" y="59" font-size="17" fill="#9AA4B8" text-anchor="end">free check \u00b7 ${esc(CHAIN[v.chain] ?? v.chain)}</text>
<text x="32" y="112" font-size="30" font-weight="700" fill="#EEF2F8">${esc(fit(v.name || shortAddr(v.token), 26))}</text>
<text x="32" y="138" font-size="17" fill="#9AA4B8">${esc(shortAddr(v.token))}</text>
<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#ffffff" stroke-opacity=".12" stroke-width="22"/>${arc}
<circle cx="${cx}" cy="${cy}" r="${r - 15}" fill="#0f1526"/><text x="${cx}" y="${cy + 14}" font-size="50" font-weight="700" fill="#fff" text-anchor="middle">${v.score}</text>
<text x="${cx}" y="${cy + 38}" font-size="15" fill="#9AA4B8" text-anchor="middle">/100</text>
<text x="222" y="226" font-size="40" font-weight="700" fill="${c}">${v.label}</text>${v.tension ? ((lay) => lay.lines.map((ln, i) => `<text x="222" y="${256 + i * lay.lineH}" font-size="${lay.font}" font-weight="700" fill="#EEF2F8">${esc(ln)}</text>`).join(""))(layoutTension(v.tension)) : `<text x="222" y="258" font-size="19" fill="#C9D1E0">${sub}</text>`}
${v.tension ? "" : v.facts.length ? `<text x="222" y="290" font-size="17" fill="#9AA4B8">${esc(v.facts.slice(0, 2).join(" \u00b7 "))}</text>${v.facts[2] ? `<text x="222" y="314" font-size="17" fill="#9AA4B8">${esc(v.facts[2])}</text>` : ""}` : ""}
${rows}${tail ? `<text x="32" y="${Math.min(y + 16, 560)}" font-size="17" font-weight="700" fill="#38BDF8">${esc(tail)}</text>` : ""}
<text x="32" y="580" font-size="14" fill="#6f7990">Danger warnings only</text><text x="568" y="580" font-size="15" font-weight="700" fill="#9AA4B8" text-anchor="end">${esc(host)}/rugradar</text>
</svg>`;
}

export function renderSharePng(v: ShareData, host: string): Buffer {
  return new Resvg(shareSvg(v, host), { font: { fontFiles: FONTS, loadSystemFonts: false, defaultFontFamily: "DejaVu Sans" }, fitTo: { mode: "original" } }).render().asPng();
}

/** Per-mint cache of card data + PNG (bounded: 300 entries, ~30-60 KB each). */
const TTL = 6 * 3600_000, MAX = 300;
const cache = new Map<string, { at: number; v: ShareData; png?: Buffer }>();
export function __resetShare() { cache.clear(); }
export function primeShare(v: ShareData) {
  const k = `${v.chain}:${v.token}`; cache.delete(k); cache.set(k, { at: Date.now(), v });
  while (cache.size > MAX) cache.delete(cache.keys().next().value!);
}
export function cachedShare(chain: string, token: string) {
  const h = cache.get(`${chain}:${token}`); if (!h) return null;
  if (Date.now() - h.at > TTL) { cache.delete(`${chain}:${token}`); return null; }
  return h;
}
let rendering = 0;
/** PNG for a mint; `load` runs only on a cache miss. Max 2 renders at once to keep memory low. */
export async function sharePng(chain: string, token: string, host: string, load: () => Promise<ShareData>): Promise<Buffer> {
  let h = cachedShare(chain, token);
  if (!h) { primeShare(await load()); h = cachedShare(chain, token)!; }
  if (h.png) return h.png;
  if (rendering >= 2) throw Object.assign(new Error("busy"), { code: "busy" });
  rendering++;
  try { h.png = renderSharePng(h.v, host); return h.png; } finally { rendering--; }
}
