#!/usr/bin/env node
/**
 * One-shot x402 buyer: pays GET /report with Exact EVM (EIP-3009 USDC) on Base.
 * Reads private key from .buyer.json — never prints secrets.
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";
import { createPublicClient, http, formatUnits } from "viem";
import { base } from "viem/chains";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const buyer = JSON.parse(readFileSync(resolve(ROOT, ".buyer.json"), "utf8"));
const pk = buyer.privateKey;
if (!pk || typeof pk !== "string") {
  console.error("ERROR: .buyer.json missing privateKey");
  process.exit(1);
}
const account = privateKeyToAccount(pk.startsWith("0x") ? pk : `0x${pk}`);
console.log("buyerAddress", account.address);

const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const erc20Abi = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
];

const publicClient = createPublicClient({
  chain: base,
  transport: http("https://mainnet.base.org"),
});

async function usdcBalance(addr) {
  const bal = await publicClient.readContract({
    address: USDC,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [addr],
  });
  return { raw: bal.toString(), formatted: formatUnits(bal, 6) };
}

const PAY_TO = "0x079471E6F43b6feeF80895E19cBFcBB496904852";
const URL = process.env.BUY_URL || "http://127.0.0.1:8402/report?q=northline-proof";

const beforeBuyer = await usdcBalance(account.address);
const beforePayTo = await usdcBalance(PAY_TO);
console.log("beforeBuyerUsdc", beforeBuyer.formatted);
console.log("beforePayToUsdc", beforePayTo.formatted);

const client = new x402Client();
client.register("eip155:*", new ExactEvmScheme(account));
const fetchWithPayment = wrapFetchWithPayment(fetch, client);

let response;
try {
  response = await fetchWithPayment(URL, { method: "GET" });
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  const redacted = msg.replace(/0x[a-fA-F0-9]{64}/g, "0x[REDACTED]");
  console.error("PAYMENT_FAILED", redacted);
  process.exit(2);
}

const status = response.status;
const paymentResponse =
  response.headers.get("PAYMENT-RESPONSE") ||
  response.headers.get("payment-response") ||
  response.headers.get("X-PAYMENT-RESPONSE") ||
  null;

const bodyText = await response.text();
let bodyJson = null;
try {
  bodyJson = JSON.parse(bodyText);
} catch {
  bodyJson = null;
}

console.log("httpStatus", status);
if (bodyJson) {
  console.log(
    "reportSummary",
    JSON.stringify({
      query: bodyJson.query,
      summary: bodyJson.summary,
      note: bodyJson.note,
      generatedAt: bodyJson.generatedAt,
      bulletsCount: Array.isArray(bodyJson.bullets) ? bodyJson.bullets.length : 0,
    }),
  );
} else {
  console.log("reportBody", bodyText.slice(0, 500));
}

function extractTxHash(headerVal) {
  if (!headerVal) return null;
  try {
    const decoded = Buffer.from(headerVal, "base64").toString("utf8");
    const j = JSON.parse(decoded);
    return (
      j.transaction ||
      j.txHash ||
      j.hash ||
      j.settlementTransaction ||
      j?.payload?.transaction ||
      null
    );
  } catch {
    /* not b64 json */
  }
  try {
    const j = JSON.parse(headerVal);
    return j.transaction || j.txHash || j.hash || null;
  } catch {
    /* not json */
  }
  const m = String(headerVal).match(/0x[a-fA-F0-9]{64}/);
  return m ? m[0] : null;
}

let txHash = extractTxHash(paymentResponse);
console.log("paymentResponseHeaderPresent", Boolean(paymentResponse));
if (paymentResponse) {
  try {
    const decoded = Buffer.from(paymentResponse, "base64").toString("utf8");
    console.log("paymentResponseDecoded", decoded.slice(0, 800));
  } catch {
    console.log("paymentResponseRawPrefix", String(paymentResponse).slice(0, 200));
  }
}

if (!txHash) {
  try {
    const lines = readFileSync(resolve(ROOT, "payments.jsonl"), "utf8")
      .trim()
      .split("\n")
      .filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      const row = JSON.parse(lines[i]);
      const cand =
        row.transaction || row.txHash || row.paymentHash || row.hash || null;
      if (cand) {
        txHash = cand;
        console.log(
          "txFromPaymentsJsonl",
          JSON.stringify({ type: row.type, at: row.at, network: row.network }),
        );
        break;
      }
    }
  } catch (e) {
    console.log("paymentsJsonlNote", e instanceof Error ? e.message : String(e));
  }
}

console.log("txHash", txHash);

const afterBuyer = await usdcBalance(account.address);
const afterPayTo = await usdcBalance(PAY_TO);
console.log("afterBuyerUsdc", afterBuyer.formatted);
console.log("afterPayToUsdc", afterPayTo.formatted);

if (status < 200 || status >= 300) {
  process.exit(3);
}
