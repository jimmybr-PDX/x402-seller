import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import express from "express";
import type { AddressInfo } from "node:net";
import { registerRugradarWeb } from "../src/lib/rugradar-web.js";
import { rugradarAgentGuide, SKILL_CONTENT_TYPE } from "../src/lib/rugradar-skill.js";

const PRIVATE = ["known-good dev", "known good", "creator family", "name history", "coinFactoryFunder", "named wallet", "inflow", "graduation"];
const U = "https://x402-seller-pmlm.onrender.com";

test("RugRadar default price is $0.01 and edge copy matches", () => {
  const server = fs.readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");
  const extra = fs.readFileSync(new URL("../src/lib/rug-extra.ts", import.meta.url), "utf8");
  assert.match(server, /const RUG_PRICE = process\.env\.RUG_PRICE \?\? "\$0\.01";/);
  assert.match(extra, /export const RUG_EDGE = "\$0\.01 per check:/);
  assert.match(extra, /export const RUG_EDGE_SHORT = "\$0\.01\/check:/);
  assert.match(server, /"\/rug-check": RUG_PRICE/);
  assert.match(server, /"\/honeypot-check": RUG_PRICE/);
  assert.match(server, /"\/token-safety": RUG_PRICE/);
  assert.match(server, /"\/credits\/buy": RUG_PRICE/);
  assert.match(server, /"\/price": TOKEN_PRICE/);
  assert.match(server, /const TOKEN_PRICE = process\.env\.TOKEN_PRICE \?\? "\$0\.001";/);
  assert.match(server, /const GAS_PRICE = process\.env\.GAS_PRICE \?\? "\$0\.001";/);
  assert.match(server, /const NEWS_PRICE = process\.env\.NEWS_PRICE \?\? "\$0\.004";/);
  assert.match(server, /const READ_PRICE = process\.env\.READ_PRICE \?\? "\$0\.004";/);
  assert.match(server, /"\/watch": "\$0\.05"/);
});

test("rugradarAgentGuide covers endpoints, $0.01 pricing, warnings, and agent rules", () => {
  const md = rugradarAgentGuide(U, "0.01");
  assert.match(md, /^# RugRadar/m);
  assert.match(md, /warnings only/i);
  assert.match(md, /\$0\.01/);
  assert.match(md, /1 free check every day/);
  assert.match(md, /no API key, no account/i);
  for (const path of [
    `${U}/rug-check?token=<address>&chain=<solana|base|ethereum|bnb|arbitrum>`,
    `${U}/honeypot-check?token=<address>&chain=<chain>`,
    `${U}/price?token=<address>`,
    `${U}/watch?token=<solana-mint>&hours=24&webhook=<https-url>`,
    `${U}/mcp`,
    `${U}/rugradar`,
  ]) assert.ok(md.includes(path), path);
  for (const tool of ["rug_check", "honeypot_check", "token_price", "watch_token", "list_watches", "cancel_watch"]) {
    assert.ok(md.includes(tool), tool);
  }
  for (const w of ["mint authority", "freeze authority", "concentrated supply", "dev bag", "unlocked liquidity", "honeypot", "taxes", "creator launch history"]) {
    assert.match(md, new RegExp(w, "i"), w);
  }
  assert.match(md, /token address/);
  assert.match(md, /not "CA"/);
  assert.match(md, /Never say or imply a token is "safe"/);
  assert.doesNotMatch(md, /token is safe to |this token is safe|considered safe/i);
  for (const bad of PRIVATE) assert.ok(!md.toLowerCase().includes(bad.toLowerCase()), bad);
  assert.match(md, /\$0\.001/);
  assert.match(md, /\$0\.05 \/ 24h, \$0\.10 \/ 48h/);
});

test("GET /skill.md and /agents.md return the same markdown at $0.01", async () => {
  const app = express();
  const srv = app.listen(0);
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  registerRugradarWeb(app, { publicUrl: base, port: 0, priceUsd: "0.01", speed: null, rugCheck: async () => ({}), spend: async () => null, refund: async () => {} });
  try {
    const want = rugradarAgentGuide(base, "0.01");
    for (const path of ["/skill.md", "/agents.md"]) {
      const res = await fetch(`${base}${path}`);
      assert.equal(res.status, 200, path);
      assert.equal(res.headers.get("content-type"), SKILL_CONTENT_TYPE, path);
      const body = await res.text();
      assert.equal(body, want, path);
      assert.match(body, /\$0\.01/);
    }
    const map = await (await fetch(`${base}/sitemap.xml`)).text();
    assert.match(map, /\/skill\.md<\/loc>/);
    assert.match(map, /\/agents\.md<\/loc>/);
  } finally { srv.close(); }
});
