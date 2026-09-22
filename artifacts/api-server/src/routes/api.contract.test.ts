import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";
import app from "../app";

const fixtureScript = fileURLToPath(new URL("../market/persistence-fixture.ts", import.meta.url));
const apiServerRoot = join(dirname(fixtureScript), "../..");

async function withServer(run: (base: string) => Promise<void>) {
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server unavailable");
  try { await run(`http://127.0.0.1:${address.port}/api`); }
  finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
}

function databaseUrlFor(databaseName: string) {
  const url = new URL(process.env.DATABASE_URL || "");
  url.pathname = `/${databaseName}`;
  return url.toString();
}

function runFixture(
  mode: "create-database" | "drop-database" | "setup" | "write-mixed-market",
  databaseUrl: string,
  marker: string,
  databaseName?: string,
) {
  return execFileSync(
    process.execPath,
    ["--import", "tsx", fixtureScript, mode],
    {
      cwd: apiServerRoot,
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl,
        MARKET_TEST_MARKER: marker,
        ...(databaseName ? { MARKET_TEST_DATABASE_NAME: databaseName } : {}),
      },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  ).trim();
}

async function findAvailablePort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Could not determine the API test port");
  }
  const port = address.port;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  return port;
}

async function withApiProcess(
  databaseUrl: string,
  disabledProviderEnvNames: readonly string[],
  run: (base: string) => Promise<void>,
) {
  const port = await findAvailablePort();
  const entrypoint = fileURLToPath(new URL("../index.ts", import.meta.url));
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    DATABASE_URL: databaseUrl,
    NODE_ENV: "production",
    LOG_LEVEL: "info",
    PORT: String(port),
  };
  for (const name of disabledProviderEnvNames) delete childEnv[name];

  const child = spawn(process.execPath, ["--import", "tsx", entrypoint], {
    cwd: apiServerRoot,
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (!child.stdout || !child.stderr) {
    child.kill("SIGTERM");
    throw new Error("Could not capture API startup output");
  }

  let output = "";
  const appendOutput = (chunk: Buffer | string) => {
    output += chunk.toString();
  };
  child.stdout.on("data", appendOutput);
  child.stderr.on("data", appendOutput);

  const started = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`API did not start within the timeout\n${output}`));
    }, 5_000);
    const checkOutput = () => {
      if (output.includes('"msg":"Server listening"')) {
        clearTimeout(timeout);
        resolve();
      }
    };
    child.stdout?.on("data", checkOutput);
    child.stderr?.on("data", checkOutput);
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      reject(new Error(`API exited before startup (code=${code}, signal=${signal})\n${output}`));
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
  const exit = new Promise<void>((resolve) => child.once("exit", () => resolve()));

  try {
    await started;
    await run(`http://127.0.0.1:${port}/api`);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    const exited = await Promise.race([
      exit.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 1_000)),
    ]);
    if (!exited) {
      child.kill("SIGKILL");
      await exit;
    }
  }
}

test("public GET endpoint schemas remain stable", () => withServer(async (base) => {
  const [health, coverage, sourceHealth] = await Promise.all([
    fetch(`${base}/healthz`).then((r) => r.json()),
    fetch(`${base}/v1/source-coverage`).then((r) => r.json()),
    fetch(`${base}/v1/public/source-health`).then((r) => r.json()),
  ]) as [{ status: string }, { measured_coverage_percent: number }, Array<{ configured: boolean; sold_comps_capable: boolean }>];
  assert.equal(health.status, "ok");
  assert.equal(typeof coverage.measured_coverage_percent, "number");
  assert.ok(Array.isArray(sourceHealth));
  assert.equal(typeof sourceHealth[0].configured, "boolean");
  assert.equal(typeof sourceHealth[0].sold_comps_capable, "boolean");
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
  for (const secretName of [
    "YAHOO_CLIENT_ID",
    "RAKUTEN_APP_ID",
    "EBAY_CLIENT_ID",
    "STOCKX_API_KEY",
    "STOCKX_ACCESS_TOKEN",
    "STOCKX_REFRESH_TOKEN",
    "STOCKX_CLIENT_ID",
    "STOCKX_CLIENT_SECRET",
    "KEEPA_API_KEY",
    "SERPAPI_KEY",
    "APIFY_TOKEN",
    "BRIGHT_DATA_TOKEN",
  ]) {
    assert.equal(combined.includes(secretName), false);
  }
}));

test("sold comps endpoint returns structured official sales with identity", { concurrency: false }, () => withServer(async (base) => {
  const savedDatabaseUrl = process.env.DATABASE_URL;
  const savedEbayClientId = process.env.EBAY_CLIENT_ID;
  const savedEbayAccessToken = process.env.EBAY_ACCESS_TOKEN;
  const originalFetch = globalThis.fetch;
  const recentSoldAt = new Date(Date.now() - 2 * 24 * 60 * 60 * 1_000).toISOString();
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
          soldPrice: { value: "100", currency: "USD" },
          lastSoldDate: recentSoldAt,
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
      persistence_status: string;
      freshness: {
        status: string;
         recent_window_days: number;
        recent_count: number;
        stale_count: number;
        missing_count: number;
        latest_sold_at: string | null;
        oldest_sold_at: string | null;
      };
    };
    assert.equal(body.comps.length, 1);
    assert.deepEqual(body.comps[0], {
      title: "Sold camera",
      sold_price: 100,
      currency: "USD",
      source: "ebay",
        sold_at: recentSoldAt,
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
    assert.equal(body.persistence_status, "unavailable");
    assert.deepEqual(body.freshness, {
      status: "recent",
      recent_window_days: 30,
      recent_count: 1,
      stale_count: 0,
      missing_count: 0,
      latest_sold_at: recentSoldAt,
      oldest_sold_at: recentSoldAt,
    });
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

test("sold comps market routing excludes unsupported providers and preserves omitted fan-out", { concurrency: false }, () => withServer(async (base) => {
  const savedDatabaseUrl = process.env.DATABASE_URL;
  const savedProviderEnv = new Map<string, string | undefined>([
    ["EBAY_CLIENT_ID", process.env.EBAY_CLIENT_ID],
    ["EBAY_ACCESS_TOKEN", process.env.EBAY_ACCESS_TOKEN],
    ["STOCKX_API_KEY", process.env.STOCKX_API_KEY],
    ["STOCKX_ACCESS_TOKEN", process.env.STOCKX_ACCESS_TOKEN],
  ]);
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  try {
    process.env.DATABASE_URL = "";
    process.env.EBAY_CLIENT_ID = "test-ebay";
    process.env.EBAY_ACCESS_TOKEN = "test-ebay-token";
    process.env.STOCKX_API_KEY = "test-stockx";
    process.env.STOCKX_ACCESS_TOKEN = "test-stockx-access-token";
    globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith(base)) return originalFetch(input, init);
      calls.push(url);
      if (url.includes("/buy/marketplace-insights/v1_beta/item_sales/search")) {
        return new Response(JSON.stringify({
          itemSales: [{
            title: "Market-routed camera",
            soldPrice: { value: "100", currency: "USD" },
            lastSoldDate: new Date(Date.now() - 2 * 24 * 60 * 60 * 1_000).toISOString(),
            condition: "USED",
            itemWebUrl: "https://www.ebay.example/market-routed-camera",
            itemId: "market-routed-camera",
          }],
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.includes("/v2/catalog/search")) {
        return new Response(JSON.stringify({ products: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/v2/selling/orders/history")) {
        return new Response(JSON.stringify({ orders: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`Unexpected test URL: ${url}`);
    }) as typeof fetch;

    const supported = await fetch(`${base}/v1/sold-comps?q=market-routing&limit=10&market=EBAY_US`);
    assert.equal(supported.status, 200);
    const supportedBody = await supported.json() as { comps: Array<{ source: string }> };
    assert.deepEqual(supportedBody.comps.map((comp) => comp.source), ["ebay"]);
    assert.equal(calls.some((url) => url.includes("stockx.com")), false);

    calls.length = 0;
    const unknown = await fetch(`${base}/v1/sold-comps?q=market-routing&limit=10&market=unknown-market`);
    assert.equal(unknown.status, 200);
    const unknownBody = await unknown.json() as { comps: unknown[] };
    assert.deepEqual(unknownBody.comps, []);
    assert.equal(calls.length, 0);

    calls.length = 0;
    const omitted = await fetch(`${base}/v1/sold-comps?q=market-routing&limit=10`);
    assert.equal(omitted.status, 200);
    assert.equal(calls.some((url) => url.includes("stockx.com")), true);
  } finally {
    globalThis.fetch = originalFetch;
    if (savedDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = savedDatabaseUrl;
    for (const [name, value] of savedProviderEnv) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}));

test("sold comps route filters persisted market history before applying the limit", {
  concurrency: false,
  skip: !process.env.DATABASE_URL,
}, async () => {
  const savedDatabaseUrl = process.env.DATABASE_URL;
  if (!savedDatabaseUrl) return;

  const marker = `market_route_${process.pid}_${Date.now()}_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
  const databaseName = `${marker}_db`;
  const databaseUrl = databaseUrlFor(databaseName);
  const providerEnvNames = [
    "EBAY_CLIENT_ID",
    "EBAY_CLIENT_SECRET",
    "EBAY_ACCESS_TOKEN",
    "STOCKX_API_KEY",
    "STOCKX_ACCESS_TOKEN",
    "STOCKX_REFRESH_TOKEN",
    "STOCKX_CLIENT_ID",
    "STOCKX_CLIENT_SECRET",
  ];
  let databaseCreated = false;

  try {
    runFixture("create-database", savedDatabaseUrl, marker, databaseName);
    databaseCreated = true;
    runFixture("setup", databaseUrl, marker);
    runFixture("write-mixed-market", databaseUrl, marker);

    await withApiProcess(databaseUrl, providerEnvNames, async (base) => {
      const supported = await fetch(
        `${base}/v1/sold-comps?q=${encodeURIComponent(marker)}&limit=1&market=EBAY_US`,
      );
      assert.equal(supported.status, 200);
      const supportedBody = await supported.json() as {
        comps: Array<{ source: string; title: string }>;
        persistence_status: string;
      };
      assert.equal(supportedBody.persistence_status, "available");
      assert.deepEqual(supportedBody.comps.map((comp) => comp.source), ["ebay"]);
      assert.equal(supportedBody.comps[0]?.title, `Mixed market ${marker} ebay-older`);

      const omitted = await fetch(
        `${base}/v1/sold-comps?q=${encodeURIComponent(marker)}&limit=10`,
      );
      assert.equal(omitted.status, 200);
      const omittedBody = await omitted.json() as {
        comps: Array<{ source: string }>;
        persistence_status: string;
      };
      assert.equal(omittedBody.persistence_status, "available");
      assert.deepEqual(omittedBody.comps.map((comp) => comp.source), [
        "stockx",
        "stockx",
        "ebay",
        "ebay",
      ]);
    });
  } finally {
    if (databaseCreated) {
      runFixture("drop-database", savedDatabaseUrl, marker, databaseName);
    }
  }
});

test("sold comps freshness reports missing evidence when no sales are available", { concurrency: false }, () => withServer(async (base) => {
  const savedDatabaseUrl = process.env.DATABASE_URL;
  const originalFetch = globalThis.fetch;
  try {
    process.env.DATABASE_URL = "";
    globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
      if (String(input).startsWith(base)) return originalFetch(input, init);
      throw new Error(`Unexpected live sold-comps request: ${String(input)}`);
    }) as typeof fetch;

    const response = await fetch(`${base}/v1/sold-comps?q=missing-camera&limit=10`);
    assert.equal(response.status, 200);
    const body = await response.json() as {
      comps: unknown[];
      conservative_value: number | null;
      freshness: {
        status: string;
        recent_window_days: number;
        recent_count: number;
        stale_count: number;
        missing_count: number;
        latest_sold_at: string | null;
        oldest_sold_at: string | null;
      };
    };
    assert.deepEqual(body.comps, []);
    assert.equal(body.conservative_value, null);
    assert.deepEqual(body.freshness, {
      status: "missing",
      recent_window_days: 30,
      recent_count: 0,
      stale_count: 0,
      missing_count: 0,
      latest_sold_at: null,
      oldest_sold_at: null,
    });
  } finally {
    globalThis.fetch = originalFetch;
    if (savedDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = savedDatabaseUrl;
  }
}));

test("sold comps freshness flags old evidence without changing the estimate", { concurrency: false }, () => withServer(async (base) => {
  const savedDatabaseUrl = process.env.DATABASE_URL;
  const savedEbayClientId = process.env.EBAY_CLIENT_ID;
  const savedEbayAccessToken = process.env.EBAY_ACCESS_TOKEN;
  const savedEbayMarketplace = process.env.EBAY_MARKETPLACE_ID;
  const originalFetch = globalThis.fetch;
  const staleSoldAt = new Date(Date.now() - 45 * 24 * 60 * 60 * 1_000).toISOString();
  try {
    process.env.DATABASE_URL = "";
    process.env.EBAY_CLIENT_ID = "test-ebay";
    process.env.EBAY_ACCESS_TOKEN = "test-ebay-token";
    process.env.EBAY_MARKETPLACE_ID = "EBAY_US";
    globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith(base)) return originalFetch(input, init);
      if (url.includes("/buy/marketplace-insights/v1_beta/item_sales/search")) {
        return new Response(JSON.stringify({
          itemSales: [{
            title: "Stale camera",
            soldPrice: { value: "100", currency: "USD" },
            lastSoldDate: staleSoldAt,
            condition: "USED",
            itemWebUrl: "https://www.ebay.example/stale-camera",
            itemId: "stale-camera",
            gtin: "4900000000001",
            brand: "Example",
          }],
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`Unexpected test URL: ${url}`);
    }) as typeof fetch;

    const response = await fetch(`${base}/v1/sold-comps?q=stale-camera&limit=10`);
    assert.equal(response.status, 200);
    const body = await response.json() as {
      conservative_value: number | null;
      freshness: {
        status: string;
        recent_window_days: number;
        recent_count: number;
        stale_count: number;
        missing_count: number;
        latest_sold_at: string | null;
        oldest_sold_at: string | null;
      };
    };
    assert.equal(body.conservative_value, 15000);
    assert.deepEqual(body.freshness, {
      status: "stale",
      recent_window_days: 30,
      recent_count: 0,
      stale_count: 1,
      missing_count: 0,
      latest_sold_at: staleSoldAt,
      oldest_sold_at: staleSoldAt,
    });
  } finally {
    globalThis.fetch = originalFetch;
    if (savedDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = savedDatabaseUrl;
    if (savedEbayClientId === undefined) delete process.env.EBAY_CLIENT_ID;
    else process.env.EBAY_CLIENT_ID = savedEbayClientId;
    if (savedEbayAccessToken === undefined) delete process.env.EBAY_ACCESS_TOKEN;
    else process.env.EBAY_ACCESS_TOKEN = savedEbayAccessToken;
    if (savedEbayMarketplace === undefined) delete process.env.EBAY_MARKETPLACE_ID;
    else process.env.EBAY_MARKETPLACE_ID = savedEbayMarketplace;
  }
}));

test("sold comps freshness flags mixed-age evidence without changing the estimate", { concurrency: false }, () => withServer(async (base) => {
  const savedDatabaseUrl = process.env.DATABASE_URL;
  const savedEbayClientId = process.env.EBAY_CLIENT_ID;
  const savedEbayAccessToken = process.env.EBAY_ACCESS_TOKEN;
  const savedEbayMarketplace = process.env.EBAY_MARKETPLACE_ID;
  const originalFetch = globalThis.fetch;
  const recentSoldAt = new Date(Date.now() - 2 * 24 * 60 * 60 * 1_000).toISOString();
  const staleSoldAt = new Date(Date.now() - 45 * 24 * 60 * 60 * 1_000).toISOString();
  try {
    process.env.DATABASE_URL = "";
    process.env.EBAY_CLIENT_ID = "test-ebay";
    process.env.EBAY_ACCESS_TOKEN = "test-ebay-token";
    process.env.EBAY_MARKETPLACE_ID = "EBAY_US";
    globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith(base)) return originalFetch(input, init);
      if (url.includes("/buy/marketplace-insights/v1_beta/item_sales/search")) {
        return new Response(JSON.stringify({
          itemSales: [
            {
              title: "Recent camera",
              soldPrice: { value: "100", currency: "USD" },
              lastSoldDate: recentSoldAt,
              condition: "USED",
              itemWebUrl: "https://www.ebay.example/recent-camera",
              itemId: "recent-camera",
              gtin: "4900000000001",
              brand: "Example",
            },
            {
              title: "Stale camera",
              soldPrice: { value: "100", currency: "USD" },
              lastSoldDate: staleSoldAt,
              condition: "USED",
              itemWebUrl: "https://www.ebay.example/stale-camera",
              itemId: "stale-camera",
              gtin: "4900000000001",
              brand: "Example",
            },
          ],
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`Unexpected test URL: ${url}`);
    }) as typeof fetch;

    const response = await fetch(`${base}/v1/sold-comps?q=mixed-camera&limit=10`);
    assert.equal(response.status, 200);
    const body = await response.json() as {
      comps: unknown[];
      conservative_value: number | null;
      freshness: {
        status: string;
        recent_window_days: number;
        recent_count: number;
        stale_count: number;
        missing_count: number;
        latest_sold_at: string | null;
        oldest_sold_at: string | null;
      };
    };
    assert.equal(body.comps.length, 2);
    assert.equal(body.conservative_value, 15000);
    assert.deepEqual(body.freshness, {
      status: "stale",
      recent_window_days: 30,
      recent_count: 1,
      stale_count: 1,
      missing_count: 0,
      latest_sold_at: recentSoldAt,
      oldest_sold_at: staleSoldAt,
    });
  } finally {
    globalThis.fetch = originalFetch;
    if (savedDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = savedDatabaseUrl;
    if (savedEbayClientId === undefined) delete process.env.EBAY_CLIENT_ID;
    else process.env.EBAY_CLIENT_ID = savedEbayClientId;
    if (savedEbayAccessToken === undefined) delete process.env.EBAY_ACCESS_TOKEN;
    else process.env.EBAY_ACCESS_TOKEN = savedEbayAccessToken;
    if (savedEbayMarketplace === undefined) delete process.env.EBAY_MARKETPLACE_ID;
    else process.env.EBAY_MARKETPLACE_ID = savedEbayMarketplace;
  }
}));

test("sold comps route exposes configured freshness window and safe fallback", { concurrency: false }, () => withServer(async (base) => {
  const savedDatabaseUrl = process.env.DATABASE_URL;
  const savedRecencyDays = process.env.SOLD_COMP_RECENCY_DAYS;
  const savedMarketOverrides = process.env.SOLD_COMP_RECENCY_DAYS_BY_MARKET;
  const savedProviderEnv = new Map<string, string | undefined>();
  const providerEnvNames = [
    "EBAY_CLIENT_ID",
    "EBAY_CLIENT_SECRET",
    "EBAY_ACCESS_TOKEN",
    "STOCKX_API_KEY",
    "STOCKX_ACCESS_TOKEN",
    "STOCKX_REFRESH_TOKEN",
    "STOCKX_CLIENT_ID",
    "STOCKX_CLIENT_SECRET",
  ];
  for (const name of providerEnvNames) savedProviderEnv.set(name, process.env[name]);

  async function recentWindowDays(market?: string) {
    const marketParam = market ? `&market=${encodeURIComponent(market)}` : "";
    const response = await fetch(`${base}/v1/sold-comps?q=freshness-window&limit=10${marketParam}`);
    assert.equal(response.status, 200);
    const body = await response.json() as { freshness: { recent_window_days: number } };
    return body.freshness.recent_window_days;
  }

  try {
    process.env.DATABASE_URL = "";
    for (const name of providerEnvNames) delete process.env[name];

    delete process.env.SOLD_COMP_RECENCY_DAYS;
    delete process.env.SOLD_COMP_RECENCY_DAYS_BY_MARKET;
    assert.equal(await recentWindowDays(), 30);

    process.env.SOLD_COMP_RECENCY_DAYS = "14";
    assert.equal(await recentWindowDays(), 14);

    process.env.SOLD_COMP_RECENCY_DAYS_BY_MARKET = JSON.stringify({ EBAY_US: 7, invalid: 0 });
    assert.equal(await recentWindowDays("EBAY_US"), 7);
    assert.equal(await recentWindowDays("missing-market"), 14);
    assert.equal(await recentWindowDays("invalid"), 14);

    process.env.SOLD_COMP_RECENCY_DAYS = "0";
    assert.equal(await recentWindowDays("EBAY_US"), 7);
    assert.equal(await recentWindowDays("missing-market"), 30);

    process.env.SOLD_COMP_RECENCY_DAYS_BY_MARKET = "{not-json";
    assert.equal(await recentWindowDays("EBAY_US"), 30);
  } finally {
    if (savedDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = savedDatabaseUrl;
    if (savedRecencyDays === undefined) delete process.env.SOLD_COMP_RECENCY_DAYS;
    else process.env.SOLD_COMP_RECENCY_DAYS = savedRecencyDays;
    if (savedMarketOverrides === undefined) delete process.env.SOLD_COMP_RECENCY_DAYS_BY_MARKET;
    else process.env.SOLD_COMP_RECENCY_DAYS_BY_MARKET = savedMarketOverrides;
    for (const [name, value] of savedProviderEnv) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}));

test("history endpoint distinguishes unavailable persistence from no history", { concurrency: false }, () => withServer(async (base) => {
  const savedDatabaseUrl = process.env.DATABASE_URL;
  try {
    process.env.DATABASE_URL = "";
    const response = await fetch(`${base}/v1/price-history?identity=camera`);
    assert.equal(response.status, 200);
    const body = await response.json() as {
      observations: unknown[];
      persistence_status: string;
    };
    assert.deepEqual(body, {
      observations: [],
      persistence_status: "unavailable",
    });
  } finally {
    if (savedDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = savedDatabaseUrl;
  }
}));