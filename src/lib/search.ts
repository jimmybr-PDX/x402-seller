/**
 * Web search (no API key): Bing HTML results -> Bing RSS -> DuckDuckGo HTML -> Wikipedia search, first source
 * that returns usable results wins. Top pages are fetched in parallel (short timeout) and their main text is
 * extracted with the /read extractor. Small in-memory cache. DDG answers datacenter IPs with a 202 "anomaly"
 * captcha, so it is a fallback only.
 */
import { htmlToMarkdown } from "./read.js";
import { safeFetch, InputError } from "./net.js";
import { execFile } from "node:child_process";

const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36";
const ENT: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'", hellip: "…", mdash: "—", ndash: "–", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", middot: "·", ensp: " ", emsp: " " };
const decode = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const n = e[1]?.toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return ENT[e.toLowerCase()] ?? m;
  });
const strip = (s: string) => decode(s.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();

type Hit = { title: string; url: string; snippet: string; published?: string | null };
export type SearchResult = { rank: number; title: string; url: string; domain: string; snippet: string; published: string | null; text: string | null };

async function get(url: string, init: RequestInit = {}, ms = 6000): Promise<{ status: number; body: string }> {
  const r = await fetch(url, { ...init, signal: AbortSignal.timeout(ms), headers: { "user-agent": BROWSER_UA, "accept-language": "en-US,en;q=0.9", accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8", ...(init.headers as any) } });
  return { status: r.status, body: await r.text() };
}

function unwrapBing(href: string): string {
  try {
    const u = new URL(href);
    if (/bing\.com$/.test(u.hostname) && u.pathname.startsWith("/ck/")) {
      const enc = u.searchParams.get("u");
      if (enc?.startsWith("a1")) return Buffer.from(enc.slice(2).replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    }
  } catch {}
  return href;
}
function unwrapDdg(href: string): string {
  try {
    const u = new URL(href, "https://duckduckgo.com");
    if (/duckduckgo\.com$/.test(u.hostname) && u.pathname.startsWith("/l/")) return u.searchParams.get("uddg") ?? href;
  } catch {}
  return href;
}

/** Brave answers Node's fetch (TLS/HTTP fingerprint) with 429 but serves curl over HTTP/2, so use curl (argv, no shell). */
function curlGet(url: string, ms = 7000): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    execFile("curl", ["-s", "--http2", "--compressed", "--max-time", String(ms / 1000), "-A", BROWSER_UA, "-H", "accept: text/html,application/xhtml+xml,*/*;q=0.8", "-H", "accept-language: en-US,en;q=0.9", "-w", "\n%{http_code}", url], { maxBuffer: 4_000_000, timeout: ms + 1000 }, (err, stdout) => {
      if (err) return reject(new Error(`curl ${(err as any).code ?? err.message}`));
      const i = stdout.lastIndexOf("\n");
      resolve({ status: Number(stdout.slice(i + 1)), body: stdout.slice(0, i) });
    });
  });
}

async function braveHtml(q: string): Promise<Hit[]> {
  const url = `https://search.brave.com/search?q=${encodeURIComponent(q)}&source=web`;
  let r = await curlGet(url);
  if (r.status === 429) { await new Promise((ok) => setTimeout(ok, 1200)); r = await curlGet(url); } // short burst limit
  if (r.status !== 200) throw new Error(`brave ${r.status}`);
  const hits: Hit[] = [];
  for (const b of r.body.split(/<div class="snippet[^"]*" data-pos="\d+" data-type="web"/).slice(1)) {
    const url = b.match(/<a href="(https?:[^"]+)"/)?.[1];
    const title = b.match(/class="title search-snippet-title[^"]*"[^>]*>([\s\S]*?)<\/div>/)?.[1];
    if (!url || !title) continue;
    let snip = strip(b.match(/class="content desktop-default-regular[^"]*"[^>]*>([\s\S]*?)<\/div>/)?.[1] ?? "");
    const dm = snip.match(/^((?:[A-Z][a-z]+ \d{1,2}, \d{4})|(?:\d+ (?:hours?|days?|weeks?) ago)) -\s*/);
    let published: string | null = null;
    if (dm) {
      snip = snip.slice(dm[0].length);
      const rel = dm[1]!.match(/^(\d+) (hour|day|week)/);
      const t = rel ? Date.now() - Number(rel[1]) * { hour: 36e5, day: 864e5, week: 6048e5 }[rel[2] as "hour"] : Date.parse(dm[1]! + " UTC");
      if (!isNaN(t)) published = new Date(t).toISOString().slice(0, rel ? 13 : 10) + (rel ? ":00:00Z" : "");
    }
    hits.push({ url: decode(url), title: strip(title), snippet: snip, published });
  }
  return hits;
}

async function bingHtml(q: string): Promise<Hit[]> {
  const r = await get(`https://www.bing.com/search?q=${encodeURIComponent(q)}&setlang=en&cc=US&count=20`);
  if (r.status !== 200) throw new Error(`bing ${r.status}`);
  const hits: Hit[] = [];
  for (const block of r.body.split(/<li class="b_algo"/).slice(1)) {
    const a = block.match(/<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!a) continue;
    const snip = block.match(/<p[^>]*class="[^"]*b_lineclamp[^"]*"[^>]*>([\s\S]*?)<\/p>/i)?.[1] ?? block.match(/<div class="b_caption"[^>]*>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/i)?.[1] ?? block.match(/<p[^>]*>([\s\S]*?)<\/p>/i)?.[1] ?? "";
    hits.push({ url: unwrapBing(decode(a[1]!)), title: strip(a[2]!), snippet: strip(snip).replace(/^\d{1,2} \w{3,9} \d{4}\s*·\s*|^\w{3} \d{1,2}, \d{4}\s*·\s*/, "") });
  }
  return hits;
}
async function bingRss(q: string): Promise<Hit[]> {
  const r = await get(`https://www.bing.com/search?format=rss&q=${encodeURIComponent(q)}&setlang=en&cc=US`);
  if (r.status !== 200) throw new Error(`bing-rss ${r.status}`);
  return [...r.body.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => ({
    title: strip(m[1]!.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? ""),
    url: decode(m[1]!.match(/<link>([\s\S]*?)<\/link>/)?.[1] ?? "").trim(),
    snippet: strip(m[1]!.match(/<description>([\s\S]*?)<\/description>/)?.[1] ?? ""),
  }));
}
async function ddgHtml(q: string): Promise<Hit[]> {
  const r = await get("https://html.duckduckgo.com/html/", { method: "POST", body: new URLSearchParams({ q, kl: "us-en" }), headers: { "content-type": "application/x-www-form-urlencoded" } }, 3500);
  if (r.status !== 200 || /anomaly/i.test(r.body)) throw new Error(`ddg ${r.status}${/anomaly/i.test(r.body) ? " captcha" : ""}`);
  return r.body.split(/class="result results_links/).slice(1).filter((b) => !/result--ad/.test(b.slice(0, 200))).map((b) => ({
    url: unwrapDdg(decode(b.match(/class="result__a"[^>]*href="([^"]+)"/)?.[1] ?? "")),
    title: strip(b.match(/class="result__a"[^>]*>([\s\S]*?)<\/a>/)?.[1] ?? ""),
    snippet: strip(b.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/)?.[1] ?? ""),
  }));
}
async function wikipedia(q: string): Promise<Hit[]> {
  const r = await get(`https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&srlimit=10&srsearch=${encodeURIComponent(q)}`);
  const j = JSON.parse(r.body);
  return (j?.query?.search ?? []).map((s: any) => ({ title: s.title, url: `https://en.wikipedia.org/wiki/${encodeURIComponent(s.title.replace(/ /g, "_"))}`, snippet: strip(s.snippet) }));
}

// Bing serves off-topic results to cookieless clients from some datacenter IPs, so Bing hits must pass the
// relevance check below; DDG often captchas datacenter IPs (202 "anomaly").
const SOURCES: [string, (q: string) => Promise<Hit[]>][] = [["brave", braveHtml], ["duckduckgo", ddgHtml], ["bing", bingHtml], ["bing-rss", bingRss], ["wikipedia", wikipedia]];
const STOP = new Set("a an and are as at be by for from how i in is it near of on or the to what when where which who why with vs best top latest today news define definition meaning review".split(" "));
const terms = (q: string) => [...new Set(q.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1 && !STOP.has(w)))];
/** Share of query terms found in title+snippet+url. */
function relevance(h: Hit, t: string[]): number {
  if (!t.length) return 1;
  const hay = `${h.title} ${h.snippet} ${h.url}`.toLowerCase();
  return t.filter((w) => hay.includes(w)).length / t.length;
}
const JUNK_HOST = /(^|\.)(bing\.com|duckduckgo\.com|microsoft\.com\/en-us\/bing|go\.microsoft\.com|doubleclick\.net|googleadservices\.com|msn\.com\/en-us\/shopping)$/i;

function clean(hits: Hit[], n: number, t: string[]): (Hit & { domain: string })[] {
  const seenUrl = new Set<string>(), perDomain = new Map<string, number>(), out: (Hit & { domain: string })[] = [];
  for (const h of hits) {
    let u: URL;
    try { u = new URL(h.url); } catch { continue; }
    if (!/^https?:$/.test(u.protocol) || !h.title || JUNK_HOST.test(u.hostname) || /[?&](ad_?id|aclk|msclkid)=/i.test(u.search)) continue;
    if (relevance(h, t) * t.length < Math.ceil(t.length * 0.6)) continue; // 1-2 terms: all; 3: 2; 5: 3
    const domain = u.hostname.replace(/^www\./, "");
    const key = domain + u.pathname.replace(/\/$/, "");
    if (seenUrl.has(key)) continue;
    const c = perDomain.get(domain) ?? 0;
    if (c >= 2) continue; // at most 2 results per domain
    seenUrl.add(key); perDomain.set(domain, c + 1);
    out.push({ ...h, url: u.toString(), domain });
    if (out.length >= n) break;
  }
  return out;
}

const PAGE_TEXT_MAX = 1500;
async function pageText(url: string): Promise<{ text: string | null; published: string | null }> {
  try {
    const r = await safeFetch(url.replace(/^http:/, "https:"), { timeoutMs: 4500, maxBytes: 1_500_000, accept: "text/html,application/xhtml+xml" });
    if (r.status >= 400 || !/html|xml/i.test(r.headers.get("content-type") ?? "html")) return { text: null, published: null };
    const o = htmlToMarkdown(r.body, r.url);
    const text = o.markdown
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1") // links -> text
      .replace(/^#{1,6} /gm, "").replace(/[*`]/g, "").replace(/^- /gm, "• ")
      .split("\n").map((l) => l.trim())
      .filter((l) => (l.length > 30 || /[.!?:]$/.test(l)) && !/[{}]|=>|\bfunction\s*\(|^\W*$/.test(l) && !/^(skip to|sign in|log in|subscribe|accept (all )?cookies|your browser doesn)/i.test(l))
      .join("\n")
      .replace(/\n{2,}/g, "\n").trim();
    const pub = o.published && !isNaN(Date.parse(o.published)) ? new Date(o.published).toISOString() : null;
    return { text: text ? (text.length > PAGE_TEXT_MAX ? text.slice(0, PAGE_TEXT_MAX).replace(/\s+\S*$/, "") + "…" : text) : null, published: pub };
  } catch {
    return { text: null, published: null };
  }
}

const cache = new Map<string, { at: number; v: any }>();
const TTL = 10 * 60 * 1000;

export async function webSearch(qRaw: string, nRaw?: number) {
  const q = qRaw.replace(/\s+/g, " ").trim();
  if (q.length < 2 || q.length > 300) throw new InputError("q is required (2-300 chars)");
  const n = Math.min(10, Math.max(1, Math.floor(Number(nRaw) || 5)));
  const key = `${q.toLowerCase()}|${n}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return { ...hit.v, cached: true };
  const started = Date.now();
  const qt = terms(q);
  const tried: Record<string, string> = {};
  let source = "", hits: (Hit & { domain: string })[] = [];
  for (const [name, fn] of SOURCES) {
    try {
      const h = clean(await fn(q), n, qt);
      tried[name] = `ok (${h.length})`;
      if (h.length >= Math.min(3, n) || (h.length && name === "wikipedia")) { source = name; hits = h; break; }
      if (h.length > hits.length) { source = name; hits = h; }
    } catch (e) {
      tried[name] = e instanceof Error ? e.message : String(e);
    }
  }
  if (!hits.length) return { error: "no_results", query: q, sources_tried: tried };
  const pages = await Promise.all(hits.map((h) => pageText(h.url)));
  const results: SearchResult[] = hits.map((h, i) => ({ rank: i + 1, title: h.title, url: h.url, domain: h.domain, snippet: h.snippet, published: pages[i]!.published ?? h.published ?? null, text: pages[i]!.text }));
  const v = { query: q, n, count: results.length, results, source, sources_tried: tried, pages_loaded: pages.filter((p) => p.text).length, fetched_at: new Date().toISOString(), latencyMs: Date.now() - started };
  cache.set(key, { at: Date.now(), v });
  if (cache.size > 300) cache.delete(cache.keys().next().value!);
  return v;
}
