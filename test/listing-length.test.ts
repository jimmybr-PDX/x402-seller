/** Guard: CDP verify fails silently for resource.description > 500 chars, which made RugRadar unpayable on Oct 14 2026. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { RUG_EDGE_SHORT } from "../src/lib/rug-extra.js";
test("every paid route description stays under 480 chars", () => {
  const src = fs.readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");
  const descs = [...src.matchAll(/^\s+description:\s*\n?(?:\s*\/\/[^\n]*\n)*\s*`([^`]+)`/gm)].map((m) => m[1]!);
  assert.ok(descs.length >= 10, `found ${descs.length}`);
  for (const d of descs) {
    const v = d.replace(/\$\{RUG_EDGE_SHORT\}/g, RUG_EDGE_SHORT).replace(/\$\{perCall\([^)]*\)\}/g, "$0.01 USDC/call; failed calls are free.").replace(/\$\{usd\([^)]*\)\}/g, "$0.01").replace(/\$\{[^}]+\}/g, "x".repeat(30));
    assert.ok(v.length <= 480, `${v.length} chars: ${v.slice(0, 80)}`);
  }
});
