/**
 * RugRadar tension line: one short, token-specific danger line that leads a result.
 * Locked spec (Nov 24 2026): max 140 chars, real numbers only, danger-only, no line when nothing is flagged,
 * fact-first openers, no disclaimers, no mocking buyers. Deterministic template bank, no LLM.
 */

export type DangerType =
  | "change"
  | "honeypot"
  | "mint_freeze"
  | "heavy_selling"
  | "thin_liquidity"
  | "price_drop"
  | "lp_unlocked"
  | "creator_history"
  | "holders"
  | "very_new"
  | "none";

export type PriorSnap = {
  t?: string | null;
  codes?: string[] | null;
  score?: number | null;
  sells24h?: number | null;
  buys24h?: number | null;
  volume24hUsd?: number | null;
  liquidityUsd?: number | null;
  top1Pct?: number | null;
  top10Pct?: number | null;
  holderCount?: number | null;
  creatorEarlierHoneypots?: number | null;
};

export type SlimFacts = {
  chain: string;
  token: string;
  label: string;
  symbol: string | null;
  score: number;
  level: string;
  codes: string[];
  volume24hUsd: number | null;
  buys24h: number | null;
  sells24h: number | null;
  priceChange1hPct: number | null;
  priceChange24hPct: number | null;
  liquidityUsd: number | null;
  marketCapUsd: number | null;
  liquidityToMcapPct: number | null;
  sellPriceImpactPct: number | null;
  sellTestUsd: number | null;
  canSell: string | null;
  sellRoute: unknown;
  sellableOnPumpCurve: boolean | null;
  lpLockedOrBurnedPct: number | null;
  creatorEarlierHoneypots: number | null;
  priorLaunches: number | null;
  priorDead: number | null;
  creatorFlagged: boolean;
  mintAuthority: boolean;
  freezeAuthority: boolean;
  mintable: boolean | null;
  hiddenOwner: boolean | null;
  canTakeBackOwnership: boolean | null;
  transferPausable: boolean | null;
  blacklist: boolean | null;
  taxModifiable: boolean | null;
  permanentDelegate: boolean;
  pausable: boolean;
  transferHook: boolean;
  top1Pct: number | null;
  top10Pct: number | null;
  ageHours: number | null;
  buyTaxPct: number | null;
  sellTaxPct: number | null;
  transferFeePct: number | null;
  holderCount: number | null;
  honeypot: boolean | null;
  cannotSellAll: boolean | null;
  owner: string | null;
  pairs: number | null;
  devHoldingPct?: number | null;
  previousCodes?: string[] | null;
  previous?: PriorSnap | null;
};

export type DangerFact = {
  type: DangerType;
  rank: number;
  clause: string;
  strong: boolean;
  fact: string;
};

export type TensionResult = {
  line: string;
  type: DangerType;
  fact: string;
  setup: string | null;
  clause: string;
  second?: string | null;
  kicker: string | null;
  chars: number;
  estimated: string[];
  ruleFlags: string[];
  historyNew: string[];
  changeLead: boolean;
};

const WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
const HEAVY_RATIO = 1.5;
const HEAVY_MIN_SELLS = 20;
const HEAVY_MIN_VOL = 1000;
const THIN_VOL_MCAP = 0.001;
const THIN_VOL_ABS = 5000;
const LIQ_MCAP_PCT = 2;
const LIQ_MCAP_MIN = 50_000;
const LIQ_MCAP_MAX = 50_000_000;
const THIN_LIQ_USD = 5000;
const DROP_24H = -25;
const DROP_1H = -10;
const IMPACT_100_WARN = 20;
const IMPACT_1K_WARN = 15;
const SEVERE_DROP_24H = -50;
const SEVERE_DROP_1H = -50;
const SOFT_AIM = 120;
const HARD_MAX = 140;

export function fmtUsd(n: number): string {
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  const v = abs;
  if (v >= 1e9) return `${sign}$${v >= 10e9 ? (v / 1e9).toFixed(0) : (v / 1e9).toFixed(1).replace(/\.0$/, "")}B`;
  if (v >= 1e6) return `${sign}$${v >= 10e6 ? (v / 1e6).toFixed(0) : (v / 1e6).toFixed(1).replace(/\.0$/, "")}M`;
  if (v >= 10_000) return `${sign}$${(v / 1000).toFixed(v >= 100_000 ? 0 : 1).replace(/\.0$/, "")}k`;
  if (v >= 100) return `${sign}$${Math.round(v).toLocaleString("en-US")}`;
  if (v >= 10) return `${sign}$${Math.round(v)}`;
  return `${sign}$${v.toFixed(2)}`;
}

export function fmtPct(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 10) return `${Math.round(n)}%`;
  if (abs >= 1) return `${n.toFixed(1).replace(/\.0$/, "")}%`;
  if (abs === 0) return "0%";
  return `${n.toFixed(1)}%`;
}

export function fmtInt(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

export function fmtCount(n: number): string {
  const i = Math.round(n);
  return i >= 0 && i <= 10 ? WORDS[i] : String(i);
}

export function fmtRatio(sells: number, buys: number): string {
  if (!(buys > 0)) return "all sells";
  const r = sells / buys;
  const rounded = Math.abs(r - Math.round(r)) < 0.08 ? Math.round(r) : Math.round(r * 10) / 10;
  return `${rounded}-to-1`;
}

export function fmtAge(hours: number): string {
  if (hours < 1) {
    const m = Math.max(1, Math.round(hours * 60));
    return m === 1 ? "1 minute old" : `${m} minutes old`;
  }
  if (hours < 24) {
    const rounded = Math.abs(hours - Math.round(hours)) < 0.05 ? Math.round(hours) : Math.round(hours * 10) / 10;
    if (rounded === 1) return "1 hour old";
    return `${rounded} hours old`;
  }
  const days = hours / 24;
  if (days < 14) {
    const d = Math.abs(days - Math.round(days)) < 0.05 ? Math.round(days) : Math.round(days * 10) / 10;
    return d === 1 ? "1 day old" : `${d} days old`;
  }
  if (days < 60) return `${Math.round(days)} days old`;
  const years = days / 365;
  if (years < 1.6) return `${Math.round(days / 30)} months old`;
  return `${years.toFixed(1).replace(/\.0$/, "")} years old`;
}

/** Constant-product estimate: quote reserve ≈ liquidity/2, impact = sell/(reserve+sell). */
export function estimateSellImpactPct(sellUsd: number, liquidityUsd: number): number | null {
  if (!(liquidityUsd > 0) || !(sellUsd > 0)) return null;
  return (100 * sellUsd) / (liquidityUsd / 2 + sellUsd);
}

export function tokenHash(mint: string): number {
  let h = 2166136261;
  const s = mint.toLowerCase();
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const KICKERS: Record<Exclude<DangerType, "none" | "change">, string[]> = {
  honeypot: [
    "The door only swings in.",
    "Exit's painted on.",
    "Selling is a rumor here.",
    "That's the trap.",
    "The sell button is decoration.",
  ],
  mint_freeze: [
    "The printer is still plugged in.",
    "Someone still holds the keys.",
    "The admin switch is live.",
    "They can change the rules mid-trade.",
    "Supply can grow without asking.",
  ],
  creator_history: [
    "Same wallet, new costume.",
    "The track record is the warning.",
    "Previous tickers didn't end well.",
    "The creator has done this before.",
    "Same hands, new ticker.",
  ],
  holders: [
    "One address, one decision.",
    "The price is one click away from changing.",
    "The top holder sets the next move.",
    "Everyone else is along for the ride.",
    "One dump sets the price.",
  ],
  lp_unlocked: [
    "LP is free to move. The pool can shrink without notice.",
    "Nothing locked. Liquidity can leave on the next block.",
    "Unlocked. The depth you see is still optional.",
    "No timer on the LP. It can be pulled whenever.",
  ],
  heavy_selling: [
    "Buys are tourists. Sells are locals.",
    "The exit line is longer than the entry line.",
    "More people leaving than arriving.",
    "Sellers showed up. Buyers didn't.",
    "The exit is already crowded.",
    "That's a slow bleed.",
  ],
  thin_liquidity: [
    "A normal sell looks like a crash here.",
    "The pool flinches at a few hundred dollars.",
    "Small money moves this one.",
    "Size matters more than it should.",
    "The pool is a puddle.",
    "The order book is a suggestion.",
  ],
  price_drop: [
    "The floor just moved.",
    "That's a sharp cut.",
    "Sellers already voted.",
    "Price fell faster than the bids could.",
    "The drop already happened. The volume didn't.",
    "Down hard with almost no one trading.",
    "It's lower and still quiet.",
  ],
  very_new: [
    "Under an hour old. Most supply is still in the first wallets.",
    "Barely launched. The chart is still the deployer.",
    "Less than 60 minutes. Almost no one has had time to exit.",
    "Fresh. Volume is still the launch wallets.",
  ],
};

const TWO_DANGER_CLOSERS = {
  creator_holders: "Same hands, concentrated.",
  lp_holders: "Either one can move this.",
  generic: "Both point the same way.",
};

function n(v: unknown): number | null {
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
}

export function priorOf(f: SlimFacts): PriorSnap | null {
  if (f.previous) return f.previous;
  if (f.previousCodes) return { codes: f.previousCodes };
  return null;
}

export function sellBuyRatio(f: { sells24h?: number | null; buys24h?: number | null }): number | null {
  if (f.sells24h == null || f.buys24h == null) return null;
  if (f.buys24h > 0) return f.sells24h / f.buys24h;
  if (f.sells24h > 0) return Infinity;
  return null;
}

export function heavySelling(f: SlimFacts): boolean {
  const r = sellBuyRatio(f);
  if (r == null) return false;
  return r >= HEAVY_RATIO && (f.sells24h ?? 0) >= HEAVY_MIN_SELLS && (f.volume24hUsd ?? 0) >= HEAVY_MIN_VOL;
}

export function thinTrading(f: SlimFacts): boolean {
  const vol = f.volume24hUsd;
  if (vol == null) return false;
  const mcap = f.marketCapUsd;
  if (mcap != null && mcap >= LIQ_MCAP_MIN) return vol < mcap * THIN_VOL_MCAP;
  return vol < THIN_VOL_ABS;
}

export function isLowVolume(f: SlimFacts): boolean {
  if (thinTrading(f)) return true;
  const vol = f.volume24hUsd;
  if (vol == null) return true;
  return vol < THIN_VOL_ABS;
}

export function buysAreHealthy(f: SlimFacts): boolean {
  const buys = f.buys24h ?? 0;
  const r = sellBuyRatio(f);
  if (buys < 20) return false;
  if (r == null) return buys >= 20;
  return r < 3;
}

export function cantSell(f: SlimFacts): boolean {
  if (f.honeypot === true || f.cannotSellAll === true) return true;
  if (f.codes.includes("honeypot") || f.codes.includes("sell_route")) return true;
  if (f.sellRoute === false) return true;
  const cs = (f.canSell || "").toLowerCase();
  if (cs.startsWith("no") || cs === "no route found") return true;
  const tax = Math.max(f.buyTaxPct ?? 0, f.sellTaxPct ?? 0, f.transferFeePct ?? 0);
  if (tax >= 50) return true;
  return false;
}

export function deadOrNoPool(f: SlimFacts): boolean {
  if (f.codes.includes("dead_token")) return true;
  const liq = f.liquidityUsd;
  const age = f.ageHours;
  if (liq != null && liq >= 100) return false;
  if (f.sellableOnPumpCurve === true) return false;
  if (cantSell(f) && (liq == null || liq < 100)) return true;
  return (liq == null || liq < 100) && age != null && age >= 24 * 7;
}

export function concentrated(f: SlimFacts): boolean {
  if (f.codes.includes("holders")) return true;
  if (f.holderCount != null && f.holderCount <= 2) return true;
  if (f.top1Pct != null && f.top1Pct > 30) return true;
  if (f.top10Pct != null && f.top10Pct > 40) return true;
  return false;
}

export function creatorHistoryHit(f: SlimFacts): boolean {
  return (f.creatorEarlierHoneypots ?? 0) > 0 || f.codes.includes("deployer_history") || f.codes.includes("known_pattern");
}

export function isEstablished(f: SlimFacts): boolean {
  const age = f.ageHours;
  const holders = f.holderCount ?? 0;
  const liq = f.liquidityUsd ?? 0;
  const mcap = f.marketCapUsd ?? 0;
  return (age != null && age >= 90 * 24) && (holders >= 100_000 || liq >= 1e6 || mcap >= 50_000_000);
}

export function lpUnlockTrusted(f: SlimFacts): boolean {
  return f.chain !== "solana" || f.codes.includes("lp_unlocked");
}

export function lpUnlockedStrong(f: SlimFacts): boolean {
  if (!lpUnlockTrusted(f)) return false;
  if (f.lpLockedOrBurnedPct == null || f.lpLockedOrBurnedPct >= 50) return false;
  if (isEstablished(f)) return false;
  return true;
}

export function underOneHour(f: SlimFacts): boolean {
  return f.ageHours != null && f.ageHours < 1;
}

export function firstWalletsHoldMost(f: SlimFacts): boolean {
  if (f.holderCount != null && f.holderCount <= 20) return true;
  if (f.top10Pct != null && f.top10Pct >= 40) return true;
  if (f.top1Pct != null && f.top1Pct >= 25) return true;
  return false;
}

export function launchWalletsInVolume(f: SlimFacts): boolean {
  return f.codes.includes("snipers") || f.codes.includes("bundled") || (f.holderCount != null && f.holderCount <= 30 && (f.volume24hUsd ?? 0) > 0);
}

export function severeDrop(f: SlimFacts): string | null {
  if (f.priceChange24hPct != null && f.priceChange24hPct <= SEVERE_DROP_24H) return "severe price drop (24h)";
  if ((f.ageHours ?? 0) >= 24 && f.priceChange1hPct != null && f.priceChange1hPct <= SEVERE_DROP_1H) return "severe price drop (1h)";
  return null;
}

export function thinLiquidity(f: SlimFacts): boolean {
  if (deadOrNoPool(f)) return true;
  if (f.sellableOnPumpCurve === true && (f.liquidityUsd == null || f.liquidityUsd < 100)) return true;
  const liq = f.liquidityUsd;
  if (liq != null && liq < THIN_LIQ_USD) return true;
  const pct = f.liquidityToMcapPct;
  const mcap = f.marketCapUsd;
  if (pct != null && mcap != null && mcap >= LIQ_MCAP_MIN && mcap <= LIQ_MCAP_MAX && pct < LIQ_MCAP_PCT) return true;
  if (f.sellPriceImpactPct != null && f.sellPriceImpactPct > IMPACT_100_WARN) return true;
  const est = liq != null ? estimateSellImpactPct(1000, liq) : null;
  if (est != null && est >= IMPACT_1K_WARN) return true;
  return false;
}

export function hoursSince(prevT: string | null | undefined, now = Date.now()): number | null {
  if (!prevT) return null;
  const t = Date.parse(prevT);
  if (!Number.isFinite(t)) return null;
  return (now - t) / 3_600_000;
}

/** overnight ≈ 8–20h, yesterday ≈ 20–36h; otherwise "since last check". */
export function gapWord(prevT: string | null | undefined, now = Date.now()): "overnight" | "yesterday" | "since last check" {
  const h = hoursSince(prevT, now);
  if (h == null) return "since last check";
  if (h >= 8 && h < 20) return "overnight";
  if (h >= 20 && h <= 36) return "yesterday";
  return "since last check";
}

export function liquidityDropPct(f: SlimFacts): number | null {
  const prev = priorOf(f)?.liquidityUsd;
  const now = f.liquidityUsd;
  if (prev == null || !(prev > 0) || now == null) return null;
  const pct = ((prev - now) / prev) * 100;
  return pct >= 20 ? pct : null;
}

// ---------- clauses ----------

export function creatorClause(f: SlimFacts): string | null {
  if (!creatorHistoryHit(f)) return null;
  const hp = f.creatorEarlierHoneypots;
  if (hp != null && hp > 0) return `Creator has ${fmtCount(hp)} earlier honeypot${hp === 1 ? "" : "s"}`;
  if ((f.priorDead ?? 0) >= 1 && (f.priorLaunches ?? 0) > 0) {
    const dead = f.priorDead!;
    const launches = f.priorLaunches!;
    if (dead >= 20) return `Creator's last ${fmtInt(dead)} tokens have no liquidity`;
    return `Creator's last ${fmtInt(launches)} tokens: ${fmtInt(dead)} already ${dead === 1 ? "has" : "have"} no liquidity`;
  }
  return "The creator has earlier high-risk launches";
}

export function holderClause(f: SlimFacts): string | null {
  if (!concentrated(f)) return null;
  if (f.holderCount != null && f.holderCount <= 2) {
    return f.holderCount === 1 ? "One wallet holds the supply" : "Two wallets hold the supply";
  }
  if (f.top1Pct != null && f.top1Pct > 30 && (f.top10Pct == null || Math.abs((f.top1Pct * 3) - f.top10Pct) >= 3)) {
    return `One wallet holds ${fmtPct(f.top1Pct)}`;
  }
  if (f.top10Pct != null) return `Top holders own ${fmtPct(f.top10Pct)} of supply`;
  if (f.top1Pct != null) return `One wallet holds ${fmtPct(f.top1Pct)}`;
  return "Top holders own a concentrated share of supply";
}

export function impactClause(f: SlimFacts, estimated: string[]): string | null {
  const liq = f.liquidityUsd;
  if (f.sellableOnPumpCurve === true && (liq == null || liq < 100)) {
    return "No DEX pool; the only exit is a pump fun curve";
  }
  if (deadOrNoPool(f) || (liq != null && liq < 100 && f.sellableOnPumpCurve !== true)) {
    return "There's no pool left to sell into";
  }
  if (f.sellPriceImpactPct != null && f.sellPriceImpactPct > IMPACT_100_WARN) {
    const usd = f.sellTestUsd ?? 100;
    return `A $${usd} sale moves the price ${fmtPct(f.sellPriceImpactPct)}`;
  }
  const est = liq != null ? estimateSellImpactPct(1000, liq) : null;
  if (est != null && est >= IMPACT_1K_WARN) {
    estimated.push(`$1k sell impact ${fmtPct(est)} estimated from constant-product using liquidity ${liq != null ? fmtUsd(liq) : "?"}`);
    return `A $1k sell moves the price about ${fmtPct(est)}`;
  }
  if (liq != null && liq < THIN_LIQ_USD) return `Liquidity is only ${fmtUsd(liq)}`;
  if (f.liquidityToMcapPct != null && f.marketCapUsd != null && f.liquidityToMcapPct < LIQ_MCAP_PCT) {
    return `Liquidity is ${fmtPct(f.liquidityToMcapPct)} of market cap`;
  }
  if (thinTrading(f) && f.volume24hUsd != null) {
    const cap = f.marketCapUsd != null ? ` on a ${fmtUsd(f.marketCapUsd)} cap` : "";
    return `24h volume is only ${fmtUsd(f.volume24hUsd)}${cap}`;
  }
  return null;
}

export function honeypotClause(f: SlimFacts): string | null {
  if (f.honeypot === true || f.codes.includes("honeypot")) {
    const extra = f.holderCount != null && f.holderCount > 0 ? `. ${fmtInt(f.holderCount)} holders are still in` : "";
    return `Selling looks blocked${extra}`;
  }
  if (f.cannotSellAll === true) return "Holders can't sell their full bag";
  const tax = Math.max(f.buyTaxPct ?? 0, f.sellTaxPct ?? 0, f.transferFeePct ?? 0);
  if (tax >= 50) return `Sell tax is ${fmtPct(tax)}`;
  if (deadOrNoPool(f) || (cantSell(f) && (f.liquidityUsd == null || f.liquidityUsd < 100) && f.sellableOnPumpCurve !== true)) {
    const extra = f.liquidityUsd != null && f.liquidityUsd > 0 ? `, and liquidity is only ${fmtUsd(f.liquidityUsd)}` : "";
    return `There's no pool left to sell into${extra}`;
  }
  if (cantSell(f) && f.liquidityUsd != null && f.liquidityUsd > 0) {
    return `No way to sell this token was found, and liquidity is only ${fmtUsd(f.liquidityUsd)}`;
  }
  if (cantSell(f)) return "No way to sell this token was found";
  return null;
}

export function mintFreezeClause(f: SlimFacts): string | null {
  if (f.permanentDelegate || f.codes.includes("permanent_delegate")) return "A permanent delegate can move anyone's tokens";
  if (f.mintAuthority || f.mintable === true || f.codes.includes("mint_authority") || f.codes.includes("mint_function")) return "Mint authority is still live";
  if (f.freezeAuthority || f.codes.includes("freeze_authority")) return "Freeze authority is still live";
  if (f.pausable || f.transferPausable === true) return "Transfers can be paused";
  if (f.transferHook || f.codes.includes("transfer_control")) return "Transfers can be blocked or hooked";
  if (f.hiddenOwner === true || f.canTakeBackOwnership === true) return "Ownership can be hidden or taken back";
  if (f.blacklist === true) return "Wallets can be blacklisted";
  if (f.taxModifiable === true) return "Tax can still be changed";
  return null;
}

export function dropClause(f: SlimFacts): string | null {
  if (f.priceChange24hPct != null && f.priceChange24hPct <= SEVERE_DROP_24H) {
    return `Down ${fmtPct(Math.abs(f.priceChange24hPct))} in 24 hours`;
  }
  if ((f.ageHours ?? 0) >= 24 && f.priceChange1hPct != null && f.priceChange1hPct <= SEVERE_DROP_1H) {
    return `Down ${fmtPct(Math.abs(f.priceChange1hPct))} in the last hour`;
  }
  if (f.priceChange1hPct != null && f.priceChange1hPct <= DROP_1H) {
    return `Down ${fmtPct(Math.abs(f.priceChange1hPct))} in the last hour`;
  }
  if (f.priceChange24hPct != null && f.priceChange24hPct <= DROP_24H) {
    return `Down ${fmtPct(Math.abs(f.priceChange24hPct))} in 24 hours`;
  }
  return null;
}

export function sellingClause(f: SlimFacts): string | null {
  if (!heavySelling(f) || f.sells24h == null || f.buys24h == null) return null;
  const ratio = fmtRatio(f.sells24h, f.buys24h);
  return ratio === "all sells" ? `Sellers ${f.sells24h}, buyers 0` : `Sellers ${ratio} all day`;
}

export function ageClause(f: SlimFacts): string | null {
  if (!underOneHour(f) || f.ageHours == null) return null;
  return `The token is ${fmtAge(f.ageHours)}`;
}

export function lpClause(f: SlimFacts): string | null {
  if (!lpUnlockedStrong(f) || f.lpLockedOrBurnedPct == null) return null;
  return `LP unlocked (${fmtPct(f.lpLockedOrBurnedPct)} locked)`;
}

// ---------- change (repeat user) ----------

export function changeFacts(f: SlimFacts, now = Date.now()): DangerFact[] {
  const prev = priorOf(f);
  if (!prev) return [];
  const when = gapWord(prev.t, now);
  const out: DangerFact[] = [];
  const prevCodes = prev.codes ?? f.previousCodes ?? [];
  const newCodes = f.codes.filter((c) => !prevCodes.includes(c));

  const prevRatio = sellBuyRatio({ sells24h: prev.sells24h, buys24h: prev.buys24h });
  const nowRatio = sellBuyRatio(f);
  const prevBuysAhead = prev.buys24h != null && prev.sells24h != null && prev.buys24h > prev.sells24h;
  if (heavySelling(f) && f.sells24h != null && f.buys24h != null && (prevRatio == null || prevRatio < HEAVY_RATIO || prevBuysAhead)) {
    const r = fmtRatio(f.sells24h, f.buys24h);
    if (prevBuysAhead) {
      const appeared = when === "overnight" ? "Sell pressure appeared overnight" : "Sell pressure appeared since last check";
      out.push({ type: "change", rank: 0, strong: true, fact: "sell-pressure appeared", clause: `${appeared}. Buys were ahead last time` });
    } else if (r !== "all sells") {
      const crowded = when === "overnight" ? "Exit got crowded overnight" : "Exit got crowded since last check";
      out.push({ type: "change", rank: 0, strong: true, fact: "sell-pressure flip", clause: `Sellers flipped to ${r} since last check. ${crowded}` });
    }
  }

  const drop = liquidityDropPct(f);
  if (drop != null) {
    out.push({ type: "change", rank: 0, strong: true, fact: "liquidity drop since last check", clause: `Liquidity down ${fmtPct(drop)} since your last look. Pool got thinner` });
  }

  const holderNew = newCodes.includes("holders") || (
    concentrated(f) &&
    prev.top1Pct != null && prev.top1Pct <= 30 &&
    f.top1Pct != null && f.top1Pct > 30
  );
  if (holderNew && (f.top1Pct != null || f.holderCount === 1)) {
    const p = f.holderCount === 1 ? 100 : f.top1Pct!;
    const was = when === "yesterday" ? "Wasn't there yesterday" : "Wasn't there last check";
    out.push({ type: "change", rank: 0, strong: true, fact: "new concentration", clause: `New: one wallet now holds ${fmtPct(p)}. ${was}` });
  }

  if (newCodes.includes("deployer_history") || newCodes.includes("known_pattern")) {
    const nHp = f.creatorEarlierHoneypots;
    const tail = nHp != null && nHp > 0 ? `${fmtCount(nHp).replace(/^./, (c) => c.toUpperCase())} earlier honeypot${nHp === 1 ? "" : "s"} now attached` : "Earlier high-risk launches now attached";
    // fmtCount("three") — capitalize: Three earlier...
    const attached = nHp != null && nHp > 0
      ? `${fmtCount(nHp).charAt(0).toUpperCase()}${fmtCount(nHp).slice(1)} earlier honeypot${nHp === 1 ? "" : "s"} now attached`
      : "Earlier high-risk launches now attached";
    out.push({ type: "change", rank: 0, strong: true, fact: "creator history flag just turned on", clause: `Creator history flag just turned on. ${attached}` });
    void tail;
  }

  return out;
}

// ---------- collect + rank ----------

const RANK = {
  change: 0,
  honeypot: 1,
  mint_freeze: 2,
  // sell-pressure / liquidity drop (newest/most actionable among market facts)
  heavy_selling: 3,
  thin_liquidity: 3,
  price_drop: 3,
  lp_unlocked: 3,
  creator_history: 4,
  holders: 5,
  very_new: 6,
} as const;

export function collectDangers(f: SlimFacts, estimated: string[], now = Date.now()): DangerFact[] {
  const out: DangerFact[] = [];
  out.push(...changeFacts(f, now));

  const hp = honeypotClause(f);
  if (hp && (cantSell(f) || deadOrNoPool(f))) {
    out.push({ type: "honeypot", rank: RANK.honeypot, clause: hp, strong: true, fact: "honeypot / can't sell" });
  }
  const mf = mintFreezeClause(f);
  if (mf) out.push({ type: "mint_freeze", rank: RANK.mint_freeze, clause: mf, strong: true, fact: "mint/freeze or admin controls still live" });

  const sell = sellingClause(f);
  if (sell) out.push({ type: "heavy_selling", rank: RANK.heavy_selling, clause: sell, strong: true, fact: "heavy selling" });

  if (severeDrop(f)) {
    const d = dropClause(f);
    if (d) out.push({ type: "price_drop", rank: RANK.price_drop, clause: d, strong: true, fact: severeDrop(f)! });
  } else if (f.priceChange24hPct != null && f.priceChange24hPct <= DROP_24H) {
    const d = dropClause(f);
    if (d) out.push({ type: "price_drop", rank: RANK.price_drop, clause: d, strong: false, fact: "fast price drop (24h)" });
  } else if (f.priceChange1hPct != null && f.priceChange1hPct <= DROP_1H && (f.ageHours ?? 0) >= 24) {
    const d = dropClause(f);
    if (d) out.push({ type: "price_drop", rank: RANK.price_drop, clause: d, strong: false, fact: "fast price drop (1h)" });
  }

  if (thinLiquidity(f)) {
    const c = impactClause(f, estimated);
    if (c) {
      const strong = deadOrNoPool(f) || (f.liquidityUsd != null && f.liquidityUsd < THIN_LIQ_USD) ||
        (estimateSellImpactPct(1000, f.liquidityUsd ?? 0) ?? 0) >= IMPACT_1K_WARN ||
        (f.sellableOnPumpCurve === true && (f.liquidityUsd == null || f.liquidityUsd < 100));
      out.push({ type: "thin_liquidity", rank: RANK.thin_liquidity, clause: c, strong, fact: "thin liquidity / big sell impact" });
    }
  }

  const lp = lpClause(f);
  if (lp) out.push({ type: "lp_unlocked", rank: RANK.lp_unlocked, clause: lp, strong: true, fact: "LP unlocked" });

  const cr = creatorClause(f);
  if (cr) out.push({ type: "creator_history", rank: RANK.creator_history, clause: cr, strong: true, fact: "creator honeypots or earlier-token history" });

  const ho = holderClause(f);
  if (ho) out.push({ type: "holders", rank: RANK.holders, clause: ho, strong: true, fact: "top-holder concentration" });

  const age = ageClause(f);
  if (age) out.push({ type: "very_new", rank: RANK.very_new, clause: age, strong: true, fact: "under 1 hour old" });

  // Dedup similar can't-sell / no-pool clauses
  const seen = new Set<string>();
  const uniq: DangerFact[] = [];
  for (const d of out) {
    if (seen.has(d.clause)) continue;
    seen.add(d.clause);
    uniq.push(d);
  }
  uniq.sort((a, b) => a.rank - b.rank || Number(b.strong) - Number(a.strong));
  return uniq;
}

export function kickerFits(type: DangerType, k: string, f: SlimFacts): boolean {
  if (type === "heavy_selling") {
    if (/Buyers didn't/i.test(k) && buysAreHealthy(f)) return false;
    if (/bids are gone|chart is red/i.test(k) && (buysAreHealthy(f) || !((f.priceChange24hPct ?? 0) <= -5))) return false;
  }
  if (type === "thin_liquidity") {
    if (/few hundred dollars/i.test(k)) {
      const est = f.liquidityUsd != null ? estimateSellImpactPct(500, f.liquidityUsd) : null;
      if (est == null || est < 15) return false;
    }
    if (/looks like a crash/i.test(k)) {
      const est = f.liquidityUsd != null ? estimateSellImpactPct(1000, f.liquidityUsd) : null;
      if (est == null || est < 25) return false;
    }
    if (/sales|big waves/i.test(k) && !(f.volume24hUsd != null && f.volume24hUsd > 0)) return false;
  }
  if (type === "holders") {
    const oneWallet = f.holderCount === 1 || (f.top1Pct != null && f.top1Pct >= 50);
    if (/One address/i.test(k) && !oneWallet) return false;
    if (/few (wallets|hands|pockets)/i.test(k) && f.holderCount != null && f.holderCount <= 2) return false;
  }
  if (type === "price_drop") {
    if (/volume didn't|almost no one trading|still quiet|The move is done/i.test(k) && !isLowVolume(f)) return false;
  }
  if (type === "very_new") {
    if (/first wallets|Most supply/i.test(k) && !firstWalletsHoldMost(f)) return false;
    if (/still the deployer/i.test(k) && !(f.devHoldingPct != null && f.devHoldingPct >= 20)) return false;
    if (/launch wallets/i.test(k) && !launchWalletsInVolume(f)) return false;
  }
  return true;
}

function pickKicker(type: DangerType, mint: string, used: Set<string>, f: SlimFacts): string | null {
  if (type === "none" || type === "change") return null;
  const bank = KICKERS[type];
  if (!bank?.length) return null;
  const start = tokenHash(mint) % bank.length;
  const order = [...bank.slice(start), ...bank.slice(0, start)];
  for (const checkUsed of [true, false]) {
    for (const k of order) {
      if (!kickerFits(type, k, f)) continue;
      if (checkUsed && used.has(k)) continue;
      used.add(k);
      return k;
    }
  }
  return null;
}

function twoDangerCloser(a: DangerFact, b: DangerFact, mint: string, used: Set<string>): string {
  const types = new Set([a.type, b.type]);
  if (types.has("creator_history") && types.has("holders")) return TWO_DANGER_CLOSERS.creator_holders;
  if (types.has("lp_unlocked") && types.has("holders")) return TWO_DANGER_CLOSERS.lp_holders;
  const opts = types.has("holders") || types.has("mint_freeze")
    ? [TWO_DANGER_CLOSERS.generic, TWO_DANGER_CLOSERS.lp_holders]
    : [TWO_DANGER_CLOSERS.generic];
  const start = tokenHash(mint) % opts.length;
  const order = [...opts.slice(start), ...opts.slice(0, start)];
  return order.find((k) => !used.has(k)) ?? order[0];
}

const BANNED_PRAISE = /\b(safe|secure|legit|no risk|clean overall|guaranteed|risk[- ]free)\b/i;
const BANNED_METHOD = /\b(heuristic|goplus|dexscreener|helius|jupiter route|we (check|test|detect)|how we|data sources?|simulation|not financial advice|do your own research|only buy what you can afford)\b/i;
const BANNED_PRIVATE = /\b(named wallet|winning wallet|known-good|creator family|name history|coinfactory|graduation sign|inflow)\b/i;
const BANNED_PROFANITY = /\b(fuck|shit|ass|bitch|damn|crap|bastard)\b/i;
const BANNED_CA = /(^|\W)CA(\W|$)/;
const BANNED_BUYER_MOCK = /\b(thanks for the (exit )?liquidity|enjoy the bag|you are the exit|bagholders?|idiots?|bagheld)\b/i;
const BANNED_OPENER = /\b(clean contract|no rug switches|mint off|freeze off|ownership renounced|taxes zero)\b/i;
const BANNED_SOFTENER = /\bquiet so far\b|\bnothing flagged\b|\bmarket's quiet\b/i;
const BANNED_DISCLAIMER = /\b(nfa|dyor|not financial advice|disclaimer)\b/i;

export function lintLine(line: string, type: DangerType = "none"): string[] {
  const flags: string[] = [];
  if (line.length > HARD_MAX) flags.push(`over 140 chars (${line.length})`);
  if (BANNED_CA.test(line)) flags.push("contains CA");
  if (BANNED_PRAISE.test(line)) flags.push("praise / guarantee wording");
  if (BANNED_METHOD.test(line)) flags.push("detection-method or disclaimer wording");
  if (BANNED_DISCLAIMER.test(line)) flags.push("disclaimer");
  if (BANNED_PRIVATE.test(line)) flags.push("private-signal wording");
  if (BANNED_PROFANITY.test(line)) flags.push("profanity");
  if (BANNED_BUYER_MOCK.test(line)) flags.push("mocks buyers");
  if (BANNED_OPENER.test(line)) flags.push("reassuring opener");
  if (BANNED_SOFTENER.test(line)) flags.push("softener / status line");
  if (type === "none") flags.push("status line on an unflagged token");
  return flags;
}

function stop(s: string): string {
  return /[.,!?]$/.test(s) ? s : `${s}.`;
}

function joinParts(parts: string[]): string {
  return parts.filter(Boolean).map(stop).join(" ").replace(/\.\./g, ".");
}

function trimLine(parts: string[]): { line: string; used: string[] } {
  const tryJoin = (ps: string[]) => joinParts(ps);
  let used = [...parts];
  let line = tryJoin(used);
  if (line.length <= SOFT_AIM) return { line, used };
  // Drop the last part first (kicker or second fact) to aim under 120.
  while (used.length > 1 && tryJoin(used).length > SOFT_AIM) {
    used = used.slice(0, -1);
  }
  line = tryJoin(used);
  if (line.length <= HARD_MAX) return { line, used };
  const cut = line.slice(0, HARD_MAX - 1).replace(/[,;:\s]+$/, "");
  return { line: cut + ".", used };
}


function sameFamily(a: DangerFact, b: DangerFact): boolean {
  if (a.type === "change") {
    if (/sell-pressure/i.test(a.fact) && b.type === "heavy_selling") return true;
    if (/liquidity/i.test(a.fact) && (b.type === "thin_liquidity" || b.type === "lp_unlocked" || b.type === "price_drop")) return true;
    if (/concentration/i.test(a.fact) && b.type === "holders") return true;
    if (/creator/i.test(a.fact) && b.type === "creator_history") return true;
  }
  // Can't-sell and a thin/empty pool are the same exit problem.
  if (a.type === "honeypot" && b.type === "thin_liquidity") return true;
  if (a.type === "thin_liquidity" && b.type === "honeypot") return true;
  return false;
}

export function tensionLine(f: SlimFacts, usedKickers: Set<string> = new Set(), now = Date.now()): TensionResult | null {
  const estimated: string[] = [];
  const dangers = collectDangers(f, estimated, now);
  if (!dangers.length) return null;

  const lead = dangers[0];
  const leadAlreadyCompound = /\.\s+\S/.test(lead.clause);
  const secondCand = leadAlreadyCompound ? null : (dangers.slice(1).find((d) => d.strong && d.type !== lead.type && d.clause !== lead.clause && !sameFamily(lead, d)) ?? null);

  const hash = tokenHash(f.token);
  // Freshness: sometimes let the number do the work (no punchline).
  const numberOnly = hash % 3 === 2 && lead.type !== "change";
  // Occasionally put the closer/punchline between facts is avoided; we keep fact-first openers.
  // Occasional swap: when two facts exist, 1/4 of the time use the locked two-danger closer
  // instead of a type punchline (already the default for two facts). For a single fact,
  // 1/4 of the time skip the punchline (handled by numberOnly).

  const parts: string[] = [lead.clause];
  let secondUsed: string | null = null;
  if (secondCand) {
    parts.push(secondCand.clause);
    secondUsed = secondCand.clause;
  }

  let kicker: string | null = null;
  if (!numberOnly) {
    if (secondUsed) kicker = twoDangerCloser(lead, secondCand!, f.token, usedKickers);
    else kicker = pickKicker(lead.type, f.token, usedKickers, f);
    if (kicker) { usedKickers.add(kicker); parts.push(kicker); }
  }

  const trimmed = trimLine(parts);
  // If trim dropped the second fact, also drop a two-danger closer that no longer applies.
  if (secondUsed && !trimmed.used.includes(secondUsed)) {
    secondUsed = null;
    kicker = trimmed.used.includes(kicker ?? "") ? kicker : null;
  } else if (kicker && !trimmed.used.includes(kicker)) {
    kicker = null;
  }

  const historyNew = (priorOf(f)?.codes ?? f.previousCodes ?? []).length
    ? f.codes.filter((c) => !(priorOf(f)?.codes ?? f.previousCodes ?? []).includes(c))
    : [];

  const ruleFlags = lintLine(trimmed.line, lead.type);
  return {
    line: trimmed.line,
    type: lead.type,
    fact: secondUsed ? `${lead.fact} + ${secondCand!.fact}` : lead.fact,
    setup: null,
    clause: lead.clause,
    second: secondUsed,
    kicker,
    chars: trimmed.line.length,
    estimated,
    ruleFlags,
    historyNew,
    changeLead: lead.type === "change",
  };
}

export function slimFromRugCheck(out: any, meta: { chain: string; token: string; label: string; previousCodes?: string[] | null; previous?: PriorSnap | null }): SlimFacts {
  const f = out?.facts || {};
  const b = (f.buyer && typeof f.buyer === "object" ? f.buyer : null) || (out?.buyer && typeof out.buyer === "object" ? out.buyer : {}) || {};
  const pick = (...keys: string[]): any => {
    for (const k of keys) if (f[k] != null) return f[k];
    for (const k of keys) if (b[k] != null) return b[k];
    return null;
  };
  const codes = (Array.isArray(out?.checks) ? out.checks : [])
    .filter((c: any) => c && Number(c.points) > 0 && c.check)
    .map((c: any) => String(c.check));
  const canSell = pick("canSell");
  const previous = meta.previous ?? (meta.previousCodes ? { codes: meta.previousCodes } : null);
  return {
    chain: meta.chain,
    token: meta.token,
    label: meta.label,
    symbol: pick("tokenSymbol") || pick("token") || meta.label,
    score: Number(out?.riskScore ?? out?.score ?? 0),
    level: String(out?.riskLevel ?? out?.level ?? ""),
    codes,
    volume24hUsd: n(pick("volume24hUsd")),
    buys24h: n(pick("buys24h")),
    sells24h: n(pick("sells24h")),
    priceChange1hPct: n(pick("priceChange1hPct")),
    priceChange24hPct: n(pick("priceChange24hPct")),
    liquidityUsd: n(pick("liquidityUsd")),
    marketCapUsd: n(pick("marketCapUsd")),
    liquidityToMcapPct: n(pick("liquidityToMcapPct")),
    sellPriceImpactPct: n(pick("sellPriceImpactPct")),
    sellTestUsd: n(pick("sellTestUsd")),
    canSell: canSell != null ? String(canSell) : null,
    sellRoute: pick("sellRoute"),
    sellableOnPumpCurve: typeof b.sellableOnPumpCurve === "boolean" ? b.sellableOnPumpCurve : null,
    lpLockedOrBurnedPct: n(pick("lpLockedOrBurnedPct")),
    creatorEarlierHoneypots: n(pick("creatorEarlierHoneypots")),
    priorLaunches: n(f.priorLaunches),
    priorDead: n(f.priorDead),
    creatorFlagged: !!(f.creatorFlagged || codes.includes("known_pattern")),
    mintAuthority: !!f.mintAuthority,
    freezeAuthority: !!f.freezeAuthority,
    mintable: typeof b.mintable === "boolean" ? b.mintable : null,
    hiddenOwner: typeof b.hiddenOwner === "boolean" ? b.hiddenOwner : null,
    canTakeBackOwnership: typeof b.canTakeBackOwnership === "boolean" ? b.canTakeBackOwnership : null,
    transferPausable: typeof b.transferPausable === "boolean" ? b.transferPausable : null,
    blacklist: typeof b.blacklist === "boolean" ? b.blacklist : null,
    taxModifiable: typeof b.taxModifiable === "boolean" ? b.taxModifiable : null,
    permanentDelegate: !!b.permanentDelegate || codes.includes("permanent_delegate"),
    pausable: !!b.pausable,
    transferHook: !!b.transferHook,
    top1Pct: n(f.top1Pct),
    top10Pct: n(f.top10Pct),
    ageHours: n(f.ageHours),
    buyTaxPct: n(pick("buyTaxPct") ?? (f.buyTax != null ? Number(f.buyTax) * 100 : null)),
    sellTaxPct: n(pick("sellTaxPct") ?? (f.sellTax != null ? Number(f.sellTax) * 100 : null)),
    transferFeePct: n(b.transferFeePct),
    holderCount: n(f.holderCount),
    honeypot: typeof b.honeypot === "boolean" ? b.honeypot : (codes.includes("honeypot") ? true : null),
    cannotSellAll: typeof b.cannotSellAll === "boolean" ? b.cannotSellAll : null,
    owner: f.owner != null ? String(f.owner) : null,
    pairs: n(f.pairs),
    devHoldingPct: n(pick("devHoldingPct")),
    previousCodes: previous?.codes ?? meta.previousCodes ?? null,
    previous,
  };
}

export function baseFacts(over: Partial<SlimFacts> = {}): SlimFacts {
  return {
    chain: "solana",
    token: "Test111111111111111111111111111111111111111",
    label: "TEST",
    symbol: "TEST",
    score: 0,
    level: "low",
    codes: [],
    volume24hUsd: null,
    buys24h: null,
    sells24h: null,
    priceChange1hPct: null,
    priceChange24hPct: null,
    liquidityUsd: null,
    marketCapUsd: null,
    liquidityToMcapPct: null,
    sellPriceImpactPct: null,
    sellTestUsd: null,
    canSell: "yes (Jupiter route)",
    sellRoute: true,
    sellableOnPumpCurve: null,
    lpLockedOrBurnedPct: null,
    creatorEarlierHoneypots: null,
    priorLaunches: null,
    priorDead: null,
    creatorFlagged: false,
    mintAuthority: false,
    freezeAuthority: false,
    mintable: false,
    hiddenOwner: false,
    canTakeBackOwnership: false,
    transferPausable: false,
    blacklist: false,
    taxModifiable: false,
    permanentDelegate: false,
    pausable: false,
    transferHook: false,
    top1Pct: null,
    top10Pct: null,
    ageHours: 1000,
    buyTaxPct: 0,
    sellTaxPct: 0,
    transferFeePct: 0,
    holderCount: 1000,
    honeypot: false,
    cannotSellAll: false,
    owner: null,
    pairs: 1,
    previousCodes: null,
    previous: null,
    ...over,
  };
}

export function hoursAgoIso(hours: number, now = Date.now()): string {
  return new Date(now - hours * 3_600_000).toISOString();
}

/** Synthetic repeat-user cases. Not from live tokens. */
export function syntheticChangeFixtures(now = Date.now()): { id: string; label: string; facts: SlimFacts }[] {
  return [
    {
      id: "sell-flip",
      label: "synthetic sell-pressure flip",
      facts: baseFacts({
        token: "SynthSellFlip11111111111111111111111111111",
        label: "SYN-FLIP",
        symbol: "SYNFLIP",
        score: 20,
        codes: [],
        volume24hUsd: 80_000,
        buys24h: 400,
        sells24h: 1200,
        liquidityUsd: 200_000,
        previous: { t: hoursAgoIso(16, now), codes: [], buys24h: 600, sells24h: 700, volume24hUsd: 70_000, liquidityUsd: 200_000 },
      }),
    },
    {
      id: "sell-appeared",
      label: "synthetic sell pressure appeared",
      facts: baseFacts({
        token: "SynthSellAppeared1111111111111111111111111",
        label: "SYN-APPEAR",
        symbol: "SYNAPP",
        score: 18,
        codes: [],
        volume24hUsd: 40_000,
        buys24h: 80,
        sells24h: 240,
        liquidityUsd: 80_000,
        previous: { t: hoursAgoIso(14, now), codes: [], buys24h: 200, sells24h: 90, volume24hUsd: 30_000, liquidityUsd: 80_000 },
      }),
    },
    {
      id: "liq-down",
      label: "synthetic liquidity drop",
      facts: baseFacts({
        token: "SynthLiqDown11111111111111111111111111111",
        label: "SYN-LIQ",
        symbol: "SYNLIQ",
        score: 15,
        codes: ["liquidity"],
        volume24hUsd: 12_000,
        buys24h: 100,
        sells24h: 110,
        liquidityUsd: 6_000,
        previous: { t: hoursAgoIso(12, now), codes: [], liquidityUsd: 10_000, buys24h: 100, sells24h: 90 },
      }),
    },
    {
      id: "new-holder",
      label: "synthetic new top holder",
      facts: baseFacts({
        token: "SynthHolder111111111111111111111111111111",
        label: "SYN-HOLD",
        symbol: "SYNHOLD",
        score: 25,
        codes: ["holders"],
        top1Pct: 64,
        top10Pct: 80,
        holderCount: 40,
        liquidityUsd: 50_000,
        volume24hUsd: 20_000,
        previous: { t: hoursAgoIso(26, now), codes: [], top1Pct: 12, top10Pct: 28, holderCount: 40, liquidityUsd: 50_000 },
      }),
    },
    {
      id: "creator-flag",
      label: "synthetic creator history flag",
      facts: baseFacts({
        token: "SynthCreator11111111111111111111111111111",
        label: "SYN-CREATOR",
        symbol: "SYNCRE",
        score: 30,
        codes: ["deployer_history"],
        creatorEarlierHoneypots: 3,
        liquidityUsd: 40_000,
        volume24hUsd: 8_000,
        previous: { t: hoursAgoIso(5, now), codes: [], creatorEarlierHoneypots: 0, liquidityUsd: 40_000 },
      }),
    },
  ];
}

/** Tension line for a finished rugCheck result, or null when nothing is flagged or a hard rule would trip. */
export function tensionFor(out: any, now = Date.now()): string | null {
  try {
    if (!out || !Array.isArray(out.checks) || !out.checks.some((c: any) => c && Number(c.points) > 0)) return null;
    const f = slimFromRugCheck(out, { chain: String(out.chain ?? "solana"), token: String(out.token ?? ""), label: String(out?.facts?.tokenSymbol ?? out?.facts?.token ?? "") });
    const r = tensionLine(f, new Set(), now);
    if (!r || r.ruleFlags.length || r.chars > HARD_MAX) return null;
    return r.line.replace(/pump\.fun/gi, "pump fun");
  } catch { return null; }
}
