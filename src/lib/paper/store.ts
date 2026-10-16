/**
 * Paper-trader persistence. Durable: private GitHub repo (PAPER_STORE_REPO, e.g. git@github.com:jimmybr-PDX/paper-trader.git)
 * written over git+SSH with a repo-scoped deploy key (PAPER_STORE_SSH_KEY_B64). Fallback: local files (PAPER_DIR).
 * Files: data/state.json (open positions + counters), data/trades.jsonl (one closed paper trade per line, append-only).
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
const run = promisify(execFile);

let mode: "github" | "file" | "unavailable" = "unavailable";
let dir = ""; let env: NodeJS.ProcessEnv = process.env; let lastError: string | null = null; let lastPushAt: string | null = null;
// Oct 16: keep git small in memory (the container has 512 MB shared with the server): single-threaded packing, small windows
const git = (...a: string[]) => run("git", ["-C", dir, "-c", "pack.threads=1", "-c", "pack.windowMemory=16m", "-c", "core.packedGitLimit=32m", "-c", "core.packedGitWindowSize=8m", "-c", "core.bigFileThreshold=4m", "-c", "gc.auto=0", ...a], { env, timeout: 30000 });
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
export function loadTrades(): any[] {
  try { return fs.readFileSync(path.join(dir, "data", "trades.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
}
export function appendTrade(t: unknown) { if (mode === "unavailable") return; fs.appendFileSync(path.join(dir, "data", "trades.jsonl"), JSON.stringify(t) + "\n"); }
let busy = false;
export async function saveState(state: unknown, msg: string) {
  if (mode === "unavailable" || busy) return;
  busy = true;
  try {
    fs.writeFileSync(path.join(dir, "data", "state.json"), JSON.stringify(state) + "\n");
    if (mode !== "github") return;
    await git("add", "data");
    const { stdout } = await git("status", "--porcelain");
    if (!stdout.trim()) return;
    await git("commit", "-q", "-m", msg);
    try { await git("push", "-q", "origin", "HEAD"); }
    catch { await git("pull", "-q", "--rebase", "origin", "HEAD"); await git("push", "-q", "origin", "HEAD"); }
    lastPushAt = new Date().toISOString(); lastError = null;
  } catch (e) { lastError = String((e as Error).message ?? e).replace(/\s+/g, " ").slice(0, 160); }
  finally { busy = false; }
}

export function loadFile<T>(name: string, fallback: T): T { try { return JSON.parse(fs.readFileSync(path.join(dir, "data", name), "utf8")); } catch { return fallback; } }
export function writeFile(name: string, obj: unknown) { if (mode === "unavailable") return; fs.writeFileSync(path.join(dir, "data", name), JSON.stringify(obj) + "\n"); }
