/**
 * Per-token X share preview for RugRadar. /rugradar?t=<mint>&s=x gets per-token og/twitter tags whose image is
 * /rugradar/share/<chain>/<token>.png: a 600x600 card (twitter:card "summary") drawn like the site: token name + short
 * address, the score dial, up to 3 free-check danger warnings and free facts (top-10 %, liquidity, age).
 * Only free-check data (limitedReport): never paid/unlocked details or private signals, and never the word "safe".
 * Results are cached per chain:mint (6 h) and primed by the site's own free check, so the X crawler normally costs no
 * new check; a cache miss runs the same cached free check (rugCheck) the embed uses.
 */
import { Resvg } from "@resvg/resvg-js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { cleanTokenText } from "./token-name.js";

export type ShareData = { token: string; chain: string; name: string; score: number; level: "high" | "medium" | "low"; label: string;
  warnings: { severity: "DANGER" | "CAUTION"; title: string }[]; more: number; facts: string[] };

const asset = (p: string) => fileURLToPath(new URL(`../assets/${p}`, import.meta.url));
const FONTS = [asset("fonts/DejaVuSans.ttf"), asset("fonts/DejaVuSans-Bold.ttf")];
let LOGO = "";
try { LOGO = "data:image/png;base64," + readFileSync(asset("rugradar/rug-radar-192.png")).toString("base64"); } catch {}
const CHAIN: Record<string, string> = { solana: "Solana", base: "Base", bnb: "BNB", ethereum: "Ethereum", arbitrum: "Arbitrum" };
const LABEL = { high: "HIGH RISK", medium: "CAUTION", low: "LOW RISK" } as const;
const COLOR = { high: "#EF4444", medium: "#F59E0B", low: "#4ade80" } as const;

/** Never show the word "safe" anywhere on the card (token names are attacker-controlled). */
export const noSafe = (s: string) => s.replace(/s(a)fe/gi, (m) => m[0] + "\u2022" + m.slice(2));
const esc = (s: string) => noSafe(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const fit = (s: string, n: number) => (Array.from(s).length > n ? Array.from(s).slice(0, n - 1).join("").trim() + "\u2026" : s);
export const shortAddr = (t: string) => (t.length > 12 ? `${t.slice(0, 4)}\u2026${t.slice(-4)}` : t);
const usdK = (n: number) => (n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(1)}K` : `$${Math.round(n)}`);
const ageTxt = (h: number) => (h < 1 ? `${Math.max(1, Math.round(h * 60))}m` : h < 48 ? `${Math.round(h)}h` : `${Math.round(h / 24)}d`);

/** Build card data from a limitedReport() result plus its warnings (warningsOf) and shown level. Free data only. */
export function shareData(l: any, ws: { sev: "DANGER" | "CAUTION"; title: string }[], level: string, token: string, chain: string): ShareData {
  const f = l?.facts ?? {}, sym = cleanTokenText(f.tokenSymbol, 20), nm = cleanTokenText(f.tokenName, 32);
  const name = nm && sym && nm.toLowerCase() !== sym.toLowerCase() ? `${nm} \u00b7 $${sym}` : sym ? `$${sym}` : nm;
  const lv = (level === "high" || level === "medium" || level === "low" ? level : "medium") as ShareData["level"];
  const facts: string[] = [];
  if (Number.isFinite(f.top10Pct)) facts.push(`Top 10 hold ${Math.round(f.top10Pct)}%`); else if (Number.isFinite(f.top1Pct)) facts.push(`Top holder ${Math.round(f.top1Pct)}%`);
  if (Number.isFinite(f.liquidityUsd)) facts.push(`Liquidity ${usdK(f.liquidityUsd)}`);
  if (Number.isFinite(f.ageHours)) facts.push(`Age ${ageTxt(f.ageHours)}`);
  return { token, chain, name, score: Math.max(0, Math.min(100, Math.round(Number(l?.riskScore) || 0))), level: lv, label: LABEL[lv],
    warnings: ws.slice(0, 3).map((w) => ({ severity: w.sev, title: w.title })), more: Math.max(0, ws.length - 3) + (Number(l?.hiddenWarnings) || 0), facts };
}

/** 600x600 SVG in the site's look (dark card, conic score dial, warning cards with red/amber bars). */
export function shareSvg(v: ShareData, host: string): string {
  const c = COLOR[v.level], p = v.level === "low" ? 100 : Math.max(4, v.score), W = 600;
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
<circle cx="${cx}" cy="${cy}" r="${r - 15}" fill="#0f1526"/><text x="${cx}" y="${cy + 14}" font-size="50" font-weight="700" fill="${v.level === "low" ? "#6CFFA0" : "#fff"}" text-anchor="middle">${v.score}</text>
<text x="${cx}" y="${cy + 38}" font-size="15" fill="#9AA4B8" text-anchor="middle">/100</text>
<text x="222" y="226" font-size="40" font-weight="700" fill="${c}">${v.label}</text><text x="222" y="258" font-size="19" fill="#C9D1E0">${sub}</text>
${v.facts.length ? `<text x="222" y="290" font-size="17" fill="#9AA4B8">${esc(v.facts.slice(0, 2).join(" \u00b7 "))}</text>${v.facts[2] ? `<text x="222" y="314" font-size="17" fill="#9AA4B8">${esc(v.facts[2])}</text>` : ""}` : ""}
${rows}${tail ? `<text x="32" y="${Math.min(y + 16, 560)}" font-size="17" font-weight="700" fill="#38BDF8">${esc(tail)}</text>` : ""}
<text x="32" y="580" font-size="14" fill="#6f7990">Not a guarantee</text><text x="568" y="580" font-size="15" font-weight="700" fill="#9AA4B8" text-anchor="end">${esc(host)}/rugradar</text>
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
