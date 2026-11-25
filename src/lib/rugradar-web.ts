import { countRugradar, countRugradarRejected } from "./rugradar-counts.js";
/**
 * RugRadar web surface: branded landing page with a free web checker (1 free limited check per visitor, limited by IP
 * and cookie), an embeddable result card (/rugradar/embed), sitemap.xml, and an MCP server (streamable HTTP, JSON responses) at /mcp.
 * Page copy shows danger warnings only, in plain words; it never names how a warning was found.
 */
import { RugBusyError } from "./rug.js";
import { LIVE_JS } from "./rugradar-live.js";
import { CLEAN_JS } from "./token-name.js";
import type { Recent } from "./rugradar-recent.js";
import { challenge, verifyChallenge, sessionWallet, isEvmAddr, isSolAddr, type WalletHistory } from "./wallet-history.js";
import { shareData, primeShare, sharePng, cachedShare, shortAddr, noSafe, marketFactLine } from "./rugradar-share.js";
import { tensionFor } from "./tension.js";
import { swapClientJs, type SwapCfg } from "./swap.js";
import type { Express, Request, Response } from "express";
import { randomBytes, createHash } from "node:crypto";
const LIVE_V = createHash("sha1").update(LIVE_JS).digest("hex").slice(0, 8); // cache-buster: the paid-report script reloads whenever it changes

export type WebDeps = {
  publicUrl: string; port: number; priceUsd: string; speed: { creditS: number; paidS: number; x: number } | null;
  rugCheck: (t: string, chain: string) => Promise<any>;
  /** Paid-path check with the live-report blocks (MCP credit-key calls); defaults to rugCheck. */
  paidCheck?: (t: string, chain: string) => Promise<any>;
  spend: (k: string) => Promise<number | null>; refund: (k: string) => Promise<void>;
  /** RugRadar Watch + Alert (optional): create a watch paid with credits; config for prices/destinations. */
  watch?: { create: (key: string, args: any) => Promise<any>; config: () => any; list?: (key: string) => Promise<any>; cancel?: (key: string, id: string) => Promise<any> };
  /** Private wallet history (paid x402 checks + connected-wallet free checks). Never listed publicly. */
  wallets?: WalletHistory;
  /** Jupiter "Buy this token" button; off unless swapConfig() says enabled. */
  swap?: SwapCfg;
  /** Optional chain detector for 0x addresses (tests inject one; default asks DexScreener). */
  detectChain?: (token: string) => Promise<string>;
  /** Recent full reports per credit key (optional) and the key check it needs (balance is null for an unknown key). */
  recent?: Recent; balance?: (k: string) => Promise<number | null>;
  /** Display prices for the research MCP tools; must match the HTTP x402 routes. Defaults match server.ts. */
  researchPrices?: { report: string; read: string; news: string; price: string };
};
export const FREE_PER_VISITOR = 1;
/** Launch promo: the one free daily check returns the full report until this time (env RUGRADAR_FULL_FREE_UNTIL overrides; default Nov 12 2026 00:00 PT = 14 days). Then it reverts to the basic free check on its own. */
const FULL_FREE_UNTIL = Date.parse(process.env.RUGRADAR_FULL_FREE_UNTIL || "2026-11-12T00:00:00-08:00");
export const fullFreeActive = () => Date.now() < FULL_FREE_UNTIL;
export const FREE_COPY_PROMO = "1 free full report every day per visitor for a limited time, then a basic free check plus credits for the full report.";
export const FREE_COPY = "1 free limited check every day per visitor, then credits for the full report.";
const LIMITED_CHECKS = new Set(["mint_authority", "freeze_authority", "mint_function", "holders", "liquidity", "age", "dead_token", "sell_route", "sell_impact", "honeypot", "tax", "heavy_selling", "thin_trading", "liquidity_vs_mcap"]);
export const LOCKED_SIGNALS = ["exact dev-sold %", "sniper share", "launch-bundle share", "can-you-sell quote with price impact", "creator's past launches", "organic/bot score", "full buyer summary"];
export const UNLOCK_CREDITS = 10;
/** Conversion offer shown after a free check (or when it is used up). Points only at the existing credits flow and x402 paths. */
export function unlockOffer(publicUrl: string, priceUsd: string) {
  const usd = (UNLOCK_CREDITS * Number(priceUsd)).toFixed(2);
  return { credits: UNLOCK_CREDITS, priceUsd: usd, label: `Unlock full report \u2014 ${UNLOCK_CREDITS} credits for $${usd}`, buy: `${publicUrl}/credits/buy?credits=${UNLOCK_CREDITS}`, useKey: "Paste the key in the Credit key box (or send header X-RugRadar-Key) and check again.", agents: `Agents: pay $${priceUsd} per call via x402 at ${publicUrl}/rug-check, or send X-RugRadar-Key.` };
}
/**
 * Free web check: basic score from mint/freeze authority, top-holder concentration, age, liquidity and the dead-token
 * rule (no liquidity, no way to sell, 7d+ old -> high, as in the full report). Paid paths never call this.
 */
export function limitedReport(full: any) {
  const f = full?.facts ?? {};
  const all = Array.isArray(full?.checks) ? full.checks : [];
  const PUBLIC = new Set(["sell_route", "sell_impact", "honeypot", "tax"]);
  const basic = all.filter((c: any) => LIMITED_CHECKS.has(c?.check) && c?.check !== "dead_token").map((c: any) => ({ check: c.check, points: Number(c.points) || 0, detail: PUBLIC.has(c.check) && WARN[c.check] ? WARN[c.check][1] : c.detail }));
  const sum = basic.reduce((a: number, c: any) => a + c.points, 0);
  const dead = all.find((c: any) => c?.check === "dead_token");
  const scored = dead ? [{ check: "dead_token", points: Math.max(5, 60 - sum), detail: dead.detail }, ...basic] : basic;
  const score = Math.min(100, scored.reduce((a: number, c: any) => a + c.points, 0));
  // Shown on the free result but not counted in the basic score: a creator's earlier honeypot tokens (EVM chains).
  const showOnly = full?.chain !== "solana" ? all.filter((c: any) => c?.check === "deployer_history" && Number(c.points) > 0).map((c: any) => ({ check: c.check, points: Number(c.points) || 0, detail: "Creator deployed earlier honeypot tokens.", shownOnly: true })) : [];
  const checks = [...scored, ...showOnly];
  const level = score >= 50 ? "high" : score >= 25 ? "medium" : "low";
  const pick = (k: string) => (f[k] === undefined ? null : f[k]);
  const links = full?.buyer?.socialLinks;
  return {
    product: "RugRadar", report: "limited", chain: full?.chain ?? null, token: full?.token ?? null, riskScore: score, riskLevel: level, scoring: "basic score (mint/freeze authority, top holders, age, liquidity, dead token, sell warnings)",
    verdict: level === "high" ? "Multiple high-risk patterns found." : level === "medium" ? "Some high-risk patterns found." : "No major high-risk patterns found in the basic checks.",
    reasons: checks.filter((c: any) => c.points > 0).map((c: any) => c.detail), checks,
    moreWarnings: Math.max(0, warningsOf(checks).length - 3) + all.filter((c: any) => c && !LIMITED_CHECKS.has(c.check) && !(c.check === "deployer_history" && full?.chain !== "solana") && Number(c.points) > 0 && WARN[c.check]).length,
    lockedTeaser: lockedTeaser(Math.max(0, warningsOf(checks).length - 3) + all.filter((c: any) => c && !LIMITED_CHECKS.has(c.check) && !(c.check === "deployer_history" && full?.chain !== "solana") && Number(c.points) > 0 && WARN[c.check]).length),
    hiddenWarnings: all.filter((c: any) => c && !LIMITED_CHECKS.has(c.check) && !(c.check === "deployer_history" && full?.chain !== "solana") && Number(c.points) > 0 && WARN[c.check]).length,
    socialLinks: Array.isArray(links) ? links : null, freeFacts: freeFacts(full), tensionLine: tensionFor(full, Date.now(), { hideCreatorHistory: full?.chain === "solana" }), warnDetails: warnDetails(full),
    facts: { tokenName: pick("tokenName"), tokenSymbol: pick("tokenSymbol"), tokenImage: pick("tokenImage"), mintAuthority: pick("mintAuthority"), freezeAuthority: pick("freezeAuthority"), top1Pct: pick("top1Pct"), top10Pct: pick("top10Pct"), holderCount: pick("holderCount"), ageHours: pick("ageHours"), liquidityUsd: pick("liquidityUsd"), marketUnknown: pick("marketUnknown"), volume24hUsd: pick("volume24hUsd"), buys24h: pick("buys24h"), sells24h: pick("sells24h"), priceChange24hPct: pick("priceChange24hPct") },
    lockedSignals: LOCKED_SIGNALS, unlock: "Credits unlock the full report (paste a credit key above, or send X-RugRadar-Key).",
    generatedAt: full?.generatedAt ?? new Date().toISOString(),
  };
}
/** Basic free result teaser: only the count of warnings left out, never their text. */
export const lockedTeaser = (n: number) => `${n > 0 ? `${n} more warning${n > 1 ? "s" : ""} in the full report` : "Full report"}, includes live chart and can-you-sell`;
/** One plain line RugCheck users expect on a Solana free check: mint authority and main-pool LP burn (from data the check already has). */
export function freeFacts(full: any): string[] {
  const f = full?.facts ?? {}, out: string[] = [];
  if (full?.chain === "solana") {
    if ("mintAuthority" in f) out.push(`Mint authority: ${f.mintAuthority ? "still on" : "off"}`);
    const lp = Array.isArray(full?.buyer?.lpBurnPct) ? full.buyer.lpBurnPct.filter((x: any) => x && typeof x.burnPct === "number" && isFinite(x.burnPct)) : [];
    if (lp.length) { const top = lp.reduce((a: any, b: any) => (Number(b.tvlUsd) > Number(a.tvlUsd) ? b : a)); out.push(`Liquidity: ${Math.round(Math.max(0, Math.min(100, top.burnPct)))}% burned`); }
  }
  const m = marketFactLine(f); if (m) out.push(m);
  return out;
}
const FREE_DAILY_CAP = Number(process.env.RUGRADAR_FREE_DAILY_CAP ?? 500);

/**
 * Plain danger-warning copy per check: [one-line title, one short line]. Titles say what the danger is, never how it
 * was found. Only checks listed here are ever shown; others (e.g. creator history) still count in the score but never appear.
 */
export const WARN: Record<string, [string, string]> = {
  dead_token: ["Dead token: no way to sell", "No liquidity left and no sell route."],
  mint_authority: ["Creator can mint more", "More tokens can appear anytime, diluting holders."],
  mint_function: ["Owner can mint more", "More tokens can appear anytime, diluting holders."],
  freeze_authority: ["Creator can freeze tokens", "Your tokens could be frozen so you can't sell."],
  holders: ["A few wallets hold most coins", "Big holders could dump on the price."],
  liquidity: ["Thin liquidity", "A sale could move the price a lot."],
  age: ["Very new token", "Many rugs happen in the first days."],
  sell_route: ["You may not be able to sell", "No way to sell this token was found."],
  sell_impact: ["Selling moves the price a lot", "A ~$100 sale moves the price over 20%."],
  honeypot: ["Holders can't sell (honeypot)", "Selling looks blocked for holders."],
  tax: ["High buy/sell tax", "A big cut is taken on each trade."],
  owner_control: ["Owner can pause or blacklist", "The owner can block or change trading."],
  unverified: ["Contract code not verified", "Nobody can read what the contract does."],
  proxy: ["Contract code can change", "The owner can swap in new code."],
  lp_unlocked: ["Liquidity can be pulled", "Most pool liquidity is not locked or burned."],
  permanent_delegate: ["Outside wallet can take tokens", "Another wallet can move or burn your tokens."],
  balance_mutable: ["Balances can be changed", "An authority can take or burn anyone's tokens."],
  closable: ["Token can be shut down", "An authority can close the token."],
  transfer_fee: ["Fee on every transfer", "Each transfer pays a fee."],
  transfer_hook: ["Transfers run custom code", "Custom code could block sells."],
  transfer_control: ["Token can be frozen or paused", "Transfers can be stopped."],
  metadata_mutable: ["Name and image can change", "The token's look can be swapped later."],
  dev_holding: ["Dev still holds a lot", "The creator could dump a big bag."],
  dev_sold: ["Dev sold most coins", "The creator sold most of what they bought."],
  creator_fast_sell: ["Dev sold right after launch", "The creator started selling within a minute."],
  snipers: ["Early buyers grabbed supply", "Fast buyers took a big share at launch."],
  snipers_holding: ["Early buyers still hold a lot", "They could sell into new buyers."],
  known_snipers: ["Repeat fast buyers got in early", "Wallets that flip launches bought early."],
  bundled: ["Launch was bundled", "A few wallets bought a big share in the first block."],
  first_minute_selling: ["Heavy selling at launch", "More selling than buying in minute one."],
  first_minute_thin: ["Few buyers at launch", "Very few wallets bought in minute one."],
  liquidity_vs_mcap: ["Liquidity tiny vs market cap", "The price is easy to crash."],
  liquidity_drop: ["Liquidity dropped fast", "Much of the pool left in 24 h."],
  inorganic_volume: ["Trading looks fake", "Volume looks bot-driven."],
  no_socials: ["No website or socials", "The creator listed no links."],
  heavy_selling: ["Heavy selling", "Far more sells than buys in 24 hours."],
  thin_trading: ["Thin trading", "24-hour volume is thin relative to the token's size."],
};
/** Short noun phrases for the result headline ("Thin liquidity, heavy selling, and ..."). Falls back to the card title. */
export const HEAD: Record<string, string> = {
  dead_token: "no way to sell", mint_authority: "creator can mint more", mint_function: "owner can mint more", freeze_authority: "creator can freeze tokens",
  holders: "a few wallets hold most coins", liquidity: "thin liquidity", age: "very new token", sell_route: "no sell route", sell_impact: "big price impact on sells",
  honeypot: "selling looks blocked", tax: "high trade tax", owner_control: "owner can pause or blacklist", unverified: "unverified contract", proxy: "contract code can change",
  lp_unlocked: "liquidity can be pulled", dev_holding: "dev holds a lot", dev_sold: "dev sold most coins", heavy_selling: "heavy selling", thin_trading: "thin trading",
  liquidity_vs_mcap: "liquidity tiny vs market cap", liquidity_drop: "liquidity dropped fast", deployer_history: "creator's earlier tokens went bad", no_socials: "no website or socials",
};
const nfmt = (v: unknown) => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
const kusd = (n: number) => (n >= 1e6 ? `$${(n / 1e6).toFixed(1).replace(/\.0$/, "")}M` : n >= 1000 ? `$${(n / 1000).toFixed(1).replace(/\.0$/, "")}k` : `$${Math.round(n)}`);
/** Card [title, line] with real numbers for the market and creator warnings. Danger wording only; never names how it was found. */
export function warnDetails(full: any): Record<string, [string, string]> {
  const out: Record<string, [string, string]> = {}, f = full?.facts ?? {}, b = (f.buyer && typeof f.buyer === "object" ? f.buyer : null) ?? (full?.buyer && typeof full.buyer === "object" ? full.buyer : {}) ?? {};
  const on = new Set((Array.isArray(full?.checks) ? full.checks : []).filter((c: any) => c && Number(c.points) > 0).map((c: any) => c.check));
  const vol = nfmt(f.volume24hUsd), buys = nfmt(f.buys24h), sells = nfmt(f.sells24h), mcap = nfmt(f.marketCapUsd) ?? nfmt(b.marketCapUsd), liq = nfmt(f.liquidityUsd);
  if (on.has("heavy_selling") && sells != null) { const x = sells / Math.max(1, buys ?? 0); out.heavy_selling = [`Heavy selling: ${x >= 10 ? Math.round(x) : x.toFixed(1)} sells per buy (24h)`, `${sells.toLocaleString("en-US")} sells vs ${(buys ?? 0).toLocaleString("en-US")} buys in 24 hours.`]; }
  if (on.has("thin_trading") && vol != null) out.thin_trading = [`Thin trading: ${kusd(vol)} volume in 24h`, "24-hour volume is thin relative to the token's size."];
  if (on.has("liquidity_vs_mcap") && mcap != null && liq != null && mcap > 0) out.liquidity_vs_mcap = ["Liquidity tiny vs market cap", `Liquidity is ${kusd(liq)}, ${((liq / mcap) * 100).toFixed(2)}% of a ${kusd(mcap)} market cap.`];
  if (on.has("deployer_history")) {
    const hp = full?.chain !== "solana" ? nfmt(b.creatorEarlierHoneypots) : null;
    if (hp != null && hp > 0) out.deployer_history = ["Creator made earlier honeypot coins", `This creator deployed ${hp} earlier honeypot token${hp === 1 ? "" : "s"}.`];
  }
  return out;
}
/** Warnings to show (points > 0), worst first, one card per title. */
export function warningsOf(checks: any, det?: Record<string, [string, string]> | null): { sev: "DANGER" | "CAUTION"; title: string; line: string; points: number }[] {
  const seen = new Set<string>(), out: any[] = [];
  for (const c of (Array.isArray(checks) ? checks : []).filter((x: any) => x && Number(x.points) > 0 && (WARN[x.check] || det?.[x.check])).sort((a: any, b: any) => b.points - a.points)) {
    const w = det?.[c.check] ?? WARN[c.check]!; if (seen.has(w[0])) continue; seen.add(w[0]);
    out.push({ sev: Number(c.points) >= 15 ? "DANGER" : "CAUTION", title: w[0], line: w[1], points: Number(c.points) });
  }
  return out;
}
/** Level shown on the ring: never LOW RISK while a warning is shown (danger -> HIGH RISK, caution -> CAUTION). */
export function shownLevel(level: string, ws: { sev: string }[]): "low" | "medium" | "high" {
  const l = level === "high" || level === "medium" || level === "low" ? level : "medium";
  if (l !== "low" || !ws.length) return l;
  return ws.some((w) => w.sev === "DANGER") ? "high" : "medium";
}
const DS_CHAIN: Record<string, string> = { base: "base", bsc: "bnb", ethereum: "ethereum", arbitrum: "arbitrum" };
const chainCache = new Map<string, { at: number; c: string }>();
/** 0x address -> the supported EVM chain with the most DexScreener liquidity (default base). Cached 1 h, 2.5 s budget. */
export async function detectEvmChain(token: string): Promise<string> {
  const k = token.toLowerCase(), hit = chainCache.get(k);
  if (hit && Date.now() - hit.at < 3600_000) return hit.c;
  let best = "base", liq = -1;
  try {
    const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${token}`, { headers: { accept: "application/json", "user-agent": "Mozilla/5.0 (RugRadar)" }, signal: AbortSignal.timeout(2500) });
    const j: any = r.ok ? await r.json() : null;
    for (const p of Array.isArray(j?.pairs) ? j.pairs : []) { const c = DS_CHAIN[p?.chainId]; const l = Number(p?.liquidity?.usd) || 0; if (c && l > liq) { best = c; liq = l; } }
  } catch {}
  chainCache.set(k, { at: Date.now(), c: best }); if (chainCache.size > 500) chainCache.delete(chainCache.keys().next().value!);
  return best;
}

// ---------- free-check limiter (in memory; resets daily and on deploy) ----------
const byIp = new Map<string, number>(), byCookie = new Map<string, number>(), lastAt = new Map<string, number>();
let day = "", dayTotal = 0;
export function freeAllowance(ip: string, vid: string, now = Date.now()): { ok: boolean; left: number; reason?: string } {
  const d = new Date(now).toISOString().slice(0, 10);
  if (d !== day) { day = d; dayTotal = 0; byIp.clear(); byCookie.clear(); lastAt.clear(); }
  if (now - (lastAt.get(ip) ?? 0) < 2500) return { ok: false, left: -1, reason: "slow_down" };
  const used = Math.max(byIp.get(ip) ?? 0, byCookie.get(vid) ?? 0);
  if (used >= FREE_PER_VISITOR) return { ok: false, left: 0, reason: "free_checks_used" };
  if (dayTotal >= FREE_DAILY_CAP) return { ok: false, left: 0, reason: "daily_free_cap" };
  return { ok: true, left: FREE_PER_VISITOR - used - 1 };
}
export function useFree(ip: string, vid: string, now = Date.now()) {
  byIp.set(ip, (byIp.get(ip) ?? 0) + 1); byCookie.set(vid, (byCookie.get(vid) ?? 0) + 1); lastAt.set(ip, now); dayTotal++;
}
export function refundFree(ip: string, vid: string) { byIp.set(ip, Math.max(0, (byIp.get(ip) ?? 1) - 1)); byCookie.set(vid, Math.max(0, (byCookie.get(vid) ?? 1) - 1)); dayTotal = Math.max(0, dayTotal - 1); }
export function __resetFree() { day = ""; }

const cookieVid = (req: Request) => /(?:^|;\s*)rr_vid=([A-Za-z0-9_-]{16,40})/.exec(req.header("cookie") ?? "")?.[1] ?? null;
const ipOf = (req: Request) => req.ip || req.socket.remoteAddress || "unknown";
const validToken = (t: string, chain: string) => (chain === "solana" ? /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(t) : /^0x[0-9a-fA-F]{40}$/.test(t));
const CHAINS = ["solana", "base", "bnb", "ethereum", "arbitrum"];
const CHAIN_NAME: Record<string, string> = { solana: "Solana", base: "Base", bnb: "BNB", ethereum: "Ethereum", arbitrum: "Arbitrum" };


// ---------- styles (v5 design) ----------
const CSS_BASE = `:root{--bg:#0B1020;--card:#131A2E;--line:#232C47;--tx:#EEF2F8;--mut:#9AA4B8;--acc:#38BDF8;--ok:#4ade80;--warn:#F59E0B;--bad:#EF4444}
*{box-sizing:border-box}a{color:var(--acc);text-decoration:none}
.verdict{display:flex;gap:16px;align-items:center;padding:16px;border-radius:16px}
.v-high{background:linear-gradient(135deg,rgba(239,68,68,.32),rgba(239,68,68,.12));border:2px solid var(--bad)}
.v-medium{background:linear-gradient(135deg,rgba(245,158,11,.30),rgba(245,158,11,.10));border:2px solid var(--warn)}
.v-low{background:linear-gradient(135deg,rgba(58,70,112,.34),rgba(58,70,112,.14));border:2px solid #3a4670}
.gauge{--p:0;--c:var(--bad);width:120px;height:120px;border-radius:50%;flex:none;background:conic-gradient(var(--c) calc(var(--p)*1%),rgba(255,255,255,.12) 0);display:grid;place-items:center;box-shadow:0 0 18px color-mix(in srgb,var(--c) 45%,transparent)}
.gauge i{width:88px;height:88px;border-radius:50%;background:#0f1526;display:grid;place-items:center;font-style:normal;font-weight:900;font-size:36px;line-height:1;color:#fff}
.gauge i small{display:block;font-size:11px;font-weight:600;color:var(--mut);text-align:center}
.g-high{--c:var(--bad)}.g-medium{--c:var(--warn)}.g-low{--c:#3a4670;box-shadow:none}.g-low i{color:#c9d1e0}.g-wait{--c:#3a4670;box-shadow:none}
.verdict{flex-wrap:wrap}.vfree{flex-basis:100%;font-size:13px;font-weight:700;color:#fff;background:rgba(0,0,0,.35);border-radius:8px;padding:6px 10px;margin-top:-4px}
.vt{font-size:21px;font-weight:900;line-height:1.15}.vt.high{color:#ff6b6b}.vt.medium{color:#fbbf24}.vt.low{color:#EEF2F8}.vtx{flex:1 1 220px;min-width:0}.vtl{font-size:17px;font-weight:700;margin-top:8px;color:#fff;line-height:1.35}.quiet.det .sub .wcards{margin-top:6px}.sec-title{font-size:13px;color:var(--mut);margin:12px 0 6px;letter-spacing:.04em;text-transform:uppercase}.vl{font-size:16px;margin-top:4px}.vtrust{font-size:12px;color:var(--mut);margin-top:6px}
.wcards{display:grid;gap:8px;margin:10px 0 6px}
.wc{border-radius:12px;border:1px solid var(--line);background:#0F1628}.wc.d{border-left:5px solid var(--bad)}.wc.c{border-left:5px solid var(--warn)}
.wc summary{display:flex;gap:10px;align-items:center;padding:12px;list-style:none;cursor:pointer;font-weight:700;font-size:16px;color:#fff}.wc summary::-webkit-details-marker{display:none}
.wc summary .tt{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
.wc summary .ch{margin-left:auto;color:var(--mut);font-weight:400}.wc summary .ch::before{content:"\\25BE"}.wc[open] summary .ch::before{content:"\\25B4"}
.sev{flex:none;font-size:11px;font-weight:900;border-radius:6px;padding:3px 7px;letter-spacing:.4px}.s3{background:var(--bad);color:#fff}.s2{background:var(--warn);color:#1b1200}
.wc p{margin:0;padding:0 12px 12px;font-size:14px;color:#c9d1e0;white-space:normal}.wc p a{font-weight:700}
.ffl{font-size:14px;color:#c9d1e0;margin:2px 0 6px}`;
const CSS_PAGE = `body{margin:0;background:var(--bg);color:var(--tx);font:17px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
@media(min-width:900px){body{font-size:16px}}
.wrap{max-width:1120px;margin:0 auto;padding:0 16px}
header{display:flex;align-items:center;justify-content:space-between;padding:12px 0}
.logo{display:flex;gap:8px;align-items:center;font-weight:800;font-size:19px;color:var(--tx)}.logo img{border-radius:50%}
.pill{border:1px solid var(--line);border-radius:999px;padding:6px 12px;font-size:14px;color:var(--tx)}
.hero h1{font-size:26px;line-height:1.15;margin:6px 0 4px}.hero p{margin:0 0 12px;color:var(--mut);font-size:15px}
.search{display:flex;gap:8px;flex-wrap:wrap}.search input{flex:1 1 260px;min-width:0;background:#0E1528;border:2px solid var(--acc);color:var(--tx);border-radius:12px;padding:14px;font-size:16px}
.search input::placeholder{color:#7d88a0}.tw{position:relative;flex:1 1 260px;display:flex;min-width:0}.tw input{flex:1;padding-right:44px}.clr{position:absolute;right:4px;top:50%;transform:translateY(-50%);background:0;border:0;color:var(--mut);font-size:24px;line-height:1;padding:8px 12px;cursor:pointer}
.btn{display:inline-block;border:0;border-radius:12px;padding:14px 18px;font-weight:700;font-size:16px;cursor:pointer;text-align:center}.pri{background:var(--acc);color:#04121d}.go{background:#22C55E;color:#04150a;width:100%}.ghost{background:transparent;border:1px solid var(--line);color:var(--tx)}.btn:disabled{opacity:.6;cursor:not-allowed}
.subrow{display:flex;gap:10px;align-items:center;margin:8px 0 6px;flex-wrap:wrap}
.chainchip{appearance:none;-webkit-appearance:none;background:transparent;border:1px solid var(--acc);border-radius:999px;padding:3px 10px;font-size:13px;color:var(--tx);cursor:pointer}
.chainchip option{background:var(--card)}.trust{font-size:13px;color:var(--mut)}
.keyd{font-size:12px;margin:0 0 8px}.keyd summary{cursor:pointer;display:inline;list-style:none;color:var(--acc);text-decoration:underline}.keyd summary::-webkit-details-marker{display:none}.keyd input{width:100%;max-width:420px;margin-top:6px;background:#0E1528;border:1px solid var(--line);color:var(--tx);border-radius:10px;padding:10px;font-size:15px}
#quota{display:block;font-size:12px;color:var(--mut)}#quota:empty{display:none}#keybox{display:block;margin-top:6px;font-size:13px}
#recent{max-width:100%;margin:0 0 8px}.wnote{font-size:13px;color:var(--mut);margin:6px 0}.whist{margin:6px 0 0;padding-left:18px;font-size:13px}.whist li{margin:2px 0}#walbox .row{display:flex;gap:6px;flex-wrap:wrap}#walbox .kbtn{margin-left:0;padding:6px 10px}.kbtn{background:#232C47;color:var(--tx);border:0;border-radius:6px;padding:3px 9px;font-size:13px;cursor:pointer;margin-left:4px}
.grid{display:grid;gap:16px}@media(min-width:900px){.grid{grid-template-columns:1.6fr 1fr;align-items:start}.hero h1{font-size:34px}}
.card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:16px}
.tok{display:flex;gap:12px;align-items:center;flex-wrap:wrap}.av{width:44px;height:44px;border-radius:50%;background:#2a3456;display:grid;place-items:center;font-weight:800;flex:none;overflow:hidden}.av img{width:100%;height:100%;object-fit:cover}
.tok b{font-size:18px;word-break:break-all}.addr{font-size:13px;color:var(--mut)}
.socw{margin-left:auto}.soc{display:flex;gap:14px;align-items:flex-start;flex-wrap:wrap}
.si a,.si span.off{position:relative;width:34px;height:34px;border-radius:10px;display:grid;place-items:center}.si svg{width:20px;height:20px;fill:currentColor}
.si a{border:1px solid #3a4670;background:#18213a}.i-x{color:#fff}.i-tg{color:#26A5E4}.i-dc{color:#5865F2}.i-web{color:#8FA3BF}
.si a::after{content:"\\2713";position:absolute;right:-5px;bottom:-5px;width:15px;height:15px;border-radius:50%;background:#22C55E;color:#04150a;font-size:10px;font-weight:900;display:grid;place-items:center}
.si span.off{border:1px solid #2c3550;background:#121a2e;color:#5b6582;overflow:hidden}.si span.off::before{content:"";position:absolute;left:-4px;right:-4px;top:50%;height:2px;background:#8a93aa;transform:rotate(-45deg)}
@media(max-width:899px){.socw{margin-left:0;width:100%}}@media(min-width:900px){.socfb{text-align:right}}
.res .verdict{margin:14px 0 10px}
@media(max-width:899px){.res .verdict{margin:10px 0 6px;padding:12px;gap:12px;min-height:150px}.gauge{width:104px;height:104px}.gauge i{width:78px;height:78px;font-size:32px}.wcards{gap:6px}.wc summary{padding:10px 12px}.card{padding:12px}.hero h1{font-size:24px}}
.tease{display:inline-block;margin:2px 0 0;padding:4px 10px;border-radius:999px;background:rgba(239,68,68,.15);border:1px solid rgba(239,68,68,.5);color:#ffc2c2;font-weight:700;font-size:13px;cursor:default}
button.tease{cursor:pointer;font:inherit;font-size:13px;font-weight:700}
.lock{margin-top:8px;padding:10px 12px;border-radius:12px;background:#0E1528;border:1px dashed #4a5a8a;font-size:14px;line-height:1.35}
.lock .btn{width:100%;margin-top:8px;padding:8px 12px;font-size:14px}.sec{background:transparent;border:1px solid rgba(56,189,248,.55);color:#9fdcf9}
.unlockwhat{font-size:14px;margin:8px 0 2px;line-height:1.35}
.lock .credsec{display:block;width:100%;margin-top:8px;text-align:center;font-size:13px;color:var(--mut)}
.disc{font-size:12px;color:var(--mut);margin-top:10px;text-align:center}
.buyline{font-size:12px;color:var(--mut);text-align:center;margin-top:6px}#swapbox{margin:10px 0 4px}#swapbox small{display:block;text-align:center}
.card h2,.card h3{margin:0 0 6px;font-size:17px}.mut{color:var(--mut);font-size:14px;margin:0 0 10px}.note{font-size:13px;color:var(--mut);margin:8px 0 10px}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}.wide{width:100%}
.cred{padding:10px 14px;background:transparent}.cred h2{font-size:14px;font-weight:600;color:var(--mut);margin-bottom:2px}.linkbtn{background:none;border:0;padding:0;color:var(--acc);text-decoration:underline;font-size:13px;cursor:pointer}.cred .mut{font-size:13px;margin-bottom:8px}.cred .note{font-size:12px;margin:6px 0 4px}.cred .btn{padding:9px 12px;font-size:14px}
.wpay{border:1px solid var(--line);border-radius:12px;padding:10px 12px;margin:10px 0;background:#0E1528;font-size:14px}.wpay .pack{margin:4px 6px 4px 0;font-size:14px;padding:9px 12px}.wpay select{background:#0E1528;color:var(--tx);border:1px solid var(--line);border-radius:8px;padding:4px}
.wpay .btn{background:var(--acc);color:#04121d;padding:9px 12px;font-size:14px;margin:4px 6px 4px 0}.wstat{margin-top:8px}.wstat code{display:block;word-break:break-all;margin:6px 0}
.qr{background:#fff;border-radius:8px;padding:6px;display:block;margin:8px 0;width:240px;height:240px}.flash{box-shadow:0 0 0 3px var(--acc)}
.quiet{background:transparent;border:1px solid var(--line);border-radius:14px;padding:12px 16px;margin-top:16px}
.quiet>summary,details.fold>summary{font-weight:700;cursor:pointer;color:var(--mut)}
.quiet>summary{list-style:none;display:flex;justify-content:space-between}.quiet>summary::-webkit-details-marker{display:none}.quiet>summary::after{content:"\\25BE"}.quiet[open]>summary::after{content:"\\25B4"}
.quiet .sub{margin-top:12px}.quiet .sub h3{font-size:15px;margin:0 0 6px}
.sub input,.sub select{width:100%;margin:4px 0;background:#0E1528;border:1px solid var(--line);color:var(--tx);border-radius:10px;padding:9px;font-size:15px}.sub .btn{padding:9px 12px;font-size:14px}
.tools{display:grid;grid-template-columns:repeat(2,1fr);gap:8px;margin-top:6px}
.tools a{background:#0E1528;border:1px solid var(--line);border-radius:12px;padding:10px;color:var(--tx);font-size:14px}.tools a small{display:block;color:var(--mut);font-size:11px}
details.fold{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:14px 16px;margin:16px 0}
code{background:#0E1528;padding:2px 6px;border-radius:6px;font-size:13px;word-break:break-all}pre{background:#0E1528;color:#9fdcf9;padding:10px;border-radius:8px;overflow-x:auto;font-size:12px}
.agents table{width:100%;border-collapse:collapse;font-size:13px}.agents td{padding:5px 4px;border-bottom:1px solid var(--line);vertical-align:top}.agents td:first-child code{white-space:nowrap;word-break:normal}
.dev{padding:10px 14px;margin:12px 0}.dev>summary{font-size:14px}.dev p{font-size:13px;margin:10px 0 6px}.dev .cpw pre{margin:0}.dev code{font-size:12px;padding:1px 4px}.dev .cpb{display:block;margin:0 0 4px auto;background:#16203a;color:var(--tx);border:1px solid var(--line);border-radius:8px;font-size:12px;padding:3px 9px;cursor:pointer}
.devlink{font-size:13px;padding:16px 0 0}
footer{color:var(--mut);font-size:12px;padding:8px 0 40px}
.soon{color:var(--mut);font-size:14px;cursor:default;user-select:none}
.shr{display:flex;flex-wrap:wrap;gap:8px;margin:10px 0 0}.shr .btn{flex:1 1 auto;padding:10px 12px;font-size:14px}.xb{background:#EEF2F8;color:#0B1020}
.shot{position:fixed;inset:0;z-index:50;background:var(--bg);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:14px;overflow:auto}.shot .shr{width:100%;max-width:420px;margin:0}
.shc{width:100%;max-width:420px;background:var(--card);border:1px solid var(--line);border-radius:16px;padding:14px}.shc .verdict{margin:0 0 10px}.shw{display:flex;gap:8px;align-items:center;font-weight:700;font-size:15px;padding:9px 10px;margin-bottom:6px;border-radius:10px;background:#0F1628}.shw.d{border-left:4px solid var(--bad)}.shw.c{border-left:4px solid var(--warn)}
.sha{font-size:12px;color:var(--mut);word-break:break-all;margin:10px 0 8px}.shm{display:flex;gap:6px;align-items:center;font-size:12px;color:var(--mut)}.shm img{border-radius:50%}.shm b{color:var(--tx)}
@media(max-width:899px){.go{padding:11px 14px;font-size:15px}.buyline{margin-top:4px;font-size:11px}.grid{gap:10px}.quiet{margin-top:10px}details.fold{margin:10px 0;padding:12px 14px}}`;


/** Pure share-text helpers (also unit-tested). Only the free score, label, warning titles and address ever go in. */
export const SHARE_JS = CLEAN_JS + String.raw`function rrLink(o,a,c){c=c||(/^0x/i.test(a)?'base':'solana');return o+'/rugradar/c/'+encodeURIComponent(c)+'/'+encodeURIComponent(a)}
function rrNm(n){n=String(n||'');const d=n.charAt(0)==='$',x=rrClean(n,33);return d&&x&&!/\s/.test(x)?'$'+x:x}
function rrShareText(sc,lb,ws,a,c,o,p,n){n=rrNm(n);const L=rrLink(o,a,c),h='Checked '+(n||'this token')+' on RugRadar \u2014 '+sc+' '+lb+'.',t=' Full report $'+p+'. '+L,room=270-h.length-t.length-2;let w=ws.slice(0,2).join(' + ');if(w.length>room)w=ws[0]||'';if(w.length>room)w=room>9?w.slice(0,room-1).trim()+'\u2026':'';return h+(w?' '+w+'.':'')+t}
function rrReportText(sc,lb,ws,a,c,o,n){n=rrNm(n);return 'RugRadar \u2014 '+(n?n+' \u2014 ':'')+sc+' '+lb+'\n'+ws.slice(0,3).map(x=>'\u2022 '+x).join('\n')+(ws.length?'\n':'')+a+'\n'+rrLink(o,a,c)}
function rrFree(ch,L,W){ch=Array.isArray(ch)?ch:[];const b=ch.filter(c=>c&&L.indexOf(c.check)>=0&&c.check!=='dead_token').map(c=>({check:c.check,points:Number(c.points)||0})),sm=b.reduce((a,c)=>a+c.points,0),d=ch.find(c=>c&&c.check==='dead_token'),xs=d?[{check:'dead_token',points:Math.max(5,60-sm)}].concat(b):b,sc=Math.min(100,xs.reduce((a,c)=>a+c.points,0)),seen={},ws=[];
xs.filter(c=>c.points>0&&W[c.check]).sort((a,c)=>c.points-a.points).forEach(c=>{const w=W[c.check];if(seen[w[0]])return;seen[w[0]]=1;ws.push({d:c.points>=15,t:w[0],l:w[1]})});return {sc:sc,lv:sc>=50?'high':sc>=25?'medium':'low',ws:ws}}
`;

/** Page client JS (no template interpolation on purpose; config arrives as CFG). */
const PAGE_JS = String.raw`${SHARE_JS}const WALLETS=[],WAPI={register:(...ws)=>{ws.forEach(w=>{if(w&&w.features&&(w.features['solana:signAndSendTransaction']||w.features['solana:signMessage'])&&w.features['standard:connect']&&!WALLETS.includes(w))WALLETS.push(w)});return()=>{}}};
window.addEventListener('wallet-standard:register-wallet',e=>{try{e.detail(WAPI)}catch(x){}});try{window.dispatchEvent(new CustomEvent('wallet-standard:app-ready',{detail:WAPI}))}catch(x){}
let PAYCFG=null;const payCfg=fetch('/rugradar/pay/config').then(r=>r.json()).then(j=>PAYCFG=j).catch(()=>null);
const B58='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58(u){let d=[0];for(const x of u){let c=x;for(let i=0;i<d.length;i++){c+=d[i]*256;d[i]=c%58;c=Math.floor(c/58)}while(c){d.push(c%58);c=Math.floor(c/58)}}let z='';for(const x of u){if(x)break;z+='1'}return z+d.reverse().map(i=>B58[i]).join('').replace(/^1+/,'')}
const post=(u)=>fetch(u,{method:'POST'}).then(async r=>({ok:r.ok,status:r.status,j:await r.json().catch(()=>({}))}));
function walletPacks(){const w=el('div','wpay');w.id='wpay';w.append(el('b',null,'Pay with Phantom or Solflare'));
 const cur=el('select');cur.id='wcur';[['sol','SOL'],['usdc','USDC']].forEach(([v,t])=>{const op=el('option',null,t);op.value=v;cur.append(op)});
 const row=el('div','row');row.style.margin='8px 0';row.append(el('span',null,'Pay in'),cur);w.append(row);
 const st=el('div','wstat');const packs=el('div','row');
 [['10','0.10'],['50','0.40'],['200','1.50']].forEach(([n,usd])=>{const bt=el('button','btn pack',n+' credits \u00b7 $'+usd);bt.type='button';bt.dataset.pack=n;bt.addEventListener('click',()=>buyPack(n,cur.value,st));packs.append(bt)});w.append(packs,st);
 payCfg.then(c=>{if(!c||!c.enabled){w.querySelectorAll('button.pack').forEach(x=>x.disabled=true);st.textContent='Wallet checkout is coming soon. For now use a credit key or x402 below.'}else st.textContent='One click: your wallet asks you to approve the transfer to '+c.recipient.slice(0,4)+'\u2026'+c.recipient.slice(-4)+'. The key appears here.'});
 setTimeout(()=>{if(MOBILE&&!WALLETS.length){const r=el('div','wstat');r.id='wphone';r.append(el('p',null,'On a phone? Open this page in your wallet app and pay in one tap:'),...deepLinks());w.insertBefore(r,st)}},900);
 const prev=localStorage.getItem('rr_order');if(prev){const r=el('button','btn',"I've paid \u2014 check my last order");r.type='button';r.style.marginTop='8px';r.addEventListener('click',()=>pollClaim(prev,null,st,10));w.append(r)}
 return w}
const MOBILE=/Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)||(navigator.maxTouchPoints>1&&/Mac/.test(navigator.platform));
function deepLinks(){const u=encodeURIComponent(location.origin+'/rugradar#credits'),r=encodeURIComponent(location.origin);return [['Open in Phantom','https://phantom.com/ul/browse/'+u+'?ref='+r],['Open in Solflare','https://solflare.com/ul/v1/browse/'+u+'?ref='+r]].map(([t,h])=>{const a=el('a','btn',t);a.href=h;a.rel='noopener';return a})}
function noWallet(od,cur,st){const ph=document.getElementById('wphone');if(ph)ph.remove();st.textContent='';st.append(el('p',null,'Pay '+od.amount+' '+cur.toUpperCase()+' ($'+od.priceUsd+') for '+od.credits+' credits to RugRadar ('+od.recipient.slice(0,4)+'\u2026'+od.recipient.slice(-4)+').'));
 const sp=el('a','btn',MOBILE?'Other wallet app':'Open in wallet app');sp.href=od.solanaPayUrl;
 if(MOBILE){st.append(el('p',null,'No wallet in this browser. Open RugRadar in your wallet app (one tap there), or pay this order with any Solana wallet app:'),...deepLinks(),sp)}
 else{const img=el('img','qr');img.alt='Solana Pay QR code';img.width=240;img.height=240;img.src='/rugradar/pay/qr.svg?order='+encodeURIComponent(od.order);st.append(el('p',null,'No browser wallet found. Scan with Phantom, Solflare or any Solana wallet app on your phone:'),img,sp)}
 const ck=el('button','btn',"I've paid \u2014 check");ck.type='button';ck.addEventListener('click',()=>pollClaim(od.order,null,st,20));st.append(ck);
 const ws=el('p',null,'Waiting for your payment. This page confirms it automatically.');st.append(ws);pollClaim(od.order,null,ws,240,5000,true)}
async function buyPack(pack,cur,st){st.textContent='Creating order...';const o=await post('/rugradar/pay/order?pack='+pack+'&currency='+cur);if(!o.ok){st.textContent=o.j.message||('Error '+o.status);return}
 const od=o.j;localStorage.setItem('rr_order',od.order);
 const wal=WALLETS.find(x=>/phantom/i.test(x.name))||WALLETS.find(x=>/solflare/i.test(x.name))||WALLETS[0];
 if(!wal){noWallet(od,cur,st);return}
 try{st.textContent='Approve in '+wal.name+'...';const acc=(await wal.features['standard:connect'].connect()).accounts[0]||wal.accounts[0];
  const t=await post('/rugradar/pay/tx?order='+encodeURIComponent(od.order)+'&account='+acc.address);if(!t.ok){st.textContent=t.j.message||('Error '+t.status);return}
  const bytes=Uint8Array.from(atob(t.j.transaction),c=>c.charCodeAt(0));
  const res=await wal.features['solana:signAndSendTransaction'].signAndSendTransaction({account:acc,transaction:bytes,chain:'solana:mainnet'});
  const sig=b58((Array.isArray(res)?res[0]:res).signature);st.textContent='Payment sent. Confirming on-chain...';pollClaim(od.order,sig,st,30)}
 catch(err){st.textContent='Wallet did not send the payment ('+((err&&err.message)||'cancelled')+'). Nothing was charged.'}}
let POLL=0;async function pollClaim(order,sig,st,tries,ms,auto){const id=++POLL;ms=ms||3000;for(let i=0;i<tries;i++){if(id!==POLL)return;const c=await post('/rugradar/pay/claim?order='+encodeURIComponent(order)+(sig?'&signature='+sig:''));
  if(c.ok){localStorage.removeItem('rr_order');st.textContent='';st.append(el('p',null,c.j.credits+' credits added. Your key is shown once. Copy it and keep it private:'));const kk=c.j.key,kc=el('code',null,kk.slice(0,3)+'\u2026'+kk.slice(-4));let ko=false;const kb=(t,fn)=>{const x=el('button','kbtn',t);x.type='button';x.addEventListener('click',fn);return x};const ks=kb('Show',()=>{ko=!ko;kc.textContent=ko?kk:kk.slice(0,3)+'\u2026'+kk.slice(-4);ks.textContent=ko?'Hide':'Show'});const kp=kb('Copy',()=>{const d=()=>{kp.textContent='Copied';setTimeout(()=>kp.textContent='Copy',1500)};if(navigator.clipboard)navigator.clipboard.writeText(kk).then(d,()=>{ko=true;kc.textContent=kk;ks.textContent='Hide'});else{ko=true;kc.textContent=kk;ks.textContent='Hide'}});st.append(kc,ks,kp);document.getElementById('key').value=kk;KS.set(kk);st.append(el('small',null,'Saved on this device (see Saved credit key above). Copy it and keep it private too.'));q.textContent=c.j.credits+' credit(s) on your key. Check a token for the full report.';return}
  if(c.status===409||c.status===400||c.status===410){if(c.status===409)localStorage.removeItem('rr_order');st.textContent=c.j.message||('Error '+c.status);return}
  if(!auto)st.textContent=(c.j.message||'Waiting for confirmation...')+' ('+(i+1)+'/'+tries+')';await new Promise(r=>setTimeout(r,ms))}
 if(id!==POLL)return;
 st.append(el('p',null,'Still not confirmed. Your order is saved; use the check button again in a minute.'))}
const KS={get(){try{return localStorage.getItem('rr_key')||''}catch(e){return ''}},set(k){try{localStorage.setItem('rr_key',k)}catch(e){}keyUI();recentLoad()},del(){try{localStorage.removeItem('rr_key')}catch(e){}keyUI();recentLoad()}};
function keyUI(){const b=document.getElementById('keybox'),k=KS.get();b.textContent='';b.hidden=!k;if(!k)return;const mask=k.slice(0,3)+'\u2026'+k.slice(-4),c=el('code',null,mask);let on=false;
 const bt=(t,f)=>{const x=el('button','kbtn',t);x.type='button';x.addEventListener('click',f);return x};
 const sh=bt('Show',()=>{on=!on;c.textContent=on?k:mask;sh.textContent=on?'Hide':'Show'});
 const cp=bt('Copy',()=>{const done=()=>{cp.textContent='Copied';setTimeout(()=>cp.textContent='Copy',1500)};if(navigator.clipboard)navigator.clipboard.writeText(k).then(done,()=>{on=true;c.textContent=k});else{on=true;c.textContent=k}});
 const fg=bt('Forget',()=>{if(!confirm('Forget the saved credit key on this device? Copy it first if it still has credits.'))return;['key','wkey'].forEach(i=>{const x=document.getElementById(i);if(x&&x.value===k)x.value=''});KS.del()});
 b.append(el('span',null,'Saved credit key: '),c,sh,cp,fg);const i=document.getElementById('key');if(!i.value)i.value=k}
const $=id=>document.getElementById(id);
const f=$('f'),out=$('out'),q=$('quota'),go=$('go');
const el=(t,c,x)=>{const e=document.createElement(t);if(c)e.className=c;if(x!=null)e.textContent=x;return e};
const OFFER=CFG.offer,DESK=matchMedia('(min-width:900px)').matches;
const short=a=>{a=String(a||'');return a.length>14?a.slice(0,4)+'\u2026'+a.slice(-6):a};
const ageTxt=h=>{if(typeof h!=='number')return null;if(h<1)return Math.max(1,Math.round(h*60))+' min old';if(h<48)return Math.round(h)+' h old';if(h<24*60)return Math.round(h/24)+' d old';return (h/24/365).toFixed(1).replace(/\.0$/,'')+' y old'};
function warnings(checks,det){det=det||{};const seen={},o=[];(Array.isArray(checks)?checks:[]).filter(c=>c&&Number(c.points)>0&&(CFG.warn[c.check]||det[c.check])).sort((a,b)=>b.points-a.points).forEach(c=>{const w=det[c.check]||CFG.warn[c.check];if(seen[w[0]])return;seen[w[0]]=1;o.push({d:Number(c.points)>=15,t:w[0],l:w[1],k:c.check})});return o}
function headline(ws){const p=ws.slice(0,3).map(w=>(CFG.head&&CFG.head[w.k])||String(w.t).toLowerCase());if(!p.length)return '';const s=p.length===1?p[0]:p.length===2?p[0]+' and '+p[1]:p[0]+', '+p[1]+', and '+p[2];return s.charAt(0).toUpperCase()+s.slice(1)}
function card(w,j,open){const d=el('details','wc '+(w.d?'d':'c'));if(open)d.open=true;const s=el('summary');s.append(el('span','sev '+(w.d?'s3':'s2'),w.d?'DANGER':'CAUTION'),el('span','tt',w.t),el('span','ch'));d.append(s);
 d.append(el('p',null,w.l));return d}
const SV=d=>'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="'+d+'"/></svg>';
const ICO={x:SV('M14.2 10.2 23 0h-2l-7.7 8.8-6-8.8h-7l9.1 13.3L.3 24h2l8-9.3 6.4 9.3h7zm-2.8 3.3-1-1.4L3.2 1.6h3.2l6 8.5.9 1.3 7.7 11.1h-3.2z'),tg:SV('M12 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0m5 7.2.4.2.1.3v.5c-.1 1.9-.9 6.5-1.3 8.6q-.3 1.3-.8 1.2-1 0-2-.9l-2.6-1.8c-1.2-.8-.4-1.2.3-1.9l3.3-3.2V10H14q-.2 0-5.1 3.3-.8.5-1.3.5-.8-.1-1.9-.5-1.2-.2-1.3-.8 0-.3 1-.6z'),dc:SV('M20.3 4.4a20 20 0 0 0-4.9-1.5L14.7 4q-2.7-.3-5.4 0L8.6 3a20 20 0 0 0-5 1.5q-4.4 7-3.5 13.7 3 2.2 6 3h.1q.8-1 1.2-2l-1.9-1V18l.4-.3q6.1 2.7 12.1 0h.1l.4.3v.1l-2 1 1.3 2q3-.8 6-3h.1q.7-7.7-3.6-13.7M8 15.4c-1.2 0-2.1-1.2-2.1-2.5s1-2.4 2.1-2.4 2.2 1 2.2 2.4-1 2.4-2.2 2.4m8 0c-1.2 0-2.2-1.2-2.2-2.5s1-2.4 2.2-2.4q2 .1 2.2 2.4c0 1.3-1 2.4-2.2 2.4'),web:'<svg viewBox="0 0 24 24" aria-hidden="true" style="fill:none;stroke:currentColor;stroke-width:1.8"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3.5 3.5 3.5 14.5 0 18M12 3c-3.5 3.5-3.5 14.5 0 18"/></svg>'};
const SOC=[['X','x',/^(twitter|x)$/i,'X'],['Telegram','tg',/^telegram$/i,'TG'],['Website','web',/^website$/i,'Web'],['Discord','dc',/^discord$/i,'Discord']];
const ic=(e,k)=>{if(ICO[k]){e.classList.add('i-'+k);e.innerHTML=ICO[k]}else e.textContent=k};
function host(u){try{return new URL(u).hostname.replace(/^www\./,'')}catch(e){return ''}}
function socials(j){const raw=Array.isArray(j.socialLinks)?j.socialLinks:(j.buyer&&Array.isArray(j.buyer.socialLinks)?j.buyer.socialLinks:null);if(!raw)return null;
 const links=raw.filter(x=>x&&typeof x.url==='string'&&/^https?:\/\//i.test(x.url)),w=el('div','socw');w.title='Links set by the token creator';
 if(!links.length){w.append(el('span','nosoc','\u26A0 No socials found'));return w}
 const row=el('div','soc'),have=[],miss=[];const mk=(x,name,k)=>{const s=el('div','si'),a=el('a');ic(a,k);a.href=x.url;a.target='_blank';a.rel='noopener noreferrer nofollow';a.setAttribute('aria-label',name);a.title=name+': '+host(x.url);s.append(a);row.append(s)};
 SOC.forEach(([name,k,re,shortName])=>{const x=links.find(l=>re.test(String(l.type||'')));if(x){mk(x,name,k);have.push(shortName)}else{const s=el('div','si'),o=el('span','off');ic(o,k);o.setAttribute('role','img');o.setAttribute('aria-label',name+' missing');o.title=name+' missing';s.append(o);row.append(s);miss.push(shortName)}});
 links.filter(l=>!SOC.some(s=>s[2].test(String(l.type||'')))).slice(0,3).forEach(x=>{const n=String(x.type||'link');mk(x,n,n.slice(0,2).toUpperCase());have.push(n)});
 row.title='Links set by the token creator';const fb=el('div','socfb',have.join(' \u00b7 '));if(miss.length){if(have.length)fb.append(' \u00b7 ');fb.append(el('span','miss',miss.join(', ')+' missing'))}
 w.append(row,fb);return w}
function gauge(lv,score){const g=el('div','gauge g-'+lv);g.style.setProperty('--p',Math.max(4,Math.min(100,score)));const i=el('i',null,String(score));i.append(el('small',null,'/100'));g.append(i);return g}
const VT={high:['HIGH RISK','Strong rug warning signs.'],medium:['CAUTION','Some rug warning signs.'],low:['NO WARNINGS','No danger warnings found.']};
function shownLevel(j,ws){const l=VT[j.riskLevel]?j.riskLevel:'medium';if(l!=='low'||!ws.length)return l;return ws.some(w=>w.d)?'high':'medium'}
function verdictBox(j,ws){const lv=shownLevel(j,ws),s=Number(j.riskScore)||0,v=el('div','verdict v-'+lv),t=el('div','vtx');
 if(!ws.length){t.append(el('div','vt low','No danger warnings found.'),el('div','vl','Open details for market and contract figures.'))}
 else{t.append(el('div','vt '+lv,headline(ws)));if(j.tensionLine)t.append(el('div','vtl',j.tensionLine));else t.append(el('div','vl','Top danger warnings. More figures are in details.'))}
 v.append(gauge(lv,s),t);return v}
function lockedPanel(note,cta,sec){const b=el('div','lock');b.id='unlock';if(note!=='')b.append(el('span',null,'\u{1F512} '+(note||'Full report: live chart, dev and sniper wallets, biggest buys and sells, sell test.')));const a=el('button','btn pri',cta||CFG.cta);a.type='button';a.addEventListener('click',()=>openBuy(true));b.append(a);if(sec){const s=el('button','linkbtn credsec',sec);s.type='button';s.addEventListener('click',()=>openBuy(true));b.append(s)}return b}
function openBuy(scroll){const x=$('buyx');x.hidden=false;const w=$('wpay');if(scroll&&w){$('credits').scrollIntoView({block:'start',behavior:'smooth'});w.classList.add('flash');setTimeout(()=>w.classList.remove('flash'),1600)}}
let LIVEP=null;function liveLoad(){if(!LIVEP)LIVEP=new Promise((ok,no)=>{const s=document.createElement('script');s.src='/rugradar/live.js?v=${LIVE_V}';s.onload=ok;s.onerror=()=>{LIVEP=null;no()};document.head.append(s)});return LIVEP}
function rrCopy(t,b){const o=b.dataset.l||(b.dataset.l=b.textContent),d=()=>{b.textContent='Copied';setTimeout(()=>b.textContent=o,1500)},fb=()=>{const x=document.createElement('textarea');x.value=t;x.setAttribute('readonly','');x.style.cssText='position:fixed;top:0;left:0;opacity:0';document.body.append(x);x.select();x.setSelectionRange(0,t.length);try{document.execCommand('copy')&&d()}catch(e){}x.remove()};if(navigator.clipboard&&navigator.clipboard.writeText)navigator.clipboard.writeText(t).then(d,fb);else fb()}
function shotMode(j,ws,lv,sc,lb,txt){const bd=el('div','shot'),c=el('div','shc'),v=el('div','verdict v-'+lv),t=el('div'),prev=document.activeElement;t.append(el('div','vt '+lv,lb),el('div','vl',VT[lv][1]));v.append(gauge(lv,sc),t);c.append(v);
 ws.slice(0,3).forEach(w=>{const r=el('div','shw '+(w.d?'d':'c'));r.append(el('span','sev '+(w.d?'s3':'s2'),w.d?'DANGER':'CAUTION'),el('span',null,w.t));c.append(r)});
 const tk=rrTok(j.facts);c.append(el('div','sha',(tk.line?tk.line+' \u00b7 ':'')+String(j.token||'')));
 const mk=el('div','shm'),im=el('img');im.src='/rugradar/rug-radar-64.png';im.width=18;im.height=18;im.alt='';mk.append(im,el('b',null,'RugRadar'),el('span',null,'free check'));c.append(mk);
 const row=el('div','shr'),cl=()=>{bd.remove();document.removeEventListener('keydown',kd);document.body.style.overflow='';if(prev&&prev.focus)prev.focus()},kd=e=>{if(e.key==='Escape')cl()};
 const bk=el('button','btn sec','\u2190 Back');bk.type='button';bk.addEventListener('click',cl);row.append(bk);
 if(navigator.share){const sb=el('button','btn sec','Share');sb.type='button';sb.addEventListener('click',()=>{try{navigator.share({text:txt}).catch(()=>{})}catch(e){}});row.append(sb)}
 bd.addEventListener('click',e=>{if(e.target===bd)cl()});bd.append(c,row);document.body.append(bd);document.body.style.overflow='hidden';document.addEventListener('keydown',kd);bk.focus()}
function shareBar(j,ws){const lv=shownLevel(j,ws),sc=Number(j.riskScore)||0,lb=VT[lv][0],a=String(j.token||''),tl=ws.map(w=>w.t),b=el('div','shr');
 const nm=rrTok(j.facts).share,txt=rrShareText(sc,lb,tl,a,j.chain,CFG.u,CFG.p,nm),x=el('a','btn xb','Share on X');x.href='https://x.com/intent/post?text='+encodeURIComponent(txt);x.target='_blank';x.rel='noopener noreferrer';
 const bt=(n,f)=>{const y=el('button','btn sec',n);y.type='button';y.addEventListener('click',()=>f(y));return y};
 b.append(x,bt('Share',()=>shotMode(j,ws,lv,sc,lb,txt)),bt('Copy report',y=>rrCopy(rrReportText(sc,lb,tl,a,j.chain,CFG.u,nm),y)),bt('Copy link',y=>rrCopy(rrLink(CFG.u,a,j.chain),y)));return b}
const WS={get(){try{return localStorage.getItem('rr_wsess')||''}catch(e){return ''}},set(v){try{localStorage.setItem('rr_wsess',v)}catch(e){}},del(){try{localStorage.removeItem('rr_wsess')}catch(e){}}};
const hexs=u=>Array.from(u,b=>b.toString(16).padStart(2,'0')).join('');
async function walConnect(kind,st){try{let addr,sign;
 if(kind==='sol'){const wal=WALLETS.find(x=>/phantom/i.test(x.name)&&x.features['solana:signMessage'])||WALLETS.find(x=>x.features['solana:signMessage']);
  if(wal){const acc=(await wal.features['standard:connect'].connect()).accounts[0]||wal.accounts[0];addr=acc.address;sign=async m=>{const r=await wal.features['solana:signMessage'].signMessage({account:acc,message:new TextEncoder().encode(m)});return hexs((Array.isArray(r)?r[0]:r).signature)}}
  else if(window.solana&&window.solana.signMessage){const r=await window.solana.connect();addr=r.publicKey.toString();sign=async m=>{const o=await window.solana.signMessage(new TextEncoder().encode(m),'utf8');return hexs(o.signature||o)}}
  else{st.textContent=MOBILE?'Open RugRadar in your Phantom or Solflare app to connect.':'No Solana wallet found in this browser.';return}}
 else{const eth=window.ethereum;if(!eth){st.textContent='No Base / EVM wallet found in this browser.';return}const a=await eth.request({method:'eth_requestAccounts'});addr=a[0];sign=m=>eth.request({method:'personal_sign',params:[m,addr]})}
 st.textContent='Sign the message in your wallet. No transaction, no cost.';
 const cr=await fetch('/rugradar/api/wallet/challenge?address='+encodeURIComponent(addr));const c=await cr.json().catch(()=>({}));if(!cr.ok||!c.message){st.textContent=c.message||'Could not connect right now.';return}
 const sig=await sign(c.message);
 const vr=await fetch('/rugradar/api/wallet/verify',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({address:addr,message:c.message,signature:sig})});const v=await vr.json().catch(()=>({}));
 if(!v.session){st.textContent=v.message||'Signature not accepted.';return}
 WS.set(v.session);walLoad()}catch(e){st.textContent='Wallet did not sign ('+((e&&e.message)||'cancelled')+'). Nothing was sent.'}}
function walLoad(){const b=$('walbox');if(!b)return;b.textContent='';const s=WS.get(),st=el('div','wstat');
 if(!s){const row=el('div','row');const mk=(t,k)=>{const x=el('button','kbtn',t);x.type='button';x.addEventListener('click',()=>walConnect(k,st));return x};row.append(mk('Solana wallet','sol'),mk('Base / EVM wallet','evm'));b.append(el('p','wnote','Sign a message to prove the wallet is yours. No transaction, no cost. Only you see your list.'),row,st);return}
 fetch('/rugradar/api/wallet/history',{headers:{'X-RugRadar-Wallet':s}}).then(async r=>{const j=await r.json().catch(()=>({}));if(r.status===401){WS.del();walLoad();return}if(!r.ok)return;
  const hd=el('div','wnote','Connected: '+short(j.wallet)+' ');const fg=el('button','kbtn','Disconnect');fg.type='button';fg.addEventListener('click',()=>{WS.del();walLoad()});hd.append(fg);b.append(hd);
  const items=Array.isArray(j.items)?j.items:[];if(!items.length){b.append(el('p','wnote','No past checks yet. Checks you run while connected show up here.'));return}
  const ul=el('ul','whist');items.forEach(it=>{const li=el('li'),a=el('a',null,short(it.token)+' \u00b7 '+(CFG.chains[it.chain]||it.chain)+(it.score!=null?' \u00b7 '+it.score+'/100':'')+' \u00b7 '+new Date(it.at).toLocaleDateString());a.href='/rugradar?token='+encodeURIComponent(it.token)+'&chain='+encodeURIComponent(it.chain);li.append(a);ul.append(li)});b.append(ul)}).catch(()=>{})}
function render(j,t){out.textContent='';const c=el('div','card res'),ws=warnings(j.checks,j.warnDetails),fa=j.facts||{},tk=rrTok(fa);
 const tok=el('div','tok'),info=el('div'),lt=(tk.s||tk.n||String(j.token||'?')).slice(0,2).toUpperCase(),av=el('div','av',lt);if(tk.img){const im=el('img');im.alt='';im.referrerPolicy='no-referrer';im.loading='lazy';im.onerror=()=>{im.remove();av.textContent=lt};im.src=tk.img;av.textContent='';av.append(im)}tok.append(av);
 info.append(el('b',null,tk.line||short(j.token)),el('div','addr',[tk.line?short(j.token):null,CFG.chains[j.chain]||j.chain,ageTxt(fa.ageHours)].filter(Boolean).join(' \u00b7 ')));tok.append(info);const sw=socials(j);if(sw)tok.append(sw);c.append(tok);
 c.append(verdictBox(j,ws));
 if(typeof SWAPHOOK==='function'&&j.token===t&&shownLevel(j,ws)==='low'){const sb=SWAPHOOK(j);if(sb)c.append(sb)}
 const wc=el('div','wcards');ws.slice(0,3).forEach(w=>wc.append(card(w,j,true)));if(ws.length)c.append(wc);
 const full=!(j.report==='limited'&&j.checks);
 if(!full){c.append(shareBar(j,ws));c.append(el('div','unlockwhat','Full report also shows: live chart, dev activity, biggest buys/sells.'));c.append(lockedPanel('','Unlock for $'+CFG.p,'or buy credits to skip the wait'));c.append(el('div','buyline','Checks finish faster with credits · buy once, skip the payment wait'));c.append(el('div','tease',j.lockedTeaser||'Full report'))}
 else if(Array.isArray(j.checks)){const fr=rrFree(j.checks,CFG.lim,CFG.warn);c.append(shareBar({riskScore:fr.sc,riskLevel:fr.lv,token:j.token,chain:j.chain,facts:fa},fr.ws))}
 const dt=el('details','quiet det');dt.id='more';if(full&&j.liveReport&&DESK)dt.open=true;dt.append(el('summary',null,'Show details'));const sub=el('div','sub');dt.append(sub);
 if(Array.isArray(j.freeFacts)&&j.freeFacts.length)sub.append(el('div','ffl',j.freeFacts.join(' \u00b7 ')));
 if(ws.length>3){sub.append(el('div','sec-title','More warnings'));const w2=el('div','wcards');ws.slice(3).forEach(w=>w2.append(card(w,j,true)));sub.append(w2)}
 if(j.liveReport){const h=el('div');sub.append(h);liveLoad().then(()=>{const b=window.RRLive(j);if(b)h.append(b)}).catch(()=>{})}
 const ws2=el('div','sub soon');ws2.append(el('span',null,'\u{1F514} Watch token: coming soon'));sub.append(ws2);c.append(dt);
 c.append(el('div','disc','Danger warnings only'));out.append(c)}
function waitCard(){out.textContent='';const c=el('div','card res'),v=el('div','verdict'),t=el('div');t.append(el('div','vt','Checking\u2026'),el('div','vl','Usually a few seconds.'));v.append(gauge('wait',0),t);v.querySelector('i').firstChild.textContent='\u2026';c.append(v);out.append(c)}
function msgCard(text,lock,note){out.textContent='';const c=el('div','card res');c.append(el('p',null,text));if(lock)c.append(lockedPanel(note));out.append(c)}
async function chainFor(t){const c=$('chain').value;if(c!=='auto')return c;if(!t.startsWith('0x'))return 'solana';try{const r=await fetch('/rugradar/api/chain?token='+encodeURIComponent(t));const j=await r.json();return j.chain||'base'}catch(e){return 'base'}}
f.addEventListener('submit',async e=>{e.preventDefault();const t=$('tok').value.trim(),k=f.dataset.free?'':$('key').value.trim();delete f.dataset.free;if(!t)return;waitCard();go.disabled=true;
 try{const c=await chainFor(t);const r=k?await fetch('/rug-check?token='+encodeURIComponent(t)+'&chain='+c,{headers:{'X-RugRadar-Key':k}}):await fetch('/rugradar/api/check?token='+encodeURIComponent(t)+'&chain='+c,{method:'POST',headers:WS.get()?{'X-RugRadar-Wallet':WS.get()}:{}});
 const j=await r.json().catch(()=>({}));
 if(!r.ok){const used=j.error==='free_checks_used';msgCard(j.message||(r.status===402&&k?'Credit key not accepted or out of credits.':'Error '+r.status),r.status===402||used,used?'Free check used. Credits unlock the full report.':null);return}
 render(j,t);
 if(j.credits_remaining!=null){q.textContent=j.credits_remaining+' credit(s) left on your key.';pill(j.credits_remaining);if(k&&KS.get()!==k)KS.set(k);else recentLoad()}
 }catch(err){msgCard('Network error, try again.')}finally{go.disabled=false}});
const RK=()=>$('key').value.trim()||KS.get(),RS=$('recent');
function recentLoad(){const k=RK();RS.hidden=true;if(!k)return;fetch('/rugradar/api/recent',{headers:{'X-RugRadar-Key':k}}).then(r=>r.ok?r.json():null).then(j=>{if(!j||!j.items||!j.items.length||RK()!==k)return;RS.textContent='';RS.append(new Option('Recent ('+j.items.length+')',''));j.items.forEach(i=>RS.append(new Option(i.name+' \u00b7 '+i.shortAddress+' \u00b7 '+i.score,i.chain+'|'+i.address)));RS.hidden=false}).catch(()=>{})}
RS.addEventListener('change',async()=>{const v=RS.value;if(!v)return;const p=v.split('|'),k=RK();RS.selectedIndex=0;waitCard();try{const r=await fetch('/rugradar/api/recent/report?chain='+encodeURIComponent(p[0])+'&token='+encodeURIComponent(p[1]),{headers:{'X-RugRadar-Key':k}}),j=await r.json().catch(()=>({}));if(!r.ok){msgCard(j.message||'Saved report not found.');recentLoad();return}$('tok').value=p[1];if($('chain').querySelector('option[value="'+p[0]+'"]'))$('chain').value=p[0];render(j,p[1]);q.textContent='Saved report from '+new Date(j.savedAt).toLocaleDateString()+'. No credit used.';if(j.credits_remaining!=null)pill(j.credits_remaining)}catch(e){msgCard('Network error, try again.')}});
$('key').addEventListener('change',recentLoad);
function pill(n){$('credpill').textContent=(n==null?'Credits':'Credits: '+n)+' \u00b7 Buy'}
$('credpill').addEventListener('click',e=>{e.preventDefault();openBuy(true)});$('buyc').addEventListener('click',()=>openBuy(false));
function openDev(){const d=$('developers');if(d)d.open=true}
document.querySelectorAll('a[href="#agents"],a[href="#developers"]').forEach(a=>a.addEventListener('click',openDev));
const od=()=>{if(location.hash==='#developers'||location.hash==='#agents')openDev()};od();addEventListener('hashchange',od);
document.querySelectorAll('.cpb').forEach(b=>b.addEventListener('click',()=>{const t=b.nextElementSibling.textContent,done=()=>{b.textContent='Copied';setTimeout(()=>b.textContent='Copy',1500)};if(navigator.clipboard)navigator.clipboard.writeText(t).then(done,()=>{});}));
if(location.hash==='#credits')openBuy(false);
try{const u=new URLSearchParams(location.search),t=u.get('token')||u.get('t'),c=u.get('chain');if(t&&t.length<=64){$('tok').value=t;if(c&&$('chain').querySelector('option[value="'+c.replace(/[^a-z]/g,'')+'"]'))$('chain').value=c;if(/^[A-Za-z0-9]{20,64}$/.test(t))setTimeout(()=>{f.dataset.free='1';f.dispatchEvent(new Event('submit',{cancelable:true}))},0)}}catch(e){}
{const tk=$('tok'),cl=$('clr'),cs=()=>{cl.hidden=!tk.value};tk.addEventListener('input',cs);cl.addEventListener('click',()=>{tk.value='';cs();tk.focus()});cs()}
keyUI();recentLoad();walLoad();document.getElementById('wpayHome').append(walletPacks());
(function(){const k=KS.get();if(!k)return;fetch('/credits/balance',{headers:{'X-RugRadar-Key':k}}).then(r=>r.json()).then(j=>{if(j&&j.known)pill(j.credits)}).catch(()=>{})})();
`;

function page(d: WebDeps, promo = false) {
  const U = d.publicUrl, p = d.priceUsd, FC = promo ? FREE_COPY_PROMO : FREE_COPY;
  const fast = d.speed ? `~${Math.round(d.speed.x)}x` : null;
  const faq = [
    ["Is RugRadar free?", `People get ${FC} ${promo ? "The free full report includes the live chart, dev and sniper wallets, biggest buys and sells and the sell test." : "The free check gives a 0-100 risk score with plain danger warnings and basic checks only; the full report adds the live chart, dev and sniper wallets, biggest buys and sells and the sell test."} Prepaid credits cost $${p} per full report (buy 1 to 1,000). Agents pay $${p} per call via x402 or use a credit key.`],
    ["Which chains does the rug check support?", "Solana (including pump.fun tokens), BNB Chain (four.meme), Base, Ethereum and Arbitrum. Chain is detected from the address."],
    ["What does the full report add?", "More danger warnings that free checkers usually miss, in plain words, plus a can-you-sell result."],
    ["What does a low score mean?", "No danger warnings were found in public on-chain data. Danger warnings only \u00b7 based on public on-chain data."],
  ];
  const ld = [
    { "@context": "https://schema.org", "@type": "SoftwareApplication", name: "RugRadar", applicationCategory: "FinanceApplication", operatingSystem: "Web", url: `${U}/rugradar`, image: `${U}/rugradar/rug-radar-512.png`,
      description: "Free Solana rug check and honeypot checker: 0-100 token risk score with plain danger warnings for Solana, BNB, Base, Ethereum and Arbitrum.", offers: { "@type": "Offer", price: p, priceCurrency: "USD" } },
    { "@context": "https://schema.org", "@type": "FAQPage", mainEntity: faq.map(([q, a]) => ({ "@type": "Question", name: q, acceptedAnswer: { "@type": "Answer", text: a } })) },
  ];
  const cfg = { u: U, offer: unlockOffer(U, p), warn: WARN, head: HEAD, lim: [...LIMITED_CHECKS], chains: CHAIN_NAME, p, cta: `Unlock full report - $${p}`, promo };
  const swapJs = d.swap?.enabled ? "\n" + swapClientJs(d.swap) + "\nconst SWAPHOOK=swapBox;" : "";
  const json = (o: unknown) => JSON.stringify(o).replace(/</g, "\\u003c");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>RugRadar: Free Solana Rug Check & Honeypot Checker</title>
<meta name="description" content="Free rug pull checker and honeypot check for new tokens on Solana (pump.fun), BNB, Base, Ethereum and Arbitrum. Paste a token address, get a 0-100 risk score with plain danger warnings. 1 free check every day.">
<link rel="canonical" href="${U}/rugradar"><link rel="icon" href="/favicon.ico"><link rel="icon" type="image/png" sizes="32x32" href="/rugradar/rug-radar-32.png"><link rel="apple-touch-icon" href="/rugradar/rug-radar-192.png">
<meta property="og:type" content="website"><meta property="og:title" content="RugRadar: free rug check & honeypot checker"><meta property="og:description" content="0-100 token risk score with plain danger warnings. Solana, BNB, Base, Ethereum, Arbitrum."><meta property="og:url" content="${U}/rugradar"><meta property="og:image" content="${U}/rugradar/preview-x402-v2.png"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630"><meta name="twitter:card" content="summary_large_image"><meta name="twitter:image" content="${U}/rugradar/preview-x402-v2.png">
<script type="application/ld+json">${json(ld)}</script>
<style>${CSS_BASE}
${CSS_PAGE}</style></head><body><div class="wrap">
<header><a class="logo" href="/rugradar"><img src="/rugradar/rug-radar-64.png" alt="" width="28" height="28">RugRadar</a><a class="pill" id="credpill" href="#credits">Credits \u00b7 Buy</a></header>
<section class="hero" aria-label="Token checker">
<h1>Is this token a rug? Check before you buy.</h1>
<p>Paste an address. Plain danger warnings in seconds.</p>
<form id="f" class="search"><span class="tw"><input id="tok" name="token" required autocomplete="off" spellcheck="false" placeholder="Token address (Solana mint or 0x contract)" aria-label="Token address"><button type="button" id="clr" class="clr" aria-label="Clear" hidden>\u00d7</button></span><button class="btn pri" id="go">Check token</button></form>
<div class="subrow"><select id="chain" class="chainchip" aria-label="Chain" title="Chain: Auto-detect (Solana, Base, BNB, Ethereum, Arbitrum)"><option value="auto">Auto \u25BE</option>${CHAINS.map((c) => `<option value="${c}">${CHAIN_NAME[c]}</option>`).join("")}</select><span class="trust">Free \u00b7 no sign-up</span></div>
<details class="keyd" id="keyd"><summary>Have a credit key?</summary><input id="key" type="password" placeholder="Credit key (rr_...)" autocomplete="off" aria-label="Credit key"><small id="keybox" hidden></small></details>
<details class="keyd" id="wald"><summary>Connect wallet to see your past checks</summary><div id="walbox"></div></details>
<select id="recent" class="chainchip" hidden aria-label="Recent full reports"></select>
<small id="quota"></small>
</section>
<div class="grid" style="margin-top:14px">
<main><div id="out" aria-live="polite"></div></main>
<aside><section class="card cred" aria-label="Prepaid credits">
<h2 id="credits">${fast ? `Prepaid credits finish checks ${fast} faster` : "Prepaid credits"}</h2>
<p class="mut">$${p} per full report \u00b7 buy 1 to 1,000 \u00b7 no account.</p>
<button class="linkbtn" id="buyc" type="button">${fast ? `Buy credits: results ${fast} faster` : "Buy credits"}</button>
<p class="note">${d.speed ? `With credits you don't wait on a payment for each check (measured ~${d.speed.x}x faster).` : "With credits you don't wait on a payment for each check."}</p>
<div id="buyx" hidden><div id="wpayHome"></div><small class="mut">Agents and scripts: pay once with any x402 client: <code>GET ${U}/credits/buy?credits=${UNLOCK_CREDITS}</code> ($${(UNLOCK_CREDITS * Number(p)).toFixed(2)}). You get a secret key once; paste it under "Have a credit key?" or send it as <code>X-RugRadar-Key</code>.</small></div>
<div style="margin-top:6px;font-size:13px"><a href="#agents">For developers \u203a</a></div>
</section></aside>
</div>
${devSection(U, p, d.researchPrices ?? RESEARCH_DEFAULTS)}
<details class="fold"><summary>How RugRadar works</summary><p class="mut">We turn public on-chain and market data into a 0-100 risk score with plain danger warnings. Danger warnings only \u00b7 based on public on-chain data.</p>${faq.map(([q, a]) => `<h3 style="font-size:15px;margin:12px 0 2px">${q}</h3><p class="mut" style="margin:0">${a}</p>`).join("")}</details>
<footer>RugRadar \u00b7 Danger warnings only \u00b7 based on public on-chain data; it never labels people.</footer>
</div>
<script>const CFG=${json(cfg)};
${PAGE_JS}${swapJs}
</script></body></html>`;
}



// ---------- "For bots & agents" section (static, no extra requests) ----------
const escH = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
export const EXAMPLE_MINT = "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN";
export function agentSnippets(U: string) {
  return {
    mcpConfig: `{ "mcpServers": { "rugradar": { "url": "${U}/mcp" } } }`,
    mcpList: `curl -s ${U}/mcp -H 'content-type: application/json' \\\n  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`,
    x402: `# 1) call without payment -> HTTP 402 + PAYMENT-REQUIRED header (base64 JSON)\ncurl -s -o /dev/null -D - "${U}/rug-check?token=${EXAMPLE_MINT}" \\\n  | grep -i '^payment-required:' | cut -d' ' -f2 | tr -d '\\r' | base64 -d\n# 2) pick an accepts[] entry (USDC on Solana/Base/...), sign it, retry with header PAYMENT-SIGNATURE\n#    (any x402 client does steps 1-2: @x402/fetch, @x402/axios, x402 Python, CDP Agentic Wallet)`,
    credits: `# buy 10 credits once (x402, $0.10) -> {"key":"rr_..."}; or buy with Phantom/Solflare on this page\ncurl -s -H "X-RugRadar-Key: rr_YOURKEY" "${U}/rug-check?token=${EXAMPLE_MINT}"\ncurl -s -H "X-RugRadar-Key: rr_YOURKEY" ${U}/credits/balance\n# 24h watch with credits (5 credits):\ncurl -s -X POST ${U}/rugradar/watch -H "X-RugRadar-Key: rr_YOURKEY" \\\n  -H 'content-type: application/json' -d '{"token":"<mint>","hours":"24","webhook":"https://you.example/hook"}'`,
    node: `const crypto = require("crypto");\n// raw = exact request body string, header = X-RugRadar-Signature, secret = whsec_... from the watch\nfunction verify(raw, header, secret) {\n  const m = /^t=(\\d+),v1=([0-9a-f]{64})$/.exec(header || ""); if (!m) return false;\n  if (Math.abs(Date.now() / 1000 - Number(m[1])) > 300) return false;\n  const want = crypto.createHmac("sha256", secret).update(m[1] + "." + raw).digest();\n  return crypto.timingSafeEqual(want, Buffer.from(m[2], "hex"));\n}`,
    embed: `<iframe src="${U}/rugradar/embed?token=<mint or 0x address>" width="380" height="420" style="border:0;max-width:100%" loading="lazy" title="RugRadar token risk"></iframe>`,
    embedJson: `curl -s "${U}/rugradar/embed.json?token=${EXAMPLE_MINT}"\n# -> {"riskScore":0,"riskLevel":"low","verdict":"No danger warnings found.","warnings":[...],"report":"${U}/rugradar?token=..."}`,
    python: `import hmac, hashlib, re, time\ndef verify(raw: bytes, header: str, secret: str) -> bool:\n    m = re.fullmatch(r"t=(\\d+),v1=([0-9a-f]{64})", header or "")\n    if not m or abs(time.time() - int(m[1])) > 300: return False\n    want = hmac.new(secret.encode(), m[1].encode() + b"." + raw, hashlib.sha256).hexdigest()\n    return hmac.compare_digest(want, m[2])`,
  };
}
export const DEV_MINT = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
function devSection(U: string, p: string, rp = RESEARCH_DEFAULTS) {
  const cp = (t: string) => `<div class="cpw"><button class="cpb" type="button" aria-label="Copy code">Copy</button><pre>${escH(t)}</pre></div>`;
  const iframe = `<iframe src="${U}/rugradar/embed?token=${DEV_MINT}" width="380" height="420" style="border:0;max-width:100%" loading="lazy" title="RugRadar token risk"></iframe>`;
  const curl = `curl -s "${U}/rugradar/embed.json?token=${DEV_MINT}"\n# -> {"riskScore":..,"riskLevel":"..","verdict":"..","warnings":[..],"reportUrl":"${U}/rugradar?token=.."}`;
  const payEx = `# one-time: x402 pays per call (USDC); any x402 client does the 402 -> sign -> retry
curl -s "${U}/rug-check?token=${DEV_MINT}"   # 402 + PAYMENT-REQUIRED header
# repeat use: buy credits once (x402, 10 credits = $0.10) -> {"key":"rr_..."}, then:
curl -s -H "X-RugRadar-Key: rr_YOURKEY" "${U}/rug-check?token=${DEV_MINT}"`;
  const c = agentSnippets(U), pre = (t: string) => `<pre>${escH(t)}</pre>`;
  const tools: [string, string, string][] = [
    ["rug_check", "Overall rug-pull report: 0-100 score, danger warnings and a buyer summary (Solana incl. pump.fun, BNB, Base, Ethereum, Arbitrum)", `$${p}`],
    ["token_safety", "Safety breakdown: mint/freeze authority, holders, liquidity, age, dev holding/sold, snipers, bundles, volume vs market cap, socials", `$${p}`],
    ["honeypot_check", "Can I sell it? Simulated buy/sell and tax on EVM; live sell quote plus freeze/mint and transfer controls on Solana", `$${p}`],
    ["watch_token", "Watch one Solana token; signed webhook alert on dev sells, liquidity drop, new mint/freeze authority, score jump, can't sell", "$0.05 / 24h, $0.10 / 48h"],
    ["research_brief", "Cited brief for a question (not a token check)", rp.report],
    ["read_page", "https URL to clean Markdown", rp.read],
    ["news_search", "Recent headlines and links on a topic", rp.news],
    ["token_price", "On-chain USD price + 24h change (not a rug check)", rp.price],
  ];
  const eps: [string, string][] = [
    [`GET /rug-check?token=&lt;mint|0x&gt;[&amp;chain=]`, `$${p}`], [`GET /token-safety?token=…`, `$${p}`], [`GET /honeypot-check?token=…`, `$${p}`],
    [`GET /watch?token=&lt;mint&gt;&amp;hours=24|48&amp;webhook=&lt;https url&gt;`, "$0.05 (24h) / $0.10 (48h)"], [`GET /credits/buy?credits=N`, `$${p} per credit (1-1000)`],
  ];
  const row = (cells: string[]) => `<tr>${cells.map((x) => `<td>${x}</td>`).join("")}</tr>`;
  return `<details class="fold dev agents" id="developers"><summary>For developers</summary><div id="agents">
<p><b>Card (iframe).</b> Free, danger warnings only. Swap in any Solana mint or 0x address.</p>${cp(iframe)}
<p><b>JSON (free check).</b> Score, verdict, top 3 warnings and a report link.</p>${cp(curl)}
<p><b>Paid full report: pay once, or repeat with a key.</b> One-time x402 payment, or buy credits once and send the key on every call:</p>${cp(payEx)}
<p><b>MCP server</b> (streamable HTTP, JSON): <code>${U}/mcp</code>. Add it to any MCP client:</p>${pre(c.mcpConfig)}
<table>${tools.map(([n, d, pr]) => row([`<code>${n}</code>`, escH(d), pr])).join("")}</table>
<p>Pass a credit key (<code>api_key</code> or header <code>X-RugRadar-Key</code>); without one, a tool returns the x402 payment requirement. List tools:</p>${pre(c.mcpList)}
<p><b>x402 endpoints</b> (USDC on Solana, Base, Polygon, Arbitrum and more; no signup):</p><table>${eps.map(([e, pr]) => row([`<code>${e}</code>`, pr])).join("")}</table>
<p>The 402 flow:</p>${pre(c.x402)}
<p><b>Credit keys</b> skip the x402 round trip:</p>${pre(c.credits)}
<p><b>Embed the RugRadar card</b> (about 360 px, free check data, danger warnings only). Paste on any page:</p>${pre(c.embed)}<p>Or fetch the same data as JSON (score, verdict, top 3 warning titles, report link):</p>${pre(c.embedJson)}
<p><b>Webhook signature</b>: header <code>X-RugRadar-Signature: t=&lt;unix&gt;,v1=&lt;hex&gt;</code>, HMAC-SHA256 of <code>t + "." + rawBody</code> with your watch secret. Node:</p>${pre(c.node)}<p>Python:</p>${pre(c.python)}
<p><small>Discovery: <a href="/.well-known/x402">/.well-known/x402</a> · <a href="/openapi.json">/openapi.json</a> · <a href="/llms.txt">/llms.txt</a>. The full report costs $${p} per check with prepaid credits (header <code>X-RugRadar-Key</code>) or x402. Danger warnings only.</small></p></div></details>`;
}


// ---------- embed card + JSON (free check data, danger warnings only) ----------
const escA = (t: unknown) => String(t ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const VERDICT: Record<string, [string, string]> = { high: ["HIGH RISK", "Strong rug warning signs."], medium: ["CAUTION", "Some rug warning signs."], low: ["NO WARNINGS", "No danger warnings found."] };
export type EmbedData = { product: "RugRadar"; report: "free"; token: string; chain: string; riskScore: number; riskLevel: string; label: string; verdict: string; warnings: { severity: string; title: string; line: string }[]; moreWarnings: number; reportUrl: string; generatedAt: string };
const embedCache = new Map<string, { at: number; v: EmbedData }>();
let embedBusy = 0;
const embedHits = new Map<string, number[]>();
export function __resetEmbed() { embedCache.clear(); embedHits.clear(); embedBusy = 0; }
export async function embedData(d: WebDeps, token: string, chain: string): Promise<EmbedData> {
  const k = `${chain}:${token}`, hit = embedCache.get(k);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.v;
  if (embedBusy >= 3) throw Object.assign(new Error("busy"), { code: "busy" });
  embedBusy++;
  try {
    const full = await d.rugCheck(token, chain), l = limitedReport(full);
    const degraded = !!full?.facts?.marketUnknown || (chain === "solana" && full?.facts?.ageHours == null);
    const ws = warningsOf(l.checks, l.warnDetails), lv = shownLevel(l.riskLevel, ws), verdict = VERDICT[lv]![1];
    const v: EmbedData = { product: "RugRadar", report: "free", token, chain, riskScore: l.riskScore, riskLevel: lv, label: VERDICT[lv]![0], verdict,
      warnings: ws.slice(0, 3).map((w) => ({ severity: w.sev, title: w.title, line: w.line })), moreWarnings: Math.max(0, ws.length - 3) + (Number(l.hiddenWarnings) || 0),
      reportUrl: `${d.publicUrl}/rugradar?token=${encodeURIComponent(token)}&chain=${chain}`, generatedAt: new Date().toISOString() };
    if (!degraded) { embedCache.set(k, { at: Date.now(), v }); primeShare(shareData(l, ws, lv, token, chain)); } if (embedCache.size > 300) embedCache.delete(embedCache.keys().next().value!);
    return v;
  } finally { embedBusy--; }
}
function embedLimited(ip: string, now = Date.now()) {
  const xs = (embedHits.get(ip) ?? []).filter((t) => now - t < 10 * 60_000); xs.push(now); embedHits.set(ip, xs);
  if (embedHits.size > 5000) embedHits.delete(embedHits.keys().next().value!);
  return xs.length > 60;
}
const EMBED_CSS = `body{margin:0;padding:8px;background:transparent;color:var(--tx);font:15px/1.4 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
.emb{width:360px;max-width:100%;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:12px}
.etok{font-size:13px;color:var(--mut);margin-bottom:8px;word-break:break-all}.etok b{color:var(--tx);font-size:15px}
.emb .verdict{gap:12px;padding:12px;border-radius:12px}.emb .gauge{width:88px;height:88px}.emb .gauge i{width:66px;height:66px;font-size:28px}.emb .gauge i small{font-size:10px}
.emb .vt{font-size:20px}.emb .vl{font-size:14px;margin-top:3px}
.emb .wcards{gap:6px;margin:8px 0}.emb .wc summary{gap:8px;padding:8px 10px;font-size:14px}.emb .wc p{padding:0 10px 8px;font-size:13px;white-space:normal}.emb .sev{font-size:10px;padding:2px 6px}
.efoot{flex-wrap:wrap;display:flex;justify-content:space-between;align-items:center;gap:8px;font-size:12px;color:var(--mut)}.efoot a{font-weight:700;font-size:13px;white-space:nowrap}.credit{font-size:11px;color:#6f7990}.emsg{font-size:14px;margin:6px 0}`;
function embedHtml(U: string, v: EmbedData | null, msg?: string, priceUsd = "0.02") {
  const price = priceUsd.startsWith("$") ? priceUsd : `$${priceUsd}`;
  const body = v
    ? `<div class="etok"><b>${escA(v.token.slice(0, 4))}\u2026${escA(v.token.slice(-6))}</b> \u00b7 ${escA(CHAIN_NAME[v.chain] ?? v.chain)} \u00b7 free check</div>
<div class="verdict v-${v.riskLevel}"><div class="gauge g-${v.riskLevel}" style="--p:${v.riskLevel === "low" ? 100 : Math.max(4, Math.min(100, v.riskScore))}"><i>${v.riskScore}<small>/100</small></i></div><div><div class="vt ${v.riskLevel}">${v.label}</div><div class="vl">${escA(v.verdict)}</div></div><div class="vfree">Free check: basic warnings only. Full report unlocks more.</div></div>
${v.warnings.length ? `<div class="wcards">${v.warnings.map((w) => `<details class="wc ${w.severity === "DANGER" ? "d" : "c"}"><summary><span class="sev ${w.severity === "DANGER" ? "s3" : "s2"}">${w.severity}</span><span class="tt">${escA(w.title)}</span><span class="ch"></span></summary><p>${escA(w.line)}</p></details>`).join("")}</div>` : ""}
${v.moreWarnings > 0 ? `<div class="emsg"><b>+${v.moreWarnings} more warning${v.moreWarnings > 1 ? "s" : ""} in the full report</b></div>` : ""}
<div class="efoot"><a href="${escA(v.reportUrl)}" target="_blank" rel="noopener">Unlock live chart + full report - ${price} \u203a</a><span class="credit">Danger warnings only \u00b7 based on public on-chain data \u00b7 <b>RugRadar</b></span></div>`
    : `<p class="emsg">${escA(msg ?? "Add ?token=<address> to show a RugRadar card.")}</p><div class="efoot"><a href="${U}/rugradar" target="_blank" rel="noopener">Check a token \u203a</a><span class="credit">Danger warnings only \u00b7 based on public on-chain data \u00b7 <b>RugRadar</b></span></div>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>RugRadar token risk card</title>
<style>${CSS_BASE}
${EMBED_CSS}</style></head><body><div class="emb">${body}</div></body></html>`;
}
async function embedFor(d: WebDeps, req: Request): Promise<{ status: number; v: EmbedData | null; msg?: string; error?: string }> {
  const token = String(req.query.token ?? "").trim(); let chain = String(req.query.chain ?? "auto").trim().toLowerCase();
  if (!token) return { status: 400, v: null, error: "invalid_input", msg: "Add ?token=<address> to show a RugRadar card." };
  if (chain === "auto" || !chain) chain = token.startsWith("0x") ? (validToken(token, "base") ? await (d.detectChain ?? detectEvmChain)(token) : "base") : "solana";
  if (!CHAINS.includes(chain) || !validToken(token, chain)) return { status: 400, v: null, error: "invalid_input", msg: "That is not a token address RugRadar can check." };
  if (embedLimited(ipOf(req)) && !embedCache.has(`${chain}:${token}`)) return { status: 429, v: null, error: "slow_down", msg: "Too many checks right now. Try again in a few minutes." };
  try { return { status: 200, v: await embedData(d, token, chain) }; }
  catch (e: any) { return e?.code === "busy" ? { status: 503, v: null, error: "busy", msg: "RugRadar is busy. Try again in a moment." } : { status: 422, v: null, error: "check_failed", msg: "Could not check this token right now." }; }
}

// ---------- MCP (streamable HTTP, JSON responses, stateless) ----------
const RESEARCH_DEFAULTS = { report: "$0.01", read: "$0.004", news: "$0.004", price: "$0.001" };
const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const PAY_CREDITS = "Invalid or failed calls are not charged (a used credit is refunded). With no usable credit key, the tool returns error=payment_required and the x402 Payment Required challenge for its HTTP route; pay that USDC amount, then retry the URL.";
const PAY_X402 = "Invalid or failed calls are not charged. With no payment, the tool returns error=payment_required and the x402 Payment Required challenge for the HTTP route; pay that USDC amount, then retry the URL.";
const FREE_NOTE = "The /rugradar website gives 1 free check every day per visitor; this MCP tool is paid.";
const OUT_ERR = {
  type: "object",
  description: "Error or payment-required result. Failed and invalid calls are not charged.",
  properties: {
    error: { type: "string", description: "payment_required, bad_input, or a failure code" },
    message: { type: "string" },
    priceUsd: { description: "USDC price to pay when error is payment_required" },
    payWith: { type: "object", description: "x402 payment requirement for the HTTP route, plus credit-key instructions when those apply" },
    refunded: { type: "boolean", description: "true when a credit was taken and then returned because the call failed" },
  },
};
function outSchema(successProps: Record<string, unknown>, required: string[] = []) {
  return { type: "object", description: "Success fields on a paid/authorized call, or error/payment_required fields. Additional properties may be present.", properties: { ...successProps, ...OUT_ERR.properties }, required, additionalProperties: true };
}
function rugMcpTools(price: string) {
  const p = price.startsWith("$") ? price : `$${price}`;
  const rugOut = outSchema({
    token: { type: "string" }, chain: { type: "string" },
    riskScore: { type: "number", description: "0-100 risk score" },
    riskLevel: { type: "string" },
    tensionLine: { type: ["string", "null"], description: "One short token-specific danger line (max 140 chars) that leads the result; null when nothing is flagged" },
    reasons: { type: "array", items: { type: "string" }, description: "Plain danger warnings" },
    buyerSummary: { type: "string", description: "Buyer-facing summary of the overall report" },
    facts: { type: "object", description: "Named safety fields (authority, holders, liquidity, age, and related public facts)" },
    shareUrl: { type: "string" }, paidWith: { type: "string" }, credits_remaining: { type: "number" },
  });
  return [
    { name: "rug_check", description: `Use for an overall rug-pull report on one token (Solana incl. pump.fun, BNB, Base, Ethereum or Arbitrum): 0-100 risk score, plain danger warnings, and a buyer summary. Use this instead of token_safety when you want the overall report and buyer summary rather than a field-by-field authority/holder/liquidity breakdown. For sellability only, use honeypot_check. ${p} per check; pass a RugRadar credit key (api_key or header X-RugRadar-Key) or pay the x402 requirement. If chain is omitted, Solana mints default to solana and 0x addresses default to base. ${FREE_NOTE} ${PAY_CREDITS}`, inputSchema: schema, outputSchema: rugOut, annotations: RO },
    { name: "token_safety", description: `Use when you need a field-by-field token-safety breakdown of one token: mint/freeze authority, holder concentration, liquidity, age, dev holding/sold, snipers, bundles, volume vs market cap, and socials, plus a 0-100 risk score. Use this instead of rug_check when you need those named fields rather than the overall buyer-summary report. For "can I sell this?", use honeypot_check. Same price as rug_check (${p}). If chain is omitted, Solana mints default to solana and 0x addresses default to base. ${FREE_NOTE} ${PAY_CREDITS}`, inputSchema: schema, outputSchema: rugOut, annotations: RO },
    { name: "honeypot_check", description: `Use to answer "can I sell this token?": simulated buy/sell and tax on EVM; live Jupiter sell quote plus freeze/mint authority and token-2022 transfer controls on Solana; 0-100 risk score. Use this instead of rug_check or token_safety when sellability is the only question; for a full rug report use rug_check; for a field-by-field authority/holder/liquidity breakdown use token_safety. ${p} per check. If chain is omitted, Solana mints default to solana and 0x addresses default to base. ${FREE_NOTE} ${PAY_CREDITS}`, inputSchema: schema, outputSchema: rugOut, annotations: RO },
  ];
}
function researchMcpTools(rp: { report: string; read: string; news: string; price: string }) {
  return [
    { name: "research_brief", description: `Use when you need a cited research brief on a question (not a token rug check). Returns a short answer, key points and sources. ${rp.report} per call via x402 on GET /report?q=. No RugRadar credit key, and no free daily check. depth defaults to standard (more sources, can take longer) at the same price; pass quick for a shorter brief with fewer sources. lang defaults to en. For a URL's text use read_page; for recent headlines use news_search. ${PAY_X402}`, inputSchema: { type: "object", properties: { q: { type: "string", description: "Question or topic (2-300 chars)" }, lang: { type: "string", description: "default en; sources and wording prefer this language when available" }, depth: { type: "string", enum: ["quick", "standard"], description: "default standard. standard uses more sources and can take longer, same ${rp.report} price; quick is shorter with fewer sources" } }, required: ["q"] }, outputSchema: outSchema({ answer: { type: "string" }, key_points: { type: "array" }, sources: { type: "array" }, depth: { type: "string" }, lang: { type: "string" }, query: { type: "string" } }), annotations: RO },
    { name: "read_page", description: `Use when you already have an https URL and need its text as clean Markdown (title, headings, links). Not a web search and not a token check. ${rp.read} per call via x402 on GET /read?url=. No free daily check. maxChars defaults to 20000 (allowed 1000-100000); if the Markdown is longer it is cut at that limit and truncated=true. Non-https URLs are rejected and not charged. ${PAY_X402}`, inputSchema: { type: "object", properties: { url: { type: "string", description: "https URL to read; non-https is rejected and not charged" }, maxChars: { type: "number", description: "max markdown chars (default 20000, min 1000, max 100000). Longer text is cut and truncated=true" } }, required: ["url"] }, outputSchema: outSchema({ url: { type: "string" }, finalUrl: { type: "string" }, title: { type: "string" }, markdown: { type: "string" }, headings: { type: "array" }, links: { type: "array" }, truncated: { type: "boolean", description: "true when markdown was cut at maxChars or the fetch was size-capped" }, wordCount: { type: "number" } }), annotations: RO },
    { name: "news_search", description: `Use for recent news headlines and links on a topic (last 1-7 days). Headlines only — use read_page for full article text. ${rp.news} per call via x402 on GET /news?q=. No free daily check. hours is the lookback window (1-168, default 72); limit caps how many headlines are returned (1-25, default 10). An empty or unmatched query is not charged. ${PAY_X402}`, inputSchema: { type: "object", properties: { q: { type: "string", description: "Keywords (2-200 chars)" }, hours: { type: "number", description: "Lookback window in hours, 1-168, default 72" }, limit: { type: "number", description: "Max headlines to return, 1-25, default 10" } }, required: ["q"] }, outputSchema: outSchema({ query: { type: "string" }, hours: { type: "number" }, count: { type: "number" }, articles: { type: "array", description: "Headlines and links only" } }), annotations: RO },
    { name: "token_price", description: `Use for a verifiable USD price and 24h change of a token (symbol, 0x address, or Solana mint). Not a rug or honeypot check — use rug_check or honeypot_check for danger warnings. ${rp.price} per call via x402 on GET /price?token=. No free daily check. If a symbol or 0x address exists on more than one chain, pass chain (ethereum, base, arbitrum, polygon, solana); Solana mints use solana. Unknown or unpriced tokens return an error and are not charged. ${PAY_X402}`, inputSchema: { type: "object", properties: { token: { type: "string", description: "Symbol, 0x address or Solana mint" }, chain: { type: "string", enum: ["ethereum", "base", "arbitrum", "polygon", "solana"], description: "optional: ethereum, base, arbitrum, polygon, solana. Pass it when the identifier exists on more than one chain; Solana mints use solana" } }, required: ["token"] }, outputSchema: outSchema({ priceUsd: { type: "number" }, change24hPct: { type: "number" }, token: { type: "string" }, chain: { type: "string" } }), annotations: RO },
  ];
}
const TITLES: Record<string, string> = { rug_check: "Rug Check (overall report)", token_safety: "Token Safety Breakdown", honeypot_check: "Honeypot / Can I Sell Check", research_brief: "Cited Research Brief",
  read_page: "Read Web Page as Markdown", news_search: "Recent News Search", token_price: "Token USD Price", watch_token: "Start Token Watch + Alert", list_watches: "List My Token Watches", cancel_watch: "Cancel a Token Watch" };
const EXAMPLES: Record<string, Record<string, unknown[]>> = {
  rug_check: { token: [EXAMPLE_MINT, "0x532f27101965dd16442E59d40670FaF5eBB142E4"], chain: ["solana", "base"] }, token_safety: { token: [EXAMPLE_MINT], chain: ["solana"] }, honeypot_check: { token: ["0x532f27101965dd16442E59d40670FaF5eBB142E4"], chain: ["base"] },
  research_brief: { q: ["What is retrieval-augmented generation?"] }, read_page: { url: ["https://x402.org"] }, news_search: { q: ["solana memecoin"] }, token_price: { token: ["JUP", "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"], chain: ["solana", "base"] },
  watch_token: { token: [EXAMPLE_MINT], hours: ["24"], webhook_url: ["https://example.com/rugradar-hook"] }, cancel_watch: { watch_id: ["w_AbCdEfGhIjKl"] },
};
const LIST_WATCHES_TOOL = { name: "list_watches", description: "Use to see the Watch + Alert watches started with your RugRadar credit key (api_key or header X-RugRadar-Key): watchId, token, status (active, expired, cancelled), expiry, destination and alert count, newest first. Read-only and free: it never spends a credit or starts a check. Only watches paid with that same credit key are listed; watches paid per-call with x402 are not tied to a key and do not appear (use the watchId and secret you got back for those). To start a watch use watch_token; to stop one use cancel_watch.",
  inputSchema: { type: "object", properties: { api_key: { type: "string", description: "RugRadar credit key used to start the watches (or header X-RugRadar-Key)" } }, required: [] },
  outputSchema: outSchema({ watches: { type: "array", items: { type: "object", properties: { watchId: { type: "string" }, token: { type: "string" }, chain: { type: "string" }, status: { type: "string", enum: ["active", "expired", "cancelled"] }, hours: { type: "number" }, createdAt: { type: "string" }, expiresAt: { type: "string" }, destination: { type: "object" }, checks: { type: "number" }, alerts: { type: "number" } } } }, count: { type: "number" } }),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } };
const CANCEL_WATCH_TOOL = { name: "cancel_watch", description: "Use to stop one Watch + Alert watch that was started with your RugRadar credit key; pass its watch_id (from watch_token or list_watches) and the same key (api_key or header X-RugRadar-Key). Alerts stop right away and the watch cannot be restarted. No refund: credits spent on the watch are not returned, even if hours remain. Free to call. Cancelling an already cancelled or expired watch returns its current status and changes nothing. A watch started with a different key, or paid per-call with x402, returns not_found.",
  inputSchema: { type: "object", properties: { watch_id: { type: "string", description: "Watch id (w_...) from watch_token or list_watches" }, api_key: { type: "string", description: "RugRadar credit key that started the watch (or header X-RugRadar-Key)" } }, required: ["watch_id"] },
  outputSchema: outSchema({ watchId: { type: "string" }, token: { type: "string" }, status: { type: "string" }, expiresAt: { type: "string" }, refunded: { type: "boolean", description: "Always false: cancelling never refunds credits" }, message: { type: "string" } }),
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false } };
function decorate(t: any) {
  const ex = EXAMPLES[t.name] ?? {}, props = t.inputSchema?.properties ?? {};
  const p2: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(props)) p2[k] = ex[k] ? { ...(v as object), examples: ex[k] } : v;
  const title = TITLES[t.name] ?? t.name;
  return { ...t, title, inputSchema: { ...t.inputSchema, properties: p2 }, annotations: { title, ...(t.annotations ?? {}) } };
}
function mcpTools(d: WebDeps) {
  const watch = d.watch ? [WATCH_TOOL, ...(d.watch.list ? [LIST_WATCHES_TOOL] : []), ...(d.watch.cancel ? [CANCEL_WATCH_TOOL] : [])] : [];
  return [...rugMcpTools(d.priceUsd), ...researchMcpTools(d.researchPrices ?? RESEARCH_DEFAULTS), ...watch].map(decorate);
}
const WATCH_TOOL = { name: "watch_token", description: "Use to start a Watch + Alert on one Solana token, not for a one-shot check (use rug_check, token_safety, or honeypot_check for those). hours=24 costs $0.05 (5 credits); hours=48 costs $0.10 (10 credits); hours defaults to 24. Re-checked about every 10 min; signed webhook alert when the dev sells, liquidity drops 30%+, mint/freeze authority appears, risk score jumps 20+ points, or it can't be sold. Each call starts a new paid watch (not idempotent) and returns watchId, expiry, and destination. To see or stop watches started with your credit key, use list_watches or cancel_watch. Pass a RugRadar credit key (api_key or header X-RugRadar-Key); without one the tool returns the x402 payment requirement for GET /watch. telegram_chat_id is not available yet — use webhook_url for signed JSON POST alerts. Invalid or failed creates are not charged. No free daily check on this tool.",
  inputSchema: { type: "object", properties: { token: { type: "string", description: "Solana mint address (this tool is Solana only)" }, hours: { type: "string", enum: ["24", "48"], description: "default 24. 24 = $0.05 (5 credits); 48 = $0.10 (10 credits)" }, webhook_url: { type: "string", description: "https URL for signed JSON POST alerts" }, telegram_chat_id: { type: "string", description: "Telegram chat id (not available yet; use webhook_url)" }, api_key: { type: "string", description: "RugRadar credit key (or header X-RugRadar-Key)" } }, required: ["token"] },
  outputSchema: outSchema({ watchId: { type: "string", description: "Id of the new watch" }, token: { type: "string" }, chain: { type: "string" }, status: { type: "string" }, hours: { type: "number" }, createdAt: { type: "string" }, expiresAt: { type: "string" }, destination: { type: "object" }, checkEveryMin: { type: "number" } }),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } };
const ROUTE: Record<string, string> = { rug_check: "/rug-check", token_safety: "/token-safety", honeypot_check: "/honeypot-check" };
const schema = { type: "object", properties: { token: { type: "string", description: "Solana mint or EVM 0x token contract" }, chain: { type: "string", enum: CHAINS, description: "Omit to default: solana for Solana mints, base for 0x addresses. Allowed: solana, base, bnb, ethereum, arbitrum" }, api_key: { type: "string", description: "optional RugRadar credit key (or send header X-RugRadar-Key)" } }, required: ["token"] };

async function mcpWatch(d: WebDeps, args: any, headerKey: string | undefined) {
  const text = (o: unknown, isError = false) => ({ result: { isError, content: [{ type: "text", text: JSON.stringify(o) }], structuredContent: o } });
  if (!d.watch) return text({ error: "unavailable" }, true);
  const key = headerKey || (typeof args?.api_key === "string" ? args.api_key : "");
  if (key) {
    try { return text(await d.watch.create(key, args ?? {})); }
    catch (e: any) { if (e?.code !== "insufficient_credits") return text({ error: e?.code ?? "unavailable", message: String(e?.message ?? e) }, true); }
  }
  const q = new URLSearchParams({ token: String(args?.token ?? ""), hours: String(args?.hours ?? "24"), webhook: String(args?.webhook_url ?? "") });
  const url = `${d.publicUrl}/watch?${q}`;
  let requirement: unknown = null;
  try { const r = await fetch(url, { headers: { accept: "application/json", "user-agent": "rugradar-mcp-self (self)" }, signal: AbortSignal.timeout(5000) }); const h = r.headers.get("payment-required"); requirement = h ? JSON.parse(Buffer.from(h, "base64").toString()) : null; } catch {}
  return text({ error: "payment_required", ...d.watch.config(), payWith: { x402: { url, method: "GET", paymentRequired: requirement }, credits: { buy: `${d.publicUrl}/credits/buy?credits=10`, use: "pass api_key or header X-RugRadar-Key" } } }, true);
}
async function mcpWatchManage(d: WebDeps, name: string, args: any, headerKey: string | undefined) {
  const text = (o: unknown, isError = false) => ({ result: { isError, content: [{ type: "text", text: JSON.stringify(o) }], structuredContent: o } });
  if (!d.watch?.list || !d.watch?.cancel) return text({ error: "unavailable" }, true);
  const key = headerKey || (typeof args?.api_key === "string" ? args.api_key : "");
  if (!key || key.length > 200) return text({ error: "missing_key", message: "Pass the RugRadar credit key that started the watch (api_key or header X-RugRadar-Key)." }, true);
  try {
    if (name === "list_watches") return text(await d.watch.list(key));
    const id = String(args?.watch_id ?? "").trim();
    if (!/^w_[A-Za-z0-9_-]{4,40}$/.test(id)) return text({ error: "bad_input", message: "watch_id is required (w_...)" }, true);
    return text(await d.watch.cancel(key, id));
  } catch (e: any) { return text({ error: e?.code ?? "unavailable", message: String(e?.message ?? e) }, true); }
}
async function mcpResearch(d: WebDeps, name: string, args: any) {
  const text = (o: unknown, isError = false) => ({ result: { isError, content: [{ type: "text", text: JSON.stringify(o) }], structuredContent: o } });
  const rp = d.researchPrices ?? RESEARCH_DEFAULTS;
  const specs: Record<string, { path: string; price: string; required: [string, string]; extra?: Record<string, (a: any) => string | undefined> }> = {
    research_brief: { path: "/report", price: rp.report, required: ["q", "q is required (2-300 chars)"], extra: { lang: (a) => a?.lang, depth: (a) => a?.depth } },
    read_page: { path: "/read", price: rp.read, required: ["url", "url is required (https)"], extra: { maxChars: (a) => a?.maxChars != null ? String(a.maxChars) : undefined } },
    news_search: { path: "/news", price: rp.news, required: ["q", "q is required (2-200 chars)"], extra: { hours: (a) => a?.hours != null ? String(a.hours) : undefined, limit: (a) => a?.limit != null ? String(a.limit) : undefined } },
    token_price: { path: "/price", price: rp.price, required: ["token", "token is required (symbol, 0x address or Solana mint)"], extra: { chain: (a) => a?.chain } },
  };
  const spec = specs[name];
  if (!spec) return { error: { code: -32602, message: `unknown tool ${name}` } };
  const [field, msg] = spec.required;
  const val = String(args?.[field] ?? "").trim();
  if (!val) return text({ error: "bad_input", message: msg }, true);
  const q = new URLSearchParams({ [field]: val });
  if (spec.extra) for (const [k, fn] of Object.entries(spec.extra)) { const v = fn(args); if (v != null && String(v).trim()) q.set(k, String(v).trim()); }
  const url = `${d.publicUrl}${spec.path}?${q}`;
  let requirement: unknown = null;
  try { const r = await fetch(url, { headers: { accept: "application/json", "user-agent": "rugradar-mcp-self (self)" }, signal: AbortSignal.timeout(5000) }); const h = r.headers.get("payment-required"); requirement = h ? JSON.parse(Buffer.from(h, "base64").toString()) : null; } catch {}
  return text({ error: "payment_required", priceUsd: spec.price, payWith: { x402: { url, method: "GET", paymentRequired: requirement } } }, true);
}
async function mcpCall(d: WebDeps, name: string, args: any, headerKey: string | undefined) {
  if (name === "watch_token") return mcpWatch(d, args, headerKey);
  if (name === "list_watches" || name === "cancel_watch") return mcpWatchManage(d, name, args, headerKey);
  if (name === "research_brief" || name === "read_page" || name === "news_search" || name === "token_price") return mcpResearch(d, name, args);
  const route = ROUTE[name];
  if (!route) return { error: { code: -32602, message: `unknown tool ${name}` } };
  const token = String(args?.token ?? "").trim();
  const chain = String(args?.chain ?? "").trim().toLowerCase() || (token.startsWith("0x") ? "base" : "solana");
  if (!token) return { result: { isError: true, content: [{ type: "text", text: "token is required" }] } };
  const key = headerKey || (typeof args?.api_key === "string" ? args.api_key : "");
  const text = (o: unknown, isError = false) => ({ result: { isError, content: [{ type: "text", text: JSON.stringify(o) }], structuredContent: o } });
  if (key) {
    const left = await d.spend(key).catch(() => null);
    if (left != null) {
      try {
        const full = await (d.paidCheck ?? d.rugCheck)(token, chain);
        primeFromLimited(limitedReport(full), token, chain);
        return text({ ...full, tensionLine: full?.tensionLine ?? null, paidWith: "credits", credits_remaining: left, shareUrl: `${d.publicUrl}/rugradar/c/${chain}/${encodeURIComponent(token)}`, freeFacts: freeFacts(full), warnDetails: warnDetails(full) });
      }
      catch (e) { await d.refund(key); return text({ error: String((e as Error).message ?? e) + (e instanceof RugBusyError ? ". You weren't charged." : ""), refunded: true }, true); }
    }
  }
  // No usable key: return the live x402 payment requirement for the HTTP endpoint.
  const url = `${d.publicUrl}${route}?token=${encodeURIComponent(token)}&chain=${chain}`;
  let requirement: unknown = null;
  try { const r = await fetch(url, { headers: { accept: "application/json", "user-agent": "rugradar-mcp-self (self)" }, signal: AbortSignal.timeout(5000) }); const h = r.headers.get("payment-required"); requirement = h ? JSON.parse(Buffer.from(h, "base64").toString()) : null; } catch {}
  return text({ error: "payment_required", priceUsd: Number(d.priceUsd), payWith: { x402: { url, method: "GET", paymentRequired: requirement }, credits: { buy: `${d.publicUrl}/credits/buy?credits=100`, use: "send header X-RugRadar-Key or pass api_key" } } }, true);
}


/** Prime the share-card cache from a limited report. Skips when market data was truly unavailable so we never cache an under-scored card. */
export function primeFromLimited(l: any, token: string, chain: string) {
  try { if (l?.facts?.marketUnknown) return; const ws = warningsOf(l.checks, l.warnDetails); primeShare(shareData(l, ws, shownLevel(l.riskLevel, ws), token, chain)); } catch {}
}
const OG_RE = /<meta property="og:type"[^\n]*?preview-x402-v2\.png">/;
function shareTarget(req: Request): { token: string; chain: string } | null {
  const token = String(req.query.t ?? req.query.token ?? "").trim(); if (!token || token.length > 64) return null;
  let chain = String(req.query.chain ?? "").trim().toLowerCase(); if (!chain) chain = token.startsWith("0x") ? "base" : "solana";
  return CHAINS.includes(chain) && validToken(token, chain) ? { token, chain } : null;
}
/** Per-token og/twitter tags. "summary" = small square thumbnail in the feed (not the full-width large image). */
function shareMeta(U: string, token: string, chain: string) {
  const c = cachedShare(chain, token)?.v, nm = c?.name || shortAddr(token);
  const title = escA(noSafe(`${nm}: RugRadar risk ${c ? `${c.score}/100 ${c.label}` : "check"}`));
  const desc = escA(noSafe(c && c.warnings.length ? (c.tension ? c.tension + " " : "") + c.warnings.map((w) => w.title).join(" \u00b7 ") + ". Danger warnings only." : "0-100 token risk score with plain danger warnings. Danger warnings only."));
  const url = escA(`${U}/rugradar/c/${chain}/${encodeURIComponent(token)}`), img = escA(c ? `${U}/rugradar/share/${chain}/${encodeURIComponent(token)}.png` : `${U}/rugradar/rug-radar-512.png`);
  return `<meta property="og:type" content="website"><meta property="og:title" content="${title}"><meta property="og:description" content="${desc}"><meta property="og:url" content="${url}"><meta property="og:image" content="${img}"><meta property="og:image:width" content="600"><meta property="og:image:height" content="600"><meta name="twitter:card" content="summary"><meta name="twitter:title" content="${title}"><meta name="twitter:description" content="${desc}"><meta name="twitter:image" content="${img}"><meta name="twitter:image:alt" content="RugRadar risk score and danger warnings for ${escA(shortAddr(token))}">`;
}
function shareCardHtml(U: string, chain: string, token: string, v: { name: string; score: number; label: string; level: string; warnings: { severity: string; title: string }[]; more: number; facts: string[]; tension?: string | null } | null): string {
  const check = `${U}/rugradar?token=${encodeURIComponent(token)}&chain=${chain}`;
  const title = escA(noSafe(v ? `${v.name || shortAddr(token)} — RugRadar danger warnings` : `RugRadar — ${shortAddr(token)}`));
  const meta = shareMeta(U, token, chain);
  const rows = (v?.warnings ?? []).map((w) => `<div class="w ${w.severity === "DANGER" ? "d" : "c"}"><b>${escA(w.severity)}</b> ${escA(noSafe(w.title))}</div>`).join("");
  const more = v && v.more > 0 ? `<p class="more">+${v.more} more warning${v.more > 1 ? "s" : ""} in the full report</p>` : "";
  const body = v
    ? `<p class="tok">${escA(noSafe(v.name || shortAddr(token)))}<small>${escA(shortAddr(token))} · ${escA(CHAIN_NAME[chain] ?? chain)}</small></p>
<div class="score"><strong>${v.score}</strong><span>/100</span></div>
${v.tension ? `<p class="tl">${escA(noSafe(v.tension))}</p>` : ""}${v.warnings.length ? rows : `<p class="none">No danger warnings found.</p>`}
${v.facts.length ? `<p class="facts">${escA(v.facts.slice(0, 3).join(" · "))}</p>` : ""}${more}
<p class="foot">Danger warnings only · <a href="${escA(check)}">Open the full check</a></p>`
    : `<p class="tok">${escA(shortAddr(token))}<small>${escA(CHAIN_NAME[chain] ?? chain)}</small></p>
<p class="none">No saved danger warnings for this token yet.</p>
<p class="foot"><a href="${escA(check)}">Check this token on RugRadar</a></p>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>${meta}
<style>.tl{font-weight:700;font-size:17px;margin:0 0 12px;color:#EEF2F8}body{margin:0;background:#0B1020;color:#EEF2F8;font:16px/1.45 system-ui,sans-serif}main{max-width:420px;margin:24px auto;padding:20px;background:#131A2E;border:1px solid #232C47;border-radius:16px}.tok{margin:0 0 12px;font-weight:700}.tok small{display:block;color:#9AA4B8;font-weight:500;margin-top:4px}.score{font-size:40px;font-weight:700;margin:0 0 14px}.score span{font-size:16px;color:#9AA4B8;margin-left:4px}.w{display:flex;gap:8px;align-items:center;font-weight:700;padding:9px 10px;margin:0 0 6px;border-radius:10px;background:#0F1628}.w.d{border-left:4px solid #EF4444}.w.c{border-left:4px solid #F59E0B}.w b{font-size:11px;letter-spacing:.04em}.none,.facts,.more,.foot{color:#9AA4B8;font-size:14px}a{color:#38BDF8;font-weight:700}</style></head>
<body><main>${body}</main></body></html>`;
}
export function registerRugradarWeb(app: Express, d: WebDeps) {
  const htmlBase = page(d), htmlPromo = page(d, true);
  app.get("/rugradar", (req, res) => {
    const html = fullFreeActive() ? htmlPromo : htmlBase, t = shareTarget(req);
    res.set("Cache-Control", "public, max-age=300").type("html").send(t ? html.replace(OG_RE, shareMeta(d.publicUrl, t.token, t.chain)) : html);
  });
  // Per-token share image (free-check data only). Rendered only from a stored result — never starts a new check.
  app.get("/rugradar/share/:chain/:file", async (req: Request, res: Response) => {
    const chain = String(req.params.chain).toLowerCase(), token = String(req.params.file).replace(/\.png$/, "");
    const fallback = () => res.set("Cache-Control", "public, max-age=120").redirect(302, "/rugradar/rug-radar-512.png");
    if (!CHAINS.includes(chain) || !validToken(token, chain) || !cachedShare(chain, token)) { fallback(); return; }
    try {
      const png = await sharePng(chain, token, new URL(d.publicUrl).host, async () => { throw Object.assign(new Error("uncached"), { code: "uncached" }); });
      res.set("Cache-Control", "public, max-age=3600").type("image/png").send(png);
    } catch { fallback(); }
  });
  // Shareable warnings-only permalink + OG tags. Renders from the stored share card only; never starts a new check.
  app.get("/rugradar/c/:chain/:token", (req: Request, res: Response) => {
    const chain = String(req.params.chain).toLowerCase(), token = String(req.params.token);
    if (!CHAINS.includes(chain) || !validToken(token, chain)) { res.status(404).type("html").send("<!doctype html><title>RugRadar</title><p>That is not a token address RugRadar can check. <a href=\"/rugradar\">Open RugRadar</a></p>"); return; }
    const hit = cachedShare(chain, token)?.v;
    res.set("Cache-Control", hit ? "public, max-age=300" : "public, max-age=60").type("html").send(shareCardHtml(d.publicUrl, chain, token, hit ?? null));
  });
  app.get("/rugradar/live.js", (_req, res) => { res.set("Cache-Control", "public, max-age=86400").type("application/javascript").send(LIVE_JS); });
  app.get("/rugradar/embed", async (req: Request, res: Response) => {
    const r = await embedFor(d, req);
    res.status(r.status).set({ "Cache-Control": r.status === 200 ? "public, max-age=300" : "no-store", "Content-Security-Policy": "frame-ancestors *" }).type("html").send(embedHtml(d.publicUrl, r.v, r.msg, d.priceUsd));
  });
  app.get("/rugradar/embed.json", async (req: Request, res: Response) => {
    const r = await embedFor(d, req);
    res.set({ "Cache-Control": r.status === 200 ? "public, max-age=300" : "no-store", "Access-Control-Allow-Origin": "*" });
    if (r.v) res.json(r.v); else res.status(r.status).json({ error: r.error, message: r.msg });
  });
  app.get("/rugradar/api/chain", async (req: Request, res: Response) => {
    const t = String(req.query.token ?? "").trim();
    res.set("Cache-Control", "no-store");
    if (!/^0x[0-9a-fA-F]{40}$/.test(t)) { res.json({ chain: "solana" }); return; }
    res.json({ chain: await (d.detectChain ?? detectEvmChain)(t) });
  });
  /** Connected wallet (signed session) on a free check: logged privately, never shown to anyone else. */
  const logConnected = (req: Request, chain: string, token: string, score: unknown) => { try { const w = sessionWallet(req.header("x-rugradar-wallet")); if (w && d.wallets) void d.wallets.log(w, chain, token, score, "connected"); } catch {} };
  const wHits = new Map<string, number[]>();
  const wLimited = (ip: string, n = 20) => { const now = Date.now(), xs = (wHits.get(ip) ?? []).filter((t) => now - t < 10 * 60_000); xs.push(now); wHits.set(ip, xs); if (wHits.size > 2000) wHits.delete(wHits.keys().next().value!); return xs.length > n; };
  // "Connect wallet to see your past checks": sign a message (no transaction, no payment); the wallet sees only its own checks.
  app.get("/rugradar/api/wallet/challenge", (req: Request, res: Response) => {
    res.set("Cache-Control", "no-store");
    const a = String(req.query.address ?? "").trim();
    if (!d.wallets) { res.status(404).json({ error: "not_available" }); return; }
    if (!(isEvmAddr(a) || isSolAddr(a))) { res.status(400).json({ error: "invalid_input", message: "Send a Solana or 0x wallet address." }); return; }
    if (wLimited(ipOf(req))) { res.status(429).json({ error: "slow_down", message: "Too many tries; wait a few minutes." }); return; }
    res.json(challenge(a));
  });
  app.post("/rugradar/api/wallet/verify", async (req: Request, res: Response) => {
    res.set("Cache-Control", "no-store");
    if (!d.wallets) { res.status(404).json({ error: "not_available" }); return; }
    if (wLimited(ipOf(req))) { res.status(429).json({ error: "slow_down", message: "Too many tries; wait a few minutes." }); return; }
    const b = req.body ?? {}, tok = await verifyChallenge(String(b.address ?? ""), String(b.message ?? ""), String(b.signature ?? ""));
    if (!tok) { res.status(401).json({ error: "bad_signature", message: "The signature did not match this wallet, or the message expired. Try connecting again." }); return; }
    res.json({ session: tok, expiresInDays: 7 });
  });
  app.get("/rugradar/api/wallet/history", async (req: Request, res: Response) => {
    res.set("Cache-Control", "no-store");
    const w = sessionWallet(req.header("x-rugradar-wallet"));
    if (!d.wallets) { res.status(404).json({ error: "not_available" }); return; }
    if (!w) { res.status(401).json({ error: "not_connected", message: "Connect your wallet again to see your past checks." }); return; }
    res.json({ wallet: w, items: await d.wallets.list(w) });
  });
  const checkFree = async (req: Request, res: Response) => {
    res.set("Cache-Control", "no-store");
    const token = String(req.query.token ?? "").trim(), chain = String(req.query.chain ?? "solana").toLowerCase();
    if (!CHAINS.includes(chain) || !validToken(token, chain)) { countRugradarRejected("invalidInput"); res.status(400).json({ error: "invalid_input", message: chain === "solana" ? "Paste a Solana mint address (base58, 32-44 chars) or pick an EVM chain for 0x addresses." : "Paste a 0x token contract address (40 hex characters)." }); return; }
    let vid = cookieVid(req);
    if (!vid) { vid = randomBytes(16).toString("base64url"); res.append("Set-Cookie", `rr_vid=${vid}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax; Secure`); }
    const ip = ipOf(req), a = freeAllowance(ip, vid);
    if (!a.ok) {
      countRugradarRejected(a.reason === "slow_down" ? "rateLimited" : "freeUsedUp");
      const msg = a.reason === "slow_down" ? "One check every few seconds, please." : a.reason === "daily_free_cap" ? "Today's free checks are used up. Buy credits to keep checking." : `You've used your free check for today. Buy credits ($${d.priceUsd} each) for the full report.`;
      res.status(a.reason === "slow_down" ? 429 : 402).json({ error: a.reason, message: msg, buyCredits: `${d.publicUrl}/credits/buy?credits=100`, ...(a.reason === "slow_down" ? {} : { lockedSignals: LOCKED_SIGNALS, unlockOffer: unlockOffer(d.publicUrl, d.priceUsd) }) }); return;
    }
    useFree(ip, vid);
    if (fullFreeActive() && d.paidCheck) {
      try { const full = await d.paidCheck(token, chain); primeFromLimited(limitedReport(full), token, chain); countRugradar("free"); logConnected(req, chain, token, full?.riskScore); res.json({ ...full, tensionLine: full?.tensionLine ?? null, paidWith: "free_promo", free_checks_left: a.left, freeFacts: freeFacts(full), warnDetails: warnDetails(full) }); }
      catch (e) { refundFree(ip, vid); countRugradarRejected("error"); if (e instanceof RugBusyError) { res.status(503).set("Retry-After", "5").json({ error: "busy", message: `${e.message}. You weren't charged and this did not use a free check.` }); return; } res.status(422).json({ error: "check_failed", message: `${String((e as Error).message ?? e)}. This did not use a free check.` }); }
      return;
    }
    try { const lr = limitedReport(await d.rugCheck(token, chain)); primeFromLimited(lr, token, chain); countRugradar("free"); logConnected(req, chain, token, lr.riskScore); res.json({ ...lr, reportUrl: `${d.publicUrl}/rugradar?token=${encodeURIComponent(token)}&chain=${chain}`, shareUrl: `${d.publicUrl}/rugradar/c/${chain}/${encodeURIComponent(token)}`, unlockOffer: unlockOffer(d.publicUrl, d.priceUsd), free_checks_left: a.left }); }
    catch (e) { refundFree(ip, vid); countRugradarRejected("error"); if (e instanceof RugBusyError) { res.status(503).set("Retry-After", "5").json({ error: "busy", message: `${e.message}. You weren't charged and this did not use a free check.` }); return; } res.status(422).json({ error: "check_failed", message: `${String((e as Error).message ?? e)}. This did not use a free check.` }); }
  };
  app.post("/rugradar/api/check", checkFree);
  app.get("/rugradar/api/check", checkFree); // same handler: some clients and crawlers use GET; count every successful free check once
  // Recent unlocked reports for a credit key. Free to read: never spends a credit or a free check; the key is checked on every call.
  const recentKey = async (req: Request, res: Response): Promise<{ key: string; credits: number } | null> => {
    res.set("Cache-Control", "no-store");
    const key = String(req.header("x-rugradar-key") ?? "").trim();
    if (!d.recent || !d.balance) { res.status(404).json({ error: "not_available" }); return null; }
    const credits = key && key.length <= 200 ? await d.balance(key).catch(() => null) : null;
    if (credits == null) { res.status(401).json({ error: key ? "invalid_key" : "missing_key", message: key ? "Credit key not recognized." : "Send your credit key in the X-RugRadar-Key header." }); return null; }
    return { key, credits };
  };
  app.get("/rugradar/api/recent", async (req: Request, res: Response) => {
    const k = await recentKey(req, res); if (!k) return;
    res.json({ items: await d.recent!.list(k.key) });
  });
  app.get("/rugradar/api/recent/report", async (req: Request, res: Response) => {
    const k = await recentKey(req, res); if (!k) return;
    const it = await d.recent!.get(k.key, String(req.query.chain ?? "").toLowerCase(), String(req.query.token ?? "").trim());
    if (!it) { res.status(404).json({ error: "not_found", message: "That saved report is gone (saved reports last 30 days)." }); return; }
    res.json({ ...(it.report as object), paidWith: "saved", savedAt: new Date(it.at).toISOString(), credits_remaining: k.credits });
  });
  app.get("/sitemap.xml", (_req, res) => {
    const now = new Date().toISOString().slice(0, 10);
    res.type("application/xml").send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${["/rugradar", "/", "/examples"].map((p) => `<url><loc>${d.publicUrl}${p}</loc><lastmod>${now}</lastmod></url>`).join("\n")}\n</urlset>\n`);
  });
  app.get("/mcp", (_req, res) => { res.status(405).set("Allow", "POST").json({ error: "use POST (MCP streamable HTTP, JSON responses)", tools: mcpTools(d).map((x) => x.name) }); });
  app.post("/mcp", async (req: Request, res: Response) => {
    const m = req.body ?? {};
    const reply = (o: object) => res.json({ jsonrpc: "2.0", id: m.id ?? null, ...o });
    if (Array.isArray(m)) { res.status(400).json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "batching not supported" } }); return; }
    if (m.id === undefined) { res.status(202).end(); return; } // notifications
    const rp = d.researchPrices ?? RESEARCH_DEFAULTS;
    switch (m.method) {
      case "initialize": return reply({ result: { protocolVersion: m.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "rugradar", title: "RugRadar", version: "1.0.0" }, instructions: `RugRadar danger checks (rug_check, token_safety, honeypot_check at $${d.priceUsd}; watch_token $0.05/24h; list_watches and cancel_watch are free with the same credit key) plus research tools on the same server: research_brief ${rp.report}, read_page ${rp.read}, news_search ${rp.news}, token_price ${rp.price}. RugRadar tools accept a credit key (header X-RugRadar-Key or api_key); otherwise each tool returns the x402 payment requirement for its HTTP route.` } });
      case "ping": return reply({ result: {} });
      case "tools/list": return reply({ result: { tools: mcpTools(d) } });
      case "tools/call": return reply(await mcpCall(d, m.params?.name, m.params?.arguments, req.header("x-rugradar-key")));
      default: return reply({ error: { code: -32601, message: `method not found: ${m.method}` } });
    }
  });
}
