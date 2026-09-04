
import { createPublicClient, http, formatUnits, decodeEventLog, parseAbiItem } from "viem";
import { base } from "viem/chains";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const abi = [{ type:"function", name:"balanceOf", stateMutability:"view", inputs:[{name:"a",type:"address"}], outputs:[{type:"uint256"}] }];
const c = createPublicClient({ chain: base, transport: http("https://base.llamarpc.com") });
const buyer="0x4862dac2c03fAA8B36A23D176932945193B04940";
const payTo="0x079471E6F43b6feeF80895E19cBFcBB496904852";
const hash="0xcc78452e28f838b779d241ee793007493278343e57b0fba6f9f8cab101bb1149";
const [b,p,receipt,tx] = await Promise.all([
  c.readContract({ address: USDC, abi, functionName:"balanceOf", args:[buyer] }),
  c.readContract({ address: USDC, abi, functionName:"balanceOf", args:[payTo] }),
  c.getTransactionReceipt({ hash }).catch(e=>({error:String(e.message||e)})),
  c.getTransaction({ hash }).catch(e=>({error:String(e.message||e)})),
]);
console.log("buyerUsdc", formatUnits(b,6));
console.log("payToUsdc", formatUnits(p,6));
if (receipt && receipt.status) {
  console.log("receiptStatus", receipt.status);
  console.log("blockNumber", Number(receipt.blockNumber));
  console.log("logCount", receipt.logs?.length);
  // try decode Transfer logs
  for (const log of receipt.logs || []) {
    if (log.address.toLowerCase() !== USDC.toLowerCase()) continue;
    try {
      const decoded = decodeEventLog({
        abi: [parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)")],
        data: log.data,
        topics: log.topics,
      });
      console.log("transfer", decoded.args.from, "->", decoded.args.to, formatUnits(decoded.args.value, 6));
    } catch {}
  }
} else {
  console.log("receipt", JSON.stringify(receipt));
}
if (tx && tx.hash) console.log("txTo", tx.to, "txFrom", tx.from);
else console.log("tx", JSON.stringify(tx));
