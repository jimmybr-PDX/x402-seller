import type { Express } from "express";
import { scorecard, isRugged } from "./engine.js";
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const LV = ["low", "medium", "high"] as const;
const COL: Record<string, string> = { low: "#2e7d32", medium: "#f9a825", high: "#c62828" };
export function scorecardStats() {
  const xs = scorecard(); const n = xs.length;
  const by = Object.fromEntries(LV.map((l) => [l, xs.filter((x) => x.level === l)]));
  const hist = (arr: typeof xs) => { const h = Array(10).fill(0); for (const x of arr) h[Math.min(9, Math.floor(x.score / 10))]++; return h; };
  const outcome = (arr: typeof xs, k: string) => { const d = arr.filter((x) => x.after[k]); return { checked: d.length, rugged: d.filter((x) => isRugged(x.after[k])).length }; };
  return { totalChecks: n, pct: Object.fromEntries(LV.map((l) => [l, n ? +(by[l].length / n * 100).toFixed(1) : 0])), counts: Object.fromEntries(LV.map((l) => [l, by[l].length])),
    scoreHistogram10pt: { failedHigh: hist(by.high), passedLowOrMedium: hist([...by.low, ...by.medium]) },
    rugRateByLevel: Object.fromEntries(["10m", "1h", "24h"].map((k) => [k, Object.fromEntries(LV.map((l) => [l, outcome(by[l], k)]))])) };
}
export function registerScorecard(app: Express) {
  app.get("/paper/rugradar.json", (_req, res) => { res.set("Cache-Control", "no-store").json({ stats: scorecardStats(), coins: scorecard().slice(-1000) }); });
  app.get("/paper/rugradar", (_req, res) => {
    const st = scorecardStats(); const xs = scorecard();
    const k = (x: any) => (x.after["1h"] ? "1h" : x.after["10m"] ? "10m" : null);
    // scatter: score (x) vs % change at the latest re-check (y, clamped -100..+300)
    const W = 640, H = 300, px = (s: number) => 40 + s / 100 * (W - 60), py = (c: number) => 20 + (300 - Math.max(-100, Math.min(300, c))) / 400 * (H - 40);
    const dots = xs.filter((x) => k(x) && x.after[k(x)!].changePct != null).map((x) => { const a = x.after[k(x)!]; return `<circle cx="${px(x.score).toFixed(1)}" cy="${py(a.changePct!).toFixed(1)}" r="4" fill="${COL[x.level] ?? "#555"}" fill-opacity=".7" stroke="${isRugged(a) ? "#000" : "none"}"><title>${esc(x.symbol)} score ${x.score}: ${a.changePct}% after ${k(x)}</title></circle>`; }).join("");
    const axes = `<line x1="40" y1="${py(0)}" x2="${W - 20}" y2="${py(0)}" stroke="#999" stroke-dasharray="4"/><line x1="40" y1="20" x2="40" y2="${H - 20}" stroke="#999"/>` +
      [-100, 0, 100, 200, 300].map((v) => `<text x="34" y="${py(v) + 4}" font-size="11" text-anchor="end">${v}%</text>`).join("") + [0, 25, 50, 75, 100].map((v) => `<text x="${px(v)}" y="${H - 4}" font-size="11" text-anchor="middle">${v}</text>`).join("");
    const bars = (["10m", "1h", "24h"] as const).map((w, wi) => LV.map((l, li) => { const o = (st.rugRateByLevel as any)[w][l]; const rate = o.checked ? o.rugged / o.checked : 0; const x = 50 + wi * 200 + li * 55, h = rate * 200;
      return `<rect x="${x}" y="${230 - h}" width="45" height="${h}" fill="${COL[l]}"/><text x="${x + 22}" y="${225 - h}" font-size="11" text-anchor="middle">${o.checked ? Math.round(rate * 100) + "%" : "n/a"}</text><text x="${x + 22}" y="246" font-size="10" text-anchor="middle">${l} (${o.checked})</text>`; }).join("") + `<text x="${50 + wi * 200 + 80}" y="264" font-size="12" text-anchor="middle"><tspan font-weight="bold">${w === "10m" ? "after 10 minutes" : w === "1h" ? "after 1 hour" : "after 24 hours"}</tspan></text>`).join("");
    const histRow = (h: number[]) => h.map((v) => `<td>${v}</td>`).join("");
    const rows = xs.slice(-200).reverse().map((x) => { const c = (w: string) => { const a = x.after[w]; return a ? `${a.changePct == null ? "?" : (a.changePct > 0 ? "+" : "") + a.changePct + "%"}${isRugged(a) ? " <b>RUGGED</b>" : ""}${a.sellable === false ? " (can't sell)" : ""}${a.late ? " (late)" : ""}` : "waiting"; };
      return `<tr><td>${new Date(x.checkedAt).toISOString().slice(5, 16).replace("T", " ")}</td><td><a href="https://dexscreener.com/solana/${esc(x.mint)}">${esc(x.symbol || x.mint.slice(0, 6))}</a></td><td>${x.score}</td><td style="color:${COL[x.level]}">${x.level}${x.backfilled ? " (from trade log)" : ""}</td><td>${c("10m")}</td><td>${c("1h")}</td><td>${c("24h")}</td></tr>`; }).join("");
    res.set("Cache-Control", "no-store").type("html").send(`<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width"><meta http-equiv=refresh content=120><title>RugRadar scorecard</title>
<style>body{font:14px system-ui;margin:16px;max-width:1100px}table{border-collapse:collapse}td,th{border-bottom:1px solid #ddd;padding:4px 6px;text-align:left}</style>
<h1>RugRadar scorecard</h1><p>Every coin RugRadar checked for the paper trader: its risk score when checked, then what actually happened 10 minutes, 1 hour and 24 hours later. "Rugged" means the price fell 90% or more, the coin could no longer be sold, or its trading pool was emptied (under $500 left). Prices come from free sources: the pump.fun bonding curve on the Solana network, DexScreener and Jupiter. <a href="/paper">Back to paper trades</a> &middot; <a href="/paper/rugradar.json">Raw data</a></p>
<h2>Summary</h2><p>Coins checked: <b>${st.totalChecks}</b> &middot; rated high risk (fail): <b>${st.pct.high}%</b> (${st.counts.high}) &middot; medium: <b>${st.pct.medium}%</b> (${st.counts.medium}) &middot; low: <b>${st.pct.low}%</b> (${st.counts.low})</p>
<table><tr><th>Score range</th>${Array.from({ length: 10 }, (_, i) => `<th>${i * 10}-${i * 10 + 9}</th>`).join("")}</tr><tr><td>Failed (high risk)</td>${histRow(st.scoreHistogram10pt.failedHigh)}</tr><tr><td>Passed (low or medium)</td>${histRow(st.scoreHistogram10pt.passedLowOrMedium)}</tr></table>
<h2>Risk score vs. price change (latest re-check, up to 1 hour)</h2><svg width="${W}" height="${H}" style="border:1px solid #eee">${axes}${dots}</svg><p>Left = RugRadar said safer, right = riskier. Dots outlined in black rugged. Colors: green low, yellow medium, red high.</p>
<h2>How often coins rugged, by RugRadar rating</h2><svg width="660" height="275" style="border:1px solid #eee">${bars}</svg><p>Number in brackets = coins re-checked so far.</p>
<h2>Every coin (newest first)</h2><table><tr><th>Checked (UTC)</th><th>Coin</th><th>Risk score</th><th>Rating</th><th>After 10 minutes</th><th>After 1 hour</th><th>After 24 hours</th></tr>${rows}</table>`);
  });
}
