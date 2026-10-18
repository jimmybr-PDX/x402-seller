import { test } from "node:test";
import assert from "node:assert/strict";
import { cfgOf, CFG, STRATS, TESTS, coinFactoryOf } from "../src/lib/paper/engine.js";

test("Oct 18 paper tests: 0.2 SOL, same cost model, tp20 exits; existing configs untouched", () => {
  for (const s of ["early_v1", "tp20", "inflow_tp"]) { assert.ok(STRATS.includes(s)); assert.ok(TESTS.some((t) => t.strat === s)); assert.equal(cfgOf(s).size, 0.2); assert.equal(cfgOf(s).prio, CFG.copy.prio); assert.equal(cfgOf(s).tip, 0); }
  assert.equal(cfgOf("tp20").tp, 0.2); assert.equal(cfgOf("inflow_tp").tp, 0.2); assert.ok(cfgOf("tp20").trail < 1);
  assert.deepEqual(cfgOf("copy_r40"), CFG.copy); assert.deepEqual(cfgOf("inflow_v1"), CFG.inflow); assert.equal(cfgOf("copy_v2ff").stallS, 90);
});
test("coinFactoryFunder: known name flags; untraced is not flagged", () => {
  assert.equal(coinFactoryOf(null, null).flag, false);
  const f: any = { creator: "C1", hops: [{ wallet: "F1", label: null, sol: 1 }] };
  assert.equal(coinFactoryOf(f, { creator: { name: "helpmegetcamaro.sol" } } as any).flag, true);
  assert.equal(coinFactoryOf(f, null).flag, false);
});
