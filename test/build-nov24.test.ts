/** Nov 24 build: market warnings, wallet history (private), list/cancel watches, MCP titles. No network. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign as edSign } from "node:crypto";
import express from "express";
import type { AddressInfo } from "node:net";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { marketWarnings, finalizeReport } from "../src/lib/rug.js";
import { challenge, verifyChallenge, sessionWallet, createWalletHistory } from "../src/lib/wallet-history.js";
import { registerRugradarWeb, warnDetails, limitedReport } from "../src/lib/rugradar-web.js";

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function b58(u: Uint8Array) { let n = 0n; for (const b of u) n = n * 256n + BigInt(b); let s = ""; while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; } for (const b of u) { if (b === 0) s = "1" + s; else break; } return s; }

test("market warnings: heavy selling, thin trading, thin liquidity thresholds", () => {
  const base = (f: any) => ({ chain: "base", token: "0x1", checks: [], facts: { volume24hUsd: 25_800, buys24h: 500, sells24h: 751, liquidityUsd: 1_500_000, buyer: { marketCapUsd: 29_900_000 }, ...f } });
  const w = marketWarnings(base({})).map((x) => x.check);
  assert.deepEqual(w, ["heavy_selling", "thin_trading"]);
  assert.deepEqual(marketWarnings(base({ sells24h: 19, buys24h: 1 })).map((x) => x.check), ["thin_trading"], "needs 20+ sells");
  assert.deepEqual(marketWarnings(base({ volume24hUsd: 900, sells24h: 100, buys24h: 10 })).map((x) => x.check), ["thin_trading"], "needs >= $1k volume");
  assert.deepEqual(marketWarnings(base({ volume24hUsd: 4000, buyer: {} })).map((x) => x.check), ["heavy_selling", "thin_trading"], "< $5k when mcap unknown");
  assert.deepEqual(marketWarnings(base({ volume24hUsd: 6000, buys24h: 900, buyer: {} })).map((x) => x.check), [], "$6k with unknown mcap is not thin");
  assert.deepEqual(marketWarnings(base({ buys24h: 900, liquidityUsd: 100_000, buyer: { marketCapUsd: 10_000_000 }, volume24hUsd: 50_000 })).map((x) => x.check), ["liquidity_vs_mcap"]);
  assert.deepEqual(marketWarnings(base({ marketUnknown: true })), []);
  const r = finalizeReport({ chain: "base", token: "0x532f27101965dd16442E59d40670FaF5eBB142E4", riskScore: 0, riskLevel: "low", confidence: "high", reasons: [], checks: [], facts: { ...base({}).facts } });
  assert.equal(r.riskScore, 8); assert.equal(typeof r.tensionLine, "string"); assert.ok(r.tensionLine.length <= 140);
  assert.ok(!/safe|pump\.fun/i.test(r.tensionLine));
  const quiet = finalizeReport({ chain: "solana", token: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN", riskScore: 0, riskLevel: "low", reasons: [], checks: [{ check: "age", points: 0, detail: "old" }], facts: {} });
  assert.equal(quiet.tensionLine, null);
  const det = warnDetails(r);
  assert.match(det.heavy_selling![0], /1\.5 sells per buy/);
  const l = limitedReport(r); assert.equal(l.tensionLine, r.tensionLine); assert.ok(l.warnDetails.thin_trading);
});

test("wallet history: signed challenge (Solana + EVM), session, own list only", async () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32), sol = b58(raw);
  const ch = challenge(sol);
  const sig = edSign(null, Buffer.from(ch.message), privateKey).toString("hex");
  const tok = await verifyChallenge(sol, ch.message, sig);
  assert.ok(tok); assert.equal(sessionWallet(tok), sol);
  assert.equal(await verifyChallenge(sol, ch.message.replace("Nonce: ", "Nonce: x"), sig), null, "tampered nonce");
  assert.equal(await verifyChallenge(sol, ch.message, "00".repeat(64)), null, "bad signature");
  assert.equal(sessionWallet(tok!.slice(0, -2) + "xx"), null, "forged session");
  const acct = privateKeyToAccount(generatePrivateKey());
  const ce = challenge(acct.address), se = await acct.signMessage({ message: ce.message });
  const te = await verifyChallenge(acct.address, ce.message, se);
  assert.equal(sessionWallet(te), acct.address.toLowerCase());
  assert.equal(await verifyChallenge(acct.address, challenge(acct.address, Date.now() - 700_000).message, se), null, "expired");
  let saved: any = null;
  const wh = createWalletHistory({ load: async () => null, save: async (d) => { saved = d; } }, { flushMs: 10 });
  await wh.log(sol, "solana", "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN", 0, "connected");
  await wh.log(acct.address, "base", "0x532f27101965dd16442E59d40670FaF5eBB142E4", 9, "x402");
  await wh.log("not-a-wallet", "base", "0x1", 1, "x402");
  assert.deepEqual((await wh.list(sol)).map((x) => x.token), ["JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN"]);
  assert.equal((await wh.list(acct.address)).length, 1);
  await wh.flush(); assert.equal(saved["wallet-checks.json"].rows.length, 2);
});

test("web: wallet history endpoints need a signed session; MCP lists 6 RugRadar tools with titles; list/cancel watches scoped to the key", async () => {
  const app = express(); app.use(express.json()); const srv = app.listen(0); const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  const wh = createWalletHistory({ load: async () => null, save: async () => {} });
  const watches: Record<string, string[]> = { k1: ["w_aaaa1111"] };
  registerRugradarWeb(app, { publicUrl: base, port: 0, priceUsd: "0.02", speed: null, rugCheck: async () => ({}), spend: async () => 5, refund: async () => {}, wallets: wh,
    watch: { create: async () => ({}), config: () => ({}), list: async (k) => ({ watches: (watches[k] ?? []).map((id) => ({ watchId: id })), count: (watches[k] ?? []).length }),
      cancel: async (k, id) => { if (!(watches[k] ?? []).includes(id)) throw Object.assign(new Error("No watch with that id was started with this credit key."), { code: "not_found" }); return { watchId: id, status: "cancelled", refunded: false }; } } });
  try {
    assert.equal((await fetch(`${base}/rugradar/api/wallet/history`)).status, 401);
    assert.equal((await fetch(`${base}/rugradar/api/wallet/history`, { headers: { "X-RugRadar-Wallet": "abc.def" } })).status, 401);
    const mcp = (body: any, h: Record<string, string> = {}) => fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json", ...h }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, ...body }) }).then((r) => r.json() as any);
    const tools = (await mcp({ method: "tools/list" })).result.tools;
    const names = tools.map((t: any) => t.name);
    assert.deepEqual(names, ["rug_check", "honeypot_check", "token_price", "watch_token", "list_watches", "cancel_watch"]);
    for (const gone of ["token_safety", "research_brief", "read_page", "news_search", "list_recent_reports"]) assert.ok(!names.includes(gone), gone);
    for (const t of tools) { assert.ok(t.title, t.name); assert.ok(t.outputSchema, t.name); assert.ok(t.annotations, t.name); }
    const cw = tools.find((t: any) => t.name === "cancel_watch");
    assert.equal(cw.annotations.destructiveHint, true); assert.match(cw.description, /No refund/);
    assert.ok(!/no list or cancel tool/.test(tools.find((t: any) => t.name === "watch_token").description));
    assert.deepEqual(tools.find((t: any) => t.name === "token_price").inputSchema.properties.chain.enum, ["ethereum", "base", "arbitrum", "polygon", "solana"]);
    assert.equal(new Set(tools.map((t: any) => t.description)).size, 6, "descriptions distinct");
    const lw = await mcp({ method: "tools/call", params: { name: "list_watches", arguments: { api_key: "k1" } } });
    assert.equal(lw.result.structuredContent.count, 1);
    const other = await mcp({ method: "tools/call", params: { name: "cancel_watch", arguments: { api_key: "k2", watch_id: "w_aaaa1111" } } });
    assert.equal(other.result.isError, true); assert.equal(other.result.structuredContent.error, "not_found");
    const ok = await mcp({ method: "tools/call", params: { name: "cancel_watch", arguments: { watch_id: "w_aaaa1111" } } }, { "X-RugRadar-Key": "k1" });
    assert.equal(ok.result.structuredContent.status, "cancelled");
    const nokey = await mcp({ method: "tools/call", params: { name: "list_watches", arguments: {} } });
    assert.equal(nokey.result.structuredContent.error, "missing_key");
    const page = await (await fetch(`${base}/rugradar`)).text();
    assert.ok(page.includes("Connect wallet to see your past checks"));
    assert.ok(!/wallet-checks|\/api\/wallet\/(list|all|export)/.test(page), "no public wallet listing");
  } finally { srv.close(); }
});
