#!/usr/bin/env node
/**
 * Recurring discovery/ranking checklist (read-only, free, no keys).
 *   node scripts/rank-check.mjs            # human-readable
 *   node scripts/rank-check.mjs --json     # machine-readable
 * Env: PAY_TO, ORIGIN, QUERIES (|-separated) to override defaults.
 */
const PAY_TO = process.env.PAY_TO ?? "0x079471E6F43b6feeF80895E19cBFcBB496904852";
const ORIGIN = (process.env.ORIGIN ?? "https://x402-seller-pmlm.onrender.com").replace(/\/$/, "");
const HOST = new URL(ORIGIN).host;
const QUERIES = (process.env.QUERIES ??
  "research brief|research brief with citations|answer a question with sources|web research|summarize a topic|wikipedia summary|read web page as markdown|url to markdown|web page to markdown|scrape article text|x402 endpoint check|validate x402 endpoint"
).split("|");
const CDP = "https://api.cdp.coinbase.com/platform/v2/x402/discovery";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const j = async (u, init) => {
  try {
    const r = await fetch(u, { ...init, signal: AbortSignal.timeout(20000) });
    return { status: r.status, ms: 0, body: await r.json().catch(() => null) };
  } catch (e) {
    return { status: 0, body: null, error: String(e) };
  }
};
const out = { at: new Date().toISOString(), origin: ORIGIN, payTo: PAY_TO };

// 1. Live endpoints + latency
out.live = [];
for (const p of ["/health", "/llms.txt", "/openapi.json", "/.well-known/x402", "/report?q=test", "/read?url=https://example.com", "/check?url=https://example.com"]) {
  const t = Date.now();
  let status = 0;
  let hasChallenge = false;
  try {
    const r = await fetch(ORIGIN + p, { signal: AbortSignal.timeout(90000) });
    status = r.status;
    hasChallenge = !!r.headers.get("payment-required");
  } catch {}
  out.live.push({ path: p, status, ms: Date.now() - t, ...(status === 402 ? { hasChallenge } : {}) });
}

// 2. CDP Bazaar: our listings + quality
const m = await j(`${CDP}/merchant?payTo=${PAY_TO}&limit=50`);
out.bazaarListings = (m.body?.resources ?? []).map((r) => ({
  resource: r.resource,
  calls30d: r.quality?.l30DaysTotalCalls ?? null,
  payers30d: r.quality?.l30DaysUniquePayers ?? null,
  lastCalledAt: r.quality?.lastCalledAt ?? null,
  lastUpdated: r.lastUpdated ?? null,
  serviceName: r.serviceName ?? null,
  tags: r.tags ?? null,
  descriptionStart: (r.description ?? "").slice(0, 80),
}));

// 3. CDP Bazaar search rank per query (top 20; null = not in top 20)
out.searchRank = [];
for (const q of QUERIES) {
  const s = await j(`${CDP}/search?limit=20&network=eip155:8453&query=${encodeURIComponent(q)}`);
  const rs = s.body?.resources ?? [];
  const idx = rs.findIndex((r) => String(r.resource).includes(HOST));
  out.searchRank.push({
    query: q,
    rank: idx >= 0 ? idx + 1 : null,
    results: rs.length,
    leader: rs[0] ? { resource: rs[0].resource, calls30d: rs[0].quality?.l30DaysTotalCalls ?? null, priceUsd: Number(rs[0].accepts?.[0]?.amount ?? 0) / 1e6 } : null,
  });
}

// 4. CDP validate (free)
for (const path of ["/report", "/read", "/check"]) {
  const v = await j("https://api.cdp.coinbase.com/platform/v2/x402/validate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ resource: ORIGIN + path, method: "GET" }),
  });
  (out.validate ??= []).push({ path, valid: v.body?.valid ?? null, simulation: v.body?.simulation?.outcome ?? null, indexActive: v.body?.index?.active ?? null, lastCrawledAt: v.body?.index?.lastCrawledAt ?? null, failed: (v.body?.preflight ?? []).filter((c) => !c.passed).map((c) => c.check) });
}

// 5. On-chain USDC received (Base, Blockscout)
const bs = await j(`https://base.blockscout.com/api/v2/addresses/${PAY_TO}/token-transfers?type=ERC-20&filter=to&token=${USDC}`);
// Exclude our own test buyer and non-sale transfers (funding top-ups > $1).
const OWN = (process.env.OWN_ADDRS ?? "0x4862dac2c03fAA8B36A23D176932945193B04940").toLowerCase().split(",");
const items = (bs.body?.items ?? []).filter(
  (t) => t.to?.hash?.toLowerCase() === PAY_TO.toLowerCase() && !OWN.includes(t.from?.hash?.toLowerCase()) && Number(t.total.value) / 1e6 <= 1,
);
const since = Date.now() - 30 * 864e5;
const last30 = items.filter((t) => Date.parse(t.timestamp) >= since);
out.onchain = {
  last30dPayments: last30.length,
  last30dUsd: Math.round(last30.reduce((a, t) => a + Number(t.total.value) / 1e6, 0) * 1e6) / 1e6,
  last30dUniquePayers: new Set(last30.map((t) => t.from.hash.toLowerCase())).size,
  latest: items.slice(0, 5).map((t) => ({ at: t.timestamp, from: t.from.hash, usd: Number(t.total.value) / 1e6, tx: t.transaction_hash })),
  note: "first page only (50 most recent transfers)",
};

// 6. x402scan presence (public page; 200 + host mention = listed)
try {
  const r = await fetch(`https://www.x402scan.com/server/${HOST}`, { signal: AbortSignal.timeout(20000) });
  const html = await r.text();
  out.x402scan = { url: `https://www.x402scan.com/server/${HOST}`, status: r.status, listed: r.ok && !/Not Found/.test(html) };
} catch (e) {
  out.x402scan = { error: String(e) };
}

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(out, null, 2));
} else {
  console.log(`# x402 rank check ${out.at}`);
  console.log("\n## Live"); for (const l of out.live) console.log(`- ${l.path}: ${l.status} in ${l.ms} ms${l.hasChallenge === false ? " (NO PAYMENT-REQUIRED header!)" : ""}`);
  console.log("\n## Bazaar listings (payTo)"); for (const b of out.bazaarListings) console.log(`- ${b.resource}: ${b.calls30d} calls / ${b.payers30d} payers (30d), last call ${b.lastCalledAt}, name=${b.serviceName ?? "-"} tags=${(b.tags ?? []).join(",") || "-"}`);
  if (!out.bazaarListings.length) console.log("- none (endpoints need a CDP-settled payment to be indexed; dropped after 30 days without one)");
  console.log("\n## Bazaar search rank (top 20, Base)"); for (const s of out.searchRank) console.log(`- "${s.query}": ${s.rank ?? "not in top 20"}  | #1 = ${s.leader?.resource ?? "-"} (${s.leader?.calls30d ?? "?"} calls, $${s.leader?.priceUsd ?? "?"})`);
  console.log("\n## CDP validate"); for (const v of out.validate) console.log(`- ${v.path}: valid=${v.valid} sim=${v.simulation} indexed=${v.indexActive} lastCrawled=${v.lastCrawledAt} failed=[${v.failed.join(",")}]`);
  console.log(`\n## On-chain (Base USDC in, outside buyers only)\n- last 30d: ${out.onchain.last30dPayments} payments, $${out.onchain.last30dUsd}, ${out.onchain.last30dUniquePayers} unique payers`);
  for (const t of out.onchain.latest) console.log(`  - ${t.at} ${t.from} $${t.usd} ${t.tx}`);
  console.log(`\n## x402scan\n- ${out.x402scan.url ?? ""} -> listed=${out.x402scan.listed ?? "?"} (${out.x402scan.status ?? out.x402scan.error})`);
}
