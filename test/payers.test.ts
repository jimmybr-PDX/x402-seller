import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { recordPaidPayer, trafficStats, mergeSaved, sumDocs, _resetPayerDays } from "../src/lib/traffic.js";

const ptDay = (d = new Date()) => d.toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
const hash = (addr: string) => createHash("sha256").update(addr.trim().toLowerCase()).digest("hex").slice(0, 16);
const A = "0x1111111111111111111111111111111111111111";
const B = "0x2222222222222222222222222222222222222222";

test("payers: same wallet twice is one distinct payer; mixed case matches; raw address is not stored", () => {
  _resetPayerDays();
  recordPaidPayer(A);
  recordPaidPayer(A.toUpperCase());
  const s: any = trafficStats(["/price"], true);
  assert.equal(s.payers.today.datePT, ptDay());
  assert.equal(s.payers.today.paidCalls, 2);
  assert.equal(s.payers.today.distinctPayers, 1);
  assert.equal(s.payers.daily[0].datePT, ptDay());
  assert.equal(s.payers.daily[0].paidCalls, 2);
  assert.equal(s.payers.daily[0].distinctPayers, 1);
  const raw = JSON.stringify(s);
  assert.equal(raw.toLowerCase().includes(A.toLowerCase()), false);
});

test("payers: two wallets count as two; missing address still counts the paid call", () => {
  _resetPayerDays();
  recordPaidPayer(A);
  recordPaidPayer(B);
  recordPaidPayer(null);
  const s: any = trafficStats(["/price"], false);
  assert.equal(s.payers.today.paidCalls, 3);
  assert.equal(s.payers.today.distinctPayers, 2);
});

test("payers: existing today/daily UTC fields keep their shape", () => {
  _resetPayerDays();
  const s: any = trafficStats(["/price"], true);
  assert.equal(typeof s.today.date, "string");
  assert.ok(s.today.totals);
  assert.ok(Array.isArray(s.daily));
  if (s.daily.length) assert.equal(typeof s.daily[0].date, "string");
  assert.equal(typeof s.payers.today.datePT, "string");
  assert.ok(Array.isArray(s.payers.daily));
});

test("payers: merge unions hashed wallets and sums paidCalls; self-paid is never recorded here", () => {
  _resetPayerDays();
  const day = "2026-11-18";
  const d1 = { v: 1 as const, savedAt: "", trackingSince: "2026-10-01T00:00:00.000Z", hourly: [], daily: [], rejections: [], rejectionReasons: {}, payerDays: { [day]: { paidCalls: 5, payers: [hash(A)] } } };
  const d2 = { v: 1 as const, savedAt: "", trackingSince: "2026-10-01T00:00:00.000Z", hourly: [], daily: [], rejections: [], rejectionReasons: {}, payerDays: { [day]: { paidCalls: 3, payers: [hash(A), hash(B)] } } };
  const sum = sumDocs([d1, d2]);
  assert.equal(sum.payerDays?.[day]?.paidCalls, 8);
  assert.deepEqual(sum.payerDays?.[day]?.payers.sort(), [hash(A), hash(B)].sort());
  mergeSaved(d1);
  mergeSaved(d2);
  const s: any = trafficStats(["/price"], true);
  const row = s.payers.daily.find((x: any) => x.datePT === day);
  assert.equal(row.paidCalls, 8);
  assert.equal(row.distinctPayers, 2);
  assert.equal(JSON.stringify(sum).toLowerCase().includes(A.toLowerCase()), false);
});
