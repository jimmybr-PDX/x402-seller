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
  "research brief|research brief with citations|answer a question with sources|web research|summarize a topic|wikipedia summary|x402 bazaar ranking|read web page as markdown|url to markdown|web page to markdown|scrape article text|x402 endpoint check|validate x402 endpoint|news search|news headlines|token price|crypto price|solana token price|sol price|wallet balance|token balances|transaction receipt|decode transaction|gas price|gas fees|ethereum gas|erc20 balance|tx status|latest news|crypto token price|web search|search api|serp api|search results with page text"
).split("|");
const CDP = "https://api.cdp.coinbase.com/platform/v2/x402/discovery";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const UA = { "user-agent": "x402-seller-rankcheck/2 (self; excluded from /stats client counts)" };
const j = async (u, init) => {
  try {
    const r = await fetch(u, { ...init, headers: { ...UA, ...(init?.headers ?? {}) }, signal: AbortSignal.timeout(20000) });
    return { status: r.status, ms: 0, body: await r.json().catch(() => null) };
  } catch (e) {
    return { status: 0, body: null, error: String(e) };
  }
};
const out = { at: new Date().toISOString(), origin: ORIGIN, payTo: PAY_TO };

// 1. Live endpoints + latency
out.live = [];
for (const p of ["/health", "/llms.txt", "/openapi.json", "/.well-known/x402", "/report?q=test", "/read?url=https://example.com", "/check?url=https://example.com", "/news?q=test", "/price?token=ETH", "/solana-price?token=SOL", "/balance?address=vitalik.eth", "/tx?hash=0x" + "ab".repeat(32), "/gas", "/search?q=test"]) {
  const t = Date.now();
  let status = 0;
  let hasChallenge = false;
  try {
    const r = await fetch(ORIGIN + p, { headers: UA, signal: AbortSignal.timeout(90000) });
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
  const [s, sa] = await Promise.all([
    j(`${CDP}/search?limit=20&network=eip155:8453&query=${encodeURIComponent(q)}`),
    j(`${CDP}/search?limit=20&query=${encodeURIComponent(q)}`),
  ]);
  const rs = s.body?.resources ?? [];
  const idx = rs.findIndex((r) => String(r.resource).includes(HOST));
  const ia = (sa.body?.resources ?? []).findIndex((r) => String(r.resource).includes(HOST));
  out.searchRank.push({
    query: q,
    rank: idx >= 0 ? idx + 1 : null,
    rankAnyNetwork: ia >= 0 ? ia + 1 : null,
    ourRoute: idx >= 0 ? new URL(rs[idx].resource).pathname : null,
    results: rs.length,
    leader: rs[0] ? { resource: rs[0].resource, calls30d: rs[0].quality?.l30DaysTotalCalls ?? null, priceUsd: Number(rs[0].accepts?.[0]?.amount ?? 0) / 1e6 } : null,
  });
}

// 4. CDP validate (free)
for (const path of ["/report", "/read", "/check", "/news", "/price", "/solana-price", "/balance", "/tx", "/gas", "/search"]) {
  const v = await j("https://api.cdp.coinbase.com/platform/v2/x402/validate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ resource: ORIGIN + path, method: "GET" }),
  });
  (out.validate ??= []).push({ path, valid: v.body?.valid ?? null, simulation: v.body?.simulation?.outcome ?? null, indexActive: v.body?.index?.active ?? null, lastCrawledAt: v.body?.index?.lastCrawledAt ?? null, failed: (v.body?.preflight ?? []).filter((c) => !c.passed).map((c) => c.check) });
}

// 5. On-chain USDC received. Blockscout first; if it fails (it started returning non-JSON on 2026-10-07 and
// silently reported 0 sales), fall back to direct Base RPC logs for the last LOOKBACK_H hours. A failed
// source is reported as unknown, never as 0. Solana USDC account is checked too.
const OWN = (process.env.OWN_ADDRS ?? "0x4862dac2c03fAA8B36A23D176932945193B04940").toLowerCase().split(",");
const LOOKBACK_H = Number(process.env.LOOKBACK_H ?? 48);
const isSale = (from, usd) => !OWN.includes(String(from).toLowerCase()) && usd <= 1; // top-ups > $1 are not sales
const rpc = async (url, method, params, tries = 3) => {
  for (let i = 1; ; i++) {
    try {
      const r = await fetch(url, { method: "POST", headers: { ...UA, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(20000) });
      const b = await r.json();
      if (b.error) throw new Error(JSON.stringify(b.error).slice(0, 160));
      return b.result;
    } catch (e) {
      if (i >= tries || !/rate|429|too many|timeout|fetch failed|Unexpected token/i.test(String(e.message ?? e))) throw e;
      await new Promise((ok) => setTimeout(ok, 1500 * i)); // back off on rate limits / flaky responses
    }
  }
};
out.onchain = { source: null, error: null, windowH: null, sales: [] };
const bs = await j(`https://base.blockscout.com/api/v2/addresses/${PAY_TO}/token-transfers?type=ERC-20&filter=to&token=${USDC}`);
if (Array.isArray(bs.body?.items)) {
  out.onchain.source = "blockscout (50 most recent transfers)";
  out.onchain.windowH = 30 * 24;
  const since = Date.now() - 30 * 864e5;
  out.onchain.sales = bs.body.items
    .filter((t) => t.to?.hash?.toLowerCase() === PAY_TO.toLowerCase() && Date.parse(t.timestamp) >= since)
    .map((t) => ({ at: t.timestamp, from: t.from.hash, usd: Number(t.total.value) / 1e6, tx: t.transaction_hash }))
    .filter((t) => isSale(t.from, t.usd));
} else {
  const RPCS = (process.env.BASE_RPCS ?? "https://base.gateway.tenderly.co|https://developer-access-mainnet.base.org|https://base-rpc.publicnode.com|https://mainnet.base.org").split("|");
  const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
  const toTopic = "0x" + PAY_TO.slice(2).toLowerCase().padStart(64, "0");
  for (const url of RPCS) {
    try {
      const latest = parseInt(await rpc(url, "eth_blockNumber", []), 16);
      const startBlock = latest - Math.round((LOOKBACK_H * 3600) / 2); // Base: 2 s blocks
      const logs = [];
      // 500-block chunks (public gateways cap ranges at 1000), 6 in parallel; any chunk error fails this RPC
      const chunks = [];
      for (let b = startBlock; b <= latest; b += 500) chunks.push([b, Math.min(b + 499, latest)]);
      for (let i = 0; i < chunks.length; i += 6) {
        const got = await Promise.all(chunks.slice(i, i + 6).map(([b, e]) => rpc(url, "eth_getLogs", [{ address: USDC, fromBlock: "0x" + b.toString(16), toBlock: "0x" + e.toString(16), topics: [TRANSFER, null, toTopic] }])));
        for (const g of got) logs.push(...g);
      }
      const sales = [];
      for (const l of logs) {
        const from = "0x" + l.topics[1].slice(-40);
        const usd = parseInt(l.data, 16) / 1e6;
        if (!isSale(from, usd)) continue;
        const blk = await rpc(url, "eth_getBlockByNumber", [l.blockNumber, false]);
        sales.push({ at: new Date(parseInt(blk.timestamp, 16) * 1000).toISOString(), from, usd, tx: l.transactionHash });
      }
      out.onchain = { source: `base rpc ${new URL(url).host} (blockscout unavailable)`, error: null, windowH: LOOKBACK_H, sales: sales.reverse() };
      break;
    } catch (e) {
      out.onchain.error = `${out.onchain.error ? out.onchain.error + "; " : `blockscout status ${bs.status}; `}${new URL(url).host}: ${String(e.message ?? e).slice(0, 120)}`;
    }
  }
}
// Solana: USDC token account activity in the window (balance change per tx; positive = money in)
const SOL_RPC = process.env.SOL_RPC ?? "https://api.mainnet-beta.solana.com";
const SOL_USDC_ATA = process.env.SOL_USDC_ATA ?? "2Ra4aQkTs3fYZrS8bafnT6LsExhaDbtqai4keRacTbYs";
out.solana = { ata: SOL_USDC_ATA, balance: null, inflows: [], error: null };
try {
  out.solana.balance = (await rpc(SOL_RPC, "getTokenAccountBalance", [SOL_USDC_ATA])).value.uiAmount;
  const sigs = await rpc(SOL_RPC, "getSignaturesForAddress", [SOL_USDC_ATA, { limit: 20 }]);
  const cutoff = Date.now() / 1000 - LOOKBACK_H * 3600;
  for (const s of sigs.filter((x) => x.blockTime >= cutoff && !x.err)) {
    const tx = await rpc(SOL_RPC, "getTransaction", [s.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }]);
    const keys = tx.transaction.message.accountKeys.map((k) => k.pubkey ?? k);
    const idx = keys.indexOf(SOL_USDC_ATA);
    const amt = (arr) => Number(arr?.find((b) => b.accountIndex === idx)?.uiTokenAmount?.uiAmount ?? 0);
    const delta = Math.round((amt(tx.meta.postTokenBalances) - amt(tx.meta.preTokenBalances)) * 1e6) / 1e6;
    if (delta > 0) out.solana.inflows.push({ at: new Date(s.blockTime * 1000).toISOString(), usd: delta, sig: s.signature, saleSized: delta <= 1 });
  }
} catch (e) {
  out.solana.error = String(e.message ?? e).slice(0, 160);
}

// 6. Our own interest tracker (/stats): real clients vs crawlers/bots per paid route
{
  const st = await j(`${ORIGIN}/stats`);
  const b = st.body;
  out.traffic = b
    ? {
        since: b.since,
        persistence: b.persistence?.mode,
        last24h: b.last24h?.totals,
        yesterday: b.yesterday?.totals,
        last7d: b.last7d?.totals,
        routes24h: Object.fromEntries(
          Object.entries(b.last24h?.routes ?? {})
            .filter(([, v]) => v.unpaid402)
            .map(([k, v]) => [k, { client402: v.unpaid402.client, automated402: v.unpaid402.automated, paid200: v.paid200, settleFailed: v.settleFailed, clientVisitors: v.visitors.client }]),
        ),
        topAgentsToday: (b.topAgentsToday ?? []).slice(0, 8),
      }
    : { error: `stats unavailable (HTTP ${st.status})` };
}

// 7. x402scan presence (public page; 200 + host mention = listed)
try {
  const X402SCAN_ID = process.env.X402SCAN_ORIGIN_ID ?? "732c6ca1-b936-460c-984a-09368d91ac8d";
  const r = await fetch(`https://www.x402scan.com/server/${X402SCAN_ID}`, { signal: AbortSignal.timeout(20000) });
  const html = await r.text();
  out.x402scan = { url: `https://www.x402scan.com/server/${X402SCAN_ID}`, status: r.status, listed: r.ok && html.includes(HOST) };
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
  console.log("\n## Bazaar search rank (top 20; Base filter / any network)"); for (const s of out.searchRank) console.log(`- "${s.query}": ${s.rank ?? "-"} / ${s.rankAnyNetwork ?? "-"}${s.ourRoute ? ` (${s.ourRoute})` : ""}  | #1 = ${s.leader?.resource ?? "-"} (${s.leader?.calls30d ?? "?"} calls, $${s.leader?.priceUsd ?? "?"})`);
  const top = out.searchRank.filter((s) => s.rank === 1).length, top3 = out.searchRank.filter((s) => s.rank && s.rank <= 3).length, top20 = out.searchRank.filter((s) => s.rank).length;
  console.log(`  summary (Base filter): #1 for ${top}, top-3 for ${top3}, top-20 for ${top20} of ${out.searchRank.length} queries`);
  console.log("\n## CDP validate"); for (const v of out.validate) console.log(`- ${v.path}: valid=${v.valid} sim=${v.simulation} indexed=${v.indexActive} lastCrawled=${v.lastCrawledAt} failed=[${v.failed.join(",")}]`);
  const oc = out.onchain;
  console.log(`\n## On-chain sales (USDC in, outside buyers only)`);
  if (!oc.source) console.log(`- Base: UNKNOWN, every source failed (${oc.error}); do not read this as zero sales`);
  else {
    console.log(`- Base, last ${oc.windowH}h via ${oc.source}: ${oc.sales.length} payments, $${Math.round(oc.sales.reduce((a, t) => a + t.usd, 0) * 1e6) / 1e6}, ${new Set(oc.sales.map((t) => t.from.toLowerCase())).size} unique payers`);
    for (const t of oc.sales.slice(0, 10)) console.log(`  - ${t.at} ${t.from} $${t.usd} ${t.tx}`);
  }
  const so = out.solana;
  if (so.error) console.log(`- Solana: UNKNOWN (${so.error})`);
  else {
    console.log(`- Solana USDC balance ${so.balance}; money in, last ${LOOKBACK_H}h: ${so.inflows.length}`);
    for (const t of so.inflows) console.log(`  - ${t.at} +$${t.usd}${t.saleSized ? "" : " (over $1, likely a top-up)"} ${t.sig}`);
  }
  const t = out.traffic;
  console.log("\n## Interest tracker (/stats; resets on deploy unless a disk is mounted)");
  if (t.error) console.log(`- ${t.error}`);
  else {
    const f = (x) => (x ? `client 402s ${x.unpaid402Client}, automated 402s ${x.unpaid402Automated}, paid ${x.paid200}, settle failed ${x.settleFailed}, client visitors ${x.clientVisitors}` : "-");
    console.log(`- tracking since ${t.since} (${t.persistence})`);
    console.log(`- last 24h: ${f(t.last24h)}`);
    console.log(`- yesterday (UTC): ${f(t.yesterday)}`);
    console.log(`- last 7d: ${f(t.last7d)}`);
    for (const [k, v] of Object.entries(t.routes24h)) console.log(`  - ${k}: client402=${v.client402} automated402=${v.automated402} paid=${v.paid200} visitors=${v.clientVisitors}`);
    console.log(`- top agents today: ${t.topAgentsToday.map((a) => `${a.class}:${a.agent}=${a.requests}`).join(", ")}`);
  }
  console.log(`\n## x402scan\n- ${out.x402scan.url ?? ""} -> listed=${out.x402scan.listed ?? "?"} (${out.x402scan.status ?? out.x402scan.error})`);
}
