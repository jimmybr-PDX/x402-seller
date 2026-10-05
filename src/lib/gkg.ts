/**
 * GDELT GKG 2.0 headline index (open data: "unlimited and unrestricted use for any academic,
 * commercial, or governmental use"; cite gdeltproject.org). GDELT publishes every news article
 * it sees as a 15-minute file; we download those files (no API, so no per-IP rate limit),
 * keep date/outlet/url/title for the last NEWS_GKG_HOURS hours (default 24) in memory, and
 * search titles locally. Backfills newest-first at startup, then polls every 5 minutes.
 */
import { promisify } from "node:util";
import zlib from "node:zlib";

const inflateRaw = promisify(zlib.inflateRaw); // libuv threadpool: keeps the event loop free
import { USER_AGENT } from "./net.js";

export type GkgItem = { title: string; url: string; source: string; t: number; lc: string };

const HOURS = Math.max(0, Number(process.env.NEWS_GKG_HOURS ?? 24));
const MAX_ITEMS = 200_000;
const BASE = "https://data.gdeltproject.org/gdeltv2/";

let items: GkgItem[] = [];
const seenUrls = new Set<string>();
const loaded = new Set<string>();
let started = false;
let lastError: string | null = null;
let newestTs: string | null = null;

const ENT: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };
const decode = (s: string) =>
  s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z0-9#]+);/gi, (m, n) => ENT[n.toLowerCase()] ?? m)
    .replace(/\s+/g, " ")
    .trim();
export const lcWords = (title: string) =>
  " " + title.toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}\s.$-]/gu, " ").split(/\s+/).filter(Boolean).join(" ") + " ";
const SPAM = /casino|betting|sportsbook|porn|xxx|escort|signup|login|onlyfans|\bslots?\b|viagra|crack(ed)? download/i;
// Substrings of the 8 MB file text would keep the whole file alive (V8 sliced strings); copy them.
const flat = (s: string) => Buffer.from(s, "utf8").toString("utf8");
const tsToMs = (ts: string) => Date.UTC(+ts.slice(0, 4), +ts.slice(4, 6) - 1, +ts.slice(6, 8), +ts.slice(8, 10), +ts.slice(10, 12), +ts.slice(12, 14));
const msToTs = (ms: number) => new Date(ms).toISOString().replace(/[-:T]/g, "").slice(0, 14);

async function unzipSingle(buf: Buffer): Promise<Buffer> {
  if (buf.readUInt32LE(0) !== 0x04034b50) throw new Error("not a zip");
  const method = buf.readUInt16LE(8);
  const start = 30 + buf.readUInt16LE(26) + buf.readUInt16LE(28);
  return method === 0 ? buf.subarray(start, start + buf.readUInt32LE(18)) : inflateRaw(buf.subarray(start));
}

async function loadFile(ts: string): Promise<number> {
  if (loaded.has(ts)) return 0;
  const res = await fetch(`${BASE}${ts}.gkg.csv.zip`, { signal: AbortSignal.timeout(30_000), headers: { "user-agent": USER_AGENT } });
  if (res.status === 404) {
    loaded.add(ts);
    return 0;
  }
  if (!res.ok) throw new Error(`gkg ${res.status}`);
  const text = (await unzipSingle(Buffer.from(await res.arrayBuffer()))).toString("utf8");
  const fresh: GkgItem[] = [];
  // Scan with indexOf instead of split(): rows are ~27 tab-separated columns of up to 100 KB, and we
  // only need columns 1, 3, 4 and the PAGE_TITLE tag. Yield to the event loop every 1,000 rows so a
  // small (0.1 CPU) instance keeps answering requests while a file is parsed.
  let pos = 0;
  let rows = 0;
  while (pos < text.length) {
    let end = text.indexOf("\n", pos);
    if (end < 0) end = text.length;
    const lineStart = pos;
    pos = end + 1;
    if (++rows % 1000 === 0) await new Promise((r) => setImmediate(r));
    const tStart = text.indexOf("<PAGE_TITLE>", lineStart);
    if (tStart < 0 || tStart > end) continue;
    const tEnd = text.indexOf("</PAGE_TITLE>", tStart);
    if (tEnd < 0 || tEnd > end) continue;
    const cols: string[] = [];
    let c = lineStart;
    for (let k = 0; k < 5; k++) {
      const tab = text.indexOf("\t", c);
      if (tab < 0 || tab > end) break;
      cols.push(text.slice(c, tab));
      c = tab + 1;
    }
    const url = cols[4] ?? "";
    if (!/^https?:\/\//.test(url)) continue;
    const title = decode(text.slice(tStart + 12, tEnd));
    if (title.length < 20 || title.length > 300 || title.split(" ").length < 4 || SPAM.test(title) || SPAM.test(url)) continue;
    const key = url.replace(/^https?:\/\/(www\.)?/, "").replace(/[?#].*$/, "").toLowerCase();
    if (seenUrls.has(key)) continue;
    seenUrls.add(flat(key));
    fresh.push({ title: flat(title), url: flat(url), source: flat(cols[3] || new URL(url).hostname.replace(/^www\./, "")), t: tsToMs(cols[1] || ts), lc: flat(lcWords(title)) });
  }
  loaded.add(ts);
  items.push(...fresh);
  if (!newestTs || ts > newestTs) newestTs = ts;
  return fresh.length;
}

function prune() {
  const cutoff = Date.now() - HOURS * 3600_000;
  if (items.length && (items[0]!.t < cutoff || items.length > MAX_ITEMS)) {
    items.sort((a, b) => a.t - b.t);
    let i = 0;
    while (i < items.length && (items[i]!.t < cutoff || items.length - i > MAX_ITEMS)) i++;
    for (const it of items.slice(0, i)) seenUrls.delete(it.url.replace(/^https?:\/\/(www\.)?/, "").replace(/[?#].*$/, "").toLowerCase());
    items = items.slice(i);
  }
}

async function latestTs(): Promise<string> {
  const res = await fetch(`${BASE}lastupdate.txt`, { signal: AbortSignal.timeout(10_000), headers: { "user-agent": USER_AGENT } });
  const txt = await res.text();
  const m = txt.match(/(\d{14})\.gkg\.csv\.zip/);
  if (!m) throw new Error("no gkg in lastupdate");
  return m[1]!;
}

async function sync(backfill: boolean) {
  try {
    const latest = await latestTs();
    const want: string[] = [];
    const n = backfill ? HOURS * 4 : 8; // poll: catch up on up to 2 h of missed files
    for (let i = 0; i < n; i++) want.push(msToTs(tsToMs(latest) - i * 15 * 60_000));
    const todo = want.filter((t) => !loaded.has(t));
    // Newest first, one at a time; a pause between files keeps CPU/network gentle on small instances.
    for (const t of todo) {
      await loadFile(t).catch((e) => void (lastError = String(e?.message ?? e)));
      if (backfill) await new Promise((r) => setTimeout(r, 400));
    }
    prune();
    lastError = null;
  } catch (e: any) {
    lastError = String(e?.message ?? e);
  }
}

export function startGkg(): void {
  if (started || HOURS <= 0) return;
  started = true;
  void sync(true);
  setInterval(() => void sync(false), 5 * 60_000).unref();
}

export function gkgItems(): GkgItem[] {
  return items;
}

export function gkgStatus() {
  return {
    enabled: HOURS > 0,
    hours: HOURS,
    files: loaded.size,
    articles: items.length,
    newest: newestTs ? new Date(tsToMs(newestTs)).toISOString() : null,
    ...(lastError ? { lastError } : {}),
  };
}
