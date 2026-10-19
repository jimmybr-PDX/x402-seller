/**
 * Free launch-feed mode (permanent default). While on, the paper bots' live launch feed uses only free sources
 * (PumpPortal websocket + public Solana websockets); the Helius websocket is used only as a fallback while those
 * free feeds have dropped. This keeps Helius credits low for other work.
 * PAPER_FREE_FEED=1 forces it on, =0 forces it off.
 * Optional PAPER_FREE_FEED_UNTIL (ISO timestamp): when PAPER_FREE_FEED is unset, free-feed stays on only until that time.
 * With neither set, free-feed is on indefinitely.
 */
export function freeFeedUntil(): string | null {
  return process.env.PAPER_FREE_FEED_UNTIL ?? null;
}
export function freeFeedOn(now = Date.now()) {
  const f = process.env.PAPER_FREE_FEED; if (f === "1") return true; if (f === "0") return false;
  const until = freeFeedUntil();
  if (until) return now < Date.parse(until);
  return true;
}
export const freeFeedStatus = () => ({
  on: freeFeedOn(),
  until: process.env.PAPER_FREE_FEED === "1" ? "forced on" : process.env.PAPER_FREE_FEED === "0" ? "forced off" : freeFeedUntil() ?? "permanent",
  heliusUse: "fallback only, while PumpPortal and the public chain feed have both been silent 2+ min",
});
