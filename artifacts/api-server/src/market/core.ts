import { createHash } from "node:crypto";
import {
  loadStoredProviderHealth,
  persistProviderHealth,
  type MarketPersistenceStatus,
} from "./storage";

export type VerificationStatus = "VERIFIED_STRONG" | "VERIFIED_SINGLE" | "CONFLICT" | "STALE" | "UNVERIFIED";
export type Identity = Record<string, string | string[] | null | undefined>;

export type VerificationResult = {
  status: VerificationStatus;
  actionable: boolean;
  reason: string;
  observations: Observation[];
  checked_at: string;
};
export type ProviderFailureType =
  | "timeout"
  | "authentication"
  | "rate_limit"
  | "network"
  | "invalid_response"
  | "configuration"
  | "http"
  | "unknown";

export type ProviderHealthOutcome = {
  ok: boolean;
  latencyMs: number;
  observations: number;
  error?: string;
  failureType?: ProviderFailureType;
};
export type Evidence = {
  value: number; currency: string; fetched_at: string; freshness_seconds: number;
  remaining_seconds?: number | null; source?: string; source_tier?: number;
  evidence_hash?: string; url?: string; [key: string]: unknown;
};

export type MarketMode = "products" | "auctions";

const fields = ["jan", "gtin", "asin", "mpn", "model", "capacity", "color", "region", "version", "year", "condition", "grade", "cert_company", "cert_number"];
export function compareIdentity(a: Identity, b: Identity) {
  const mismatches = fields.filter((k) => a[k] && b[k] && String(a[k]).toLowerCase() !== String(b[k]).toLowerCase());
  return { match: mismatches.length === 0, mismatches };
}

export const auctionFreshnessLimit = (remaining?: number | null) =>
  remaining != null && remaining <= 600 ? 120 : remaining != null && remaining <= 1800 ? 300 : 1800;

export function verifyEvidence(items: Evidence[]) {
  if (!items.length) return { status: "UNVERIFIED" as const, actionable: false, reason: "価格観測がありません" };
  const uniquePayloads = new Map<string, Evidence>();
  for (const item of items) {
    const payloadKey = item.evidence_hash || evidenceHash([item.source, item.url, item.value, item.currency, item.fetched_at]);
    if (!uniquePayloads.has(payloadKey)) uniquePayloads.set(payloadKey, item);
  }
  const deduped = [...uniquePayloads.values()];
  if (deduped.some((i) => i.freshness_seconds > auctionFreshnessLimit(i.remaining_seconds))) {
    return { status: "STALE" as const, actionable: false, reason: "鮮度ポリシーを満たしていません" };
  }
  const min = Math.min(...deduped.map((i) => i.value));
  const max = Math.max(...deduped.map((i) => i.value));
  if (max > min * 1.08) return { status: "CONFLICT" as const, actionable: false, reason: "重要な価格差があります" };
  const sources = new Set(deduped.map((i) => (i.source || new URL(i.url || "https://unknown.invalid").hostname).toLowerCase()));
  const hasAuthoritative = deduped.some((i) => i.source_tier === 1);
  const independent = sources.size >= 2;
  const strong = independent && (deduped.length >= 2 || hasAuthoritative);
  const status = strong ? "VERIFIED_STRONG" as const : "VERIFIED_SINGLE" as const;
  return { status, actionable: true, reason: strong ? "独立した複数ソースが合意" : "重複を除外した単一ソース観測" };
}

export function isActionable(status: VerificationStatus, freshness: number, remaining?: number | null) {
  return (status === "VERIFIED_STRONG" || status === "VERIFIED_SINGLE") && freshness <= auctionFreshnessLimit(remaining);
}

export const evidenceHash = (input: unknown) => createHash("sha256").update(JSON.stringify(input)).digest("hex");

export function computeCoverage(sources: Array<{ configured: boolean; searchable: boolean; live_price_capable: boolean; sold_comps_capable: boolean }>) {
  const n = sources.length || 1;
  return {
    registry_size: sources.length,
    configured_count: sources.filter((s) => s.configured).length,
    searchable_count: sources.filter((s) => s.searchable).length,
    live_price_count: sources.filter((s) => s.live_price_capable).length,
    sold_comps_count: sources.filter((s) => s.sold_comps_capable).length,
    measured_coverage_percent: Math.round((sources.filter((s) => s.configured).length / n) * 1000) / 10,
    disclaimer: "インターネット全体ではなく、登録済み trusted-source registry に対する実測カバレッジです。",
  };
}

export type Observation = Evidence & {
  id: string;
  title: string;
  source: string;
  source_tier: number;
  confidence: number;
  url: string;
  evidence_hash: string;
  identity: Identity;
  actionable: boolean;
};

export type SoldCompRecord = {
  title: string;
  sold_price: number;
  currency: string;
  sold_at: string;
  source: string;
  normalized_price: number;
  condition: string;
  url: string;
  identity: Identity;
};

export type SoldCompsResult = {
  query: string;
  comps: SoldCompRecord[];
  conservative_value: number | null;
  liquidity: "insufficient_data" | "low" | "medium" | "high";
  confidence: number;
  persistence_status: MarketPersistenceStatus;
};

export type ProviderSearchResult = {
  observations: Observation[];
  discoveries: DiscoveryResult[];
};

function normalizeIdentity(identity: Identity | undefined): Identity {
  if (!identity) return { accessories: [] };
  const normalized: Identity = {};
  for (const [key, value] of Object.entries(identity)) {
    if (Array.isArray(value)) {
      const values = value.map(normalizeString).filter((item): item is string => Boolean(item));
      if (values.length) normalized[key] = values;
    } else {
      const item = normalizeString(value);
      if (item) normalized[key] = item;
    }
  }
  if (!normalized.accessories) normalized.accessories = [];
  return normalized;
}

const hasEnv = (name: string) => Boolean(process.env[name]?.trim());

export function normalizeDiscovery(raw: {
  title: unknown;
  url: unknown;
  source: string;
  snippet?: unknown;
}): DiscoveryResult | null {
  const title = normalizeString(raw.title);
  const url = normalizeUrl(raw.url);
  if (!title || !url) return null;
  const snippet = normalizeString(raw.snippet);
  return {
    title,
    url,
    source: raw.source,
    kind: "DISCOVERY_ONLY",
    ...(snippet ? { snippet: snippet.slice(0, 500) } : {}),
  };
}

function normalizeTimestamp(value: unknown, fallback: string) {
  const raw = normalizeString(value);
  if (!raw) return fallback;
  const timestamp = new Date(raw);
  return Number.isNaN(timestamp.getTime()) ? fallback : timestamp.toISOString();
}

const withConfigured = (provider: Omit<ProviderDefinition, "configured">): ProviderDefinition =>
  Object.defineProperty({ ...provider }, "configured", {
    enumerable: true,
    get: () => isProviderConfigured(provider),
  }) as ProviderDefinition;

export function parsePrice(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) && value > 0 ? value : null;
  if (typeof value !== "string") return null;

  const normalized = value.trim().replace(/[^\d.,+-]/g, "");
  if (!normalized) return null;

  const lastComma = normalized.lastIndexOf(",");
  const lastDot = normalized.lastIndexOf(".");
  let numeric = normalized;
  if (lastComma > lastDot) {
    numeric = normalized.replace(/\./g, "").replace(",", ".");
  } else {
    numeric = normalized.replace(/,/g, "");
  }

  const parsed = Number(numeric);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export async function recordProviderHealth(
  providerId: string,
  outcome: ProviderHealthOutcome,
) {
  await ensureProviderHealthLoaded();
  const current = providerHealth.get(providerId) || emptyProviderHealth();
  current.attempts += 1;
  current.lastLatencyMs = Math.max(0, Math.round(outcome.latencyMs));
  current.observations += Math.max(0, outcome.observations);
  if (outcome.ok) {
    current.successes += 1;
    current.consecutiveFailures = 0;
    current.lastSuccessAt = new Date().toISOString();
    current.lastError = null;
    current.lastErrorType = null;
  } else {
    current.failures += 1;
    current.consecutiveFailures += 1;
    current.lastError = outcome.error || "provider_request_failed";
    current.lastErrorType = outcome.failureType || providerFailureTypeFromError(current.lastError);
  }
  providerHealth.set(providerId, current);
  await persistProviderHealth(providerId, outcome);
}

export type DiscoveryResult = {
  title: string;
  url: string;
  source: string;
  kind: "DISCOVERY_ONLY";
  snippet?: string;
};

export function buildSearchResponse(
  query: string,
  observations: Observation[],
  discoveries: DiscoveryResult[],
  providersQueried: string[],
): SearchResponse {
  const grouped = new Map<string, Observation[]>();
  for (const observation of observations) {
    const key = observationGroupKey(observation);
    const group = grouped.get(key) || [];
    group.push(observation);
    grouped.set(key, group);
  }

  const results = [...grouped.values()]
    .sort((a, b) => {
      const tier = (a[0]?.source_tier || Number.MAX_SAFE_INTEGER) - (b[0]?.source_tier || Number.MAX_SAFE_INTEGER);
      return tier || (a[0]?.title || "").localeCompare(b[0]?.title || "");
    })
    .map((items) => {
      const verification = verifyEvidence(items);
      return {
        ...verification,
        observations: items,
        checked_at: new Date().toISOString(),
      };
    });

  const uniqueDiscoveries = new Map<string, DiscoveryResult>();
  for (const discovery of discoveries) uniqueDiscoveries.set(`${discovery.source}:${discovery.url}`, discovery);

  return {
    query,
    results,
    providers_queried: providersQueried,
    generated_at: new Date().toISOString(),
    ...(uniqueDiscoveries.size ? { discovery: [...uniqueDiscoveries.values()] } : {}),
  };
}

export type SearchResponse = {
  query: string;
  results: VerificationResult[];
  providers_queried: string[];
  generated_at: string;
  discovery?: DiscoveryResult[];
};

export function providerFailureTypeFromError(error: string | null | undefined): ProviderFailureType | null {
  if (!error) return null;
  if (error === "timeout") return "timeout";
  if (error === "http_401" || error === "http_403") return "authentication";
  if (error === "http_429") return "rate_limit";
  if (error === "network_error") return "network";
  if (error === "invalid_json") return "invalid_response";
  if (error === "missing_credential" || error === "token_missing" || error === "unsupported_sold_marketplace") {
    return "configuration";
  }
  if (error.startsWith("http_")) return "http";
  return "unknown";
}

function quantile(values: number[], percentile: number) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * percentile;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower] ?? null;
  const lowerValue = sorted[lower];
  const upperValue = sorted[upper];
  if (lowerValue == null || upperValue == null) return null;
  return lowerValue + (upperValue - lowerValue) * (position - lower);
}

function removePriceOutliers(comps: SoldCompRecord[]) {
  const valid = comps.filter((comp) => Number.isFinite(comp.normalized_price) && comp.normalized_price > 0);
  if (valid.length < 3) return valid;

  const values = valid.map((comp) => comp.normalized_price);
  const q1 = quantile(values, 0.25);
  const q3 = quantile(values, 0.75);
  const median = quantile(values, 0.5);
  if (q1 == null || q3 == null || median == null) return valid;

  const iqr = q3 - q1;
  const lowerFence = Math.max(q1 - 1.5 * iqr, median * 0.4);
  const upperFence = Math.min(q3 + 1.5 * iqr, median * 2.5);
  return valid.filter((comp) => comp.normalized_price >= lowerFence && comp.normalized_price <= upperFence);
}

export function buildSoldCompsResponse(
  query: string,
  comps: SoldCompRecord[],
  persistenceStatus: MarketPersistenceStatus = "available",
): SoldCompsResult {
  const usable = removePriceOutliers(comps);
  const conservative = quantile(usable.map((comp) => comp.normalized_price), 0.25);
  const sourceCount = new Set(usable.map((comp) => comp.source.toLowerCase())).size;
  const confidence = usable.length
    ? Math.round(Math.min(1, usable.length / 5) * (0.65 + 0.35 * Math.min(1, sourceCount / 3)) * 100) / 100
    : 0;

  return {
    query,
    comps,
    conservative_value: conservative == null ? null : Math.round(conservative * 100) / 100,
    liquidity: usable.length === 0
      ? "insufficient_data"
      : usable.length === 1
        ? "low"
        : usable.length < 5
          ? "medium"
          : "high",
    confidence,
    persistence_status: persistenceStatus,
  };
}

function observationGroupKey(observation: Observation) {
  for (const key of ["gtin", "jan", "asin", "mpn", "model"]) {
    const value = observation.identity[key];
    if (typeof value === "string" && value) return `identifier:${value.toLowerCase()}`;
  }
  return `title:${observation.title.trim().toLowerCase().replace(/\s+/g, " ")}`;
}

export function isProviderConfigured(provider: Pick<ProviderDefinition, "env" | "requiredEnv" | "anyEnv" | "anyEnvGroups">) {
  const required = provider.requiredEnv ?? (provider.env ? [provider.env] : []);
  if (!required.every(hasEnv)) return false;
  if (provider.anyEnv && !provider.anyEnv.some(hasEnv)) return false;
  return !provider.anyEnvGroups || provider.anyEnvGroups.some((group) => group.every(hasEnv));
}

export type ProviderDefinition = {
  id: string;
  label: string;
  tier: number;
  kind: ProviderKind;
  env?: string;
  requiredEnv?: readonly string[];
  anyEnv?: readonly string[];
  anyEnvGroups?: readonly (readonly string[])[];
  readonly configured: boolean;
};

const providerHealth = new Map<string, ProviderHealth>();

/**
 * The registry is intentionally metadata-only. Provider-specific adapters live in
 * providers.ts, and a provider is considered configured at request time so that
 * Replit Secrets added while the process is running take effect without exposing
 * the secret values.
 */
const providerDefinitions: Array<Omit<ProviderDefinition, "configured">> = [
  { id: "yahoo-shopping", label: "Yahoo!ショッピング API", tier: 1, kind: "official", env: "YAHOO_CLIENT_ID" },
  { id: "rakuten", label: "楽天市場 API", tier: 1, kind: "official", env: "RAKUTEN_APP_ID" },
  {
    id: "ebay",
    label: "eBay Browse API",
    tier: 1,
    kind: "official",
    env: "EBAY_CLIENT_ID",
    requiredEnv: ["EBAY_CLIENT_ID"],
    anyEnv: ["EBAY_CLIENT_SECRET", "EBAY_ACCESS_TOKEN"],
  },
  {
    id: "stockx",
    label: "StockX API",
    tier: 1,
    kind: "official",
    env: "STOCKX_API_KEY",
    requiredEnv: ["STOCKX_API_KEY"],
    anyEnvGroups: [
      ["STOCKX_ACCESS_TOKEN"],
      ["STOCKX_REFRESH_TOKEN", "STOCKX_CLIENT_ID", "STOCKX_CLIENT_SECRET"],
    ],
  },
  { id: "amazon", label: "Amazon Creators API", tier: 1, kind: "official", env: "AMAZON_CREATORS_KEY" },
  { id: "keepa", label: "Keepa", tier: 2, kind: "specialist", env: "KEEPA_API_KEY" },
  { id: "serpapi", label: "SerpApi Google Shopping", tier: 3, kind: "discovery", env: "SERPAPI_KEY" },
  { id: "apify", label: "Apify Marketplace Actors", tier: 4, kind: "marketplace", env: "APIFY_TOKEN" },
  { id: "brightdata", label: "Bright Data", tier: 5, kind: "fallback", env: "BRIGHT_DATA_TOKEN" },
  { id: "jsonld", label: "JSON-LD / Schema.org", tier: 6, kind: "generic" },
  { id: "playwright", label: "Playwright (最終手段)", tier: 7, kind: "browser", env: "ENABLE_PLAYWRIGHT" },
];

export const providerRegistry = providerDefinitions.map(withConfigured);

export function normalizeObservation(raw: RawObservation): Observation | null {
  const title = normalizeString(raw.title);
  const value = parsePrice(raw.value);
  const url = normalizeUrl(raw.url);
  if (!title || value == null || !url) return null;

  const fetchedAt = normalizeTimestamp(raw.fetchedAt, new Date().toISOString());
  const fetchedMs = new Date(fetchedAt).getTime();
  const freshnessSeconds = Math.max(0, Math.floor((Date.now() - fetchedMs) / 1000));
  const remainingValue = typeof raw.remainingSeconds === "number"
    ? raw.remainingSeconds
    : typeof raw.remainingSeconds === "string"
      ? Number(raw.remainingSeconds.trim())
      : Number.NaN;
  const remainingSeconds = Number.isFinite(remainingValue) && remainingValue >= 0
    ? Math.round(remainingValue)
    : null;
  const currency = normalizeString(raw.currency)?.toUpperCase() || "JPY";
  const identity = normalizeIdentity(raw.identity);
  const itemId = normalizeString(raw.providerItemId);
  const evidence_hash = evidenceHash([
    raw.source,
    itemId || url,
    value,
    currency,
    fetchedAt,
  ]);

  return {
    id: evidenceHash([raw.source, itemId || url, fetchedAt]),
    title,
    value,
    currency,
    source: raw.source,
    source_tier: raw.sourceTier,
    fetched_at: fetchedAt,
    freshness_seconds: freshnessSeconds,
    remaining_seconds: remainingSeconds,
    confidence: clampConfidence(raw.confidence, defaultConfidence(raw.sourceTier)),
    url,
    evidence_hash,
    actionable: true,
    identity,
  };
}

const emptyProviderHealth = (): ProviderHealth => ({
  attempts: 0,
  successes: 0,
  failures: 0,
  observations: 0,
  lastSuccessAt: null,
  lastError: null,
  lastErrorType: null,
  lastLatencyMs: 0,
  consecutiveFailures: 0,
});

export type RawObservation = {
  title: unknown;
  value: unknown;
  currency?: unknown;
  url: unknown;
  source: string;
  sourceTier: number;
  fetchedAt?: unknown;
  remainingSeconds?: unknown;
  confidence?: unknown;
  identity?: Identity;
  providerItemId?: unknown;
};

function clampConfidence(value: unknown, fallback: number) {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.min(1, parsed)) : fallback;
}

function normalizeString(value: unknown) {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const result = String(value).trim();
  return result || undefined;
}

function normalizeUrl(value: unknown) {
  const raw = normalizeString(value);
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

export type ProviderKind = "official" | "specialist" | "discovery" | "marketplace" | "fallback" | "generic" | "browser";

function defaultConfidence(sourceTier: number) {
  if (sourceTier <= 1) return 0.94;
  if (sourceTier === 2) return 0.88;
  if (sourceTier === 3) return 0.62;
  if (sourceTier === 4) return 0.7;
  if (sourceTier === 5) return 0.55;
  return 0.6;
}

export function getProviderHealth(providerId: string) {
  const current = providerHealth.get(providerId) || emptyProviderHealth();
  return {
    ...current,
    lastErrorType: current.lastErrorType || providerFailureTypeFromError(current.lastError),
  };
}

let providerHealthHydration: Promise<void> | undefined;

export async function ensureProviderHealthLoaded() {
  providerHealthHydration ??= loadStoredProviderHealth().then((stored) => {
    for (const [providerId, metrics] of stored) {
      providerHealth.set(providerId, {
        ...metrics,
        lastErrorType: providerFailureTypeFromError(metrics.lastError),
      });
    }
  });
  await providerHealthHydration;
}

type ProviderHealth = {
  attempts: number;
  successes: number;
  failures: number;
  observations: number;
  lastSuccessAt: string | null;
  lastError: string | null;
  lastErrorType: ProviderFailureType | null;
  lastLatencyMs: number;
  consecutiveFailures: number;
};
