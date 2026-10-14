import { rugradar, DISCLAIMER } from "./client.js";
const MINT = /\b(0x[a-fA-F0-9]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})\b/;
const CHAIN = /\b(base|bsc|bnb|ethereum|eth|arbitrum)\b/i;
const chainOf = (t: string) => { const c = t.match(CHAIN)?.[1]?.toLowerCase(); return c === "bnb" ? "bsc" : c === "eth" ? "ethereum" : c ?? "solana"; };
const mk = (name: string, tool: "rug-check" | "token-safety" | "honeypot-check", similes: string[], description: string) => ({
  name, similes, description,
  validate: async (_rt: any, msg: any) => MINT.test(msg?.content?.text ?? ""),
  handler: async (rt: any, msg: any, _s: any, _o: any, cb?: (r: any) => any) => {
    const text = msg?.content?.text ?? ""; const token = text.match(MINT)![1];
    try {
      const r = await rugradar(tool, token, token.startsWith("0x") ? chainOf(text) : "solana", rt?.getSetting?.("RUGRADAR_API_KEY") ?? undefined);
      const out = `RugRadar: risk ${r.riskScore}/100 (${r.riskLevel}). ${r.reasons.slice(0, 4).join("; ")}. ${DISCLAIMER}`;
      await cb?.({ text: out, content: r }); return { success: true, text: out, data: r };
    } catch (e) { const out = `RugRadar check failed: ${(e as Error).message}`; await cb?.({ text: out }); return { success: false, text: out }; }
  },
  examples: [[{ name: "{{user1}}", content: { text: `${name === "RUGRADAR_HONEYPOT_CHECK" ? "can I sell" : "is this a rug"} JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN` } }, { name: "{{agent}}", content: { text: "RugRadar: risk 8/100 (low)...", actions: [name] } }]],
});
export const rugradarPlugin = {
  name: "rugradar", description: "Rug-pull, token-safety and honeypot risk checks (Solana, Base, BNB, Ethereum, Arbitrum). " + DISCLAIMER,
  actions: [
    mk("RUGRADAR_RUG_CHECK", "rug-check", ["RUG_CHECK", "IS_IT_A_RUG"], "Check a token for high-risk rug-pull patterns."),
    mk("RUGRADAR_TOKEN_SAFETY", "token-safety", ["TOKEN_SAFETY", "MEMECOIN_RISK"], "Token safety score for a memecoin or ERC-20."),
    mk("RUGRADAR_HONEYPOT_CHECK", "honeypot-check", ["HONEYPOT_CHECK", "CAN_I_SELL"], "Check whether a token shows honeypot / can't-sell patterns."),
  ],
};
export default rugradarPlugin;
