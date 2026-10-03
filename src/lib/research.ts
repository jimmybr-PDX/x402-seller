/**
 * Cited research brief built only from free, keyless public sources:
 *   Wikipedia (search + full plain-text article), Stack Overflow (Stack Exchange API, no key),
 *   GitHub (repo search + README), Hacker News (Algolia; used to discover linked articles),
 *   DuckDuckGo Instant Answer, and Crossref (scholarly works).
 * Pipeline: discover candidates -> fetch real page text -> drop off-topic sources by relevance
 * scoring against the query -> follow links to official docs -> extractive summary built from
 * the best query-matching sentences (intent-aware), every sentence cited [n].
 * Returns null when nothing relevant was found (caller answers 4xx => buyer not charged).
 */
import { getJson, safeFetch, USER_AGENT } from "./net.js";
import { htmlToMarkdown } from "./read.js";

export type Source = {
  id: number;
  type: "encyclopedia" | "instant_answer" | "discussion" | "paper" | "web_page";
  provider: string;
  title: string;
  url: string;
  snippet: string;
  publishedAt?: string | null;
  score?: number | null;
};

type Doc = Source & { text: string; quality: number; relevance: number; links: string[]; origin: string };

// ---------- text utils ----------
const ENT: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'", "#039": "'", "#x27": "'", hellip: "…", mdash: "—", ndash: "–", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“" };
const decode = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
  if (e[0] === "#") { const n = e[1]?.toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(n) ? String.fromCodePoint(n) : m; }
  return ENT[e.toLowerCase()] ?? m;
});
const strip = (s: string) => decode(s.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1).replace(/\s+\S*$/, "") + "…" : s);
const hostOf = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } };

const STOP = new Set("a an the of in on at to for from by with about into over and or but if then than so as is are was were be been being do does did doing have has had having it its this that these those there here what which who whom whose when where why how can could should would will shall may might must i me my we our you your he she they them their his her not no yes vs versus via per any some all each more most much many very just also using use used get gets explain explained tell me please".split(" "));
// words that describe the kind of answer wanted; they boost but are not required for relevance
const INTENT_WORDS = new Set("best practice practices tip tips guide guides overview history historical cause causes caused causing reason reasons why work works working definition define meaning example examples pros cons advantages disadvantages difference differences compare comparison summary introduction intro basics tutorial".split(" "));

// a few common equivalents so wording differences don't hide the answer (sleep vs "spins down after inactivity")
const SYN: Record<string, RegExp> = {
  sleep: /\b(spin(s|ning)? down|spun down|spin-down|idle|inactiv\w*|suspend\w*|cold start\w*|wake\w*|asleep)\b/i,
  price: /\b(cost\w*|pric\w*|fees?|\$\d)/i, cost: /\b(pric\w*|fees?|\$\d)/i,
  limit: /\b(quota\w*|cap(s|ped)?|maximum|max)\b/i,
  fast: /\b(speed\w*|perform\w*|latenc\w*|quick\w*)\b/i, performance: /\b(speed\w*|fast\w*|slow\w*|latenc\w*)\b/i,
  error: /\b(fail\w*|exception\w*|bug\w*)\b/i,
};
const stem = (w: string) => w.length <= 4 ? w : w.replace(/(ies)$/, "y").replace(/(ing|ed|es|s)$/, "");
const tokens = (s: string) => (s.toLowerCase().match(/[a-z0-9][a-z0-9+#._-]*[a-z0-9+#]|[a-z0-9]/g) ?? []).map((t) => t.replace(/[._-]+$/, ""));
function termMatch(tok: string, term: string): boolean {
  if (tok === term) return true;
  const a = stem(tok), b = stem(term);
  if (a === b) return true;
  return Math.min(a.length, b.length) >= 4 && (a.startsWith(b) || b.startsWith(a)) && Math.abs(a.length - b.length) <= 4;
}

type Query = { raw: string; core: string[]; aspect: string[]; intent: string[]; entities: string[]; cased: Record<string, string>; phrases: string[]; phrasesCased: string[]; siteKeys: string[]; kind: "define" | "cause" | "how" | "practice" | "history" | "compare" | "general"; keyword: string };

export function parseQuery(q: string): Query {
  const raw = q.trim();
  const words = raw.replace(/[?!.,;:()"]/g, " ").split(/\s+/).filter(Boolean);
  const core: string[] = [], intent: string[] = [];
  for (const t of tokens(raw)) {
    if (STOP.has(t)) continue;
    if (INTENT_WORDS.has(t)) { if (!intent.includes(t)) intent.push(t); continue; }
    if (!core.includes(t)) core.push(t);
  }
  // entities: capitalised (not sentence-initial question words) or alphanumeric tokens like x402, S3, GPT-4
  const entities: string[] = [];
  const cased: Record<string, string> = {};
  const phrases: string[] = [];
  const phrasesCased: string[] = [];
  let run: string[] = [];
  const flush = () => { if (run.length > 1) { phrases.push(run.join(" ").toLowerCase()); phrasesCased.push(run.join(" ")); } run = []; };
  words.forEach((w, i) => {
    const lw = w.toLowerCase();
    const isCap = /^[A-Z][a-zA-Z0-9+#-]*$/.test(w) && !(i === 0 && STOP.has(lw)) && !STOP.has(lw) && !INTENT_WORDS.has(lw);
    const isAlnum = /[a-z]/i.test(w) && /\d/.test(w);
    if ((isCap && (i > 0 || words.length <= 3 || !STOP.has(lw))) || isAlnum) { if (!entities.includes(lw)) entities.push(lw); if (isCap && !/\d/.test(w)) cased[lw] = w.replace(/[^A-Za-z0-9+#-]/g, ""); }
    if (isCap) run.push(w); else flush();
  });
  flush();
  const l = raw.toLowerCase();
  const kind: Query["kind"] =
    /\b(cause|causes|caused|why)\b/.test(l) ? "cause" :
    /\b(best practices?|tips|should i|recommend|guidelines?)\b/.test(l) ? "practice" :
    /\bhistory|historical|origins?\b/.test(l) ? "history" :
    /\b(vs\.?|versus|difference|compare)\b/.test(l) ? "compare" :
    /\bhow (do|does|to|is|are|can)\b|\bwork(s|ing)?\b/.test(l) ? "how" :
    /^(what|who) (is|are|was|were)\b|\bdefin|\bmeaning\b/.test(l) ? "define" : "general";
  const coreF = core.length ? core : intent.slice(0, 2);
  const ents = entities.filter((e) => coreF.includes(e) || /\d/.test(e));
  const inPhrase = new Set(phrases.flatMap((p) => p.split(" ")));
  // keys used to recognise the topic's own website (render -> render.com, postgres -> postgresql.org)
  const siteKeys = [...phrases.map((p) => p.replace(/[^a-z0-9]/g, "")), ...ents.filter((e) => !inPhrase.has(e)).map((e) => e.replace(/[^a-z0-9]/g, ""))].filter((k) => k.length >= 3);
  return { raw, core: coreF, aspect: coreF.filter((c) => !ents.includes(c)), intent, entities: ents, cased, phrases, phrasesCased, siteKeys, kind, keyword: [...coreF, ...intent].join(" ") || raw };
}

const CUES: Record<Query["kind"], RegExp> = {
  define: /\b(is|are) (a|an|the)\b|\brefers? to\b|\bknown as\b|\bdefined as\b/i,
  cause: /\b(caus\w*|because|due to|result(s|ed)? (of|from)|driven by|leads? to|triggers?|stems? from|demand|supply|increase\w*|rise|rising)\b/i,
  how: /\b(when|after|until|automatically|once|then|by default|each|every|minutes?|seconds?|hours?|requests?|will)\b/i,
  practice: /\b(should|shouldn'?t|avoid|prefer|consider|recommend\w*|best practice|make sure|ensure|don'?t|do not|(is|are) (usually |often |generally )?(better|wise|important|useful)|good idea|rule of thumb|sensibl\w*|overhead|trade-?offs?|only (if|when)|unless|speed up|slow down|performance)\b/i,
  history: /\b(1[0-9]{3}|20[0-2][0-9]|founded|established|settled|incorporated|became|century|first|originally|named)\b/i,
  compare: /\b(whereas|while|unlike|compared|than|both|differ\w*)\b/i,
  general: /\b(is|are)\b/i,
};

function splitSentences(text: string): { s: string; section: string; pos: number }[] {
  const out: { s: string; section: string; pos: number }[] = [];
  let section = "";
  let pos = 0;
  for (const block of text.split(/\n+/)) {
    const line = block.trim();
    if (!line) continue;
    const h = line.match(/^(?:#{1,6}\s+(.+)|={2,}\s*(.+?)\s*={2,})$/);
    if (h) { section = (h[1] ?? h[2] ?? "").trim(); continue; }
    const prot = line.replace(/\b(e\.g|i\.e|etc|vs|Mr|Mrs|Dr|St|Inc|Ltd|Jr|Sr|U\.S|U\.K|No|approx|ca)\./g, (m) => m.replace(/\./g, "\u0000"));
    const parts = prot.split(/(?<=[.!?])\s+(?=[A-Z0-9"“(\[])/);
    for (const p of parts) {
      const s = p.replace(/\u0000/g, ".").replace(/^[-*•]\s+/, "").replace(/\s+/g, " ").trim();
      const s2 = s.replace(/^(abstract|summary|tl;?dr)\s*[:.]\s*/i, "");
      if (s2) out.push({ s: /[.!?:)]$/.test(s2) ? s2 : s2 + ".", section, pos: pos++ });
    }
  }
  return out;
}

const JUNK = /\b(cookies?|subscribe|sign (up|in)|log in|click here|all rights reserved|javascript|newsletter|privacy policy|terms of (use|service)|advertis\w*|share this|follow us|copyright|this article|this section|citation needed|you may also like|read more|skip to|view a pdf|download pdf|submitted on|interactive exercises?)\b/i;
function goodSentence(s: string): boolean {
  if (s.length < 50 || s.length > 420) return false;
  if (JUNK.test(s)) return false;
  if (/https?:\/\/|```|\|.*\||\{|\}|<|>|^\W|\$\s*\w+\s*=|;\s*$/.test(s)) return false;
  const letters = (s.match(/[a-z]/gi) ?? []).length;
  if (letters / s.length < 0.65) return false;
  if ((s.match(/\b\w+\b/g) ?? []).length < 8) return false;
  return true;
}

function markdownToText(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, "\n")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, "$1") // reference-style links
    .replace(/^\s*\[[^\]]+\]:\s*\S+.*$/gm, "") // link definitions
    .replace(/([^\n])\n(?!\n|\s*([-*+>|#]|\d+[.)])\s)/g, "$1 ") // re-join hard-wrapped lines
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*|__|\*(?=\S)|(?<=\S)\*/g, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/^\s*\|.*\|\s*$/gm, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/[ \t]+/g, " ");
}

// ---------- relevance ----------
// proper noun as written in the query: capitalised first letter, rest case-insensitive ("Postgres" matches "PostgreSQL", "Go" not "go"/"Gold")
function properNounRe(c: string): RegExp {
  const esc = (ch: string) => ch.replace(/[.*+?^${}()|[\]\\#]/g, "\\$&");
  const rest = [...c.slice(1)].map((ch) => (/[a-z]/i.test(ch) ? `[${ch.toLowerCase()}${ch.toUpperCase()}]` : esc(ch))).join("");
  return new RegExp(`(^|[^A-Za-z])${esc(c[0] ?? "")}${rest}(?![a-z])`, "g");
}
function relevance(q: Query, title: string, text: string): number {
  const tt = tokens(title);
  const bt = tokens(text.slice(0, 60_000));
  const has = (arr: string[], term: string) => arr.some((t) => termMatch(t, term));
  const n = q.core.length || 1;
  let inTitle = 0, inBody = 0;
  for (const c of q.core) { if (has(tt, c)) inTitle++; if (has(bt, c)) inBody++; }
  const lowTitle = title.toLowerCase(), lowText = text.slice(0, 60_000).toLowerCase();
  if (q.kind !== "compare") for (const e of q.entities) if (!has(tt, e) && !has(bt, e)) return 0; // must mention every named entity
  const casedEntries = Object.entries(q.cased).filter(([e]) => !q.phrases.some((p) => p.split(" ").includes(e)));
  const reFor = properNounRe;
  if (q.kind === "compare" && casedEntries.length >= 2) {
    if (!casedEntries.some(([, c]) => reFor(c).test(title))) return 0; // compare: page must be about one of the things compared
  } else {
    for (const [, c] of casedEntries) if (!reFor(c).test(title) && (text.slice(0, 60_000).match(reFor(c)) ?? []).length < 2) return 0; // proper nouns must appear capitalised (Go the language, not "go")
  }
  const body60 = text.slice(0, 60_000);
  for (const p of q.phrasesCased) if (!title.includes(p) && (body60.split(p).length - 1) < 3) return 0; // multi-word names: in title, or repeatedly in body (case-sensitive)
  const bodyCov = inBody / n;
  if (bodyCov < (n >= 4 ? 0.5 : n === 3 ? 0.66 : 1)) return 0;
  // a page that only mentions the topic in passing is off-topic: need title coverage or repeated mentions
  const count = (term: string) => bt.filter((t) => termMatch(t, term)).length;
  if (inTitle / n < 0.5 && !(q.entities.every((e) => count(e) >= 3) && q.core.filter((c) => count(c) >= 2).length >= Math.ceil(n * 0.6))) return 0;
  // frequency of core terms (saturating) so a passing mention scores low
  let freq = 0;
  for (const c of q.core) freq += Math.min(1, count(c) / 4);
  return Number((0.45 * (inTitle / n) + 0.35 * bodyCov + 0.2 * (freq / n)).toFixed(3));
}

function sourceQuality(url: string, q: Query, kind: Source["type"]): number {
  const h = hostOf(url);
  const label = h.split(".").slice(-2, -1)[0] ?? "";
  if (kind === "encyclopedia") return 1.15;
  if (isOfficialHost(h, q)) return /docs?\.|\/docs?\/|\/manual\/|\/guides?\//.test(url) ? 1.5 : /\/(blog|articles?|news)\//.test(url) ? 1.15 : 1.3; // official site; its docs rank highest
  if (/(^|\.)((gov|edu|mil)(\.[a-z]{2})?|europa\.eu|who\.int|imf\.org|worldbank\.org|federalreserve\.gov|britannica\.com|developer\.mozilla\.org|w3\.org|ietf\.org|rfc-editor\.org|nature\.com|nih\.gov|bbc\.co\.uk|reuters\.com|apnews\.com|smithsonianmag\.com|nationalgeographic\.com)$/.test(h)) return 1.2;
  if (/^docs\.|\.readthedocs\.io$|\/docs?\//.test(h + new URL(url).pathname)) return 1.15;
  if (h === "stackoverflow.com" || h.endsWith("stackexchange.com")) return 1.0;
  if (h === "github.com") return 1.0;
  if (/(youtube|youtu\.be|twitter|x\.com|facebook|instagram|tiktok|pinterest|quora|reddit|linkedin)\./.test(h + ".")) return 0.5;
  if (kind === "paper") return 0.85;
  return 0.9;
}

const siteLabel = (host: string) => host.replace(/^www\./, "").split(".").slice(-2, -1)[0] ?? "";
function isOfficialHost(host: string, q: Query): boolean {
  const label = siteLabel(host);
  return label.length >= 3 && q.siteKeys.some((k) => label === k || (label.startsWith(k) && label.length - k.length <= 2) || (k.startsWith(label) && label.length >= 4));
}

// ---------- discovery ----------
async function wikipedia(q: Query, lang: string, max: number): Promise<Doc[]> {
  const base = `https://${lang}.wikipedia.org`;
  const search = (term: string) => getJson<any>(`${base}/w/api.php?action=query&list=search&format=json&srlimit=6&srprop=snippet|timestamp&srsearch=${encodeURIComponent(term)}`).then((s) => (s?.query?.search ?? []) as any[]);
  const terms = [q.keyword];
  if (q.kind === "compare" && q.entities.length >= 2) terms.push(...q.entities.map((e) => `${q.cased[e] ?? e} ${q.entities.filter((x) => x !== e).map((x) => q.cased[x] ?? x).join(" ")}`));
  const lists = await Promise.all(terms.map(search));
  const seenT = new Set<string>();
  const hits: any[] = [];
  lists.forEach((list, li) => list.forEach((h: any, rank: number) => {
    if (seenT.has(h.title)) return; seenT.add(h.title);
    const tt = tokens(String(h.title).replace(/\(.*?\)/g, ""));
    const cov = termCount(q, String(h.title)) / (q.core.length || 1);
    const extra = tt.filter((w) => !q.core.some((c) => termMatch(w, c)) && !STOP.has(w)).length;
    hits.push({ ...h, li, pre: cov - 0.12 * extra - 0.04 * rank + (li > 0 ? 0.3 : 0) });
  }));
  hits.sort((a, b) => b.pre - a.pre);
  let pick = hits.filter((h) => termCount(q, String(h.title)) > 0).slice(0, max + (terms.length > 1 ? 2 : 0));
  if (q.kind === "compare" && q.entities.length >= 2) {
    // same sense for every compared thing: "Rust (programming language)" -> try "Go (programming language)"
    // pick the sense (qualifier) that exists for every compared name, preferring the joint search's ranking
    const quals = [...hits].sort((a, b) => a.li - b.li).map((h) => String(h.title).match(/^(.+?) \((.+)\)$/)).filter((m): m is RegExpMatchArray => !!m && q.entities.some((e) => termMatch(tokens(m[1]!)[0] ?? "", e)));
    let qual: RegExpMatchArray | undefined;
    for (const m of quals.filter((m, i) => quals.findIndex((x) => x[2] === m[2]) === i).slice(0, 3)) {
      const others = q.entities.filter((e) => !termMatch(tokens(m[1]!)[0] ?? "", e)).map((e) => `${q.cased[e] ?? e} (${m[2]})`);
      const ex = await getJson<any>(`${base}/w/api.php?action=query&format=json&redirects=1&titles=${encodeURIComponent(others.join("|"))}`, 4000);
      const pages: any[] = Object.values(ex?.query?.pages ?? {});
      if (pages.length && pages.every((pg) => !("missing" in pg))) { qual = m; break; }
    }
    if (qual) {
      const extra = q.entities.filter((e) => !termMatch(tokens(qual[1]!)[0] ?? "", e)).map((e) => ({ title: `${q.cased[e] ?? e} (${qual[2]})`, timestamp: null }));
      pick = [...pick.filter((h) => String(h.title).endsWith(`(${qual[2]})`)).slice(0, 2), ...extra];
    }
  }
  const docs = await Promise.all(pick.map(async (h): Promise<Doc | null> => {
    const title = String(h.title);
    const d = await getJson<any>(`${base}/w/api.php?action=query&prop=extracts|info|pageprops&ppprop=wikibase_item&inprop=url&explaintext=1&exsectionformat=wiki&redirects=1&format=json&titles=${encodeURIComponent(title)}`, 7000);
    const page: any = Object.values(d?.query?.pages ?? {})[0];
    const text: string = page?.extract ?? "";
    if (!text || /may refer to:/.test(text.slice(0, 300))) return null;
    const cut = text.split(/\n==\s*(See also|References|Notes|External links|Further reading|Bibliography|Sources)\s*==/)[0]!;
    const links: string[] = [];
    const qid = page?.pageprops?.wikibase_item;
    if (qid && q.siteKeys.length) {
      const w = await getJson<any>(`https://www.wikidata.org/w/api.php?action=wbgetclaims&format=json&property=P856&entity=${qid}`, 4000);
      for (const c of w?.claims?.P856 ?? []) { const v = c?.mainsnak?.datavalue?.value; if (typeof v === "string") links.push(v); }
    }
    return { id: 0, type: "encyclopedia", provider: "wikipedia", title, url: page.fullurl ?? `${base}/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}`, snippet: "", publishedAt: page.touched ?? h.timestamp ?? null, text: cut, quality: 1.15, relevance: 0, links, origin: "wikipedia" };
  }));
  return docs.filter((x): x is Doc => !!x);
}
const termCount = (q: Query, s: string) => { const t = tokens(s); return q.core.filter((c) => t.some((x) => termMatch(x, c))).length; };

async function duckduckgo(q: Query): Promise<{ docs: Doc[]; urls: string[] }> {
  const d = await getJson<any>(`https://api.duckduckgo.com/?format=json&no_html=1&skip_disambig=1&q=${encodeURIComponent(q.raw)}`, 3000);
  const docs: Doc[] = [];
  const urls: string[] = [];
  if (d?.AbstractText && d?.AbstractURL) {
    docs.push({ id: 0, type: "instant_answer", provider: "duckduckgo", title: d.Heading || q.raw, url: d.AbstractURL, snippet: "", publishedAt: null, text: strip(d.AbstractText), quality: 1.0, relevance: 0, links: [], origin: "duckduckgo" });
  }
  for (const r of d?.Results ?? []) if (r?.FirstURL) urls.push(String(r.FirstURL)); // usually the official site
  return { docs, urls };
}

async function stackoverflow(q: Query): Promise<Doc[]> {
  if (!q.entities.length) return [];
  const so = (kw: string) => getJson<any>(`https://api.stackexchange.com/2.3/search/advanced?order=desc&sort=relevance&site=stackoverflow&pagesize=6&answers=1&q=${encodeURIComponent(kw)}`, 5000);
  let s = await so(q.core.join(" "));
  if (!s?.items?.length && q.aspect.length > 1) s = await so([...q.entities, q.aspect[q.aspect.length - 1]!].join(" ")); // search is AND-like; retry with fewer words
  const qs: any[] = (s?.items ?? []).filter((i: any) => i.score >= 1 && termCount(q, strip(i.title)) >= Math.min(2, q.core.length)).slice(0, 3);
  if (!qs.length) return [];
  const a = await getJson<any>(`https://api.stackexchange.com/2.3/questions/${qs.map((i) => i.question_id).join(";")}/answers?order=desc&sort=votes&site=stackoverflow&pagesize=15&filter=withbody`, 5000);
  const byQ = new Map<number, any[]>();
  for (const ans of a?.items ?? []) { if (ans.score < 1 && !ans.is_accepted) continue; (byQ.get(ans.question_id) ?? byQ.set(ans.question_id, []).get(ans.question_id)!).push(ans); }
  return qs.flatMap((qq): Doc[] => {
    const answers = (byQ.get(qq.question_id) ?? []).sort((x, y) => Number(y.is_accepted) - Number(x.is_accepted) || y.score - x.score).slice(0, 2);
    if (!answers.length) return [];
    const html = answers.map((x) => x.body as string).join("\n");
    const links = [...html.matchAll(/href="(https:[^"]+)"/g)].map((m) => decode(m[1]!));
    const text = markdownToText(htmlToMarkdown(`<main>${html.replace(/<pre[\s\S]*?<\/pre>/gi, "")}</main>`, qq.link).markdown);
    return [{ id: 0, type: "discussion", provider: "stackoverflow", title: strip(qq.title), url: qq.link, snippet: "", publishedAt: new Date((answers[0].last_activity_date ?? qq.creation_date) * 1000).toISOString(), score: answers[0].score ?? null, text, quality: 1.0, relevance: 0, links, origin: "stackoverflow" }];
  });
}

async function github(q: Query): Promise<Doc[]> {
  if (!q.entities.length || q.kind === "compare") return [];
  const s = await getJson<any>(`https://api.github.com/search/repositories?per_page=5&sort=stars&q=${encodeURIComponent(q.core.join(" "))}`, 5000);
  const repos: any[] = (s?.items ?? []).filter((r: any) => r.stargazers_count >= 25 && !r.fork && termCount(q, `${r.full_name} ${r.description ?? ""}`) >= Math.min(2, q.core.length)).slice(0, 2);
  const docs = await Promise.all(repos.map(async (r): Promise<Doc | null> => {
    try {
      const res = await fetch(`https://raw.githubusercontent.com/${r.full_name}/HEAD/README.md`, { signal: AbortSignal.timeout(5000), headers: { "user-agent": USER_AGENT } });
      if (!res.ok) return null;
      const md = (await res.text()).slice(0, 200_000);
      const links = [...md.matchAll(/\]\((https:[^)\s]+)\)/g)].map((m) => m[1]!);
      if (r.homepage) links.unshift(String(r.homepage));
      return { id: 0, type: "web_page", provider: "github", title: `${r.full_name}: ${r.description ?? "README"}`, url: r.html_url, snippet: "", publishedAt: r.pushed_at ?? null, score: r.stargazers_count, text: markdownToText(md), quality: 1.0, relevance: 0, links, origin: "github" };
    } catch { return null; }
  }));
  return docs.filter((x): x is Doc => !!x);
}

async function hackernewsLinks(q: Query): Promise<{ url: string; title: string; points: number; at: string | null }[]> {
  const d = await getJson<any>(`https://hn.algolia.com/api/v1/search?tags=story&hitsPerPage=12&query=${encodeURIComponent(q.core.join(" "))}`);
  return (d?.hits ?? [])
    .filter((h: any) => h.url && h.title && termCount(q, strip(h.title)) >= Math.min(2, q.core.length))
    .map((h: any) => ({ url: String(h.url), title: strip(h.title).replace(/^(Show|Ask|Tell|Launch) HN:\s*/i, ""), points: h.points ?? 0, at: h.created_at ?? null }))
    .sort((a: any, b: any) => b.points - a.points)
    .slice(0, 4);
}

async function crossref(q: Query): Promise<Doc[]> {
  const d = await getJson<any>(`https://api.crossref.org/works?rows=6&select=DOI,title,abstract,issued,is-referenced-by-count&filter=has-abstract:true&query.bibliographic=${encodeURIComponent(q.keyword)}`, 7000);
  return (d?.message?.items ?? [])
    .filter((w: any) => w.title?.[0] && w.DOI && termCount(q, strip(w.title[0])) === q.core.length && (w["is-referenced-by-count"] ?? 0) >= 5)
    .slice(0, 2)
    .map((w: any): Doc => {
      const parts = w.issued?.["date-parts"]?.[0];
      return { id: 0, type: "paper", provider: "crossref", title: strip(w.title[0]), url: `https://doi.org/${w.DOI}`, snippet: "", publishedAt: parts ? parts.filter(Boolean).join("-") : null, score: w["is-referenced-by-count"] ?? null, text: strip(w.abstract ?? "").replace(/^abstract\s*/i, ""), quality: 0.85, relevance: 0, links: [], origin: "crossref" };
    });
}

async function fetchPage(url: string, title: string | null, origin: string, at: string | null = null): Promise<Doc | null> {
  try {
    if (/\.(pdf|zip|png|jpe?g|gif|mp4|mp3)(\?|$)/i.test(url) || /(youtube\.com|youtu\.be|twitter\.com|x\.com)\//.test(url)) return null;
    const r = await safeFetch(url, { timeoutMs: 6000, maxBytes: 1_500_000, accept: "text/html,application/xhtml+xml,*/*;q=0.8" });
    if (r.status >= 400 || !/html/i.test(r.headers.get("content-type") ?? "")) return null;
    const p = htmlToMarkdown(r.body, r.url);
    const text = markdownToText(p.markdown);
    if (text.length < 400) return null;
    return { id: 0, type: "web_page", provider: hostOf(r.url), title: p.title || title || hostOf(r.url), url: r.url, snippet: "", publishedAt: p.published ?? at, text, quality: 1.0, relevance: 0, links: p.links.map((l) => l.url), origin };
  } catch { return null; }
}

// ---- official docs: find the topic's own site, then pick pages from its sitemap / links by path relevance ----
function officialHosts(q: Query, docs: Doc[], extra: string[]): string[] {
  if (!q.siteKeys.length) return [];
  const counts = new Map<string, number>();
  const add = (host: string, w: number) => { const h = host.toLowerCase().replace(/^www\./, ""); if (h && isOfficialHost(h, q)) counts.set(h, (counts.get(h) ?? 0) + w); };
  // Wikidata "official website" (on encyclopedia docs) is authoritative; other links/mentions are weak votes
  for (const d of docs) for (const u of d.links) { try { const x = new URL(u); if (x.protocol === "https:" || d.type === "encyclopedia") add(x.hostname, d.type === "encyclopedia" ? 10 : 1); } catch {} }
  for (const u of extra) { try { add(new URL(u).hostname, 3); } catch {} }
  for (const d of docs) for (const m of `${d.title} ${d.text.slice(0, 20000)}`.matchAll(/\b((?:[a-z0-9-]+\.)+(?:com|org|io|dev|net|ai|app|co|sh|so|cloud|tech))\b/gi)) add(m[1]!, 1);
  // collapse subdomains to their site (docs.x402.org -> x402.org) keeping the most-cited
  const apex = new Map<string, number>();
  for (const [h, c] of counts) { const a = h.split(".").slice(-2).join("."); apex.set(a, (apex.get(a) ?? 0) + c); }
  return [...apex.entries()].sort((a, b) => b[1] - a[1]).slice(0, 1).map(([a]) => a);
}

function pathScore(q: Query, u: URL): number {
  const path = decodeURIComponent(u.hostname + u.pathname).toLowerCase().replace(/\/index\.html?$/, "/");
  const pt = tokens(path.replace(/[\/_.-]+/g, " "));
  const hit = (w: string) => pt.some((t) => termMatch(t, w));
  const exact = (w: string) => pt.some((t) => t === w || stem(t) === stem(w));
  const aspect = q.aspect.filter(hit).length;
  if (q.aspect.length && !aspect) return 0;
  let s = q.aspect.reduce((a, w) => a + (exact(w) ? 3 : hit(w) ? 1 : 0), 0) + q.intent.filter(hit).length;
  if (/(^|\.)docs?\.|\/docs?\/|\/guides?\/|\/learn\/|\/manual\/|\/reference\//.test(path)) s += 3;
  if (/\/(articles?|resources?|compare|vs)\//.test(u.pathname)) s -= 2;
  if (/(^|[-_/])(api|internals?|interface|hackers?|develop\w*|source|catalogs?|am)([-_./]|$)/.test(u.pathname)) s -= 1;
  if (/\/(current|latest|stable)\//.test(path)) s += 1;
  const KIND_PATH: Partial<Record<Query["kind"], RegExp>> = {
    practice: /tips|best|practi[cs]e|guideline|performance|tuning|examin|usage|optimi[sz]|when-to|choosing/,
    how: /how|works?|overview|concepts?|intro|behavio|lifecycle/,
    define: /intro|overview|what-is|about|concepts?|welcome/,
    history: /history|timeline|origins?|about/,
  };
  if (KIND_PATH[q.kind]?.test(u.pathname.toLowerCase())) s += 2;
  if (/\/v?\d+(\.\d+)*\/|\/(devel|dev|beta|nightly|next|canary|legacy|archive)\//.test(u.pathname)) s -= 2;
  if (/\/(blog|news|changelog|pricing|login|signup|careers|jobs|legal|privacy|terms|customers|events|tag|author)s?\//.test(u.pathname)) s -= 3;
  if (/community\./.test(u.hostname)) s -= 1;
  return s;
}

const SITEMAP_CACHE = new Map<string, { at: number; urls: string[] }>();
async function sitemapUrls(apex: string): Promise<string[]> {
  const hit = SITEMAP_CACHE.get(apex);
  if (hit && Date.now() - hit.at < 6 * 3600_000) return hit.urls;
  const urls = await sitemapUrlsUncached(apex);
  if (SITEMAP_CACHE.size >= 10) SITEMAP_CACHE.delete(SITEMAP_CACHE.keys().next().value!);
  SITEMAP_CACHE.set(apex, { at: Date.now(), urls: urls.filter((u) => u.length < 300).slice(0, 30_000) });
  return urls;
}
async function sitemapUrlsUncached(apex: string): Promise<string[]> {
  const get = async (u: string) => { try { const r = await safeFetch(u, { timeoutMs: 5000, maxBytes: 6_000_000, accept: "*/*" }); return r.status < 400 ? r.body : ""; } catch { return ""; } };
  const roots = new Set<string>();
  const robots = await get(`https://${apex}/robots.txt`);
  for (const m of robots.matchAll(/^sitemap:\s*(\S+)/gim)) roots.add(m[1]!);
  if (!roots.size) roots.add(`https://www.${apex}/sitemap.xml`).add(`https://${apex}/sitemap.xml`);
  roots.add(`https://docs.${apex}/sitemap.xml`);
  const locs: string[] = [];
  const children: string[] = [];
  await Promise.all([...roots].slice(0, 4).map(async (r) => {
    const x = await get(r);
    const target = /<sitemapindex/i.test(x.slice(0, 2000)) ? children : locs;
    for (const m of x.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)) target.push(decode(m[1]!));
  }));
  children.sort((a, b) => Number(/docs?|guide|learn|manual/.test(b)) - Number(/docs?|guide|learn|manual/.test(a)));
  await Promise.all(children.slice(0, 3).map(async (c) => { const x = await get(c); for (const m of x.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)) locs.push(decode(m[1]!)); }));
  return locs.slice(0, 60_000);
}

async function officialDocUrls(q: Query, docs: Doc[], extra: string[]): Promise<string[]> {
  const hosts = officialHosts(q, docs, extra);
  if (!hosts.length) return [];
  const apex = hosts[0]!;
  const cand = new Map<string, number>();
  const hubs = new Map<string, number>();
  const consider = (raw: string, bonus: number) => {
    let u: URL; try { u = new URL(raw); } catch { return; }
    if (u.protocol !== "https:" || !(u.hostname === apex || u.hostname.endsWith("." + apex) || isOfficialHost(u.hostname, q))) return; // sites often redirect (reactjs.org -> react.dev)
    u.hash = ""; u.search = "";
    const s = pathScore(q, u);
    if (s <= 0 && q.aspect.length) { hubs.set(u.toString(), (hubs.get(u.toString()) ?? 0) + 1 + (/\/(docs?|reference|guides?|learn|manual)\b/.test(u.pathname) ? 2 : 0)); return; }
    cand.set(u.toString(), Math.max(cand.get(u.toString()) ?? -9, s + bonus));
  };
  for (const l of [...extra, ...docs.flatMap((d) => d.links)]) consider(l, 1);
  for (const l of await sitemapUrls(apex)) consider(l, 0);
  if (!cand.size) { // no on-topic page known yet: return the site's docs hubs; the caller follows their links one hop
    const h = [...hubs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([k]) => k);
    return h.length ? h : [`https://${apex}/`];
  }
  return [...cand.entries()].sort((a, b) => b[1] - a[1] || a[0].length - b[0].length).slice(0, 5).map(([k]) => k);
}

// ---------- extractive synthesis ----------
type Cand = { s: string; doc: Doc; score: number; def: boolean; pos: number };

function rankSentences(q: Query, docs: Doc[]): Cand[] {
  const all: { s: string; section: string; pos: number; doc: Doc }[] = [];
  for (const doc of docs) for (const x of splitSentences(doc.text).slice(0, 900)) if (goodSentence(x.s)) all.push({ ...x, doc });
  const N = all.length || 1;
  const toks = all.map((x) => tokens(x.s));
  const df = new Map<string, number>();
  for (const c of q.core) df.set(c, toks.filter((t) => t.some((w) => termMatch(w, c))).length);
  const idf = (c: string) => Math.log(1 + N / (1 + (df.get(c) ?? 0)));
  const maxIdf = Math.max(...q.core.map(idf), 1);
  const names = [...q.phrases, ...q.entities, ...(q.entities.length ? [] : q.core)].map((e) => e.replace(/[^a-z0-9 ]/g, "").replace(/ /g, "\\W+")).filter(Boolean);
  const entRe = names.length ? new RegExp(`^(the |an? |in \\w+, )?(${names.join("|")})\\b[^.,;]{0,60}?\\b(is|are|was|were|refers to|means)\\b`, "i") : null;
  const out: Cand[] = [];
  all.forEach((x, i) => {
    const t = toks[i]!;
    // on pages titled after the subject (or official docs), the subject is implied in every sentence
    const titled = x.doc.origin === "official-docs" || q.entities.some((e) => tokens(x.doc.title).some((w) => termMatch(w, e)));
    const matched = q.core.filter((c) => t.some((w) => termMatch(w, c)) || (titled && q.entities.includes(c)) || !!SYN[c]?.test(x.s));
    if (!matched.length) return;
    // must touch the asked-about aspect (e.g. "indexing", not just "Postgres"), or for pure-name queries the name itself
    const aspectHit = q.aspect.some((c) => t.some((w) => termMatch(w, c)) || !!SYN[c]?.test(x.s));
    if (q.aspect.length && !aspectHit && !(x.doc.type === "web_page" && x.doc.origin === "official-docs" && CUES[q.kind].test(x.s))) return;
    if (!q.aspect.length && q.phrasesCased.length && !q.phrasesCased.some((p) => x.s.includes(p)) && !(q.phrasesCased.some((p) => x.doc.title.includes(p)) && CUES[q.kind].test(x.s))) return;
    if (/:$|\bthe following\b|\bbelow\b|\babove\b/i.test(x.s)) return;
    if (q.kind === "compare" && !Object.values(q.cased).some((c) => properNounRe(c).test(x.s))) return;
    // pages not titled after the subject (comparisons, roundups) may only contribute sentences that name it
    if (q.entities.length && x.doc.type !== "encyclopedia" && !q.entities.some((e) => tokens(x.doc.title).some((w) => termMatch(w, e))) && !q.entities.some((e) => t.some((w) => termMatch(w, e)))) return;
    let score = matched.reduce((a, c) => a + idf(c), 0) / (q.core.reduce((a, c) => a + idf(c), 0) || maxIdf); // 0..1 weighted coverage
    const cue = CUES[q.kind].test(x.s);
    const strongIntent = q.kind === "practice" || q.kind === "cause" || q.kind === "how";
    if (cue) score += q.kind === "general" ? 0.1 : strongIntent ? 0.5 : 0.35;
    else if (strongIntent) score -= 0.15;
    if (q.intent.some((w) => t.some((tt) => termMatch(tt, w)))) score += 0.15;
    const sec = x.section.toLowerCase();
    if (sec && (q.core.some((c) => tokens(sec).some((w) => termMatch(w, c))) || q.intent.some((w) => tokens(sec).some((tt) => termMatch(tt, w))) ||
      (q.kind === "cause" && /cause|origin|theor/.test(sec)) || (q.kind === "history" && /history|founding|settle|early/.test(sec)) || (q.kind === "practice" && /practice|tip|guideline|recommend|perform|tuning/.test(sec)))) score += 0.35;
    const def = !!entRe?.test(x.s) && (x.pos < 4 || x.section === "" || x.doc.origin === "official-docs");
    if (def && (q.kind === "define" || q.kind === "general")) score += 0.4;
    if (x.pos < 3 && x.section === "") score += 0.15; // lead sentences are usually the gist
    score -= Math.min(0.2, x.pos / 2000);
    if (/^(this|these|it|they|he|she|however|but|also|so|and|thus|therefore)\b/i.test(x.s)) score -= 0.25; // dangling references read badly out of context
    if (/\?$/.test(x.s)) score -= 0.4;
    if (/\b(check out|webinar|stay tuned|interested in|sign up|our (product|team|platform|customers)|in this (post|article|guide|tutorial|video))\b|\bIf you ask\b/i.test(x.s)) return; // promo chatter
    if (/\b(we|our|us|I|my)\b/.test(x.s)) score -= 0.5; // first-person narrative rarely answers the question
    if (/\balso\b/i.test(x.s.slice(0, 60))) score -= 0.1;
    const exactTitle = tokens(x.doc.title.replace(/\(.*?\)|[–—|:-].*$/g, "")).filter((w) => !STOP.has(w)).every((w) => q.core.some((c) => termMatch(w, c)));
    out.push({ s: x.s, doc: x.doc, score: score * x.doc.quality * (0.6 + 0.4 * x.doc.relevance) * (exactTitle ? 1.15 : 1), def, pos: x.pos });
  });
  return out.sort((a, b) => b.score - a.score);
}

const jacc = (a: string, b: string) => {
  const A = new Set(tokens(a).filter((t) => !STOP.has(t))), B = new Set(tokens(b).filter((t) => !STOP.has(t)));
  let inter = 0; for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter || 1);
};

function compose(q: Query, cands: Cand[]) {
  if (!cands.length) return null;
  const top = cands[0]!.score;
  const pool = cands.filter((c) => c.score >= top * 0.4);
  const chosen: Cand[] = [];
  const take = (c: Cand) => { if (!chosen.some((x) => jacc(x.s, c.s) > 0.45 || x.s === c.s)) { chosen.push(c); return true; } return false; };
  // opener: a definitional sentence for define/general/how questions; otherwise the best-scoring sentence
  const wantsDef = q.kind === "define" || q.kind === "general" || q.kind === "cause" || q.kind === "history" || q.kind === "compare" || (q.kind === "how" && q.aspect.length <= 1 && !q.entities.length);
  // opener for "what is / why / history" questions: the definitional lead of the most on-topic, highest-quality source
  const defs = cands.filter((c) => c.def && c.score >= top * 0.25).sort((a, b) => b.doc.relevance * b.doc.quality - a.doc.relevance * a.doc.quality || a.pos - b.pos);
  const opener = wantsDef ? (defs[0] ?? pool[0]!) : pool[0]!;
  if (q.kind === "compare" && q.entities.length >= 2) {
    for (const e of q.entities.slice(0, 3)) { const d = cands.find((c) => c.def && tokens(c.s.slice(0, 60)).some((w) => termMatch(w, e)) && c.score >= top * 0.2); if (d) take(d); }
  }
  if (!chosen.length) take(opener);
  const perDoc = (d: Doc) => chosen.filter((c) => c.doc === d).length;
  const nDocs = new Set(pool.map((c) => c.doc)).size;
  const capS = nDocs === 1 ? 3 : 2, capB = nDocs === 1 ? 8 : nDocs === 2 ? 4 : 3;
  for (const c of pool) { if (chosen.length >= 3) break; if (perDoc(c.doc) < capS && (chosen.length < 2 || c.doc !== chosen[chosen.length - 1]!.doc || pool.every((p) => p.doc === c.doc))) take(c); }
  const summaryParts = chosen.slice(0, Math.min(3, chosen.length));
  for (const c of pool) { if (chosen.length >= summaryParts.length + 5) break; if (perDoc(c.doc) < capB) take(c); }
  const bulletParts = chosen.slice(summaryParts.length);
  if (q.kind === "history") {
    const yr = (s: string) => Number(s.match(/\b(1[0-9]{3}|20[0-2][0-9])\b/)?.[1] ?? 9999);
    bulletParts.sort((a, b) => yr(a.s) - yr(b.s));
  }
  return { summaryParts, bulletParts };
}

async function llmSynthesis(q: string, sources: Source[]): Promise<{ summary: string; bullets: string[]; model: string } | null> {
  const grokKey = process.env.GROK_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;
  if (!grokKey && !openaiKey) return null;
  const base = grokKey ? (process.env.GROK_API_BASE ?? "https://api.x.ai/v1") : "https://api.openai.com/v1";
  const model = grokKey ? (process.env.GROK_MODEL ?? "grok-4.3") : (process.env.OPENAI_MODEL ?? "gpt-4o-mini");
  const ctx = sources.map((s) => `[${s.id}] ${s.title} (${s.provider}, ${s.url}): ${s.snippet}`).join("\n");
  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      signal: AbortSignal.timeout(20_000),
      headers: { Authorization: `Bearer ${grokKey ?? openaiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model, temperature: 0.2, response_format: { type: "json_object" },
        messages: [
          { role: "system", content: "You write factual research briefs. Use ONLY the numbered sources. Return JSON {\"summary\": string (2-4 sentences), \"bullets\": string[] (3-6 items, each ending with citations like [1] or [2][3])}. No markdown." },
          { role: "user", content: `Question: ${q}\n\nSources:\n${ctx}` },
        ],
      }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as any;
    const parsed = JSON.parse(data.choices?.[0]?.message?.content ?? "{}");
    if (typeof parsed.summary !== "string" || !Array.isArray(parsed.bullets)) return null;
    return { summary: parsed.summary, bullets: parsed.bullets.map(String).slice(0, 6), model };
  } catch { return null; }
}


export type Depth = "quick" | "standard";

export async function researchBrief(qRaw: string, opts: { lang?: string; depth?: Depth } = {}) {
  const started = Date.now();
  const lang = /^[a-z]{2,3}$/.test(opts.lang ?? "") ? opts.lang! : "en";
  const depth: Depth = opts.depth === "quick" ? "quick" : "standard";
  const q = parseQuery(qRaw);

  // 1) discovery (parallel, each bounded)
  const [wiki, ddg, so, gh, hn, cr] = await Promise.all([
    wikipedia(q, lang, depth === "quick" ? 2 : 3).catch(() => []),
    duckduckgo(q).catch(() => ({ docs: [], urls: [] })),
    depth === "standard" && lang === "en" ? stackoverflow(q).catch(() => []) : Promise.resolve([]),
    depth === "standard" ? github(q).catch(() => []) : Promise.resolve([]),
    depth === "standard" ? hackernewsLinks(q).catch(() => []) : Promise.resolve([]),
    depth === "standard" ? crossref(q).catch(() => []) : Promise.resolve([]),
  ]);
  let docs: Doc[] = [...wiki, ...ddg.docs, ...so, ...gh, ...cr];
  const evidence = docs.filter((d) => q.entities.some((e) => termCount({ ...q, core: [e] }, d.title) > 0));

  // 2) fetch real page text for linked articles + official docs found in relevant sources
  const score = (d: Doc) => { d.relevance = relevance(q, d.title, d.text); d.quality = sourceQuality(d.url, q, d.type); return d; };
  docs = docs.map(score).filter((d) => d.relevance > 0);
  if (depth === "standard") {
    const seen = new Set(docs.map((d) => d.url));
    const official = (await officialDocUrls(q, [...docs, ...evidence.filter((d) => !docs.includes(d))], ddg.urls).catch(() => [] as string[])).filter((u) => !seen.has(u));
    const officialRaw: Doc[] = [];
    const pages = await Promise.all([
      ...official.slice(0, 5).map((u) => fetchPage(u, null, "official-docs").then((d) => {
        if (!d) return d;
        officialRaw.push(d);
        try { if (q.aspect.length && pathScore(q, new URL(d.url)) <= 0 && !q.aspect.some((a) => tokens(d.title).some((w) => termMatch(w, a)))) return null; } catch {} // hub page, not an answer
        return d;
      })),
      ...hn.filter((h) => !seen.has(h.url)).slice(0, 3).map((h) => fetchPage(h.url, h.title, "hackernews", h.at)),
    ]);
    for (const p of pages) if (p && !docs.some((d) => d.url === p.url)) { score(p); if (p.relevance > 0) docs.push(p); }
    // one hop from official hub pages (e.g. a docs chapter index) to its most on-topic subpages
    const hubs = officialRaw; // includes hub pages that are not themselves on-topic
    if (hubs.length) {
      const host = hostOf(hubs[0]!.url);
      const have = new Set(docs.map((d) => d.url.replace(/[#?].*$/, "")));
      const next = new Map<string, number>();
      for (const h of hubs) for (const l of h.links) {
        try { const u = new URL(l); u.hash = ""; u.search = ""; if ((hostOf(u.toString()) !== host && !isOfficialHost(u.hostname, q)) || have.has(u.toString())) continue; const s = pathScore(q, u); if (s > 0) next.set(u.toString(), Math.max(next.get(u.toString()) ?? 0, s)); } catch {}
      }
      const pick = [...next.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([u]) => u);
      const more = await Promise.all(pick.map((u) => fetchPage(u, null, "official-docs")));
      for (const p of more) if (p && !docs.some((d) => d.url === p.url)) { score(p); if (p.relevance > 0) docs.push(p); }
    }
  }
  if (!docs.length) return null;

  // 3) rank sentences across sources and compose
  const cands = rankSentences(q, docs);
  const comp = compose(q, cands);
  if (!comp) return null;

  // 4) sources: cited first (ids in citation order), then other relevant ones
  const order: Doc[] = [];
  for (const c of [...comp.summaryParts, ...comp.bulletParts]) if (!order.includes(c.doc)) order.push(c.doc);
  for (const d of docs.sort((a, b) => b.relevance * b.quality - a.relevance * a.quality)) if (!order.includes(d) && order.length < 8 && d.relevance >= 0.6 && d.quality >= 1.15 && termCount(q, d.title) / (q.core.length || 1) >= 0.5) order.push(d);
  order.forEach((d, i) => (d.id = i + 1));
  const sources: Source[] = order.map((d) => {
    const best = cands.filter((c) => c.doc === d).slice(0, 2).sort((a, b) => a.pos - b.pos).map((c) => c.s);
    const snippet = clip(best.join(" ") || splitSentences(d.text).map((x) => x.s).find(goodSentence) || d.text, 600);
    const src: Source = { id: d.id, type: d.type, provider: d.provider, title: clip(d.title, 160), url: d.url, snippet, publishedAt: d.publishedAt ?? null };
    if (d.score != null) src.score = d.score;
    return src;
  });
  const cite = (c: Cand) => `${clip(c.s, 320)} [${c.doc.id}]`;
  let summary = comp.summaryParts.map(cite).join(" ");
  let bullets = comp.bulletParts.map(cite);
  let method = "extractive";
  const llm = await llmSynthesis(q.raw, sources);
  if (llm) { summary = llm.summary; bullets = llm.bullets; method = `llm-synthesis:${llm.model}`; }
  const providers = [...new Set(order.map((d) => d.origin))];
  return {
    query: q.raw,
    summary,
    bullets,
    sources,
    sourceCount: sources.length,
    providers,
    method,
    depth,
    lang,
    latencyMs: Date.now() - started,
    generatedAt: new Date().toISOString(),
  };
}
