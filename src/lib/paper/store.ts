/**
 * Paper-trader persistence. Durable: private GitHub repo (PAPER_STORE_REPO, e.g. git@github.com:jimmybr-PDX/paper-trader.git)
 * written over git+SSH with a repo-scoped deploy key (PAPER_STORE_SSH_KEY_B64). Fallback: local files (PAPER_DIR).
 * Files: data/state.json (open positions + counters), data/trades.jsonl (one closed paper trade per line, append-only).
 * Oct 18 history (batched, one new file per batch so each commit only adds small blobs): data/coin-trades/<day>/<time>.jsonl.gz,
 * data/launches/<day>/<time>.jsonl.gz, data/market/<day>/<time>.jsonl, data/trade-marks.jsonl (post-exit price checkpoints).
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { gzip as gzipCb } from "node:zlib";
import { createHash } from "node:crypto";
import { track, stringifyParts, yielder } from "../lag.js";
const gzipAsync = promisify(gzipCb); // libuv threadpool, off the event loop
const run = promisify(execFile);

let mode: "github" | "file" | "unavailable" = "unavailable";
let dir = ""; let env: NodeJS.ProcessEnv = process.env; let lastError: string | null = null; let lastPushAt: string | null = null;
// Oct 16: keep git small in memory (the container has 512 MB shared with the server): single-threaded packing, small windows
// Oct 18: git runs at the lowest CPU priority so on the 0.1 CPU free plan it cannot starve the server (health check timeouts)
const NICE = fs.existsSync("/usr/bin/nice") ? ["/usr/bin/nice", "-n", "19"] : [];
const git = (...a: string[]) => run(NICE[0] ?? "git", [...NICE.slice(1), ...(NICE.length ? ["git"] : []), "-C", dir, "-c", "pack.threads=1", "-c", "pack.windowMemory=16m", "-c", "core.packedGitLimit=32m", "-c", "core.packedGitWindowSize=8m", "-c", "core.bigFileThreshold=4m", "-c", "gc.auto=0", ...a], { env, timeout: 30000 });
export const storeStatus = () => ({ mode, lastPushAt, ...(lastError ? { error: lastError } : {}) });

export async function initStore(): Promise<void> {
  const repo = process.env.PAPER_STORE_REPO, keyB64 = process.env.PAPER_STORE_SSH_KEY_B64;
  if (!repo || !keyB64) { dir = process.env.PAPER_DIR ?? path.join(process.cwd(), "data", "paper-store"); fs.mkdirSync(path.join(dir, "data"), { recursive: true }); mode = "file"; return; }
  try {
    const keyPath = path.join(os.tmpdir(), "paper_store_key");
    fs.writeFileSync(keyPath, Buffer.from(keyB64, "base64"), { mode: 0o600 });
    env = { ...process.env, GIT_SSH_COMMAND: `ssh -i ${keyPath} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=${path.join(os.tmpdir(), "paper_known_hosts")}`, GIT_AUTHOR_NAME: "paper-bot", GIT_AUTHOR_EMAIL: "paper-bot@users.noreply.github.com", GIT_COMMITTER_NAME: "paper-bot", GIT_COMMITTER_EMAIL: "paper-bot@users.noreply.github.com" };
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "paper-store-"));
    await run("git", ["clone", "--depth", "1", repo, dir], { env, timeout: 60000 });
    fs.mkdirSync(path.join(dir, "data"), { recursive: true });
    mode = "github";
  } catch (e) { mode = "unavailable"; lastError = String((e as Error).message ?? e).replace(/\s+/g, " ").slice(0, 160); }
}
export function loadState<T>(fallback: T): T { try { return JSON.parse(fs.readFileSync(path.join(dir, "data", "state.json"), "utf8")); } catch { return fallback; } }
/** Oct 18: parses only the last `tail` lines (was the whole 11+ MB file, then sliced: seconds of blocked loop on 0.1 CPU). */
export function loadTrades(tail = Infinity): any[] {
  // Oct 19 (bandwidth): new trades go to small hourly files data/trades/<day>/<HH>.jsonl; data/trades.jsonl is the frozen pre-Oct-19 log.
  try {
    const want = Number.isFinite(tail) ? tail : Infinity; let rows: string[] = [];
    for (const f of tradeFiles().reverse()) { rows = readLines(f).concat(rows); if (rows.length >= want) break; }
    if (rows.length < want) rows = readLines(path.join(dir, "data", "trades.jsonl")).concat(rows);
    return rows.slice(Number.isFinite(want) ? -want : 0).map((l) => JSON.parse(l));
  } catch { return []; }
}
const readLines = (f: string) => { try { return fs.readFileSync(f, "utf8").split("\n").filter(Boolean); } catch { return []; } };
function tradeFiles(): string[] {
  const root = path.join(dir, "data", "trades"); const out: string[] = [];
  try { for (const d of fs.readdirSync(root).sort()) for (const h of fs.readdirSync(path.join(root, d)).sort()) if (h.endsWith(".jsonl")) out.push(path.join(root, d, h)); } catch {}
  return out;
}
export function tradeFileFor(now = new Date()) { const iso = now.toISOString(); return path.join("trades", iso.slice(0, 10), `${iso.slice(11, 13)}.jsonl`); }
export function appendTrade(t: unknown, now = new Date()) {
  if (mode === "unavailable") return;
  const f = path.join(dir, "data", tradeFileFor(now)); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.appendFileSync(f, JSON.stringify(t) + "\n");
}
let busy = false;
export async function saveState(state: unknown, msg: string) { return track("paper-store save+push", () => saveStateNow(state, msg)); }
async function saveStateNow(state: unknown, msg: string) {
  if (mode === "unavailable" || busy) return;
  busy = true;
  try {
    await writeParts(path.join(dir, "data", "state.json"), [...(await stringifyParts(state)), "\n"]); // Oct 18: time-sliced (was one blocking JSON.stringify)
    if (mode !== "github") return;
    // Oct 19 (bandwidth): raw coin-trades history stays on local disk only (it was ~70 MB/day of uploads)
    await git("add", "-A", "--", "data", ":(exclude)data/coin-trades");
    const { stdout } = await git("status", "--porcelain");
    if (!stdout.split("\n").some((l) => l.trim() && !l.startsWith("??"))) return; // untracked local-only history is not a change
    await git("commit", "-q", "-m", msg);
    try { await git("push", "-q", "origin", "HEAD"); }
    catch { await git("pull", "-q", "--rebase", "origin", "HEAD"); await git("push", "-q", "origin", "HEAD"); }
    lastPushAt = new Date().toISOString(); lastError = null;
  } catch (e) { lastError = String((e as Error).message ?? e).replace(/\s+/g, " ").slice(0, 160); }
  finally { busy = false; }
}

/** Write string parts to a file in ~256 KB batches through one async file handle (tmp file + rename, so readers never see half a file). */
async function writeParts(file: string, parts: string[]) {
  const tmp = `${file}.tmp`; const fh = await fs.promises.open(tmp, "w");
  try {
    let buf: string[] = [], n = 0;
    for (const p of parts) { buf.push(p); n += p.length; if (n >= 262_144) { await fh.write(buf.join("")); buf = []; n = 0; } }
    if (buf.length) await fh.write(buf.join(""));
  } finally { await fh.close(); }
  await fs.promises.rename(tmp, file);
}
export function loadFile<T>(name: string, fallback: T): T { try { return JSON.parse(fs.readFileSync(path.join(dir, "data", name), "utf8")); } catch { return fallback; } }
const lastHash = new Map<string, string>();
/** Oct 18: async, stringified in slices (creators/names are several MB), and skipped when nothing changed (less git work too). */
// Oct 19 (bandwidth): multi-MB caches are re-uploaded whole on every change (git sends files over 4 MB without deltas),
// so they are written at most every 6 h, plus on shutdown.
export const BIG_FILES = new Set(["scorecard.json", "names.json", "creators.json"]);
export const BIG_EVERY_MS = 6 * 3600_000;
const lastBigWrite = new Map<string, number>();
export async function writeFile(name: string, obj: unknown, force = false, now = Date.now()) {
  if (mode === "unavailable") return;
  if (!force && BIG_FILES.has(name)) { const at = lastBigWrite.get(name); if (at == null) lastBigWrite.set(name, now); else if (now - at < BIG_EVERY_MS) return; }
  if (BIG_FILES.has(name)) lastBigWrite.set(name, now);
  await track(`paper-store write ${name}`, async () => {
    // Oct 18 (v2): stringify in time slices, hash part by part with yields, write the parts in batches (no multi-MB join/hash in one go)
    const parts = [...(await stringifyParts(obj)), "\n"]; const h = createHash("sha1"); const y = yielder();
    for (const p of parts) { h.update(p); await y(); }
    const hsh = h.digest("hex");
    if (lastHash.get(name) === hsh) return; await writeParts(path.join(dir, "data", name), parts); lastHash.set(name, hsh);
  });
}
/** Oct 18: append one JSON line to a data/ file (small, append-only logs). */
export function appendLine(name: string, obj: unknown) { if (mode === "unavailable") return; fs.appendFileSync(path.join(dir, "data", name), JSON.stringify(obj) + "\n"); }
/** Oct 18: write one batch of JSON lines as a new file under data/<kind>/<UTC day>/<HHMMSS>[.gz]. Returns the relative path or null. */
export async function writeBatch(kind: string, rows: unknown[], gzip = true, now = new Date()): Promise<string | null> {
  if (mode === "unavailable" || !rows.length) return null;
  const iso = now.toISOString(), day = iso.slice(0, 10), t = iso.slice(11, 19).replace(/:/g, "");
  const rel = path.join(kind, day, `${t}.jsonl${gzip ? ".gz" : ""}`), full = path.join(dir, "data", rel);
  await fs.promises.mkdir(path.dirname(full), { recursive: true });
  const parts: string[] = []; // Oct 18: stringify in slices with yields, gzip on the threadpool, async write
  for (let i = 0; i < rows.length; i += 200) { parts.push(rows.slice(i, i + 200).map((r) => JSON.stringify(r)).join("\n")); await new Promise((r) => setImmediate(r)); }
  const body = parts.join("\n") + "\n";
  await fs.promises.writeFile(full, gzip ? await gzipAsync(body, { level: 6 }) : body); historyDirty = true;
  return rel;
}
let historyDirty = false;
/** True once after history files were written (so the save loop commits them even when no trade changed). */
export function takeHistoryDirty() { const d = historyDirty; historyDirty = false; return d; }
export const storeDir = () => dir;
