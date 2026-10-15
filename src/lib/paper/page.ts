import type { Express } from "express";
import { paperSummary, paperTrades } from "./engine.js";
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
let solUsd: { v: number | null; at: number } = { v: null, at: 0 };
/** Live SOL/USD from Jupiter's free price API, cached 5 minutes. */
async function solPrice(): Promise<number | null> {
  if (Date.now() - solUsd.at < 300_000 && solUsd.v) return solUsd.v;
  try {
    const r = await fetch("https://lite-api.jup.ag/price/v3?ids=So11111111111111111111111111111111111111112", { signal: AbortSignal.timeout(3000) });
    const v = Number((await r.json() as any)?.So11111111111111111111111111111111111111112?.usdPrice);
    if (v > 0) solUsd = { v, at: Date.now() };
  } catch {}
  return solUsd.v;
}
const NAMES: Record<string, string> = { copy: "Copy the winners", sniper: "Sniper (earliest buy)", edge: "Edge-finder (RugRadar low risk only)" };
const REASONS: Record<string, string> = { take_profit: "Hit profit target", trailing_stop: "Fell back from its high", stop_loss: "Hit loss limit", time_stop: "Held too long, sold", no_sell_route_writeoff: "Could not sell, written off" };
const reason = (r?: string) => (r ? (REASONS[r.replace(/_via_curve$/, "")] ?? r) + (r.endsWith("_via_curve") ? " (sold directly on pump.fun)" : "") : "");
const sol = (n: number | null | undefined) => (n == null ? "-" : n.toFixed(4));
const usd = (n: number | null | undefined, p: number | null) => (n == null || p == null ? "-" : (n * p < 0 ? "-$" : "$") + Math.abs(n * p).toFixed(2));
const pct = (n: number | null | undefined) => (n == null ? "-" : (n > 0 ? "+" : "") + (n * 100).toFixed(1) + "%");
const secs = (n?: number) => (n == null ? "-" : n < 120 ? `${n} seconds` : `${(n / 60).toFixed(1)} minutes`);
export function registerPaper(app: Express) {
  app.get("/paper.json", (_req, res) => { res.set("Cache-Control", "no-store").json(paperSummary()); });
  app.get("/paper/trades.json", (_req, res) => { res.set("Cache-Control", "no-store").json(paperTrades().slice(-500)); });
  app.get("/paper", async (_req, res) => {
    const s = paperSummary(); const p = await solPrice();
    const all = paperTrades();
    const rows = Object.entries(s.strategies).map(([k, v]: any) => {
      const xs = all.filter((t: any) => t.strat === k);
      const spent = xs.reduce((a: number, t: any) => a + (t.costSol ?? 0), 0);
      return `<tr><td><b>${esc(NAMES[k] ?? k)}</b></td><td>${v.closedTrades}</td><td>${v.wins}</td><td>${v.winRate == null ? "-" : (v.winRate * 100).toFixed(1) + "%"}</td><td>${sol(spent)} SOL</td><td>${sol(v.totalPnlSol)} SOL</td><td>${usd(v.totalPnlSol, p)}</td><td>${pct(v.avgRoi)}</td><td>${v.failedBuys}</td><td>${v.open.length}</td></tr>`;
    }).join("");
    const rec = s.recent.map((t: any) => `<tr><td>${esc(t.exitAt ?? t.entryAt).slice(5, 16).replace("T", " ")}</td><td>${esc(NAMES[t.strat] ?? t.strat)}</td><td><a href="https://dexscreener.com/solana/${esc(t.mint)}">${esc(t.symbol || t.mint.slice(0, 6))}</a></td><td>${t.result === "win" ? "Profit" : t.result === "loss" ? "Loss" : "Buy failed (fees lost)"}</td><td>${esc(reason(t.exitReason))}</td><td>${secs(t.entryAgeS)}</td><td>${secs(t.holdS)}</td><td>${sol(t.costSol)}</td><td>${sol(t.proceedsSol)}</td><td>${sol(t.pnlSol)}</td><td>${usd(t.pnlSol, p)}</td><td>${pct(t.roi)}</td><td>${t.rugScore ?? "-"}</td></tr>`).join("");
    res.set("Cache-Control", "no-store").type("html").send(`<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width"><meta http-equiv=refresh content=60><title>Paper trader</title>
<style>body{font:14px system-ui;margin:16px;max-width:1200px}table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #ddd;padding:4px 6px;text-align:left}.w{background:#fff3cd;padding:8px}</style>
<h1>Paper trader (pretend money only)</h1><p class=w><b>PAPER TRADING ONLY.</b> No wallet, no keys, no real trades. Each pretend trade spends ${s.sizeSolPerTrade} SOL plus fees. Prices come from live Jupiter quotes at the moment the trade would have landed; network fees, priority fees, our measured delay, and failed buys and sells are included. Not financial advice.</p>
<p>Running since ${esc(s.startedAt).replace("T", " ").slice(0, 16)} UTC &middot; SOL price used: ${p ? "$" + p.toFixed(2) : "unavailable"} (live, refreshed every 5 minutes) &middot; Time to spot a new coin: about ${(s.latency.medianDetectMs / 1000).toFixed(1)} seconds &middot; Time for a pretend trade to land: about ${(s.latency.simulatedExecMs / 1000).toFixed(1)} seconds &middot; Data saved to: ${s.store.mode === "github" ? "private GitHub repo" : esc(s.store.mode)}</p>
<h2>Totals by strategy</h2><table><tr><th>Strategy</th><th>Finished trades</th><th>Profitable trades</th><th>Win rate</th><th>Total spent (SOL)</th><th>Total profit/loss (SOL)</th><th>Total profit/loss (USD)</th><th>Average gain/loss per trade</th><th>Buys that failed</th><th>Trades still open</th></tr>${rows}</table>
<h2>Recent trades</h2><table><tr><th>Time (UTC)</th><th>Strategy</th><th>Coin</th><th>Result</th><th>Why it sold</th><th>Coin age when bought</th><th>Held for</th><th>Bought for (SOL)</th><th>Sold for (SOL)</th><th>Profit/loss (SOL)</th><th>Profit/loss (USD)</th><th>Gain/loss %</th><th>RugRadar risk score (0 safe - 100 risky)</th></tr>${rec}</table>
<p>"Bought for" includes fees and the token account deposit; "Sold for" is what came back after fees, with the deposit refunded. <a href="/paper.json">Raw data</a> &middot; <a href="/paper/trades.json">All trades</a></p>`);
  });
}
