/**
 * Direct answers for factual "who won X" questions (sports results, awards, elections).
 * Pulls the winner from fresh web results only; says "not found" honestly when no source names one.
 */
export type WinnerSrc = { title: string; url: string; snippet?: string; text?: string | null; published?: string | null };
export type DirectAnswer =
  | { type: "who_won"; found: true; answer: string; winner: string; date: string | null; source: { title: string; url: string }; support: number }
  | { type: "who_won"; found: false; answer: string };

const Q_RE = /^\s*(?:who|which\s+(?:team|player|country|candidate|film|movie|club|driver|horse|party|person|nation))\s+(?:won|wins|has\s+won|will\s+win|took|claimed|is\s+the\s+winner\s+of|was\s+the\s+winner\s+of|got)\b/i;
const Q_RE2 = /\b(?:winner|champion|victor)s?\s+of\b|^\s*who\s+(?:is|was)\s+(?:the\s+)?(?:winner|champion)\b/i;
export function isWinnerQuestion(q: string): boolean { return Q_RE.test(q) || Q_RE2.test(q); }

const STOP = new Set("who which won wins win has will took claimed is was the a an of in at for to and on by what did got winner winners champion champions victor team player country candidate".split(" "));
const keyTerms = (q: string) => [...new Set(q.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 1 && !STOP.has(w)))];
const MONTHS = "January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec";
const DATE_RE = new RegExp(`\\b(?:(?:${MONTHS})\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+\\d{4}|\\d{1,2}\\s+(?:${MONTHS})\\.?\\s+\\d{4}|\\d{4}-\\d{2}-\\d{2})\\b`);
const NAME = "((?:\\p{Lu}[\\p{L}\\d'’.-]*|\\d{2,4}ers)(?:\\s+(?:of|the|de|van|von|da|and|&)?\\s*\\p{Lu}[\\p{L}\\d'’.-]*){0,5})";
const VERB = "(?:won|wins|has\\s+won|claimed|clinched|captured|defeated|beat|beats|took\\s+home|was\\s+awarded|were\\s+awarded|received|was\\s+named\\s+(?:the\\s+)?winner\\s+of|was\\s+elected|is\\s+elected|won\\s+election)";
const ACTIVE = new RegExp(`${NAME}\\s+${VERB}\\b`, "gu");
const PASSIVE = /\b(?:won|awarded|went)\s+(?:to|by)\s+((?:\p{Lu}[\p{L}\d'’.-]*)(?:\s+\p{Lu}[\p{L}\d'’.-]*){0,4})/gu;
const BAD = /^(?:The|A|An|He|She|They|It|Who|This|That|Which|What|When|In|On|At|After|Before|Last|Today|Yesterday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|Watch|Here|How|Why|Also|But|And)$/;

const sentences = (t: string) => t.replace(/\s+/g, " ").split(/(?<=[.!?])\s+(?=[A-Z"“])/).filter((s) => s.length > 15 && s.length < 500);
function cleanName(n: string): string | null {
  const w = n.trim().replace(/[’']s$/, "").split(/\s+/);
  while (w.length && BAD.test(w[0]!)) w.shift();
  while (w.length && /^(?:of|the|de|and|&)$/i.test(w[w.length - 1]!)) w.pop();
  const s = w.join(" ").replace(/[.,]$/, "");
  return s.length >= 2 && !BAD.test(s) ? s : null;
}
function isoDate(s: string | null | undefined): string | null {
  if (!s) return null;
  const d = new Date(s.replace(/(\d)(st|nd|rd|th)/, "$1"));
  return isNaN(+d) ? null : d.toISOString().slice(0, 10);
}

export function extractWinner(question: string, results: WinnerSrc[]): DirectAnswer {
  const terms = keyTerms(question);
  const need = Math.max(1, Math.ceil(terms.length * 0.5));
  const votes = new Map<string, { n: number; score: number; first: { src: WinnerSrc; date: string | null } }>();
  results.forEach((r, rank) => {
    const body = [r.title, r.snippet ?? "", (r.text ?? "").slice(0, 6000)].join(". ");
    for (const s of sentences(body)) {
      const low = s.toLowerCase();
      const hits = terms.filter((t) => low.includes(t)).length;
      if (hits < need) continue;
      const names: string[] = [];
      for (const m of s.matchAll(ACTIVE)) { const n = cleanName(m[1]!); if (n) names.push(n); }
      for (const m of s.matchAll(PASSIVE)) { const n = cleanName(m[1]!); if (n) names.push(n); }
      for (const n of names) {
        if (terms.length && terms.every((t) => n.toLowerCase().includes(t))) continue; // the event itself, not a winner
        const k = n.toLowerCase();
        const sd = s.match(DATE_RE)?.[0];
        const v = votes.get(k) ?? { n: 0, score: 0, first: { src: r, date: isoDate(sd) ?? isoDate(r.published) ?? isoDate(r.url.match(/\/(20\d{2})\/(\d{2})\/(\d{2})\//)?.slice(1).join("-")) } };
        v.n++; v.score += hits / terms.length + 1 / (rank + 1);
        votes.set(k, v);
      }
    }
  });
  const best = [...votes.entries()].sort((a, b) => b[1].score - a[1].score)[0];
  if (!best) return { type: "who_won", found: false, answer: "Not found: none of the fresh web sources checked name a winner for this question." };
  const [, v] = best;
  const winner = [...votes.keys()].length && cleanName(best[0]) ? (() => {
    // recover original casing from a source sentence
    const body = [v.first.src.title, v.first.src.snippet ?? "", v.first.src.text ?? ""].join(" ");
    const i = body.toLowerCase().indexOf(best[0]); return i >= 0 ? body.slice(i, i + best[0].length) : best[0];
  })() : best[0];
  let host = v.first.src.url; try { host = new URL(v.first.src.url).hostname.replace(/^www\./, ""); } catch {}
  const answer = `Winner: ${winner}${v.first.date ? ` (${v.first.date})` : ""} — source: ${host} (${v.first.src.url})`;
  return { type: "who_won", found: true, answer, winner, date: v.first.date, source: { title: v.first.src.title, url: v.first.src.url }, support: v.n };
}
