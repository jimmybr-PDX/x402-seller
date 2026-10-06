/**
 * News search over free, keyless sources:
 *  - GDELT GKG 15-minute article files (open data, any use): a local index of every headline
 *    GDELT saw in the last 24 h (see gkg.ts). No API, so no per-IP rate limit.
 *  - GDELT DOC 2.0 API (optional, NEWS_GDELT_API=1). Hard limit 1 request / 5 s per IP: we
 *    serialize calls (>= 6 s apart), cache 10 min, and back off 5 min after a 429.
 *  - Hacker News via the public Algolia HN Search API (tech coverage).
 *  - A pool of publisher RSS/Atom headline feeds, refreshed at most every 10 min.
 *    Only headline, link, outlet and timestamp are returned (no article text).
 */
import { USER_AGENT, getJson } from "./net.js";
import { gkgItems, gkgStatus, lcWords, startGkg } from "./gkg.js";

const GDELT_API = process.env.NEWS_GDELT_API === "1";
// Outlets that get a small ranking boost over the long tail of GDELT sources.
const MAJOR = new Set(
  "reuters.com apnews.com bbc.co.uk bbc.com nytimes.com theguardian.com cnbc.com bloomberg.com wsj.com ft.com washingtonpost.com npr.org cnn.com foxnews.com aljazeera.com axios.com politico.com theverge.com techcrunch.com arstechnica.com wired.com coindesk.com cointelegraph.com theblock.co decrypt.co forbes.com businessinsider.com finance.yahoo.com yahoo.com marketwatch.com nbcnews.com cbsnews.com abcnews.go.com usatoday.com independent.co.uk news.sky.com sky.com dw.com france24.com economist.com time.com newsweek.com latimes.com thehill.com engadget.com variety.com hollywoodreporter.com billboard.com espn.com nature.com science.org space.com"
    .split(" "),
);

export type NewsArticle = {
  title: string;
  url: string;
  source: string;
  publishedAt: string | null;
  provider: "gdelt" | "hackernews" | "rss";
  score?: number;
  partialMatch?: boolean;
  points?: number;
};

const FEEDS: { name: string; url: string }[] = [
  { name: "BBC News", url: "https://feeds.bbci.co.uk/news/rss.xml" },
  { name: "BBC World", url: "https://feeds.bbci.co.uk/news/world/rss.xml" },
  { name: "BBC Business", url: "https://feeds.bbci.co.uk/news/business/rss.xml" },
  { name: "BBC Technology", url: "https://feeds.bbci.co.uk/news/technology/rss.xml" },
  { name: "NPR", url: "https://feeds.npr.org/1001/rss.xml" },
  { name: "The Guardian World", url: "https://www.theguardian.com/world/rss" },
  { name: "The Guardian Business", url: "https://www.theguardian.com/uk/business/rss" },
  { name: "The Guardian Technology", url: "https://www.theguardian.com/uk/technology/rss" },
  { name: "Al Jazeera", url: "https://www.aljazeera.com/xml/rss/all.xml" },
  { name: "CNBC", url: "https://www.cnbc.com/id/100003114/device/rss/rss.html" },
  { name: "CNBC Tech", url: "https://www.cnbc.com/id/19854910/device/rss/rss.html" },
  { name: "MarketWatch", url: "https://feeds.content.dowjones.io/public/rss/mw_topstories" },
  { name: "New York Times", url: "https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml" },
  { name: "Washington Post World", url: "https://feeds.washingtonpost.com/rss/world" },
  { name: "CBS News", url: "https://www.cbsnews.com/latest/rss/main" },
  { name: "Sky News World", url: "https://feeds.skynews.com/feeds/rss/world.xml" },
  { name: "Politico", url: "https://www.politico.com/rss/politicopicks.xml" },
  { name: "TechCrunch", url: "https://techcrunch.com/feed/" },
  { name: "The Verge", url: "https://www.theverge.com/rss/index.xml" },
  { name: "Ars Technica", url: "https://feeds.arstechnica.com/arstechnica/index" },
  { name: "Wired", url: "https://www.wired.com/feed/rss" },
  { name: "Engadget", url: "https://www.engadget.com/rss.xml" },
  { name: "Cointelegraph", url: "https://cointelegraph.com/rss" },
  { name: "Decrypt", url: "https://decrypt.co/feed" },
  { name: "The Block", url: "https://www.theblock.co/rss.xml" },
  { name: "ScienceDaily", url: "https://www.sciencedaily.com/rss/all.xml" },
  // More crypto/markets depth: the 1-7 day window beyond the 24 h GDELT index relies on feeds
  { name: "CoinDesk", url: "https://www.coindesk.com/arc/outboundfeeds/rss" },
  { name: "The Defiant", url: "https://thedefiant.io/api/feed" },
  { name: "CryptoSlate", url: "https://cryptoslate.com/feed/" },
  { name: "Bitcoin Magazine", url: "https://bitcoinmagazine.com/feed" },
  { name: "Bloomberg Markets", url: "https://www.bloomberg.com/feeds/markets/news.rss" },
];

const RSS_TTL_MS = 10 * 60 * 1000;
const QUERY_TTL_MS = 10 * 60 * 1000;

// ---------- text helpers ----------
const ENT: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'", hellip: "…", mdash: "—", ndash: "–", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“" };
function decode(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z0-9#]+);/gi, (m, n) => ENT[n.toLowerCase()] ?? m)
    .replace(/\s+/g, " ")
    .trim();
}
function tag(block: string, name: string): string | null {
  const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i"));
  return m ? decode(m[1]!) : null;
}
function isoDate(s: string | null): string | null {
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}
const STOP = new Set(["the", "a", "an", "of", "in", "on", "for", "and", "or", "to", "is", "are", "what", "latest", "news", "about", "with", "at", "by", "from", "new", "today", "this", "week"]);
export function terms(q: string): string[] {
  return [...new Set(q.toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}\s.$-]/gu, " ").split(/\s+/).filter((w) => w.length > 1 && !STOP.has(w)))].slice(0, 8);
}
// Light stemming: "regulation" ~ "regulators" ~ "regulatory", "rates" ~ "rate".
function stem(w: string): string {
  if (w.length <= 4) return w;
  return w.replace(/(ations?|ators?|atory|ings?|ions?|ers?|ed|es|s|y)$/, "") || w;
}
// lc = " word1 word2 ... " (see lcWords): whole-word and prefix tests become substring tests.
const hasTerm = (lc: string, w: string) => {
  const st = stem(w);
  return lc.includes(` ${w} `) || (st.length >= 4 ? lc.includes(` ${st}`) : lc.includes(` ${w}s `));
};
/** Which query terms appear in the title (stemmed, whole-word). */
// Common headline abbreviations: a title word on the right counts as all query words on the left.
const ALIASES: [string[], string[]][] = [
  [["federal", "reserve"], ["fed"]],
  [["artificial", "intelligence"], ["ai"]],
  [["united", "states"], ["us", "u.s."]],
  [["european", "union"], ["eu"]],
  [["interest", "rates"], ["rates"]],
  [["interest", "rate"], ["rate"]],
];
const ACTIVE_ALIASES = (ts: string[]) => ALIASES.map(([phrase, abbrs]) => ({ idx: phrase.map((p) => ts.indexOf(p)), abbrs })).filter((a) => a.idx.every((i) => i >= 0));
function matched(lc: string, ts: string[], aliases = ACTIVE_ALIASES(ts)): boolean[] {
  const m = ts.map((w) => hasTerm(lc, w));
  for (const { idx, abbrs } of aliases) if (abbrs.some((a) => lc.includes(` ${a} `))) for (const i of idx) m[i] = true;
  return m;
}

// ---------- RSS pool ----------
type FeedItem = { title: string; url: string; source: string; publishedAt: string | null };
let rssCache: { at: number; items: FeedItem[]; ok: number } | null = null;
let rssInflight: Promise<{ at: number; items: FeedItem[]; ok: number }> | null = null;

async function fetchFeed(f: { name: string; url: string }): Promise<FeedItem[]> {
  const res = await fetch(f.url, { signal: AbortSignal.timeout(6000), headers: { "user-agent": USER_AGENT, accept: "application/rss+xml, application/atom+xml, application/xml, text/xml" } });
  if (!res.ok) throw new Error(`${res.status}`);
  const xml = (await res.text()).slice(0, 3_000_000);
  const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>|<entry[\s>][\s\S]*?<\/entry>/gi) ?? [];
  const out: FeedItem[] = [];
  for (const b of blocks.slice(0, 80)) {
    const title = tag(b, "title");
    let url = tag(b, "link");
    if (!url) url = b.match(/<link[^>]*href="([^"]+)"/i)?.[1] ?? null;
    if (!title || !url || !/^https?:\/\//.test(url)) continue;
    const date = tag(b, "pubDate") ?? tag(b, "published") ?? tag(b, "updated") ?? tag(b, "dc:date");
    out.push({ title, url: url.trim(), source: f.name, publishedAt: isoDate(date) });
  }
  return out;
}

async function rssPool() {
  if (rssCache && Date.now() - rssCache.at < RSS_TTL_MS) return rssCache;
  // Stale-while-revalidate: serve the old pool (< 1 h) instantly and refresh in the background.
  if (rssCache && Date.now() - rssCache.at < 6 * RSS_TTL_MS) {
    if (!rssInflight) void refreshRss();
    return rssCache;
  }
  return refreshRss();
}
export function warmNews(): void {
  void refreshRss().catch(() => {});
  startGkg();
}
export function newsStatus() {
  return { gdeltGkg: gkgStatus(), gdeltApi: GDELT_API ? (Date.now() < gdeltBackoffUntil ? "backoff" : "on") : "off", rssFeedsOk: rssCache ? `${rssCache.ok}/${FEEDS.length}` : "warming", rssItems: rssCache?.items.length ?? 0 };
}
async function refreshRss() {
  if (rssInflight) return rssInflight;
  rssInflight = (async () => {
    const results = await Promise.allSettled(FEEDS.map(fetchFeed));
    const items = results.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
    const ok = results.filter((r) => r.status === "fulfilled").length;
    const fresh = { at: Date.now(), items, ok };
    if (items.length || !rssCache) rssCache = fresh; // keep stale pool if every feed failed
    return rssCache!;
  })().finally(() => {
    rssInflight = null;
  });
  return rssInflight;
}

// ---------- GDELT (strictly throttled) ----------
let gdeltNextAt = 0;
let gdeltChain: Promise<unknown> = Promise.resolve();
let gdeltBackoffUntil = 0;
const gdeltCache = new Map<string, { at: number; items: NewsArticle[] }>();

async function gdelt(q: string, hours: number, max: number): Promise<{ items: NewsArticle[]; status: string }> {
  const key = `${q}|${hours}`;
  const hit = gdeltCache.get(key);
  if (hit && Date.now() - hit.at < QUERY_TTL_MS) return { items: hit.items, status: "cache" };
  if (!GDELT_API) return { items: [], status: "off" };
  if (Date.now() < gdeltBackoffUntil) return { items: [], status: "backoff" };
  // Serialize: one call at a time, >= 6 s apart. Give up if we would wait > 7 s.
  if (gdeltNextAt - Date.now() > 7000) return { items: [], status: "busy" };
  const run = gdeltChain.then(async () => {
    const wait = gdeltNextAt - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    gdeltNextAt = Date.now() + 6000;
    const ts = terms(q);
    const query = ts.length > 1 ? `(${ts.map((t) => (/[^a-z0-9]/.test(t) ? `"${t}"` : t)).join(" ")}) sourcelang:english` : `${ts[0] ?? q} sourcelang:english`;
    const url = `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(query)}&mode=artlist&format=json&maxrecords=${Math.min(75, max * 3)}&timespan=${Math.max(1, Math.round(hours))}h&sort=hybridrel`;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5000), headers: { "user-agent": USER_AGENT } });
      if (res.status === 429) {
        gdeltBackoffUntil = Date.now() + 5 * 60 * 1000;
        return { items: [], status: "rate_limited" };
      }
      if (!res.ok) return { items: [], status: `http_${res.status}` };
      const text = await res.text();
      let j: any;
      try {
        j = JSON.parse(text);
      } catch {
        return { items: [], status: "bad_json" };
      }
      const items: NewsArticle[] = (j.articles ?? []).map((a: any) => ({
        title: decode(String(a.title ?? "")),
        url: String(a.url ?? ""),
        source: String(a.domain ?? ""),
        publishedAt: a.seendate ? isoDate(String(a.seendate).replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, "$1-$2-$3T$4:$5:$6Z")) : null,
        provider: "gdelt" as const,
      })).filter((a: NewsArticle) => a.title && /^https?:\/\//.test(a.url));
      gdeltCache.set(key, { at: Date.now(), items });
      if (gdeltCache.size > 500) gdeltCache.delete(gdeltCache.keys().next().value!);
      return { items, status: "ok" };
    } catch {
      gdeltBackoffUntil = Date.now() + 60 * 1000;
      return { items: [], status: "timeout" };
    }
  });
  gdeltChain = run.catch(() => {});
  return run;
}

// ---------- Hacker News ----------
const hnCache = new Map<string, { at: number; items: NewsArticle[] }>();
async function hackernews(q: string, hours: number, max: number): Promise<NewsArticle[]> {
  const key = `${q}|${hours}`;
  const hit = hnCache.get(key);
  if (hit && Date.now() - hit.at < QUERY_TTL_MS) return hit.items;
  const since = Math.floor(Date.now() / 1000 - hours * 3600);
  const j = await getJson<any>(
    `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(q)}&tags=story&numericFilters=created_at_i>${since},points>2&hitsPerPage=${Math.min(30, max * 2)}`,
    5000,
  );
  const items: NewsArticle[] = (j?.hits ?? []).map((h: any) => ({
    title: String(h.title ?? ""),
    url: h.url ? String(h.url) : `https://news.ycombinator.com/item?id=${h.objectID}`,
    source: h.url ? (() => { try { return new URL(h.url).hostname.replace(/^www\./, ""); } catch { return "news.ycombinator.com"; } })() : "news.ycombinator.com",
    publishedAt: h.created_at ?? null,
    provider: "hackernews" as const,
    points: h.points ?? 0,
  })).filter((a: NewsArticle) => a.title);
  hnCache.set(key, { at: Date.now(), items });
  if (hnCache.size > 500) hnCache.delete(hnCache.keys().next().value!);
  return items;
}

// ---------- main ----------
function normUrl(u: string): string {
  try {
    const x = new URL(u);
    x.hash = "";
    for (const k of [...x.searchParams.keys()]) if (/^(utm_|at_|cmp|ref|ocid)/i.test(k)) x.searchParams.delete(k);
    return (x.hostname.replace(/^www\./, "") + x.pathname.replace(/\/$/, "") + x.search).toLowerCase();
  } catch {
    return u.toLowerCase();
  }
}
const normTitle = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, 80);

export async function newsSearch(qRaw: string, opts: { hours?: number; limit?: number } = {}) {
  const started = Date.now();
  const q = qRaw.trim().slice(0, 200);
  const ts = terms(q);
  if (!ts.length) return { error: "no_search_terms" as const };
  const fin = (v: number | undefined, d: number) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v) : d);
  const hours = Math.min(168, Math.max(1, fin(opts.hours, 72)));
  const limit = Math.min(25, Math.max(1, fin(opts.limit, 10)));
  const cutoff = Date.now() - hours * 3600 * 1000;
  const need = 2; // internal score levels: 2 = strict match, 1 = partial
  const relaxed = 1;

  const [g, hn, pool] = await Promise.all([gdelt(q, hours, limit), hackernews(q, hours, limit), rssPool()]);
  const rss: NewsArticle[] = pool.items
    .filter((i) => !i.publishedAt || Date.parse(i.publishedAt) >= cutoff)
    .map((i) => ({ ...i, provider: "rss" as const }));

  // GDELT GKG index: only titles that contain at least one query term become candidates.
  const aliases = ACTIVE_ALIASES(ts);
  const gk = gkgItems();
  const gkC: NewsArticle[] = [];
  const gkM: boolean[][] = [];
  for (const it of gk) {
    if (it.t < cutoff) continue;
    const m = matched(it.lc, ts, aliases);
    if (!m.some(Boolean)) continue;
    gkC.push({ title: it.title, url: it.url, source: it.source, publishedAt: new Date(it.t).toISOString(), provider: "gdelt" });
    gkM.push(m);
  }
  // IDF weights from the candidate pool: rare terms ("Starship") matter more than common ones ("launch").
  const small = [...rss, ...g.items, ...hn];
  const cands = [...small, ...gkC];
  const marks = [...small.map((a) => matched(lcWords(a.title), ts, aliases)), ...gkM];
  const N = rss.length + g.items.length + hn.length + gk.length + 1;
  const idf = ts.map((_, i) => Math.log(N / (1 + marks.filter((m) => m[i]).length)) + 0.1);
  // Terms that never occur in any candidate can't help rank; weight only the ones that do.
  const present = ts.map((_, i) => marks.some((m) => m[i]));
  // A term found nowhere still counts (at 70% weight): "Oregon wildfire" with no wildfire
  // headlines should come back empty (uncharged), not as a list of unrelated Oregon stories.
  const idfSum = idf.reduce((x, y, i) => x + (present[i] ? y : 0.7 * y), 0) || 1;
  const top = idf.reduce((best, v, i) => (present[i] && (best < 0 || v > idf[best]!) ? i : best), -1);

  const all: NewsArticle[] = [];
  const seenU = new Set<string>();
  const seenT = new Set<string>();
  const gdeltDocUrls = new Set(g.items.map((a) => a.url));
  for (const [i, a] of cands.entries()) {
    const m = marks[i]!;
    const hitCount = m.filter(Boolean).length;
    const cover = m.reduce((acc, ok, k) => acc + (ok ? idf[k]! : 0), 0) / idfSum;
    const hasTop = top >= 0 && m[top]!;
    // GDELT already matched article body text; keep it unless its title is clearly off-topic.
    const strictOk = hitCount === ts.length || (ts.length > 2 && hitCount >= ts.length - 1 && cover >= 0.8 && hasTop);
    // GDELT DOC API results already matched article body text; keep unless the title is clearly off-topic.
    // Two-word queries need the matched word to carry most of the weight (>= 0.6) for a partial hit.
    const relaxedOk = gdeltDocUrls.has(a.url) ? hitCount > 0 || ts.length === 1 : cover >= (ts.length === 2 ? 0.6 : 0.5) && hasTop;
    if (!strictOk && !relaxedOk) continue;
    const s = strictOk ? need : relaxed;
    if (a.publishedAt && Date.parse(a.publishedAt) < cutoff) continue;
    const u = normUrl(a.url);
    const t = normTitle(a.title);
    if (seenU.has(u) || seenT.has(t)) continue;
    seenU.add(u);
    seenT.add(t);
    const ageH = a.publishedAt ? (Date.now() - Date.parse(a.publishedAt)) / 3.6e6 : hours;
    const pop = a.provider === "hackernews" ? Math.min(1, Math.log10(1 + (a.points ?? 0)) / 3) : 0;
    const major = a.provider === "rss" || MAJOR.has(a.source.replace(/^www\./, "")) ? 0.15 : 0;
    all.push({ ...a, partialMatch: s < need, score: Math.round((s / 2 + Math.max(0, 1 - ageH / hours) * 0.5 + pop * 0.3 + major) * 1000) / 1000 } as NewsArticle);
  }
  all.sort((a, b) => b.score! - a.score! || (Date.parse(b.publishedAt ?? "") || 0) - (Date.parse(a.publishedAt ?? "") || 0));
  const strict = all.filter((a) => !a.partialMatch);
  // Only fall back to partial matches when strict matches are thin.
  const pick0 = strict.length >= Math.min(3, limit) ? strict : [...strict, ...all.filter((a) => a.partialMatch)];
  // Outlet diversity: at most 3 headlines per outlet.
  const perSource = new Map<string, number>();
  const pick = pick0.filter((a) => {
    const n = (perSource.get(a.source) ?? 0) + 1;
    perSource.set(a.source, n);
    return n <= 3;
  });
  const articles = pick.slice(0, limit).map(({ points, ...a }) => (points ? { ...a, points } : a));
  const gs = gkgStatus();
  if (!articles.length) return { error: "no_recent_articles" as const, query: q, hours, providerStatus: { gdeltIndex: gs.articles, gdeltApi: g.status, hackernews: hn.length, rssFeedsOk: pool.ok } };
  return {
    query: q,
    terms: ts,
    hours,
    count: articles.length,
    articles,
    outlets: [...new Set(articles.map((a) => a.source))].slice(0, 15),
    providers: [...new Set(articles.map((a) => a.provider))],
    totalMatches: all.length,
    providerStatus: { gdeltIndex: { articles: gs.articles, hours: gs.hours, newest: gs.newest }, gdeltApi: g.status, hackernews: hn.length, rssFeeds: `${pool.ok}/${FEEDS.length}`, rssPoolAgeSec: Math.round((Date.now() - pool.at) / 1000) },
    note: "Headlines and links only; open the url (or /read) for the full article. Sources: GDELT Project global news index (gdeltproject.org, last 24 h), ~26 major-outlet RSS feeds, Hacker News.",
    latencyMs: Date.now() - started,
    generatedAt: new Date().toISOString(),
  };
}
