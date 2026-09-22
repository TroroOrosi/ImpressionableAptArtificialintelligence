import { createHash } from "node:crypto";
import { and, desc, eq, gte, ilike, inArray, lt, or, sql } from "drizzle-orm";
import { logger } from "../lib/logger";
import type {
  Identity,
  Observation,
  ProviderHealthOutcome,
  SoldCompRecord,
} from "./core";
import type {
  MarketObservation,
  MarketSoldComp,
  MarketSourceHealth,
} from "@workspace/db";

type DatabaseModule = typeof import("@workspace/db");

let databaseModulePromise: Promise<DatabaseModule | null> | undefined;

/**
 * Retention policy for the queryable market history.
 *
 * Observations are short-lived price evidence, so the API keeps six months of
 * fetched evidence. Sold comps are useful for longer valuation trends, so the
 * API keeps two years of completed-sale evidence. Older rows are removed by
 * the bounded cleanup job below rather than during a user request.
 */
export const DEFAULT_MARKET_HISTORY_RETENTION_DAYS = Object.freeze({
  observations: 180,
  soldComps: 730,
});

const DEFAULT_HISTORY_CLEANUP_BATCH_SIZE = 500;
const DEFAULT_HISTORY_CLEANUP_MAX_ROWS_PER_TABLE = 5_000;
const MAX_RETENTION_DAYS = 3_650;
const MAX_HISTORY_CLEANUP_BATCH_SIZE = 5_000;
const MAX_HISTORY_CLEANUP_ROWS_PER_TABLE = 100_000;

export type MarketHistoryPolicy = {
  observationRetentionDays: number;
  soldCompRetentionDays: number;
  cleanupBatchSize: number;
  cleanupMaxRowsPerTable: number;
};

function positiveIntegerSetting(
  name: string,
  fallback: number,
  maximum: number,
) {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value >= 1 && value <= maximum
    ? value
    : fallback;
}

/**
 * Resolve operational settings at call time so a process can validate a
 * deployment's environment without changing the safe defaults.
 */
export function getMarketHistoryPolicy(): MarketHistoryPolicy {
  return {
    observationRetentionDays: positiveIntegerSetting(
      "MARKET_OBSERVATION_RETENTION_DAYS",
      DEFAULT_MARKET_HISTORY_RETENTION_DAYS.observations,
      MAX_RETENTION_DAYS,
    ),
    soldCompRetentionDays: positiveIntegerSetting(
      "MARKET_SOLD_COMP_RETENTION_DAYS",
      DEFAULT_MARKET_HISTORY_RETENTION_DAYS.soldComps,
      MAX_RETENTION_DAYS,
    ),
    cleanupBatchSize: positiveIntegerSetting(
      "MARKET_HISTORY_CLEANUP_BATCH_SIZE",
      DEFAULT_HISTORY_CLEANUP_BATCH_SIZE,
      MAX_HISTORY_CLEANUP_BATCH_SIZE,
    ),
    cleanupMaxRowsPerTable: positiveIntegerSetting(
      "MARKET_HISTORY_CLEANUP_MAX_ROWS",
      DEFAULT_HISTORY_CLEANUP_MAX_ROWS_PER_TABLE,
      MAX_HISTORY_CLEANUP_ROWS_PER_TABLE,
    ),
  };
}

export type MarketHistoryCutoffs = {
  observations: Date;
  soldComps: Date;
};

export function getMarketHistoryCutoffs(
  now = new Date(),
  policy = getMarketHistoryPolicy(),
): MarketHistoryCutoffs {
  if (Number.isNaN(now.getTime())) {
    throw new Error("history cleanup requires a valid reference time");
  }

  return {
    observations: new Date(
      now.getTime() - policy.observationRetentionDays * 24 * 60 * 60 * 1_000,
    ),
    soldComps: new Date(
      now.getTime() - policy.soldCompRetentionDays * 24 * 60 * 60 * 1_000,
    ),
  };
}

async function getDatabaseModule(): Promise<DatabaseModule | null> {
  if (!process.env.DATABASE_URL) return null;
  databaseModulePromise ??= import("@workspace/db").catch((error: unknown) => {
    logger.warn({ err: error }, "Market persistence is unavailable");
    return null;
  });
  return databaseModulePromise;
}

function reportStorageFailure(operation: string, error: unknown) {
  logger.warn({ err: error, operation }, "Market persistence operation failed");
}

function asIso(value: Date | string) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? new Date(0).toISOString() : date.toISOString();
}

function parseAmount(value: unknown) {
  if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? value : null;
  if (typeof value !== "string") return null;
  const normalized = value.trim().replace(/[^\d.,+-]/g, "");
  if (!normalized) return null;
  const lastComma = normalized.lastIndexOf(",");
  const lastDot = normalized.lastIndexOf(".");
  const numeric = lastComma > lastDot
    ? normalized.replace(/\./g, "").replace(",", ".")
    : normalized.replace(/,/g, "");
  const parsed = Number(numeric);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function normalizedText(value: unknown) {
  if (typeof value !== "string" && typeof value !== "number") return "";
  return String(value).trim();
}

function normalizedCurrency(value: unknown) {
  return normalizedText(value).toUpperCase() || "JPY";
}

const currencyToJpy: Record<string, number> = {
  JPY: 1,
  USD: 150,
  EUR: 165,
  GBP: 190,
  CNY: 21,
  KRW: 0.11,
  TWD: 4.7,
  HKD: 19,
  SGD: 112,
  AUD: 98,
  CAD: 110,
};

function normalizeCondition(value: unknown) {
  const condition = normalizedText(value).toLowerCase();
  if (!condition) return "unknown";
  if (/brand[\s_-]*new|new|新品|未使用|sealed/.test(condition)) return "new";
  if (/mint|like[\s_-]*new|美品/.test(condition)) return "like_new";
  if (/very[\s_-]*good|good|used|良品|中古/.test(condition)) return "good";
  if (/fair|可|使用感/.test(condition)) return "fair";
  if (/poor|damaged|junk|ジャンク|難あり/.test(condition)) return "poor";
  return condition.replace(/\s+/g, "_").slice(0, 80) || "unknown";
}

function normalizeIdentity(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { accessories: [] };
  const result: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (Array.isArray(raw)) {
      const items = raw
        .map((item) => normalizedText(item))
        .filter(Boolean);
      if (items.length) result[key] = items;
      continue;
    }
    const item = normalizedText(raw);
    if (item) result[key] = item;
  }
  if (!result.accessories) result.accessories = [];
  return result;
}

function observationValues(observation: Observation) {
  return {
    id: observation.id,
    title: observation.title,
    value: observation.value,
    currency: observation.currency.toUpperCase(),
    source: observation.source,
    sourceTier: observation.source_tier,
    fetchedAt: new Date(observation.fetched_at),
    freshnessSeconds: observation.freshness_seconds,
    remainingSeconds: observation.remaining_seconds ?? null,
    confidence: observation.confidence,
    url: observation.url,
    evidenceHash: observation.evidence_hash,
    identity: normalizeIdentity(observation.identity),
    actionable: observation.actionable,
  };
}

export async function persistObservations(observations: Observation[]) {
  if (!observations.length) return;
  const database = await getDatabaseModule();
  if (!database) return;

  try {
    await database.db
      .insert(database.marketObservations)
      .values(observations.map(observationValues))
      .onConflictDoNothing();
  } catch (error) {
    reportStorageFailure("persist_observations", error);
  }
}

function mapObservation(row: MarketObservation): Observation {
  return {
    id: row.id,
    title: row.title,
    value: Number(row.value),
    currency: row.currency,
    source: row.source,
    source_tier: row.sourceTier,
    fetched_at: asIso(row.fetchedAt),
    freshness_seconds: row.freshnessSeconds,
    remaining_seconds: row.remainingSeconds,
    confidence: Number(row.confidence),
    url: row.url,
    evidence_hash: row.evidenceHash,
    identity: row.identity as Identity,
    actionable: row.actionable,
  };
}

function searchPattern(query: string) {
  return `%${query.trim()}%`;
}

function observationSearchWhere(
  table: DatabaseModule["marketObservations"],
  query: string,
) {
  const pattern = searchPattern(query);
  return or(
    eq(table.id, query),
    ilike(table.title, pattern),
    sql`${table.identity}::text ILIKE ${pattern}`,
  );
}

function boundedHistoryLimit(limit: number) {
  return Number.isFinite(limit)
    ? Math.max(1, Math.min(250, Math.floor(limit)))
    : 100;
}

export async function getStoredPriceHistory(query: string, limit = 100): Promise<Observation[]> {
  const normalizedQuery = query.trim();
  if (!normalizedQuery) return [];
  const database = await getDatabaseModule();
  if (!database) return [];

  try {
    const { observations: cutoff } = getMarketHistoryCutoffs();
    const rows = await database.db
      .select()
      .from(database.marketObservations)
      .where(and(
        gte(database.marketObservations.fetchedAt, cutoff),
        observationSearchWhere(database.marketObservations, normalizedQuery),
      ))
      .orderBy(desc(database.marketObservations.fetchedAt))
      .limit(boundedHistoryLimit(limit));
    return rows.map(mapObservation);
  } catch (error) {
    reportStorageFailure("read_price_history", error);
    return [];
  }
}

export async function getStoredObservations(limit = 100): Promise<Observation[]> {
  const database = await getDatabaseModule();
  if (!database) return [];

  try {
    const { observations: cutoff } = getMarketHistoryCutoffs();
    const rows = await database.db
      .select()
      .from(database.marketObservations)
      .where(gte(database.marketObservations.fetchedAt, cutoff))
      .orderBy(desc(database.marketObservations.fetchedAt))
      .limit(boundedHistoryLimit(limit));
    return rows.map(mapObservation);
  } catch (error) {
    reportStorageFailure("read_observations", error);
    return [];
  }
}

export type MarketHistoryCleanupResult = {
  status: "completed" | "unavailable";
  dryRun: boolean;
  policy: MarketHistoryPolicy;
  cutoffs: {
    observations: string;
    soldComps: string;
  };
  observationsDeleted: number;
  soldCompsDeleted: number;
  observationsWouldDelete: number | null;
  soldCompsWouldDelete: number | null;
  observationsRemaining: boolean;
  soldCompsRemaining: boolean;
  durationMs: number;
};

async function countOldObservations(
  database: DatabaseModule,
  cutoff: Date,
) {
  const [row] = await database.db
    .select({ count: sql<number>`count(*)` })
    .from(database.marketObservations)
    .where(lt(database.marketObservations.fetchedAt, cutoff));
  return Number(row?.count ?? 0);
}

async function countOldSoldComps(
  database: DatabaseModule,
  cutoff: Date,
) {
  const [row] = await database.db
    .select({ count: sql<number>`count(*)` })
    .from(database.marketSoldComps)
    .where(lt(database.marketSoldComps.soldAt, cutoff));
  return Number(row?.count ?? 0);
}

async function deleteOldObservations(
  database: DatabaseModule,
  cutoff: Date,
  batchSize: number,
  maxRows: number,
) {
  let deleted = 0;
  const maxBatches = Math.ceil(maxRows / batchSize) + 1;

  for (let batch = 0; deleted < maxRows && batch < maxBatches; batch += 1) {
    const requested = Math.min(batchSize, maxRows - deleted);
    const removed = await database.db.transaction(async (transaction) => {
      const candidates = await transaction
        .select({ id: database.marketObservations.id })
        .from(database.marketObservations)
        .where(lt(database.marketObservations.fetchedAt, cutoff))
        .orderBy(database.marketObservations.fetchedAt)
        .limit(requested);
      if (!candidates.length) return 0;

      const result = await transaction
        .delete(database.marketObservations)
        .where(and(
          inArray(
            database.marketObservations.id,
            candidates.map((candidate) => candidate.id),
          ),
          lt(database.marketObservations.fetchedAt, cutoff),
        ))
        .returning({ id: database.marketObservations.id });
      return result.length;
    });

    deleted += removed;
    if (!removed) break;
  }

  const [next] = await database.db
    .select({ id: database.marketObservations.id })
    .from(database.marketObservations)
    .where(lt(database.marketObservations.fetchedAt, cutoff))
    .limit(1);

  return { deleted, hasMore: Boolean(next) };
}

async function deleteOldSoldComps(
  database: DatabaseModule,
  cutoff: Date,
  batchSize: number,
  maxRows: number,
) {
  let deleted = 0;
  const maxBatches = Math.ceil(maxRows / batchSize) + 1;

  for (let batch = 0; deleted < maxRows && batch < maxBatches; batch += 1) {
    const requested = Math.min(batchSize, maxRows - deleted);
    const removed = await database.db.transaction(async (transaction) => {
      const candidates = await transaction
        .select({ id: database.marketSoldComps.id })
        .from(database.marketSoldComps)
        .where(lt(database.marketSoldComps.soldAt, cutoff))
        .orderBy(database.marketSoldComps.soldAt)
        .limit(requested);
      if (!candidates.length) return 0;

      const result = await transaction
        .delete(database.marketSoldComps)
        .where(and(
          inArray(
            database.marketSoldComps.id,
            candidates.map((candidate) => candidate.id),
          ),
          lt(database.marketSoldComps.soldAt, cutoff),
        ))
        .returning({ id: database.marketSoldComps.id });
      return result.length;
    });

    deleted += removed;
    if (!removed) break;
  }

  const [next] = await database.db
    .select({ id: database.marketSoldComps.id })
    .from(database.marketSoldComps)
    .where(lt(database.marketSoldComps.soldAt, cutoff))
    .limit(1);

  return { deleted, hasMore: Boolean(next) };
}

/**
 * Remove only evidence outside the configured windows.
 *
 * Each table is cleaned in small transactions and capped per invocation. The
 * second date predicate on each DELETE protects against a row changing after
 * candidate selection, and source health is intentionally not queried here.
 */
export async function cleanupMarketHistory(options: {
  dryRun?: boolean;
  now?: Date;
} = {}): Promise<MarketHistoryCleanupResult> {
  const startedAt = Date.now();
  const policy = getMarketHistoryPolicy();
  const cutoffs = getMarketHistoryCutoffs(options.now, policy);
  const dryRun = options.dryRun === true;
  const baseResult = {
    status: "completed" as const,
    dryRun,
    policy,
    cutoffs: {
      observations: cutoffs.observations.toISOString(),
      soldComps: cutoffs.soldComps.toISOString(),
    },
    observationsDeleted: 0,
    soldCompsDeleted: 0,
    observationsWouldDelete: null as number | null,
    soldCompsWouldDelete: null as number | null,
    observationsRemaining: false,
    soldCompsRemaining: false,
    durationMs: 0,
  };

  const database = await getDatabaseModule();
  if (!database) {
    return {
      ...baseResult,
      status: "unavailable",
      durationMs: Date.now() - startedAt,
    };
  }

  try {
    if (dryRun) {
      const [observationsWouldDelete, soldCompsWouldDelete] = await Promise.all([
        countOldObservations(database, cutoffs.observations),
        countOldSoldComps(database, cutoffs.soldComps),
      ]);
      const result = {
        ...baseResult,
        observationsWouldDelete,
        soldCompsWouldDelete,
        observationsRemaining: observationsWouldDelete > 0,
        soldCompsRemaining: soldCompsWouldDelete > 0,
        durationMs: Date.now() - startedAt,
      };
      logger.info(result, "Market history cleanup dry run completed");
      return result;
    }

    const observations = await deleteOldObservations(
      database,
      cutoffs.observations,
      policy.cleanupBatchSize,
      policy.cleanupMaxRowsPerTable,
    );
    const soldComps = await deleteOldSoldComps(
      database,
      cutoffs.soldComps,
      policy.cleanupBatchSize,
      policy.cleanupMaxRowsPerTable,
    );
    const result = {
      ...baseResult,
      observationsDeleted: observations.deleted,
      soldCompsDeleted: soldComps.deleted,
      observationsRemaining: observations.hasMore,
      soldCompsRemaining: soldComps.hasMore,
      durationMs: Date.now() - startedAt,
    };
    logger.info(result, "Market history cleanup completed");
    return result;
  } catch (error) {
    reportStorageFailure("cleanup_market_history", error);
    throw error;
  }
}

export type SoldCompInput = {
  id?: unknown;
  query?: unknown;
  title: unknown;
  soldPrice?: unknown;
  sold_price?: unknown;
  currency?: unknown;
  soldAt?: unknown;
  sold_at?: unknown;
  source: unknown;
  condition?: unknown;
  url: unknown;
  identity?: Identity;
  providerItemId?: unknown;
  evidenceHash?: unknown;
  evidence_hash?: unknown;
  fees?: unknown;
  fee?: unknown;
  feeAmount?: unknown;
  fee_amount?: unknown;
  feeRate?: unknown;
  fee_rate?: unknown;
  feePercent?: unknown;
  shipping?: unknown;
  shippingAmount?: unknown;
  shipping_amount?: unknown;
};

function objectValue(value: unknown, ...keys: string[]) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  for (const key of keys) {
    const candidate = (value as Record<string, unknown>)[key];
    if (candidate !== undefined && candidate !== null) return candidate;
  }
  return undefined;
}

function feeAmountFrom(input: SoldCompInput, gross: number) {
  const feeRate = parseAmount(
    input.feeRate
      ?? input.fee_rate
      ?? input.feePercent
      ?? objectValue(input.fees, "rate", "percent", "percentage"),
  );
  if (feeRate != null) {
    return gross * (feeRate > 1 ? feeRate / 100 : feeRate);
  }

  const rawFee = input.feeAmount
    ?? input.fee_amount
    ?? input.fees
    ?? input.fee;
  const amount = parseAmount(objectValue(rawFee, "amount", "value") ?? rawFee);
  if (amount == null) return 0;
  if (amount > 0 && amount <= 1 && typeof rawFee === "number") return gross * amount;
  return amount;
}

function shippingAmountFrom(input: SoldCompInput) {
  const rawShipping = input.shippingAmount ?? input.shipping_amount ?? input.shipping;
  return parseAmount(objectValue(rawShipping, "amount", "value") ?? rawShipping) ?? 0;
}

function soldCompHash(input: {
  source: string;
  providerItemId: string;
  url: string;
  soldAt: string;
  price: number;
  currency: string;
}) {
  return createHash("sha256")
    .update(JSON.stringify([
      input.source,
      input.providerItemId || input.url,
      input.soldAt,
      input.price,
      input.currency,
    ]))
    .digest("hex");
}

function normalizeSoldComp(input: SoldCompInput) {
  const title = normalizedText(input.title);
  const source = normalizedText(input.source);
  const url = normalizedText(input.url);
  const price = parseAmount(input.soldPrice ?? input.sold_price);
  const currency = normalizedCurrency(input.currency);
  const soldAtRaw = normalizedText(input.soldAt ?? input.sold_at);
  const soldAt = new Date(soldAtRaw);
  const fxRate = currencyToJpy[currency];
  if (
    !title
    || !source
    || !url
    || !/^https?:\/\//i.test(url)
    || price == null
    || price <= 0
    || Number.isNaN(soldAt.getTime())
    || fxRate == null
  ) {
    return null;
  }

  const feeAmount = Math.min(price, Math.max(0, feeAmountFrom(input, price)));
  const shippingAmount = Math.min(price - feeAmount, Math.max(0, shippingAmountFrom(input)));
  const normalizedPrice = Math.max(0, (price - feeAmount - shippingAmount) * fxRate);
  const providerItemId = normalizedText(input.providerItemId);
  const evidenceHash = normalizedText(input.evidenceHash ?? input.evidence_hash)
    || soldCompHash({
      source,
      providerItemId,
      url,
      soldAt: soldAt.toISOString(),
      price,
      currency,
    });
  const queryKey = normalizedText(input.query) || title;
  const id = normalizedText(input.id) || evidenceHash;

  return {
    id,
    queryKey,
    title,
    soldPrice: price,
    currency,
    soldAt,
    source,
    normalizedPrice: Math.round(normalizedPrice * 100) / 100,
    condition: normalizeCondition(input.condition),
    url,
    feeAmount,
    shippingAmount,
    identity: normalizeIdentity(input.identity),
    evidenceHash,
  };
}

export function normalizeSoldCompRecord(input: SoldCompInput): SoldCompRecord | null {
  const normalized = normalizeSoldComp(input);
  if (!normalized) return null;
  return {
    title: normalized.title,
    sold_price: normalized.soldPrice,
    currency: normalized.currency,
    sold_at: normalized.soldAt.toISOString(),
    source: normalized.source,
    normalized_price: normalized.normalizedPrice,
    condition: normalized.condition,
    url: normalized.url,
    identity: normalized.identity as Identity,
  };
}

export async function persistSoldComps(inputs: SoldCompInput[]) {
  if (!inputs.length) return 0;
  const database = await getDatabaseModule();
  if (!database) return 0;
  const values = inputs
    .map(normalizeSoldComp)
    .filter((value): value is NonNullable<typeof value> => Boolean(value));
  if (!values.length) return 0;

  try {
    const inserted = await database.db
      .insert(database.marketSoldComps)
      .values(values)
      .onConflictDoNothing()
      .returning({ id: database.marketSoldComps.id });
    return inserted.length;
  } catch (error) {
    reportStorageFailure("persist_sold_comps", error);
    return 0;
  }
}

function mapSoldComp(row: MarketSoldComp): SoldCompRecord {
  return {
    title: row.title,
    sold_price: Number(row.soldPrice),
    currency: row.currency,
    sold_at: asIso(row.soldAt),
    source: row.source,
    normalized_price: Number(row.normalizedPrice),
    condition: row.condition,
    url: row.url,
    identity: normalizeIdentity(row.identity) as Identity,
  };
}

function soldCompSearchWhere(
  table: DatabaseModule["marketSoldComps"],
  query: string,
) {
  const pattern = searchPattern(query);
  return or(
    ilike(table.queryKey, pattern),
    ilike(table.title, pattern),
    sql`${table.identity}::text ILIKE ${pattern}`,
  );
}

export async function getStoredSoldComps(query: string, limit = 100): Promise<SoldCompRecord[]> {
  const normalizedQuery = query.trim();
  if (!normalizedQuery) return [];
  const database = await getDatabaseModule();
  if (!database) return [];

  try {
    const { soldComps: cutoff } = getMarketHistoryCutoffs();
    const rows = await database.db
      .select()
      .from(database.marketSoldComps)
      .where(and(
        gte(database.marketSoldComps.soldAt, cutoff),
        soldCompSearchWhere(database.marketSoldComps, normalizedQuery),
      ))
      .orderBy(desc(database.marketSoldComps.soldAt))
      .limit(boundedHistoryLimit(limit));
    return rows.map(mapSoldComp);
  } catch (error) {
    reportStorageFailure("read_sold_comps", error);
    return [];
  }
}

export type PersistedProviderHealth = {
  attempts: number;
  successes: number;
  failures: number;
  observations: number;
  lastSuccessAt: string | null;
  lastError: string | null;
  lastLatencyMs: number;
  consecutiveFailures: number;
};

function mapProviderHealth(row: MarketSourceHealth): PersistedProviderHealth {
  return {
    attempts: row.attempts,
    successes: row.successes,
    failures: row.failures,
    observations: row.observations,
    lastSuccessAt: row.lastSuccessAt ? asIso(row.lastSuccessAt) : null,
    lastError: row.lastError,
    lastLatencyMs: row.lastLatencyMs,
    consecutiveFailures: row.consecutiveFailures,
  };
}

export async function loadStoredProviderHealth() {
  const database = await getDatabaseModule();
  if (!database) return new Map<string, PersistedProviderHealth>();

  try {
    const rows = await database.db.select().from(database.marketSourceHealth);
    return new Map(rows.map((row) => [row.providerId, mapProviderHealth(row)]));
  } catch (error) {
    reportStorageFailure("read_source_health", error);
    return new Map<string, PersistedProviderHealth>();
  }
}

export async function persistProviderHealth(
  providerId: string,
  outcome: ProviderHealthOutcome,
) {
  const database = await getDatabaseModule();
  if (!database) return;

  const table = database.marketSourceHealth;
  const now = new Date();
  const latencyMs = Math.max(0, Math.round(outcome.latencyMs));
  const observations = Math.max(0, Math.round(outcome.observations));
  const errorMessage = outcome.error || "provider_request_failed";

  try {
    await database.db
      .insert(table)
      .values({
        providerId,
        attempts: 1,
        successes: outcome.ok ? 1 : 0,
        failures: outcome.ok ? 0 : 1,
        observations,
        lastSuccessAt: outcome.ok ? now : null,
        lastError: outcome.ok ? null : errorMessage,
        lastLatencyMs: latencyMs,
        consecutiveFailures: outcome.ok ? 0 : 1,
      })
      .onConflictDoUpdate({
        target: table.providerId,
        set: {
          attempts: sql`${table.attempts} + 1`,
          successes: sql`${table.successes} + ${outcome.ok ? 1 : 0}`,
          failures: sql`${table.failures} + ${outcome.ok ? 0 : 1}`,
          observations: sql`${table.observations} + ${observations}`,
          lastLatencyMs: latencyMs,
          updatedAt: now,
          ...(outcome.ok
            ? { lastSuccessAt: now, lastError: null, consecutiveFailures: 0 }
            : {
              lastError: errorMessage,
              consecutiveFailures: sql`${table.consecutiveFailures} + 1`,
            }),
        },
      });
  } catch (error) {
    reportStorageFailure("persist_source_health", error);
  }
}