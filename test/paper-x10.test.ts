import { test } from "node:test";
import assert from "node:assert/strict";
import { cfgOf, CFG, STRATS, TESTS, X10, x10Reason, TP20 } from "../src/lib/paper/engine.js";

test("inflow_x10: own strategy on inflow's cost model with 0.0001 SOL priority fee and -15% stop", () => {
  assert.ok(STRATS.includes("inflow_x10")); assert.ok(TESTS.some((t) => t.strat === "inflow_x10" && t.startedAt));
  const c = cfgOf("inflow_x10");
  assert.equal(c.size, 0.2); assert.equal(c.prio, 100_000); assert.equal(c.sl, -0.15); assert.equal(c.tip, 0);
  assert.equal(c.maxHoldS, CFG.inflow.maxHoldS); assert.equal(c.tp, CFG.inflow.tp); assert.equal(c.trailArm, CFG.inflow.trailArm);
  assert.equal(X10.afterS, 10); assert.equal(X10.minPeakPct, 5); assert.equal(X10.trailPct, 20);
});
test("existing strategies are untouched (copy_r40 stays the control)", () => {
  assert.deepEqual(cfgOf("copy_r40"), CFG.copy); assert.deepEqual(cfgOf("inflow_v1"), CFG.inflow);
  assert.deepEqual(cfgOf("inflow_fx25"), { ...CFG.inflow, maxOpen: 99 }); assert.deepEqual(cfgOf("inflow_tp"), { ...CFG.inflow, ...TP20 });
  assert.equal(CFG.inflow.prio, 1_000_000); assert.equal(CFG.inflow.sl, -0.25); assert.equal(CFG.copy.prio, 1_000_000);
  assert.equal(TESTS.find((t) => t.strat === "copy_r40")!.rule.startsWith("Control"), true);
});
test("x10Reason: 10 s never-above-+5% exit, 20% trail from the high, -15% stop", () => {
  assert.equal(x10Reason({ peakRoi: 0.04, lastMarkRoi: 0.01 }, 9.9), null);                 // before 10 s: hold
  assert.equal(x10Reason({ peakRoi: 0.04, lastMarkRoi: 0.01 }, 10), "x10_never_above_5pct");
  assert.equal(x10Reason({ peakRoi: 0.05, lastMarkRoi: 0.0 }, 10), "x10_never_above_5pct"); // exactly +5% is not "above"
  assert.equal(x10Reason({ peakRoi: 0.06, lastMarkRoi: 0.02 }, 10), null);                  // was above +5%: keep
  assert.equal(x10Reason({ peakRoi: 0.5, lastMarkRoi: 0.21 }, 30), null);                   // 1.21 > 1.5 * 0.8
  assert.equal(x10Reason({ peakRoi: 0.5, lastMarkRoi: 0.19 }, 30), "trailing_stop_20pct");  // 1.19 <= 1.20
  assert.equal(x10Reason({ peakRoi: 0.0, lastMarkRoi: -0.15 }, 3), "stop_loss");
  assert.equal(x10Reason({ peakRoi: 0.0, lastMarkRoi: -0.14 }, 3), null);
});
