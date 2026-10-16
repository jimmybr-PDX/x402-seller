import test from "node:test";
import assert from "node:assert/strict";
import { CHAINS } from "../src/lib/price.js";

// Offline: point Arbitrum at a closed local port so every RPC call fails.
(CHAINS as any).arbitrum.rpcs = ["http://127.0.0.1:9/rpc"];
const { txLookup } = await import("../src/lib/tx.js");

test("RPC outage is an upstream error (503, not charged), never 'not found' or 'pending'", async () => {
  await assert.rejects(
    () => txLookup("0xf63a498dacb3c8be662785fe0d4beb30611d9f0e011d6689a0a040789b84fea6", "arbitrum"),
    /Could not confirm on every chain: arbitrum: RPC error/,
  );
});
