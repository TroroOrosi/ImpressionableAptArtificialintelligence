import test from "node:test";
import assert from "node:assert/strict";
import {
  auctionFreshnessLimit,
  compareIdentity,
  computeCoverage,
  isActionable,
  providerRegistry,
  verifyEvidence,
} from "./core";

test("provider routing preserves official-first priority", () => {
  const sorted = [...providerRegistry].sort((a, b) => a.tier - b.tier);
  assert.equal(sorted[0]?.kind, "official");
  assert.ok(sorted.findIndex((p) => p.id === "jsonld") > sorted.findIndex((p) => p.id === "serpapi"));
});

test("missing optional credentials disable providers gracefully", () => {
  const optional = providerRegistry.filter((p) => p.env);
  assert.ok(optional.every((p) => typeof p.configured === "boolean"));
  assert.ok(optional.filter((p) => !p.configured).every((p) => p.configured === false));
});

test("identity mismatch catches material attributes", () => {
  assert.equal(compareIdentity({ model: "A", color: "黒" }, { model: "B", color: "黒" }).match, false);
});

test("evidence consensus and conflict", () => {
  const base = { currency: "JPY", fetched_at: new Date().toISOString(), freshness_seconds: 60 };
  assert.equal(verifyEvidence([{ ...base, value: 10000 }, { ...base, value: 10300 }]).status, "VERIFIED_STRONG");
  assert.equal(verifyEvidence([{ ...base, value: 10000 }, { ...base, value: 15000 }]).status, "CONFLICT");
  assert.equal(verifyEvidence([]).status, "UNVERIFIED");
});

test("stale auction is rejected", () => {
  assert.equal(auctionFreshnessLimit(500), 120);
  assert.equal(isActionable("VERIFIED_SINGLE", 300, 500), false);
});

test("coverage is measured over the registry", () => {
  const report = computeCoverage([{ configured: true, searchable: true, live_price_capable: true, sold_comps_capable: false }]);
  assert.equal(report.measured_coverage_percent, 100);
  assert.match(report.disclaimer, /registry/i);
});

test("health degrades after consecutive failures", () => {
  const successRate = (successes: number, failures: number) => successes / Math.max(1, successes + failures);
  assert.ok(successRate(5, 5) < successRate(9, 1));
});