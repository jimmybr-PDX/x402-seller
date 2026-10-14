// Buyer-facing extra signals (free sources only): Jupiter token stats + sell quote, pump.fun public trades,
// mint-account token-2022 extensions, DexScreener socials. Every lookup is time-boxed; failures become unknowns.
const SOL = "So11111111111111111111111111111111111111112";
const UA = { "user-agent": "Mozilla/5.0 (RugRadar)", accept: "application/json" };
const j = (u: string, ms = 3500) => fetch(u, { headers: UA, signal: AbortSignal.timeout(ms) }).then((r) => (r.ok ? r.json() : null)).catch(() => null) as Promise<any>;
const r2 = (n: number | null | undefined, d = 2) => (n == null || !isFinite(Number(n)) ? null : +Number(n).toFixed(d));
export type Extra = { signals: Record<string, unknown>; checks: { check: string; points: number; detail: string }[]; unknown: string[]; ms: number };

/** pump.fun public trade history (newest first, 100/page). Reaches launch only for young tokens (<= 400 trades). */
export async function pumpLaunch(mint: string, dev: string | null, supply: number) {
  const trades: any[] = []; let cursor = ""; let complete = false;
  for (let p = 0; p < 4; p++) {
    const d = await j(`https://swap-api.pump.fun/v2/coins/${mint}/trades?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, 3000);
    if (!d?.trades) return null;
    trades.push(...d.trades);
    if (!d.pagination?.hasMore) { complete = true; break; }
    cursor = d.pagination.nextCursor;
  }
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
  }
  return out;
}

export async function solanaExtra(mint: string, o: { jup: any; mintInfo: any; dsPairs: any[]; supply: number; decimals: number | null; liquidityUsd: number | null }): Promise<Extra> {
  const t0 = Date.now(); const { jup } = o; const unknown: string[] = []; const checks: Extra["checks"] = [];
  const add = (check: string, points: number, detail: string) => checks.push({ check, points, detail });
  const isPump = /pump/i.test(jup?.launchpad ?? "") || mint.endsWith("pump");
  // Sell check: ask Jupiter for a sell quote of ~$100 worth (or 0.1% of supply).
  const price = Number(jup?.usdPrice ?? 0);
  const units = price > 0 ? Math.floor((100 / price) * 10 ** (o.decimals ?? 0)) : Math.floor(o.supply * 0.001 * 10 ** (o.decimals ?? 0));
  const [quote, pump] = await Promise.all([
    units > 0 && mint !== SOL ? fetch(`https://lite-api.jup.ag/swap/v1/quote?inputMint=${mint}&outputMint=${SOL}&amount=${units}&slippageBps=1000`, { headers: UA, signal: AbortSignal.timeout(3500) }).then((r) => r.json()).catch(() => null) : Promise.resolve(null),
    isPump ? pumpLaunch(mint, jup?.dev ?? null, o.supply).catch(() => null) : Promise.resolve(null),
  ]);
  const s: Record<string, unknown> = {};
  // Sell route (honeypot pattern on Solana = no route out, or a huge impact)
  if (quote?.outAmount) { s.sellRoute = true; s.sellPriceImpactPct = r2(Number(quote.priceImpactPct) * 100, 2); s.sellTestUsd = price > 0 ? 100 : null; s.sellVia = [...new Set((quote.routePlan ?? []).map((x: any) => x.swapInfo?.label).filter(Boolean))].slice(0, 3); }
  else if (/ROUTE|NOT_TRADABLE/i.test(String(quote?.errorCode ?? quote?.error ?? "")) && (o.liquidityUsd ?? 0) > 1000) { s.sellRoute = false; add("sell_route", 30, "No sell route found despite listed liquidity (honeypot high-risk pattern)."); }
  else unknown.push("sell route");
  if (Number(s.sellPriceImpactPct) > 20) add("sell_impact", 10, `Selling ~$100 moves the price ${s.sellPriceImpactPct}%: very thin exit.`);
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
  Object.assign(s, { marketCapUsd: r2(jup?.mcap, 0), fdvUsd: r2(jup?.fdv, 0), liquidityToMcapPct: jup?.mcap > 0 && o.liquidityUsd != null ? r2((o.liquidityUsd / jup.mcap) * 100, 2) : null,
    volume24hUsd: r2((st.buyVolume ?? 0) + (st.sellVolume ?? 0), 0), buys24h: st.numBuys ?? null, sells24h: st.numSells ?? null, traders24h: st.numTraders ?? null, netBuyers24h: st.numNetBuyers ?? null,
    priceChange1hPct: r2(h1.priceChange), priceChange24hPct: r2(st.priceChange), holderChange24hPct: r2(st.holderChange), liquidityChange24hPct: r2(st.liquidityChange) });
  if (jup?.stats24h == null) unknown.push("24h trading stats");
  if (s.liquidityToMcapPct != null && Number(s.liquidityToMcapPct) < 2 && Number(s.marketCapUsd) > 50_000 && Number(s.marketCapUsd) < 50_000_000) add("liquidity_vs_mcap", 8, `Liquidity is only ${s.liquidityToMcapPct}% of market cap: price can collapse on modest selling.`);
  if (Number(st.liquidityChange) <= -50) add("liquidity_drop", 15, `Liquidity fell ${Math.abs(Number(st.liquidityChange)).toFixed(0)}% in 24h (liquidity-pull high-risk pattern).`);
  if (s.organicLabel === "low" && Number(s.volume24hUsd) > 10_000) add("inorganic_volume", 5, "Jupiter rates trading as low-organic (bot-like volume).");
  // Socials (Jupiter + DexScreener info)
  const dsInfo = o.dsPairs.find((p) => p.info)?.info ?? {};
  const socials = new Set<string>([...(jup?.twitter ? ["twitter"] : []), ...(jup?.website ? ["website"] : []), ...(jup?.telegram ? ["telegram"] : []), ...(jup?.discord ? ["discord"] : []),
    ...(dsInfo.socials ?? []).map((x: any) => String(x.type)), ...((dsInfo.websites ?? []).length ? ["website"] : [])]);
  s.socials = [...socials]; s.twitter = jup?.twitter ?? (dsInfo.socials ?? []).find((x: any) => x.type === "twitter")?.url ?? null; s.website = jup?.website ?? dsInfo.websites?.[0]?.url ?? null;
  if (!socials.size) add("no_socials", 5, "No website or social links listed.");
  // LP status: pump.fun bonding curve has no LP to pull; PumpSwap graduation burns LP by protocol design.
  const dexes = [...new Set(o.dsPairs.map((p) => p.dexId))];
  s.lpStatus = dexes.includes("pumpfun") && !dexes.includes("pumpswap") ? "pump.fun bonding curve (no LP tokens to pull)" : dexes.includes("pumpswap") ? "PumpSwap pool (pump.fun burns graduation LP by design)" : dexes.length ? "not verified" : null;
  // pump.fun launch: dev sold, snipers, same-slot bundles
  if (pump) {
    Object.assign(s, { devSoldPctOfBought: pump.devSoldPctOfBought, devSells: pump.devSells, sniperSupplyPct10s: pump.sniperSupplyPct10s ?? null, sniperWallets10s: pump.sniperWallets10s ?? null,
      bundledSupplyPctLaunchSlot: pump.bundledSupplyPctLaunchSlot ?? null, bundledWalletsLaunchSlot: pump.bundledWalletsLaunchSlot ?? null });
    if (Number(pump.devSoldPctOfBought) >= 90 && Number(pump.devSells) > 0) add("dev_sold", 10, `Dev sold ${pump.devSoldPctOfBought}% of what they bought.`);
    if (Number(pump.sniperSupplyPct10s) >= 25) add("snipers", 10, `Snipers bought ${pump.sniperSupplyPct10s}% of supply in the first 10 seconds.`);
    if (Number(pump.bundledSupplyPctLaunchSlot) >= 15) add("bundled", 12, `${pump.bundledWalletsLaunchSlot} wallets bought ${pump.bundledSupplyPctLaunchSlot}% in the launch block (bundle high-risk pattern).`);
    if (!pump.historyComplete) unknown.push("sniper/bundle share (too many trades to reach launch)");
  } else if (isPump) unknown.push("pump.fun trade history"); else s.launchAnalysis = "not a pump.fun launch";
  return { signals: s, checks, unknown, ms: Date.now() - t0 };
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
export const RUG_EDGE = "$0.01 per check: 45+ data points per token, including 16 signals RugCheck's free report doesn't show (dev-sold %, sniper and launch-bundle share, a live can-you-sell quote, the creator's past launches, volume vs market cap, bot-trading score), across 5 chains.";
