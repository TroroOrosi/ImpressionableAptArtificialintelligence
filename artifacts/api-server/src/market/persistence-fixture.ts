import { db, pool } from "@workspace/db";
import { sql } from "drizzle-orm";
import {
  ensureProviderHealthLoaded,
  getProviderHealth,
  recordProviderHealth,
  type Observation,
} from "./core";
import {
  cleanupMarketHistory,
  getStoredPriceHistory,
  getStoredSoldComps,
  loadStoredProviderHealth,
  persistObservations,
  persistSoldComps,
} from "./storage";

const mode = process.argv[2];

function requiredMarker() {
  const value = process.env.MARKET_TEST_MARKER;
  if (!value) {
    throw new Error("MARKET_TEST_MARKER is required");
  }
  return value;
}

const marker = requiredMarker();

const observation: Observation = {
  id: `${marker}-observation`,
  title: `Restart fixture ${marker}`,
  value: 15000,
  currency: "jpy",
  source: "restart-fixture",
  source_tier: 1,
  fetched_at: "2026-09-19T10:00:00.000Z",
  freshness_seconds: 42,
  remaining_seconds: 600,
  confidence: 0.875,
  url: "https://example.com/restart-fixture-observation",
  evidence_hash: `${marker}-observation-evidence`,
  identity: {
    model: ` ${marker} `,
    accessories: [" strap ", ""],
  },
  actionable: true,
};

async function createTables() {
  const statements = [
    `
      CREATE TABLE market_observations (
        id text PRIMARY KEY,
        title text NOT NULL,
        value double precision NOT NULL,
        currency text NOT NULL,
        source text NOT NULL,
        source_tier integer NOT NULL,
        fetched_at timestamptz NOT NULL,
        freshness_seconds integer NOT NULL,
        remaining_seconds integer,
        confidence double precision NOT NULL,
        url text NOT NULL,
        evidence_hash text NOT NULL,
        identity jsonb NOT NULL,
        actionable boolean NOT NULL DEFAULT true,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `,
    "CREATE UNIQUE INDEX market_observations_evidence_hash_idx ON market_observations (evidence_hash)",
    "CREATE INDEX market_observations_fetched_at_idx ON market_observations (fetched_at)",
    "CREATE INDEX market_observations_title_idx ON market_observations (title)",
    `
      CREATE TABLE market_sold_comps (
        id text PRIMARY KEY,
        query_key text NOT NULL,
        title text NOT NULL,
        sold_price double precision NOT NULL,
        currency text NOT NULL,
        sold_at timestamptz NOT NULL,
        source text NOT NULL,
        normalized_price double precision NOT NULL,
        condition text NOT NULL DEFAULT 'unknown',
        url text NOT NULL,
        fee_amount double precision NOT NULL DEFAULT 0,
        shipping_amount double precision NOT NULL DEFAULT 0,
        identity jsonb NOT NULL,
        evidence_hash text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `,
    "CREATE UNIQUE INDEX market_sold_comps_evidence_hash_idx ON market_sold_comps (evidence_hash)",
    "CREATE INDEX market_sold_comps_query_key_idx ON market_sold_comps (query_key)",
    "CREATE INDEX market_sold_comps_sold_at_idx ON market_sold_comps (sold_at)",
    "CREATE INDEX market_sold_comps_title_idx ON market_sold_comps (title)",
    `
      CREATE TABLE market_source_health (
        provider_id text PRIMARY KEY,
        attempts integer NOT NULL DEFAULT 0,
        successes integer NOT NULL DEFAULT 0,
        failures integer NOT NULL DEFAULT 0,
        observations integer NOT NULL DEFAULT 0,
        last_success_at timestamptz,
        last_error text,
        last_latency_ms integer NOT NULL DEFAULT 0,
        consecutive_failures integer NOT NULL DEFAULT 0,
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `,
    "CREATE INDEX market_source_health_updated_at_idx ON market_source_health (updated_at)",
  ];

  for (const statement of statements) {
    await db.execute(sql.raw(statement));
  }
}

async function writeRecords() {
  await persistObservations([observation]);
  const inserted = await persistSoldComps([{
    query: marker,
    title: `Sold ${marker}`,
    soldPrice: "100",
    currency: "USD",
    soldAt: "2026-09-19T10:00:00.000Z",
    source: "restart-fixture-market",
    condition: "brand new",
    url: "https://example.com/restart-fixture-sold",
    fees: { percent: 10 },
    shipping: 5,
    providerItemId: marker,
    identity: {
      model: ` ${marker} `,
      accessories: [" strap ", ""],
    },
  }]);

   if (inserted.accepted !== 1) {
     throw new Error(`Expected one sold comp, inserted ${inserted.accepted}`);
  }

  await recordProviderHealth(marker, {
    ok: false,
    latencyMs: 123.4,
    observations: 2,
    error: "timeout",
    failureType: "timeout",
  });
}

async function seedOldRecordsAndCleanup() {
  await db.execute(sql`
    INSERT INTO market_observations (
      id, title, value, currency, source, source_tier, fetched_at,
      freshness_seconds, remaining_seconds, confidence, url, evidence_hash,
      identity, actionable
    ) VALUES (
      ${`${marker}-old-observation`},
      ${`Old restart fixture ${marker}`},
      12000,
      'JPY',
      'restart-fixture-old',
      1,
      ${new Date("2010-01-01T00:00:00.000Z")},
      42,
      NULL,
      0.5,
      ${`https://example.com/${marker}/old-observation`},
      ${`${marker}-old-observation-evidence`},
      ${JSON.stringify({ model: marker, accessories: [] })}::jsonb,
      true
    )
  `);
  await db.execute(sql`
    INSERT INTO market_sold_comps (
      id, query_key, title, sold_price, currency, sold_at, source,
      normalized_price, condition, url, fee_amount, shipping_amount,
      identity, evidence_hash
    ) VALUES (
      ${`${marker}-old-sold`},
      ${marker},
      ${`Old sold ${marker}`},
      80,
      'USD',
      ${new Date("2010-01-01T00:00:00.000Z")},
      'restart-fixture-old',
      10000,
      'good',
      ${`https://example.com/${marker}/old-sold`},
      0,
      0,
      ${JSON.stringify({ model: marker, accessories: [] })}::jsonb,
      ${`${marker}-old-sold-evidence`}
    )
  `);

  const result = await cleanupMarketHistory({
    now: new Date("2026-09-22T12:00:00.000Z"),
  });
  console.log(JSON.stringify(result));
}

async function readRecords() {
  const [history, soldComps, persistedHealth] = await Promise.all([
    getStoredPriceHistory(marker),
    getStoredSoldComps(marker),
    loadStoredProviderHealth(),
  ]);
  await ensureProviderHealthLoaded();

  console.log(JSON.stringify({
    history: history.records,
    soldComps: soldComps.records,
    historyPersistenceStatus: history.status,
    soldCompsPersistenceStatus: soldComps.status,
    persistedHealth: persistedHealth.get(marker),
    coreHealth: getProviderHealth(marker),
  }));
}

try {
  if (mode === "setup") {
    await createTables();
  } else if (mode === "write") {
    await writeRecords();
  } else if (mode === "cleanup") {
    await seedOldRecordsAndCleanup();
  } else if (mode === "read") {
    await readRecords();
  } else {
    throw new Error(`Unknown persistence fixture mode: ${mode || "(missing)"}`);
  }
} finally {
  await pool.end();
}