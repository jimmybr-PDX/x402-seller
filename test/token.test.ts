import { test } from "node:test";
import assert from "node:assert/strict";
import { TokenInputError, tokenInfo } from "../src/lib/token.js";

test("tokenInfo rejects empty and unknown symbols", async () => {
  await assert.rejects(() => tokenInfo(""), (e: unknown) => e instanceof TokenInputError);
  await assert.rejects(() => tokenInfo("NOTAREALTICKERXYZ"), (e: unknown) => e instanceof TokenInputError && /unknown_symbol/.test((e as Error).message));
  await assert.rejects(() => tokenInfo("USDC", "moonchain"), (e: unknown) => e instanceof TokenInputError && /unknown chain/.test((e as Error).message));
});

test("tokenInfo returns native ETH with no fixed supply", async () => {
  const r = await tokenInfo("ETH");
  assert.equal(r.token.kind, "native");
  assert.equal(r.token.symbol, "ETH");
  assert.equal(r.token.decimals, 18);
  assert.equal(r.totalSupply, null);
  assert.equal(r.token.chain, "ethereum");
});

test("tokenInfo reads USDC on ethereum from public RPC", async () => {
  const r = await tokenInfo("USDC", "ethereum");
  assert.equal(r.token.kind, "erc20");
  assert.equal(r.token.symbol, "USDC");
  assert.equal(r.token.decimals, 6);
  assert.equal(r.token.chain, "ethereum");
  assert.equal(r.token.address, "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48");
  assert.ok(typeof r.totalSupply === "number" && r.totalSupply > 1_000_000);
  assert.ok(typeof r.supplyNote === "string" && /this chain only/.test(r.supplyNote));
  assert.ok(r.explorer.includes("etherscan.io"));
});

test("tokenInfo reads a Solana mint (USDC) from public RPC", async () => {
  const r = await tokenInfo("USDC", "solana");
  assert.equal(r.token.kind, "spl");
  assert.equal(r.token.chain, "solana");
  assert.equal(r.token.mint, "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
  assert.equal(r.token.decimals, 6);
  assert.ok(r.totalSupply === null || r.totalSupply > 1_000_000);
  assert.ok(r.explorer.includes("solscan.io"));
});
