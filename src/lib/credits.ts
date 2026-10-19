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
// Oct 18: lowest CPU priority so git cannot starve the server on the 0.1 CPU free plan
const NICE = fs.existsSync("/usr/bin/nice") ? ["/usr/bin/nice", "-n", "19"] : [];
const git = (...a: string[]) => run(NICE[0] ?? "git", [...NICE.slice(1), ...(NICE.length ? ["git"] : []), "-C", dir, ...a], { env, timeout: 20000 });

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
      branch = (await run("git", ["-C", dir, "rev-parse", "--abbrev-ref", "HEAD"], { env, timeout: 10000 })).stdout.trim() || "main";
      mode = "github";
    } catch (e) { mode = "unavailable"; lastError = String((e as Error).message ?? e).replace(/\s+/g, " ").slice(0, 160); }
  })();
  return ready;
}

// Oct 19: pushes never leave the clone stuck. Before, a rejected push ran `git pull --rebase`; when two instances
// (old + new during a deploy/restart) had changed the same file the rebase stopped half-way, the error was swallowed and
// every later push failed. Now: on a rejected push, abort any rebase, fetch, hard-reset to the remote, re-apply every
// document this instance still owes (credits.json is merged with the remote copy so no paid key is lost), commit, retry.
const dirty = new Map<string, (afterReset: boolean) => void>();
let branch = "main";
const revoked = new Set<string>(); // hashes revoked here, so a remote merge never brings them back
/** After a reset to the remote: fold the remote credits.json (now on disk) into memory. */
function mergeRemoteCredits() {
  {
    try {
      const remote = JSON.parse(fs.readFileSync(file, "utf8")) as Data;
      for (const [h, r] of Object.entries(remote.keys ?? {})) {
        if (revoked.has(h)) continue;
        const l = data.keys[h];
        if (!l) data.keys[h] = r; // bought on the other instance: keep it
        else { l.credits = Math.min(l.credits, r.credits); l.bought = Math.max(l.bought, r.bought); if ((r.lastUsedAt ?? "") > (l.lastUsedAt ?? "")) l.lastUsedAt = r.lastUsedAt; } // spends only lower credits
      }
      for (const [ref, h] of Object.entries(remote.purchases ?? {})) if (!(ref in data.purchases)) data.purchases[ref] = h;
    } catch { /* no remote copy: ours is the only one */ }
  }
}
function writeCredits() { fs.writeFileSync(file, JSON.stringify(data, null, 1) + "\n"); }
async function resetToRemote() {
  await git("rebase", "--abort").catch(() => {});
  await git("merge", "--abort").catch(() => {});
  await git("fetch", "-q", "--depth", "1", "origin", branch);
  await git("reset", "-q", "--hard", "FETCH_HEAD");
  mergeRemoteCredits(); // keys bought/spent on another instance; memory now covers both
  if (!dirty.has("credits.json")) dirty.set("credits.json", writeCredits);
  const names = [...dirty.keys()];
  for (const w of dirty.values()) w(true);
  if (names.length) { await git("add", "-A"); await git("commit", "-q", "-m", "re-apply after remote moved").catch(() => {}); }
}
/** Write the named documents (their writers are registered in `dirty`), commit and push, recovering from a moved remote. */
async function commitPush(names: string[], msg: string) {
  for (const n of names) dirty.get(n)?.(false);
  if (mode !== "github") { for (const n of names) dirty.delete(n); return; }
  await git("add", "-A");
  await git("commit", "-q", "-m", msg).catch(() => {});
  let err: unknown;
  for (let i = 0; i < 3; i++) {
    try { await git("push", "-q", "origin", `HEAD:${branch}`); dirty.clear(); return; } catch (e) { err = e; }
    try { await resetToRemote(); } catch (e) { err = e; }
  }
  throw err;
}
async function persist(msg: string) {
  dirty.set("credits.json", writeCredits);
  await commitPush(["credits.json"], msg);
}
/** Fetch the remote and hard-reset the local clone to it (keeping anything this instance still has to push). */
export async function syncStore(): Promise<void> { await initCredits(); if (mode === "github") await serial(resetToRemote); }
/** Names of stored JSON documents starting with `prefix` (local clone; call syncStore first for a fresh view). */
export async function listDocs(prefix: string): Promise<string[]> {
  await initCredits();
  if (!file) return [];
  try { return fs.readdirSync(path.dirname(file)).filter((n) => n.startsWith(prefix) && n.endsWith(".json")).sort(); } catch { return []; }
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
export async function revokeKey(key: string) { await serial(async () => { const h = hashKey(key); revoked.add(h); delete data.keys[h]; await persist("revoke unpaid"); }); }
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
  return saveDocs({ [name]: value }, msg);
}
/** Write several documents in one commit; a null value deletes that document. */
export async function saveDocs(docs: Record<string, unknown>, msg: string): Promise<void> {
  await initCredits();
  if (!file) throw new Error("store unavailable");
  await serial(async () => {
    const names = Object.keys(docs);
    for (const n of names) {
      const body = docs[n] === null ? null : JSON.stringify(docs[n]) + "\n";
      dirty.set(n, () => { const p = docPath(n); if (body === null) fs.rmSync(p, { force: true }); else fs.writeFileSync(p, body); });
    }
    await commitPush(names, msg);
  });
}
