import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import express from "express";
import type { AddressInfo } from "node:net";
import { registerRugradarWeb, agentSnippets } from "../src/lib/rugradar-web.js";
import { sign } from "../src/lib/watch.js";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

test("/rugradar has a compact 'For bots & agents' section: MCP, 4 tools with prices, x402 endpoints, credits, signature snippets", async () => {
  const app = express(); const srv = app.listen(0); const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  registerRugradarWeb(app, { publicUrl: base, port: 0, priceUsd: "0.01", speed: null, rugCheck: async () => ({}), spend: async () => null, refund: async () => {} });
  try {
    const h = await (await fetch(`${base}/rugradar`)).text();
    assert.ok(h.includes('id="agents"') && h.includes('href="#agents"'));
    for (const x of ["rug_check", "token_safety", "honeypot_check", "watch_token", `${base}/mcp`, "/watch?token=", "/credits/buy?credits=N", "$0.05 / 24h, $0.10 / 48h", "X-RugRadar-Key", "X-RugRadar-Signature", "timingSafeEqual", "compare_digest", "PAYMENT-SIGNATURE"]) assert.ok(h.includes(x) || h.includes(x.replace(/&/g, "&amp;")), x);
    assert.ok(Buffer.byteLength(h) < 55_500, `page stays small (${Buffer.byteLength(h)} bytes)`);
    for (const bad of ["inflow", "winner", "family", "named wallet", "known good"]) assert.ok(!h.toLowerCase().includes(bad), bad);
  } finally { srv.close(); }
});
test("the published signature snippets verify real RugRadar signatures (Node and Python) and reject tampering", () => {
  const sn = agentSnippets("https://x"), secret = "whsec_abc", body = JSON.stringify({ event: "watch.alert", token: "M" }), hdr = sign(secret, body);
  const verify = new Function("require", sn.node + "; return verify;")(require) as (r: string, h: string, s: string) => boolean;
  assert.equal(verify(body, hdr, secret), true); assert.equal(verify(body + " ", hdr, secret), false); assert.equal(verify(body, hdr, "whsec_x"), false);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sig-")); const py = path.join(dir, "v.py");
  fs.writeFileSync(py, sn.python + `\nimport sys\nprint(verify(sys.argv[1].encode(), sys.argv[2], sys.argv[3]), verify((sys.argv[1] + " ").encode(), sys.argv[2], sys.argv[3]))\n`);
  assert.equal(execFileSync("python3", [py, body, hdr, secret]).toString().trim(), "True False");
});
