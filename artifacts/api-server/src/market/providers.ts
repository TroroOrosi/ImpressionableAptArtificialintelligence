import {
  buildSearchResponse,
  ensureProviderHealthLoaded,
  getProviderHealth,
  isProviderConfigured,
  normalizeDiscovery,
  normalizeObservation,
  providerRegistry,
  recordProviderHealth,
  type DiscoveryResult,
  type Identity,
  type MarketMode,
  type Observation,
  type ProviderSearchResult,
  type SearchResponse,
  type SoldCompRecord,
} from "./core";
import { normalizeSoldCompRecord, persistObservations } from "./storage";

type JsonRecord = Record<string, unknown>;

type SearchContext = {
  query: string;
  limit: number;
  mode: MarketMode;
};

type SearchAdapter = {
  modes: readonly MarketMode[];
  search: (context: SearchContext) => Promise<ProviderSearchResult>;
};

type SoldSearchContext = {
  query: string;
  limit: number;
};

type SoldAdapter = {
  search: (context: SoldSearchContext) => Promise<SoldCompRecord[]>;
};

const REQUEST_TIMEOUT_MS = 12_000;
const EBAY_SOLD_MARKETPLACE_IDS = new Set(["EBAY_US"]);

class ProviderRequestError extends Error {
  constructor(
    readonly providerId: string,
    readonly code: string,
  ) {
    super(code);
    this.name = "ProviderRequestError";
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown) {
  return isRecord(value) ? value : undefined;
}

function stringValue(value: unknown) {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const result = String(value).trim();
  return result || undefined;
}

function getPath(value: unknown, path: string): unknown {
  let current: unknown = value;
  for (const part of path.split(".")) {
    if (!isRecord(current)) return undefined;
    current = current[part];
  }
  return current;
}

function firstValue(record: JsonRecord, ...paths: string[]) {
  for (const path of paths) {
    const value = getPath(record, path);
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

function firstString(record: JsonRecord, ...paths: string[]) {
  return stringValue(firstValue(record, ...paths));
}

function recordsAt(payload: unknown, ...paths: string[]): JsonRecord[] {
  if (Array.isArray(payload)) return payload.filter(isRecord);
  for (const path of paths) {
    const value = getPath(payload, path);
    if (Array.isArray(value)) return value.filter(isRecord);
    if (isRecord(value)) {
      for (const key of ["hit", "item", "items", "Items", "results", "products", "itemSummaries", "data"]) {
        const nested = value[key];
        if (Array.isArray(nested)) return nested.filter(isRecord);
      }
      return [value];
    }
  }
  return [];
}

function requiredSecret(name: string, providerId: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new ProviderRequestError(providerId, "missing_credential");
  return value;
}

function providerTier(providerId: string) {
  return providerRegistry.find((provider) => provider.id === providerId)?.tier || 9;
}

function providerResult() {
  return { observations: [] as Observation[], discoveries: [] as DiscoveryResult[] };
}

function identityFrom(item: JsonRecord): Identity {
  const code = asRecord(firstValue(item, "code", "productCode", "identifiers"));
  return {
    jan: firstString(item, "jan", "janCode", "JAN", "productCode.jan", "code.jan", "identifiers.jan"),
    gtin: firstString(item, "gtin", "gtin13", "gtin14", "GTIN", "code.gtin", "identifiers.gtin")
      ?? firstString(code || {}, "gtin", "gtin13", "gtin14"),
    asin: firstString(item, "asin", "ASIN"),
    mpn: firstString(item, "mpn", "manufacturerPartNumber", "partNumber", "code.mpn"),
    model: firstString(item, "model", "modelNumber", "model_number", "code.model"),
    condition: firstString(item, "conditionDisplayName", "condition.conditionDisplayName", "condition", "itemCondition"),
    brand: firstString(item, "brand", "brandName"),
    capacity: firstString(item, "capacity", "storageCapacity", "size"),
    color: firstString(item, "color", "colour"),
    region: firstString(item, "region", "country"),
    version: firstString(item, "version", "edition"),
    year: firstString(item, "year", "releaseYear"),
  };
}

function rawObservation(
  providerId: string,
  item: JsonRecord,
  values: {
    title: unknown;
    value: unknown;
    currency?: unknown;
    url: unknown;
    fetchedAt: string;
    remainingSeconds?: unknown;
    providerItemId?: unknown;
    confidence?: number;
  },
) {
  return normalizeObservation({
    title: values.title,
    value: values.value,
    currency: values.currency,
    url: values.url,
    source: providerId,
    sourceTier: providerTier(providerId),
    fetchedAt: values.fetchedAt,
    remainingSeconds: values.remainingSeconds,
    providerItemId: values.providerItemId,
    confidence: values.confidence,
    identity: identityFrom(item),
  });
}

function rawDiscovery(providerId: string, item: JsonRecord, paths: { title: string[]; url: string[]; snippet: string[] }) {
  const title = firstValue(item, ...paths.title);
  const url = firstValue(item, ...paths.url);
  const snippet = firstValue(item, ...paths.snippet);
  return normalizeDiscovery({ title, url, source: providerId, snippet });
}

function validTimestamp(value: unknown) {
  const raw = stringValue(value);
  if (!raw) return undefined;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

async function fetchJson(providerId: string, url: string, init?: RequestInit): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      redirect: "follow",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new ProviderRequestError(providerId, "network_error");
  }

  if (!response.ok) throw new ProviderRequestError(providerId, `http_${response.status}`);
  try {
    return await response.json() as unknown;
  } catch {
    throw new ProviderRequestError(providerId, "invalid_json");
  }
}

async function searchYahoo(context: SearchContext): Promise<ProviderSearchResult> {
  const clientId = requiredSecret("YAHOO_CLIENT_ID", "yahoo-shopping");
  const url = new URL("https://shopping.yahooapis.jp/ShoppingWebService/V3/itemSearch");
  url.searchParams.set("appid", clientId);
  url.searchParams.set("query", context.query);
  url.searchParams.set("results", String(context.limit));
  url.searchParams.set("start", "1");
  url.searchParams.set("availability", "1");

  const payload = await fetchJson("yahoo-shopping", url.href);
  const fetchedAt = new Date().toISOString();
  const result = providerResult();
  for (const item of recordsAt(payload, "hits", "result.hits", "items", "results")) {
    const observation = rawObservation("yahoo-shopping", item, {
      title: firstValue(item, "name", "itemName", "title"),
      value: firstValue(item, "price", "itemPrice", "salePrice", "offers.price"),
      currency: firstValue(item, "priceCurrency", "currency", "offers.priceCurrency") || "JPY",
      url: firstValue(item, "url", "itemUrl", "link"),
      fetchedAt,
      providerItemId: firstValue(item, "code.productId", "productId", "id", "itemCode"),
    });
    if (observation) result.observations.push(observation);
  }
  return result;
}

async function searchRakuten(context: SearchContext): Promise<ProviderSearchResult> {
  const appId = requiredSecret("RAKUTEN_APP_ID", "rakuten");
  const accessKey = process.env.RAKUTEN_ACCESS_KEY?.trim();
  const endpoint = accessKey
    ? "https://openapi.rakuten.co.jp/ichibams/api/IchibaItem/Search/20260701"
    : "https://app.rakuten.co.jp/services/api/IchibaItem/Search/20220601";
  const url = new URL(endpoint);
  url.searchParams.set("applicationId", appId);
  url.searchParams.set("keyword", context.query);
  url.searchParams.set("hits", String(context.limit));
  url.searchParams.set("format", "json");

  const payload = await fetchJson("rakuten", url.href, accessKey ? { headers: { accessKey } } : undefined);
  const fetchedAt = new Date().toISOString();
  const result = providerResult();
  for (const wrapper of recordsAt(payload, "Items", "items", "results")) {
    const item = asRecord(firstValue(wrapper, "Item", "item")) || wrapper;
    const observation = rawObservation("rakuten", item, {
      title: firstValue(item, "itemName", "name", "title"),
      value: firstValue(item, "itemPrice", "price", "salePrice"),
      currency: firstValue(item, "priceCurrency", "currency") || "JPY",
      url: firstValue(item, "itemUrl", "url", "link"),
      fetchedAt,
      providerItemId: firstValue(item, "itemCode", "itemNumber", "id"),
    });
    if (observation) result.observations.push(observation);
  }
  return result;
}

type EbayTokenCache = {
  token: string;
  expiresAt: number;
  clientId: string;
};

let ebayTokenCache: EbayTokenCache | undefined;

async function ebayAccessToken() {
  const staticToken = process.env.EBAY_ACCESS_TOKEN?.trim();
  if (staticToken) return staticToken;

  const clientId = requiredSecret("EBAY_CLIENT_ID", "ebay");
  const secret = requiredSecret("EBAY_CLIENT_SECRET", "ebay");
  if (ebayTokenCache && ebayTokenCache.clientId === clientId && ebayTokenCache.expiresAt > Date.now() + 60_000) {
    return ebayTokenCache.token;
  }

  const credentials = Buffer.from(`${clientId}:${secret}`, "utf8").toString("base64");
  const payload = await fetchJson("ebay", "https://api.ebay.com/identity/v1/oauth2/token", {
    method: "POST",
    headers: {
      accept: "application/json",
      authorization: `Basic ${credentials}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      scope: "https://api.ebay.com/oauth/api_scope",
    }).toString(),
  });
  const record = asRecord(payload);
  const token = stringValue(record?.access_token);
  if (!token) throw new ProviderRequestError("ebay", "token_missing");
  const expiresIn = Number(record?.expires_in);
  ebayTokenCache = {
    token,
    clientId,
    expiresAt: Date.now() + (Number.isFinite(expiresIn) ? expiresIn * 1000 : 7_200_000),
  };
  return token;
}

async function searchEbay(context: SearchContext): Promise<ProviderSearchResult> {
  const token = await ebayAccessToken();
  const host = process.env.EBAY_SANDBOX === "true" ? "https://api.sandbox.ebay.com" : "https://api.ebay.com";
  const marketplace = /^[A-Z0-9_]+$/.test(process.env.EBAY_MARKETPLACE_ID?.trim() || "")
    ? process.env.EBAY_MARKETPLACE_ID!.trim()
    : "EBAY_JP";
  const url = new URL(`${host}/buy/browse/v1/item_summary/search`);
  url.searchParams.set("q", context.query);
  url.searchParams.set("limit", String(context.limit));
  if (context.mode === "auctions") url.searchParams.set("filter", "buyingOptions:{AUCTION}");

  const payload = await fetchJson("ebay", url.href, {
    headers: {
      accept: "application/json",
      authorization: `Bearer ${token}`,
      "x-ebay-c-marketplace-id": marketplace,
    },
  });
  const fetchedAt = new Date().toISOString();
  const result = providerResult();
  const summaries = recordsAt(payload, "itemSummaries", "items", "results");
  for (const item of summaries) {
    const endDate = stringValue(firstValue(item, "itemEndDate", "endDate"));
    const endMs = endDate ? new Date(endDate).getTime() : Number.NaN;
    const remainingSeconds = Number.isFinite(endMs) ? Math.max(0, Math.floor((endMs - Date.now()) / 1000)) : null;
    const price = asRecord(firstValue(item, "price", "currentBidPrice", "buyingOptions.0.price"));
    const observation = rawObservation("ebay", item, {
      title: firstValue(item, "title", "itemName", "name"),
      value: price?.value ?? firstValue(item, "price", "currentBidPrice", "buyItNowPrice"),
      currency: price?.currency ?? firstValue(item, "currency") ?? "JPY",
      url: firstValue(item, "itemWebUrl", "itemUrl", "url", "link"),
      fetchedAt,
      remainingSeconds,
      providerItemId: firstValue(item, "itemId", "legacyItemId", "epid"),
    });
    if (observation) result.observations.push(observation);
  }
  return result;
}

async function searchEbaySold(context: SoldSearchContext): Promise<SoldCompRecord[]> {
  const configuredMarketplace = process.env.EBAY_MARKETPLACE_ID?.trim().toUpperCase() || "EBAY_US";
  if (!EBAY_SOLD_MARKETPLACE_IDS.has(configuredMarketplace)) {
    throw new ProviderRequestError("ebay", "unsupported_sold_marketplace");
  }

  const token = await ebayAccessToken();
  const host = process.env.EBAY_SANDBOX === "true" ? "https://api.sandbox.ebay.com" : "https://api.ebay.com";
  const url = new URL(`${host}/buy/marketplace-insights/v1_beta/item_sales/search`);
  url.searchParams.set("q", context.query);
  url.searchParams.set("limit", String(context.limit));

  const payload = await fetchJson("ebay", url.href, {
    headers: {
      accept: "application/json",
      authorization: `Bearer ${token}`,
      "x-ebay-c-marketplace-id": configuredMarketplace,
    },
  });
  const comps: SoldCompRecord[] = [];
  for (const item of recordsAt(payload, "itemSales", "sales", "items", "results")) {
    const price = asRecord(firstValue(item, "price", "soldPrice", "salePrice"));
    const soldAt = validTimestamp(firstValue(
      item,
      "lastSoldDate",
      "soldDate",
      "transactionDate",
      "itemEndDate",
      "endDate",
    ));
    if (!soldAt) continue;

    const comp = normalizeSoldCompRecord({
      query: context.query,
      title: firstValue(item, "title", "itemName", "name"),
      soldPrice: price ? firstValue(price, "value", "amount") : firstValue(item, "price", "soldPrice", "salePrice"),
      currency: price
        ? firstValue(price, "currency")
        : firstValue(item, "currency", "priceCurrency") || "JPY",
      soldAt,
      source: "ebay",
      condition: firstValue(
        item,
        "conditionDisplayName",
        "condition.conditionDisplayName",
        "condition",
        "itemCondition",
      ),
      url: firstValue(item, "itemWebUrl", "itemUrl", "url", "link"),
      identity: identityFrom(item),
      providerItemId: firstValue(item, "itemId", "legacyItemId", "epid"),
    });
    if (comp) comps.push(comp);
  }
  return comps;
}

function keepaPrice(product: JsonRecord): number | null {
  const stats = asRecord(firstValue(product, "stats"));
  const current = firstValue(stats || {}, "current");
  if (Array.isArray(current)) {
    for (const index of [1, 0, 10, 2, 3, 4]) {
      const value = Number(current[index]);
      if (Number.isFinite(value) && value > 0) return value / 100;
    }
  }

  for (const key of ["buyBoxPrice", "newPrice", "price", "currentPrice"]) {
    const value = Number(firstValue(product, key));
    if (Number.isFinite(value) && value > 0) return value > 100 ? value / 100 : value;
  }

  const csv = firstValue(product, "csv");
  if (Array.isArray(csv)) {
    for (const series of csv) {
      if (!Array.isArray(series)) continue;
      for (let index = series.length - 1; index >= 1; index -= 2) {
        const value = Number(series[index]);
        if (Number.isFinite(value) && value > 0) return value / 100;
      }
    }
  }
  return null;
}

async function searchKeepa(context: SearchContext): Promise<ProviderSearchResult> {
  const key = requiredSecret("KEEPA_API_KEY", "keepa");
  const domain = /^\d+$/.test(process.env.KEEPA_DOMAIN?.trim() || "") ? process.env.KEEPA_DOMAIN!.trim() : "5";
  let products: JsonRecord[] = [];
  const asinQuery = /^[A-Z0-9]{10}$/i.test(context.query.trim());

  if (asinQuery) {
    const url = new URL("https://api.keepa.com/product");
    url.searchParams.set("key", key);
    url.searchParams.set("domain", domain);
    url.searchParams.set("asin", context.query.trim());
    url.searchParams.set("stats", "1");
    const payload = await fetchJson("keepa", url.href);
    products = recordsAt(payload, "products", "items", "product");
    if (!products.length && isRecord(payload)) products = [payload];
  } else {
    const searchUrl = new URL("https://api.keepa.com/search");
    searchUrl.searchParams.set("key", key);
    searchUrl.searchParams.set("domain", domain);
    searchUrl.searchParams.set("type", "product");
    searchUrl.searchParams.set("term", context.query);
    searchUrl.searchParams.set("limit", String(context.limit));
    const searchPayload = await fetchJson("keepa", searchUrl.href);
    products = recordsAt(searchPayload, "products", "items", "results");
    const asins = Array.isArray(asRecord(searchPayload)?.asinList)
      ? (asRecord(searchPayload)?.asinList as unknown[]).map(stringValue).filter((value): value is string => Boolean(value)).slice(0, context.limit)
      : [];
    if (!products.length && asins.length) {
      const productUrl = new URL("https://api.keepa.com/product");
      productUrl.searchParams.set("key", key);
      productUrl.searchParams.set("domain", domain);
      productUrl.searchParams.set("asin", asins.join(","));
      productUrl.searchParams.set("stats", "1");
      const productPayload = await fetchJson("keepa", productUrl.href);
      products = recordsAt(productPayload, "products", "items", "product");
    }
  }

  const fetchedAt = new Date().toISOString();
  const result = providerResult();
  for (const product of products.slice(0, context.limit)) {
    const asin = stringValue(firstValue(product, "asin", "ASIN"));
    const observation = rawObservation("keepa", product, {
      title: firstValue(product, "title", "productTitle", "name") || (asin ? `Amazon ${asin}` : undefined),
      value: keepaPrice(product),
      currency: "JPY",
      url: firstValue(product, "url", "itemUrl") || (asin ? `https://www.amazon.co.jp/dp/${encodeURIComponent(asin)}` : undefined),
      fetchedAt,
      providerItemId: asin,
    });
    if (observation) result.observations.push(observation);
  }
  return result;
}

async function searchSerpApi(context: SearchContext): Promise<ProviderSearchResult> {
  const key = requiredSecret("SERPAPI_KEY", "serpapi");
  const url = new URL("https://serpapi.com/search.json");
  url.searchParams.set("engine", "google_shopping");
  url.searchParams.set("api_key", key);
  url.searchParams.set("q", context.query);
  url.searchParams.set("num", String(context.limit));
  url.searchParams.set("gl", "jp");
  url.searchParams.set("hl", "ja");
  const payload = await fetchJson("serpapi", url.href);
  const result = providerResult();
  for (const item of recordsAt(payload, "shopping_results", "products", "results")) {
    const discovery = rawDiscovery("serpapi", item, {
      title: ["title", "name", "product_name"],
      url: ["link", "product_link", "url"],
      snippet: ["snippet", "description", "source"],
    });
    if (discovery) result.discoveries.push(discovery);
  }
  return result;
}

async function searchApify(context: SearchContext): Promise<ProviderSearchResult> {
  const token = requiredSecret("APIFY_TOKEN", "apify");
  const actor = (process.env.APIFY_ACTOR_ID?.trim() || "apify~google-shopping-scraper").replace(/[^A-Za-z0-9~_-]/g, "");
  const structuredActor = process.env.APIFY_STRUCTURED_ACTOR_ID?.trim().replace(/[^A-Za-z0-9~_-]/g, "");
  const hasStructuredContract = Boolean(structuredActor && structuredActor === actor);
  const url = `https://api.apify.com/v2/acts/${encodeURIComponent(actor)}/run-sync-get-dataset-items`;
  const payload = await fetchJson("apify", url, {
    method: "POST",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      searchQueries: [context.query],
      queries: [context.query],
      countryCode: "JP",
      maxItems: context.limit,
    }),
  });
  const result = providerResult();
  for (const item of recordsAt(payload, "items", "data", "results", "products")) {
    const fetchedAt = new Date().toISOString();
    const observation = hasStructuredContract
      ? rawObservation("apify", item, {
        title: firstValue(item, "providerOwnedTitle", "provider_owned_title", "title", "name", "productName"),
        value: firstValue(item, "providerOwnedPrice", "provider_owned_price"),
        currency: firstValue(item, "providerOwnedCurrency", "provider_owned_currency") || "JPY",
        url: firstValue(item, "providerOwnedUrl", "provider_owned_url"),
        fetchedAt,
        providerItemId: firstValue(item, "providerOwnedItemId", "provider_owned_item_id", "id", "productId", "product_id"),
        confidence: 0.68,
      })
      : null;
    if (observation) {
      result.observations.push(observation);
    } else {
      const discovery = rawDiscovery("apify", item, {
        title: ["title", "name", "productName"],
        url: ["url", "link", "productUrl", "product_url"],
        snippet: ["snippet", "description", "source"],
      });
      if (discovery) result.discoveries.push(discovery);
    }
  }
  return result;
}

async function searchBrightData(context: SearchContext): Promise<ProviderSearchResult> {
  const token = requiredSecret("BRIGHT_DATA_TOKEN", "brightdata");
  const zone = (process.env.BRIGHT_DATA_ZONE?.trim() || "serp_api1").replace(/[^A-Za-z0-9_-]/g, "");
  const searchUrl = new URL("https://www.google.com/search");
  searchUrl.searchParams.set("tbm", "shop");
  searchUrl.searchParams.set("q", context.query);
  searchUrl.searchParams.set("hl", "ja");
  searchUrl.searchParams.set("gl", "jp");
  const payload = await fetchJson("brightdata", "https://api.brightdata.com/request", {
    method: "POST",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ zone, url: searchUrl.href, format: "json" }),
  });
  const result = providerResult();
  for (const item of recordsAt(payload, "shopping_results", "shopping", "products", "results", "organic")) {
    const discovery = rawDiscovery("brightdata", item, {
      title: ["title", "name", "product_name"],
      url: ["link", "url", "product_link"],
      snippet: ["snippet", "description", "source"],
    });
    if (discovery) result.discoveries.push(discovery);
  }
  return result;
}

const adapters: Record<string, SearchAdapter> = {
  "yahoo-shopping": { modes: ["products"], search: searchYahoo },
  rakuten: { modes: ["products"], search: searchRakuten },
  ebay: { modes: ["products", "auctions"], search: searchEbay },
  keepa: { modes: ["products"], search: searchKeepa },
  serpapi: { modes: ["products"], search: searchSerpApi },
  apify: { modes: ["products"], search: searchApify },
  brightdata: { modes: ["products"], search: searchBrightData },
};

const soldAdapters: Record<string, SoldAdapter> = {
  ebay: { search: searchEbaySold },
};

function configuredProvider(providerId: string) {
  const provider = providerRegistry.find((candidate) => candidate.id === providerId);
  return provider ? isProviderConfigured(provider) : false;
}

export function hasProviderAdapter(providerId: string, mode?: MarketMode) {
  const adapter = adapters[providerId];
  return Boolean(adapter && (!mode || adapter.modes.includes(mode)));
}

export function hasSoldCompsAdapter(providerId: string) {
  return Boolean(soldAdapters[providerId]);
}

export function availableProviderIds(mode?: MarketMode) {
  return providerRegistry
    .filter((provider) => configuredProvider(provider.id) && hasProviderAdapter(provider.id, mode))
    .sort((a, b) => a.tier - b.tier)
    .map((provider) => provider.id);
}

export function availableSoldProviderIds() {
  return providerRegistry
    .filter((provider) => configuredProvider(provider.id) && hasSoldCompsAdapter(provider.id))
    .sort((a, b) => a.tier - b.tier)
    .map((provider) => provider.id);
}

export async function searchMarket(query: string, mode: MarketMode, limit = 20): Promise<SearchResponse> {
  const normalizedQuery = query.trim();
  const normalizedLimit = Math.max(1, Math.min(50, Math.floor(limit) || 20));
  const observations: Observation[] = [];
  const discoveries: DiscoveryResult[] = [];
  const providersQueried: string[] = [];

  for (const providerId of availableProviderIds(mode)) {
    const adapter = adapters[providerId];
    if (!adapter) continue;
    providersQueried.push(providerId);
    const startedAt = Date.now();
    try {
      const result = await adapter.search({ query: normalizedQuery, limit: normalizedLimit, mode });
      observations.push(...result.observations.slice(0, normalizedLimit));
      discoveries.push(...result.discoveries.slice(0, normalizedLimit));
      await persistObservations(result.observations);
      await recordProviderHealth(providerId, {
        ok: true,
        latencyMs: Date.now() - startedAt,
        observations: result.observations.length,
      });
    } catch (error) {
      await recordProviderHealth(providerId, {
        ok: false,
        latencyMs: Date.now() - startedAt,
        observations: 0,
        error: error instanceof ProviderRequestError ? error.code : "provider_request_failed",
      });
    }
  }

  return buildSearchResponse(normalizedQuery, observations, discoveries, providersQueried);
}

export type SoldCompsSearchResponse = {
  comps: SoldCompRecord[];
  providers_queried: string[];
};

export async function searchSoldComps(query: string, limit = 20): Promise<SoldCompsSearchResponse> {
  const normalizedQuery = query.trim();
  const normalizedLimit = Math.max(1, Math.min(50, Math.floor(limit) || 20));
  const comps: SoldCompRecord[] = [];
  const providersQueried: string[] = [];

  for (const providerId of availableSoldProviderIds()) {
    const adapter = soldAdapters[providerId];
    if (!adapter) continue;
    providersQueried.push(providerId);
    const startedAt = Date.now();
    try {
      const providerComps = await adapter.search({ query: normalizedQuery, limit: normalizedLimit });
      comps.push(...providerComps.slice(0, normalizedLimit));
      await recordProviderHealth(providerId, {
        ok: true,
        latencyMs: Date.now() - startedAt,
        observations: providerComps.length,
      });
    } catch (error) {
      await recordProviderHealth(providerId, {
        ok: false,
        latencyMs: Date.now() - startedAt,
        observations: 0,
        error: error instanceof ProviderRequestError ? error.code : "provider_request_failed",
      });
    }
  }

  return { comps, providers_queried: providersQueried };
}

export async function sourceHealth() {
  await ensureProviderHealthLoaded();
  return providerRegistry.map((provider) => {
    const metrics = getProviderHealth(provider.id);
    const configured = configuredProvider(provider.id);
    const available = configured && (hasProviderAdapter(provider.id) || provider.id === "jsonld");
    const attempts = metrics.attempts || 0;
    const successRate = attempts ? metrics.successes / attempts : 0;
    return {
      id: provider.id,
      label: provider.label,
      tier: provider.tier,
      configured,
      available,
      success_rate: successRate,
      price_success_rate: attempts && metrics.observations ? successRate : 0,
      identity_success_rate: attempts && metrics.observations ? successRate : 0,
      last_success_at: metrics.lastSuccessAt,
      last_error: !configured ? "optional credential missing" : !available ? "adapter unavailable" : metrics.lastError,
      latency_ms: metrics.lastLatencyMs,
      consecutive_failures: metrics.consecutiveFailures,
    };
  });
}