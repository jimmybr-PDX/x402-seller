/**
 * Unit tests for the /search source chain. No network: global fetch and the Brave curl transport are mocked;
 * result URLs use public IP literals so the page-text fetch skips DNS and hits the fetch mock (404 -> text null).
 * Run: npm test
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { webSearch, __setCurlForTests } from "../src/lib/search.js";

const KEY = "test-serper-key-DO-NOT-LOG-123";
const realFetch = globalThis.fetch;
type Call = { url: string; init?: RequestInit };
let calls: Call[] = [];
let curlCalls: string[] = [];
let logged: string[] = [];
const realLog = { log: console.log, warn: console.warn, error: console.error, info: console.info };

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const html = (status: number, body: string) => new Response(body, { status, headers: { "content-type": "text/html" } });
const organic = (k: number, word: string) => Array.from({ length: k }, (_, i) => ({ title: `${word} result ${i + 1}`, link: `https://93.184.216.${10 + i}/p${i}`, snippet: `About ${word} number ${i + 1}` }));
const bingPage = (urls: string[], word: string) =>
  urls.map((u, i) => `<li class="b_algo"><h2><a href="${u}">${word} bing ${i + 1}</a></h2><div class="b_caption"><p>${word} snippet ${i + 1}</p></div></li>`).join("");

function mockFetch(route: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, init });
    return route(url, init);
  }) as typeof fetch;
}

beforeEach(() => {
  calls = []; curlCalls = []; logged = [];
  for (const k of ["log", "warn", "error", "info"] as const) (console as any)[k] = (...a: unknown[]) => { logged.push(a.map(String).join(" ")); };
  __setCurlForTests(async (url: string) => { curlCalls.push(url); return { status: 429, body: "" }; });
});
afterEach(() => {
  globalThis.fetch = realFetch;
  Object.assign(console, realLog);
  __setCurlForTests();
  delete process.env.SERPER_API_KEY;
});

test("serper is first when SERPER_API_KEY is set; maps organic results; source=serper", async () => {
  process.env.SERPER_API_KEY = KEY;
  mockFetch((url) => (url.startsWith("https://google.serper.dev/") ? json(200, { organic: organic(7, "zebra facts") }) : html(404, "")));
  const out: any = await webSearch("zebra facts", 5);
  assert.equal(out.source, "serper");
  assert.deepEqual(out.sources_used, ["serper"]);
  assert.equal(out.count, 5);
  assert.deepEqual(Object.keys(out.sources_tried), ["serper"]);
  assert.equal(out.results[0].title, "zebra facts result 1");
  assert.equal(out.results[0].url, "https://93.184.216.10/p0");
  assert.equal(out.results[0].snippet, "About zebra facts number 1");
  const s = calls.find((c) => c.url === "https://google.serper.dev/search")!;
  assert.ok(s, "serper called");
  assert.equal(s.init?.method, "POST");
  assert.equal((s.init?.headers as any)["X-API-KEY"], KEY);
  assert.deepEqual(JSON.parse(String(s.init?.body)), { q: "zebra facts", num: 10, gl: "us", hl: "en" });
  assert.equal(curlCalls.length, 0, "no fallback scraped");
  // cached on the second call, no new upstream calls
  const before = calls.length;
  const again: any = await webSearch("zebra facts", 5);
  assert.equal(again.cached, true);
  assert.equal(calls.length, before);
});

test("serper quota error falls through; short source tops up from the next one, deduped by URL", async () => {
  process.env.SERPER_API_KEY = KEY;
  const bingUrls = ["https://93.184.216.20/a", "https://93.184.216.21/b", "https://93.184.216.22/c", "https://93.184.216.23/d"];
  mockFetch((url) => {
    if (url.startsWith("https://google.serper.dev/")) return json(429, { message: "Not enough credits" });
    if (url.startsWith("https://html.duckduckgo.com/")) return html(202, "anomaly");
    if (url.includes("bing.com/search?format=rss")) {
      // one duplicate of a Bing hit plus one new URL
      const items = [bingUrls[1]!, "https://93.184.216.24/e"].map((u, i) => `<item><title>walrus habitat rss ${i}</title><link>${u}</link><description>walrus habitat rss</description></item>`).join("");
      return html(200, `<rss><channel>${items}</channel></rss>`);
    }
    if (url.startsWith("https://www.bing.com/search")) return html(200, bingPage(bingUrls, "walrus habitat"));
    return html(404, "");
  });
  const out: any = await webSearch("walrus habitat", 5);
  assert.equal(out.sources_tried.serper, "serper 429");
  assert.equal(out.sources_tried.brave, "brave 429");
  assert.match(out.sources_tried.duckduckgo, /captcha/);
  assert.equal(out.source, "bing");
  assert.deepEqual(out.sources_used, ["bing", "bing-rss"]);
  assert.equal(out.count, 5);
  assert.equal(new Set(out.results.map((r: any) => r.url)).size, 5, "no duplicate URLs");
  assert.equal(out.results[4].url, "https://93.184.216.24/e");
  assert.ok(!("wikipedia" in out.sources_tried), "stopped once n reached");
  assert.ok(!JSON.stringify(out).includes(KEY), "key not in response");
  assert.ok(!logged.some((l) => l.includes(KEY)), "key not logged");
});

test("serper timeout / network error falls through to the existing chain", async () => {
  process.env.SERPER_API_KEY = KEY;
  mockFetch((url) => {
    if (url.startsWith("https://google.serper.dev/")) throw new Error("network down");
    if (url.startsWith("https://html.duckduckgo.com/")) return html(200, ["https://93.184.216.30/x", "https://93.184.216.31/y", "https://93.184.216.32/z"].map((u, i) => `<div class="result results_links"><a class="result__a" href="${u}">heron ddg ${i}</a><a class="result__snippet">heron</a></div>`).join(""));
    return html(404, "");
  });
  const out: any = await webSearch("heron", 3);
  assert.equal(out.sources_tried.serper, "network down");
  assert.equal(out.source, "duckduckgo");
  assert.equal(out.count, 3);
});

test("without SERPER_API_KEY serper is never called and the chain starts at Brave", async () => {
  mockFetch((url) => (url.startsWith("https://www.bing.com/search") && !url.includes("format=rss") ? html(200, bingPage(["https://93.184.216.40/a", "https://93.184.216.41/b"], "otter")) : html(404, "")));
  const out: any = await webSearch("otter", 2);
  assert.ok(!calls.some((c) => c.url.includes("serper")), "serper not called");
  assert.ok(!("serper" in out.sources_tried));
  assert.equal(Object.keys(out.sources_tried)[0], "brave");
  assert.ok(curlCalls.length >= 1);
  assert.equal(out.source, "bing");
  assert.equal(out.count, 2);
});

test("all sources failing returns no_results (handler maps to 422, caller not charged)", async () => {
  process.env.SERPER_API_KEY = KEY;
  mockFetch(() => html(500, ""));
  const out: any = await webSearch("nothing here", 5);
  assert.equal(out.error, "no_results");
  assert.equal(out.sources_tried.serper, "serper 500");
});
