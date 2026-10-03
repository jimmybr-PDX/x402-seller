/**
 * x402 readiness check for someone else's endpoint. ONE unpaid probe, never pays.
 * Grades the 402 challenge against what CDP Bazaar and x402scan need to index and rank it.
 */
import { safeFetch } from "./net.js";

type Check = { id: string; pass: boolean; severity: "required" | "ranking"; detail: string };

export async function checkX402Endpoint(target: string, method: "GET" | "POST") {
  const r = await safeFetch(target, { method, timeoutMs: 15_000, maxBytes: 500_000, accept: "application/json" });
  const checks: Check[] = [];
  const add = (id: string, pass: boolean, severity: Check["severity"], detail: string) => checks.push({ id, pass, severity, detail });

  add("status_402", r.status === 402, "required", `HTTP ${r.status} (unpaid probe must return 402)`);
  add("latency_under_3s", r.ms < 3000, "ranking", `${r.ms} ms (slow or cold-start responses hurt availability ranking and agent timeouts)`);

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
  add("challenge_parseable", !!challenge, "required", hdr ? "PAYMENT-REQUIRED header (v2)" : challenge ? "JSON body (v1 style)" : "no parseable x402 challenge");
  add("x402_version_2", challenge?.x402Version === 2, "ranking", `x402Version=${challenge?.x402Version ?? "missing"}`);
  const accepts: any[] = Array.isArray(challenge?.accepts) ? challenge.accepts : [];
  add("accepts_non_empty", accepts.length > 0, "required", `${accepts.length} payment option(s)`);
  const first = accepts[0] ?? {};
  const atomic = first.amount ?? first.maxAmountRequired;
  const atomicOk = typeof atomic === "string" && /^\d+$/.test(atomic);
  add("amount_atomic_units", atomicOk, "required", atomicOk ? `${atomic} atomic units` : `amount=${JSON.stringify(atomic)} (must be an integer string; 0.01 USDC = "10000")`);
  add("pay_to_present", typeof first.payTo === "string" && first.payTo.length > 10, "required", String(first.payTo ?? "missing"));
  add("network_caip2", typeof first.network === "string" && first.network.includes(":"), "required", String(first.network ?? "missing"));
  const res = challenge?.resource ?? {};
  const resourceUrl: string | undefined = typeof res === "object" ? res.url : first.resource;
  add("resource_https", typeof resourceUrl === "string" && resourceUrl.startsWith("https://"), "required", String(resourceUrl ?? "missing"));
  const description: string = (typeof res === "object" ? res.description : "") || first.description || "";
  add("description_80_to_500_chars", description.length >= 80 && description.length <= 500, "ranking", `${description.length} chars (CDP rejects >500; short or placeholder text scores zero)`);
  add("mime_type_set", !!(res.mimeType || first.mimeType), "ranking", String(res.mimeType || first.mimeType || "empty"));
  add("service_name_set", typeof res.serviceName === "string" && res.serviceName.length > 0, "ranking", String(res.serviceName ?? "missing (resource.serviceName, <=32 ASCII chars)"));
  add("tags_set", Array.isArray(res.tags) && res.tags.length > 0, "ranking", Array.isArray(res.tags) ? res.tags.join(", ") : "missing (resource.tags, up to 5)");
  const bazaar = challenge?.extensions?.bazaar ?? first?.outputSchema;
  add("bazaar_extension", !!bazaar, "required", bazaar ? "extensions.bazaar present" : "missing: Bazaar cannot index input/output");
  const inp = bazaar?.info?.input;
  add("input_example", !!(inp && (inp.queryParams || inp.body || inp.pathParams || inp.toolName)), "ranking", inp ? "example input declared" : "no example input");
  const ex = bazaar?.info?.output?.example;
  const exFields = ex && typeof ex === "object" ? Object.keys(ex).length : 0;
  add("output_example_8_fields", exFields >= 8, "ranking", `${exFields} top-level fields in output example (top-ranked listings show 8+)`);
  const outSchema = bazaar?.schema?.properties?.output?.properties?.example ?? bazaar?.info?.output?.schema;
  add("output_schema", !!(outSchema && (outSchema.properties || outSchema.required)), "ranking", outSchema?.properties ? "typed output schema" : "output schema is untyped");

  const priceUsd = atomicOk ? Number(atomic) / 1e6 : null;
  const passed = checks.filter((c) => c.pass).length;
  const requiredFailed = checks.filter((c) => !c.pass && c.severity === "required").length;
  return {
    target: r.url,
    method,
    score: Math.round((passed / checks.length) * 100),
    passed,
    total: checks.length,
    indexable: requiredFailed === 0,
    priceUsdIfUsdc: priceUsd,
    network: first.network ?? null,
    latencyMs: r.ms,
    checks,
    fixes: checks.filter((c) => !c.pass).map((c) => `${c.id}: ${c.detail}`),
    checkedAt: new Date().toISOString(),
    note: "One unpaid probe; this service never pays the target.",
  };
}
