/**
 * x402 endpoint check for someone else's endpoint. ONE unpaid probe, never pays.
 * Grades the 402 challenge against what the CDP facilitator, Bazaar and x402scan need, then adds
 * free public Coinbase data: the official validator verdict, the endpoint's live Bazaar listing
 * (30-day calls / payers, indexed metadata vs. what the endpoint serves now) and its search rank
 * for its own name and tags.
 */
import { getJson, safeFetch, USER_AGENT } from "./net.js";

type Check = { id: string; pass: boolean; severity: "required" | "ranking" | "advisory"; detail: string; fix?: string };
const CDP = "https://api.cdp.coinbase.com/platform/v2/x402";
const USDC: Record<string, string> = {
  "eip155:8453": "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
  "eip155:84532": "0x036cbd53842c5426634e7929541ec2318f3dcf7e",
  "eip155:137": "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359",
  "eip155:42161": "0xaf88d065e77c8cc2239327c5edb3a432268e5831",
  "eip155:43114": "0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e",
  "eip155:1329": "0xe15fc38f6d8c56af07bbcbe3baf5708a2bf42392",
  "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp": "epjfwdd5aufqssqem2qn1xzybapc8g4weggkzwytdt1v",
};
const TUNNEL = /(\.ngrok(-free)?\.(io|app|dev)|\.trycloudflare\.com|\.loca\.lt|\.serveo\.net|\.localhost\.run|\.pinggy\.(io|link))$/i;

async function postJson(url: string, body: unknown, timeoutMs = 12_000): Promise<any> {
  try {
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "user-agent": USER_AGENT }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}
const normUrl = (u: string) => u.replace(/^https?:\/\//, "").replace(/[?#].*$/, "").replace(/\/+$/, "").toLowerCase();

export async function checkX402Endpoint(target: string, method: "GET" | "POST") {
  const started = Date.now();
  // Coinbase validator runs in parallel with our own probe (it makes its own unpaid probe).
  const validateP = postJson(`${CDP}/validate`, { resource: target, method });
  const r = await safeFetch(target, { method, timeoutMs: 15_000, maxBytes: 500_000, accept: "application/json" });
  const checks: Check[] = [];
  const add = (id: string, pass: boolean, severity: Check["severity"], detail: string, fix?: string) => checks.push({ id, pass, severity, detail, ...(pass || !fix ? {} : { fix }) });

  add("status_402", r.status === 402, "required", `HTTP ${r.status} (unpaid probe must return 402)`, "Return HTTP 402 with a PAYMENT-REQUIRED header to unpaid requests (including Bazaar's probe with the example input).");
  add("latency_under_1500ms", r.ms < 1500, "ranking", `${r.ms} ms`, "Serve the 402 challenge before any slow work; avoid cold starts (keep the instance warm). Slow probes hurt availability and agent timeouts.");

  let challenge: any = null;
  const hdr = r.headers.get("payment-required");
  if (hdr) {
    try {
      challenge = JSON.parse(Buffer.from(hdr, "base64").toString("utf8"));
    } catch {
      /* ignore */
    }
  }
  if (!challenge && r.body) {
    try {
      const b = JSON.parse(r.body);
      if (b && (b.accepts || b.x402Version)) challenge = b;
    } catch {
      /* not JSON */
    }
  }
  add("challenge_parseable", !!challenge, "required", hdr ? "PAYMENT-REQUIRED header (v2)" : challenge ? "JSON body (v1 style)" : "no parseable x402 challenge", "Send base64 JSON in the PAYMENT-REQUIRED header (x402 v2).");
  add("x402_version_2", challenge?.x402Version === 2, "ranking", `x402Version=${challenge?.x402Version ?? "missing"}`, "Upgrade to x402 v2 (@x402/* packages); v1 listings are being phased out.");
  const accepts: any[] = Array.isArray(challenge?.accepts) ? challenge.accepts : [];
  add("accepts_non_empty", accepts.length > 0, "required", `${accepts.length} payment option(s)`);
  const first = accepts[0] ?? {};
  const atomic = first.amount ?? first.maxAmountRequired;
  const atomicOk = typeof atomic === "string" && /^\d+$/.test(atomic);
  add("amount_atomic_units", atomicOk, "required", atomicOk ? `${atomic} atomic units` : `amount=${JSON.stringify(atomic)}`, 'amount must be an integer string in atomic units (0.01 USDC = "10000").');
  add("pay_to_present", accepts.length > 0 && accepts.every((a) => typeof a.payTo === "string" && a.payTo.length > 10), "required", String(first.payTo ?? "missing"));
  add("network_caip2", accepts.length > 0 && accepts.every((a) => typeof a.network === "string" && a.network.includes(":")), "required", accepts.map((a) => a.network).join(", ") || "missing", "Use CAIP-2 network ids such as eip155:8453.");
  add("max_timeout_set", accepts.length > 0 && accepts.every((a) => Number(a.maxTimeoutSeconds) > 0), "required", `maxTimeoutSeconds=${first.maxTimeoutSeconds ?? "missing"}`);
  const knownUsdc = accepts.filter((a) => USDC[a.network] && String(a.asset).toLowerCase() === USDC[a.network]).length;
  add("asset_is_usdc", accepts.length > 0 && knownUsdc === accepts.length, "advisory", `${knownUsdc}/${accepts.length} accepts use native USDC`);
  const res = challenge?.resource ?? {};
  const resourceUrl: string | undefined = typeof res === "object" ? res.url : first.resource;
  add("resource_https", typeof resourceUrl === "string" && resourceUrl.startsWith("https://"), "required", String(resourceUrl ?? "missing"), "Behind a proxy, trust X-Forwarded-Proto so resource.url is https://.");
  const description: string = (typeof res === "object" ? res.description : "") || first.description || "";
  add("description_max_500", description.length <= 500, "required", `${description.length} chars`, "The CDP facilitator rejects verify/settle when the description exceeds 500 characters.");
  add("description_useful", description.length >= 80, "ranking", `${description.length} chars`, "Write 1-3 sentences: what it returns, when an agent should call it, and the key input. Bare names score zero on metadata quality.");
  const serviceName: string = typeof res.serviceName === "string" ? res.serviceName : "";
  add("service_name_set", serviceName.length > 0 && serviceName.length <= 32 && /^[\x20-\x7e]+$/.test(serviceName), "ranking", serviceName || "missing", "Set resource.serviceName (<= 32 printable ASCII) to the phrase buyers search for, e.g. 'Gas Price' rather than a brand.");
  const tags: string[] = Array.isArray(res.tags) ? res.tags : [];
  const tagsOk = tags.length > 0 && tags.length <= 5 && tags.every((t) => typeof t === "string" && t.length <= 32);
  add("tags_set", tagsOk, "ranking", tags.length ? `${tags.length} tag(s): ${tags.join(", ")}` : "missing", tags.length > 5 ? "Bazaar keeps only the first 5 tags; put your most-searched phrases first and drop the rest." : "Add up to 5 tags (<= 32 chars each) that are literal search phrases, e.g. 'token price'.");
  add("mime_type_set", !!(res.mimeType || first.mimeType), "advisory", String(res.mimeType || first.mimeType || "empty"));
  const bazaar = challenge?.extensions?.bazaar ?? first?.outputSchema;
  add("bazaar_extension", !!bazaar, "required", bazaar ? "extensions.bazaar present" : "missing", "Declare the Bazaar extension (declareDiscoveryExtension) so Bazaar can index input/output.");
  const inp = bazaar?.info?.input;
  const inSchema = bazaar?.schema?.properties?.input;
  const hasInputExample = !!(inp && (inp.queryParams || inp.body || inp.pathParams || inp.toolName || inp.type));
  add("input_example", hasInputExample, "ranking", hasInputExample ? "example input declared" : "no example input", "Add an example input; Bazaar sends it when it probes your endpoint.");
  const inProps = inSchema?.properties?.queryParams?.properties ?? inSchema?.properties?.body?.properties ?? inSchema?.properties?.pathParams?.properties;
  const described = inProps ? Object.values(inProps).filter((p: any) => p && p.description).length : 0;
  add("input_schema_described", !!inProps && described === Object.keys(inProps).length, "ranking", inProps ? `${described}/${Object.keys(inProps).length} input fields have a description` : "no typed input schema", "Give every input field a type and a description so agents can build a valid call without guessing.");
  const ex = bazaar?.info?.output?.example;
  const exFields = ex && typeof ex === "object" ? Object.keys(ex).length : 0;
  add("output_example", exFields > 0, "ranking", `${exFields} top-level fields in the output example`, "Add a realistic output example (real values, not placeholders).");
  const outSchema = bazaar?.schema?.properties?.output?.properties?.example ?? bazaar?.info?.output?.schema;
  const outProps = outSchema?.properties ? Object.keys(outSchema.properties) : [];
  add("output_schema_typed", outProps.length > 0, "ranking", outProps.length ? `${outProps.length} typed output fields` : "output schema is untyped", "Add a JSON Schema for the output (types for each field).");
  const req: string[] = Array.isArray(outSchema?.required) ? outSchema.required : [];
  const missingReq = ex && typeof ex === "object" ? req.filter((k) => !(k in ex)) : req;
  add("example_matches_schema", outProps.length > 0 && exFields > 0 && missingReq.length === 0, "advisory", missingReq.length ? `example lacks required: ${missingReq.join(", ")}` : "required output fields present in example");
  let host = "";
  try {
    host = new URL(r.url).hostname;
  } catch {
    /* ignore */
  }
  add("dedicated_domain", !TUNNEL.test(host), "ranking", host, "Bazaar weights shared tunnel domains (ngrok etc.) below dedicated domains; use your own domain or a stable host.");
  const expose = (r.headers.get("access-control-expose-headers") ?? "").toLowerCase();
  add("cors_exposes_payment_headers", expose.includes("payment-required") || expose === "*", "advisory", expose || "no Access-Control-Expose-Headers", "Expose PAYMENT-REQUIRED / PAYMENT-RESPONSE via CORS so browser-based agents can pay.");

  // ---- free public Coinbase data (validator verdict, live Bazaar listing, search rank) ----
  const payTo = typeof first.payTo === "string" ? first.payTo : null;
  const [validate, merchant] = await Promise.all([validateP, payTo ? getJson<any>(`${CDP}/discovery/merchant?payTo=${encodeURIComponent(payTo)}&limit=100`, 8000) : Promise.resolve(null)]);
  const mine = (merchant?.resources ?? []).find((x: any) => normUrl(String(x.resource)) === normUrl(resourceUrl ?? r.url));
  const queries = [...new Set([serviceName, ...tags.slice(0, 2)].map((s) => s.trim()).filter((s) => s.length >= 3))].slice(0, 3);
  const searchRanks = await Promise.all(
    queries.map(async (query) => {
      const s = await getJson<any>(`${CDP}/discovery/search?limit=20&query=${encodeURIComponent(query)}`, 8000);
      const rs: any[] = s?.resources ?? [];
      const i = rs.findIndex((x) => normUrl(String(x.resource)) === normUrl(resourceUrl ?? r.url));
      return { query, rank: i >= 0 ? i + 1 : null, of: rs.length, leader: rs[0] ? { resource: rs[0].resource, calls30d: rs[0].quality?.l30DaysTotalCalls ?? null, payers30d: rs[0].quality?.l30DaysUniquePayers ?? null } : null };
    }),
  );
  const stale: string[] = [];
  if (mine) {
    if ((mine.serviceName ?? "") !== serviceName) stale.push("serviceName");
    if (JSON.stringify(mine.tags ?? []) !== JSON.stringify(tags.slice(0, 5))) stale.push("tags");
    if ((mine.description ?? "") !== description) stale.push("description");
  }
  const bazaarListing = mine
    ? {
        listed: true,
        calls30d: mine.quality?.l30DaysTotalCalls ?? null,
        uniquePayers30d: mine.quality?.l30DaysUniquePayers ?? null,
        lastCalledAt: mine.quality?.lastCalledAt ?? null,
        lastUpdated: mine.lastUpdated ?? null,
        indexedServiceName: mine.serviceName ?? null,
        indexedTags: mine.tags ?? null,
        metadataStale: stale,
        ...(stale.length ? { staleNote: "Bazaar shows older metadata than the endpoint serves now; it refreshes after the next CDP-settled payment." } : {}),
      }
    : { listed: false, note: merchant ? "Not in the CDP Bazaar yet: listings appear after the first payment settled through the CDP facilitator, and drop after 30 days without one." : "Bazaar lookup unavailable" };
  add("bazaar_listed", !!mine, "ranking", mine ? `listed: ${mine?.quality?.l30DaysTotalCalls ?? 0} calls / ${mine?.quality?.l30DaysUniquePayers ?? 0} payers in 30 days` : "not listed in CDP Bazaar", "Complete one real paid call through the CDP facilitator to get indexed; ranking then grows with distinct buyers and recent calls.");
  const cdpValidator = validate
    ? {
        valid: validate.valid ?? null,
        simulation: validate.simulation?.outcome ?? null,
        indexed: validate.index?.active ?? null,
        lastCrawledAt: validate.index?.lastCrawledAt ?? null,
        failedRequired: (validate.preflight ?? []).filter((c: any) => !c.passed && c.severity === "required").map((c: any) => c.check),
        failedAdvisory: (validate.preflight ?? []).filter((c: any) => !c.passed && c.severity !== "required").map((c: any) => c.check),
      }
    : null;
  if (cdpValidator) add("cdp_validator", cdpValidator.valid === true, "required", `Coinbase validator: valid=${cdpValidator.valid}, simulation=${cdpValidator.simulation}${cdpValidator.failedRequired.length ? `, failed: ${cdpValidator.failedRequired.join(", ")}` : ""}`, "Fix the failed Coinbase preflight checks listed in cdpValidator.failedRequired.");

  const priceUsd = atomicOk ? Number(atomic) / 1e6 : null;
  const scored = checks.filter((c) => c.severity !== "advisory");
  const passed = scored.filter((c) => c.pass).length;
  const requiredFailed = checks.filter((c) => !c.pass && c.severity === "required");
  const score = Math.round((passed / scored.length) * 100);
  const grade = requiredFailed.length ? "F" : score >= 95 ? "A" : score >= 85 ? "B" : score >= 70 ? "C" : "D";
  const order = { required: 0, ranking: 1, advisory: 2 } as const;
  return {
    target: r.url,
    method,
    score,
    grade,
    passed,
    total: scored.length,
    indexable: requiredFailed.length === 0,
    serviceName: serviceName || null,
    priceUsdIfUsdc: priceUsd,
    networks: accepts.map((a) => a.network),
    latencyMs: r.ms,
    checks,
    fixes: checks
      .filter((c) => !c.pass)
      .sort((a, b) => order[a.severity] - order[b.severity])
      .map((c) => `[${c.severity}] ${c.id}: ${c.fix ?? c.detail}`),
    bazaarListing,
    searchRanks,
    cdpValidator,
    checkedAt: new Date().toISOString(),
    totalMs: Date.now() - started,
    note: "One unpaid probe from this service plus Coinbase's own free validator probe; nothing is ever paid to the target. Bazaar rank = relevance (name, tags, description) blended with 30-day unique buyers, settled calls, recency and metadata completeness, recomputed about every 6 hours.",
  };
}
