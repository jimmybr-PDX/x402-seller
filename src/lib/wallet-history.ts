/**
 * Private RugRadar wallet history. Logs which wallet checked which token: every PAID x402 rug check (payer from the
 * settlement) and every free check from a wallet that connected on /rugradar (signed message, no transaction).
 * PRIVATE: never shown publicly, never in share cards or posts. The only read path is a wallet's own list, after it
 * proves ownership with a signature. Stored as one bounded document in the private durable store (credits.ts),
 * flushed in debounced batches. Memory: at most MAX_ROWS small rows.
 */
import { createHash, createHmac, createPublicKey, randomBytes, timingSafeEqual, verify as edVerify } from "node:crypto";
import { verifyMessage } from "viem";

export const WH_DOC = "wallet-checks.json", MAX_ROWS = 5000, PER_WALLET = 50, FLUSH_MS = 60_000;
export type WRow = { w: string; c: string; t: string; s: number | null; at: number; src: "x402" | "connected" };
type Doc = { v: 1; rows: WRow[] };
export type WhStore = { load: (name: string) => Promise<Doc | null>; save: (docs: Record<string, Doc>, msg: string) => Promise<void> };

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function b58decode(s: string): Uint8Array | null {
  let n = 0n;
  for (const ch of s) { const i = B58.indexOf(ch); if (i < 0) return null; n = n * 58n + BigInt(i); }
  const out: number[] = []; while (n > 0n) { out.unshift(Number(n & 255n)); n >>= 8n; }
  for (const ch of s) { if (ch === "1") out.unshift(0); else break; }
  return Uint8Array.from(out);
}
export const isSolAddr = (a: string) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a) && b58decode(a)?.length === 32;
export const isEvmAddr = (a: string) => /^0x[0-9a-fA-F]{40}$/.test(a);
export const normWallet = (a: string) => (isEvmAddr(a) ? a.toLowerCase() : a);

const SECRET = createHash("sha256").update("rr-wallet-session|" + (process.env.RUGRADAR_STORE_SSH_KEY_B64 || process.env.CDP_API_KEY_SECRET || randomBytes(32).toString("hex"))).digest();
const mac = (s: string) => createHmac("sha256", SECRET).update(s).digest("base64url");
const eq = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** Message the wallet signs to prove ownership. No transaction, no payment. Valid 10 minutes. */
export function challenge(address: string, now = Date.now()) {
  const a = normWallet(address), ts = String(now), nonce = mac(`ch|${a}|${ts}`).slice(0, 16);
  return { message: `RugRadar: show my past checks.\nWallet: ${a}\nNonce: ${nonce}\nIssued: ${new Date(now).toISOString()}\nTs: ${ts}\nThis signature does not send a transaction or cost anything.`, expiresInS: 600 };
}
async function sigOk(address: string, message: string, signature: string): Promise<boolean> {
  try {
    if (isEvmAddr(address)) return await verifyMessage({ address: address as `0x${string}`, message, signature: signature as `0x${string}` });
    if (!isSolAddr(address)) return false;
    const pk = b58decode(address)!, sig = /^[0-9a-f]{128}$/i.test(signature) ? Buffer.from(signature, "hex") : Buffer.from(signature, "base64");
    if (sig.length !== 64) return false;
    const key = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(pk)]), format: "der", type: "spki" });
    return edVerify(null, Buffer.from(message, "utf8"), key, sig);
  } catch { return false; }
}
/** Verify a signed challenge; returns a 7-day session token for that wallet, or null. */
export async function verifyChallenge(address: string, message: string, signature: string, now = Date.now()): Promise<string | null> {
  const a = normWallet(String(address || "")); if (!(isEvmAddr(a) || isSolAddr(a)) || typeof message !== "string" || message.length > 600 || typeof signature !== "string" || signature.length > 200) return null;
  const m = /\nWallet: (\S+)\nNonce: (\S+)\n[\s\S]*\nTs: (\d{10,16})\n/.exec(message);
  if (!m || normWallet(m[1]!) !== a || now - Number(m[3]) > 600_000 || Number(m[3]) - now > 60_000) return null;
  if (!eq(m[2]!, mac(`ch|${a}|${m[3]}`).slice(0, 16))) return null;
  if (!(await sigOk(isEvmAddr(address) ? address : a, message, signature))) return null;
  const exp = String(now + 7 * 86_400_000), body = Buffer.from(`${a}|${exp}`).toString("base64url");
  return `${body}.${mac(`s|${a}|${exp}`)}`;
}
/** Session token -> wallet, or null when missing, forged or expired. */
export function sessionWallet(tok: unknown, now = Date.now()): string | null {
  if (typeof tok !== "string" || tok.length > 300) return null;
  const [body, sig] = tok.split("."); if (!body || !sig) return null;
  const [a, exp] = Buffer.from(body, "base64url").toString().split("|");
  if (!a || !exp || Number(exp) < now || !eq(sig, mac(`s|${a}|${exp}`))) return null;
  return a;
}

export function createWalletHistory(store: WhStore, opts: { flushMs?: number; now?: () => number } = {}) {
  const now = opts.now ?? Date.now, flushMs = opts.flushMs ?? FLUSH_MS;
  let rows: WRow[] | null = null, loading: Promise<WRow[]> | null = null, dirty = false, timer: NodeJS.Timeout | null = null;
  const load = () => rows ? Promise.resolve(rows) : (loading ??= store.load(WH_DOC).then((d) => (rows = Array.isArray(d?.rows) ? d!.rows.slice(-MAX_ROWS) : [])).catch(() => (rows = [])));
  async function flush() {
    if (timer) { clearTimeout(timer); timer = null; }
    if (!dirty || !rows) return; dirty = false;
    try { await store.save({ [WH_DOC]: { v: 1, rows } }, "wallet history"); } catch { dirty = true; if (!timer) { timer = setTimeout(() => { timer = null; flush().catch(() => {}); }, flushMs * 4); timer.unref?.(); } }
  }
  /** Log one check. Never throws. */
  async function log(wallet: string, chain: string, token: string, score: unknown, src: WRow["src"]) {
    try {
      const w = normWallet(String(wallet || "").trim()), t = String(token || "").trim();
      if (!(isEvmAddr(w) || isSolAddr(w)) || !t || t.length > 64 || !chain || chain.length > 12) return;
      const r = await load(), s = Number(score);
      r.push({ w, c: chain, t, s: Number.isFinite(s) ? Math.round(s) : null, at: now(), src });
      if (r.length > MAX_ROWS) r.splice(0, r.length - MAX_ROWS);
      dirty = true;
      if (!timer) { timer = setTimeout(() => { timer = null; flush().catch(() => {}); }, flushMs); timer.unref?.(); }
    } catch {}
  }
  /** One wallet's own past checks, newest first (one per token). */
  async function list(wallet: string) {
    const w = normWallet(wallet), seen = new Set<string>(), out: { chain: string; token: string; score: number | null; at: string }[] = [];
    const r = await load();
    for (let i = r.length - 1; i >= 0 && out.length < PER_WALLET; i--) {
      const x = r[i]!; if (x.w !== w) continue; const k = `${x.c}:${x.t}`; if (seen.has(k)) continue; seen.add(k);
      out.push({ chain: x.c, token: x.t, score: x.s, at: new Date(x.at).toISOString() });
    }
    return out;
  }
  return { log, list, flush, size: () => rows?.length ?? 0 };
}
export type WalletHistory = ReturnType<typeof createWalletHistory>;
