import { createHash } from "node:crypto";
import { desc, eq, ilike, or, sql } from "drizzle-orm";
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

export async function getStoredPriceHistory(query: string, limit = 100): Promise<Observation[]> {
  const normalizedQuery = query.trim();
  if (!normalizedQuery) return [];
  const database = await getDatabaseModule();
  if (!database) return [];

  try {
    const rows = await database.db
      .select()
      .from(database.marketObservations)
      .where(observationSearchWhere(database.marketObservations, normalizedQuery))
      .orderBy(desc(database.marketObservations.fetchedAt))
      .limit(Math.max(1, Math.min(250, Math.floor(limit))));
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
    const rows = await database.db
      .select()
      .from(database.marketObservations)
      .orderBy(desc(database.marketObservations.fetchedAt))
      .limit(Math.max(1, Math.min(250, Math.floor(limit))));
    return rows.map(mapObservation);
  } catch (error) {
    reportStorageFailure("read_observations", error);
    return [];
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
    const rows = await database.db
      .select()
      .from(database.marketSoldComps)
      .where(soldCompSearchWhere(database.marketSoldComps, normalizedQuery))
      .orderBy(desc(database.marketSoldComps.soldAt))
      .limit(Math.max(1, Math.min(250, Math.floor(limit))));
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