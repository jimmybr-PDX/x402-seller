/**
 * RugRadar web surface: branded landing page with a free web checker (1 free limited check per visitor, limited by IP
 * and cookie), an embeddable result card (/rugradar/embed), sitemap.xml, and an MCP server (streamable HTTP, JSON responses) at /mcp.
 * Page copy shows danger warnings only, in plain words; it never names how a warning was found.
 */
import { RUG_EDGE } from "./rug-extra.js";
import { swapClientJs, type SwapCfg } from "./swap.js";
import type { Express, Request, Response } from "express";
import { randomBytes } from "node:crypto";

export type WebDeps = {
  publicUrl: string; port: number; priceUsd: string; speed: { creditS: number; paidS: number; x: number } | null;
  rugCheck: (t: string, chain: string) => Promise<any>;
  spend: (k: string) => Promise<number | null>; refund: (k: string) => Promise<void>;
  /** RugRadar Watch + Alert (optional): create a watch paid with credits; config for prices/destinations. */
  watch?: { create: (key: string, args: any) => Promise<any>; config: () => any };
  /** Jupiter "Buy this token" button; off unless swapConfig() says enabled. */
  swap?: SwapCfg;
  /** Optional chain detector for 0x addresses (tests inject one; default asks DexScreener). */
  detectChain?: (token: string) => Promise<string>;
};
export const FREE_PER_VISITOR = 1;
export const FREE_COPY = "1 free limited check per visitor, then credits for the full report.";
const LIMITED_CHECKS = new Set(["mint_authority", "freeze_authority", "mint_function", "holders", "liquidity", "age", "dead_token"]);
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
  const basic = all.filter((c: any) => LIMITED_CHECKS.has(c?.check) && c?.check !== "dead_token").map((c: any) => ({ check: c.check, points: Number(c.points) || 0, detail: c.detail }));
  const sum = basic.reduce((a: number, c: any) => a + c.points, 0);
  const dead = all.find((c: any) => c?.check === "dead_token");
  const checks = dead ? [{ check: "dead_token", points: Math.max(5, 60 - sum), detail: dead.detail }, ...basic] : basic;
  const score = Math.min(100, checks.reduce((a: number, c: any) => a + c.points, 0));
  const level = score >= 50 ? "high" : score >= 25 ? "medium" : "low";
  const pick = (k: string) => (f[k] === undefined ? null : f[k]);
  const links = full?.buyer?.socialLinks;
  return {
    product: "RugRadar", report: "limited", chain: full?.chain ?? null, token: full?.token ?? null, riskScore: score, riskLevel: level, scoring: "basic score (mint/freeze authority, top holders, age, liquidity, dead token)",
    verdict: level === "high" ? "Multiple high-risk patterns found." : level === "medium" ? "Some high-risk patterns found." : "No major high-risk patterns found in the basic checks.",
    reasons: checks.filter((c: any) => c.points > 0).map((c: any) => c.detail), checks,
    hiddenWarnings: all.filter((c: any) => c && !LIMITED_CHECKS.has(c.check) && Number(c.points) > 0 && WARN[c.check]).length,
    socialLinks: Array.isArray(links) ? links : null, freeFacts: freeFacts(full),
    facts: { mintAuthority: pick("mintAuthority"), freezeAuthority: pick("freezeAuthority"), top1Pct: pick("top1Pct"), top10Pct: pick("top10Pct"), holderCount: pick("holderCount"), ageHours: pick("ageHours"), liquidityUsd: pick("liquidityUsd") },
    lockedSignals: LOCKED_SIGNALS, unlock: "Credits unlock the full report (paste a credit key above, or send X-RugRadar-Key).",
    disclaimer: full?.disclaimer ?? DISCLAIMER, generatedAt: full?.generatedAt ?? new Date().toISOString(),
  };
}
/** One plain line RugCheck users expect on a Solana free check: mint authority and main-pool LP burn (from data the check already has). */
export function freeFacts(full: any): string[] {
  if (full?.chain !== "solana") return [];
  const f = full?.facts ?? {}, out: string[] = [];
  if ("mintAuthority" in f) out.push(`Mint authority: ${f.mintAuthority ? "still on" : "off"}`);
  const lp = Array.isArray(full?.buyer?.lpBurnPct) ? full.buyer.lpBurnPct.filter((x: any) => x && typeof x.burnPct === "number" && isFinite(x.burnPct)) : [];
  if (lp.length) { const top = lp.reduce((a: any, b: any) => (Number(b.tvlUsd) > Number(a.tvlUsd) ? b : a)); out.push(`Liquidity: ${Math.round(Math.max(0, Math.min(100, top.burnPct)))}% burned`); }
  return out;
}
const FREE_DAILY_CAP = Number(process.env.RUGRADAR_FREE_DAILY_CAP ?? 500);
const DISCLAIMER = "Automated heuristic, may be wrong. Not financial advice. Do your own research.";

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
};
/** Warnings to show (points > 0), worst first, one card per title. */
export function warningsOf(checks: any): { sev: "DANGER" | "CAUTION"; title: string; line: string; points: number }[] {
  const seen = new Set<string>(), out: any[] = [];
  for (const c of (Array.isArray(checks) ? checks : []).filter((x: any) => x && Number(x.points) > 0 && WARN[x.check]).sort((a: any, b: any) => b.points - a.points)) {
    const w = WARN[c.check]!; if (seen.has(w[0])) continue; seen.add(w[0]);
    out.push({ sev: Number(c.points) >= 15 ? "DANGER" : "CAUTION", title: w[0], line: w[1], points: Number(c.points) });
  }
  return out;
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
.v-low{background:linear-gradient(135deg,rgba(74,222,128,.34),rgba(74,222,128,.14));border:2px solid var(--ok)}
.gauge{--p:0;--c:var(--bad);width:120px;height:120px;border-radius:50%;flex:none;background:conic-gradient(var(--c) calc(var(--p)*1%),rgba(255,255,255,.12) 0);display:grid;place-items:center;box-shadow:0 0 18px color-mix(in srgb,var(--c) 45%,transparent)}
.gauge i{width:88px;height:88px;border-radius:50%;background:#0f1526;display:grid;place-items:center;font-style:normal;font-weight:900;font-size:36px;line-height:1;color:#fff}
.gauge i small{display:block;font-size:11px;font-weight:600;color:var(--mut);text-align:center}
.g-high{--c:var(--bad)}.g-medium{--c:var(--warn)}.g-low{--c:var(--ok)}.g-low i{color:#6CFFA0}.g-wait{--c:#3a4670;box-shadow:none}
.vt{font-size:24px;font-weight:900;line-height:1.1}.vt.high{color:#ff6b6b}.vt.medium{color:#fbbf24}.vt.low{color:#6CFFA0}.vl{font-size:16px;margin-top:4px}.vtrust{font-size:12px;color:var(--mut);margin-top:6px}
.wcards{display:grid;gap:8px;margin:10px 0 6px}
.wc{border-radius:12px;border:1px solid var(--line);background:#0F1628}.wc.d{border-left:5px solid var(--bad)}.wc.c{border-left:5px solid var(--warn)}
.wc summary{display:flex;gap:10px;align-items:center;padding:12px;list-style:none;cursor:pointer;font-weight:700;font-size:16px;color:#fff}.wc summary::-webkit-details-marker{display:none}
.wc summary .tt{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
.wc summary .ch{margin-left:auto;color:var(--mut);font-weight:400}.wc summary .ch::before{content:"\\25BE"}.wc[open] summary .ch::before{content:"\\25B4"}
.sev{flex:none;font-size:11px;font-weight:900;border-radius:6px;padding:3px 7px;letter-spacing:.4px}.s3{background:var(--bad);color:#fff}.s2{background:var(--warn);color:#1b1200}
.wc p{margin:0;padding:0 12px 12px;font-size:14px;color:#c9d1e0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.wc p a{font-weight:700}
.ffl{font-size:14px;color:#c9d1e0;margin:2px 0 6px}`;
const CSS_PAGE = `body{margin:0;background:var(--bg);color:var(--tx);font:17px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
@media(min-width:900px){body{font-size:16px}}
.wrap{max-width:1120px;margin:0 auto;padding:0 16px}
header{display:flex;align-items:center;justify-content:space-between;padding:12px 0}
.logo{display:flex;gap:8px;align-items:center;font-weight:800;font-size:19px;color:var(--tx)}.logo img{border-radius:50%}
.pill{border:1px solid var(--line);border-radius:999px;padding:6px 12px;font-size:14px;color:var(--tx)}
.hero h1{font-size:26px;line-height:1.15;margin:6px 0 4px}.hero p{margin:0 0 12px;color:var(--mut);font-size:15px}
.search{display:flex;gap:8px;flex-wrap:wrap}.search input{flex:1 1 260px;min-width:0;background:#0E1528;border:2px solid var(--acc);color:var(--tx);border-radius:12px;padding:14px;font-size:16px}
.search input::placeholder{color:#7d88a0}
.btn{display:inline-block;border:0;border-radius:12px;padding:14px 18px;font-weight:700;font-size:16px;cursor:pointer;text-align:center}.pri{background:var(--acc);color:#04121d}.go{background:#22C55E;color:#04150a;width:100%}.ghost{background:transparent;border:1px solid var(--line);color:var(--tx)}.btn:disabled{opacity:.6;cursor:not-allowed}
.subrow{display:flex;gap:10px;align-items:center;margin:8px 0 6px;flex-wrap:wrap}
.chainchip{appearance:none;-webkit-appearance:none;background:transparent;border:1px solid var(--acc);border-radius:999px;padding:3px 10px;font-size:13px;color:var(--tx);cursor:pointer}
.chainchip option{background:var(--card)}.trust{font-size:13px;color:var(--mut)}
.keyd{font-size:13px;color:var(--mut);margin:0 0 12px}.keyd summary{cursor:pointer;display:inline}.keyd input{width:100%;max-width:420px;margin-top:6px;background:#0E1528;border:1px solid var(--line);color:var(--tx);border-radius:10px;padding:10px;font-size:15px}
#quota{display:block;font-size:12px;color:var(--mut)}#keybox{display:block;margin-top:6px;font-size:13px}
.kbtn{background:#232C47;color:var(--tx);border:0;border-radius:6px;padding:3px 9px;font-size:13px;cursor:pointer;margin-left:4px}
.grid{display:grid;gap:16px}@media(min-width:900px){.grid{grid-template-columns:1.6fr 1fr;align-items:start}.hero h1{font-size:34px}}
.card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:16px}
.tok{display:flex;gap:12px;align-items:center;flex-wrap:wrap}.av{width:44px;height:44px;border-radius:50%;background:#2a3456;display:grid;place-items:center;font-weight:800;flex:none}
.tok b{font-size:18px;word-break:break-all}.addr{font-size:13px;color:var(--mut)}
.socw{margin-left:auto}.soc{display:flex;gap:14px;align-items:flex-start;flex-wrap:wrap}
.si a,.si span.off{position:relative;width:34px;height:34px;border-radius:10px;display:grid;place-items:center;font-size:13px;font-weight:700}
.si a{border:1px solid #3a4670;background:#18213a;color:var(--tx)}
.si a::after{content:"\\2713";position:absolute;right:-5px;bottom:-5px;width:15px;height:15px;border-radius:50%;background:#22C55E;color:#04150a;font-size:10px;font-weight:900;display:grid;place-items:center}
.si span.off{border:1px solid var(--bad);background:rgba(239,68,68,.18);color:#ffc2c2;overflow:hidden}.si span.off::before{content:"";position:absolute;left:-4px;right:-4px;top:50%;height:2px;background:var(--bad);transform:rotate(-45deg)}
.nosoc{display:inline-block;background:rgba(239,68,68,.18);border:1px solid var(--bad);color:#ffc2c2;border-radius:999px;padding:5px 10px;font-size:13px;font-weight:700}
.socfb{display:none;font-size:13px;font-weight:600;color:#C9D1E0;margin-top:6px}.socfb .miss{color:#ff8a8a;font-weight:700}
@media(max-width:899px){.socfb{display:block}.socw{margin-left:0;width:100%}}
.socnote{font-size:10px;color:#6f7990;margin-top:3px}@media(min-width:900px){.socnote{text-align:right}}
.res .verdict{margin:14px 0 10px}
@media(max-width:899px){.res .verdict{margin:10px 0 6px;padding:12px;gap:12px;min-height:150px}.gauge{width:104px;height:104px}.gauge i{width:78px;height:78px;font-size:32px}.wcards{gap:6px}.wc summary{padding:10px 12px}.card{padding:12px}.hero h1{font-size:24px}}
.tease{display:inline-block;margin:2px 0 0;padding:4px 10px;border-radius:999px;background:rgba(239,68,68,.15);border:1px solid rgba(239,68,68,.5);color:#ffc2c2;font-weight:700;font-size:13px;cursor:default}
button.tease{cursor:pointer;font:inherit;font-size:13px;font-weight:700}
.lock{margin-top:8px;padding:10px 12px;border-radius:12px;background:#0E1528;border:1px dashed #4a5a8a;font-size:14px;line-height:1.35}
.lock .btn{width:100%;margin-top:8px;padding:8px 12px;font-size:14px}.sec{background:transparent;border:1px solid rgba(56,189,248,.55);color:#9fdcf9}
.disc{font-size:12px;color:var(--mut);margin-top:10px;text-align:center}
.buyline{font-size:12px;color:var(--mut);text-align:center;margin-top:6px}#swapbox{margin:10px 0 4px}#swapbox small{display:block;text-align:center}
.card h2,.card h3{margin:0 0 6px;font-size:17px}.mut{color:var(--mut);font-size:14px;margin:0 0 10px}.note{font-size:13px;color:var(--mut);margin:8px 0 10px}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}.wide{width:100%}
.cred{border:2px solid var(--acc);box-shadow:0 0 18px rgba(56,189,248,.18)}
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
footer{color:var(--mut);font-size:12px;padding:20px 0 40px}
@media(max-width:899px){.go{padding:11px 14px;font-size:15px}.buyline{margin-top:4px;font-size:11px}.grid{gap:10px}.quiet{margin-top:10px}details.fold{margin:10px 0;padding:12px 14px}}`;


/** Page client JS (no template interpolation on purpose; config arrives as CFG). */
const PAGE_JS = String.raw`const WALLETS=[],WAPI={register:(...ws)=>{ws.forEach(w=>{if(w&&w.features&&w.features['solana:signAndSendTransaction']&&w.features['standard:connect']&&!WALLETS.includes(w))WALLETS.push(w)});return()=>{}}};
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
  if(c.ok){localStorage.removeItem('rr_order');st.textContent='';st.append(el('p',null,c.j.credits+' credits added. Your key (shown once, save it):'));const k=el('code',null,c.j.key);st.append(k);document.getElementById('key').value=c.j.key;KS.set(c.j.key);st.append(el('small',null,'Saved on this device (see Saved credit key above). Copy it and keep it private too.'));q.textContent=c.j.credits+' credit(s) on your key. Check a token for the full report.';return}
  if(c.status===409||c.status===400||c.status===410){if(c.status===409)localStorage.removeItem('rr_order');st.textContent=c.j.message||('Error '+c.status);return}
  if(!auto)st.textContent=(c.j.message||'Waiting for confirmation...')+' ('+(i+1)+'/'+tries+')';await new Promise(r=>setTimeout(r,ms))}
 if(id!==POLL)return;
 st.append(el('p',null,'Still not confirmed. Your order is saved; use the check button again in a minute.'))}
const KS={get(){try{return localStorage.getItem('rr_key')||''}catch(e){return ''}},set(k){try{localStorage.setItem('rr_key',k)}catch(e){}keyUI()},del(){try{localStorage.removeItem('rr_key')}catch(e){}keyUI()}};
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
function warnings(checks){const seen={},o=[];(Array.isArray(checks)?checks:[]).filter(c=>c&&Number(c.points)>0&&CFG.warn[c.check]).sort((a,b)=>b.points-a.points).forEach(c=>{const w=CFG.warn[c.check];if(seen[w[0]])return;seen[w[0]]=1;o.push({d:Number(c.points)>=15,t:w[0],l:w[1]})});return o}
function card(w,j,open){const d=el('details','wc '+(w.d?'d':'c'));if(open)d.open=true;const s=el('summary');s.append(el('span','sev '+(w.d?'s3':'s2'),w.d?'DANGER':'CAUTION'),el('span','tt',w.t),el('span','ch'));d.append(s);
 d.append(el('p',null,w.l));return d}
const SOC=[['X','\u{1D54F}',/^(twitter|x)$/i,'X'],['Telegram','TG',/^telegram$/i,'TG'],['Website','\u{1F310}',/^website$/i,'Web'],['Discord','DC',/^discord$/i,'Discord']];
function host(u){try{return new URL(u).hostname.replace(/^www\./,'')}catch(e){return ''}}
function socials(j){const raw=Array.isArray(j.socialLinks)?j.socialLinks:(j.buyer&&Array.isArray(j.buyer.socialLinks)?j.buyer.socialLinks:null);if(!raw)return null;
 const links=raw.filter(x=>x&&typeof x.url==='string'&&/^https?:\/\//i.test(x.url)),w=el('div','socw'),note=el('div','socnote','links are set by the token creator; check before trusting');
 if(!links.length){w.append(el('span','nosoc','\u26A0 No socials found'),note);return w}
 const row=el('div','soc'),have=[],miss=[];const mk=(x,name,ic)=>{const s=el('div','si'),a=el('a',null,ic);a.href=x.url;a.target='_blank';a.rel='noopener noreferrer nofollow';a.setAttribute('aria-label',name);a.title=name+': '+host(x.url);s.append(a);row.append(s)};
 SOC.forEach(([name,ic,re,shortName])=>{const x=links.find(l=>re.test(String(l.type||'')));if(x){mk(x,name,ic);have.push(shortName)}else{const s=el('div','si'),o=el('span','off',ic);o.setAttribute('aria-label',name+' missing');o.title=name+' missing';s.append(o);row.append(s);miss.push(shortName)}});
 links.filter(l=>!SOC.some(s=>s[2].test(String(l.type||'')))).slice(0,3).forEach(x=>{const n=String(x.type||'link');mk(x,n,n.slice(0,2).toUpperCase());have.push(n)});
 row.title=have.concat(miss.map(m=>m+' missing')).join(' \u00b7 ');const fb=el('div','socfb',have.join(' \u00b7 '));if(miss.length){if(have.length)fb.append(' \u00b7 ');fb.append(el('span','miss',miss.join(', ')+' missing'))}
 w.append(row,fb,note);return w}
function gauge(lv,score){const g=el('div','gauge g-'+lv);g.style.setProperty('--p',lv==='low'?100:Math.max(4,Math.min(100,score)));const i=el('i',null,String(score));i.append(el('small',null,'/100'));g.append(i);return g}
const VT={high:['HIGH RISK','Strong rug warning signs.'],medium:['CAUTION','Some rug warning signs.'],low:['LOW RISK','No danger warnings found. Not a guarantee.']};
function verdictBox(j,ws){const lv=VT[j.riskLevel]?j.riskLevel:'medium',s=Number(j.riskScore)||0,v=el('div','verdict v-'+lv),t=el('div');let line=VT[lv][1];if(lv==='low'&&ws.some(w=>w.d))line='Few warning signs. Not a guarantee.';
 t.append(el('div','vt '+lv,VT[lv][0]),el('div','vl',line),el('div','vtrust',j.report==='limited'?'Free check: basic warnings only.':'Full report.'));v.append(gauge(lv,s),t);return v}
function lockedPanel(note){const b=el('div','lock');b.id='unlock';b.append(el('span',null,'\u{1F512} '+(note||'Full report adds the danger warnings free checkers usually miss.')));const a=el('button','btn sec',OFFER.label);a.type='button';a.addEventListener('click',()=>openBuy(true));b.append(a);return b}
function openBuy(scroll){const x=$('buyx');x.hidden=false;const w=$('wpay');if(scroll&&w){$('credits').scrollIntoView({block:'start',behavior:'smooth'});w.classList.add('flash');setTimeout(()=>w.classList.remove('flash'),1600)}}
function render(j,t){out.textContent='';const c=el('div','card res'),ws=warnings(j.checks),fa=j.facts||{};
 const tok=el('div','tok'),info=el('div');tok.append(el('div','av',(typeof fa.token==='string'?fa.token:String(j.token||'?')).slice(0,2).toUpperCase()));
 info.append(el('b',null,(typeof fa.token==='string'?'$'+fa.token+' \u00b7 ':'')+short(j.token)),el('div','addr',[CFG.chains[j.chain]||j.chain,ageTxt(fa.ageHours)].filter(Boolean).join(' \u00b7 ')));tok.append(info);const sw=socials(j);if(sw)tok.append(sw);c.append(tok);
 c.append(verdictBox(j,ws));if(Array.isArray(j.freeFacts)&&j.freeFacts.length)c.append(el('div','ffl',j.freeFacts.join(' \u00b7 ')));
 if(typeof SWAPHOOK==='function'&&j.token===t){const sb=SWAPHOOK(j);if(sb)c.append(sb)}
 const wc=el('div','wcards');ws.slice(0,3).forEach((w,i)=>wc.append(card(w,j,DESK&&i===0)));if(ws.length)c.append(wc);
 if(j.report==='limited'&&j.checks){const n=Number(j.hiddenWarnings)||0;if(n>0)c.append(el('span','tease','+'+n+' more warning'+(n>1?'s':'')+' in the full report'));c.append(lockedPanel())}
 else if(ws.length>3){const b=el('button','tease','+'+(ws.length-3)+' more warnings');b.type='button';b.addEventListener('click',()=>{ws.slice(3).forEach(w=>wc.append(card(w,j,false)));b.remove()});c.append(b)}
 c.append(el('div','disc','Danger warnings only. Not a guarantee, not financial advice.'));out.append(c)}
function waitCard(){out.textContent='';const c=el('div','card res'),v=el('div','verdict'),t=el('div');t.append(el('div','vt','Checking\u2026'),el('div','vl','Usually a few seconds.'));v.append(gauge('wait',0),t);v.querySelector('i').firstChild.textContent='\u2026';c.append(v);out.append(c)}
function msgCard(text,lock,note){out.textContent='';const c=el('div','card res');c.append(el('p',null,text));if(lock)c.append(lockedPanel(note));out.append(c)}
async function chainFor(t){const c=$('chain').value;if(c!=='auto')return c;if(!t.startsWith('0x'))return 'solana';try{const r=await fetch('/rugradar/api/chain?token='+encodeURIComponent(t));const j=await r.json();return j.chain||'base'}catch(e){return 'base'}}
f.addEventListener('submit',async e=>{e.preventDefault();const t=$('tok').value.trim(),k=$('key').value.trim();if(!t)return;waitCard();go.disabled=true;
 try{const c=await chainFor(t);const r=k?await fetch('/rug-check?token='+encodeURIComponent(t)+'&chain='+c,{headers:{'X-RugRadar-Key':k}}):await fetch('/rugradar/api/check?token='+encodeURIComponent(t)+'&chain='+c,{method:'POST'});
 const j=await r.json().catch(()=>({}));
 if(!r.ok){const used=j.error==='free_checks_used';msgCard(j.message||(r.status===402&&k?'Credit key not accepted or out of credits.':'Error '+r.status),r.status===402||used,used?'Free check used. Credits unlock the full report.':null);if(used)q.textContent='Free check used. Credits unlock the full report.';return}
 render(j,t);
 if(j.free_checks_left!=null)q.textContent=j.free_checks_left>0?j.free_checks_left+' free limited check(s) left.':'Free check used. Credits unlock the full report.';
 if(j.credits_remaining!=null){q.textContent=j.credits_remaining+' credit(s) left on your key.';pill(j.credits_remaining);if(k&&KS.get()!==k)KS.set(k)}
 }catch(err){msgCard('Network error, try again.')}finally{go.disabled=false}});
function pill(n){$('credpill').textContent=(n==null?'Credits':'Credits: '+n)+' \u00b7 Buy'}
$('credpill').addEventListener('click',e=>{e.preventDefault();openBuy(true)});$('buyc').addEventListener('click',()=>openBuy(false));
document.querySelectorAll('a[href="#agents"]').forEach(a=>a.addEventListener('click',()=>{$('agents').open=true}));
if(location.hash==='#agents')$('agents').open=true;if(location.hash==='#credits')openBuy(false);
try{const u=new URLSearchParams(location.search),t=u.get('token'),c=u.get('chain');if(t&&t.length<=64){$('tok').value=t;if(c&&$('chain').querySelector('option[value="'+c.replace(/[^a-z]/g,'')+'"]'))$('chain').value=c}}catch(e){}
keyUI();document.getElementById('wpayHome').append(walletPacks());
(function(){const k=KS.get();if(!k)return;$('keyd').open=true;fetch('/credits/balance',{headers:{'X-RugRadar-Key':k}}).then(r=>r.json()).then(j=>{if(j&&j.known)pill(j.credits)}).catch(()=>{})})();
`;

function page(d: WebDeps) {
  const U = d.publicUrl, p = d.priceUsd;
  const fast = d.speed ? `~${Math.round(d.speed.x)}x` : null;
  const faq = [
    ["Is RugRadar free?", `People get ${FREE_COPY} The free check gives a 0-100 risk score with plain danger warnings. Prepaid credits cost $${p} per full report (buy 1 to 1,000). Agents pay $${p} per call via x402 or use a credit key.`],
    ["Which chains does the rug check support?", "Solana (including pump.fun tokens), BNB Chain (four.meme), Base, Ethereum and Arbitrum. Chain is detected from the address."],
    ["What does the full report add?", "More danger warnings that free checkers usually miss, in plain words, plus a can-you-sell result."],
    ["Is a low score a guarantee?", `No. ${DISCLAIMER}`],
  ];
  const ld = [
    { "@context": "https://schema.org", "@type": "SoftwareApplication", name: "RugRadar", applicationCategory: "FinanceApplication", operatingSystem: "Web", url: `${U}/rugradar`, image: `${U}/rugradar/rug-radar-512.png`,
      description: "Free Solana rug check and honeypot checker: 0-100 token risk score with plain danger warnings for Solana, BNB, Base, Ethereum and Arbitrum.", offers: { "@type": "Offer", price: p, priceCurrency: "USD" } },
    { "@context": "https://schema.org", "@type": "FAQPage", mainEntity: faq.map(([q, a]) => ({ "@type": "Question", name: q, acceptedAnswer: { "@type": "Answer", text: a } })) },
  ];
  const cfg = { offer: unlockOffer(U, p), warn: WARN, chains: CHAIN_NAME, p };
  const swapJs = d.swap?.enabled ? "\n" + swapClientJs(d.swap) + "\nconst SWAPHOOK=swapBox;" : "";
  const json = (o: unknown) => JSON.stringify(o).replace(/</g, "\\u003c");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>RugRadar: Free Solana Rug Check & Honeypot Checker</title>
<meta name="description" content="Free rug pull checker and honeypot check for new tokens on Solana (pump.fun), BNB, Base, Ethereum and Arbitrum. Paste a token address, get a 0-100 risk score with plain danger warnings. 1 free limited check per visitor.">
<link rel="canonical" href="${U}/rugradar"><link rel="icon" href="/favicon.ico"><link rel="icon" type="image/png" sizes="32x32" href="/rugradar/rug-radar-32.png"><link rel="apple-touch-icon" href="/rugradar/rug-radar-192.png">
<meta property="og:type" content="website"><meta property="og:title" content="RugRadar: free rug check & honeypot checker"><meta property="og:description" content="0-100 token risk score with plain danger warnings. Solana, BNB, Base, Ethereum, Arbitrum."><meta property="og:url" content="${U}/rugradar"><meta property="og:image" content="${U}/rugradar/preview-label.png"><meta name="twitter:card" content="summary_large_image">
<script type="application/ld+json">${json(ld)}</script>
<style>${CSS_BASE}
${CSS_PAGE}</style></head><body><div class="wrap">
<header><a class="logo" href="/rugradar"><img src="/rugradar/rug-radar-64.png" alt="" width="28" height="28">RugRadar</a><a class="pill" id="credpill" href="#credits">Credits \u00b7 Buy</a></header>
<section class="hero" aria-label="Token checker">
<h1>Is this token a rug? Check before you buy.</h1>
<p>Paste an address. Plain danger warnings in seconds.</p>
<form id="f" class="search"><input id="tok" name="token" required autocomplete="off" spellcheck="false" placeholder="Token address (Solana mint or 0x contract)" aria-label="Token address"><button class="btn pri" id="go">Check token</button></form>
<div class="subrow"><select id="chain" class="chainchip" aria-label="Chain" title="Chain: Auto-detect (Solana, Base, BNB, Ethereum, Arbitrum)"><option value="auto">Auto \u25BE</option>${CHAINS.map((c) => `<option value="${c}">${CHAIN_NAME[c]}</option>`).join("")}</select><span class="trust">Free \u00b7 no sign-up</span></div>
<details class="keyd" id="keyd"><summary>Have a credit key?</summary><input id="key" placeholder="Credit key (rr_...)" autocomplete="off" aria-label="Credit key"><small id="keybox" hidden></small></details>
<small id="quota">${FREE_COPY}</small>
</section>
<div class="grid" style="margin-top:14px">
<main><div id="out" aria-live="polite"></div></main>
<aside><section class="card cred" aria-label="Prepaid credits">
<h2 id="credits">${fast ? `Prepaid credits finish checks ${fast} faster` : "Prepaid credits"}</h2>
<p class="mut">$${p} per full report \u00b7 buy 1 to 1,000 \u00b7 no account.</p>
<button class="btn pri wide" id="buyc" type="button">${fast ? `Buy credits: results ${fast} faster` : "Buy credits"}</button>
<p class="note">${d.speed ? `With credits you don't wait on a payment for each check (measured ~${d.speed.x}x faster).` : "With credits you don't wait on a payment for each check."}</p>
<div id="buyx" hidden><div id="wpayHome"></div><small class="mut">Agents and scripts: pay once with any x402 client: <code>GET ${U}/credits/buy?credits=${UNLOCK_CREDITS}</code> ($${(UNLOCK_CREDITS * Number(p)).toFixed(2)}). You get a secret key once; paste it under "Have a credit key?" or send it as <code>X-RugRadar-Key</code>.</small></div>
<div class="row" style="margin-top:8px"><a class="btn ghost" href="#agents">For bots &amp; agents</a></div>
</section></aside>
</div>
${agentsSection(U, p)}
<details class="fold"><summary>How RugRadar works</summary><p class="mut">We turn public on-chain and market data into a 0-100 risk score with plain danger warnings. Danger warnings only: a low score is not a guarantee.</p>${faq.map(([q, a]) => `<h3 style="font-size:15px;margin:12px 0 2px">${q}</h3><p class="mut" style="margin:0">${a}</p>`).join("")}</details>
<footer>RugRadar \u00b7 ${DISCLAIMER} Danger warnings only, never a guarantee; it never labels people.</footer>
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
    embed: `<iframe src="${U}/rugradar/embed?token=<mint or 0x address>" width="380" height="350" style="border:0;max-width:100%" loading="lazy" title="RugRadar token risk"></iframe>`,
    embedJson: `curl -s "${U}/rugradar/embed.json?token=${EXAMPLE_MINT}"\n# -> {"riskScore":0,"riskLevel":"low","verdict":"No danger warnings found. Not a guarantee.","warnings":[...],"report":"${U}/rugradar?token=..."}`,
    python: `import hmac, hashlib, re, time\ndef verify(raw: bytes, header: str, secret: str) -> bool:\n    m = re.fullmatch(r"t=(\\d+),v1=([0-9a-f]{64})", header or "")\n    if not m or abs(time.time() - int(m[1])) > 300: return False\n    want = hmac.new(secret.encode(), m[1].encode() + b"." + raw, hashlib.sha256).hexdigest()\n    return hmac.compare_digest(want, m[2])`,
  };
}
function agentsSection(U: string, p: string) {
  const c = agentSnippets(U), pre = (t: string) => `<pre>${escH(t)}</pre>`;
  const tools: [string, string, string][] = [
    ["rug_check", "0-100 rug risk score, plain danger warnings and a buyer summary (Solana incl. pump.fun, BNB, Base, Ethereum, Arbitrum)", `$${p}`],
    ["token_safety", "Same engine, token-safety wording: authorities, holders, liquidity, dev history, snipers, bundles", `$${p}`],
    ["honeypot_check", "Can I sell it? Sell quote / simulated sell and tax, freeze authority", `$${p}`],
    ["watch_token", "Watch one Solana token; signed webhook alert on dev sells, liquidity drop, new mint/freeze authority, score jump, can't sell", "$0.05 / 24h, $0.10 / 48h"],
  ];
  const eps: [string, string][] = [
    [`GET /rug-check?token=&lt;mint|0x&gt;[&amp;chain=]`, `$${p}`], [`GET /token-safety?token=…`, `$${p}`], [`GET /honeypot-check?token=…`, `$${p}`],
    [`GET /watch?token=&lt;mint&gt;&amp;hours=24|48&amp;webhook=&lt;https url&gt;`, "$0.05 (24h) / $0.10 (48h)"], [`GET /credits/buy?credits=N`, `$${p} per credit (1-1000)`],
  ];
  const row = (cells: string[]) => `<tr>${cells.map((x) => `<td>${x}</td>`).join("")}</tr>`;
  return `<details class="fold agents" id="agents"><summary>For bots &amp; agents (MCP + x402 + embed)</summary><div>
<p><b>MCP server</b> (streamable HTTP, JSON): <code>${U}/mcp</code>. Add it to any MCP client:</p>${pre(c.mcpConfig)}
<table>${tools.map(([n, d, pr]) => row([`<code>${n}</code>`, escH(d), pr])).join("")}</table>
<p>Pass a credit key (<code>api_key</code> or header <code>X-RugRadar-Key</code>); without one, a tool returns the x402 payment requirement. List tools:</p>${pre(c.mcpList)}
<p><b>x402 endpoints</b> (USDC on Solana, Base, Polygon, Arbitrum and more; no signup):</p><table>${eps.map(([e, pr]) => row([`<code>${e}</code>`, pr])).join("")}</table>
<p>The 402 flow:</p>${pre(c.x402)}
<p><b>Credit keys</b> skip the x402 round trip:</p>${pre(c.credits)}
<p><b>Embed the RugRadar card</b> (about 360 px, free check data, danger warnings only). Paste on any page:</p>${pre(c.embed)}<p>Or fetch the same data as JSON (score, verdict, top 3 warning titles, report link):</p>${pre(c.embedJson)}
<p><b>Webhook signature</b>: header <code>X-RugRadar-Signature: t=&lt;unix&gt;,v1=&lt;hex&gt;</code>, HMAC-SHA256 of <code>t + "." + rawBody</code> with your watch secret. Node:</p>${pre(c.node)}<p>Python:</p>${pre(c.python)}
<p><small>Discovery: <a href="/.well-known/x402">/.well-known/x402</a> · <a href="/openapi.json">/openapi.json</a> · <a href="/llms.txt">/llms.txt</a>. Danger warnings only; heuristic, may be wrong, not financial advice.</small></p></div></details>`;
}


// ---------- embed card + JSON (free check data, danger warnings only) ----------
const escA = (t: unknown) => String(t ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const VERDICT: Record<string, [string, string]> = { high: ["HIGH RISK", "Strong rug warning signs."], medium: ["CAUTION", "Some rug warning signs."], low: ["LOW RISK", "No danger warnings found. Not a guarantee."] };
export type EmbedData = { product: "RugRadar"; report: "free"; token: string; chain: string; riskScore: number; riskLevel: string; label: string; verdict: string; warnings: { severity: string; title: string; line: string }[]; moreWarnings: number; reportUrl: string; disclaimer: string; generatedAt: string };
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
    const l = limitedReport(await d.rugCheck(token, chain));
    const lv = VERDICT[l.riskLevel] ? l.riskLevel : "medium", ws = warningsOf(l.checks);
    const verdict = lv === "low" && ws.some((w) => w.sev === "DANGER") ? "Few warning signs. Not a guarantee." : VERDICT[lv]![1];
    const v: EmbedData = { product: "RugRadar", report: "free", token, chain, riskScore: l.riskScore, riskLevel: lv, label: VERDICT[lv]![0], verdict,
      warnings: ws.slice(0, 3).map((w) => ({ severity: w.sev, title: w.title, line: w.line })), moreWarnings: Math.max(0, ws.length - 3) + (Number(l.hiddenWarnings) || 0),
      reportUrl: `${d.publicUrl}/rugradar?token=${encodeURIComponent(token)}&chain=${chain}`, disclaimer: "Danger warnings only. Not a guarantee, not financial advice.", generatedAt: new Date().toISOString() };
    embedCache.set(k, { at: Date.now(), v }); if (embedCache.size > 300) embedCache.delete(embedCache.keys().next().value!);
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
.efoot{display:flex;justify-content:space-between;align-items:center;gap:8px;font-size:12px;color:var(--mut)}.efoot a{font-weight:700;font-size:13px;white-space:nowrap}.credit{font-size:11px;color:#6f7990}.emsg{font-size:14px;margin:6px 0}`;
function embedHtml(U: string, v: EmbedData | null, msg?: string) {
  const body = v
    ? `<div class="etok"><b>${escA(v.token.slice(0, 4))}\u2026${escA(v.token.slice(-6))}</b> \u00b7 ${escA(CHAIN_NAME[v.chain] ?? v.chain)} \u00b7 free check</div>
<div class="verdict v-${v.riskLevel}"><div class="gauge g-${v.riskLevel}" style="--p:${v.riskLevel === "low" ? 100 : Math.max(4, Math.min(100, v.riskScore))}"><i>${v.riskScore}<small>/100</small></i></div><div><div class="vt ${v.riskLevel}">${v.label}</div><div class="vl">${escA(v.verdict)}</div></div></div>
${v.warnings.length ? `<div class="wcards">${v.warnings.map((w) => `<details class="wc ${w.severity === "DANGER" ? "d" : "c"}"><summary><span class="sev ${w.severity === "DANGER" ? "s3" : "s2"}">${w.severity}</span><span class="tt">${escA(w.title)}</span><span class="ch"></span></summary><p>${escA(w.line)}</p></details>`).join("")}</div>` : ""}
<div class="efoot"><a href="${escA(v.reportUrl)}" target="_blank" rel="noopener">Unlock full report \u203a</a><span class="credit">Not a guarantee \u00b7 <b>RugRadar</b></span></div>`
    : `<p class="emsg">${escA(msg ?? "Add ?token=<address> to show a RugRadar card.")}</p><div class="efoot"><a href="${U}/rugradar" target="_blank" rel="noopener">Check a token \u203a</a><span class="credit">Not a guarantee \u00b7 <b>RugRadar</b></span></div>`;
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
const TOOLS = [
  ["rug_check", "RugRadar rug check / rug pull checker: 0-100 risk score with plain reasons and a buyer summary for a token on Solana (incl. pump.fun), BNB, Base, Ethereum or Arbitrum. " + RUG_EDGE],
  ["token_safety", "RugRadar token safety check: mint/freeze authority, holder concentration, liquidity, age, deployer history, dev holding/sold, snipers, bundles, volume vs market cap, socials; 0-100 risk score. " + RUG_EDGE],
  ["honeypot_check", "RugRadar honeypot check: can I sell this token? Simulated buy/sell and tax on EVM chains, live Jupiter sell quote plus freeze/mint authority and token-2022 transfer controls on Solana; 0-100 risk score. " + RUG_EDGE],
] as const;
const WATCH_TOOL = { name: "watch_token", description: "RugRadar Watch + Alert: watch one Solana token for 24h ($0.05 = 5 credits) or 48h ($0.10 = 10 credits). Re-checked about every 10 min with the RugRadar engine; signed webhook alert when the dev sells, liquidity drops 30%+, mint/freeze authority appears, risk score jumps 20+ points, or it can't be sold. Pass a RugRadar credit key; without one the tool returns the x402 payment requirement for GET /watch.",
  inputSchema: { type: "object", properties: { token: { type: "string", description: "Solana mint address" }, hours: { type: "string", enum: ["24", "48"], description: "default 24" }, webhook_url: { type: "string", description: "https URL for signed JSON POST alerts" }, telegram_chat_id: { type: "string", description: "Telegram chat id (coming soon)" }, api_key: { type: "string", description: "RugRadar credit key (or header X-RugRadar-Key)" } }, required: ["token"] },
  annotations: { readOnlyHint: false, openWorldHint: true } };
const ROUTE: Record<string, string> = { rug_check: "/rug-check", token_safety: "/token-safety", honeypot_check: "/honeypot-check" };
const schema = { type: "object", properties: { token: { type: "string", description: "Solana mint or EVM 0x token contract" }, chain: { type: "string", enum: CHAINS, description: "default solana; 0x addresses default to base" }, api_key: { type: "string", description: "optional RugRadar credit key (or send header X-RugRadar-Key)" } }, required: ["token"] };

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
async function mcpCall(d: WebDeps, name: string, args: any, headerKey: string | undefined) {
  if (name === "watch_token") return mcpWatch(d, args, headerKey);
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
      try { return text({ ...(await d.rugCheck(token, chain)), paidWith: "credits", credits_remaining: left }); }
      catch (e) { await d.refund(key); return text({ error: String((e as Error).message ?? e), refunded: true }, true); }
    }
  }
  // No usable key: return the live x402 payment requirement for the HTTP endpoint.
  const url = `${d.publicUrl}${route}?token=${encodeURIComponent(token)}&chain=${chain}`;
  let requirement: unknown = null;
  try { const r = await fetch(url, { headers: { accept: "application/json", "user-agent": "rugradar-mcp-self (self)" }, signal: AbortSignal.timeout(5000) }); const h = r.headers.get("payment-required"); requirement = h ? JSON.parse(Buffer.from(h, "base64").toString()) : null; } catch {}
  return text({ error: "payment_required", priceUsd: Number(d.priceUsd), payWith: { x402: { url, method: "GET", paymentRequired: requirement }, credits: { buy: `${d.publicUrl}/credits/buy?credits=100`, use: "send header X-RugRadar-Key or pass api_key" } }, disclaimer: DISCLAIMER }, true);
}


export function registerRugradarWeb(app: Express, d: WebDeps) {
  const html = page(d);
  app.get("/rugradar", (_req, res) => { res.set("Cache-Control", "public, max-age=300").type("html").send(html); });
  app.get("/rugradar/embed", async (req: Request, res: Response) => {
    const r = await embedFor(d, req);
    res.status(r.status).set({ "Cache-Control": r.status === 200 ? "public, max-age=300" : "no-store", "Content-Security-Policy": "frame-ancestors *" }).type("html").send(embedHtml(d.publicUrl, r.v, r.msg));
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
  app.post("/rugradar/api/check", async (req: Request, res: Response) => {
    res.set("Cache-Control", "no-store");
    const token = String(req.query.token ?? "").trim(), chain = String(req.query.chain ?? "solana").toLowerCase();
    if (!CHAINS.includes(chain) || !validToken(token, chain)) { res.status(400).json({ error: "invalid_input", message: chain === "solana" ? "Paste a Solana mint address (base58, 32-44 chars) or pick an EVM chain for 0x addresses." : "Paste a 0x token contract address (40 hex characters)." }); return; }
    let vid = cookieVid(req);
    if (!vid) { vid = randomBytes(16).toString("base64url"); res.append("Set-Cookie", `rr_vid=${vid}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax; Secure`); }
    const ip = ipOf(req), a = freeAllowance(ip, vid);
    if (!a.ok) {
      const msg = a.reason === "slow_down" ? "One check every few seconds, please." : a.reason === "daily_free_cap" ? "Today's free checks are used up. Buy credits to keep checking." : `You've used your free limited check. Buy credits ($${d.priceUsd} each) for the full report.`;
      res.status(a.reason === "slow_down" ? 429 : 402).json({ error: a.reason, message: msg, buyCredits: `${d.publicUrl}/credits/buy?credits=100`, ...(a.reason === "slow_down" ? {} : { lockedSignals: LOCKED_SIGNALS, unlockOffer: unlockOffer(d.publicUrl, d.priceUsd) }) }); return;
    }
    useFree(ip, vid);
    try { res.json({ ...limitedReport(await d.rugCheck(token, chain)), unlockOffer: unlockOffer(d.publicUrl, d.priceUsd), free_checks_left: a.left }); }
    catch (e) { refundFree(ip, vid); res.status(422).json({ error: "check_failed", message: `${String((e as Error).message ?? e)}. This did not use a free check.` }); }
  });
  app.get("/sitemap.xml", (_req, res) => {
    const now = new Date().toISOString().slice(0, 10);
    res.type("application/xml").send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${["/rugradar", "/", "/examples"].map((p) => `<url><loc>${d.publicUrl}${p}</loc><lastmod>${now}</lastmod></url>`).join("\n")}\n</urlset>\n`);
  });
  app.get("/mcp", (_req, res) => { res.status(405).set("Allow", "POST").json({ error: "use POST (MCP streamable HTTP, JSON responses)", tools: [...TOOLS.map(([n]) => n), ...(d.watch ? [WATCH_TOOL.name] : [])] }); });
  app.post("/mcp", async (req: Request, res: Response) => {
    const m = req.body ?? {};
    const reply = (o: object) => res.json({ jsonrpc: "2.0", id: m.id ?? null, ...o });
    if (Array.isArray(m)) { res.status(400).json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "batching not supported" } }); return; }
    if (m.id === undefined) { res.status(202).end(); return; } // notifications
    switch (m.method) {
      case "initialize": return reply({ result: { protocolVersion: m.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "rugradar", title: "RugRadar", version: "1.0.0" }, instructions: `Token rug/honeypot risk checks. Each call costs $${d.priceUsd}: pass a RugRadar credit key (header X-RugRadar-Key or api_key), otherwise the tool returns the x402 payment requirement. ${DISCLAIMER}` } });
      case "ping": return reply({ result: {} });
      case "tools/list": return reply({ result: { tools: [...TOOLS.map(([name, description]) => ({ name, description, inputSchema: schema, annotations: { readOnlyHint: true, openWorldHint: true } })), ...(d.watch ? [WATCH_TOOL] : [])] } });
      case "tools/call": return reply(await mcpCall(d, m.params?.name, m.params?.arguments, req.header("x-rugradar-key")));
      default: return reply({ error: { code: -32601, message: `method not found: ${m.method}` } });
    }
  });
}
