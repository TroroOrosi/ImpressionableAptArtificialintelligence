import { Router, type IRouter, type Request } from "express";
import { timingSafeEqual } from "node:crypto";
import {
  buildSoldCompsResponse,
  computeCoverage,
  normalizeSoldCompMarket,
  normalizeObservation,
  providerRegistry,
  verifyEvidence,
} from "../market/core";
import { buildSetupBundle } from "../market/setupBundle";
import { buildChatgptBundle } from "../market/chatgptBundle";
import { createCallLimiter, handleMcpHttp, publicBaseUrl } from "../market/mcp";
import { addTrustedDomain, safeFetchPublicUrl } from "../market/urlSafety";
import {
  hasProviderAdapter,
  hasSoldCompsAdapter,
  searchMarket,
  searchSoldComps,
  soldCompProviderIdsForMarket,
  soldCompProviderMatchesMarket,
  sourceHealth,
} from "../market/providers";
import {
  getStoredObservations,
  getStoredPriceHistory,
  getStoredSoldComps,
  cleanupMarketHistory,
  persistObservations,
  persistSoldComps,
  type MarketPersistenceStatus,
  type SoldCompInput,
} from "../market/storage";

const router: IRouter = Router();
const started = Date.now();
const publicCalls = createCallLimiter();
const mcpCalls = createCallLimiter();

const trustedSources = () => [
  ["yahoo-shopping","Yahoo!ショッピング","general retail"],
  ["rakuten","楽天市場","general retail"],
  ["ebay","eBay","marketplaces/auctions"],
  ["yahoo-auctions","Yahoo!オークション","marketplaces/auctions"],
  ["mercari","メルカリ","marketplaces/auctions"],
  ["rakuma","ラクマ","marketplaces/auctions"],
  ["keepa","Keepa","digital/electronics"],
  ["pcgs","PCGS","coins/bullion"],
  ["tcgplayer","TCGplayer","TCG"],
  ["chrono24","Chrono24","watches"],
  ["gia","GIA","jewelry/gems"],
  ["artnet","Artnet","art/antiques"],
  ["stockx","StockX","fashion/brands"],
  ["serpapi","Google Shopping","general retail"],
].map(([id, name, category]) => {
  const provider = providerRegistry.find((candidate) => candidate.id === id);
  const configured = Boolean(provider?.configured);
  const searchable = configured && hasProviderAdapter(id, "products");
  const livePriceCapable = searchable && provider?.kind !== "discovery";
  const soldCompsCapable = configured && hasSoldCompsAdapter(id);
  return {
    id,
    name,
    category,
    configured,
    searchable,
    live_price_capable: livePriceCapable,
    sold_comps_capable: soldCompsCapable,
    health: searchable || soldCompsCapable ? "healthy" : "disabled",
  };
});
router.use("/v1", (_req, res, next) => {
  // A cached current-price response must not defeat the 2-minute auction freshness rule.
  res.setHeader("Cache-Control", "no-store");
  next();
});
router.use("/v1/public", (req, res, next) => {
  res.setHeader("X-RateLimit-Daily-Limit", "500");
  if (!publicCalls(req.ip || "unknown")) {
    res.setHeader("Retry-After", "60");
    res.status(429).json({ error: "rate_limit_exceeded" });
    return;
  }
  next();
});

async function genericVerify(raw: string) {
  let fetchResult: Awaited<ReturnType<typeof safeFetchPublicUrl>>;
  try { fetchResult = await safeFetchPublicUrl(raw); }
  catch (error) {
    const reason = error instanceof Error ? error.message : "unsupported_url";
    if (reason === "unsupported_domain") return { status:"UNVERIFIED", actionable:false, reason:"UNSUPPORTED_DOMAIN", observations:[], checked_at:new Date().toISOString() };
    throw error;
  }
  const { body: html, finalUrl: url } = fetchResult;
  const scripts = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  let product: Record<string, unknown> | undefined;
  for (const match of scripts) {
    try {
      const parsed = JSON.parse(match[1] || "{}");
      const list = Array.isArray(parsed) ? parsed : parsed["@graph"] || [parsed];
      product = list.find((x: Record<string, unknown>) => x["@type"] === "Product");
      if (product) break;
    } catch { /* malformed publisher JSON is ignored */ }
  }
  const fetched = new Date().toISOString();
  const offerValue = Array.isArray(product?.offers)
    ? (product.offers[0] as Record<string, unknown> | undefined)
    : product?.offers as Record<string, unknown> | undefined;
  const observation = product
    ? normalizeObservation({
      title: product.name || url.hostname,
      value: offerValue?.price,
      currency: offerValue?.priceCurrency || "JPY",
      source: url.hostname,
      sourceTier: 6,
      url: url.href,
      fetchedAt: fetched,
      identity: {
        model: product.model ? String(product.model) : null,
        gtin: product.gtin ? String(product.gtin) : null,
      },
    })
    : null;
  if (!observation) return { status: "UNVERIFIED", actionable: false, reason: "構造化された現在価格を確認できません", observations: [], checked_at: fetched };
  await persistObservations([observation]);
  return { ...verifyEvidence([observation]), observations: [observation], checked_at: fetched };
}

const queryFrom = (value: unknown) => String(value ?? "").trim();
const limitFrom = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(1, Math.min(50, Math.floor(parsed))) : 20;
};
const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);
const adminTokenMatches = (req: Request) => {
  const configuredToken = process.env.ADMIN_API_TOKEN;
  const suppliedToken = req.get("x-admin-token");
  return Boolean(
    configuredToken
    && suppliedToken
    && suppliedToken.length === configuredToken.length
    && timingSafeEqual(Buffer.from(suppliedToken), Buffer.from(configuredToken)),
  );
};

async function searchRoute(queryValue: unknown, mode: "products" | "auctions", limitValue: unknown) {
  const query = queryFrom(queryValue);
  if (query.length < 2) throw new Error("検索語は2文字以上で指定してください");
  return searchMarket(query, mode, limitFrom(limitValue));
}

function soldCompKey(comp: {
  source: string;
  url: string;
  sold_at: string;
  sold_price: number;
  currency: string;
}) {
  return [comp.source, comp.url, comp.sold_at, comp.sold_price, comp.currency].join("|");
}

async function soldCompsRoute(queryValue: unknown, limitValue: unknown, marketValue?: unknown) {
  const query = queryFrom(queryValue);
  const limit = limitFrom(limitValue);
  const market = normalizeSoldCompMarket(marketValue);
  const live = await searchSoldComps(query, limit, marketValue);
  let writeStatus: MarketPersistenceStatus = "available";
  if (live.comps.length) {
    const persisted = await persistSoldComps(live.comps.map((comp) => ({
      query,
      title: comp.title,
      soldPrice: comp.sold_price,
      currency: comp.currency,
      soldAt: comp.sold_at,
      source: comp.source,
      condition: comp.condition,
      url: comp.url,
      identity: comp.identity,
    })));
    writeStatus = persisted.status;
  }

  const stored = await getStoredSoldComps(query, limit, soldCompProviderIdsForMarket(marketValue));
  const merged = new Map<string, (typeof live.comps)[number]>();
  const storedRecords = marketValue === undefined
    ? stored.records
    : stored.records.filter((comp) => soldCompProviderMatchesMarket(comp.source, marketValue));
  for (const comp of storedRecords) merged.set(soldCompKey(comp), comp);
  for (const comp of live.comps) merged.set(soldCompKey(comp), comp);
  const comps = [...merged.values()]
    .sort((a, b) => new Date(b.sold_at).getTime() - new Date(a.sold_at).getTime())
    .slice(0, limit);
  const persistenceStatus = writeStatus === "unavailable" || stored.status === "unavailable"
    ? "unavailable"
    : "available";
  return buildSoldCompsResponse(query, comps, persistenceStatus, market);
}

function priceHistoryResponse(result: Awaited<ReturnType<typeof getStoredPriceHistory>>) {
  return {
    observations: result.records,
    persistence_status: result.status,
  };
}

router.get("/v1/public/verify", async (req,res) => { try { res.json(await genericVerify(String(req.query.url||""))); } catch(e) { res.status(400).json({ error: e instanceof Error ? e.message : "verification_failed" }); } });
router.get("/v1/public/search-products", async (req,res) => {
  try { res.json(await searchRoute(req.query.q, "products", req.query.limit)); }
  catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : "search_failed" }); }
});
router.get("/v1/public/search-auctions", async (req,res) => {
  try { res.json(await searchRoute(req.query.q, "auctions", req.query.limit)); }
  catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : "search_failed" }); }
});
router.get("/v1/public/source-health", async (_req,res): Promise<void> => {
  res.json(await sourceHealth());
});
router.get(["/v1/source-coverage", "/v1/public/source-coverage"], (_req,res) => {
  const sources = trustedSources();
  res.json({ ...computeCoverage(sources), sources });
});
router.get(["/v1/price-history", "/v1/public/price-history"], async (req,res): Promise<void> => {
  res.json(priceHistoryResponse(await getStoredPriceHistory(queryFrom(req.query.identity))));
});
router.get(["/v1/sold-comps", "/v1/public/sold-comps"], async (req,res): Promise<void> => {
  res.json(await soldCompsRoute(req.query.q, req.query.limit, req.query.market));
});
router.get(["/v1/compare", "/v1/public/compare"], async (req,res) => {
  try { res.json(await searchRoute(req.query.q, "products", req.query.limit)); }
  catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : "comparison_failed" }); }
});
router.get("/v1/admin/summary", async (_req,res): Promise<void> => {
  const sources = trustedSources();
  const [health, observations] = await Promise.all([
    sourceHealth(),
    getStoredObservations(1),
  ]);
  res.json({
    providers_total: providerRegistry.length,
    providers_available: health.filter((provider) => provider.available).length,
    registry_coverage_percent: computeCoverage(sources).measured_coverage_percent,
    conflicts_24h: 0,
    stale_24h: 0,
    observations_24h: 0,
    uptime_seconds: Math.floor((Date.now()-started)/1000),
    persistence_status: observations.status,
  });
});
router.get("/v1/admin/conflicts", (_req,res) => res.json([]));
router.get("/v1/admin/observations", async (_req,res): Promise<void> => {
  res.json((await getStoredObservations()).records);
});
router.post("/v1/admin/history/cleanup", async (req,res): Promise<void> => {
  if (!adminTokenMatches(req)) {
    res.status(403).json({ error:"forbidden" });
    return;
  }

  const body = isRecord(req.body) ? req.body : {};
  if (body.dry_run !== undefined && typeof body.dry_run !== "boolean") {
    res.status(400).json({ error:"dry_run must be a boolean" });
    return;
  }

  try {
    const result = await cleanupMarketHistory({ dryRun: body.dry_run === true });
    if (result.status === "unavailable") {
      res.status(503).json({ error:"market_persistence_unavailable" });
      return;
    }
    res.json(result);
  } catch {
    res.status(503).json({ error:"history_cleanup_failed" });
  }
});
router.post("/v1/admin/sold-comps", async (req,res): Promise<void> => {
  if (!adminTokenMatches(req)) {
    res.status(403).json({ error:"forbidden" });
    return;
  }

  const candidates = Array.isArray(req.body)
    ? req.body
    : isRecord(req.body) && Array.isArray(req.body.comps)
      ? req.body.comps
      : null;
  if (!candidates || candidates.length > 250) {
    res.status(400).json({ error:"comps must be an array with at most 250 items" });
    return;
  }

  const inputs = candidates.filter(isRecord) as SoldCompInput[];
  const persisted = await persistSoldComps(inputs);
  if (persisted.status === "unavailable") {
    res.status(503).json({ error:"market_persistence_unavailable" });
    return;
  }
  res.status(201).json({ accepted: persisted.accepted, skipped: candidates.length - persisted.accepted });
});
router.post("/v1/admin/trusted-domains", (req,res) => {
  if (!adminTokenMatches(req)) {
    res.status(403).json({ error:"forbidden" }); return;
  }
  try { res.status(201).json({ domain:addTrustedDomain(String(req.body?.domain || "")) }); }
  catch (error) { res.status(400).json({ error:error instanceof Error ? error.message : "invalid_domain" }); }
});

const setupFor = (req: Request) => {
  const base = publicBaseUrl(process.env.PUBLIC_BASE_URL, req.headers, req.protocol);
  return buildChatgptBundle(base, buildSetupBundle(base));
};
router.get(["/v1/setup-bundle", "/v1/public/setup-bundle"], (req, res) => {
  try { res.json(setupFor(req)); }
  catch { res.status(500).json({ error: "invalid_public_base_url_configuration" }); }
});

router.all("/mcp", async (req, res): Promise<void> => {
  const configuredOrigin = process.env.PUBLIC_BASE_URL?.trim();
  let allowedOrigins = (process.env.MCP_ALLOWED_ORIGINS || "").split(",").map(value => value.trim()).filter(Boolean);
  if (configuredOrigin) {
    try { allowedOrigins = [...allowedOrigins, publicBaseUrl(configuredOrigin, {}, "https")]; }
    catch { res.status(500).json({ error: "invalid_public_base_url_configuration" }); return; }
  }
  const reply = await handleMcpHttp({
    method: req.method,
    headers: req.headers,
    body: req.body,
    allowedOrigins,
    allowToolCall: () => mcpCalls(req.ip || "unknown"),
  }, {
    search_products: args => searchRoute(args.q, "products", args.limit),
    search_auctions: args => searchRoute(args.q, "auctions", args.limit),
    fetch_listing: args => genericVerify(String(args.url)),
    get_price_history: async args => priceHistoryResponse(await getStoredPriceHistory(queryFrom(args.identity ?? args.q))),
    get_sold_comps: args => soldCompsRoute(args.q, args.limit, args.market),
    compare_offers: args => searchRoute(args.q, "products", args.limit),
    verify_current_price: args => genericVerify(String(args.url)),
    get_source_health: () => sourceHealth(),
    get_source_coverage: () => {
      const sources = trustedSources();
      return { ...computeCoverage(sources), sources };
    },
    get_setup_bundle: () => setupFor(req),
  });
  res.set(reply.headers).status(reply.status);
  if (reply.body === undefined) res.end();
  else res.json(reply.body);
});

export default router;
