import { jupFetch } from "./jup-gate.js";
import { stashTrades } from "./rug-paid.js";
// Buyer-facing extra signals (free sources only): Jupiter token stats + sell quote, pump.fun frontend-api-v3 trades,
// mint-account token-2022 extensions, DexScreener socials. Every lookup is time-boxed; failures become unknowns.
const SOL = "So11111111111111111111111111111111111111112";
const UA = { "user-agent": "Mozilla/5.0 (RugRadar)", accept: "application/json" };
let lastWarn = 0;
const r2 = (n: number | null | undefined, d = 2) => (n == null || !isFinite(Number(n)) ? null : +Number(n).toFixed(d));
import { goplusSol, goplusChecks } from "./goplus-sol.js";
export type Extra = { signals: Record<string, unknown>; checks: { check: string; points: number; detail: string }[]; unknown: string[]; ms: number };

// Repeat snipers: wallets this service has itself seen sniping (first 10 s) 3+ different coins. In-memory, free, no lookups.
// RugRadar never reads paper-bot or private signal data; it reports danger warnings from public data only.
const sniperSeen = new Map<string, Set<string>>();
function noteSnipers(mint: string, ws: string[]) { for (const w of ws) { const x = sniperSeen.get(w) ?? new Set(); x.add(mint); sniperSeen.set(w, x); } if (sniperSeen.size > 50000) sniperSeen.delete(sniperSeen.keys().next().value!); }
const isKnownSniper = (w: string) => (sniperSeen.get(w)?.size ?? 0) >= 3;
/** pump.fun bonding curve state via RPC: active curve = still sellable on pump.fun even without a Jupiter route. */
export async function pumpCurve(mint: string): Promise<{ active: boolean; complete: boolean } | null> {
  try {
    const { getProgramDerivedAddress, getAddressEncoder, address } = await import("@solana/kit");
    const [pda] = await getProgramDerivedAddress({ programAddress: address("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"), seeds: ["bonding-curve", getAddressEncoder().encode(address(mint))] });
    const { rpc } = await import("./solana.js");
    const v: any = await rpc<any>("getAccountInfo", [pda, { encoding: "base64" }], { timeoutMs: 1500 });
    const b = Buffer.from(v?.value?.data?.[0] ?? "", "base64"); if (b.length < 49) return null;
    return { active: b[48] === 0 && b.readBigUInt64LE(24) > 0n, complete: b[48] === 1 };
  } catch { return null; }
}
/** Solana CAIP-2 chain id used by frontend-api-v3.pump.fun. */
export const PUMP_CHAIN = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
export const pumpTradesUrl = (mint: string, cursor?: string) =>
  `https://frontend-api-v3.pump.fun/trades/${PUMP_CHAIN}/${mint}?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;

/** Map a frontend-api-v3 trade onto the shape stashTrades / launch analysis already use.
 *  amountSol comes from valueNative so WBTC-quoted (and other non-SOL) pools stay in SOL terms. Launch slot is blockId. */
export function mapPumpV3Trade(t: any): { userAddress: string; type: "buy" | "sell"; baseAmount: number; amountSol: number; amountUsd: number | null; timestamp: string; slotIndexId: string } | null {
  const addr = typeof t?.trader?.address === "string" ? t.trader.address : "";
  const side = t?.side === "sell" ? "sell" as const : t?.side === "buy" ? "buy" as const : null;
  if (!addr || !side) return null;
  const dec = Number(t?.baseAmount?.decimals);
  const raw = Number(t?.baseAmount?.raw);
  const baseAmount = isFinite(raw) ? raw / 10 ** (isFinite(dec) && dec >= 0 ? dec : 0) : 0;
  const ts = Number(t?.blockTimeMs);
  if (!isFinite(ts)) return null;
  return {
    userAddress: addr, type: side, baseAmount,
    amountSol: Number(t?.valueNative ?? 0) || 0,
    amountUsd: t?.valueUsd != null && isFinite(Number(t.valueUsd)) ? Number(t.valueUsd) : null,
    timestamp: new Date(ts).toISOString(),
    slotIndexId: String(t?.blockId ?? ""),
  };
}

/** One page of pump.fun trades. 4xx returns immediately (no retry). Network / 5xx may retry once. */
async function pumpTradesPage(url: string, retry: boolean): Promise<{ status: number; body: any } | { status: number; body: null; network: true }> {
  try {
    const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(2500) });
    if (!r.ok) {
      if (Date.now() - lastWarn > 5000) { lastWarn = Date.now(); console.warn(`[rug-extra] ${new URL(url).host} HTTP ${r.status}`); }
      if (r.status >= 500 && retry) { await new Promise((res) => setTimeout(res, 400)); return pumpTradesPage(url, false); }
      return { status: r.status, body: null };
    }
    return { status: r.status, body: await r.json() };
  } catch (e: any) {
    if (Date.now() - lastWarn > 5000) { lastWarn = Date.now(); console.warn(`[rug-extra] ${new URL(url).host} ${e?.name ?? "error"}`); }
    if (retry) { await new Promise((r) => setTimeout(r, 400)); return pumpTradesPage(url, false); }
    return { status: 0, body: null, network: true };
  }
}

/** pump.fun public trade history via frontend-api-v3 (newest first, 100/page, cursor paging). Reaches launch only for young tokens (<= 400 trades). */
export async function pumpLaunch(mint: string, dev: string | null, supply: number) {
  const trades: NonNullable<ReturnType<typeof mapPumpV3Trade>>[] = []; let cursor = ""; let complete = false;
  for (let p = 0; p < 4; p++) {
    const u = pumpTradesUrl(mint, cursor || undefined);
    const d = await pumpTradesPage(u, true);
    if (d.status >= 400 && d.status < 500) return null; // 410/404/400: endpoint gone or bad request — do not retry
    const raw = Array.isArray(d.body?.trades) ? d.body.trades : null;
    if (!raw) return null;
    for (const t of raw) { const m = mapPumpV3Trade(t); if (m) trades.push(m); }
    if (!d.body?.cursor) { complete = true; break; }
    cursor = String(d.body.cursor);
  }
  try { stashTrades(mint, trades, complete); } catch {} // kept 10 min for the paid report (no extra fetch)
  const amt = (t: any) => Number(t.baseAmount || 0);
  const devT = dev ? trades.filter((t) => t.userAddress === dev) : [];
  const devBought = devT.filter((t) => t.type === "buy").reduce((a, t) => a + amt(t), 0);
  const devSoldAmt = devT.filter((t) => t.type === "sell").reduce((a, t) => a + amt(t), 0);
  const out: Record<string, unknown> = { devBuys: devT.filter((t) => t.type === "buy").length, devSells: devT.filter((t) => t.type === "sell").length,
    devSoldPctOfBought: devBought > 0 ? r2(Math.min(100, (devSoldAmt / devBought) * 100), 1) : (devSoldAmt > 0 ? 100 : 0), tradesSeen: trades.length, historyComplete: complete };
  if (complete && trades.length) {
    const asc = [...trades].reverse(); const t0 = Date.parse(asc[0].timestamp); const slot0 = asc[0].slotIndexId.slice(0, 13);
    const buys = asc.filter((t) => t.type === "buy" && t.userAddress !== dev);
    const sniperBuys = buys.filter((t) => Date.parse(t.timestamp) - t0 <= 10_000), bundleBuys = buys.filter((t) => t.slotIndexId.slice(0, 13) === slot0);
    const pct = (xs: any[]) => (supply > 0 ? r2((xs.reduce((a, t) => a + amt(t), 0) / supply) * 100, 2) : null);
    Object.assign(out, { sniperWallets10s: new Set(sniperBuys.map((t) => t.userAddress)).size, sniperSupplyPct10s: pct(sniperBuys),
      bundledWalletsLaunchSlot: new Set(bundleBuys.map((t) => t.userAddress)).size, bundledSupplyPctLaunchSlot: pct(bundleBuys) });
    // First minute of trading
    const m1 = asc.filter((t) => Date.parse(t.timestamp) - t0 <= 60_000);
    const sol = (xs: any[]) => r2(xs.reduce((a, t) => a + Number(t.amountSol || 0), 0), 3);
    const devFirstSell = dev ? asc.find((t) => t.userAddress === dev && t.type === "sell") : null;
    out.firstMinute = { buyers: new Set(m1.filter((t) => t.type === "buy").map((t) => t.userAddress)).size, buySol: sol(m1.filter((t) => t.type === "buy")), sellSol: sol(m1.filter((t) => t.type === "sell")), trades: m1.length };
    out.creatorFirstSellAfterSec = devFirstSell ? Math.round((Date.parse(devFirstSell.timestamp) - t0) / 1000) : null;
    // Early snipers (first 10 s, not the dev): how much they still hold, and repeat sniper wallets among early buyers
    const sn = [...new Set(sniperBuys.map((t) => t.userAddress))];
    const net = (w: string) => asc.filter((t) => t.userAddress === w).reduce((a, t) => a + (t.type === "buy" ? 1 : -1) * amt(t), 0);
    out.sniperStillHoldPct = supply > 0 ? r2((sn.reduce((a, w) => a + Math.max(0, net(w)), 0) / supply) * 100, 2) : null;
    const early = [...new Set(asc.filter((t) => t.type === "buy" && Date.parse(t.timestamp) - t0 <= 60_000 && t.userAddress !== dev).map((t) => t.userAddress))];
    out.knownSnipersEarly = early.filter(isKnownSniper).length;
    noteSnipers(mint, sn);
  }
  return out;
}

export type MarketSnap = { failed: boolean; pairs: any[]; liquidityUsd: number | null; source?: string };
export async function solanaExtra(mint: string, o: { jup: any; jupFailed?: boolean; dsAnswered?: boolean; mintInfo: any; dsPairs?: any[]; supply: number; decimals: number | null; liquidityUsd?: number | null; marketP?: Promise<MarketSnap>; liqOf?: (m: MarketSnap) => number | null }): Promise<Extra> {
  const t0 = Date.now(); const { jup } = o; const unknown: string[] = []; const checks: Extra["checks"] = [];
  const add = (check: string, points: number, detail: string) => checks.push({ check, points, detail });
  const isPump = /pump/i.test(jup?.launchpad ?? "") || mint.endsWith("pump");
  // Market (DexScreener/Gecko) can be slow from Render: start the sell quote, pump.fun trades and curve read
  // immediately, and only wait for market when a check actually needs liquidity or pair socials.
  const marketReady: Promise<{ dsPairs: any[]; dsAnswered: boolean | undefined; liquidityUsd: number | null }> = o.marketP
    ? o.marketP.then((m) => ({ dsPairs: m.pairs ?? [], dsAnswered: !m.failed && !m.source, liquidityUsd: (o.liqOf ? o.liqOf(m) : m.liquidityUsd) ?? null })).catch(() => ({ dsPairs: o.dsPairs ?? [], dsAnswered: o.dsAnswered, liquidityUsd: o.liquidityUsd ?? null }))
    : Promise.resolve({ dsPairs: o.dsPairs ?? [], dsAnswered: o.dsAnswered, liquidityUsd: o.liquidityUsd ?? null });
  // Sell check: ask Jupiter for a sell quote of ~$100 worth (or 0.1% of supply).
  const price = Number(jup?.usdPrice ?? 0);
  const units = price > 0 ? Math.floor((100 / price) * 10 ** (o.decimals ?? 0)) : Math.floor(o.supply * 0.001 * 10 ** (o.decimals ?? 0));
  const gpP = goplusSol(mint); // non-blocking: raced below against a short budget
  const [quote, pump, curve, mkt] = await Promise.all([
    units > 0 && mint !== SOL ? jupFetch(`https://lite-api.jup.ag/swap/v1/quote?inputMint=${mint}&outputMint=${SOL}&amount=${units}&slippageBps=1000`, { headers: UA, signal: AbortSignal.timeout(3500) }).then((r) => (r ? r.json() : null)).catch(() => null) : Promise.resolve(null),
    isPump ? pumpLaunch(mint, jup?.dev ?? null, o.supply).catch(() => null) : Promise.resolve(null),
    isPump ? pumpCurve(mint) : Promise.resolve(null),
    marketReady,
  ]);
  const dsPairs = mkt.dsPairs;
  const liquidityUsd = mkt.liquidityUsd;
  const s: Record<string, unknown> = {};
  // Sell route (honeypot pattern on Solana = no route out, or a huge impact)
  // Can it still be sold? Jupiter route or, for pump.fun coins, an active bonding curve.
  s.sellableOnPumpCurve = curve ? curve.active : null;
  s.canSell = quote?.outAmount ? "yes (Jupiter route)" : curve?.active ? "yes (pump.fun curve)" : curve == null && !quote ? "unknown" : "no route found";
  if (!quote?.outAmount && curve?.active) { s.sellRoute = "pump.fun curve only"; }
  else if (!quote?.outAmount && isPump && curve && !curve.active && /ROUTE|NOT_TRADABLE/i.test(String(quote?.errorCode ?? quote?.error ?? ""))) { s.sellRoute = false; add("sell_route", 30, "No way to sell this token was found."); }
  else if (quote?.outAmount) { s.sellRoute = true; s.sellPriceImpactPct = r2(Number(quote.priceImpactPct) * 100, 2); s.sellTestUsd = price > 0 ? 100 : null; s.sellVia = [...new Set((quote.routePlan ?? []).map((x: any) => x.swapInfo?.label).filter(Boolean))].slice(0, 3); }
  else if (/ROUTE|NOT_TRADABLE/i.test(String(quote?.errorCode ?? quote?.error ?? "")) && (liquidityUsd ?? 0) > 1000) { s.sellRoute = false; add("sell_route", 30, "No way to sell this token was found."); }
  else unknown.push("sell route");
  if (Number(s.sellPriceImpactPct) > 20) add("sell_impact", 10, "A ~$100 sale moves the price over 20%.");
  // Token-2022 extensions that let the issuer take or block funds
  const ext = new Map<string, any>((o.mintInfo?.extensions ?? []).map((e: any) => [e.extension, e.state]));
  const fee = ext.get("transferFeeConfig"); const feeBps = fee ? Number(fee.newerTransferFee?.transferFeeBasisPoints ?? fee.olderTransferFee?.transferFeeBasisPoints ?? 0) : 0;
  s.token2022Extensions = [...ext.keys()]; s.transferFeePct = feeBps / 100;
  s.permanentDelegate = ext.get("permanentDelegate")?.delegate ?? null; s.transferHook = ext.get("transferHook")?.programId ?? null;
  s.defaultFrozen = ext.get("defaultAccountState")?.accountState === "frozen"; s.pausable = ext.has("pausableConfig"); s.nonTransferable = ext.has("nonTransferable");
  if (s.permanentDelegate) add("permanent_delegate", 30, "Permanent delegate set: an outside wallet can move or burn anyone's tokens.");
  if (feeBps >= 1000) add("transfer_fee", 15, `Transfer fee of ${feeBps / 100}% on every transfer.`); else if (feeBps > 0) add("transfer_fee", 3, `Transfer fee of ${feeBps / 100}%.`);
  if (s.transferHook) add("transfer_hook", 10, "Transfer hook program can run custom code on every transfer (can block sells).");
  if (s.defaultFrozen || s.pausable || s.nonTransferable) add("transfer_control", 20, "Token can start frozen, be paused, or is non-transferable.");
  const meta = ext.get("tokenMetadata"); if (meta) s.metadataMutable = !!(meta.updateAuthority && meta.updateAuthority !== "11111111111111111111111111111111");
  // Dev wallet, insiders, organic trading, market (Jupiter)
  const a = jup?.audit ?? {};
  s.devHoldingPct = r2(a.devBalancePercentage); s.devLaunches = a.devMints ?? null; s.devGraduated = a.devMigrations ?? null;
  s.botHoldersPct = r2(a.botHoldersPercentage); s.isSus = a.isSus ?? null;
  if (s.devHoldingPct != null && Number(s.devHoldingPct) >= 20) add("dev_holding", 15, `Dev wallet still holds ${s.devHoldingPct}% of supply.`);
  s.organicScore = r2(jup?.organicScore, 1); s.organicLabel = jup?.organicScoreLabel ?? null; s.jupiterVerified = jup?.isVerified ?? null;
  const st = jup?.stats24h ?? {}, h1 = jup?.stats1h ?? {};
  Object.assign(s, { marketCapUsd: r2(jup?.mcap, 0), fdvUsd: r2(jup?.fdv, 0), liquidityToMcapPct: jup?.mcap > 0 && liquidityUsd != null ? r2((liquidityUsd / jup.mcap) * 100, 2) : null,
    volume24hUsd: r2((st.buyVolume ?? 0) + (st.sellVolume ?? 0), 0), buys24h: st.numBuys ?? null, sells24h: st.numSells ?? null, traders24h: st.numTraders ?? null, netBuyers24h: st.numNetBuyers ?? null,
    priceChange1hPct: r2(h1.priceChange), priceChange24hPct: r2(st.priceChange), holderChange24hPct: r2(st.holderChange), liquidityChange24hPct: r2(st.liquidityChange) });
  if (jup?.stats24h == null) unknown.push("24h trading stats");
  if (s.liquidityToMcapPct != null && Number(s.liquidityToMcapPct) < 2 && Number(s.marketCapUsd) > 50_000 && Number(s.marketCapUsd) < 50_000_000) add("liquidity_vs_mcap", 8, `Liquidity is only ${s.liquidityToMcapPct}% of market cap: price can collapse on modest selling.`);
  if (Number(st.liquidityChange) <= -50) add("liquidity_drop", 15, `Liquidity fell ${Math.abs(Number(st.liquidityChange)).toFixed(0)}% in 24h (liquidity-pull high-risk pattern).`);
  if (s.organicLabel === "low" && Number(s.volume24hUsd) > 10_000) add("inorganic_volume", 5, "Jupiter rates trading as low-organic (bot-like volume).");
  // Socials (Jupiter + DexScreener info)
  // If Jupiter has no links and DexScreener had no info, ask GeckoTerminal. Never call a coin link-less just because sources were down.
  let dsInfo = dsPairs.find((p) => p.info)?.info ?? null;
  const jupLinks = !!(jup && (jup.twitter || jup.website || jup.telegram || jup.discord));
  let gtAnswered = false;
  if (!jupLinks && !dsInfo && (o.jupFailed === true || mkt.dsAnswered !== true)) { const g = await geckoInfo(mint); if (g !== undefined) { gtAnswered = true; dsInfo = g; } }
  dsInfo = dsInfo ?? {};
  const socials = new Set<string>([...(jup?.twitter ? ["twitter"] : []), ...(jup?.website ? ["website"] : []), ...(jup?.telegram ? ["telegram"] : []), ...(jup?.discord ? ["discord"] : []),
    ...(dsInfo.socials ?? []).map((x: any) => String(x.type)), ...((dsInfo.websites ?? []).length ? ["website"] : [])]);
  s.socials = [...socials]; s.twitter = jup?.twitter ?? (dsInfo.socials ?? []).find((x: any) => x.type === "twitter")?.url ?? null; s.website = jup?.website ?? dsInfo.websites?.[0]?.url ?? null;
  const links = socialLinks(jup, dsInfo);
  const socialsKnown = links.length > 0 || socials.size > 0 || (o.jupFailed !== true && jup != null) || mkt.dsAnswered === true || gtAnswered;
  s.socialLinks = socialsKnown ? links : null;
  if (!socialsKnown) unknown.push("socials (link sources not available)");
  else if (!socials.size) add("no_socials", 5, "No website or social links listed.");
  // LP status: pump.fun bonding curve has no LP to pull; PumpSwap graduation burns LP by protocol design.
  const dexes = [...new Set(dsPairs.map((p) => p.dexId))];
  s.lpStatus = dexes.includes("pumpfun") && !dexes.includes("pumpswap") ? "pump.fun bonding curve (no LP tokens to pull)" : dexes.includes("pumpswap") ? "PumpSwap pool (pump.fun burns graduation LP by design)" : dexes.length ? "not verified" : null;
  // GoPlus (keyless): LP burn %, closable mint, balance-changing authority, mutable metadata
  const gp = await Promise.race([gpP, new Promise<"t">((r) => setTimeout(() => r("t"), Number(process.env.GOPLUS_SOL_WAIT_MS ?? 1200)).unref?.())]);
  if (gp === "t" || gp == null) unknown.push("LP burn / closable / balance authority (GoPlus not available)");
  else {
    Object.assign(s, { closable: gp.closable, balanceMutableAuthority: gp.balanceMutable, metadataMutable: s.metadataMutable === true || gp.metadataMutable,
      lpBurnPct: gp.pools.filter((p) => p.lpBurnPct != null).map((p) => ({ dex: p.dex, tvlUsd: Math.round(p.tvlUsd), burnPct: p.lpBurnPct })).slice(0, 5) });
    checks.push(...goplusChecks(gp));
  }
  // pump.fun launch: dev sold, snipers, same-slot bundles
  if (pump) {
    Object.assign(s, { devSoldPctOfBought: pump.devSoldPctOfBought, devSells: pump.devSells, sniperSupplyPct10s: pump.sniperSupplyPct10s ?? null, sniperWallets10s: pump.sniperWallets10s ?? null,
      bundledSupplyPctLaunchSlot: pump.bundledSupplyPctLaunchSlot ?? null, bundledWalletsLaunchSlot: pump.bundledWalletsLaunchSlot ?? null });
    if (Number(pump.devSoldPctOfBought) >= 90 && Number(pump.devSells) > 0) add("dev_sold", 10, `Dev sold ${pump.devSoldPctOfBought}% of what they bought.`);
    if (Number(pump.sniperSupplyPct10s) >= 25) add("snipers", 10, `Snipers bought ${pump.sniperSupplyPct10s}% of supply in the first 10 seconds.`);
    if (Number(pump.bundledSupplyPctLaunchSlot) >= 15) add("bundled", 12, `${pump.bundledWalletsLaunchSlot} wallets bought ${pump.bundledSupplyPctLaunchSlot}% in the launch block (bundle high-risk pattern).`);
    if (!pump.historyComplete) unknown.push("sniper/bundle share (too many trades to reach launch)");
    Object.assign(s, { firstMinute: pump.firstMinute ?? null, creatorFirstSellAfterSec: pump.creatorFirstSellAfterSec ?? null, sniperStillHoldPct: pump.sniperStillHoldPct ?? null, knownSnipersEarly: pump.knownSnipersEarly ?? null });
    const fm: any = pump.firstMinute;
    if (pump.creatorFirstSellAfterSec != null && Number(pump.creatorFirstSellAfterSec) <= 60) add("creator_fast_sell", 12, `Creator started selling ${pump.creatorFirstSellAfterSec} seconds after launch.`);
    if (fm && fm.sellSol > fm.buySol && fm.trades >= 5) add("first_minute_selling", 6, `More selling than buying in the first minute (${fm.sellSol} vs ${fm.buySol} SOL).`);
    if (fm && fm.buyers < 5 && fm.trades > 0) add("first_minute_thin", 4, `Only ${fm.buyers} buyers in the first minute.`);
    if (Number(pump.sniperStillHoldPct) >= 20) add("snipers_holding", 8, `Early snipers still hold ${pump.sniperStillHoldPct}% of supply (likely to sell into buyers).`);
    if (Number(pump.knownSnipersEarly) >= 3) add("known_snipers", 5, `${pump.knownSnipersEarly} repeat sniper wallets bought in the first minute.`);
  } else if (isPump) unknown.push("pump.fun trade history"); else s.launchAnalysis = "not a pump.fun launch";
  return { signals: s, checks, unknown, ms: Date.now() - t0 };
}

/** All creator-set social links (Jupiter + DexScreener), http(s) only, max 200 chars each, deduped, max 12. */
// GeckoTerminal token info in DexScreener "info" shape. undefined = no answer; 404 = answered, not listed (empty).
export async function geckoInfo(mint: string): Promise<{ socials: { type: string; url: string }[]; websites: { url: string }[] } | undefined> {
  try {
    const r = await fetch(`https://api.geckoterminal.com/api/v2/networks/solana/tokens/${mint}/info`, { signal: AbortSignal.timeout(1200), headers: { accept: "application/json" } });
    if (r.status === 404) return { socials: [], websites: [] };
    if (!r.ok) return undefined;
    const a = ((await r.json()) as any)?.data?.attributes ?? {};
    const h = (v: unknown) => (typeof v === "string" && /^[A-Za-z0-9_]{1,40}$/.test(v) ? v : null);
    const socials: { type: string; url: string }[] = [];
    if (h(a.twitter_handle)) socials.push({ type: "twitter", url: `https://x.com/${a.twitter_handle}` });
    if (h(a.telegram_handle)) socials.push({ type: "telegram", url: `https://t.me/${a.telegram_handle}` });
    if (typeof a.discord_url === "string") socials.push({ type: "discord", url: a.discord_url });
    return { socials, websites: (Array.isArray(a.websites) ? a.websites : []).filter((u: unknown) => typeof u === "string").map((url: string) => ({ url })) };
  } catch { return undefined; }
}
export function socialLinks(jup: any, dsInfo: any): { type: string; url: string }[] {
  const raw: { type: string; url: unknown }[] = [
    { type: "twitter", url: jup?.twitter }, { type: "website", url: jup?.website }, { type: "telegram", url: jup?.telegram }, { type: "discord", url: jup?.discord },
    ...(Array.isArray(dsInfo?.socials) ? dsInfo.socials : []).map((x: any) => ({ type: String(x?.type ?? "link"), url: x?.url })),
    ...(Array.isArray(dsInfo?.websites) ? dsInfo.websites : []).map((x: any) => ({ type: "website", url: x?.url })),
  ];
  const out: { type: string; url: string }[] = []; const seen = new Set<string>();
  for (const r of raw) {
    if (typeof r.url !== "string" || r.url.length > 200) continue;
    let u: URL; try { u = new URL(r.url.trim()); } catch { continue; }
    if (u.protocol !== "https:" && u.protocol !== "http:") continue;
    const key = u.href.replace(/\/$/, "").toLowerCase(); if (seen.has(key)) continue; seen.add(key);
    out.push({ type: r.type.replace(/[^a-z0-9_-]/gi, "").slice(0, 20).toLowerCase() || "link", url: u.href });
    if (out.length >= 12) break;
  }
  return out;
}

export function evmExtra(g: any, ds: any[] | null) {
  const on = (k: string) => (g?.[k] === "1" ? true : g?.[k] === "0" ? false : null);
  const p = ds?.[0]; const vol = ds?.reduce((a, x) => a + (x.volume?.h24 ?? 0), 0) ?? null; const liq = ds?.reduce((a, x) => a + (x.liquidity?.usd ?? 0), 0) ?? null;
  const tx = ds?.reduce((a, x) => ({ b: a.b + (x.txns?.h24?.buys ?? 0), s: a.s + (x.txns?.h24?.sells ?? 0) }), { b: 0, s: 0 });
  const info = ds?.find((x) => x.info)?.info ?? {};
  const lpLocked = (g?.lp_holders ?? []).reduce((a: number, h: any) => a + (h.is_locked === 1 || /^0x0+(dead)?$/i.test(h.address ?? "") ? Number(h.percent || 0) : 0), 0) * 100;
  return {
    honeypot: on("is_honeypot"), cannotSellAll: on("cannot_sell_all"), buyTaxPct: g?.buy_tax !== "" && g?.buy_tax != null ? r2(Number(g.buy_tax) * 100) : null, sellTaxPct: g?.sell_tax !== "" && g?.sell_tax != null ? r2(Number(g.sell_tax) * 100) : null,
    taxModifiable: on("slippage_modifiable"), personalTaxModifiable: on("personal_slippage_modifiable"), mintable: on("is_mintable"), ownerCanChangeBalance: on("owner_change_balance"),
    hiddenOwner: on("hidden_owner"), canTakeBackOwnership: on("can_take_back_ownership"), transferPausable: on("transfer_pausable"), blacklist: on("is_blacklisted"), whitelist: on("is_whitelisted"),
    antiWhale: on("is_anti_whale"), tradingCooldown: on("trading_cooldown"), selfDestruct: on("selfdestruct"), externalCall: on("external_call"), proxy: on("is_proxy"), openSource: on("is_open_source"),
    airdropScamPattern: on("is_airdrop_scam"), creatorHoldingPct: g?.creator_percent ? r2(Number(g.creator_percent) * 100) : null, ownerHoldingPct: g?.owner_percent ? r2(Number(g.owner_percent) * 100) : null,
    lpLockedOrBurnedPct: (g?.lp_holders ?? []).length ? r2(lpLocked, 1) : null, lpHolders: g?.lp_holder_count ? Number(g.lp_holder_count) : null, creatorEarlierHoneypots: g?.honeypot_with_same_creator != null ? Number(g.honeypot_with_same_creator) : null,
    cexListed: g?.is_in_cex?.listed === "1" || g?.is_in_cex === "1" || null,
    marketCapUsd: r2(p?.marketCap, 0), fdvUsd: r2(p?.fdv, 0), liquidityToMcapPct: p?.marketCap > 0 && liq != null ? r2((liq / p.marketCap) * 100) : null, volume24hUsd: r2(vol, 0),
    buys24h: tx?.b ?? null, sells24h: tx?.s ?? null, priceChange1hPct: r2(p?.priceChange?.h1), priceChange24hPct: r2(p?.priceChange?.h24),
    socials: [...new Set([...(info.socials ?? []).map((x: any) => String(x.type)), ...((info.websites ?? []).length ? ["website"] : [])])],
  };
}

/** One plain-English line a buyer can act on. Never calls anyone a scammer. */
export function buyerSummary(level: string, top: string[], confidence: string) {
  const head = level === "high" ? "High risk: multiple high-risk patterns. Many buyers would avoid this." : level === "medium" ? "Caution: some high-risk patterns. Size small if you buy." : "No major high-risk patterns found. Still only buy what you can afford to lose.";
  return `${head}${top.length ? ` Top concerns: ${top.slice(0, 3).join(" ")}` : ""}${confidence !== "high" ? ` (confidence ${confidence}: some data was unavailable.)` : ""}`;
}

/** Verified Oct 14 2026 on 5 Solana tokens vs RugCheck's free API (see docs/rugcheck-comparison.md). */
export const RUG_EDGE = "$0.02 per check: 45+ data points per token, including 16 signals RugCheck's free report doesn't show (dev-sold %, sniper and launch-bundle share, a live can-you-sell quote, the creator's past launches, volume vs market cap, bot-trading score), across 5 chains.";
/** Short form for x402 listings: the facilitator rejects payments whose resource.description exceeds 500 chars. */
export const RUG_EDGE_SHORT = "$0.02/check: 45+ data points, incl. 16 RugCheck's free report lacks (dev sold %, snipers, bundles, live sell test, creator history, volume vs mcap, bot score); 5 chains.";
