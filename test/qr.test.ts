import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { qrMatrix, qrSvg } from "../src/lib/qr.js";

const finderOk = (m: boolean[][], x0: number, y0: number) => {
  for (let y = 0; y < 7; y++) for (let x = 0; x < 7; x++) {
    const d = Math.max(Math.abs(x - 3), Math.abs(y - 3));
    if (m[y0 + y]![x0 + x] !== (d !== 2)) return false;
  }
  return true;
};
// Read the 15-bit format info around the top-left finder and check its BCH code; returns [eclBits, mask].
function formatInfo(m: boolean[][]) {
  let v = 0; const b = (x: number, y: number) => (m[y]![x] ? 1 : 0);
  for (let i = 0; i <= 5; i++) v |= b(8, i) << i;
  v |= b(8, 7) << 6; v |= b(8, 8) << 7; v |= b(7, 8) << 8;
  for (let i = 9; i < 15; i++) v |= b(14 - i, 8) << i;
  const raw = v ^ 0x5412, data = raw >>> 10; let r = data; for (let i = 0; i < 10; i++) r = (r << 1) ^ ((r >>> 9) * 0x537);
  assert.equal(((data << 10) | r) & 0x7fff, raw, "format BCH");
  return [data >>> 3, data & 7];
}

test("QR: version sizing, finder patterns, timing and format info (ECC M) are correct", () => {
  const url = "solana:3a9DUWEA34ejDaMbWo96gFfuqN2TvojJewUBCA14Dg75?amount=1.5&spl-token=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v&reference=7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU&label=RugRadar&message=200%20RugRadar%20credits";
  for (const [t, ver] of [["hello", 1], [url, 11], ["x".repeat(400), 15]] as const) {
    const m = qrMatrix(t, "M"), n = m.length;
    assert.equal(n, 4 * ver + 17, `version for ${t.length} bytes`);
    assert.ok(finderOk(m, 0, 0) && finderOk(m, n - 7, 0) && finderOk(m, 0, n - 7), "finders");
    for (let i = 8; i < n - 8; i++) { assert.equal(m[6]![i], i % 2 === 0); assert.equal(m[i]![6], i % 2 === 0); }
    assert.equal(m[n - 8]![8], true, "dark module");
    const [ecl, mask] = formatInfo(m); assert.equal(ecl, 0, "ECC level M"); assert.ok(mask! >= 0 && mask! <= 7);
  }
  assert.equal(qrMatrix("hello", "L").length, 21);
  const [eclL] = formatInfo(qrMatrix("hello", "L")); assert.equal(eclL, 1, "ECC level L");
});

test("QR: deterministic output (golden) and too-long input throws", () => {
  const h = (t: string) => createHash("sha256").update(qrMatrix(t, "M").map((r) => r.map((b) => (b ? 1 : 0)).join("")).join("\n")).digest("hex").slice(0, 16);
  assert.equal(h("hello"), h("hello"));
  assert.equal(h("solana:3a9DUWEA34ejDaMbWo96gFfuqN2TvojJewUBCA14Dg75?amount=0.1"), GOLDEN);
  assert.throws(() => qrMatrix("A".repeat(3000), "M"), /qr_too_long/);
});

test("QR SVG: one path, quiet zone, fixed size, no script", () => {
  const s = qrSvg("hello", { px: 200 });
  assert.match(s, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 29 29" width="200" height="200"/);
  assert.equal((s.match(/<path /g) ?? []).length, 1); assert.ok(!/script/i.test(s)); assert.ok(s.length < 4000);
});
const GOLDEN = "9608cacffd4c07a3";
