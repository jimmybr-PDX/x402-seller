/**
 * RugRadar web surface: branded landing page with a free web checker (1 free limited check per visitor, limited by IP
 * and cookie), sitemap.xml, and an MCP server (streamable HTTP, JSON responses) at /mcp.
 */
import { RUG_EDGE } from "./rug-extra.js";
import type { Express, Request, Response } from "express";
import { randomBytes } from "node:crypto";

export type WebDeps = {
  publicUrl: string; port: number; priceUsd: string; speed: { creditS: number; paidS: number; x: number } | null;
  rugCheck: (t: string, chain: string) => Promise<any>;
  spend: (k: string) => Promise<number | null>; refund: (k: string) => Promise<void>;
};
export const FREE_PER_VISITOR = 1;
export const FREE_COPY = "1 free limited check per visitor, then credits for the full report.";
const LIMITED_CHECKS = new Set(["mint_authority", "freeze_authority", "mint_function", "holders", "liquidity", "age"]);
export const LOCKED_SIGNALS = ["exact dev-sold %", "sniper share", "launch-bundle share", "can-you-sell quote with price impact", "creator's past launches", "organic/bot score", "full buyer summary"];
export const UNLOCK_CREDITS = 10;
/** Conversion offer shown after a free check (or when it is used up). Points only at the existing credits flow and x402 paths. */
export function unlockOffer(publicUrl: string, priceUsd: string) {
  const usd = (UNLOCK_CREDITS * Number(priceUsd)).toFixed(2);
  return { credits: UNLOCK_CREDITS, priceUsd: usd, label: `Unlock full report \u2014 ${UNLOCK_CREDITS} credits for $${usd}`, buy: `${publicUrl}/credits/buy?credits=${UNLOCK_CREDITS}`, useKey: "Paste the key in the Credit key box (or send header X-RugRadar-Key) and check again.", agents: `Agents: pay $${priceUsd} per call via x402 at ${publicUrl}/rug-check, or send X-RugRadar-Key.` };
}
/** Free web check: basic score from mint/freeze authority, top-holder concentration, age and liquidity only. Paid paths never call this. */
export function limitedReport(full: any) {
  const f = full?.facts ?? {};
  const checks = (Array.isArray(full?.checks) ? full.checks : []).filter((c: any) => LIMITED_CHECKS.has(c?.check)).map((c: any) => ({ check: c.check, points: c.points, detail: c.detail }));
  const score = Math.min(100, checks.reduce((a: number, c: any) => a + (Number(c.points) || 0), 0));
  const level = score >= 50 ? "high" : score >= 25 ? "medium" : "low";
  const pick = (k: string) => (f[k] === undefined ? null : f[k]);
  return {
    product: "RugRadar", report: "limited", chain: full?.chain ?? null, token: full?.token ?? null, riskScore: score, riskLevel: level, scoring: "basic score (mint/freeze authority, top holders, age, liquidity)",
    verdict: level === "high" ? "Multiple high-risk patterns found." : level === "medium" ? "Some high-risk patterns found." : "No major high-risk patterns found in the basic checks.",
    reasons: checks.filter((c: any) => c.points > 0).map((c: any) => c.detail), checks,
    facts: { mintAuthority: pick("mintAuthority"), freezeAuthority: pick("freezeAuthority"), top1Pct: pick("top1Pct"), top10Pct: pick("top10Pct"), holderCount: pick("holderCount"), ageHours: pick("ageHours"), liquidityUsd: pick("liquidityUsd") },
    lockedSignals: LOCKED_SIGNALS, unlock: "Credits unlock the full report (paste a credit key above, or send X-RugRadar-Key).",
    disclaimer: full?.disclaimer ?? DISCLAIMER, generatedAt: full?.generatedAt ?? new Date().toISOString(),
  };
}
const FREE_DAILY_CAP = Number(process.env.RUGRADAR_FREE_DAILY_CAP ?? 500);
const DISCLAIMER = "Automated heuristic, may be wrong. Not financial advice. Do your own research.";

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

function page(d: WebDeps) {
  const U = d.publicUrl, p = d.priceUsd;
  const sp = d.speed ? `Prepaid credits: ~${d.speed.creditS}s per check vs ~${d.speed.paidS}s pay-per-call: ${d.speed.x}x faster` : "Prepaid credits: pay once, then check with just a key";
  const faq = [
    ["How is RugRadar different from RugCheck?", "In a side-by-side test on 5 Solana tokens RugRadar returned 28 of 30 buyer signals vs 14 for RugCheck's free report, including dev-sold %, sniper and bundle share, a live sell test, volume vs market cap and a bot-trading score, and it also covers Base, BNB, Ethereum and Arbitrum."],
    ["Is RugRadar free?", `People get ${FREE_COPY} The free check shows a basic risk score, mint/freeze authority, top-holder concentration, token age and liquidity. Prepaid credits cost $${p} per full check (buy 1 to 1,000). Agents pay $${p} per call via x402 or use a credit key.`],
    ["Which chains does the rug check support?", "Solana (including pump.fun tokens), BNB Chain (four.meme), Base, Ethereum and Arbitrum."],
    ["What does the honeypot check look at?", "On EVM chains a simulated buy and sell (can you sell, buy/sell tax) plus owner powers like mint, pause and blacklist. On Solana, active freeze or mint authority, holder concentration, liquidity, token age and the deployer's earlier launches."],
    ["Is a low score a guarantee?", DISCLAIMER],
  ];
  const ld = [
    { "@context": "https://schema.org", "@type": "SoftwareApplication", name: "RugRadar", applicationCategory: "FinanceApplication", operatingSystem: "Web", url: `${U}/rugradar`, image: `${U}/rugradar/rug-radar-512.png`,
      description: "Free Solana rug check and honeypot checker: 0-100 token risk score with plain reasons for Solana, BNB, Base, Ethereum and Arbitrum.", offers: { "@type": "Offer", price: p, priceCurrency: "USD" } },
    { "@context": "https://schema.org", "@type": "FAQPage", mainEntity: faq.map(([q, a]) => ({ "@type": "Question", name: q, acceptedAnswer: { "@type": "Answer", text: a } })) },
  ];
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>RugRadar: Free Solana Rug Check & Honeypot Checker (Token Safety Score)</title>
<meta name="description" content="Free rug pull checker and honeypot check for new tokens on Solana (pump.fun), BNB, Base, Ethereum and Arbitrum. Paste a token address, get a 0-100 risk score with plain reasons. 1 free limited check per visitor.">
<link rel="canonical" href="${U}/rugradar"><link rel="icon" href="/favicon.ico"><link rel="icon" type="image/png" sizes="32x32" href="/rugradar/rug-radar-32.png"><link rel="apple-touch-icon" href="/rugradar/rug-radar-192.png">
<meta property="og:type" content="website"><meta property="og:title" content="RugRadar: free rug check & honeypot checker"><meta property="og:description" content="0-100 token risk score with plain reasons. Solana, BNB, Base, Ethereum, Arbitrum."><meta property="og:url" content="${U}/rugradar"><meta property="og:image" content="${U}/rugradar/preview-label.png"><meta name="twitter:card" content="summary_large_image">
<script type="application/ld+json">${JSON.stringify(ld).replace(/</g, "\\u003c")}</script>
<style>body{margin:0;background:#0A1630;color:#E8EEF8;font:16px/1.5 system-ui,sans-serif;display:flex;justify-content:center}main{max-width:760px;width:100%;padding:28px 18px}
h1{color:#46DC64;font-size:44px;margin:4px 0;text-align:center;text-shadow:0 0 18px rgba(70,220,100,.55)}h2{color:#46DC64;font-size:21px;margin:26px 0 8px}.c{text-align:center}img.logo{width:150px;height:150px}
.box{background:#12224a;border-radius:10px;padding:14px 18px;margin:14px 0}code{color:#F7931A;word-break:break-all}small{color:#9fb0cc}
.banner{background:#0f2a1a;border:2px solid #46DC64;border-radius:12px;padding:14px 18px;margin-bottom:18px;box-shadow:0 0 18px rgba(70,220,100,.35);text-align:center}.banner b{color:#46DC64;font-size:22px}
.btn{display:inline-block;background:#46DC64;color:#0A1630;font-weight:800;padding:10px 20px;border-radius:8px;text-decoration:none;border:0;font-size:16px;cursor:pointer}
input,select{font-size:16px;padding:10px;border-radius:8px;border:1px solid #2b3d6b;background:#0A1630;color:#E8EEF8}#tok{width:100%;box-sizing:border-box;margin:8px 0}
.row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}.score{font-size:48px;font-weight:800}.low{color:#46DC64}.medium{color:#F7931A}.high{color:#ff5a5a}ul{padding-left:20px}
.locked{border:1px dashed #46DC64;border-radius:10px;padding:12px 16px;margin:14px 0;background:#0d1b3a}.locked table{width:100%;border-collapse:collapse}.locked td{padding:5px 4px;border-bottom:1px solid #1d2f5c;color:#6f7f9c}.locked td.v{text-align:right;letter-spacing:2px}.locked .how{font-size:14px;color:#9fb0cc;margin-top:10px}</style></head>
<body><main>
<div class="banner"><b>${sp}</b><div style="margin:6px 0 10px"><b>${RUG_EDGE.replace("$0.01", "$" + p)}</b><br>Same $${p} per check, buy 1 to 1,000. Agents send the key as X-RugRadar-Key.</div><a class="btn" href="#credits">Buy credits</a></div>
<div class="c"><img class="logo" src="/rugradar/rug-radar-512.png" alt="RugRadar emblem" width="150" height="150"><h1>RugRadar</h1>
<p style="font-size:19px">Free rug check and honeypot checker: paste a token address, get a 0-100 risk score with plain reasons, plus what buyers actually ask: did the dev sell, how much did snipers and bundles take, can you sell, is the volume real.</p></div>
<section class="box" aria-label="Token checker"><form id="f"><label for="tok"><b>Token address</b> (Solana mint or 0x contract)</label>
<input id="tok" name="token" required autocomplete="off" spellcheck="false" placeholder="e.g. JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN">
<div class="row"><label for="chain">Chain</label><select id="chain">${CHAINS.map((c) => `<option value="${c}">${c === "bnb" ? "BNB (BSC)" : c[0]!.toUpperCase() + c.slice(1)}</option>`).join("")}</select>
<input id="key" placeholder="Credit key (optional)" autocomplete="off" style="flex:1;min-width:180px"><button class="btn" id="go">Check token</button></div>
<small id="quota">${FREE_COPY}</small></form><div id="out" aria-live="polite"></div></section>
<h2>Free Solana rug check (incl. pump.fun)</h2><p>Mint and freeze authority, top-holder share, liquidity, token age, and the deployer wallet's earlier launches that died or never graduated, plus a funding wallet linked to earlier high-risk patterns.</p>
<h2>Honeypot check for BNB, Base, Ethereum and Arbitrum</h2><p>A simulated buy and sell shows whether you can sell and the real buy/sell tax, plus owner powers such as mint, pause and blacklist. Established, exchange-listed tokens are weighted accordingly.</p>
<h2>RugCheck alternative: what RugRadar shows that RugCheck doesn't</h2><div class="box">Tested on Oct 14, 2026 with the same 5 Solana tokens (a fresh pump.fun launch, a known rug, a mid-cap meme, an established token, and one with mint and freeze authority). RugCheck's free report covered 14 of our 30 buyer signals; RugRadar covered 28. Only RugRadar showed: dev sold % of what they bought, sniper share in the first 10 seconds, launch-block bundle share, a live can-you-sell quote with price impact, the creator's past launches and our bad-deployer list, market cap and liquidity vs market cap, 24h volume, buys, sells and traders, price, holder and liquidity change, a bot-trading (organic) score, social links, a plain buyer summary, a confidence rating, and 4 EVM chains. RugCheck still shows two things we don't: an insider-network graph and an "already rugged" flag.</div>
<h2 id="credits">Prepaid credits</h2><div class="box">$${p} per check, no discount, 1 to 1,000 credits. Pay once with any x402 client: <code>GET ${U}/credits/buy?credits=${UNLOCK_CREDITS}</code> ($${(UNLOCK_CREDITS * Number(p)).toFixed(2)}, unlocks ${UNLOCK_CREDITS} full reports) or <code>GET ${U}/credits/buy?credits=100</code> ($1.00). You get a secret key once; paste it above or send it as <code>X-RugRadar-Key</code>. Free balance: <code>${U}/credits/balance</code>.</div>
<h2>Rug pull checker API for AI agents (x402 + MCP)</h2><div class="box">HTTP: <code>GET ${U}/rug-check?token=&lt;address&gt;&amp;chain=solana</code> ($${p} via x402; also /token-safety and /honeypot-check).<br>MCP (streamable HTTP): <code>${U}/mcp</code> with tools rug_check, token_safety, honeypot_check.</div>
<h2>FAQ</h2>${faq.map(([q, a]) => `<h3 style="font-size:17px;margin:14px 0 4px">${q}</h3><p style="margin:0">${a}</p>`).join("")}
<p class="c"><small>${DISCLAIMER} RugRadar flags high-risk patterns; it never labels people.</small></p>
<script>
const f=document.getElementById('f'),out=document.getElementById('out'),q=document.getElementById('quota'),go=document.getElementById('go');
const el=(t,c,x)=>{const e=document.createElement(t);if(c)e.className=c;if(x!=null)e.textContent=x;return e};
const LOCKED=${JSON.stringify(LOCKED_SIGNALS)},OFFER=${JSON.stringify(unlockOffer(U, p))};
function lockedPanel(names,o,note){o=o||OFFER;const b=el('div','locked');b.id='unlock';b.append(el('b',null,note||'Full report: locked signals'));
 const tb=el('table');(names&&names.length?names:LOCKED).forEach(n=>{const tr=el('tr');tr.append(el('td',null,'\u{1F512} '+n),el('td','v','\u2022\u2022\u2022'));tb.append(tr)});b.append(tb);
 const a=el('a','btn',o.label);a.href='#credits';a.style.marginTop='12px';a.addEventListener('click',()=>{h.hidden=false;setTimeout(()=>document.getElementById('key').focus(),50)});b.append(a);
 const h=el('div','how');h.hidden=true;h.append(el('p',null,'1. Buy '+o.credits+' credits ($'+o.priceUsd+') with any x402 client: GET '+o.buy+' (you get a secret key once).'),el('p',null,'2. '+o.useKey),el('p',null,o.agents));b.append(h);return b}
document.getElementById('tok').addEventListener('input',e=>{if(e.target.value.trim().startsWith('0x')&&document.getElementById('chain').value==='solana')document.getElementById('chain').value='base'});
f.addEventListener('submit',async e=>{e.preventDefault();out.textContent='Checking...';go.disabled=true;
 const t=document.getElementById('tok').value.trim(),c=document.getElementById('chain').value,k=document.getElementById('key').value.trim();
 try{const r=k?await fetch('/rug-check?token='+encodeURIComponent(t)+'&chain='+c,{headers:{'X-RugRadar-Key':k}}):await fetch('/rugradar/api/check?token='+encodeURIComponent(t)+'&chain='+c,{method:'POST'});
 const j=await r.json().catch(()=>({}));out.textContent='';
 if(!r.ok){out.append(el('p',null,j.message||(r.status===402&&k?'Credit key not accepted or out of credits.':'Error '+r.status)));if(r.status===402||j.error==='free_checks_used'){out.append(lockedPanel(j.lockedSignals,j.unlockOffer,j.error==='free_checks_used'?'Free check used. The full report includes:':null));if(j.error==='free_checks_used')q.textContent='Free check used. Credits unlock the full report.'}return}
 const s=el('div','score '+j.riskLevel,j.riskScore+'/100');out.append(s,el('p',null,(j.riskLevel||'').toUpperCase()+' risk, confidence '+(j.confidence||'n/a')+'. '+(j.verdict||'')));
 if(j.buyerSummary)out.append(el('p',null,j.buyerSummary));
 const B=j.buyer||(j.facts&&j.facts.buyer)||{},F=[['Dev holds %','devHoldingPct'],['Dev sold % of buys','devSoldPctOfBought'],['Snipers % (first 10s)','sniperSupplyPct10s'],['Launch-bundle %','bundledSupplyPctLaunchSlot'],['Can sell ($100 test)','sellRoute'],['Sell price impact %','sellPriceImpactPct'],['Sell tax %','sellTaxPct'],['Market cap $','marketCapUsd'],['Liquidity / mcap %','liquidityToMcapPct'],['24h volume $','volume24hUsd'],['24h buys / sells',null],['Organic trading','organicLabel'],['LP','lpStatus'],['Socials','socials']];
 const tb=el('table');F.forEach(([n,k])=>{let v=k?B[k]:(B.buys24h!=null?B.buys24h+' / '+B.sells24h:null);if(v==null||v==='')return;if(Array.isArray(v))v=v.length?v.join(', '):'none';if(typeof v==='boolean')v=v?'yes':'NO';if(typeof v==='number'&&v>=1000)v=Math.round(v).toLocaleString();const tr=el('tr');tr.append(el('td',null,n),el('td',null,String(v)));tb.append(tr)});if(tb.childNodes.length)out.append(tb);
 const ul=el('ul');(j.reasons&&j.reasons.length?j.reasons:['No major high-risk patterns found.']).forEach(x=>ul.append(el('li',null,x)));out.append(ul);
 if(j.unknownSignals&&j.unknownSignals.length)out.append(el('p',null,'Unknown (scored neutral): '+j.unknownSignals.join(', ')));
 out.append(el('small',null,j.disclaimer||${JSON.stringify(DISCLAIMER)}));
 if(j.lockedSignals){out.append(el('p',null,'Limited free report: basic score, mint/freeze authority, top holders, age and liquidity.'));out.append(lockedPanel(j.lockedSignals,j.unlockOffer))}if(j.free_checks_left!=null)q.textContent=j.free_checks_left>0?j.free_checks_left+' free limited check(s) left.':'Free check used. Credits unlock the full report.';if(j.credits_remaining!=null)q.textContent=j.credits_remaining+' credit(s) left on your key.';
 }catch(err){out.textContent='Network error, try again.'}finally{go.disabled=false}});
</script></main></body></html>`;
}

// ---------- MCP (streamable HTTP, JSON responses, stateless) ----------
const TOOLS = [
  ["rug_check", "RugRadar rug check / rug pull checker: 0-100 risk score with plain reasons and a buyer summary for a token on Solana (incl. pump.fun), BNB, Base, Ethereum or Arbitrum. " + RUG_EDGE],
  ["token_safety", "RugRadar token safety check: mint/freeze authority, holder concentration, liquidity, age, deployer history, dev holding/sold, snipers, bundles, volume vs market cap, socials; 0-100 risk score. " + RUG_EDGE],
  ["honeypot_check", "RugRadar honeypot check: can I sell this token? Simulated buy/sell and tax on EVM chains, live Jupiter sell quote plus freeze/mint authority and token-2022 transfer controls on Solana; 0-100 risk score. " + RUG_EDGE],
] as const;
const ROUTE: Record<string, string> = { rug_check: "/rug-check", token_safety: "/token-safety", honeypot_check: "/honeypot-check" };
const schema = { type: "object", properties: { token: { type: "string", description: "Solana mint or EVM 0x token contract" }, chain: { type: "string", enum: CHAINS, description: "default solana; 0x addresses default to base" }, api_key: { type: "string", description: "optional RugRadar credit key (or send header X-RugRadar-Key)" } }, required: ["token"] };

async function mcpCall(d: WebDeps, name: string, args: any, headerKey: string | undefined) {
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
  app.get("/rugradar", (_req, res) => { res.set("Cache-Control", "public, max-age=300").type("html").send(page(d)); });
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
  app.get("/mcp", (_req, res) => { res.status(405).set("Allow", "POST").json({ error: "use POST (MCP streamable HTTP, JSON responses)", tools: TOOLS.map(([n]) => n) }); });
  app.post("/mcp", async (req: Request, res: Response) => {
    const m = req.body ?? {};
    const reply = (o: object) => res.json({ jsonrpc: "2.0", id: m.id ?? null, ...o });
    if (Array.isArray(m)) { res.status(400).json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "batching not supported" } }); return; }
    if (m.id === undefined) { res.status(202).end(); return; } // notifications
    switch (m.method) {
      case "initialize": return reply({ result: { protocolVersion: m.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "rugradar", title: "RugRadar", version: "1.0.0" }, instructions: `Token rug/honeypot risk checks. Each call costs $${d.priceUsd}: pass a RugRadar credit key (header X-RugRadar-Key or api_key), otherwise the tool returns the x402 payment requirement. ${DISCLAIMER}` } });
      case "ping": return reply({ result: {} });
      case "tools/list": return reply({ result: { tools: TOOLS.map(([name, description]) => ({ name, description, inputSchema: schema, annotations: { readOnlyHint: true, openWorldHint: true } })) } });
      case "tools/call": return reply(await mcpCall(d, m.params?.name, m.params?.arguments, req.header("x-rugradar-key")));
      default: return reply({ error: { code: -32601, message: `method not found: ${m.method}` } });
    }
  });
}
