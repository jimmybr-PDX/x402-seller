import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import bs58 from "bs58";
import { createOrder, claim, buildTx, decodeOrder, encodeOrder, checkTx, PayError, USDC_MINT, solanaPayUrl, orderQrSvg, registerWalletPay, type PayDeps } from "../src/lib/solpay.js";
import { qrMatrix } from "../src/lib/qr.js";
import express from "express";
import type { AddressInfo } from "node:net";

const TO = "3a9DUWEA34ejDaMbWo96gFfuqN2TvojJewUBCA14Dg75", OTHER = "787RZwDGpjmRsG5wgnyBeWQHBuARax8Qo6P7dmDuqKeW", PAYER = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const sig = () => bs58.encode(randomBytes(64));
function deps(txs: Record<string, any>, byRef: Record<string, string[]>, enabled = true) {
  const redeemed = new Set<string>(); let issued = 0;
  const d: PayDeps & { issued: () => number } = {
    enabled, recipient: TO, secret: Buffer.alloc(32, 7), solUsd: async () => 200,
    rpc: async <T,>(m: string, p: any[]): Promise<T> => {
      if (m === "getSignaturesForAddress") return (byRef[p[0]] ?? []).map((s) => ({ signature: s, err: null })) as T;
      if (m === "getTransaction") return (txs[p[0]] ?? null) as T;
      if (m === "getLatestBlockhash") return { value: { blockhash: "4uQeVj5tqViQh7yWWGStvkEG1Zmhx6uasJtWCJziofM", lastValidBlockHeight: 100 } } as T;
      throw new Error("unexpected " + m);
    },
    issue: async (n, refs) => { if (refs.some((r) => redeemed.has(r))) throw new Error("already_redeemed"); refs.forEach((r) => redeemed.add(r)); issued++; return { key: "rr_test" + issued, credits: n }; },
    isRedeemed: async (r) => redeemed.has(r), issued: () => issued,
  };
  return d;
}
const usdcTx = (ref: string, owner: string, pre: string, post: string, extra: any = {}) => ({ blockTime: Math.floor(Date.now() / 1000), meta: { err: null, preBalances: [], postBalances: [], preTokenBalances: [{ mint: USDC_MINT, owner, uiTokenAmount: { amount: pre } }], postTokenBalances: [{ mint: USDC_MINT, owner, uiTokenAmount: { amount: post } }] }, transaction: { message: { accountKeys: [{ pubkey: PAYER }, { pubkey: ref }] } }, ...extra });
const solTx = (ref: string, to: string, lamports: bigint) => ({ blockTime: Math.floor(Date.now() / 1000), meta: { err: null, preBalances: [5_000_000_000, 1_000], postBalances: [4_000_000_000, String(1_000n + lamports)], preTokenBalances: [], postTokenBalances: [] }, transaction: { message: { accountKeys: [{ pubkey: PAYER }, { pubkey: to }, { pubkey: ref }] } } });
const code = async (p: Promise<unknown>) => { try { await p; return "ok"; } catch (e) { assert.ok(e instanceof PayError, String(e)); return (e as PayError).code; } };

test("USDC pack: correct payment issues a key once; replay of the order or signature is refused", async () => {
  const txs: Record<string, any> = {}, byRef: Record<string, string[]> = {}; const d = deps(txs, byRef);
  const o = await createOrder(d, "50", "usdc"); assert.equal(o.amount, "0.4"); assert.equal(o.credits, 50); assert.match(o.solanaPayUrl, new RegExp(`^solana:${TO}\\?amount=0.4&spl-token=${USDC_MINT}&reference=${o.reference}`));
  assert.equal(await code(claim(d, o.order)), "payment_not_found");
  const s = sig(); txs[s] = usdcTx(o.reference, TO, "1000000", "1400000"); byRef[o.reference] = [s];
  const k = await claim(d, o.order); assert.equal(k.credits, 50); assert.equal(k.signature, s); assert.equal(d.issued(), 1);
  assert.equal(await code(claim(d, o.order)), "already_redeemed");
  const o2 = await createOrder(d, "50", "usdc"); assert.equal(await code(claim(d, o2.order, s)), "already_redeemed"); // same tx reused for a new order
  assert.equal(d.issued(), 1);
});
test("rejects wrong amount, wrong recipient, failed tx, missing reference, fake and tampered orders", async () => {
  const txs: Record<string, any> = {}, byRef: Record<string, string[]> = {}; const d = deps(txs, byRef);
  const o = await createOrder(d, "200", "usdc");
  const s1 = sig(); txs[s1] = usdcTx(o.reference, TO, "0", "1499999"); byRef[o.reference] = [s1];
  assert.equal(await code(claim(d, o.order)), "wrong_amount");
  const s2 = sig(); txs[s2] = usdcTx(o.reference, OTHER, "0", "1500000"); byRef[o.reference] = [s2];
  assert.equal(await code(claim(d, o.order)), "wrong_recipient");
  const s3 = sig(); txs[s3] = usdcTx(o.reference, TO, "0", "1500000", {}); txs[s3].meta.err = { InstructionError: [0, "x"] }; assert.equal(await code(claim(d, o.order, s3)), "transaction_failed");
  const s4 = sig(); txs[s4] = usdcTx("11111111111111111111111111111111", TO, "0", "1500000"); assert.equal(await code(claim(d, o.order, s4)), "reference_missing");
  assert.equal(await code(claim(d, "eyJ2IjoxfQ.fake")), "invalid_order");
  const dec = decodeOrder(o.order, d.secret)!; const forged = encodeOrder({ ...dec, atomic: "1" }, Buffer.alloc(32, 9)); assert.equal(await code(claim(d, forged)), "invalid_order");
  const [body] = o.order.split("."); const tampered = Buffer.from(JSON.stringify({ ...dec, atomic: "1" })).toString("base64url") + "." + o.order.split(".")[1]; assert.notEqual(body, tampered.split(".")[0]); assert.equal(await code(claim(d, tampered)), "invalid_order");
  assert.equal(d.issued(), 0);
});
test("SOL pack priced from SOL/USD with small tolerance; too little SOL is refused", async () => {
  const txs: Record<string, any> = {}, byRef: Record<string, string[]> = {}; const d = deps(txs, byRef);
  const o = await createOrder(d, "10", "sol"); assert.equal(o.amount, "0.0005"); // $0.10 / $200
  const want = 500_000n;
  const s1 = sig(); txs[s1] = solTx(o.reference, TO, want - want / 10n); byRef[o.reference] = [s1]; assert.equal(await code(claim(d, o.order)), "wrong_amount");
  const s2 = sig(); txs[s2] = solTx(o.reference, TO, want - want / 1000n); byRef[o.reference] = [s2]; const k = await claim(d, o.order); assert.equal(k.credits, 10);
  assert.equal(checkTx(decodeOrder(o.order, d.secret)!, solTx(o.reference, OTHER, want)), "wrong_recipient");
});
test("disabled flag: no orders, no transactions; tx builder produces a wallet transaction when enabled", async () => {
  const off = deps({}, {}, false);
  assert.equal(await code(createOrder(off, "10", "usdc")), "wallet_pay_disabled");
  const on = deps({}, {}); const o = await createOrder(on, "10", "usdc");
  assert.equal(await code(buildTx(off, o.order, PAYER)), "wallet_pay_disabled");
  assert.equal(await code(createOrder(on, "7", "usdc")), "invalid_pack");
  const t = await buildTx(on, o.order, PAYER); assert.equal(t.encoding, "base64"); const raw = Buffer.from(t.transaction, "base64");
  const b58 = bs58.encode(raw); assert.ok(raw.length > 150); assert.ok(raw.includes(Buffer.from(bs58.decode(o.reference))), "reference account in tx"); assert.ok(raw.includes(Buffer.from(bs58.decode(TO))) === false, "USDC goes to the ATA, not the owner"); assert.ok(b58.length > 0); assert.ok(raw.includes(Buffer.from(bs58.decode("BaXAaxFZCSiCSXytiHc4u9HqjL9NMxkcDKgSoeYSpAsk"))), "pays RugRadar's USDC ATA (BaXA…)");
  const ts = await buildTx(on, (await createOrder(on, "10", "sol")).order, PAYER); assert.ok(Buffer.from(ts.transaction, "base64").includes(Buffer.from(bs58.decode(TO))));
});
test("QR: signed order -> same Solana Pay URL as the order response; tampered, expired and disabled refused", async () => {
  const d = deps({}, {});
  for (const cur of ["sol", "usdc"] as const) {
    const o = await createOrder(d, "10", cur), dec = decodeOrder(o.order, d.secret)!;
    assert.equal(solanaPayUrl(dec), o.solanaPayUrl); assert.ok(o.solanaPayUrl.startsWith(`solana:${TO}?`), "pays the same RugRadar wallet");
    const svg = orderQrSvg(d, o.order); assert.match(svg, /^<svg /); assert.equal(svg, orderQrSvg(d, o.order));
    const n = qrMatrix(o.solanaPayUrl, "M").length; assert.match(svg, new RegExp(`viewBox="0 0 ${n + 8} ${n + 8}"`));
  }
  const o = await createOrder(d, "50", "usdc");
  const forged = encodeOrder({ ...decodeOrder(o.order, d.secret)!, to: OTHER }, Buffer.alloc(32, 9));
  assert.equal(await code(Promise.resolve().then(() => orderQrSvg(d, forged))), "invalid_order");
  assert.equal(await code(Promise.resolve().then(() => orderQrSvg(d, "not-an-order"))), "invalid_order");
  const later = { ...d, now: () => Date.now() + 21 * 60_000 };
  assert.equal(await code(Promise.resolve().then(() => orderQrSvg(later, o.order))), "order_expired");
  assert.equal(await code(Promise.resolve().then(() => orderQrSvg(deps({}, {}, false), o.order))), "wallet_pay_disabled");
});
test("QR route: GET /rugradar/pay/qr.svg serves image/svg+xml for a valid order and JSON errors otherwise", async () => {
  const d = deps({}, {}); const app = express(); registerWalletPay(app, d);
  const srv = app.listen(0); const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  try {
    const o = await createOrder(d, "10", "sol");
    const r = await fetch(`${base}/rugradar/pay/qr.svg?order=${encodeURIComponent(o.order)}`); assert.equal(r.status, 200); assert.match(r.headers.get("content-type") ?? "", /image\/svg\+xml/); assert.match(await r.text(), /<path d="M/);
    const bad = await fetch(`${base}/rugradar/pay/qr.svg?order=x.y`); assert.equal(bad.status, 400); assert.equal((await bad.json() as any).error, "invalid_order");
    const cfg = await (await fetch(`${base}/rugradar/pay/config`)).json() as any; assert.equal(cfg.recipient, TO);
  } finally { srv.closeAllConnections(); srv.close(); }
});
