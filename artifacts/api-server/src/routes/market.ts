import { Router, type IRouter, type Request } from "express";
import { timingSafeEqual } from "node:crypto";
import {
  buildSoldCompsResponse,
  computeCoverage,
  normalizeObservation,
  providerRegistry,
  verifyEvidence,
} from "../market/core";
import { buildSetupBundle } from "../market/setupBundle";
import { addTrustedDomain, safeFetchPublicUrl } from "../market/urlSafety";
import {
  hasProviderAdapter,
  hasSoldCompsAdapter,
  searchMarket,
  searchSoldComps,
  sourceHealth,
} from "../market/providers";
import {
  getStoredObservations,
  getStoredPriceHistory,
  getStoredSoldComps,
  cleanupMarketHistory,
  persistObservations,
  persistSoldComps,
  type SoldCompInput,
} from "../market/storage";

const router: IRouter = Router();
const started = Date.now();
const counters = new Map<string, { day: string; count: number; minute: number; minuteCount: number }>();

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
    health: searchable ? "healthy" : "disabled",
  };
});
router.use("/v1/public", (req, res, next) => {
  const key = req.ip || "unknown", now = new Date(), day = now.toISOString().slice(0,10), minute = Math.floor(Date.now()/60000);
  const hit = counters.get(key) || { day, count: 0, minute, minuteCount: 0 };
  if (hit.day !== day) Object.assign(hit, { day, count: 0 });
  if (hit.minute !== minute) Object.assign(hit, { minute, minuteCount: 0 });
  hit.count++; hit.minuteCount++; counters.set(key, hit);
  res.setHeader("X-RateLimit-Daily-Limit", "500");
  if (hit.count > 500 || hit.minuteCount > 30) { res.status(429).json({ error: "rate_limit_exceeded" }); return; }
  res.setHeader("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
  next(); return;
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

async function soldCompsRoute(queryValue: unknown, limitValue: unknown) {
  const query = queryFrom(queryValue);
  const limit = limitFrom(limitValue);
  const live = await searchSoldComps(query, limit);
  if (live.comps.length) {
    await persistSoldComps(live.comps.map((comp) => ({
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
  }

  const stored = await getStoredSoldComps(query, limit);
  const merged = new Map<string, (typeof live.comps)[number]>();
  for (const comp of stored) merged.set(soldCompKey(comp), comp);
  for (const comp of live.comps) merged.set(soldCompKey(comp), comp);
  const comps = [...merged.values()]
    .sort((a, b) => new Date(b.sold_at).getTime() - new Date(a.sold_at).getTime())
    .slice(0, limit);
  return buildSoldCompsResponse(query, comps);
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
router.get("/v1/source-coverage", (_req,res) => {
  const sources = trustedSources();
  res.json({ ...computeCoverage(sources), sources });
});
router.get("/v1/price-history", async (req,res): Promise<void> => {
  res.json(await getStoredPriceHistory(queryFrom(req.query.identity)));
});
router.get("/v1/sold-comps", async (req,res): Promise<void> => {
  res.json(await soldCompsRoute(req.query.q, req.query.limit));
});
router.get("/v1/compare", async (req,res) => {
  try { res.json(await searchRoute(req.query.q, "products", req.query.limit)); }
  catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : "comparison_failed" }); }
});
router.get("/v1/admin/summary", async (_req,res): Promise<void> => {
  const sources = trustedSources();
  const health = await sourceHealth();
  res.json({
    providers_total: providerRegistry.length,
    providers_available: health.filter((provider) => provider.available).length,
    registry_coverage_percent: computeCoverage(sources).measured_coverage_percent,
    conflicts_24h: 0,
    stale_24h: 0,
    observations_24h: 0,
    uptime_seconds: Math.floor((Date.now()-started)/1000),
  });
});
router.get("/v1/admin/conflicts", (_req,res) => res.json([]));
router.get("/v1/admin/observations", async (_req,res): Promise<void> => {
  res.json(await getStoredObservations());
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
  const accepted = await persistSoldComps(inputs);
  res.status(201).json({ accepted, skipped: candidates.length - accepted });
});
router.post("/v1/admin/trusted-domains", (req,res) => {
  if (!adminTokenMatches(req)) {
    res.status(403).json({ error:"forbidden" }); return;
  }
  try { res.status(201).json({ domain:addTrustedDomain(String(req.body?.domain || "")) }); }
  catch (error) { res.status(400).json({ error:error instanceof Error ? error.message : "invalid_domain" }); }
});

router.get("/v1/setup-bundle", (req,res) => {
  const forwardedProto = req.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const proto = forwardedProto === "https" || forwardedProto === "http" ? forwardedProto : req.protocol;
  const forwardedHost = req.get("x-forwarded-host")?.split(",")[0]?.trim();
  const candidateHost = forwardedHost || req.get("host") || "";
  const host = /^[a-z0-9.-]+(?::\d+)?$/i.test(candidateHost) ? candidateHost : "localhost";
  res.json(buildSetupBundle(`${proto}://${host}`));
});

const toolNames = ["search_products","search_auctions","fetch_listing","get_price_history","get_sold_comps","compare_offers","verify_current_price","get_source_health","get_source_coverage"];
router.post("/mcp", async (req,res) => {
  const { id, method, params } = req.body || {};
  if (method === "initialize") { res.json({ jsonrpc:"2.0",id,result:{ protocolVersion:"2025-06-18",capabilities:{tools:{}},serverInfo:{name:"market-intel-mcp",version:"1.0.0"} } }); return; }
  if (method === "tools/list") { res.json({ jsonrpc:"2.0",id,result:{tools:toolNames.map(name=>({name,description:`Market Intel: ${name}`,inputSchema:{type:"object",properties:{q:{type:"string"},url:{type:"string"}}}}))} }); return; }
  if (method === "tools/call") {
    const name = params?.name, args = params?.arguments || {};
    try {
      let data: unknown = { error:"unknown_tool" };
      if (name === "verify_current_price" || name === "fetch_listing") data = await genericVerify(args.url);
      else if (name === "search_products" || name === "compare_offers") data = await searchRoute(args.q, "products", args.limit);
      else if (name === "search_auctions") data = await searchRoute(args.q, "auctions", args.limit);
      else if (name === "get_source_health") data = await sourceHealth();
      else if (name === "get_source_coverage") {
        const sources = trustedSources();
        data = { ...computeCoverage(sources), sources };
      }
      else if (name === "get_sold_comps") {
        data = await soldCompsRoute(args.q, args.limit);
      }
      else if (name === "get_price_history") data = await getStoredPriceHistory(queryFrom(args.identity ?? args.q));
      else data = { query: args.q || "", results: [], providers_queried: [], generated_at: new Date().toISOString() };
      res.json({ jsonrpc:"2.0", id, result:{ content:[{ type:"text", text:JSON.stringify(data) }], structuredContent:data } }); return;
    } catch (error) {
      res.json({ jsonrpc:"2.0", id, error:{ code:-32000, message:error instanceof Error ? error.message : "tool_failed" } }); return;
    }
  }
  res.status(400).json({ jsonrpc:"2.0", id, error:{ code:-32601, message:"Method not found" } }); return;
});

export default router;
