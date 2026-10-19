import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
const src = fs.readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");
test("RugRadar icons exist and both RugRadar listings use the RugRadar icon", () => {
  for (const f of ["rug-radar-512.png", "rug-radar-192.png", "rug-radar-64.png", "rug-radar-32.png", "rug-radar-16.png", "favicon.ico", "preview-label.png", "rug-radar-1024.png"])
    assert.ok(fs.statSync(new URL(`../src/assets/rugradar/${f}`, import.meta.url)).size > 500, f);
  for (const name of ["RugRadar: Solana Rug Check & Token Safety Score", "Is This Token Safe? RugRadar Token Safety Score"]) {
    const i = src.indexOf(`serviceName: "${name}"`);
    assert.ok(i > 0 && src.slice(i, i + 400).includes("iconUrl: RUG_ICON_URL"), name);
  }
  assert.match(src, /Automated heuristic, may be wrong\. Not financial advice\. Do your own research\./);
});
test("RugRadar price is $0.01", () => { assert.match(src, /const RUG_PRICE = process\.env\.RUG_PRICE \?\? "\$0\.01";/); });
