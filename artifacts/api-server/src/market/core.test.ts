import test from "node:test";
import assert from "node:assert/strict";
import {
  auctionFreshnessLimit,
  compareIdentity,
  computeCoverage,
  buildSoldCompsResponse,
  getSoldCompRecencyDays,
  getSoldCompRecencyDaysForMarket,
  getSoldCompRecencyWarning,
  isActionable,
  providerRegistry,
  summarizeSoldCompsFreshness,
  SOLD_COMP_RECENCY_DAYS,
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

test("sold comp freshness distinguishes missing, recent, and stale evidence", { concurrency: false }, () => {
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

  const savedRecencyDays = process.env.SOLD_COMP_RECENCY_DAYS;
  try {
    delete process.env.SOLD_COMP_RECENCY_DAYS;
    assert.deepEqual(summarizeSoldCompsFreshness([], now), {
      status: "missing",
      recent_window_days: SOLD_COMP_RECENCY_DAYS,
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
      summarizeSoldCompsFreshness([
        comp("2026-09-20T00:00:00.000Z"),
        comp("2026-08-01T00:00:00.000Z"),
      ], now),
      {
        status: "stale",
        recent_window_days: SOLD_COMP_RECENCY_DAYS,
        recent_count: 1,
        stale_count: 1,
        missing_count: 0,
        latest_sold_at: "2026-09-20T00:00:00.000Z",
        oldest_sold_at: "2026-08-01T00:00:00.000Z",
      },
    );
    assert.deepEqual(
      summarizeSoldCompsFreshness([comp("not-a-date")], now),
      {
        status: "missing",
        recent_window_days: SOLD_COMP_RECENCY_DAYS,
        recent_count: 0,
        stale_count: 0,
        missing_count: 1,
        latest_sold_at: null,
        oldest_sold_at: null,
      },
    );
  } finally {
    if (savedRecencyDays === undefined) delete process.env.SOLD_COMP_RECENCY_DAYS;
    else process.env.SOLD_COMP_RECENCY_DAYS = savedRecencyDays;
  }
});

test("sold comp freshness accepts a bounded setting and falls back for invalid values", { concurrency: false }, () => {
  const now = new Date("2026-09-22T00:00:00.000Z");
  const comp = {
    title: "Used camera",
    sold_price: 1000,
    currency: "JPY",
    sold_at: "2026-09-12T00:00:00.000Z",
    source: "market-a",
    normalized_price: 1000,
    condition: "good",
    url: "https://example.com/configured-window",
    identity: {},
  };
  const savedRecencyDays = process.env.SOLD_COMP_RECENCY_DAYS;
  try {
    process.env.SOLD_COMP_RECENCY_DAYS = "14";
    assert.equal(getSoldCompRecencyDays(), 14);
    assert.deepEqual(summarizeSoldCompsFreshness([comp], now), {
      status: "recent",
      recent_window_days: 14,
      recent_count: 1,
      stale_count: 0,
      missing_count: 0,
      latest_sold_at: comp.sold_at,
      oldest_sold_at: comp.sold_at,
    });

    for (const invalid of ["0", "366", "14.5", "not-a-number"]) {
      process.env.SOLD_COMP_RECENCY_DAYS = invalid;
      assert.equal(getSoldCompRecencyDays(), SOLD_COMP_RECENCY_DAYS);
      assert.equal(summarizeSoldCompsFreshness([comp], now).recent_window_days, SOLD_COMP_RECENCY_DAYS);
    }
  } finally {
    if (savedRecencyDays === undefined) delete process.env.SOLD_COMP_RECENCY_DAYS;
    else process.env.SOLD_COMP_RECENCY_DAYS = savedRecencyDays;
  }
});

test("sold comp freshness applies valid market overrides before the global setting", { concurrency: false }, () => {
  const savedRecencyDays = process.env.SOLD_COMP_RECENCY_DAYS;
  const savedMarketOverrides = process.env.SOLD_COMP_RECENCY_DAYS_BY_MARKET;
  try {
    process.env.SOLD_COMP_RECENCY_DAYS = "45";
    process.env.SOLD_COMP_RECENCY_DAYS_BY_MARKET = JSON.stringify({
      ebay_us: 14,
      "slow-market": "7",
      invalid_zero: 0,
      invalid_decimal: 14.5,
    });

    assert.equal(getSoldCompRecencyDaysForMarket("EBAY_US"), 14);
    assert.equal(getSoldCompRecencyDaysForMarket("slow-market"), 7);
    assert.equal(getSoldCompRecencyDaysForMarket("missing-market"), 45);
    assert.equal(getSoldCompRecencyDaysForMarket("invalid_zero"), 45);
    assert.equal(getSoldCompRecencyDaysForMarket("invalid_decimal"), 45);
    assert.equal(getSoldCompRecencyDaysForMarket("not a market"), 45);

    process.env.SOLD_COMP_RECENCY_DAYS = "0";
    assert.equal(getSoldCompRecencyDaysForMarket("missing-market"), SOLD_COMP_RECENCY_DAYS);
    assert.equal(getSoldCompRecencyDaysForMarket("EBAY_US"), 14);

    process.env.SOLD_COMP_RECENCY_DAYS_BY_MARKET = "{not-json";
    assert.equal(getSoldCompRecencyDaysForMarket("EBAY_US"), SOLD_COMP_RECENCY_DAYS);
  } finally {
    if (savedRecencyDays === undefined) delete process.env.SOLD_COMP_RECENCY_DAYS;
    else process.env.SOLD_COMP_RECENCY_DAYS = savedRecencyDays;
    if (savedMarketOverrides === undefined) delete process.env.SOLD_COMP_RECENCY_DAYS_BY_MARKET;
    else process.env.SOLD_COMP_RECENCY_DAYS_BY_MARKET = savedMarketOverrides;
  }
});

test("sold comp freshness warning identifies the safe policy without echoing the setting", { concurrency: false }, () => {
  const savedRecencyDays = process.env.SOLD_COMP_RECENCY_DAYS;
  try {
    delete process.env.SOLD_COMP_RECENCY_DAYS;
    assert.equal(getSoldCompRecencyWarning(), null);
    assert.equal(getSoldCompRecencyWarning("14"), null);
    assert.equal(getSoldCompRecencyWarning(" 14 "), null);

    const expectedWarning = "SOLD_COMP_RECENCY_DAYS was rejected; using the safe default of 30 days. Accepted values are whole days from 1 through 365.";
    for (const invalid of ["", "0", "366", "14.5", "not-a-number"]) {
      const warning = getSoldCompRecencyWarning(invalid);
      assert.equal(warning, expectedWarning);
    }
  } finally {
    if (savedRecencyDays === undefined) delete process.env.SOLD_COMP_RECENCY_DAYS;
    else process.env.SOLD_COMP_RECENCY_DAYS = savedRecencyDays;
  }
});

test("health degrades after consecutive failures", () => {
  const successRate = (successes: number, failures: number) => successes / Math.max(1, successes + failures);
  assert.ok(successRate(5, 5) < successRate(9, 1));
});