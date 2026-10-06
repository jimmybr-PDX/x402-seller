/** Plain-English, mobile-friendly HTML view of /stats for humans (JSON stays the default for programs). */
const FRIENDLY: Record<string, string> = {
  "/report": "Research brief",
  "/read": "Web page reader",
  "/check": "Endpoint checker",
  "/news": "News search",
  "/price": "Crypto price",
  "/solana-price": "Solana price",
  "/balance": "Wallet balance",
  "/tx": "Transaction lookup",
  "/gas": "Gas fees",
};
const TZ = "America/Los_Angeles";
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const n = (x: number) => x.toLocaleString("en-US");
const plural = (x: number, one: string, many: string) => `${n(x)} ${x === 1 ? one : many}`;
export function pt(iso: string): string {
  const d = new Date(iso);
  const time = d.toLocaleTimeString("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit" });
  const day = d.toLocaleDateString("en-US", { timeZone: TZ, month: "short", day: "numeric" });
  return `${time} PT ${day}`;
}

type Row = { unpaid402: { client: number }; paid200: number; selfPaid?: number; automatedRequests?: number; settleFailed?: number };
type Block = { totals: { unpaid402Client: number; paid200: number; selfPaid?: number; automatedRequests?: number; settleFailed: number }; routes: Record<string, unknown> };

type Rejected = { byReason: Array<{ reason: string; count: number }> };
/** Plain words for the payment-library error strings a buyer is most likely to hit. */
function friendlyReason(r: string): string {
  const x = r.toLowerCase();
  if (x.includes("no matching payment requirements")) return "paid in a way we don't accept (wrong network, coin or amount)";
  if (x.includes("insufficient")) return "their wallet didn't have enough USDC";
  if (x.includes("expired") || x.includes("valid_before") || x.includes("validbefore")) return "their payment signature had expired";
  if (x.includes("signature")) return "their payment signature didn't check out";
  if (x.includes("not base64")) return "sent an unreadable payment";
  return r;
}

export function statsHtml(s: { trackingSince: string; generatedAt: string; allTime: Block; last24h: Block; persistence: { mode: string }; rejectedPayments?: Rejected }, paidRoutes: string[]): string {
  const t = s.allTime.totals;
  const self = t.selfPaid ?? 0;
  const head =
    `Since ${pt(s.trackingSince)}: ${plural(t.unpaid402Client, "possible buyer looked at a price", "possible buyers looked at a price")}, ${n(t.paid200)} paid` +
    (self ? ` (${plural(self, "test call", "test calls")} by you not counted)` : "") +
    ".";
  const rows = paidRoutes
    .map((r) => {
      const c = s.allTime.routes[r] as Row | undefined;
      return `<tr><td>${esc(FRIENDLY[r] ?? r)}</td><td>${n(c?.unpaid402.client ?? 0)}</td><td>${n(c?.paid200 ?? 0)}</td><td>${n(c?.automatedRequests ?? 0)}</td></tr>`;
    })
    .join("");
  const d = s.last24h.totals;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="300"><title>Who is using my tools</title>
<style>body{font:16px/1.45 system-ui,-apple-system,sans-serif;margin:0 auto;max-width:640px;padding:16px;color:#1a1a1a}
h1{font-size:1.25rem;line-height:1.35;margin:.2em 0 .8em}table{border-collapse:collapse;width:100%}
th,td{padding:8px 6px;border-bottom:1px solid #e5e5e5;text-align:right}th:first-child,td:first-child{text-align:left}
th{font-size:.85rem;color:#555;font-weight:600}tr.total td{font-weight:700;border-top:2px solid #999}p{color:#555;font-size:.9rem}a{color:#0057b8}</style></head><body>
<h1>${esc(head)}</h1>
<table><thead><tr><th>Tool</th><th>Looked at price</th><th>Paid</th><th>Bots/crawlers</th></tr></thead><tbody>${rows}
<tr class="total"><td>Total</td><td>${n(t.unpaid402Client)}</td><td>${n(t.paid200)}</td><td>${n(t.automatedRequests ?? 0)}</td></tr></tbody></table>
<p>Last 24 hours: ${plural(d.unpaid402Client, "look", "looks")} at a price, ${n(d.paid200)} paid${d.settleFailed ? `, ${n(d.settleFailed)} payment(s) failed to settle` : ""}.</p>
${rejectedLine(s.rejectedPayments)}
<p>"Looked at price" = a likely real program or person asked for a tool and got the price, but didn't pay. "Bots/crawlers" = directory crawlers, uptime pings and other bots. Your own test calls and checks are left out.</p>
<p>Updated ${esc(pt(s.generatedAt))}. Counts reset when the server restarts or redeploys.</p>
<p><a href="?format=json">Raw data (JSON)</a></p>
</body></html>`;
}

function rejectedLine(r?: Rejected): string {
  const list = r?.byReason ?? [];
  if (!list.length) return "";
  const total = list.reduce((a, b) => a + b.count, 0);
  const parts = list.slice(0, 3).map((x) => `${n(x.count)} ${esc(friendlyReason(x.reason))}`);
  return `<p>${plural(total, "payment attempt was", "payment attempts were")} turned down (nobody was charged): ${parts.join("; ")}.</p>`;
}
