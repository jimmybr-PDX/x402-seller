// Minimal RugRadar HTTP client. Pays with a prepaid credit key (X-RugRadar-Key).
// Buy credits: https://x402-seller-pmlm.onrender.com/credits/buy?credits=100 (x402, $0.01 per check).
export const RUGRADAR_URL = "https://x402-seller-pmlm.onrender.com";
export type Tool = "rug-check" | "token-safety" | "honeypot-check";
export async function rugradar(tool: Tool, token: string, chain = "solana", apiKey = process.env.RUGRADAR_API_KEY ?? "", baseUrl = process.env.RUGRADAR_URL ?? RUGRADAR_URL) {
  if (!apiKey) throw new Error("Set RUGRADAR_API_KEY (buy credits at " + baseUrl + "/credits/buy?credits=100)");
  const r = await fetch(`${baseUrl}/${tool}?token=${encodeURIComponent(token)}&chain=${encodeURIComponent(chain)}`, { headers: { "X-RugRadar-Key": apiKey, accept: "application/json" }, signal: AbortSignal.timeout(20000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`RugRadar ${r.status}: ${(j as any).error ?? "request failed"}`);
  return j as { riskScore: number; riskLevel: string; reasons: string[]; disclaimer: string; [k: string]: unknown };
}
export const DISCLAIMER = "Automated heuristic, may be wrong. Not financial advice. Do your own research.";
