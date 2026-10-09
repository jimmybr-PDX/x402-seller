/**
 * Static checks on the /report Bazaar listing in src/server.ts (no network, server not started):
 * description fits the 500-char listing limit, the declared example input is the query the example output
 * was captured for, and the example permalink points at the pinned demo id.
 * Run: npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");
const route = src.slice(src.indexOf(`"GET /report": {`), src.indexOf(`"GET /read": {`));

test("/report description fits the 500-char limit and names the price", () => {
  const m = route.match(/description:\s*`([^`]+)`/);
  assert.ok(m, "description template found");
  const desc = m![1]!.replace("${perCall(REPORT_PRICE)}", "0.01 USDC/call; failed calls are free.");
  assert.ok(!desc.includes("${"), "no other interpolations");
  assert.ok(desc.length <= 500, `description is ${desc.length} chars`);
  assert.match(desc, /cited answer/);
});

test("/report example input, example output and pinned permalink agree", () => {
  const input = route.match(/input:\s*\{\s*q:\s*"([^"]+)"\s*\}/)?.[1];
  const exampleQuery = src.match(/const reportExample = \{[\s\S]*?"query":\s*"([^"]+)"/)?.[1];
  const permalinkId = src.match(/const reportExample = \{[\s\S]*?"permalink":\s*"[^"]*\/a\/([^"]+)"/)?.[1];
  const pinned = src.match(/pinAnswer\("([^"]+)",\s*reportExample\)/)?.[1];
  assert.ok(input && exampleQuery && permalinkId && pinned);
  assert.equal(input, exampleQuery);
  assert.equal(permalinkId, pinned);
});
