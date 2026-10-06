/**
 * Read a public web page and return clean, LLM-ready markdown plus metadata.
 * Dependency-free HTML -> markdown (good enough for articles, docs, blogs).
 */
import { safeFetch } from "./net.js";

const ENT: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'", mdash: "—", ndash: "–", hellip: "…", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“" };
const decode = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const n = e[1]?.toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return ENT[e.toLowerCase()] ?? m;
  });

function meta(html: string, name: string): string | null {
  const re = new RegExp(`<meta[^>]+(?:name|property)=["']${name}["'][^>]*>`, "i");
  const tag = html.match(re)?.[0];
  const c = tag?.match(/content=["']([^"']*)["']/i)?.[1];
  return c ? decode(c).trim() : null;
}

export function htmlToMarkdown(html: string, baseUrl: string) {
  const title = decode(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "").replace(/\s+/g, " ").trim() || meta(html, "og:title") || null;
  const description = meta(html, "description") ?? meta(html, "og:description");
  const lang = html.match(/<html[^>]*\blang=["']?([a-zA-Z-]+)/i)?.[1] ?? null;
  const published = meta(html, "article:published_time") ?? html.match(/<time[^>]+datetime=["']([^"']+)["']/i)?.[1] ?? null;

  let body = html.match(/<main[\s\S]*?<\/main>/i)?.[0] ?? html.match(/<article[\s\S]*?<\/article>/i)?.[0] ?? html.match(/<body[\s\S]*<\/body>/i)?.[0] ?? html;
  body = body
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|noscript|svg|iframe|template|form|nav|footer|header|aside|button|select)\b[\s\S]*?<\/\1>/gi, "")
    .replace(/<(div|ul|table)\b[^>]*(role=["']navigation["']|class=["'][^"']*\b(navbox|sidebar|menu|toc|breadcrumb|cookie)\b)[^>]*>[\s\S]*?<\/\1>/gi, "");

  const links: { text: string; url: string }[] = [];
  const abs = (h: string) => {
    try {
      return new URL(decode(h), baseUrl).toString();
    } catch {
      return null;
    }
  };
  let md = body
    .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, n, t) => `\n\n${"#".repeat(Number(n))} ${t.replace(/<[^>]+>/g, "").trim()}\n\n`)
    .replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_m, t) => `\n\n\`\`\`\n${t.replace(/<[^>]+>/g, "")}\n\`\`\`\n\n`)
    .replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (_m, t) => `\`${t.replace(/<[^>]+>/g, "")}\``)
    .replace(/<a\b[^>]*href=["']([^"'#][^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, h, t) => {
      const inner = t.replace(/<[^>]+>/g, "");
      const text = inner.replace(/\s+/g, " ").trim();
      // keep whitespace that sat inside the link (`in<a> prices</a>` must not become "inprices")
      const pre = /^\s/.test(inner) ? " " : "", post = /\s$/.test(inner) ? " " : "";
      const u = abs(h);
      if (!u || !text || !/^https?:/.test(u)) return pre + text + post;
      if (links.length < 200) links.push({ text: decode(text), url: u });
      return `${pre}[${text}](${u})${post}`;
    })
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, "**$2**")
    .replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, "*$2*")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|section|ul|ol|table|tr|blockquote)>/gi, "\n\n")
    .replace(/<t[dh][^>]*>/gi, " | ")
    .replace(/<[^>]+>/g, "");
  md = decode(md)
    .replace(/[ \t]+/g, " ")
    .replace(/\n /g, "\n")
    .split("\n")
    .filter((l) => !/^\s*([-|*]\s*)+$/.test(l)) // drop empty bullets / table pipes
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const headings = [...md.matchAll(/^(#{1,3}) (.+)$/gm)].slice(0, 50).map((m) => ({ level: m[1]!.length, text: m[2]!.trim() }));
  return { title, description, lang, published, markdown: md, headings, links };
}

export async function readPage(target: string, maxChars: number) {
  const r = await safeFetch(target, { timeoutMs: 12_000, maxBytes: 3_000_000, accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5" });
  const ctype = r.headers.get("content-type") ?? "";
  if (r.status >= 400)
    return { error: "upstream_status", status: r.status, message: `The page answered HTTP ${r.status}${r.status === 403 || r.status === 429 ? " (the site blocks automated readers or is rate limiting)" : r.status === 404 ? " (not found; check the URL)" : ""}` } as const;
  let out;
  if (/html|xml/i.test(ctype) || /^\s*</.test(r.body)) out = htmlToMarkdown(r.body, r.url);
  else if (/text\/|json/i.test(ctype)) out = { title: null, description: null, lang: null, published: null, markdown: r.body.trim(), headings: [], links: [] };
  else return { error: "unsupported_content_type", contentType: ctype, message: `Only HTML or text pages can be read; this URL returned ${ctype.split(";")[0] || "an unknown content type"}${/pdf/i.test(ctype) ? " (PDFs are not supported)" : ""}` } as const;
  const full = out.markdown;
  const markdown = full.length > maxChars ? full.slice(0, maxChars) : full;
  return {
    url: target,
    finalUrl: r.url,
    status: r.status,
    contentType: ctype || null,
    title: out.title,
    description: out.description,
    lang: out.lang,
    publishedAt: out.published,
    markdown,
    wordCount: full.split(/\s+/).filter(Boolean).length,
    truncated: r.truncated || full.length > maxChars,
    headings: out.headings,
    links: out.links.slice(0, 100),
    fetchMs: r.ms,
    fetchedAt: new Date().toISOString(),
  };
}
