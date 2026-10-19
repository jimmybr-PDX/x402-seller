/**
 * RugRadar "Buy this token" button (Jupiter Plugin, non-custodial: the user signs their own swap in their own wallet).
 * OFF by default. Shown only when RUGRADAR_SWAP_ENABLED=1 AND JUP_REFERRAL_ACCOUNT is a valid Solana address, and only
 * on full Solana reports that pass a strict low-risk rule (below). Fee: fixed 0.5% (50 bps) via Jupiter's Referral
 * Program; Jupiter keeps 20% of it. (The page body is a flex box, so the plugin's container is pinned full-width to keep the modal visible.) Never used in watches, alerts, webhooks, MCP tools or x402 responses.
 */
export const SWAP_FEE_BPS = 50;
export const JUP_PLUGIN_SRC = "https://plugin.jup.ag/plugin-v1.js";
export const SOL_MINT = "So11111111111111111111111111111111111111112";
export type SwapCfg = { enabled: boolean; referralAccount: string | null; feeBps: number; reason: string };
const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function swapConfig(env: Record<string, string | undefined> = process.env): SwapCfg {
  const ref = String(env.JUP_REFERRAL_ACCOUNT ?? "").trim();
  if (String(env.RUGRADAR_SWAP_ENABLED ?? "0").trim() !== "1") return { enabled: false, referralAccount: null, feeBps: SWAP_FEE_BPS, reason: "RUGRADAR_SWAP_ENABLED is not 1 (default off)" };
  if (!B58.test(ref)) return { enabled: false, referralAccount: null, feeBps: SWAP_FEE_BPS, reason: "JUP_REFERRAL_ACCOUNT missing or not a Solana address" };
  return { enabled: true, referralAccount: ref, feeBps: SWAP_FEE_BPS, reason: "on" };
}

/**
 * The one low-risk rule, as browser JS. The page ships exactly this string and the tests run exactly this string.
 * Shown only if ALL hold: full (not limited) Solana report; low risk (score < 25); high confidence with no unknown
 * signals; mint and freeze authority known and revoked; known creator, not on the bad-deployer list, no flagged funder,
 * no earlier dead launches; at least 24 h old (not "very new", not new-coin scoring); sellable through a Jupiter route
 * with < 10% price impact on the ~$100 test; and no risk points on authority/deployer/sell/honeypot checks.
 */
export const SWAP_RULE_JS = `function swapOk(r){if(!r||typeof r!=='object')return false;var f=r.facts||{},b=r.buyer||{},c=r.checks;
if(r.product!=='RugRadar'||r.chain!=='solana'||r.report==='limited'||r.scoring)return false;
if(!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(String(r.token||'')))return false;
if(r.riskLevel!=='low'||typeof r.riskScore!=='number'||!(r.riskScore<25))return false;
if(r.confidence!=='high'||!Array.isArray(r.unknownSignals)||r.unknownSignals.length)return false;
if(!('mintAuthority' in f)||!('freezeAuthority' in f)||f.mintAuthority||f.freezeAuthority)return false;
if(!f.creator||f.creatorFlagged||f.funderFlagged||Number(f.priorDead)>0)return false;
if(typeof f.ageHours!=='number'||!(f.ageHours>=24))return false;
if(b.sellRoute!==true||!/^yes/.test(String(b.canSell||''))||typeof b.sellPriceImpactPct!=='number'||!(b.sellPriceImpactPct<10))return false;
if(!Array.isArray(c))return false;var bad={mint_authority:1,freeze_authority:1,deployer_history:1,known_pattern:1,shared_funder:1,sell_route:1,sell_impact:1,honeypot:1};
for(var i=0;i<c.length;i++){if(c[i]&&bad[c[i].check]&&Number(c[i].points)>0)return false}
return true}`;
export const swapEligible = new Function(`${SWAP_RULE_JS};return swapOk;`)() as (r: unknown) => boolean;

export const SWAP_LABEL = "RugRadar earns 0.5% on swaps via this button.";
/** Browser snippet appended to the page ONLY when the feature is on. Loads the Jupiter Plugin lazily when the button is shown. */
export function swapClientJs(c: SwapCfg) {
  if (!c.enabled || !c.referralAccount) return "";
  const cfg = JSON.stringify({ ref: c.referralAccount, bps: c.feeBps, src: JUP_PLUGIN_SRC, sol: SOL_MINT, label: SWAP_LABEL });
  return `${SWAP_RULE_JS}
const SWAP=${cfg};let JUPP=null;
function jupLoad(){if(!JUPP)JUPP=new Promise((ok,no)=>{const c=document.createElement('style');c.textContent='#jupiter-plugin-instance{position:fixed;top:0;left:0;width:100%;z-index:1000}';document.head.append(c);const s=document.createElement('script');s.src=SWAP.src;s.async=true;s.onload=()=>ok(window.Jupiter);s.onerror=()=>{JUPP=null;no(new Error('load'))};document.head.append(s)});return JUPP}
function swapBox(j){if(!swapOk(j))return null;const b=el('div',null);b.id='swapbox';
 const bt=el('button','btn go','Buy this token \\u2197');bt.type='button';bt.title=SWAP.label;const st=el('small',null,'');
 bt.addEventListener('click',()=>{st.textContent='Opening Jupiter...';jupLoad().then(J=>{st.textContent='';J.init({displayMode:'modal',formProps:{initialInputMint:SWAP.sol,initialOutputMint:j.token,fixedMint:j.token,referralAccount:SWAP.ref,referralFee:SWAP.bps}})}).catch(()=>{st.textContent='Could not load Jupiter. Try again.'})});
 b.append(bt,el('div','buyline','Opens swap in your wallet \\u00b7 '+(SWAP.bps/100)+'% fee \\u00b7 not advice'),st);
 jupLoad().catch(()=>{});return b}`;
}
