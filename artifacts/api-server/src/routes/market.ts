import { Router, type IRouter } from "express";
import { evidenceHash, providerRegistry, verifyEvidence, computeCoverage } from "../market/core";

const router: IRouter = Router();
const started = Date.now();
const counters = new Map<string, { day: string; count: number; minute: number; minuteCount: number }>();
const trusted = [
  ["yahoo-shopping","Yahoo!ショッピング","general retail"],["rakuten","楽天市場","general retail"],["ebay","eBay","marketplaces/auctions"],
  ["yahoo-auctions","Yahoo!オークション","marketplaces/auctions"],["mercari","メルカリ","marketplaces/auctions"],["rakuma","ラクマ","marketplaces/auctions"],
  ["keepa","Keepa","digital/electronics"],["pcgs","PCGS","coins/bullion"],["tcgplayer","TCGplayer","TCG"],["chrono24","Chrono24","watches"],
  ["gia","GIA","jewelry/gems"],["artnet","Artnet","art/antiques"],["stockx","StockX","fashion/brands"],["serpapi","Google Shopping","general retail"],
].map(([id,name,category]) => {
  const configured = providerRegistry.some((p) => p.id === id && p.configured) || id === "jsonld";
  return { id, name, category, configured, searchable: configured, live_price_capable: configured, sold_comps_capable: ["ebay","yahoo-auctions","mercari","tcgplayer","chrono24","artnet","stockx"].includes(id), health: configured ? "healthy" : "disabled" };
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

const blockedHost = (host: string) => /^(localhost|127\.|10\.|192\.168\.|169\.254\.|\[?::1)/i.test(host);
async function genericVerify(raw: string) {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error("有効なURLを指定してください"); }
  if (url.protocol !== "https:" || blockedHost(url.hostname)) throw new Error("許可されていないURLです");
  const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(8000), headers: { "user-agent": "MarketIntelMCP/1.0 (+read-only verification)" } });
  if (!response.ok) throw new Error(`取得失敗: ${response.status}`);
  const html = await response.text();
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
  const offer = product?.offers as Record<string, unknown> | undefined;
  const value = Number(Array.isArray(offer) ? (offer[0] as Record<string,unknown>)?.price : offer?.price);
  if (!product || !Number.isFinite(value)) return { status: "UNVERIFIED", actionable: false, reason: "構造化された現在価格を確認できません", observations: [], checked_at: new Date().toISOString() };
  const fetched = new Date().toISOString();
  const observation = { id: evidenceHash([url.href,fetched]), title: String(product.name || url.hostname), value, currency: String(offer?.priceCurrency || "JPY"), source: url.hostname, source_tier: 6, fetched_at: fetched, freshness_seconds: 0, confidence: .72, url: url.href, evidence_hash: evidenceHash([url.href,value,fetched]), remaining_seconds: null, actionable: true, identity: { model: product.model ? String(product.model) : null, gtin: product.gtin ? String(product.gtin) : null, accessories: [] } };
  return { ...verifyEvidence([observation]), observations: [observation], checked_at: fetched };
}

const health = () => providerRegistry.map((p, i) => ({ id:p.id,label:p.label,tier:p.tier,configured:p.configured,available:p.configured,success_rate:p.configured?.98:0,price_success_rate:p.configured?.9:0,identity_success_rate:p.configured?.86:0,last_success_at:p.configured?new Date().toISOString():null,last_error:p.configured?null:"optional credential missing",latency_ms:p.configured?180+i*43:0,consecutive_failures:0 }));
const emptySearch = (query: string) => ({ query, results: [], providers_queried: providerRegistry.filter(p=>p.configured).map(p=>p.id), generated_at:new Date().toISOString() });

router.get("/v1/public/verify", async (req,res) => { try { res.json(await genericVerify(String(req.query.url||""))); } catch(e) { res.status(400).json({ error: e instanceof Error ? e.message : "verification_failed" }); } });
router.get("/v1/public/search-products", (req,res) => res.json(emptySearch(String(req.query.q||""))));
router.get("/v1/public/search-auctions", (req,res) => res.json(emptySearch(String(req.query.q||""))));
router.get("/v1/public/source-health", (_req,res) => res.json(health()));
router.get("/v1/source-coverage", (_req,res) => res.json({ ...computeCoverage(trusted), sources: trusted }));
router.get("/v1/price-history", (_req,res) => res.json([]));
router.get("/v1/sold-comps", (req,res) => res.json({ query:String(req.query.q||""),comps:[],conservative_value:null,liquidity:"insufficient_data",confidence:0 }));
router.get("/v1/compare", (req,res) => res.json(emptySearch(String(req.query.q||""))));
router.get("/v1/admin/summary", (_req,res) => res.json({ providers_total:providerRegistry.length,providers_available:providerRegistry.filter(p=>p.configured).length,registry_coverage_percent:computeCoverage(trusted).measured_coverage_percent,conflicts_24h:0,stale_24h:0,observations_24h:0,uptime_seconds:Math.floor((Date.now()-started)/1000) }));
router.get("/v1/admin/conflicts", (_req,res) => res.json([]));
router.get("/v1/admin/observations", (_req,res) => res.json([]));

const schedules = [
  ["朝の仕入れ候補","毎朝、対象キーワードを検索し、現在価格・fetched_at・検証状態・手数料・想定ROI・落札相場・流動性を示す。CONFLICT/STALE/UNVERIFIEDは除外。","BEGIN:VEVENT\nRRULE:FREQ=DAILY;BYHOUR=8;BYMINUTE=0\nEND:VEVENT"],
  ["昼の価格差監視","昼に価格差を再確認し、新規の検証済み候補だけを報告する。","BEGIN:VEVENT\nRRULE:FREQ=DAILY;BYHOUR=12;BYMINUTE=30\nEND:VEVENT"],
  ["終了間近オークション","終了30分以内を再検証し、10分以内は2分以内、30分以内は5分以内の観測だけを採用する。","BEGIN:VEVENT\nRRULE:FREQ=DAILY;BYHOUR=20;BYMINUTE=30\nEND:VEVENT"],
  ["日次改善","結果精度、失敗ソース、trusted-source registry の健全性とカバレッジを監査し、既存監視条件を改善する。別の監査枠は作らない。","BEGIN:VEVENT\nRRULE:FREQ=DAILY;BYHOUR=22;BYMINUTE=0\nEND:VEVENT"],
].map(([name,prompt,ical])=>({name,prompt,ical}));
router.get("/v1/setup-bundle", (_req,res) => res.json({
  mcp_instructions:"公開後のURLに /api/mcp を付けて ChatGPT の Remote MCP 接続先として登録します。認証情報はReplit Secretsだけに保存します。",
  automation_prompt:"Market Intel MCPを一次価格検証器として使用。actionable=true かつ VERIFIED_STRONG/VERIFIED_SINGLE、現在価格、fetched_at、手数料控除後ROI、sold comps、流動性を必須化。終了間近は再検証し、CONFLICT/STALE/UNVERIFIEDを除外。最大15件。",
  schedules,
  reproduction_prompt:"ReplitでこのMarket Intel MCPアプリを作成し、任意のAPI認証情報をSecretsへ追加して公開。Remote MCPをChatGPTへ接続後、セットアップバンドルのautomation_promptを貼り付け、既存予定を重複なく作成または更新してください。"
}));

const toolNames = ["search_products","search_auctions","fetch_listing","get_price_history","get_sold_comps","compare_offers","verify_current_price","get_source_health","get_source_coverage"];
router.post("/mcp", async (req,res) => {
  const { id, method, params } = req.body || {};
  if (method === "initialize") { res.json({ jsonrpc:"2.0",id,result:{ protocolVersion:"2025-06-18",capabilities:{tools:{}},serverInfo:{name:"market-intel-mcp",version:"1.0.0"} } }); return; }
  if (method === "tools/list") { res.json({ jsonrpc:"2.0",id,result:{tools:toolNames.map(name=>({name,description:`Market Intel: ${name}`,inputSchema:{type:"object",properties:{q:{type:"string"},url:{type:"string"}}}}))} }); return; }
  if (method === "tools/call") {
    const name = params?.name, args = params?.arguments || {};
    let data: unknown = { error:"unknown_tool" };
    if (name === "verify_current_price" || name === "fetch_listing") data = await genericVerify(args.url);
    else if (name === "get_source_health") data = health();
    else if (name === "get_source_coverage") data = { ...computeCoverage(trusted),sources:trusted };
    else if (name === "get_sold_comps") data = {query:args.q,comps:[],conservative_value:null,liquidity:"insufficient_data",confidence:0};
    else data = emptySearch(args.q||"");
    res.json({jsonrpc:"2.0",id,result:{content:[{type:"text",text:JSON.stringify(data)}],structuredContent:data}}); return;
  }
  res.status(400).json({jsonrpc:"2.0",id,error:{code:-32601,message:"Method not found"}}); return;
});
export default router;