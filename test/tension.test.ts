import test from "node:test";
import assert from "node:assert/strict";
/**
 * Rule tests for the locked tension-line spec. No network.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  tensionLine, tensionFor, lintLine, baseFacts, syntheticChangeFixtures, hoursAgoIso,
  type SlimFacts, type TensionResult,
} from "../src/lib/tension.js";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const failures: string[] = [];
const ok: string[] = [];

function pass(name: string) { ok.push(name); }
function fail(name: string, msg: string) { failures.push(`${name}: ${msg}`); }

function checkLine(name: string, line: string, type: TensionResult["type"]) {
  const flags = lintLine(line, type);
  if (flags.length) fail(name, `lint: ${flags.join("; ")} [${line}]`);
  else pass(`${name} lint`);
  if (line.length > 140) fail(name, `length ${line.length} > 140`);
  else pass(`${name} <=140 (${line.length})`);
}

// --- nothing flagged = no line ---
{
  const quiet = baseFacts({
    token: "JupLike11111111111111111111111111111111111",
    symbol: "QUIET",
    score: 0,
    codes: [],
    volume24hUsd: 7_000_000,
    buys24h: 20_000,
    sells24h: 20_100,
    liquidityUsd: 3_000_000,
    marketCapUsd: 700_000_000,
    ageHours: 20_000,
    priceChange24hPct: -8,
  });
  const r = tensionLine(quiet);
  if (r !== null) fail("quiet-null", `expected null, got "${r.line}"`);
  else pass("nothing flagged → no line");
}

// --- banned openers / safe words must not appear ---
{
  const f = baseFacts({
    token: "Open11111111111111111111111111111111111111",
    codes: ["deployer_history"],
    creatorEarlierHoneypots: 3,
    liquidityUsd: 80_000,
    volume24hUsd: 10_000,
    score: 9,
  });
  const r = tensionLine(f);
  if (!r) fail("opener-sample", "expected a line");
  else {
    if (/\b(clean contract|no rug switches|ownership renounced|mint off|taxes zero)\b/i.test(r.line)) {
      fail("banned-opener", r.line);
    } else pass("no banned openers");
    if (/\b(safe|secure|legit|no risk|guaranteed)\b/i.test(r.line)) fail("safe-words", r.line);
    else pass("no safe words");
    checkLine("opener-sample", r.line, r.type);
  }
}

// --- two strong dangers: both named, drop second if over 120 ---
{
  const f = baseFacts({
    token: "TwoDanger111111111111111111111111111111111",
    codes: ["deployer_history", "holders"],
    creatorEarlierHoneypots: 4,
    top1Pct: 61,
    top10Pct: 70,
    holderCount: 80,
    liquidityUsd: 90_000,
    volume24hUsd: 20_000,
    score: 40,
  });
  const r = tensionLine(f, new Set());
  if (!r) fail("two-danger", "expected a line");
  else {
    const hasCreator = /creator|honeypot/i.test(r.line);
    const hasHolder = /wallet holds|one address|top holder/i.test(r.line);
    if (r.chars <= 120) {
      if (!(hasCreator && hasHolder)) fail("two-danger", `expected both facts in "${r.line}"`);
      else pass(`two-danger both facts (${r.chars}c) "${r.line}"`);
    } else {
      fail("two-danger", `over 120c without dropping a fact: ${r.chars} "${r.line}"`);
    }
    checkLine("two-danger", r.line, r.type);
  }
}

{
  // Long second fact should be dropped to stay under ~120
  const f = baseFacts({
    token: "LongTwo11111111111111111111111111111111111",
    codes: ["deployer_history", "liquidity"],
    creatorEarlierHoneypots: 0,
    priorLaunches: 2350,
    priorDead: 2334,
    liquidityUsd: 2_100,
    volume24hUsd: 8_000,
    buys24h: 100,
    sells24h: 80,
    score: 45,
  });
  const r = tensionLine(f, new Set());
  if (!r) fail("two-danger-trim", "expected a line");
  else {
    if (r.chars > 140) fail("two-danger-trim", `>140 (${r.chars}) ${r.line}`);
    else pass(`two-danger-trim ${r.chars}c "${r.line}"`);
    checkLine("two-danger-trim", r.line, r.type);
  }
}

// --- under 1 hour punchline only with supporting holder data ---
{
  const weak = baseFacts({
    token: "NewWeak11111111111111111111111111111111111",
    ageHours: 0.4,
    holderCount: 900,
    top1Pct: 4,
    top10Pct: 12,
    liquidityUsd: 80_000,
    volume24hUsd: 15_000,
    score: 10,
    codes: ["age"],
  });
  const r = tensionLine(weak, new Set());
  if (!r) fail("age-only", "expected an under-1-hour line");
  else {
    if (/Most supply is still in the first wallets/i.test(r.line)) fail("age-holder-fit", `used first-wallets punchline without data: ${r.line}`);
    else pass(`age punchline fits data "${r.line}"`);
    checkLine("age-only", r.line, r.type);
  }
}

// --- synthetic change lines ---
const synthNow = Date.parse("2026-11-25T04:50:00.000Z");
const synth = syntheticChangeFixtures(synthNow);
const synthLines: { id: string; label: string; line: string }[] = [];
for (const c of synth) {
  const r = tensionLine(c.facts, new Set(), synthNow);
  if (!r) { fail(`synthetic ${c.id}`, "expected a change line"); continue; }
  if (!r.changeLead) fail(`synthetic ${c.id}`, `did not lead with change: "${r.line}"`);
  else pass(`synthetic ${c.id} leads with change`);
  checkLine(`synthetic ${c.id}`, r.line, r.type);
  synthLines.push({ id: c.id, label: c.label, line: r.line });
  console.log(`SYNTHETIC ${c.id}: "${r.line}" (${r.chars}c)`);
}

// expected shapes
const flip = synthLines.find((s) => s.id === "sell-flip");
if (flip && /flipped to 3-to-1 since last check/i.test(flip.line) && /overnight/i.test(flip.line) && !/Sellers 3-to-1 all day|Both point the same way/i.test(flip.line)) pass("sell-flip wording");
else if (flip) fail("sell-flip wording", flip.line);
const hold = synthLines.find((s) => s.id === "new-holder");
if (hold && /one wallet now holds 64%/i.test(hold.line) && /yesterday/i.test(hold.line)) pass("new-holder wording");
else if (hold) fail("new-holder wording", hold.line);
const liq = synthLines.find((s) => s.id === "liq-down");
if (liq && /Liquidity down 40%/i.test(liq.line)) pass("liq-down wording");
else if (liq) fail("liq-down wording", liq.line);
const cre = synthLines.find((s) => s.id === "creator-flag");
if (cre && /flag just turned on/i.test(cre.line) && /Three earlier honeypots/i.test(cre.line) && /overnight|yesterday/i.test(cre.line)) {
  fail("creator-flag time word", `5h gap should not say overnight/yesterday: ${cre.line}`);
} else if (cre && /flag just turned on/i.test(cre.line) && /Three earlier honeypots/i.test(cre.line)) pass("creator-flag wording");
else if (cre) fail("creator-flag wording", cre.line);
const app = synthLines.find((s) => s.id === "sell-appeared");
if (app && /appeared overnight/i.test(app.line) && /Buys were ahead last time/i.test(app.line)) pass("sell-appeared wording");
else if (app) fail("sell-appeared wording", app.line);

// overnight must not be used on a 2-hour gap
{
  const f = baseFacts({
    token: "ShortGap1111111111111111111111111111111111",
    volume24hUsd: 50_000,
    buys24h: 100,
    sells24h: 300,
    liquidityUsd: 40_000,
    previous: { t: hoursAgoIso(2, synthNow), codes: [], buys24h: 200, sells24h: 90 },
  });
  const r = tensionLine(f, new Set(), synthNow);
  if (!r) fail("short-gap", "expected a change line");
  else if (/\b(overnight|yesterday)\b/i.test(r.line)) fail("short-gap", `used overnight/yesterday on 2h gap: ${r.line}`);
  else pass(`short-gap uses since last check "${r.line}"`);
}

// --- cached tokens ---
const factsPath = process.env.TENSION_FACTS || path.join(DIR, "fixtures", "tension-facts.json");
if (fs.existsSync(factsPath)) {
  const slims: SlimFacts[] = JSON.parse(fs.readFileSync(factsPath, "utf8"));
  const used = new Set<string>();
  const quietWanted = new Set(["JUP", "Bonk", "BONK", "WIF"]);
  for (const s of slims) {
    const r = tensionLine(s, used);
    const name = s.symbol || s.label;
    if (quietWanted.has(name) || (s.score === 0 && !s.codes.length && !s.creatorEarlierHoneypots && !s.previous?.sells24h)) {
      // JUP/BONK/WIF style: no flags
      if ((name === "JUP" || name === "Bonk" || name === "BONK" || name === "WIF") && r) {
        fail(`cached ${name}`, `expected no line, got "${r.line}"`);
      } else if (name === "JUP" || name === "Bonk" || name === "BONK" || name === "WIF") {
        pass(`cached ${name} no line`);
      }
    }
    if (r) {
      checkLine(`cached ${name}`, r.line, r.type);
      if (r.chars > 140) fail(`cached ${name} hard cap`, String(r.chars));
    }
  }
} else {
  pass("cached facts not present (set TENSION_FACTS to run live-token fixtures)");
}

// --- tensionFor on rugCheck-shaped results ---
{
  const quiet = tensionFor({ chain: "solana", token: "JupLike11111111111111111111111111111111111", checks: [{ check: "established", points: 0, detail: "x" }], facts: { volume24hUsd: 7e6 } });
  if (quiet !== null) fail("tensionFor quiet", `expected null, got ${quiet}`); else pass("tensionFor quiet null");
  const hp = tensionFor({ chain: "base", token: "0x1111111111111111111111111111111111111111", riskScore: 85, riskLevel: "high", checks: [{ check: "honeypot", points: 40, detail: "Selling looks blocked for holders." }], facts: { holderCount: 1020, buyer: { honeypot: true } } });
  if (!hp) fail("tensionFor honeypot", "expected a line"); else { checkLine("tensionFor honeypot", hp, "cant_sell" as any); if (/pump\.fun/i.test(hp)) fail("tensionFor pump", hp); }
  const nopool = tensionFor({ chain: "solana", token: "Mlg1111111111111111111111111111111111111pump", riskScore: 52, checks: [{ check: "liquidity", points: 15, detail: "No DEX pool found." }], facts: { liquidityUsd: null, top1Pct: 90, buyer: { sellableOnPumpCurve: true } } });
  if (nopool && /pump\.fun/i.test(nopool)) fail("tensionFor pump fun", nopool); else pass("tensionFor pump fun wording");
}

console.log(`\n${ok.length} passed, ${failures.length} failed`);
for (const f of failures) console.log("FAIL", f);
test("tension line rules", () => { assert.deepEqual(failures, []); });
