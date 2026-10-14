import { z } from "zod";
import { PluginBase, Tool, createToolParameters } from "@goat-sdk/core";
import { rugradar, DISCLAIMER } from "./client.js";
export class TokenParams extends createToolParameters(z.object({ token: z.string().describe("Token mint or 0x address"), chain: z.enum(["solana", "base", "bsc", "ethereum", "arbitrum"]).default("solana") })) {}
export class RugRadarService {
  constructor(private apiKey?: string) {}
  @Tool({ name: "rugradar_rug_check", description: "Check a token for high-risk rug-pull patterns. " + DISCLAIMER })
  async rugCheck(p: TokenParams) { return rugradar("rug-check", p.token, p.chain, this.apiKey); }
  @Tool({ name: "rugradar_token_safety", description: "Token safety score for a memecoin or ERC-20. " + DISCLAIMER })
  async tokenSafety(p: TokenParams) { return rugradar("token-safety", p.token, p.chain, this.apiKey); }
  @Tool({ name: "rugradar_honeypot_check", description: "Check whether a token shows honeypot / can't-sell patterns. " + DISCLAIMER })
  async honeypotCheck(p: TokenParams) { return rugradar("honeypot-check", p.token, p.chain, this.apiKey); }
}
export class RugRadarPlugin extends PluginBase {
  constructor(opts: { apiKey?: string } = {}) { super("rugradar", [new RugRadarService(opts.apiKey)]); }
  supportsChain = () => true; // pure HTTP data plugin, works with any wallet/chain
}
export const rugradarPlugin = (opts: { apiKey?: string } = {}) => new RugRadarPlugin(opts);
