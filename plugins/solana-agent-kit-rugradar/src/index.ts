import { z } from "zod";
import { rugradar, DISCLAIMER } from "./client.js";
// Solana Agent Kit v2 Action shape (name, similes, description, examples, schema, handler(agent, input)).
const schema = z.object({ token: z.string().describe("Token mint (Solana) or 0x address (EVM)"), chain: z.enum(["solana", "base", "bsc", "ethereum", "arbitrum"]).default("solana") });
const mk = (name: string, tool: "rug-check" | "token-safety" | "honeypot-check", similes: string[], description: string) => ({
  name, similes, description: description + " " + DISCLAIMER, schema,
  examples: [[{ input: { token: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN" }, output: { status: "success", riskScore: 8, riskLevel: "low" }, explanation: "Low-risk result for JUP" }]],
  handler: async (agent: any, input: Record<string, any>) => {
    const { token, chain } = schema.parse(input);
    try { return { status: "success", ...(await rugradar(tool, token, chain, agent?.config?.RUGRADAR_API_KEY)) }; }
    catch (e) { return { status: "error", message: (e as Error).message }; }
  },
});
export const rugCheckAction = mk("RUGRADAR_RUG_CHECK", "rug-check", ["rug check", "is this a rug"], "Check a token for high-risk rug-pull patterns.");
export const tokenSafetyAction = mk("RUGRADAR_TOKEN_SAFETY", "token-safety", ["token safety", "memecoin risk"], "Token safety score.");
export const honeypotCheckAction = mk("RUGRADAR_HONEYPOT_CHECK", "honeypot-check", ["honeypot check", "can i sell"], "Honeypot / can't-sell check.");
export const RugRadarPlugin = { name: "rugradar", methods: {}, actions: [rugCheckAction, tokenSafetyAction, honeypotCheckAction], initialize() {} };
export default RugRadarPlugin;
