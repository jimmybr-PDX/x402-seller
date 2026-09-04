import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG = path.resolve(__dirname, "..", "payments.jsonl");

type Row = {
  type?: string;
  kind?: string;
  priceUsd?: number;
  at?: string;
};

function main() {
  if (!fs.existsSync(LOG)) {
    console.log(`No log yet at ${LOG}`);
    return;
  }
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const lines = fs.readFileSync(LOG, "utf8").split("\n").filter(Boolean);
  let settlements = 0;
  let errors = 0;
  let revenueUsd = 0;
  const byDay: Record<string, { settlements: number; errors: number; usd: number }> = {};
  const errorKinds: Record<string, number> = {};
  for (const line of lines) {
    let row: Row;
    try { row = JSON.parse(line) as Row; } catch { continue; }
    if (!row.at) continue;
    const t = Date.parse(row.at);
    if (!Number.isFinite(t) || t < cutoff) continue;
    const day = row.at.slice(0, 10);
    byDay[day] ??= { settlements: 0, errors: 0, usd: 0 };
    if (row.type === "settlement") {
      settlements += 1;
      const usd = typeof row.priceUsd === "number" ? row.priceUsd : 0;
      revenueUsd += usd;
      byDay[day].settlements += 1;
      byDay[day].usd += usd;
    } else if (row.type === "error") {
      errors += 1;
      byDay[day].errors += 1;
      const k = row.kind ?? "unknown";
      errorKinds[k] = (errorKinds[k] ?? 0) + 1;
    }
  }
  console.log("=== x402 seller - last 7 days (UTC) ===");
  console.log(`Log: ${LOG}`);
  console.log(`Settlements: ${settlements}`);
  console.log(`Revenue (sum priceUsd): $${revenueUsd.toFixed(2)}`);
  console.log(`Errors: ${errors}`);
  if (Object.keys(errorKinds).length) console.log("Error kinds:", errorKinds);
  console.log("\nBy day:");
  const days = Object.keys(byDay).sort();
  if (!days.length) {
    console.log("  (no rows in window)");
  } else {
    for (const d of days) {
      const x = byDay[d]!;
      console.log(`  ${d}  settlements=${x.settlements}  usd=$${x.usd.toFixed(2)}  errors=${x.errors}`);
    }
  }
}

main();
