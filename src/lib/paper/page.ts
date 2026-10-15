import type { Express } from "express";
import { paperSummary, paperTrades } from "./engine.js";
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
export function registerPaper(app: Express) {
  app.get("/paper.json", (_req, res) => { res.set("Cache-Control", "no-store").json(paperSummary()); });
  app.get("/paper/trades.json", (_req, res) => { res.set("Cache-Control", "no-store").json(paperTrades().slice(-500)); });
  app.get("/paper", (_req, res) => {
    const s = paperSummary();
    const rows = Object.entries(s.strategies).map(([k, v]: any) => `<tr><td><b>${k}</b></td><td>${v.closedTrades}</td><td>${v.winRate == null ? "-" : (v.winRate * 100).toFixed(1) + "%"}</td><td>${v.totalPnlSol.toFixed(4)}</td><td>${v.avgRoi == null ? "-" : (v.avgRoi * 100).toFixed(1) + "%"}</td><td>${v.failedBuys}</td><td>${v.open.length}</td></tr>`).join("");
    const rec = s.recent.map((t: any) => `<tr><td>${esc(t.exitAt ?? t.entryAt).slice(5, 19)}</td><td>${t.strat}</td><td><a href="https://dexscreener.com/solana/${esc(t.mint)}">${esc(t.symbol || t.mint.slice(0, 6))}</a></td><td>${t.result}</td><td>${esc(t.exitReason ?? "")}</td><td>${t.entryAgeS ?? "-"}s</td><td>${t.holdS ?? "-"}s</td><td>${t.entryPriceSol?.toExponential(3) ?? "-"}</td><td>${t.exitPriceSol?.toExponential(3) ?? "-"}</td><td>${(t.pnlSol).toFixed(4)}</td><td>${t.rugScore ?? "-"}</td></tr>`).join("");
    res.set("Cache-Control", "no-store").type("html").send(`<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width"><meta http-equiv=refresh content=60><title>Paper trader</title>
<style>body{font:14px system-ui;margin:16px;max-width:1100px}table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #ddd;padding:4px 6px;text-align:left}.w{background:#fff3cd;padding:8px}</style>
<h1>Paper trader (simulated only)</h1><p class=w><b>PAPER TRADING ONLY.</b> No wallet, no keys, no real trades. ${s.sizeSolPerTrade} SOL simulated per trade. Fills from live Jupiter quotes at simulated landing time; fees, priority fees, measured latency, failed buys/sells included. Not financial advice.</p>
<p>Since ${esc(s.startedAt)} &middot; median detect latency ${s.latency.medianDetectMs} ms &middot; RPC round trip ${s.latency.medianRpcRoundTripMs} ms &middot; simulated exec ${s.latency.simulatedExecMs} ms &middot; store: ${esc(s.store.mode)} ${esc(s.store.lastPushAt ?? "")}</p>
<table><tr><th>Strategy</th><th>Closed</th><th>Win rate</th><th>P&amp;L (SOL)</th><th>Avg ROI</th><th>Failed buys</th><th>Open</th></tr>${rows}</table>
<h2>Recent trades</h2><table><tr><th>Time (UTC)</th><th>Strat</th><th>Coin</th><th>Result</th><th>Exit</th><th>Entry age</th><th>Hold</th><th>Entry px (SOL)</th><th>Exit px</th><th>P&amp;L SOL</th><th>Rug score</th></tr>${rec}</table>
<p><a href="/paper.json">JSON</a> &middot; <a href="/paper/trades.json">all trades</a></p>`);
  });
}
