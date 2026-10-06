/**
 * Permalinks for paid /report answers: /a/<id> (HTML) and /a/<id>?format=json.
 * In memory only (Render free has no persistent disk): answers vanish on restart/deploy.
 * Stores only the answer itself (question, answer, sources). No IP, user agent, payer or payment data.
 */
import { randomBytes } from "node:crypto";

const MAX = 500; // ~5-8 KB each => a few MB at most
const TTL_MS = 30 * 864e5;
const store = new Map<string, { at: number; body: any }>();
const pinned = new Map<string, any>(); // e.g. the documented example answer; never evicted
export const pinAnswer = (id: string, body: unknown) => void pinned.set(id, body);

export const newAnswerId = () => randomBytes(9).toString("base64url"); // 12 chars, unguessable
export function saveAnswer(id: string, body: unknown): void {
  store.set(id, { at: Date.now(), body });
  while (store.size > MAX) store.delete(store.keys().next().value!);
}
export function getAnswer(id: string): any | null {
  if (pinned.has(id)) return pinned.get(id);
  const e = store.get(id);
  if (!e) return null;
  if (Date.now() - e.at > TTL_MS) { store.delete(id); return null; }
  return e.body;
}
export const deleteAnswer = (id: string) => void store.delete(id);
export const answerCount = () => store.size;

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const pt = (iso: string) => {
  const d = new Date(iso);
  return isNaN(+d) ? "" : `${d.toLocaleString("en-US", { timeZone: "America/Los_Angeles", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" })} PT`;
};
const cites = (ids: number[]) => ids.map((i) => `<a href="#s${i}" class="c">[${i}]</a>`).join("");

export function answerHtml(a: any, serviceUrl: string, serviceName: string): string {
  const srcs = (a.sources ?? []) as any[];
  const points = (a.key_points ?? []) as { text: string; citations: number[] }[];
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(a.query)} — cited answer</title><meta name="description" content="${esc(String(a.answer ?? "").slice(0, 160))}">
<link rel="canonical" href="${esc(a.permalink)}"><link rel="alternate" type="application/json" href="${esc(a.permalink)}?format=json">
<style>body{font:17px/1.55 system-ui,-apple-system,sans-serif;margin:0 auto;max-width:720px;padding:18px;color:#1a1a1a}
h1{font-size:1.35rem;line-height:1.3;margin:.3em 0}.ans{font-size:1.1rem;background:#f5f7fa;border-left:4px solid #0057b8;padding:12px 14px;margin:14px 0}
a{color:#0057b8}.c{font-size:.8em;text-decoration:none;margin-left:2px}li{margin:6px 0}.meta,.src small{color:#666;font-size:.88rem}
.src{margin:10px 0}.src blockquote{margin:4px 0 0;padding-left:10px;border-left:3px solid #ddd;color:#444;font-size:.93rem}
footer{margin-top:28px;padding-top:12px;border-top:1px solid #e5e5e5;font-size:.9rem;color:#555}</style></head><body>
<h1>${esc(a.query)}</h1>
<div class="ans">${esc(a.answer)} ${cites(a.answer_citations ?? [])}</div>
${points.length ? `<h2 style="font-size:1.05rem">Key points</h2><ul>${points.map((p) => `<li>${esc(p.text)} ${cites(p.citations)}</li>`).join("")}</ul>` : ""}
<p class="meta">Confidence: <b>${esc(a.confidence)}</b> — ${esc(a.confidence_why)}<br>Checked ${esc(pt(a.checked_at))}</p>
<h2 style="font-size:1.05rem">Sources</h2>
${srcs.map((s) => `<div class="src" id="s${s.id}">[${s.id}] <a href="${esc(s.url)}" rel="noopener nofollow">${esc(s.title)}</a><br><small>${esc(s.publisher ?? s.provider)}${s.published ? ` · ${esc(s.published)}` : ""}</small>${s.quote ? `<blockquote>“${esc(s.quote)}”</blockquote>` : ""}</div>`).join("")}
<footer>Answered by <a href="${esc(serviceUrl)}">${esc(serviceName)} — x402</a>: cited answers for AI agents, $0.01 per question. · <a href="?format=json">JSON</a><br>
<small>This page is kept temporarily and may disappear when the server restarts.</small></footer>
</body></html>`;
}
