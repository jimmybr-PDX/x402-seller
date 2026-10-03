/**
 * Cited research brief built from keyless public sources:
 * Wikipedia (search + REST summary), DuckDuckGo Instant Answer, Hacker News (Algolia),
 * and Crossref (scholarly works). Optional LLM synthesis over those sources when an
 * LLM key is configured and working; otherwise an extractive summary is returned.
 * Returns null when no source produced anything (caller answers 4xx => buyer not charged).
 */
import { getJson } from "./net.js";

export type Source = {
  id: number;
  type: "encyclopedia" | "instant_answer" | "discussion" | "paper";
  provider: "wikipedia" | "duckduckgo" | "hackernews" | "crossref";
  title: string;
  url: string;
  snippet: string;
  publishedAt?: string | null;
  score?: number | null;
};

const strip = (s: string) =>
  s.replace(/<[^>]+>/g, "").replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1).replace(/\s+\S*$/, "") + "…" : s);
const sentences = (s: string) => s.match(/[^.!?]+[.!?]+(\s|$)/g)?.map((x) => x.trim()) ?? (s ? [s] : []);

async function wikipedia(q: string, lang: string): Promise<Source[]> {
  const base = `https://${lang}.wikipedia.org`;
  const search = await getJson<any>(
    `${base}/w/api.php?action=query&list=search&format=json&srlimit=3&srsearch=${encodeURIComponent(q)}`,
  );
  const hits: any[] = search?.query?.search ?? [];
  const out: Source[] = [];
  await Promise.all(
    hits.slice(0, 3).map(async (h, i) => {
      const title = String(h.title);
      const sum = i < 2 ? await getJson<any>(`${base}/api/rest_v1/page/summary/${encodeURIComponent(title.replace(/ /g, "_"))}`) : null;
      out[i] = {
        id: 0,
        type: "encyclopedia",
        provider: "wikipedia",
        title,
        url: sum?.content_urls?.desktop?.page ?? `${base}/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}`,
        snippet: clip(strip(sum?.extract ?? h.snippet ?? ""), 600),
        publishedAt: sum?.timestamp ?? h.timestamp ?? null,
      };
    }),
  );
  return out.filter(Boolean);
}

async function duckduckgo(q: string): Promise<Source[]> {
  const d = await getJson<any>(`https://api.duckduckgo.com/?format=json&no_html=1&skip_disambig=1&q=${encodeURIComponent(q)}`, 2500);
  if (!d?.AbstractText || !d?.AbstractURL) return [];
  return [{ id: 0, type: "instant_answer", provider: "duckduckgo", title: d.Heading || q, url: d.AbstractURL, snippet: clip(strip(d.AbstractText), 600), publishedAt: null }];
}

async function hackernews(q: string): Promise<Source[]> {
  const d = await getJson<any>(
    `https://hn.algolia.com/api/v1/search?tags=story&hitsPerPage=5&query=${encodeURIComponent(q)}`,
  );
  return (d?.hits ?? [])
    .filter((h: any) => h.title)
    .slice(0, 4)
    .map((h: any) => ({
      id: 0,
      type: "discussion" as const,
      provider: "hackernews" as const,
      title: strip(h.title),
      url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
      snippet: `Hacker News discussion: ${h.points ?? 0} points, ${h.num_comments ?? 0} comments (https://news.ycombinator.com/item?id=${h.objectID}).`,
      publishedAt: h.created_at ?? null,
      score: typeof h.points === "number" ? h.points : null,
    }));
}

async function crossref(q: string): Promise<Source[]> {
  const d = await getJson<any>(
    `https://api.crossref.org/works?rows=3&select=DOI,title,abstract,issued,container-title,is-referenced-by-count&query=${encodeURIComponent(q)}`,
    7000,
  );
  return (d?.message?.items ?? [])
    .filter((w: any) => w.title?.[0] && w.DOI)
    .map((w: any) => {
      const parts = w.issued?.["date-parts"]?.[0];
      return {
        id: 0,
        type: "paper" as const,
        provider: "crossref" as const,
        title: strip(w.title[0]),
        url: `https://doi.org/${w.DOI}`,
        snippet: clip(strip(w.abstract ?? `${w["container-title"]?.[0] ?? "Scholarly work"}; cited ${w["is-referenced-by-count"] ?? 0} times.`), 500),
        publishedAt: parts ? parts.filter(Boolean).join("-") : null,
        score: w["is-referenced-by-count"] ?? null,
      };
    });
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
        model,
        temperature: 0.2,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              "You write factual research briefs. Use ONLY the numbered sources. Return JSON {\"summary\": string (2-4 sentences), \"bullets\": string[] (3-6 items, each ending with citations like [1] or [2][3])}. No markdown.",
          },
          { role: "user", content: `Question: ${q}\n\nSources:\n${ctx}` },
        ],
      }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as any;
    const parsed = JSON.parse(data.choices?.[0]?.message?.content ?? "{}");
    if (typeof parsed.summary !== "string" || !Array.isArray(parsed.bullets)) return null;
    return { summary: parsed.summary, bullets: parsed.bullets.map(String).slice(0, 6), model };
  } catch {
    return null;
  }
}

function extractive(q: string, sources: Source[]): { summary: string; bullets: string[] } {
  const enc = sources.filter((s) => s.type === "encyclopedia" || s.type === "instant_answer");
  const lead = enc[0];
  const summary = lead
    ? `${sentences(lead.snippet).slice(0, 3).join(" ")} [${lead.id}]`
    : `Sources found for "${q}": ${sources.slice(0, 3).map((s) => `${s.title} [${s.id}]`).join("; ")}.`;
  const bullets: string[] = [];
  for (const s of enc.slice(1, 3)) {
    const first = sentences(s.snippet)[0];
    if (first) bullets.push(`${s.title}: ${clip(first, 240)} [${s.id}]`);
  }
  for (const s of sources.filter((x) => x.type === "paper").slice(0, 2)) {
    bullets.push(`Scholarly: "${s.title}"${s.publishedAt ? ` (${String(s.publishedAt).slice(0, 4)})` : ""} [${s.id}]`);
  }
  for (const s of sources.filter((x) => x.type === "discussion").slice(0, 2)) {
    bullets.push(`Discussion: "${s.title}"${s.score != null ? ` (${s.score} HN points)` : ""} [${s.id}]`);
  }
  return { summary, bullets: bullets.slice(0, 6) };
}

export type Depth = "quick" | "standard";

export async function researchBrief(q: string, opts: { lang?: string; depth?: Depth } = {}) {
  const started = Date.now();
  const lang = /^[a-z]{2,3}$/.test(opts.lang ?? "") ? opts.lang! : "en";
  const depth: Depth = opts.depth === "quick" ? "quick" : "standard";
  const tasks: Promise<Source[]>[] = [wikipedia(q, lang), duckduckgo(q)];
  if (depth === "standard") tasks.push(hackernews(q), crossref(q));
  const settled = await Promise.allSettled(tasks);
  const sources: Source[] = [];
  const providersOk: string[] = [];
  const names = ["wikipedia", "duckduckgo", "hackernews", "crossref"];
  settled.forEach((r, i) => {
    if (r.status === "fulfilled" && r.value.length) {
      providersOk.push(names[i]!);
      sources.push(...r.value);
    }
  });
  // de-dupe by URL, assign citation ids
  const seen = new Set<string>();
  const unique = sources.filter((s) => (seen.has(s.url) ? false : (seen.add(s.url), true)));
  unique.forEach((s, i) => (s.id = i + 1));
  if (!unique.length) return null;

  const llm = await llmSynthesis(q, unique);
  const body = llm ?? extractive(q, unique);
  return {
    query: q,
    summary: body.summary,
    bullets: body.bullets,
    sources: unique,
    sourceCount: unique.length,
    providers: providersOk,
    method: llm ? `llm-synthesis:${llm.model}` : "extractive",
    depth,
    lang,
    latencyMs: Date.now() - started,
    generatedAt: new Date().toISOString(),
  };
}
