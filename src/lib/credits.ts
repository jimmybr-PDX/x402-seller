/**
 * RugRadar prepaid credits. Keys are random secrets returned once; only SHA-256 hashes are stored.
 * Durable free store: a private GitHub repo (jimmybr-PDX/rugradar-credits) written with a repo-scoped
 * deploy key over git+SSH (env RUGRADAR_STORE_REPO + RUGRADAR_STORE_SSH_KEY_B64). Tests/dev use a local
 * file (CREDITS_FILE). If the durable store is unavailable, selling credits is refused (never sell
 * balances that could vanish); spending existing keys still works from memory.
 */
import { createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
const run = promisify(execFile);

type Rec = { credits: number; bought: number; createdAt: string; lastUsedAt: string | null };
type Data = { v: 1; keys: Record<string, Rec>; purchases: Record<string, string> };
let data: Data = { v: 1, keys: {}, purchases: {} };
let mode: "github" | "file" | "unavailable" = "unavailable";
let lastError: string | null = null;
let dir = "";
let file = "";
let env: NodeJS.ProcessEnv = process.env;
let ready: Promise<void> | null = null;
let chain: Promise<unknown> = Promise.resolve();
const serial = <T>(f: () => Promise<T>): Promise<T> => { const p = chain.then(f, f); chain = p.catch(() => {}); return p; };

export const hashKey = (k: string) => createHash("sha256").update(k).digest("hex");
const git = (...a: string[]) => run("git", ["-C", dir, ...a], { env, timeout: 20000 });

export function initCredits(): Promise<void> {
  if (ready) return ready;
  ready = (async () => {
    const repo = process.env.RUGRADAR_STORE_REPO, keyB64 = process.env.RUGRADAR_STORE_SSH_KEY_B64;
    if (process.env.CREDITS_FILE || !repo || !keyB64) {
      file = process.env.CREDITS_FILE ?? path.join(process.cwd(), "data", "credits.json");
      try { fs.mkdirSync(path.dirname(file), { recursive: true }); if (fs.existsSync(file)) data = JSON.parse(fs.readFileSync(file, "utf8")); mode = "file"; } catch (e) { lastError = String(e).slice(0, 120); }
      return;
    }
    try {
      const keyPath = path.join(os.tmpdir(), "rugradar_store_key");
      fs.writeFileSync(keyPath, Buffer.from(keyB64, "base64"), { mode: 0o600 });
      env = { ...process.env, GIT_SSH_COMMAND: `ssh -i ${keyPath} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=${path.join(os.tmpdir(), "rugradar_known_hosts")}`, GIT_AUTHOR_NAME: "rugradar-bot", GIT_AUTHOR_EMAIL: "rugradar-bot@users.noreply.github.com", GIT_COMMITTER_NAME: "rugradar-bot", GIT_COMMITTER_EMAIL: "rugradar-bot@users.noreply.github.com" };
      dir = fs.mkdtempSync(path.join(os.tmpdir(), "rugradar-store-"));
      await run("git", ["clone", "--depth", "1", repo, dir], { env, timeout: 30000 });
      file = path.join(dir, "credits.json");
      data = JSON.parse(fs.readFileSync(file, "utf8"));
      mode = "github";
    } catch (e) { mode = "unavailable"; lastError = String((e as Error).message ?? e).replace(/\s+/g, " ").slice(0, 160); }
  })();
  return ready;
}

async function persist(msg: string) {
  fs.writeFileSync(file, JSON.stringify(data, null, 1) + "\n");
  if (mode !== "github") return;
  await git("add", "credits.json");
  await git("commit", "-q", "-m", msg).catch(() => {});
  try { await git("push", "-q", "origin", "HEAD"); }
  catch { await git("pull", "-q", "--rebase", "origin", "HEAD").catch(() => {}); await git("push", "-q", "origin", "HEAD"); }
}
let pending: NodeJS.Timeout | null = null;
function persistSoon() {
  if (pending) return;
  pending = setTimeout(() => { pending = null; serial(() => persist("spend")).catch((e) => { lastError = String(e).slice(0, 120); }); }, 3000);
  pending.unref?.();
}

export const creditsStatus = () => ({ store: mode, durable: mode === "github" || (mode === "file" && !process.env.RENDER), ...(lastError && mode === "unavailable" ? { error: lastError } : {}) });
export const canSell = () => mode === "github" || (mode === "file" && !process.env.RENDER);

/** Issue a new key with n credits. Durable before the key is returned. */
export async function issueKey(n: number, ref: string): Promise<{ key: string; credits: number }> {
  await initCredits();
  if (!canSell()) throw new Error("credit store unavailable");
  const key = "rr_" + randomBytes(24).toString("base64url");
  return serial(async () => {
    data.keys[hashKey(key)] = { credits: n, bought: n, createdAt: new Date().toISOString(), lastUsedAt: null };
    data.purchases[ref] = hashKey(key).slice(0, 12);
    await persist(`buy ${n}`);
    return { key, credits: n };
  });
}
/** True when a purchase reference (e.g. a wallet-payment signature) has already been redeemed. Durable, same store as keys. */
export async function isRedeemed(ref: string): Promise<boolean> { await initCredits(); return ref in data.purchases; }
/** Issue a key once for a set of purchase refs: throws "already_redeemed" if any ref was used before (checked and written atomically). */
export async function issueKeyOnce(n: number, refs: string[]): Promise<{ key: string; credits: number }> {
  await initCredits();
  if (!canSell()) throw new Error("credit store unavailable");
  return serial(async () => {
    if (refs.some((r) => r in data.purchases)) throw new Error("already_redeemed");
    const key = "rr_" + randomBytes(24).toString("base64url"), h = hashKey(key);
    data.keys[h] = { credits: n, bought: n, createdAt: new Date().toISOString(), lastUsedAt: null };
    for (const r of refs) data.purchases[r] = h.slice(0, 12);
    try { await persist(`wallet buy ${n}`); } catch (e) { delete data.keys[h]; for (const r of refs) delete data.purchases[r]; throw e; }
    return { key, credits: n };
  });
}
export async function revokeKey(key: string) { await serial(async () => { delete data.keys[hashKey(key)]; await persist("revoke unpaid"); }); }
/** Spend one credit. Returns remaining credits, or null when the key is unknown or empty. */
export async function spend(key: string): Promise<number | null> {
  await initCredits();
  const r = data.keys[hashKey(key)];
  if (!r || r.credits <= 0) return null;
  r.credits -= 1; r.lastUsedAt = new Date().toISOString(); persistSoon();
  return r.credits;
}
export async function refund(key: string) { const r = data.keys[hashKey(key)]; if (r) { r.credits += 1; persistSoon(); } }
export async function balance(key: string): Promise<number | null> { await initCredits(); return data.keys[hashKey(key)]?.credits ?? null; }
export async function flushCredits() { if (pending) { clearTimeout(pending); pending = null; } await serial(() => persist("flush")); }

/** Spend n credits at once (all or nothing). Returns remaining credits, or null when the key is unknown or has fewer than n. */
export async function spendN(key: string, n: number): Promise<number | null> {
  await initCredits();
  const r = data.keys[hashKey(key)];
  if (!r || !(n >= 1) || r.credits < n) return null;
  r.credits -= n; r.lastUsedAt = new Date().toISOString(); persistSoon();
  return r.credits;
}
export async function refundN(key: string, n: number) { const r = data.keys[hashKey(key)]; if (r) { r.credits += n; persistSoon(); } }

/** Extra JSON documents in the same durable store (e.g. watches.json). Same repo, same serial queue as credits. */
const docPath = (name: string) => path.join(path.dirname(file), name);
export async function loadDoc<T>(name: string, fallback: T): Promise<T> {
  await initCredits();
  if (!file) return fallback;
  try { const p = docPath(name); return fs.existsSync(p) ? (JSON.parse(fs.readFileSync(p, "utf8")) as T) : fallback; } catch { return fallback; }
}
export async function saveDoc(name: string, value: unknown, msg: string): Promise<void> {
  await initCredits();
  if (!file) throw new Error("store unavailable");
  await serial(async () => {
    fs.writeFileSync(docPath(name), JSON.stringify(value) + "\n");
    if (mode !== "github") return;
    await git("add", name);
    await git("commit", "-q", "-m", msg).catch(() => {});
    try { await git("push", "-q", "origin", "HEAD"); }
    catch { await git("pull", "-q", "--rebase", "origin", "HEAD").catch(() => {}); await git("push", "-q", "origin", "HEAD"); }
  });
}
