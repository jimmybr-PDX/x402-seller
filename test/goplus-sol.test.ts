import { test } from "node:test"; import assert from "node:assert/strict";
import { parseGoPlusSol, goplusChecks, goplusSol, __setGoplusFetch } from "../src/lib/goplus-sol.js";
import { isDeadToken } from "../src/lib/rug.js";
const raw = (o: any = {}) => ({ closable: { status: "0" }, balance_mutable_authority: { status: "0" }, metadata_mutable: { status: "0" }, dex: [], ...o });
test("clean token: no warnings", () => assert.deepEqual(goplusChecks(parseGoPlusSol(raw())!), []));
test("balance-changing authority, closable, mutable metadata flagged", () => {
  const c = goplusChecks(parseGoPlusSol(raw({ closable: { status: "1" }, balance_mutable_authority: { status: "1" }, metadata_mutable: { status: "1" } }))!).map((x) => x.check);
  assert.deepEqual(c.sort(), ["balance_mutable", "closable", "metadata_mutable"]);
});
test("LP burn: unburned standard pool flagged, CLMM/pump pools and burned pools not", () => {
  const p = (dex: string, type: string, tvl: string, burn: number | null) => ({ dex_name: dex, type, tvl, burn_percent: burn });
  assert.equal(goplusChecks(parseGoPlusSol(raw({ dex: [p("raydium", "Standard", "50000", 2)] }))!)[0].points, 15);
  assert.equal(goplusChecks(parseGoPlusSol(raw({ dex: [p("raydium", "Standard", "50000", 30)] }))!)[0].points, 8);
  assert.deepEqual(goplusChecks(parseGoPlusSol(raw({ dex: [p("raydium", "Standard", "50000", 99)] }))!), []);
  assert.deepEqual(goplusChecks(parseGoPlusSol(raw({ dex: [p("orca", "Concentrated", "50000", 0), p("pumpswap", "Standard", "9000", 0)] }))!), []);
});
test("GoPlus down: null, not cached, never throws", async () => {
  let n = 0; __setGoplusFetch(async () => { n++; throw new Error("down"); });
  assert.equal(await goplusSol("X"), null); assert.equal(await goplusSol("X"), null); assert.equal(n, 2);
  __setGoplusFetch(async () => ({ ok: true, json: async () => ({ result: { Y: raw() } }) }));
  assert.ok(await goplusSol("Y")); assert.ok(await goplusSol("Y"));
});
test("dead token rule", () => {
  assert.equal(isDeadToken({ liquidityUsd: null, ageHours: 3000 }, {}), true);
  assert.equal(isDeadToken({ liquidityUsd: 0, ageHours: 0.1 }, {}), false); // brand-new coin
  assert.equal(isDeadToken({ liquidityUsd: null, ageHours: 3000, marketUnknown: true }, {}), false); // source down
  assert.equal(isDeadToken({ liquidityUsd: null, ageHours: 3000 }, { sellableOnPumpCurve: true }), false);
  assert.equal(isDeadToken({ liquidityUsd: 50000, ageHours: 3000 }, {}), false);
});
import { isEstablished } from "../src/lib/rug.js";
test("established rule", () => {
  assert.equal(isEstablished({ jupiterVerified: true, organicScore: 95, marketCapUsd: 2.5e8 }, 20000), true);
  assert.equal(isEstablished({ jupiterVerified: true, organicScore: 95, marketCapUsd: 2.5e8 }, 24), false); // new
  assert.equal(isEstablished({ jupiterVerified: false, organicScore: 95, marketCapUsd: 2.5e8 }, 20000), false);
  assert.equal(isEstablished({ jupiterVerified: true, organicScore: 40, marketCapUsd: 2.5e8 }, 20000), false);
});
