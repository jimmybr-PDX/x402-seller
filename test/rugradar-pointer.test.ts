import { test } from "node:test";
import assert from "node:assert/strict";
import {
  POINTER_PATHS,
  SEE_ALSO_PATHS,
  looksLikeToken,
  pointerHtmlLine,
  pointerPaywallHtml,
  rugradarHref,
  seeAlsoLine,
  tokenFromQuery,
  withSeeAlso,
} from "../src/lib/rugradar-pointer.js";

const BASE = "https://x402-seller-pmlm.onrender.com";
const JUP = "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

test("the four high-view tools get a pointer, and /watch is included in see_also", () => {
  for (const p of ["/report", "/search", "/balance", "/watch"]) {
    assert.equal(POINTER_PATHS.has(p), true, p);
    assert.equal(SEE_ALSO_PATHS.has(p), true, p);
  }
});

test("looksLikeToken accepts mints and 0x contracts, rejects questions and ENS", () => {
  assert.equal(looksLikeToken(JUP), true);
  assert.equal(looksLikeToken(USDC), true);
  assert.equal(looksLikeToken("vitalik.eth"), false);
  assert.equal(looksLikeToken("What is the Model Context Protocol?"), false);
  assert.equal(looksLikeToken(""), false);
  assert.equal(looksLikeToken("<script>"), false);
});

test("rugradarHref stays plain unless the value looks like a token", () => {
  assert.equal(rugradarHref("", BASE), `${BASE}/rugradar`);
  assert.equal(rugradarHref(JUP, BASE), `${BASE}/rugradar?token=${JUP}`);
  assert.equal(rugradarHref("vitalik.eth", BASE), `${BASE}/rugradar`);
  assert.equal(rugradarHref("", "https://example.com/llms.txt"), "https://example.com/rugradar");
});

test("tokenFromQuery only forwards token/address inputs, not research queries", () => {
  assert.equal(tokenFromQuery("/watch", (n) => (n === "token" ? JUP : "")), JUP);
  assert.equal(tokenFromQuery("/balance", (n) => (n === "address" ? USDC : "")), USDC);
  assert.equal(tokenFromQuery("/report", (n) => (n === "q" ? "What is MCP?" : "")), "");
  assert.equal(tokenFromQuery("/search", (n) => (n === "q" ? JUP : "")), JUP);
});

test("see_also uses the approved wording and does not overwrite an existing field", () => {
  assert.equal(seeAlsoLine("", BASE), `Check this token on RugRadar: ${BASE}/rugradar`);
  assert.equal(seeAlsoLine(JUP, BASE), `Check this token on RugRadar: ${BASE}/rugradar?token=${JUP}`);
  const added = withSeeAlso({ tool: "x" }, "", BASE);
  assert.equal(added.see_also, `Check this token on RugRadar: ${BASE}/rugradar`);
  const kept = withSeeAlso({ see_also: "keep me" }, JUP, BASE);
  assert.equal(kept.see_also, "keep me");
  assert.deepEqual(withSeeAlso("nope"), "nope");
});

test("paywall HTML has a visible pointer and a script that can attach ?token=", () => {
  const html = pointerPaywallHtml("Web Search API + Page Text", "$0.01");
  assert.match(html, />Check this token on RugRadar</);
  assert.match(html, /href="\/rugradar"/);
  assert.match(html, /Web Search API \+ Page Text/);
  assert.match(html, /\$0\.01/);
  assert.match(html, /u\.get\("token"\)\|\|u\.get\("address"\)\|\|u\.get\("mint"\)/);
  assert.equal(html.includes("accepts"), false);
  assert.match(pointerHtmlLine(BASE, JUP), new RegExp(`href="${BASE}/rugradar\\?token=${JUP}".*Check this token on RugRadar`));
});
