/**
 * Oct 18: free launch-feed mode. While on, the paper bots' live launch feed uses only free sources (PumpPortal websocket +
 * public Solana websockets); the Helius websocket is used only as a fallback while those free feeds have dropped.
 * This frees ~20k Helius credits/day for a backfill. Default: on until PAPER_FREE_FEED_UNTIL (5 days from Oct 18).
 * PAPER_FREE_FEED=1 forces it on, =0 forces it off.
 */
export const FREE_FEED_UNTIL = process.env.PAPER_FREE_FEED_UNTIL ?? "2026-10-23T23:00:00Z";
export function freeFeedOn(now = Date.now()) {
  const f = process.env.PAPER_FREE_FEED; if (f === "1") return true; if (f === "0") return false;
  return now < Date.parse(FREE_FEED_UNTIL);
}
export const freeFeedStatus = () => ({ on: freeFeedOn(), until: process.env.PAPER_FREE_FEED === "1" ? "forced on" : process.env.PAPER_FREE_FEED === "0" ? "forced off" : FREE_FEED_UNTIL, heliusUse: "fallback only, while PumpPortal and the public chain feed have both been silent 2+ min" });
