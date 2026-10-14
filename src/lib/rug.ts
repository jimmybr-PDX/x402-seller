/**
 * Solana rug check: heuristic 0-100 risk score for an SPL mint from free public data only
 * (public Solana RPC + keyless DexScreener API). Automated heuristic, may be wrong. Not financial advice.
 */
import fs from "node:fs";
import path from "node:path";
import { rpc, SolanaInputError } from "./solana.js";

export const DISCLAIMER = "Automated heuristic, may be wrong. Not financial advice. Do your own research.";
const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const DS = "https://api.dexscreener.com/tokens/v1/solana/";
const KNOWN_PROGRAM_OWNERS = new Set(["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"]);

// ---------- local list of deployers behind high-risk patterns (repo file + in-memory additions) ----------
const LIST_FILE = process.env.RUG_LIST_FILE ?? path.join(process.cwd(), "src", "assets", "rugged-deployers.json");
type Entry = { dead: number; launches: number; seenAt: string };
let list: Record<string, Entry> = {};
try { list = JSON.parse(fs.readFileSync(LIST_FILE, "utf8")).wallets ?? {}; } catch {}
export const flaggedWallets = () => list;
export function flagDeployer(w: string, dead: number, launches: number) {
  list[w] = { dead, launches, seenAt: new Date().toISOString() };
  try { fs.writeFileSync(LIST_FILE, JSON.stringify({ note: "Deployer wallets seen behind high-risk patterns (>=3 launches that lost liquidity). Heuristic list, may be wrong.", wallets: list }, null, 1)); } catch {}
}

export type Facts = {
  mint: string; decimals: number | null; supply: number | null;
  mintAuthority: string | null; freezeAuthority: string | null; token2022: boolean;
  top1Pct: number | null; top10Pct: number | null;
  liquidityUsd: number | null; priceUsd: number | null; pairs: number; lpNote: string | null;
  ageHours: number | null; creator: string | null; funder: string | null;
  priorLaunches: number | null; priorDead: number | null;
  creatorFlagged: boolean; funderFlagged: boolean; unknown: string[];
};
export type Reason = { check: string; points: number; detail: string };

/** Pure scoring: points add up to a 0-100 risk score. */
export function scoreFacts(f: Facts): { score: number; level: "low" | "medium" | "high"; reasons: Reason[] } {
  const r: Reason[] = [];
  const add = (check: string, points: number, detail: string) => r.push({ check, points, detail });
  if (f.mintAuthority) add("mint_authority", 25, "Mint authority is still active: more tokens can be created at any time (high-risk pattern).");
  else add("mint_authority", 0, "Mint authority is revoked: supply is fixed.");
  if (f.freezeAuthority) add("freeze_authority", 20, "Freeze authority is still active: holders' tokens can be frozen, a common honeypot pattern.");
  else add("freeze_authority", 0, "Freeze authority is revoked.");
  if (f.top10Pct == null) add("holders", 5, "Top-holder concentration unavailable from public RPC.");
  else if (f.top1Pct! > 30 || f.top10Pct > 70) add("holders", 20, `Top holder owns ${f.top1Pct!.toFixed(1)}%, top 10 own ${f.top10Pct.toFixed(1)}% (may include pool/curve accounts): heavy concentration.`);
  else if (f.top10Pct > 40) add("holders", 10, `Top 10 holders own ${f.top10Pct.toFixed(1)}% (may include pool/curve accounts).`);
  else add("holders", 0, `Top 10 holders own ${f.top10Pct.toFixed(1)}%: spread out.`);
  if (f.liquidityUsd == null) add("liquidity", 15, "No DEX pool found: cannot sell easily (or not launched yet).");
  else if (f.liquidityUsd < 5000) add("liquidity", 15, `Very thin liquidity ($${Math.round(f.liquidityUsd)}).`);
  else if (f.liquidityUsd < 50000) add("liquidity", 7, `Modest liquidity ($${Math.round(f.liquidityUsd)}).`);
  else add("liquidity", 0, `Liquidity $${Math.round(f.liquidityUsd).toLocaleString("en-US")} across ${f.pairs} pool(s).`);
  if (f.ageHours == null) add("age", 3, "Token age unknown.");
  else if (f.ageHours < 24) add("age", 10, `Very new: ${f.ageHours.toFixed(1)} hours old.`);
  else if (f.ageHours < 24 * 7) add("age", 5, `New: ${(f.ageHours / 24).toFixed(1)} days old.`);
  else add("age", 0, `${Math.round(f.ageHours / 24)} days old.`);
  if (f.priorLaunches != null && f.priorLaunches > 0) {
    const share = (f.priorDead ?? 0) / f.priorLaunches;
    if ((f.priorDead ?? 0) >= 3 && share >= 0.5) add("deployer_history", 20, `Creator wallet launched ${f.priorLaunches} other token(s) recently; ${f.priorDead} have no liquidity left (serial-launch high-risk pattern).`);
    else if ((f.priorDead ?? 0) >= 1) add("deployer_history", 8, `Creator wallet launched ${f.priorLaunches} other token(s); ${f.priorDead} have no liquidity left.`);
    else add("deployer_history", 0, `Creator wallet launched ${f.priorLaunches} other token(s), all still with liquidity.`);
  } else if (f.creator) add("deployer_history", 0, "No other recent launches found from the creator wallet.");
  if (f.creatorFlagged) add("known_pattern", 25, "Creator wallet is on our list of deployers behind earlier high-risk patterns.");
  if (f.funderFlagged) add("shared_funder", 20, "Creator was funded by a wallet on our list of deployers behind earlier high-risk patterns.");
  const score = Math.min(100, r.reduce((a, x) => a + x.points, 0));
  return { score, level: score >= 50 ? "high" : score >= 25 ? "medium" : "low", reasons: r.sort((a, b) => b.points - a.points) };
}

async function ds(mints: string[]): Promise<any[]> {
  try { const r = await fetch(DS + mints.join(","), { signal: AbortSignal.timeout(6000) }); return r.ok ? ((await r.json()) as any[]) : []; } catch { return []; }
}
export async function marketOf(mint: string) {
  const pairs = (await ds([mint])).filter((p) => p.baseToken?.address === mint || p.quoteToken?.address === mint);
  const liq = pairs.reduce((a, p) => a + (p.liquidity?.usd ?? 0), 0);
  const best = pairs.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
  return { pairs, liquidityUsd: pairs.length ? liq : null, priceUsd: best?.priceUsd ? Number(best.priceUsd) : null, createdAt: pairs.length ? Math.min(...pairs.map((p) => p.pairCreatedAt ?? Infinity)) : null };
}

async function oldestTx(addr: string, pages = 6): Promise<{ sig: string; time: number | null; complete: boolean } | null> {
  let before: string | undefined; let last: any = null;
  for (let i = 0; i < pages; i++) {
    const s = await rpc<any[]>("getSignaturesForAddress", [addr, { limit: 1000, ...(before ? { before } : {}) }], { timeoutMs: 8000 });
    if (!s?.length) break;
    last = s[s.length - 1]; before = last.signature;
    if (s.length < 1000) return { sig: last.signature, time: last.blockTime ?? null, complete: true };
  }
  return last ? { sig: last.signature, time: last.blockTime ?? null, complete: false } : null;
}
const getTx = (sig: string) => rpc<any>("getTransaction", [sig, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }], { timeoutMs: 8000, nullIsMiss: true }).catch(() => null);
const feePayer = (tx: any): string | null => { const k = tx?.transaction?.message?.accountKeys?.[0]; return typeof k === "string" ? k : k?.pubkey ?? null; };
const mintsCreated = (tx: any): string[] => {
  const ins = [...(tx?.transaction?.message?.instructions ?? []), ...(tx?.meta?.innerInstructions ?? []).flatMap((x: any) => x.instructions)];
  return ins.filter((i: any) => /^initializeMint2?$/.test(i?.parsed?.type ?? "")).map((i: any) => i.parsed.info.mint);
};

export async function gatherFacts(mint: string): Promise<Facts> {
  const unknown: string[] = [];
  const acct = await rpc<any>("getAccountInfo", [mint, { encoding: "jsonParsed" }], { timeoutMs: 6000 });
  const info = acct?.value?.data?.parsed?.info;
  if (!acct?.value || acct.value.data?.parsed?.type !== "mint" || !KNOWN_PROGRAM_OWNERS.has(acct.value.owner)) throw new SolanaInputError("not an SPL token mint address");
  const decimals = info.decimals ?? null; const supply = Number(info.supply) / 10 ** (decimals ?? 0);
  const [largest, market, oldest] = await Promise.all([
    rpc<any>("getTokenLargestAccounts", [mint], { timeoutMs: 6000 }).catch(() => null),
    marketOf(mint),
    oldestTx(mint).catch(() => null),
  ]);
  let top1Pct: number | null = null, top10Pct: number | null = null;
  if (largest?.value?.length && supply > 0) {
    const amts = largest.value.map((a: any) => Number(a.uiAmount ?? 0));
    top1Pct = (amts[0] / supply) * 100; top10Pct = (amts.slice(0, 10).reduce((a: number, b: number) => a + b, 0) / supply) * 100;
  } else unknown.push("holders");
  let creator: string | null = null, funder: string | null = null, priorLaunches: number | null = null, priorDead: number | null = null;
  let ageHours = market.createdAt && isFinite(market.createdAt) ? (Date.now() - market.createdAt) / 3.6e6 : null;
  if (oldest?.complete) {
    if (oldest.time) ageHours = (Date.now() / 1000 - oldest.time) / 3600;
    creator = feePayer(await getTx(oldest.sig));
  } else unknown.push("creator (token has too much history for the free RPC lookup)");
  if (creator) {
    try {
      const sigs = await rpc<any[]>("getSignaturesForAddress", [creator, { limit: 100 }], { timeoutMs: 8000 });
      const txs: any[] = [];
      for (let i = 0; i < Math.min(sigs.length, 40); i += 8) txs.push(...(await Promise.all(sigs.slice(i, i + 8).map((s) => getTx(s.signature)))));
      const others = [...new Set(txs.filter((t) => feePayer(t) === creator).flatMap(mintsCreated))].filter((m) => m !== mint).slice(0, 29);
      priorLaunches = others.length; priorDead = 0;
      if (others.length) { const live = new Set((await ds(others)).filter((p) => (p.liquidity?.usd ?? 0) >= 1000).map((p) => p.baseToken?.address)); priorDead = others.filter((m) => !live.has(m)).length; }
      if (priorDead >= 3 && priorDead / Math.max(1, priorLaunches) >= 0.5) flagDeployer(creator, priorDead, priorLaunches);
      const first = await oldestTx(creator, 1).catch(() => null);
      if (first?.complete) {
        const t = await getTx(first.sig);
        const ix = (t?.transaction?.message?.instructions ?? []).find((i: any) => i?.parsed?.type === "transfer" && i.parsed.info?.destination === creator);
        funder = ix?.parsed?.info?.source ?? null;
      }
    } catch { unknown.push("deployer history"); }
  }
  return { mint, decimals, supply, mintAuthority: info.mintAuthority ?? null, freezeAuthority: info.freezeAuthority ?? null, token2022: acct.value.owner !== "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    top1Pct, top10Pct, liquidityUsd: market.liquidityUsd, priceUsd: market.priceUsd, pairs: market.pairs.length,
    lpNote: market.pairs.length ? `${market.pairs.length} pool(s) on ${[...new Set(market.pairs.map((p: any) => p.dexId))].join(", ")}; LP lock/burn status not verified` : null,
    ageHours, creator, funder, priorLaunches, priorDead, creatorFlagged: !!(creator && list[creator] && !(priorDead! >= 3)), funderFlagged: !!(funder && list[funder]), unknown };
}

// ---------- silent validation log for "low risk" results ----------
const VAL_FILE = process.env.RUG_VALIDATION_FILE ?? path.join(process.cwd(), "data", "rug-validation.jsonl");
export function logValidation(mint: string, score: number, priceUsd: number | null, liquidityUsd: number | null, delayMs = 10 * 60_000, chain = "solana") {
  const at = new Date().toISOString();
  const t = setTimeout(async () => {
    const m = EVM[chain] ? await fetch(`https://api.dexscreener.com/tokens/v1/${EVM[chain]!.ds}/${mint.split(":")[1]}`).then((r) => r.json()).then((p: any[]) => ({ priceUsd: p[0]?.priceUsd ? Number(p[0].priceUsd) : null, liquidityUsd: p.length ? p.reduce((a, x) => a + (x.liquidity?.usd ?? 0), 0) : null })).catch(() => null) : await marketOf(mint).catch(() => null);
    const row = { chain, mint, score, checkedAt: at, priceAtCheck: priceUsd, liquidityAtCheck: liquidityUsd, laterAt: new Date().toISOString(), priceLater: m?.priceUsd ?? null, liquidityLater: m?.liquidityUsd ?? null,
      liquidityDropPct: liquidityUsd && m?.liquidityUsd != null ? Math.round((1 - m.liquidityUsd / liquidityUsd) * 1000) / 10 : null };
    try { fs.mkdirSync(path.dirname(VAL_FILE), { recursive: true }); fs.appendFileSync(VAL_FILE, JSON.stringify(row) + "\n"); } catch {}
  }, delayMs);
  t.unref();
}
export function validationSummary() {
  try {
    const rows = fs.readFileSync(VAL_FILE, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const bad = rows.filter((r) => (r.liquidityDropPct ?? 0) >= 80).length;
    return { lowRiskChecked: rows.length, liquidityCollapsedWithin10m: bad };
  } catch { return { lowRiskChecked: 0, liquidityCollapsedWithin10m: 0 }; }
}

// ---------- Base (EVM) via keyless GoPlus token security + DexScreener ----------
export function scoreEvm(g: any, liquidityUsd: number | null, ageHours: number | null): { score: number; level: "low" | "medium" | "high"; reasons: Reason[] } {
  const r: Reason[] = []; const on = (k: string) => g?.[k] === "1";
  const add = (check: string, points: number, detail: string) => r.push({ check, points, detail });
  if (on("is_honeypot") || on("cannot_sell_all")) add("honeypot", 40, "Simulation says holders cannot sell (honeypot high-risk pattern).");
  const tax = Math.max(Number(g?.buy_tax || 0), Number(g?.sell_tax || 0));
  if (tax >= 0.1) add("tax", 15, `Buy/sell tax up to ${(tax * 100).toFixed(0)}%.`);
  if (on("is_mintable")) add("mint_function", 20, "Owner can mint more tokens.");
  if (on("hidden_owner") || on("can_take_back_ownership")) add("owner_control", 15, "Hidden owner or ownership can be taken back.");
  if (on("transfer_pausable") || on("is_blacklisted") || on("slippage_modifiable")) add("owner_control", 15, "Owner can pause transfers, blacklist wallets or change tax.");
  if (g?.is_open_source === "0") add("unverified", 10, "Contract source is not verified.");
  if (on("is_proxy")) add("proxy", 5, "Upgradeable proxy: code can change.");
  if (Number(g?.honeypot_with_same_creator || 0) > 0) add("deployer_history", 25, `Creator deployed ${g.honeypot_with_same_creator} earlier honeypot token(s).`);
  const top10 = (g?.holders ?? []).filter((h: any) => h.is_contract !== 1 && h.is_locked !== 1).slice(0, 10).reduce((a: number, h: any) => a + Number(h.percent || 0), 0) * 100;
  if (top10 > 50) add("holders", 15, `Top non-contract holders own ${top10.toFixed(1)}%.`);
  const lpLocked = (g?.lp_holders ?? []).reduce((a: number, h: any) => a + (h.is_locked === 1 || /^0x0+(dead)?$/i.test(h.address ?? "") ? Number(h.percent || 0) : 0), 0) * 100;
  if ((g?.lp_holders ?? []).length && lpLocked < 50) add("lp_unlocked", 10, `Only ${lpLocked.toFixed(0)}% of LP tokens are locked or burned.`);
  if (liquidityUsd == null || liquidityUsd < 5000) add("liquidity", 15, liquidityUsd == null ? "No DEX pool found." : `Very thin liquidity ($${Math.round(liquidityUsd)}).`);
  if (ageHours != null && ageHours < 24) add("age", 10, `Very new: ${ageHours.toFixed(1)} hours old.`);
  const score = Math.min(100, r.reduce((a, x) => a + x.points, 0));
  return { score, level: score >= 50 ? "high" : score >= 25 ? "medium" : "low", reasons: r.sort((a, b) => b.points - a.points) };
}
const EVM: Record<string, { id: number; ds: string }> = { base: { id: 8453, ds: "base" }, bnb: { id: 56, ds: "bsc" }, ethereum: { id: 1, ds: "ethereum" }, arbitrum: { id: 42161, ds: "arbitrum" } };
const ALIAS: Record<string, string> = { bsc: "bnb", eth: "ethereum", arb: "arbitrum" };
async function evmCheck(addr: string, chain: string) {
  const c = EVM[chain]!;
  const [gj, dsr] = await Promise.all([
    fetch(`https://api.gopluslabs.io/api/v1/token_security/${c.id}?contract_addresses=${addr}`, { signal: AbortSignal.timeout(8000) }).then((r) => r.json()).catch(() => null) as Promise<any>,
    fetch(`https://api.dexscreener.com/tokens/v1/${c.ds}/${addr}`, { signal: AbortSignal.timeout(6000) }).then((r) => (r.ok ? r.json() : [])).catch(() => []) as Promise<any[]>,
  ]);
  const g = gj?.result?.[addr.toLowerCase()];
  if (!g) throw new SolanaInputError(`token security data unavailable for this address on ${chain} (not a token, or the free GoPlus API is busy); you were not charged`);
  const liq = dsr.length ? dsr.reduce((a, p) => a + (p.liquidity?.usd ?? 0), 0) : null;
  const created = dsr.length ? Math.min(...dsr.map((p) => p.pairCreatedAt ?? Infinity)) : null;
  const age = created && isFinite(created) ? (Date.now() - created) / 3.6e6 : null;
  const price = dsr[0]?.priceUsd ? Number(dsr[0].priceUsd) : null;
  return { ...scoreEvm(g, liq, age), facts: { token: g.token_symbol, creator: g.creator_address || null, owner: g.owner_address || null, holderCount: Number(g.holder_count || 0), liquidityUsd: liq, priceUsd: price, ageHours: age && +age.toFixed(1), buyTax: g.buy_tax, sellTax: g.sell_tax }, price, liq };
}
export const CHAINS = ["solana", "base", "bnb", "ethereum", "arbitrum"] as const; // EVM chains: add to EVM map (GoPlus chain id + DexScreener slug)

const verdictOf = (l: string) => (l === "high" ? "Multiple high-risk patterns found." : l === "medium" ? "Some high-risk patterns found." : "No major high-risk patterns found.");
export async function rugCheck(mintRaw: string, chainRaw = "solana") {
  const c0 = (chainRaw || "solana").toLowerCase(); const chain = ALIAS[c0] ?? c0;
  if (!(CHAINS as readonly string[]).includes(chain)) throw new SolanaInputError(`chain must be one of: ${CHAINS.join(", ")}`);
  if (EVM[chain]) {
    const a = mintRaw.trim();
    if (!/^0x[0-9a-fA-F]{40}$/.test(a)) throw new SolanaInputError(`token must be a ${chain} token contract address (0x...)`);
    const b = await evmCheck(a, chain);
    if (b.level === "low") logValidation(`${chain}:${a}`, b.score, b.price, b.liq, 10 * 60_000, chain);
    return { product: "RugRadar", chain, token: a, riskScore: b.score, riskLevel: b.level, verdict: verdictOf(b.level), reasons: b.reasons.map((x) => x.detail), checks: b.reasons, facts: b.facts,
      disclaimer: DISCLAIMER, method: "keyless GoPlus token security (honeypot simulation, owner functions, holders, LP lock, creator's earlier honeypots) + keyless DexScreener (liquidity, age)", generatedAt: new Date().toISOString() };
  }
  const mint = mintRaw.trim();
  if (!B58.test(mint)) throw new SolanaInputError("mint is required (a Solana SPL token mint address)");
  const f = await gatherFacts(mint);
  const { score, level, reasons } = scoreFacts(f);
  if (level === "low") logValidation(mint, score, f.priceUsd, f.liquidityUsd);
  return {
    product: "RugRadar", chain, token: mint, riskScore: score, riskLevel: level, verdict: verdictOf(level),
    reasons: reasons.filter((x) => x.points > 0).map((x) => x.detail), checks: reasons,
    facts: { ...f, top1Pct: f.top1Pct && +f.top1Pct.toFixed(2), top10Pct: f.top10Pct && +f.top10Pct.toFixed(2), ageHours: f.ageHours && +f.ageHours.toFixed(1) },
    disclaimer: DISCLAIMER, method: "public Solana RPC (mint account, largest holders, creator transactions) + keyless DexScreener (pools, liquidity, prior launches)", generatedAt: new Date().toISOString(),
  };
}
