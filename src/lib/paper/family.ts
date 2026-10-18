/**
 * PRIVATE "creator family" signal (paper trader + scorecard only; never used in RugRadar's paid checks or public API).
 * Creator wallet -> who first funded it (first incoming SOL transfer) -> up to 3 hops, stopping at exchanges / very busy wallets.
 * Siblings: other wallets the first funder sent SOL to (a few recent transfers only, to stay cheap). Free public RPC only; cached per wallet.
 */
const RPC = process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";
// Best-effort labels for well-known exchange hot wallets (public explorer labels). Unknown busy wallets are caught by the activity test below.
export const KNOWN: Record<string, string> = {
  H8sMJSCQxfKiFTCfDR3DUMLPwcRbM61LGFJ8N4dK3WjS: "Coinbase", "2AQdpHJ2JpcEgPiATUXjQxA8QmafFegfQwSLWSprPicm": "Coinbase", GJRs4FwHtemZ5ZE9x3FNvJ8TMwitKTh21yxdRPqn7npE: "Coinbase",
  "5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhJ5n7Jr": "Binance", "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM": "Binance", "2ojv9BAiHUrvsm9gxDe7fJSzbNZSJcxZvf8dqmWGHG8S": "Binance",
  "5VCwKtCXgCJ6kit5FybXjvriW3xELsFDhYrPSqtJNmcD": "OKX", AC5RDfQFmDS1deWZos921JfqscXdByf8BKHs5ACWjtW2: "Bybit", FWznbcNXWQuHTawe9RxvQ2LdCENssh12dsznf4RiouN5: "Kraken",
  ASTyfSima4LLAdDgoFGkgqoKowG1LZFDr9fAQrg7iaJZ: "MEXC", BmFdpraQhkiDQE6SnfG5omcA1VwzqfXrwtNYBwWTymy6: "KuCoin", u6PJ8DtQuPFnfmwHbGFULQ4u4EgjDiyYKjVEsynXq2w: "Gate.io",
};
let reqs = 0;
async function rpc(method: string, params: unknown[]): Promise<any> {
  reqs++;
  const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(6000) });
  return (await r.json() as any)?.result ?? null;
}
type Fund = { funder: string | null; sol: number | null; at: number | null; busy: boolean; txCount: number };
const fundCache = new Map<string, Promise<Fund>>();
/** First incoming SOL transfer to a wallet. "busy" = 1,000+ transactions seen (exchange, bot or service): we stop tracing there. */
function funding(w: string): Promise<Fund> {
  const hit = fundCache.get(w); if (hit) return hit;
  const p = (async (): Promise<Fund> => {
    let before: string | undefined; let last: any = null; let n = 0;
    for (let i = 0; i < 2; i++) {
      const s = await rpc("getSignaturesForAddress", [w, { limit: 1000, ...(before ? { before } : {}) }]);
      if (!s?.length) break; n += s.length; last = s[s.length - 1]; before = last.signature;
      if (s.length < 1000) break;
    }
    if (n >= 1000) return { funder: null, sol: null, at: null, busy: true, txCount: n };
    if (!last) return { funder: null, sol: null, at: null, busy: false, txCount: 0 };
    const tx = await rpc("getTransaction", [last.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }]);
    const ins = [...(tx?.transaction?.message?.instructions ?? []), ...(tx?.meta?.innerInstructions ?? []).flatMap((x: any) => x.instructions)];
    const t = ins.find((i: any) => i?.program === "system" && /transfer|createAccount/.test(i?.parsed?.type ?? "") && (i.parsed.info.destination ?? i.parsed.info.newAccount) === w);
    return { funder: t?.parsed?.info?.source ?? null, sol: t ? Number(t.parsed.info.lamports) / 1e9 : null, at: last.blockTime ? last.blockTime * 1000 : null, busy: false, txCount: n };
  })().catch(() => ({ funder: null, sol: null, at: null, busy: false, txCount: -1 }));
  fundCache.set(w, p); if (fundCache.size > 20000) fundCache.delete(fundCache.keys().next().value!);
  return p;
}
const sibCache = new Map<string, Promise<string[]>>();
/** Up to 8 other wallets the parent recently sent SOL to (cheap sample, not a full list). */
function siblings(parent: string): Promise<string[]> {
  const hit = sibCache.get(parent); if (hit) return hit;
  const p = (async () => {
    const s = (await rpc("getSignaturesForAddress", [parent, { limit: 25 }])) ?? [];
    const out = new Set<string>();
    for (const x of s.slice(0, 8)) {
      const tx = await rpc("getTransaction", [x.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }]);
      for (const i of tx?.transaction?.message?.instructions ?? []) if (i?.program === "system" && i?.parsed?.type === "transfer" && i.parsed.info.source === parent) out.add(i.parsed.info.destination);
    }
    return [...out];
  })().catch(() => []);
  sibCache.set(parent, p); if (sibCache.size > 5000) sibCache.delete(sibCache.keys().next().value!);
  return p;
}
export const MAX_HOPS = 5, FANOUT_TX = 200; // keep tracing while the trail is clean; stop at exchanges, busy or fan-out wallets
export type Family = { hopsReached: number; stopReason: string; ruggerHop: number | null; creator: string; hops: { wallet: string; label: string | null; sol: number | null }[]; origin: string; familyWallets: number; familyCoinsBefore: number; familyRugs: number; familyTracked: number; knownRugger: boolean; serialRugger: boolean; siblings?: string[]; ms: number; rpcCalls: number };
export type FamilyCtx = { coinsBy: (wallet: string) => { mint: string; t: number }[]; rugged: (mint: string) => boolean | null; flagged: (wallet: string) => boolean };
// Load control (Oct 15): at most 2 creator-family traces run at once; the rest queue.
let slots = 2; const waiters: (() => void)[] = [];
async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (slots > 0) slots--; else await new Promise<void>((r) => waiters.push(r));
  try { return await fn(); } finally { const w = waiters.shift(); if (w) w(); else slots++; }
}
const famCache = new Map<string, { at: number; p: Promise<Family> }>();
export function familyOf(creator: string, beforeMs: number, ctx: FamilyCtx): Promise<Family> {
  const hit = famCache.get(creator); if (hit && Date.now() - hit.at < 30 * 60_000) return hit.p;
  const p = withSlot(async (): Promise<Family> => {
    const t0 = Date.now(), r0 = reqs;
    const hops: Family["hops"] = []; let cur = creator; let origin = "untraced"; let stopReason = "max hops (5) reached"; let ruggerHop: number | null = null;
    for (let h = 0; h < MAX_HOPS; h++) {
      const f = await funding(cur);
      if (f.busy) { origin = h === 0 ? "creator is a very busy wallet" : "funded from a very busy wallet (likely an exchange or bot)"; stopReason = "very busy wallet (1,000+ transactions)"; break; }
      if (h > 0 && f.txCount >= FANOUT_TX) { stopReason = `wallet fans out (${f.txCount} transactions)`; break; }
      if (!f.funder) { origin = h === 0 ? "no funding found" : "fresh wallet chain"; stopReason = f.txCount < 0 ? "lookup failed" : "no earlier funder found"; break; }
      const label = KNOWN[f.funder] ?? null;
      hops.push({ wallet: f.funder, label, sol: f.sol });
      if (label) { origin = `funded from ${label}`; stopReason = `reached exchange (${label})`; break; }
      if (ctx.flagged(f.funder) || ctx.coinsBy(f.funder).some((c) => ctx.rugged(c.mint))) { ruggerHop ??= h + 1; }
      if (ctx.flagged(f.funder)) { origin = `funded by a known rugger (${h + 1} hop${h ? "s" : ""} back)`; stopReason = "reached known rugger"; break; }
      cur = f.funder; origin = "fresh wallet chain";
    }
    const parent = hops[0] && !hops[0].label ? hops[0].wallet : null;
    const sibs = parent ? (await siblings(parent)).filter((w) => w !== creator) : [];
    const fam = [...new Set([creator, ...hops.filter((x) => !x.label).map((x) => x.wallet), ...sibs])];
    const coins = fam.flatMap((w) => ctx.coinsBy(w)).filter((c) => c.t < beforeMs);
    const verdicts = coins.map((c) => ctx.rugged(c.mint)).filter((v) => v != null);
    const knownRugger = fam.some((w) => ctx.flagged(w));
    if (knownRugger && origin === "fresh wallet chain") origin = "known rugger in family";
    const familyRugs = verdicts.filter(Boolean).length;
    return { hopsReached: hops.length, stopReason, ruggerHop, creator, hops, origin, familyWallets: fam.length, familyCoinsBefore: coins.length, familyRugs, familyTracked: verdicts.length, knownRugger, serialRugger: knownRugger || familyRugs >= 2, siblings: sibs.slice(0, 8), ms: Date.now() - t0, rpcCalls: reqs - r0 };
  });
  famCache.set(creator, { at: Date.now(), p }); if (famCache.size > 5000) famCache.delete(famCache.keys().next().value!);
  return p;
}
