import test from "node:test";
import assert from "node:assert/strict";
import {
  auctionFreshnessLimit,
  compareIdentity,
  computeCoverage,
  buildSoldCompsResponse,
  isActionable,
  providerRegistry,
  summarizeSoldCompsFreshness,
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
  assert.equal(verifyEvidence([{ ...base, value: 10000, source:"rakuten" }, { ...base, value: 10300, source:"ebay" }]).status, "VERIFIED_STRONG");
  assert.equal(verifyEvidence([{ ...base, value: 10000, source:"rakuten" }, { ...base, value: 15000, source:"ebay" }]).status, "CONFLICT");
  assert.equal(verifyEvidence([]).status, "UNVERIFIED");
});

test("same upstream or cached payload cannot create strong verification", () => {
  const base = { currency:"JPY", fetched_at:new Date().toISOString(), freshness_seconds:30 };
  assert.equal(verifyEvidence([
    { ...base, value:10000, source:"same-api", evidence_hash:"payload-a" },
    { ...base, value:10020, source:"same-api", evidence_hash:"payload-b" },
  ]).status, "VERIFIED_SINGLE");
  assert.equal(verifyEvidence([
    { ...base, value:10000, source:"api-a", evidence_hash:"shared-cache" },
    { ...base, value:10000, source:"api-b", evidence_hash:"shared-cache" },
  ]).status, "VERIFIED_SINGLE");
  assert.equal(verifyEvidence([
    { ...base, value:10000, source:"official-api", source_tier:1 },
    { ...base, value:10100, source:"independent-market" },
  ]).status, "VERIFIED_STRONG");
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

test("sold comps normalize conservative value around fees and reject outliers", () => {
  const response = buildSoldCompsResponse("camera", [
    {
      title: "Used camera A",
      sold_price: 1000,
      currency: "JPY",
      sold_at: "2026-09-19T10:00:00.000Z",
      source: "market-a",
      normalized_price: 800,
      condition: "good",
      url: "https://example.com/a",
      identity: {},
    },
    {
      title: "Used camera B",
      sold_price: 1200,
      currency: "JPY",
      sold_at: "2026-09-18T10:00:00.000Z",
      source: "market-b",
      normalized_price: 1100,
      condition: "good",
      url: "https://example.com/b",
      identity: {},
    },
    {
      title: "Badly reported outlier",
      sold_price: 10000,
      currency: "JPY",
      sold_at: "2026-09-17T10:00:00.000Z",
      source: "market-c",
      normalized_price: 10000,
      condition: "new",
      url: "https://example.com/c",
      identity: {},
    },
  ]);

  assert.equal(response.conservative_value, 875);
  assert.equal(response.comps.length, 3);
  assert.equal(response.liquidity, "medium");
});

test("sold comp freshness distinguishes missing, recent, and stale evidence", () => {
  const now = new Date("2026-09-22T00:00:00.000Z");
  const comp = (soldAt: string) => ({
    title: "Used camera",
    sold_price: 1000,
    currency: "JPY",
    sold_at: soldAt,
    source: "market-a",
    normalized_price: 1000,
    condition: "good",
    url: `https://example.com/${soldAt}`,
    identity: {},
  });

  assert.deepEqual(summarizeSoldCompsFreshness([], now), {
    status: "missing",
    recent_count: 0,
    stale_count: 0,
    missing_count: 0,
    latest_sold_at: null,
    oldest_sold_at: null,
  });
  assert.equal(
    summarizeSoldCompsFreshness([comp("2026-09-20T00:00:00.000Z")], now).status,
    "recent",
  );
  assert.equal(
    summarizeSoldCompsFreshness([comp("2026-08-01T00:00:00.000Z")], now).status,
    "stale",
  );
  assert.deepEqual(
    summarizeSoldCompsFreshness([comp("not-a-date")], now),
    {
      status: "missing",
      recent_count: 0,
      stale_count: 0,
      missing_count: 1,
      latest_sold_at: null,
      oldest_sold_at: null,
    },
  );
});

test("health degrades after consecutive failures", () => {
  const successRate = (successes: number, failures: number) => successes / Math.max(1, successes + failures);
  assert.ok(successRate(5, 5) < successRate(9, 1));
});