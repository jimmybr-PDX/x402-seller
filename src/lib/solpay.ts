/**
 * RugRadar wallet checkout for humans (Phantom / Solflare): credit packs paid in USDC or SOL on Solana.
 * Standard Solana Pay pattern: every order gets a unique reference public key that the payment transaction
 * carries as a read-only account. The server finds the transaction by reference on free public RPC, checks
 * success, recipient, amount and timing, and issues a credit key exactly once (references and signatures are
 * recorded in the durable credit store). Orders are HMAC-signed tokens, so a restart never loses a paid order.
 * x402 (/credits/buy, /rug-check) is unchanged for agents. On unless RUGRADAR_WALLET_PAY=0 (kill switch); pays RugRadar's existing Solana payTo.
 */
import { createHmac, randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { address, getAddressDecoder, pipe, createTransactionMessage, setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash, appendTransactionMessageInstruction, compileTransaction, getBase64EncodedWireTransaction, createNoopSigner, AccountRole, type Address, type Instruction } from "@solana/kit";
import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS, getTransferCheckedInstruction } from "@solana-program/token";
import { getTransferSolInstruction } from "@solana-program/system";
import type { Express, Request, Response } from "express";
import { qrSvg } from "./qr.js";

export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const PACKS: Record<string, { credits: number; usd: number }> = { "10": { credits: 10, usd: 0.1 }, "50": { credits: 50, usd: 0.4 }, "200": { credits: 200, usd: 1.5 } };
export const SOL_TOLERANCE = 0.005; // accept up to 0.5% below the quoted lamports (rounding in wallets)
export const ORDER_TTL_S = 20 * 60; // quote valid 20 min; a payment landing inside the window is honored at claim time later
export type Currency = "usdc" | "sol";
export type Order = { v: 1; ref: string; pack: string; credits: number; usd: number; cur: Currency; atomic: string; to: string; iat: number; exp: number; solUsd?: number };
export type PayDeps = {
  enabled: boolean; recipient: string; secret: Buffer;
  rpc: <T>(method: string, params: unknown[]) => Promise<T>;
  solUsd: () => Promise<number | null>;
  issue: (credits: number, refs: string[]) => Promise<{ key: string; credits: number }>;
  isRedeemed: (ref: string) => Promise<boolean>;
  now?: () => number;
};
const nowS = (d: PayDeps) => Math.floor((d.now?.() ?? Date.now()) / 1000);
const b64u = (b: Buffer | string) => Buffer.from(b).toString("base64url");
const sign = (secret: Buffer, body: string) => createHmac("sha256", secret).update("rugradar-order:" + body).digest("base64url");

/** Stable secret: RUGRADAR_ORDER_SECRET, else derived from the credit-store deploy key (already secret); else per-process random. */
export function orderSecret(env = process.env): { secret: Buffer; durable: boolean } {
  const s = env.RUGRADAR_ORDER_SECRET || (env.RUGRADAR_STORE_SSH_KEY_B64 ? "derived:" + createHash("sha256").update("rugradar-order-secret:" + env.RUGRADAR_STORE_SSH_KEY_B64).digest("hex") : "");
  return s ? { secret: createHash("sha256").update(s).digest(), durable: true } : { secret: randomBytes(32), durable: false };
}
export function encodeOrder(o: Order, secret: Buffer) { const body = b64u(JSON.stringify(o)); return `${body}.${sign(secret, body)}`; }
export function decodeOrder(tok: string, secret: Buffer): Order | null {
  const [body, mac] = String(tok ?? "").split(".");
  if (!body || !mac) return null;
  const want = Buffer.from(sign(secret, body)), got = Buffer.from(mac);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  try { const o = JSON.parse(Buffer.from(body, "base64url").toString()); return o?.v === 1 && PACKS[o.pack] ? o : null; } catch { return null; }
}
const fmt = (atomic: bigint, dec: number) => { const s = atomic.toString().padStart(dec + 1, "0"); return (s.slice(0, -dec) + "." + s.slice(-dec)).replace(/\.?0+$/, ""); };

export async function createOrder(d: PayDeps, pack: string, cur: Currency) {
  if (!d.enabled) throw new PayError(503, "wallet_pay_disabled", "Wallet checkout is not enabled yet. Use a credit key or x402 (/credits/buy).");
  const p = PACKS[pack]; if (!p) throw new PayError(400, "invalid_pack", `pack must be one of ${Object.keys(PACKS).join(", ")}`);
  if (cur !== "usdc" && cur !== "sol") throw new PayError(400, "invalid_currency", "currency must be usdc or sol");
  const ref = getAddressDecoder().decode(randomBytes(32)) as string, iat = nowS(d);
  let atomic: bigint, solUsd: number | undefined;
  if (cur === "usdc") atomic = BigInt(Math.round(p.usd * 1e6));
  else { const px = await d.solUsd(); if (!px || !(px > 1)) throw new PayError(503, "sol_price_unavailable", "SOL price unavailable right now; pay in USDC or try again."); solUsd = px; atomic = BigInt(Math.ceil((p.usd / px) * 1e9)); }
  const o: Order = { v: 1, ref, pack, credits: p.credits, usd: p.usd, cur, atomic: atomic.toString(), to: d.recipient, iat, exp: iat + ORDER_TTL_S, ...(solUsd ? { solUsd } : {}) };
  const amount = fmt(atomic, cur === "usdc" ? 6 : 9);
  return { order: encodeOrder(o, d.secret), reference: ref, pack, credits: p.credits, priceUsd: p.usd.toFixed(2), currency: cur, amount, recipient: d.recipient, expiresAt: new Date(o.exp * 1000).toISOString(), solanaPayUrl: solanaPayUrl(o), ...(solUsd ? { solUsd } : {}) };
}
/** Solana Pay transfer-request URL for an order (same string the order response carries; rebuilt from the signed order for the QR). */
export function solanaPayUrl(o: Order) {
  const amount = fmt(BigInt(o.atomic), o.cur === "usdc" ? 6 : 9);
  const q = new URLSearchParams({ amount, ...(o.cur === "usdc" ? { "spl-token": USDC_MINT } : {}), reference: o.ref, label: "RugRadar", message: `${o.credits} RugRadar credits` });
  return `solana:${o.to}?${q.toString().replace(/\+/g, "%20")}`;
}
/** QR (SVG) of a signed order's Solana Pay URL. Only signed, unexpired orders: the endpoint can't be used to make arbitrary QR codes. */
export function orderQrSvg(d: PayDeps, tok: string) {
  if (!d.enabled) throw new PayError(503, "wallet_pay_disabled", "Wallet checkout is not enabled yet.");
  const o = decodeOrder(tok, d.secret); if (!o) throw new PayError(400, "invalid_order", "Unknown or tampered order.");
  if (nowS(d) > o.exp) throw new PayError(410, "order_expired", "This quote expired; start a new one.");
  return qrSvg(solanaPayUrl(o), { ecl: "M", px: 240 });
}

/** Unsigned transfer transaction (payer = fee payer) for wallet-standard signAndSendTransaction. Reference rides as a read-only account. */
export async function buildTx(d: PayDeps, tok: string, payer: string) {
  if (!d.enabled) throw new PayError(503, "wallet_pay_disabled", "Wallet checkout is not enabled yet.");
  const o = decodeOrder(tok, d.secret); if (!o) throw new PayError(400, "invalid_order", "Unknown or tampered order.");
  if (nowS(d) > o.exp) throw new PayError(410, "order_expired", "This quote expired; start a new one.");
  let from: Address; try { from = address(payer); } catch { throw new PayError(400, "invalid_account", "account must be a Solana address"); }
  const signer = createNoopSigner(from), ref = { address: address(o.ref), role: AccountRole.READONLY };
  let ix: Instruction;
  if (o.cur === "sol") ix = getTransferSolInstruction({ source: signer, destination: address(o.to), amount: BigInt(o.atomic) });
  else {
    const mint = address(USDC_MINT);
    const [src] = await findAssociatedTokenPda({ owner: from, mint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    const [dst] = await findAssociatedTokenPda({ owner: address(o.to), mint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    ix = getTransferCheckedInstruction({ source: src, mint, destination: dst, authority: signer, amount: BigInt(o.atomic), decimals: 6 });
  }
  ix = { ...ix, accounts: [...(ix.accounts ?? []), ref] } as Instruction;
  const bh: any = await d.rpc("getLatestBlockhash", [{ commitment: "confirmed" }]);
  const msg = pipe(createTransactionMessage({ version: 0 }), (m) => setTransactionMessageFeePayer(from, m), (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: bh.value.blockhash, lastValidBlockHeight: BigInt(bh.value.lastValidBlockHeight) }, m), (m) => appendTransactionMessageInstruction(ix, m));
  return { transaction: getBase64EncodedWireTransaction(compileTransaction(msg)), encoding: "base64", reference: o.ref };
}

export class PayError extends Error { constructor(public status: number, public code: string, msg: string) { super(msg); } }
const keysOf = (tx: any): string[] => (tx?.transaction?.message?.accountKeys ?? []).map((k: any) => (typeof k === "string" ? k : k.pubkey));

/** Check one parsed transaction against the order. Returns null when it pays the order, else the reason. */
export function checkTx(o: Order, tx: any): string | null {
  if (!tx || !tx.meta) return "transaction_not_found";
  if (tx.meta.err) return "transaction_failed";
  const keys = keysOf(tx);
  if (!keys.includes(o.ref)) return "reference_missing";
  const bt = Number(tx.blockTime ?? 0);
  if (bt && (bt < o.iat - 120 || bt > o.exp + 120)) return "outside_order_window";
  const want = BigInt(o.atomic);
  if (o.cur === "sol") {
    const i = keys.indexOf(o.to); if (i < 0) return "wrong_recipient";
    const got = BigInt(tx.meta.postBalances[i]) - BigInt(tx.meta.preBalances[i]);
    const min = want - (want * BigInt(Math.round(SOL_TOLERANCE * 1e6))) / 1_000_000n;
    return got >= min ? null : got > 0n ? "wrong_amount" : "wrong_recipient";
  }
  const bal = (arr: any[]) => (arr ?? []).filter((b) => b.mint === USDC_MINT && b.owner === o.to).reduce((a, b) => a + BigInt(b.uiTokenAmount?.amount ?? "0"), 0n);
  const pre = tx.meta.preTokenBalances ?? [], post = tx.meta.postTokenBalances ?? [];
  if (!post.some((b: any) => b.mint === USDC_MINT && b.owner === o.to)) return "wrong_recipient";
  const got = bal(post) - bal(pre);
  return got >= want ? null : "wrong_amount";
}

const claiming = new Set<string>();
/** Find the payment by reference (or a given signature), verify it, and issue the credit key exactly once. */
export async function claim(d: PayDeps, tok: string, signature?: string) {
  const o = decodeOrder(tok, d.secret); if (!o) throw new PayError(400, "invalid_order", "Unknown or tampered order. Nothing was charged by this check.");
  if (await d.isRedeemed(`wallet:ref:${o.ref}`)) throw new PayError(409, "already_redeemed", "This order was already redeemed for a credit key.");
  if (claiming.has(o.ref)) throw new PayError(429, "claim_in_progress", "Already checking this order; try again in a few seconds.");
  claiming.add(o.ref);
  try {
    let sigs: string[] = [];
    if (signature) { if (!/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(signature)) throw new PayError(400, "invalid_signature", "signature must be a base58 transaction signature"); sigs = [signature]; }
    else { const r: any[] = (await d.rpc<any[]>("getSignaturesForAddress", [o.ref, { limit: 10, commitment: "confirmed" }])) ?? []; sigs = r.filter((x) => !x.err).map((x) => x.signature); }
    if (!sigs.length) throw new PayError(402, "payment_not_found", "No payment found for this order yet. If you just paid, wait a few seconds and check again.");
    let last = "payment_not_found";
    for (const sig of sigs.slice(0, 5)) {
      if (await d.isRedeemed(`wallet:sig:${sig}`)) { last = "already_redeemed"; continue; }
      const tx = await d.rpc<any>("getTransaction", [sig, { encoding: "jsonParsed", commitment: "confirmed", maxSupportedTransactionVersion: 0 }]);
      const why = checkTx(o, tx);
      if (why) { last = why; continue; }
      try { const k = await d.issue(o.credits, [`wallet:ref:${o.ref}`, `wallet:sig:${sig}`]); return { ...k, signature: sig, reference: o.ref, pack: o.pack, currency: o.cur }; }
      catch (e) { if ((e as Error).message === "already_redeemed") throw new PayError(409, "already_redeemed", "This payment was already redeemed for a credit key."); throw new PayError(503, "credits_unavailable", "Payment verified, but the credit store is busy. Check again in a minute; your payment is safe."); }
    }
    const msg: Record<string, string> = { already_redeemed: "This payment was already redeemed for a credit key.", wrong_amount: "A payment was found but the amount is too small for this pack.", wrong_recipient: "A transaction with this reference did not pay the RugRadar wallet.", transaction_failed: "The payment transaction failed on-chain.", outside_order_window: "The payment is outside this order's time window.", reference_missing: "The transaction does not carry this order's reference.", transaction_not_found: "Transaction not confirmed yet; check again in a few seconds." };
    throw new PayError(last === "already_redeemed" ? 409 : 402, last, msg[last] ?? "No valid payment found for this order yet.");
  } finally { claiming.delete(o.ref); }
}

/** SOL/USD from two independent public sources; refuses when they disagree by more than 2%. */
export async function solUsdPublic(): Promise<number | null> {
  const j = (u: string) => fetch(u, { signal: AbortSignal.timeout(3000), headers: { accept: "application/json" } }).then((r) => (r.ok ? r.json() : null)).catch(() => null) as Promise<any>;
  const [cb, kr] = await Promise.all([j("https://api.coinbase.com/v2/prices/SOL-USD/spot"), j("https://api.kraken.com/0/public/Ticker?pair=SOLUSD")]);
  const a = Number(cb?.data?.amount), b = Number(Object.values<any>(kr?.result ?? {})[0]?.c?.[0]);
  const ok = (x: number) => isFinite(x) && x > 1;
  if (ok(a) && ok(b)) return Math.abs(a - b) / Math.min(a, b) <= 0.02 ? (a + b) / 2 : null;
  return ok(a) ? a : ok(b) ? b : null;
}

const lastHit = new Map<string, number>();
function tooFast(req: Request, key: string, ms = 1500) {
  const ip = String(req.headers["x-forwarded-for"] ?? req.socket.remoteAddress ?? "").split(",")[0]!.trim(), k = key + ":" + ip, t = Date.now();
  if ((lastHit.get(k) ?? 0) > t - ms) return true; lastHit.set(k, t); if (lastHit.size > 20000) lastHit.clear(); return false;
}
export function walletPayConfig(d: PayDeps) {
  return { enabled: d.enabled, wallets: ["Phantom", "Solflare"], currencies: ["usdc", "sol"], recipient: d.recipient, packs: Object.values(PACKS).map((p) => ({ credits: p.credits, priceUsd: p.usd.toFixed(2) })), agents: "Agents keep using x402 (/rug-check, /credits/buy) or X-RugRadar-Key." };
}
export function registerWalletPay(app: Express, d: PayDeps) {
  const send = (res: Response, f: () => Promise<unknown>) => f().then((j) => res.set("Cache-Control", "no-store").json(j)).catch((e) => {
    if (e instanceof PayError) res.status(e.status).set("Cache-Control", "no-store").json({ error: e.code, message: e.message });
    else res.status(503).set("Cache-Control", "no-store").json({ error: "rpc_unavailable", message: "Solana RPC is busy; try again shortly." });
  });
  const q = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  app.get("/rugradar/pay/config", (_req, res) => { res.set("Cache-Control", "no-store").json(walletPayConfig(d)); });
  app.post("/rugradar/pay/order", (req, res) => { if (tooFast(req, "o", 1000)) { res.status(429).json({ error: "slow_down" }); return; } send(res, () => createOrder(d, q(req.query.pack), q(req.query.currency).toLowerCase() as Currency)); });
  app.post("/rugradar/pay/tx", (req, res) => { if (tooFast(req, "t", 1000)) { res.status(429).json({ error: "slow_down" }); return; } send(res, () => buildTx(d, q(req.query.order) || q((req.body as any)?.order), q(req.query.account) || q((req.body as any)?.account))); });
  app.get("/rugradar/pay/qr.svg", (req, res) => {
    try { res.set("Cache-Control", "private, max-age=1200").type("image/svg+xml").send(orderQrSvg(d, q(req.query.order))); }
    catch (e) { const pe = e instanceof PayError ? e : new PayError(500, "qr_failed", "Could not make the QR code."); res.status(pe.status).set("Cache-Control", "no-store").json({ error: pe.code, message: pe.message }); }
  });
  app.post("/rugradar/pay/claim", (req, res) => { if (tooFast(req, "c", 2000)) { res.status(429).json({ error: "slow_down", message: "One check every 2 seconds, please." }); return; } send(res, () => claim(d, q(req.query.order) || q((req.body as any)?.order), q(req.query.signature) || q((req.body as any)?.signature) || undefined)); });
}
