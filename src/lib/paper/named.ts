/** PRIVATE paper-test signal (Oct 15): does the coin's creator (or its first traced funder) have a public name?
 * Free sources only: SNS (.sol) primary domain, then any .sol domain owned (sdk-proxy-v2.sns.id), then our built-in label list.
 * Async, queued one lookup at a time, cached per wallet for 24 h. Never used by RugRadar's paid checks. */
import { KNOWN } from "./family.js";
export type Named = { named: boolean; name: string | null; source: string | null; wallet: string | null; who: "creator" | "funder" | null; checked: number };
type One = { name: string; source: string } | null;
const cache = new Map<string, { at: number; p: Promise<One> }>();
let q: Promise<unknown> = Promise.resolve();
const getJ = (u: string) => fetch(u, { signal: AbortSignal.timeout(3000) }).then((r) => (r.ok ? r.json() : null)).catch(() => null) as Promise<any>;
function lookup(w: string, labels = true): Promise<One> {
  if (!labels && KNOWN[w]) return Promise.resolve(null); // exchange funders are not "named devs"
  const hit = cache.get(w); if (hit && Date.now() - hit.at < 86_400_000) return hit.p;
  const p = q.then(async (): Promise<One> => {
    if (KNOWN[w]) return { name: KNOWN[w], source: "public label list" };
    const fav = await getJ(`https://sdk-proxy-v2.sns.id/favorite-domain/${w}`);
    if (fav?.result?.reverse) return { name: `${fav.result.reverse}.sol`, source: "SNS primary .sol domain" };
    const all = await getJ(`https://sdk-proxy-v2.sns.id/domains/${w}`);
    const d = Array.isArray(all?.result) ? all.result[0] : null; const nm = typeof d === "string" ? d : d?.domain ?? d?.name;
    if (nm) return { name: `${String(nm).replace(/\.sol$/, "")}.sol`, source: "SNS .sol domain owned" };
    return null;
  });
  q = p.catch(() => {}); cache.set(w, { at: Date.now(), p }); if (cache.size > 20000) cache.delete(cache.keys().next().value!);
  return p;
}
export async function namedWallet(creator: string, funder: string | null): Promise<Named> {
  const ws = [creator, funder].filter(Boolean) as string[];
  for (const [i, w] of ws.entries()) { const r = await lookup(w, i === 0).catch(() => null); if (r) return { named: true, ...r, wallet: w, who: i ? "funder" : "creator", checked: ws.length }; }
  return { named: false, name: null, source: null, wallet: null, who: null, checked: ws.length };
}
