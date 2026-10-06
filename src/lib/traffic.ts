/**
 * Interest tracker: who is looking at the paid routes, and how many of them pay.
 *
 * Per route and per hour/day (UTC) bucket it counts requests by visitor class, unpaid 402s,
 * paid 200s, settle failures, rejected payments and uncharged errors, plus unique visitors.
 * Visitors are sha256(dailySalt + IP + UA) truncated to 64 bits; the salt is random per UTC day
 * and never written to disk, so raw IPs are never stored and hashes cannot be linked across days.
 *
 * Memory: ~48 hourly + ~35 daily buckets of small counters, plus today's visitor-hash sets
 * (capped at 20k entries in total), i.e. well under 5 MB. Optional persistence to TRAFFIC_FILE
 * (counts only) every 10 min and on SIGTERM; without a writable disk it stays in memory.
 */
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export type Klass = "client" | "crawler" | "pinger" | "bot" | "head" | "self";
const KLASSES: Klass[] = ["client", "crawler", "pinger", "bot", "head", "self"];
type ByClass = Record<Klass, number>;
type RouteCounts = {
  requests: ByClass; // every request to the route, by visitor class
  unpaid402: ByClass; // 402 challenges served to callers without a payment header
  paid200: number; // payment verified + settled + content returned
  settleFailed: number; // payment verified, settlement failed (buyer not charged)
  paymentInvalid: number; // payment header present but rejected at verify
  uncharged: number; // paid attempt that ended in 4xx/5xx from the handler (never charged)
  selfPaid?: number; // paid 200s from our own test wallet (SELF_PAYERS); not counted in paid200
  visitors: ByClass; // unique visitors (first seen in this bucket), by class
};
type Bucket = { start: string; routes: Record<string, RouteCounts>; agents: Record<string, number> };

const HOURS_KEPT = 48;
const DAYS_KEPT = 35;
const MAX_VISITORS_PER_DAY = 20_000;
const MAX_AGENT_KEYS = 60;

const zero = (): ByClass => ({ client: 0, crawler: 0, pinger: 0, bot: 0, head: 0, self: 0 });
const newCounts = (): RouteCounts => ({ requests: zero(), unpaid402: zero(), paid200: 0, settleFailed: 0, paymentInvalid: 0, uncharged: 0, visitors: zero() });

const hourly: Bucket[] = [];
const daily: Bucket[] = [];
let salt = { day: "", value: Buffer.alloc(0) };
// visitor sets for the current hour and day: route -> Set<hash>
let hourSets = { key: "", sets: new Map<string, Set<string>>() };
let daySets = { key: "", sets: new Map<string, Set<string>>(), size: 0, capped: false };
const startedAt = new Date().toISOString();
let trackingSince = startedAt; // first moment covered by the counts (restored from file if any)
// Last unpaid client 402 per visitor+route, so a following payment from our own test wallet can
// re-tag that probe as "self". Small, short-lived (5 min), capped.
type Probe = { t: number; hk: string; dk: string; agent: string; vHour: boolean; vDay: boolean };
const probes = new Map<string, Probe>();
const PROBE_TTL_MS = 5 * 60_000;

// ---------- classification ----------
const CRAWLER: Array<[RegExp, string]> = [
  [/coinbase|\bcdp\b|cdp-|bazaar/i, "cdp-bazaar"],
  [/x402scan/i, "x402scan"],
  [/402index|402-index/i, "402index"],
  [/agentic\.market/i, "agentic.market"],
  [/x402[-_ ]?(crawler|indexer|bot|monitor|probe|validator|discovery|health|directory|list|station)/i, "x402-directory"],
];
const PINGER: Array<[RegExp, string]> = [
  [/cron-job\.org/i, "cron-job.org"],
  [/uptimerobot/i, "uptimerobot"],
  [/better ?(uptime|stack)/i, "betterstack"],
  [/pingdom|statuscake|freshping|hetrix|uptime-kuma|updown\.io|site24x7|checkly|newrelicpinger|uptime/i, "uptime-monitor"],
  [/render\/|render-health/i, "render"],
];
const BOT =
  /bot\b|bot\/|crawl|spider|slurp|headless|phantomjs|scrapy|httrack|zgrab|masscan|nmap|nikto|censys|shodan|expanse|internet-measurement|facebookexternalhit|embedly|preview|wordpress|semrush|ahrefs|dataforseo|bytespider|gptbot|claudebot|perplexity|ccbot|petalbot|yandex|baidu|bingpreview|python-urllib|libwww|go-http-client\/1\.1$/i;

export function classify(method: string, ua: string): { klass: Klass; agent: string } {
  const u = ua.trim();
  if (/x402-seller-rankcheck/i.test(u)) return { klass: "self", agent: "rank-check" };
  for (const [re, name] of CRAWLER) if (re.test(u)) return { klass: "crawler", agent: name };
  for (const [re, name] of PINGER) if (re.test(u)) return { klass: "pinger", agent: name };
  if (method === "HEAD" || method === "OPTIONS") return { klass: "head", agent: method.toLowerCase() };
  if (!u) return { klass: "bot", agent: "(empty UA)" };
  if (BOT.test(u)) {
    const m = u.match(/([A-Za-z][\w.-]*(?:bot|crawler|spider))/i);
    return { klass: "bot", agent: (m?.[1] ?? "generic-bot").slice(0, 32) };
  }
  return { klass: "client", agent: uaFamily(u) };
}

function uaFamily(u: string): string {
  if (/^node$|undici|node-fetch|axios|got\/|ky\/|bun\/|deno\//i.test(u)) return "node/js";
  if (/python|httpx|aiohttp|requests\//i.test(u)) return "python";
  if (/^curl\//i.test(u)) return "curl";
  if (/^wget/i.test(u)) return "wget";
  if (/go-http-client|^go\b/i.test(u)) return "go";
  if (/okhttp|java\//i.test(u)) return "java";
  if (/rust|reqwest/i.test(u)) return "rust";
  if (/mozilla\//i.test(u)) return "browser";
  return u.split(/[\s/;(]/)[0]!.slice(0, 24) || "other";
}

// ---------- buckets ----------
const hourKey = (d: Date) => d.toISOString().slice(0, 13) + ":00Z";
const dayKey = (d: Date) => d.toISOString().slice(0, 10);

function bucket(list: Bucket[], key: string, keep: number): Bucket {
  const last = list[list.length - 1];
  if (last && last.start === key) return last;
  let b = list.find((x) => x.start === key);
  if (!b) {
    b = { start: key, routes: {}, agents: {} };
    list.push(b);
    list.sort((a, c) => (a.start < c.start ? -1 : 1));
    while (list.length > keep) list.shift();
  }
  return b;
}
const rc = (b: Bucket, route: string) => (b.routes[route] ??= newCounts());

function visitorHash(day: string, ip: string, ua: string): string {
  if (salt.day !== day) salt = { day, value: randomBytes(16) };
  return createHash("sha256").update(salt.value).update(ip).update("|").update(ua).digest("hex").slice(0, 16);
}

export type Outcome = "unpaid402" | "paid200" | "settleFailed" | "paymentInvalid" | "uncharged" | "ok" | "error";

/** Record one finished request. `route` is the paid route path, or a free path label. */
export function recordRequest(route: string, method: string, ua: string, ip: string, outcome: Outcome, paidAttempt: boolean, selfPayer = false): void {
  const now = new Date();
  const hk = hourKey(now);
  const dk = dayKey(now);
  let { klass, agent } = classify(method, ua);
  if (paidAttempt && klass !== "self") klass = "client"; // anyone who sends a payment is a real client
  if (selfPayer) [klass, agent] = ["self", "test-wallet"]; // payment signed by our own test wallet
  const hb = bucket(hourly, hk, HOURS_KEPT);
  const db = bucket(daily, dk, DAYS_KEPT);
  for (const b of [hb, db]) {
    const c = rc(b, route);
    c.requests[klass]++;
    if (outcome === "unpaid402") c.unpaid402[klass]++;
    else if (selfPayer) {
      if (outcome === "paid200") c.selfPaid = (c.selfPaid ?? 0) + 1; // other self outcomes are not counted
    } else if (outcome === "paid200") c.paid200++;
    else if (outcome === "settleFailed") c.settleFailed++;
    else if (outcome === "paymentInvalid") c.paymentInvalid++;
    else if (outcome === "uncharged") c.uncharged++;
  }
  const ak = `${klass}:${agent}`;
  if (db.agents[ak] !== undefined || Object.keys(db.agents).length < MAX_AGENT_KEYS) db.agents[ak] = (db.agents[ak] ?? 0) + 1;
  else db.agents["other:other"] = (db.agents["other:other"] ?? 0) + 1;

  // unique visitors
  if (hourSets.key !== hk) hourSets = { key: hk, sets: new Map() };
  if (daySets.key !== dk) daySets = { key: dk, sets: new Map(), size: 0, capped: false };
  const h = visitorHash(dk, ip, ua);
  let vHour = false;
  let vDay = false;
  const hs = hourSets.sets.get(route) ?? hourSets.sets.set(route, new Set()).get(route)!;
  if (!hs.has(h) && hs.size < 5000) {
    hs.add(h);
    rc(hb, route).visitors[klass]++;
    vHour = true;
  }
  const ds = daySets.sets.get(route) ?? daySets.sets.set(route, new Set()).get(route)!;
  if (!ds.has(h)) {
    if (daySets.size < MAX_VISITORS_PER_DAY) {
      ds.add(h);
      daySets.size++;
      rc(db, route).visitors[klass]++;
      vDay = true;
    } else daySets.capped = true;
  }

  // Self-test probe handling: remember client 402s; when our test wallet pays from the same
  // visitor on the same route shortly after, move that probe from "client" to "self".
  const pk = `${h}|${route}`;
  if (outcome === "unpaid402" && klass === "client") {
    if (probes.size >= 2000) for (const [k, p] of probes) if (now.getTime() - p.t > PROBE_TTL_MS || probes.size >= 2000) probes.delete(k);
    probes.set(pk, { t: now.getTime(), hk, dk, agent: `client:${agent}`, vHour, vDay });
  } else if (selfPayer) {
    const p = probes.get(pk);
    probes.delete(pk);
    if (p && now.getTime() - p.t <= PROBE_TTL_MS) {
      for (const [b, v] of [[hourly.find((x) => x.start === p.hk), p.vHour], [daily.find((x) => x.start === p.dk), p.vDay]] as const) {
        const c = b?.routes[route];
        if (!c || c.unpaid402.client < 1) continue;
        c.unpaid402.client--, c.unpaid402.self++, c.requests.client--, c.requests.self++;
        if (v && c.visitors.client > 0) c.visitors.client--, c.visitors.self++;
      }
      const d = daily.find((x) => x.start === p.dk);
      if (d && (d.agents[p.agent] ?? 0) > 0) {
        d.agents[p.agent]--;
        if (!d.agents[p.agent]) delete d.agents[p.agent];
        d.agents["self:test-wallet"] = (d.agents["self:test-wallet"] ?? 0) + 1;
      }
    }
  }
}

// ---------- rejected payments (why a payment attempt was refused) ----------
// A payment header that fails verification gets a 402 back. Keep the last few reasons (no IPs, no
// signatures) so we can tell a real buyer stuck on a fixable problem (wrong network, expired
// signature, low balance) from a prober sending junk. Saved with the counts.
export type Rejection = { at: string; route: string; reason: string; network: string | null; scheme: string | null; x402Version: number | null; agent: string; self: boolean };
const REJECTIONS_KEPT = 30;
let rejections: Rejection[] = [];
let rejectionReasons: Record<string, number> = {};
export function recordRejection(r: Omit<Rejection, "at">): void {
  const reason = (r.reason || "unknown").replace(/\s+/g, " ").slice(0, 120);
  rejections.push({ ...r, reason, at: new Date().toISOString() });
  while (rejections.length > REJECTIONS_KEPT) rejections.shift();
  if (!r.self && (rejectionReasons[reason] !== undefined || Object.keys(rejectionReasons).length < 40)) rejectionReasons[reason] = (rejectionReasons[reason] ?? 0) + 1;
}

// ---------- reporting ----------
const sumBC = (a: ByClass, b: ByClass) => KLASSES.forEach((k) => (a[k] += b[k]));
function merge(buckets: Bucket[]): Record<string, RouteCounts> {
  const out: Record<string, RouteCounts> = {};
  for (const b of buckets)
    for (const [r, c] of Object.entries(b.routes)) {
      const o = (out[r] ??= newCounts());
      sumBC(o.requests, c.requests);
      sumBC(o.unpaid402, c.unpaid402);
      sumBC(o.visitors, c.visitors);
      o.paid200 += c.paid200;
      o.settleFailed += c.settleFailed;
      o.paymentInvalid += c.paymentInvalid;
      o.uncharged += c.uncharged;
      o.selfPaid = (o.selfPaid ?? 0) + (c.selfPaid ?? 0);
    }
  return out;
}
const total = (x: ByClass) => KLASSES.reduce((s, k) => s + x[k], 0);
/** Compact view: client vs automated, which is what matters for "real interest". */
function compact(routes: Record<string, RouteCounts>, paidRoutes: string[]) {
  const rows: Record<string, unknown> = {};
  const tot = { unpaid402Client: 0, unpaid402Automated: 0, paid200: 0, settleFailed: 0, paymentInvalid: 0, uncharged: 0, clientVisitors: 0, selfPaid: 0, automatedRequests: 0 };
  for (const r of [...paidRoutes, ...Object.keys(routes).filter((k) => !paidRoutes.includes(k)).sort()]) {
    const c = routes[r];
    if (!c) continue;
    const paid = paidRoutes.includes(r);
    const row = paid
      ? {
          unpaid402: { client: c.unpaid402.client, automated: total(c.unpaid402) - c.unpaid402.client - c.unpaid402.self, self: c.unpaid402.self, byClass: c.unpaid402 },
          paid200: c.paid200,
          selfPaid: c.selfPaid ?? 0,
          automatedRequests: total(c.requests) - c.requests.client - c.requests.self,
          settleFailed: c.settleFailed,
          paymentInvalid: c.paymentInvalid,
          uncharged: c.uncharged,
          visitors: { client: c.visitors.client, all: total(c.visitors) },
          conversion: c.unpaid402.client ? Math.round((c.paid200 / (c.unpaid402.client + c.paid200)) * 1000) / 10 : null,
        }
      : { requests: { client: c.requests.client, automated: total(c.requests) - c.requests.client - c.requests.self }, visitors: { client: c.visitors.client, all: total(c.visitors) } };
    rows[r] = row;
    if (paid) {
      tot.unpaid402Client += c.unpaid402.client;
      tot.unpaid402Automated += total(c.unpaid402) - c.unpaid402.client - c.unpaid402.self;
      tot.paid200 += c.paid200;
      tot.settleFailed += c.settleFailed;
      tot.paymentInvalid += c.paymentInvalid;
      tot.uncharged += c.uncharged;
      tot.clientVisitors += c.visitors.client;
      tot.selfPaid += c.selfPaid ?? 0;
      tot.automatedRequests += total(c.requests) - c.requests.client - c.requests.self;
    }
  }
  return { totals: tot, routes: rows };
}

let persistence: { mode: "file" | "memory"; file: string | null; note: string; lastSavedAt: string | null; restoredFrom: string | null } = {
  mode: "memory",
  file: null,
  note: "in memory only: resets on every deploy or restart",
  lastSavedAt: null,
  restoredFrom: null,
};

export function trafficStats(paidRoutes: string[], full = true) {
  const now = new Date();
  const today = daily.filter((b) => b.start === dayKey(now));
  const yday = daily.filter((b) => b.start === dayKey(new Date(now.getTime() - 864e5)));
  const last24 = hourly.filter((b) => Date.parse(b.start) > now.getTime() - 24 * 3600e3);
  const last7 = daily.filter((b) => b.start >= dayKey(new Date(now.getTime() - 6 * 864e5)));
  const base = {
    since: daily[0]?.start ?? startedAt.slice(0, 10),
    trackingSince,
    processStartedAt: startedAt,
    persistence,
    last24h: compact(merge(last24), paidRoutes),
    today: { date: dayKey(now), ...compact(merge(today), paidRoutes) },
  };
  if (!full) return base;
  return {
    ...base,
    yesterday: { date: dayKey(new Date(now.getTime() - 864e5)), ...compact(merge(yday), paidRoutes) },
    last7d: { ...compact(merge(last7), paidRoutes), note: "visitors are summed per UTC day (a returning visitor counts once per day)" },
    allTime: { ...compact(merge(daily), paidRoutes), note: `everything kept (up to ${DAYS_KEPT} days) since trackingSince` },
    topAgentsToday: Object.entries(today[0]?.agents ?? {})
      .sort((a, b) => b[1] - a[1])
      .slice(0, 25)
      .map(([k, n]) => ({ class: k.split(":")[0], agent: k.slice(k.indexOf(":") + 1), requests: n })),
    daily: daily.map((b) => {
      const c = compact(b.routes, paidRoutes);
      return { date: b.start, ...c.totals };
    }),
    hourly: hourly.slice(-48).map((b) => {
      const c = compact(b.routes, paidRoutes);
      return { hour: b.start, unpaid402Client: c.totals.unpaid402Client, unpaid402Automated: c.totals.unpaid402Automated, paid200: c.totals.paid200, clientVisitors: c.totals.clientVisitors };
    }),
    rejectedPayments: {
      byReason: Object.entries(rejectionReasons).sort((a, b) => b[1] - a[1]).map(([reason, count]) => ({ reason, count })),
      recent: rejections.slice().reverse(),
      note: `payment attempts we refused (buyer not charged), since trackingSince; last ${REJECTIONS_KEPT} kept; our own test wallet is marked self and left out of byReason`,
    },
    visitorSetCapped: daySets.capped,
    definitions: {
      client: "likely real caller (any request carrying a payment, or a non-bot user agent such as node, python, curl, browser)",
      crawler: "directory/indexer crawlers: Coinbase CDP Bazaar, x402scan, 402index, agentic.market, other x402 directories",
      pinger: "uptime monitors (cron-job.org, UptimeRobot, Better Stack, ...)",
      bot: "generic bots, scanners, search/AI crawlers, empty user agent",
      head: "HEAD/OPTIONS requests",
      self: "our own traffic: the rank-check script, payments signed by our test wallet (SELF_PAYERS), and the unpaid probe just before such a payment",
      selfPaid: "paid 200s from our own test wallet; excluded from paid200",
      automated: "crawler + pinger + bot + head",
      visitors: "unique sha256(daily random salt + IP + user agent), per hour or per UTC day; raw IPs are never stored",
      conversion: "paid200 / (client unpaid402 + paid200), in %",
    },
  };
}

// ---------- persistence ----------
let saveTimer: NodeJS.Timeout | null = null;
function save(): void {
  if (persistence.mode !== "file" || !persistence.file) return;
  try {
    const tmp = persistence.file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify({ v: 1, savedAt: new Date().toISOString(), trackingSince, hourly, daily, rejections, rejectionReasons }));
    fs.renameSync(tmp, persistence.file);
    persistence.lastSavedAt = new Date().toISOString();
  } catch (e) {
    persistence.note = `save failed (${String((e as Error).message).slice(0, 80)}); in memory only`;
  }
}

export function startTraffic(): void {
  const file = process.env.TRAFFIC_FILE ?? path.join(process.cwd(), "data", "traffic.json");
  if (file && file !== "off") {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.accessSync(path.dirname(file), fs.constants.W_OK);
      persistence = {
        mode: "file",
        file,
        note: process.env.RENDER
          ? "saved to local disk every 10 min and on shutdown; Render free instances have no persistent disk, so this still resets on each deploy (mount a disk and set TRAFFIC_FILE to keep it)"
          : "saved to local disk every 10 min and on shutdown",
        lastSavedAt: null,
        restoredFrom: null,
      };
      if (fs.existsSync(file)) {
        const j = JSON.parse(fs.readFileSync(file, "utf8"));
        if (j?.v === 1) {
          for (const b of j.hourly ?? []) hourly.push(b);
          for (const b of j.daily ?? []) daily.push(b);
          while (hourly.length > HOURS_KEPT) hourly.shift();
          while (daily.length > DAYS_KEPT) daily.shift();
          persistence.restoredFrom = j.savedAt ?? null;
          if (Array.isArray(j.rejections)) rejections = j.rejections.slice(-REJECTIONS_KEPT);
          if (j.rejectionReasons && typeof j.rejectionReasons === "object") rejectionReasons = j.rejectionReasons;
          if (daily.length) trackingSince = j.trackingSince ?? `${daily[0]!.start}T00:00:00.000Z`;
        }
      }
    } catch (e) {
      persistence = { mode: "memory", file: null, note: `no writable disk (${String((e as Error).message).slice(0, 60)}); in memory only, resets on deploy`, lastSavedAt: null, restoredFrom: null };
    }
  }
  if (persistence.mode === "file" && !saveTimer) {
    saveTimer = setInterval(save, 10 * 60_000);
    saveTimer.unref();
    const onExit = () => {
      save();
      process.exit(0);
    };
    process.once("SIGTERM", onExit);
    process.once("SIGINT", onExit);
  }
}
