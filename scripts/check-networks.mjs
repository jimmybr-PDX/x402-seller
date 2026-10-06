#!/usr/bin/env node
/** Free: fetch each paid route unpaid and verify its 402 challenge lists every intended network with the right
 * USDC asset, payTo and amount. ORIGIN env overrides (default live). Exit 1 on any mismatch. */
const ORIGIN = (process.env.ORIGIN ?? "https://x402-seller-pmlm.onrender.com").replace(/\/$/, "");
const EVM = "0x079471E6F43b6feeF80895E19cBFcBB496904852", SOL = "787RZwDGpjmRsG5wgnyBeWQHBuARax8Qo6P7dmDuqKeW";
const WANT = {
  "eip155:8453": ["Base", "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", EVM],
  "eip155:137": ["Polygon", "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", EVM],
  "eip155:42161": ["Arbitrum", "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", EVM],
  "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp": ["Solana", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", SOL],
  "eip155:43114": ["Avalanche", "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E", EVM],
  "eip155:1329": ["Sei", "0xe15fC38F6D8c56aF07bbCBe3BAf5708A2Bf42392", EVM],
};
const ROUTES = { "/report?q=test": 10000, "/read?url=https://example.com": 5000, "/check?url=https://example.com": 5000, "/news?q=test": 5000, "/price?token=ETH": 2000, "/solana-price?token=SOL": 2000, "/balance?address=vitalik.eth": 3000, ["/tx?hash=0x" + "ab".repeat(32)]: 3000, "/gas": 2000 };
let bad = 0;
for (const [p, amount] of Object.entries(ROUTES)) {
  const r = await fetch(ORIGIN + p, { headers: { "user-agent": "x402-seller-rankcheck/2 (self; network check)" } });
  const hdr = r.headers.get("payment-required");
  const ch = hdr ? JSON.parse(Buffer.from(hdr, "base64").toString()) : null;
  const acc = ch?.accepts ?? [];
  const problems = [];
  if (r.status !== 402) problems.push(`status ${r.status}`);
  for (const [net, [name, asset, payTo]] of Object.entries(WANT)) {
    const a = acc.find((x) => x.network === net);
    if (!a) { problems.push(`${name} missing`); continue; }
    if (a.asset?.toLowerCase() !== asset.toLowerCase()) problems.push(`${name} asset ${a.asset}`);
    if (a.payTo !== payTo) problems.push(`${name} payTo ${a.payTo}`);
    if (Number(a.amount) !== amount) problems.push(`${name} amount ${a.amount}`);
    if (a.scheme !== "exact") problems.push(`${name} scheme ${a.scheme}`);
    if (net.startsWith("solana") && !a.extra?.feePayer) problems.push(`${name} no feePayer`);
    if (!net.startsWith("solana") && !(a.extra?.name && a.extra?.version)) problems.push(`${name} no EIP-712 name/version`);
  }
  const extra = acc.filter((x) => !WANT[x.network]).map((x) => x.network);
  if (extra.length) problems.push(`unexpected: ${extra.join(",")}`);
  if (problems.length) bad++;
  console.log(`${p.split("?")[0].padEnd(14)} ${r.status} x402v${ch?.x402Version} ${acc.length} networks [${acc.map((a) => WANT[a.network]?.[0] ?? a.network).join(", ")}] $${amount / 1e6} ${problems.length ? "PROBLEMS: " + problems.join("; ") : "OK"}`);
  if (process.env.VERBOSE) console.log(JSON.stringify(acc.map(({ network, asset, payTo, amount, extra }) => ({ network, asset, payTo, amount, extra })), null, 1));
}
process.exit(bad ? 1 : 0);
