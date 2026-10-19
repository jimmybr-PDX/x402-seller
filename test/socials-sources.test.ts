import { test } from "node:test";
import assert from "node:assert/strict";
import { solanaExtra, geckoInfo } from "../src/lib/rug-extra.js";
import { jupiterOnce } from "../src/lib/rug.js";

const MINT = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const real = globalThis.fetch;
function stub(h: (url: string) => Response | null) {
  globalThis.fetch = (async (u: any) => { const r = h(String(u)); if (r) return r; throw new Error("offline"); }) as any;
}
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
const base = { mintInfo: { mintAuthority: null, freezeAuthority: null }, supply: 1e9, decimals: 6, liquidityUsd: 1e6 };

test("Jupiter 429 / timeout is 'no answer' (undefined), not 'not listed'", async (t) => {
  t.after(() => { globalThis.fetch = real; });
  stub(() => json({ error: "rate limited" }, 429));
  assert.equal(await jupiterOnce(MINT), undefined);
  stub(() => null);
  assert.equal(await jupiterOnce(MINT), undefined);
  stub(() => json([]));
  assert.equal(await jupiterOnce(MINT), null);
});

test("all link sources down: no 'no socials' warning, socialLinks null (row hidden)", async (t) => {
  t.after(() => { globalThis.fetch = real; });
  stub(() => null);
  const ex: any = await solanaExtra(MINT, { ...base, jup: undefined, jupFailed: true, dsAnswered: false, dsPairs: [] } as any);
  assert.ok(!ex.checks.some((c: any) => c.check === "no_socials"));
  assert.equal(ex.signals.socialLinks, null);
});

test("Jupiter and DexScreener down: GeckoTerminal supplies the links", async (t) => {
  t.after(() => { globalThis.fetch = real; });
  stub((u) => u.includes("geckoterminal.com") && u.includes("/info")
    ? json({ data: { attributes: { websites: ["https://www.bonkcoin.com"], twitter_handle: "bonk_inu", telegram_handle: null, discord_url: "https://discord.gg/ubqvDDFUhf" } } })
    : null);
  const ex: any = await solanaExtra(MINT, { ...base, jup: undefined, jupFailed: true, dsAnswered: false, dsPairs: [] } as any);
  assert.ok(!ex.checks.some((c: any) => c.check === "no_socials"));
  const types = ex.signals.socialLinks.map((l: any) => l.type).sort();
  assert.deepEqual(types, ["discord", "twitter", "website"]);
});

test("sources answered with no links: 'no socials' warning still fires", async (t) => {
  t.after(() => { globalThis.fetch = real; });
  stub(() => null);
  const ex: any = await solanaExtra(MINT, { ...base, jup: null, jupFailed: false, dsAnswered: true, dsPairs: [] } as any);
  assert.ok(ex.checks.some((c: any) => c.check === "no_socials"));
  assert.deepEqual(ex.signals.socialLinks, []);
});

test("geckoInfo: 404 = listed nowhere (empty), 5xx = no answer", async (t) => {
  t.after(() => { globalThis.fetch = real; });
  stub(() => json({}, 404)); assert.deepEqual(await geckoInfo(MINT), { socials: [], websites: [] });
  stub(() => json({}, 503)); assert.equal(await geckoInfo(MINT), undefined);
  stub(() => json({ data: { attributes: { twitter_handle: "x/../evil", websites: [5] } } }));
  assert.deepEqual(await geckoInfo(MINT), { socials: [], websites: [] });
});
