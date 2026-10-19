import { test } from "node:test"; import assert from "node:assert/strict";
import express from "express"; import type { AddressInfo } from "node:net";
import { socialLinks } from "../src/lib/rug-extra.js";
import { registerRugradarWeb } from "../src/lib/rugradar-web.js";
test("socialLinks: telegram/discord/other DexScreener socials + all websites, http(s) only, capped, deduped", () => {
  const l = socialLinks({ twitter: "https://x.com/abc", telegram: "https://t.me/abcgroup", discord: "javascript:alert(1)" },
    { socials: [{ type: "twitter", url: "https://x.com/abc" }, { type: "discord", url: "https://discord.gg/xyz" }, { type: "tiktok", url: "https://tiktok.com/@a" }, { type: "bad", url: "ftp://x" }, { type: "long", url: "https://a.com/" + "x".repeat(300) }],
      websites: [{ label: "Website", url: "https://abc.io" }, { label: "Docs", url: "http://docs.abc.io/" }] });
  assert.deepEqual(l.map((x) => x.type + " " + x.url), ["twitter https://x.com/abc", "telegram https://t.me/abcgroup", "discord https://discord.gg/xyz", "tiktok https://tiktok.com/@a", "website https://abc.io/", "website http://docs.abc.io/"]);
  assert.deepEqual(socialLinks(null, null), []);
});
test("page renders socials as nofollow links with a creator tooltip; inline scripts still parse", async () => {
  const app = express(); const srv = app.listen(0); const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  registerRugradarWeb(app, { publicUrl: base, port: 0, priceUsd: "0.01", speed: null, rugCheck: async () => ({}), spend: async () => null, refund: async () => {} } as any);
  const html = await (await fetch(base + "/rugradar")).text(); srv.close();
  assert.match(html, /noopener noreferrer nofollow/); assert.ok(!/links are set by the token creator/.test(html), "long trust line dropped"); assert.match(html, /Links set by the token creator/, "kept as a tooltip only"); assert.match(html, /a\.target='_blank'/);
  for (const m of html.matchAll(/<script(?![^>]*src=)(?![^>]*application\/ld\+json)[^>]*>([\s\S]*?)<\/script>/g)) assert.doesNotThrow(() => new Function(m[1]), "inline script syntax");
  assert.match(html, /\/\^https\?:\\\/\\\/\/i/); // regex survived the template literal
});
