import test from "node:test";
import assert from "node:assert/strict";
import app from "../app";

async function withServer(run: (base: string) => Promise<void>) {
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server unavailable");
  try { await run(`http://127.0.0.1:${address.port}/api`); }
  finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
}

test("public GET endpoint schemas remain stable", () => withServer(async (base) => {
  const [health, coverage, sourceHealth] = await Promise.all([
    fetch(`${base}/healthz`).then((r) => r.json()),
    fetch(`${base}/v1/source-coverage`).then((r) => r.json()),
    fetch(`${base}/v1/public/source-health`).then((r) => r.json()),
  ]) as [{ status: string }, { measured_coverage_percent: number }, Array<{ configured: boolean }>];
  assert.equal(health.status, "ok");
  assert.equal(typeof coverage.measured_coverage_percent, "number");
  assert.ok(Array.isArray(sourceHealth));
  assert.equal(typeof sourceHealth[0].configured, "boolean");
}));

test("generic fallback rejects private and unsafe URLs", () => withServer(async (base) => {
  const response = await fetch(`${base}/v1/public/verify?url=${encodeURIComponent("http://127.0.0.1/secret")}`);
  assert.equal(response.status, 400);
}));

test("unknown public domains are not fetched and return UNVERIFIED unsupported", () => withServer(async (base) => {
  const response = await fetch(`${base}/v1/public/verify?url=${encodeURIComponent("https://unknown.example/item")}`);
  assert.equal(response.status, 200);
  const body = await response.json() as { status:string; actionable:boolean; reason:string; observations:unknown[]; checked_at:string };
  assert.deepEqual(body, { status:"UNVERIFIED", actionable:false, reason:"UNSUPPORTED_DOMAIN", observations:[], checked_at:body.checked_at });
}));

test("admin trusted-domain extension is closed when no secret is configured", () => withServer(async (base) => {
  const response = await fetch(`${base}/v1/admin/trusted-domains`, {
    method:"POST", headers:{"content-type":"application/json","x-admin-token":"guess"},
    body:JSON.stringify({domain:"partner.example"}),
  });
  assert.equal(response.status, 403);
}));

test("public API enforces strict minute rate limit", () => withServer(async (base) => {
  let status = 200;
  for (let i = 0; i < 31; i++) status = (await fetch(`${base}/v1/public/source-health`, { headers: { "x-forwarded-for": "203.0.113.9" } })).status;
  assert.equal(status, 429);
}));

test("MCP schema exposes every required tool", () => withServer(async (base) => {
  const response = await fetch(`${base}/mcp`, { method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/list"}) });
  const body = await response.json() as { result: { tools: Array<{ name: string }> } };
  const names = body.result.tools.map((tool: { name: string }) => tool.name);
  for (const required of ["search_products","search_auctions","fetch_listing","get_price_history","get_sold_comps","compare_offers","verify_current_price","get_source_health","get_source_coverage"]) assert.ok(names.includes(required));
}));

test("setup bundle contains Full 14 and exact Core 6 packs with deployed URL", () => withServer(async (base) => {
  const response = await fetch(`${base}/v1/setup-bundle`, {
    headers: { "x-forwarded-proto": "https", "x-forwarded-host": "intel.example.com" },
  });
  const body = await response.json() as {
    deployed_base_url: string;
    full_schedule_pack: Array<{ name: string; prompt: string; ical: string }>;
    core_6_pack: Array<{ name: string; prompt: string; ical: string }>;
    app_reproduction_prompt: string;
    chatgpt_setup_prompt: string;
  };
  assert.equal(body.deployed_base_url, "https://intel.example.com");
  assert.equal(body.full_schedule_pack.length, 14);
  assert.deepEqual(body.core_6_pack.map((x) => x.name), [
    "終了2時間以内スキャン", "終了12時間以内スキャン", "C2C価格差スキャン",
    "固定買取・新品セール裁定スキャン", "朝の統合レポート", "日次改善",
  ]);
  for (const schedule of body.full_schedule_pack) {
    assert.match(schedule.prompt, /https:\/\/intel\.example\.com\/api\/mcp/);
    assert.match(schedule.prompt, /CONFLICT\/STALE\/UNVERIFIED/);
    assert.match(schedule.prompt, /推測しない/);
    assert.match(schedule.ical, /BEGIN:VCALENDAR[\s\S]*RRULE:/);
  }
  assert.match(body.app_reproduction_prompt, /Replit Secrets/);
  assert.match(body.chatgpt_setup_prompt, /14件/);
}));

test("setup and health responses never expose credential environment names or values", () => withServer(async (base) => {
  const responses = await Promise.all([
    fetch(`${base}/v1/setup-bundle`).then((r) => r.text()),
    fetch(`${base}/v1/public/source-health`).then((r) => r.text()),
  ]);
  const combined = responses.join("\n");
  for (const secretName of ["YAHOO_CLIENT_ID","RAKUTEN_APP_ID","EBAY_CLIENT_ID","KEEPA_API_KEY","SERPAPI_KEY","APIFY_TOKEN","BRIGHT_DATA_TOKEN"]) {
    assert.equal(combined.includes(secretName), false);
  }
}));

test("sold comps endpoint returns structured official sales with identity", { concurrency: false }, () => withServer(async (base) => {
  const savedDatabaseUrl = process.env.DATABASE_URL;
  const savedEbayClientId = process.env.EBAY_CLIENT_ID;
  const savedEbayAccessToken = process.env.EBAY_ACCESS_TOKEN;
  const originalFetch = globalThis.fetch;
  try {
    process.env.DATABASE_URL = "";
    process.env.EBAY_CLIENT_ID = "test-ebay";
    process.env.EBAY_ACCESS_TOKEN = "test-ebay-token";
    globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith(base)) return originalFetch(input, init);
      if (!url.includes("/buy/marketplace-insights/v1_beta/item_sales/search")) {
        throw new Error(`Unexpected test URL: ${url}`);
      }
      return new Response(JSON.stringify({
        itemSales: [{
          title: "Sold camera",
          price: { value: "100", currency: "USD" },
          lastSoldDate: "2026-09-19T10:00:00.000Z",
          condition: "USED",
          itemWebUrl: "https://www.ebay.example/sold-camera",
          itemId: "sold-camera",
          gtin: "4900000000001",
          brand: "Example",
        }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    const response = await fetch(`${base}/v1/sold-comps?q=camera&limit=10`);
    assert.equal(response.status, 200);
    const body = await response.json() as {
      comps: Array<{
        source: string;
        sold_at: string;
        sold_price: number;
        condition: string;
        url: string;
        identity: { brand?: string; gtin?: string };
      }>;
      conservative_value: number | null;
      liquidity: string;
      confidence: number;
    };
    assert.equal(body.comps.length, 1);
    assert.deepEqual(body.comps[0], {
      title: "Sold camera",
      sold_price: 100,
      currency: "USD",
      source: "ebay",
      sold_at: "2026-09-19T10:00:00.000Z",
      normalized_price: 15000,
      condition: "good",
      url: "https://www.ebay.example/sold-camera",
      identity: {
        brand: "Example",
        gtin: "4900000000001",
        condition: "USED",
        accessories: [],
      },
    });
    assert.equal(body.conservative_value, 15000);
    assert.equal(body.liquidity, "low");
    assert.equal(body.confidence, 0.15);
  } finally {
    globalThis.fetch = originalFetch;
    if (savedDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = savedDatabaseUrl;
    if (savedEbayClientId === undefined) delete process.env.EBAY_CLIENT_ID;
    else process.env.EBAY_CLIENT_ID = savedEbayClientId;
    if (savedEbayAccessToken === undefined) delete process.env.EBAY_ACCESS_TOKEN;
    else process.env.EBAY_ACCESS_TOKEN = savedEbayAccessToken;
  }
}));