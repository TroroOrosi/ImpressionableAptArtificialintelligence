import assert from "node:assert/strict";
import test from "node:test";
import { getStoredPriceHistory, getStoredSoldComps, loadStoredProviderHealth, persistObservations, persistProviderHealth, persistSoldComps } from "./storage";
import type { Observation } from "./core";

test("market records survive a fresh database read with normalized values", { skip: !process.env.DATABASE_URL }, async () => {
  const [{ db, marketObservations, marketSoldComps, marketSourceHealth }, { eq }] = await Promise.all([
    import("@workspace/db"),
    import("drizzle-orm"),
  ]);
  const marker = `task2-persistence-${process.pid}-${Date.now()}`;
  const observation: Observation = {
    id: `${marker}-observation`,
    title: `Task 2 persistence ${marker}`,
    value: 15000,
    currency: "JPY",
    source: "task2-test",
    source_tier: 1,
    fetched_at: new Date().toISOString(),
    freshness_seconds: 0,
    remaining_seconds: null,
    confidence: 0.9,
    url: "https://example.com/task2-observation",
    evidence_hash: `${marker}-evidence`,
    identity: { model: marker },
    actionable: true,
  };

  try {
    await persistObservations([observation]);
    assert.equal(await persistSoldComps([{
      query: marker,
      title: `Sold ${marker}`,
      soldPrice: "100",
      currency: "USD",
      soldAt: "2026-09-19T10:00:00.000Z",
      source: "task2-market",
      condition: "brand new",
      url: "https://example.com/task2-sold",
      fees: { percent: 10 },
      shipping: 5,
      providerItemId: marker,
    }]), 1);
    await persistProviderHealth(marker, {
      ok: false,
      latencyMs: 123,
      observations: 0,
      error: "task2_test_failure",
    });

    const [history, soldComps, health] = await Promise.all([
      getStoredPriceHistory(marker),
      getStoredSoldComps(marker),
      loadStoredProviderHealth(),
    ]);
    assert.equal(history[0]?.evidence_hash, observation.evidence_hash);
    assert.equal(soldComps[0]?.normalized_price, 12750);
    assert.equal(soldComps[0]?.condition, "new");
    assert.equal(health.get(marker)?.lastError, "task2_test_failure");
    assert.equal(health.get(marker)?.lastLatencyMs, 123);
    assert.equal(health.get(marker)?.consecutiveFailures, 1);
  } finally {
    await Promise.all([
      db.delete(marketObservations).where(eq(marketObservations.id, observation.id)),
      db.delete(marketSoldComps).where(eq(marketSoldComps.queryKey, marker)),
      db.delete(marketSourceHealth).where(eq(marketSourceHealth.providerId, marker)),
    ]);
  }
});