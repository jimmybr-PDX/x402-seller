/**
 * Outbound-fetch safety helpers: public https targets only (SSRF guard),
 * bounded time and size.
 */
import dns from "node:dns/promises";
import net from "node:net";

export const PUBLIC_URL = (process.env.PUBLIC_URL ?? "https://x402-seller-pmlm.onrender.com").replace(/\/+$/, "");
export const USER_AGENT = `x402-research-tools/2 (+${PUBLIC_URL}/llms.txt)`;

export function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number) as [number, number];
    return (
      a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19)) || a >= 224
    );
  }
  const l = ip.toLowerCase();
  if (l.startsWith("::ffff:")) return isPrivateIp(l.slice(7));
  return l === "::1" || l === "::" || l.startsWith("fc") || l.startsWith("fd") || l.startsWith("fe80");
}

export class InputError extends Error {}

export async function assertPublicHttps(raw: string): Promise<URL> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new InputError("invalid_url: pass a full public URL such as https://example.com/page");
  }
  if (u.protocol !== "https:") throw new InputError("https_only: the url must start with https:// (plain http is not fetched)");
  if (u.username || u.password) throw new InputError("no_credentials_in_url: remove user:password@ from the url");
  if (u.port && u.port !== "443") throw new InputError("port_443_only: only the default https port is allowed");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new InputError("non_public_host: localhost, private and internal addresses are not allowed");
    return u;
  }
  let addrs: { address: string }[];
  try {
    addrs = await dns.lookup(host, { all: true });
  } catch {
    throw new InputError("dns_lookup_failed: that host name does not resolve; check the domain spelling");
  }
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) throw new InputError("non_public_host: localhost, private and internal addresses are not allowed");
  return u;
}

/** GET a public https URL, following up to 3 redirects (each re-validated). */
export async function safeFetch(
  raw: string,
  opts: { timeoutMs?: number; maxBytes?: number; accept?: string; method?: "GET" | "POST" } = {},
): Promise<{ url: string; status: number; headers: Headers; body: string; truncated: boolean; ms: number }> {
  const started = Date.now();
  const maxBytes = opts.maxBytes ?? 2_000_000;
  let current = raw;
  for (let hop = 0; hop < 4; hop++) {
    const u = await assertPublicHttps(current);
    const res = await fetch(u, {
      method: opts.method ?? "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(opts.timeoutMs ?? 12_000),
      headers: { "user-agent": USER_AGENT, accept: opts.accept ?? "*/*" },
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get("location") && hop < 3) {
      current = new URL(res.headers.get("location")!, u).toString();
      continue;
    }
    const reader = res.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    let truncated = false;
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) {
          truncated = true;
          await reader.cancel().catch(() => {});
          break;
        }
        chunks.push(value);
      }
    }
    const body = Buffer.concat(chunks).toString("utf8");
    return { url: u.toString(), status: res.status, headers: res.headers, body, truncated, ms: Date.now() - started };
  }
  throw new InputError("too_many_redirects: the url redirected more than 3 times");
}

/** Small JSON GET for trusted public APIs (no SSRF concern: fixed hosts). */
export async function getJson<T = any>(url: string, timeoutMs = 6000): Promise<T | null> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { "user-agent": USER_AGENT, accept: "application/json" },
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}
