import { test } from "node:test";
import assert from "node:assert/strict";
import { isWinnerQuestion, extractWinner } from "../src/lib/winner.js";

test("detects who-won questions", () => {
  for (const q of ["Who won the 2026 World Series?", "who won the Nobel Prize in Literature 2025", "Which team won Super Bowl LX", "winner of the 2024 presidential election"]) assert.ok(isWinnerQuestion(q), q);
  for (const q of ["best time to visit Japan", "what is x402", "how to win at chess"]) assert.ok(!isWinnerQuestion(q), q);
});

test("extracts winner with date and source", () => {
  const r = extractWinner("Who won Super Bowl LX?", [
    { title: "Super Bowl LX recap", url: "https://www.espn.com/nfl/sb60", snippet: "The Seattle Seahawks won Super Bowl LX on February 8, 2026, beating New England 29-13.", published: "2026-02-09" },
    { title: "Super Bowl LX", url: "https://example.org/x", snippet: "Seattle Seahawks defeated the Patriots in Super Bowl LX." },
  ]);
  assert.equal(r.found, true);
  if (r.found) { assert.equal(r.winner, "Seattle Seahawks"); assert.equal(r.date, "2026-02-08"); assert.match(r.answer, /espn\.com/); }
});

test("honest not-found when sources don't name a winner", () => {
  const r = extractWinner("Who won the 2030 World Cup?", [{ title: "2030 World Cup host cities", url: "https://x.org", snippet: "The 2030 World Cup will be held in Spain, Portugal and Morocco." }]);
  assert.equal(r.found, false);
  assert.match(r.answer, /^Not found/);
});
