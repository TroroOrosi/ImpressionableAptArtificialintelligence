import assert from "node:assert/strict";
import test from "node:test";
import { availableProviderIds, availableSoldProviderIds, searchMarket, searchSoldComps, sourceHealth } from "./providers";

const providerEnv = [
  "YAHOO_CLIENT_ID",
  "RAKUTEN_APP_ID",
  "RAKUTEN_ACCESS_KEY",
  "EBAY_CLIENT_ID",
  "EBAY_CLIENT_SECRET",
  "EBAY_ACCESS_TOKEN",
  "EBAY_MARKETPLACE_ID",
  "EBAY_SANDBOX",
  "STOCKX_API_KEY",
  "STOCKX_ACCESS_TOKEN",
  "STOCKX_REFRESH_TOKEN",
  "STOCKX_CLIENT_ID",
  "STOCKX_CLIENT_SECRET",
  "KEEPA_API_KEY",
  "SERPAPI_KEY",
  "APIFY_TOKEN",
  "APIFY_ACTOR_ID",
  "APIFY_STRUCTURED_ACTOR_ID",
  "BRIGHT_DATA_TOKEN",
  "BRIGHT_DATA_ZONE",
];

function saveProviderEnv() {
  return new Map(providerEnv.map((name) => [name, process.env[name]]));
}

function clearProviderEnv() {
  for (const name of providerEnv) delete process.env[name];
}

function restoreProviderEnv(saved: Map<string, string | undefined>) {
  clearProviderEnv();
  for (const [name, value] of saved) {
    if (value !== undefined) process.env[name] = value;
  }
}

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function ebaySoldItemFixture(overrides: Record<string, unknown> = {}) {
  return {
    title: "Sold camera",
    soldPrice: { value: "100", currency: "USD" },
    lastSoldDate: "2026-09-19T10:00:00.000Z",
    condition: "USED",
    itemWebUrl: "https://www.ebay.example/sold-camera",
    itemId: "sold-camera",
    gtin: "4900000000001",
    brand: "Example",
    ...overrides,
  };
}

function ebayPriceFieldFixture() {
  return ebaySoldItemFixture({
    title: "Sold camera with price field",
    soldPrice: undefined,
    price: { amount: "125", currency: "USD" },
    itemWebUrl: "https://www.ebay.example/sold-camera-price",
    itemId: "sold-camera-price",
  });
}

function ebayScalarSoldPriceFixture() {
  return ebaySoldItemFixture({
    title: "Sold camera with scalar sold price",
    soldPrice: "150",
    currency: "USD",
    lastSoldDate: undefined,
    transactionDate: "2026-09-17T10:00:00.000Z",
    condition: undefined,
    itemCondition: "NEW",
    itemWebUrl: undefined,
    url: "https://www.ebay.example/sold-camera-scalar",
    itemId: undefined,
    epid: "sold-camera-scalar",
  });
}

test("official adapters normalize product and auction observations in priority order", { concurrency: false }, async () => {
  const savedEnv = saveProviderEnv();
  const originalFetch = globalThis.fetch;
  try {
    clearProviderEnv();
    process.env.YAHOO_CLIENT_ID = "test-yahoo";
    process.env.RAKUTEN_APP_ID = "test-rakuten";
    process.env.EBAY_CLIENT_ID = "test-ebay";
    process.env.EBAY_ACCESS_TOKEN = "test-ebay-token";

    const calls: string[] = [];
    globalThis.fetch = (async (input: string | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("shopping.yahooapis.jp")) {
        return jsonResponse({
          hits: [{
            name: "Camera body",
            price: 100000,
            url: "https://store.example/yahoo-camera",
            code: { jan: "4900000000001" },
          }],
        });
      }
      if (url.includes("app.rakuten.co.jp")) {
        return jsonResponse({
          Items: [{
            Item: {
              itemName: "Camera body",
              itemPrice: 100000,
              itemUrl: "https://store.example/rakuten-camera",
              jan: "4900000000001",
            },
          }],
        });
      }
      if (url.includes("/buy/browse/v1/item_summary/search")) {
        return jsonResponse({
          itemSummaries: [{
            title: "Camera body",
            price: { value: "100000", currency: "JPY" },
            itemWebUrl: "https://www.ebay.example/camera",
            itemId: "ebay-camera",
            gtin: "4900000000001",
            itemEndDate: new Date(Date.now() + 300_000).toISOString(),
          }],
        });
      }
      throw new Error(`Unexpected test URL: ${url}`);
    }) as typeof fetch;

    const products = await searchMarket("camera", "products", 10);
    assert.deepEqual(products.providers_queried, ["yahoo-shopping", "rakuten", "ebay"]);
    assert.equal(products.results.length, 1);
    assert.equal(products.results[0]?.status, "VERIFIED_STRONG");
    assert.equal(products.results[0]?.observations.length, 3);
    assert.deepEqual(
      products.results[0]?.observations.map((observation) => observation.source),
      ["yahoo-shopping", "rakuten", "ebay"],
    );

    const auctions = await searchMarket("camera", "auctions", 10);
    assert.deepEqual(auctions.providers_queried, ["ebay"]);
    assert.equal(auctions.results[0]?.observations[0]?.source, "ebay");
    assert.ok((auctions.results[0]?.observations[0]?.remaining_seconds || 0) > 0);
    assert.ok(calls.some((url) => url.includes("filter=buyingOptions%3A%7BAUCTION%7D")));
  } finally {
    globalThis.fetch = originalFetch;
    restoreProviderEnv(savedEnv);
  }
});

test("provider failures fall through the priority chain and recover without retries", { concurrency: false }, async () => {
  const savedEnv = saveProviderEnv();
  const originalFetch = globalThis.fetch;
  const failureCases = [
    { name: "timeout", status: 0, error: "timeout", errorType: "timeout" },
    { name: "401", status: 401, error: "http_401", errorType: "authentication" },
    { name: "403", status: 403, error: "http_403", errorType: "authentication" },
    { name: "429", status: 429, error: "http_429", errorType: "rate_limit" },
  ] as const;

  try {
    for (const failureCase of failureCases) {
      clearProviderEnv();
      process.env.YAHOO_CLIENT_ID = "test-yahoo";
      process.env.RAKUTEN_APP_ID = "test-rakuten";

      const calls: string[] = [];
      globalThis.fetch = (async (input: string | URL) => {
        const url = String(input);
        calls.push(url);
        if (url.includes("shopping.yahooapis.jp")) {
          if (failureCase.name === "timeout") {
            throw Object.assign(new Error("The operation timed out"), { name: "TimeoutError" });
          }
          return jsonResponse({}, failureCase.status);
        }
        if (url.includes("app.rakuten.co.jp")) {
          return jsonResponse({
            Items: [{
              Item: {
                itemName: "Fallback camera",
                itemPrice: 12345,
                itemUrl: "https://store.example/rakuten-fallback-camera",
                jan: "4900000000001",
              },
            }],
          });
        }
        throw new Error(`Unexpected test URL: ${url}`);
      }) as typeof fetch;

      const response = await searchMarket("camera", "products", 10);
      assert.deepEqual(response.providers_queried, ["yahoo-shopping", "rakuten"]);
      assert.equal(response.results.length, 1);
      assert.equal(response.results[0]?.observations[0]?.source, "rakuten");
      assert.equal(response.results[0]?.observations[0]?.value, 12345);
      assert.equal(calls.filter((url) => url.includes("shopping.yahooapis.jp")).length, 1);
      assert.equal(calls.filter((url) => url.includes("app.rakuten.co.jp")).length, 1);

      const failedHealth = (await sourceHealth()).find((provider) => provider.id === "yahoo-shopping");
      assert.equal(failedHealth?.last_error, failureCase.error);
      assert.equal(failedHealth?.last_error_type, failureCase.errorType);
      assert.ok((failedHealth?.consecutive_failures || 0) > 0);
    }

    globalThis.fetch = (async (input: string | URL) => {
      const url = String(input);
      if (url.includes("shopping.yahooapis.jp")) {
        return jsonResponse({
          hits: [{
            name: "Recovered camera",
            price: 54321,
            url: "https://store.example/yahoo-recovered-camera",
            code: { jan: "4900000000002" },
          }],
        });
      }
      if (url.includes("app.rakuten.co.jp")) {
        return jsonResponse({
          Items: [{
            Item: {
              itemName: "Fallback camera",
              itemPrice: 12345,
              itemUrl: "https://store.example/rakuten-fallback-camera",
              jan: "4900000000001",
            },
          }],
        });
      }
      throw new Error(`Unexpected test URL: ${url}`);
    }) as typeof fetch;

    await searchMarket("camera", "products", 10);
    const recoveredHealth = (await sourceHealth()).find((provider) => provider.id === "yahoo-shopping");
    assert.equal(recoveredHealth?.last_error, null);
    assert.equal(recoveredHealth?.last_error_type, null);
    assert.equal(recoveredHealth?.consecutive_failures, 0);
  } finally {
    globalThis.fetch = originalFetch;
    restoreProviderEnv(savedEnv);
  }
});

test("discovery providers never turn shopping snippets into price evidence", { concurrency: false }, async () => {
  const savedEnv = saveProviderEnv();
  const originalFetch = globalThis.fetch;
  try {
    clearProviderEnv();
    process.env.SERPAPI_KEY = "test-serpapi";
    process.env.BRIGHT_DATA_TOKEN = "test-brightdata";

    globalThis.fetch = (async (input: string | URL) => {
      const url = String(input);
      if (url.includes("serpapi.com")) {
        return jsonResponse({
          shopping_results: [{
            title: "Snippet camera",
            price: "¥50,000",
            link: "https://merchant.example/serp-camera",
            snippet: "A shopping search snippet",
          }],
        });
      }
      if (url.includes("api.brightdata.com/request")) {
        return jsonResponse({
          shopping_results: [{
            title: "Bright snippet camera",
            price: 50000,
            link: "https://merchant.example/bright-camera",
            snippet: "Another shopping snippet",
          }],
        });
      }
      throw new Error(`Unexpected test URL: ${url}`);
    }) as typeof fetch;

    const response = await searchMarket("camera", "products", 10);
    assert.deepEqual(response.providers_queried, ["serpapi", "brightdata"]);
    assert.deepEqual(response.results, []);
    assert.equal(response.discovery?.length, 2);
    assert.ok(response.discovery?.every((item) => item.kind === "DISCOVERY_ONLY"));
  } finally {
    globalThis.fetch = originalFetch;
    restoreProviderEnv(savedEnv);
  }
});

test("official sold adapter normalizes completed marketplace sales only", { concurrency: false }, async () => {
  const savedEnv = saveProviderEnv();
  const originalFetch = globalThis.fetch;
  try {
    clearProviderEnv();
    process.env.EBAY_CLIENT_ID = "test-ebay";
    process.env.EBAY_ACCESS_TOKEN = "test-ebay-token";
    assert.deepEqual(availableSoldProviderIds(), ["ebay"]);

    globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/buy/marketplace-insights/v1_beta/item_sales/search")) {
        assert.equal(new Headers(init?.headers).get("x-ebay-c-marketplace-id"), "EBAY_US");
        return jsonResponse({
          itemSales: [
            ebaySoldItemFixture(),
          ],
        });
      }
      throw new Error(`Unexpected test URL: ${url}`);
    }) as typeof fetch;

    const response = await searchSoldComps("camera", 10);
    assert.deepEqual(response.providers_queried, ["ebay"]);
    assert.equal(response.comps.length, 1);
    assert.deepEqual(response.comps[0], {
      title: "Sold camera",
      sold_price: 100,
      currency: "USD",
      sold_at: "2026-09-19T10:00:00.000Z",
      source: "ebay",
      normalized_price: 15000,
      condition: "good",
      url: "https://www.ebay.example/sold-camera",
      identity: {
        gtin: "4900000000001",
        condition: "USED",
        brand: "Example",
        accessories: [],
      },
    });
  } finally {
    globalThis.fetch = originalFetch;
    restoreProviderEnv(savedEnv);
  }
});

test("sold provider routing matches supported, unknown, and omitted markets", { concurrency: false }, () => {
  const savedEnv = saveProviderEnv();
  try {
    clearProviderEnv();
    process.env.EBAY_CLIENT_ID = "test-ebay";
    process.env.EBAY_ACCESS_TOKEN = "test-ebay-token";
    process.env.STOCKX_API_KEY = "test-stockx";
    process.env.STOCKX_ACCESS_TOKEN = "test-stockx-access-token";

    assert.deepEqual(availableSoldProviderIds(), ["ebay", "stockx"]);
    assert.deepEqual(availableSoldProviderIds("ebay_us"), ["ebay"]);
    assert.deepEqual(availableSoldProviderIds("unknown-market"), []);
  } finally {
    restoreProviderEnv(savedEnv);
  }
});

test("eBay sold adapter supports the legacy price field", { concurrency: false }, async () => {
  const savedEnv = saveProviderEnv();
  const originalFetch = globalThis.fetch;
  try {
    clearProviderEnv();
    process.env.EBAY_CLIENT_ID = "test-ebay";
    process.env.EBAY_ACCESS_TOKEN = "test-ebay-token";

    globalThis.fetch = (async (input: string | URL) => {
      const url = String(input);
      if (url.includes("/buy/marketplace-insights/v1_beta/item_sales/search")) {
        return jsonResponse({ itemSales: [ebayPriceFieldFixture()] });
      }
      throw new Error(`Unexpected test URL: ${url}`);
    }) as typeof fetch;

    const response = await searchSoldComps("camera", 10);
    assert.equal(response.comps.length, 1);
    assert.equal(response.comps[0]?.sold_price, 125);
    assert.equal(response.comps[0]?.normalized_price, 18750);
  } finally {
    globalThis.fetch = originalFetch;
    restoreProviderEnv(savedEnv);
  }
});

test("eBay sold adapter supports scalar sold prices and optional field aliases", { concurrency: false }, async () => {
  const savedEnv = saveProviderEnv();
  const originalFetch = globalThis.fetch;
  try {
    clearProviderEnv();
    process.env.EBAY_CLIENT_ID = "test-ebay";
    process.env.EBAY_ACCESS_TOKEN = "test-ebay-token";

    globalThis.fetch = (async (input: string | URL) => {
      const url = String(input);
      if (url.includes("/buy/marketplace-insights/v1_beta/item_sales/search")) {
        return jsonResponse({ itemSales: [ebayScalarSoldPriceFixture()] });
      }
      throw new Error(`Unexpected test URL: ${url}`);
    }) as typeof fetch;

    const response = await searchSoldComps("camera", 10);
    assert.deepEqual(response.comps[0], {
      title: "Sold camera with scalar sold price",
      sold_price: 150,
      currency: "USD",
      sold_at: "2026-09-17T10:00:00.000Z",
      source: "ebay",
      normalized_price: 22500,
      condition: "new",
      url: "https://www.ebay.example/sold-camera-scalar",
      identity: {
        gtin: "4900000000001",
        condition: "NEW",
        brand: "Example",
        accessories: [],
      },
    });
  } finally {
    globalThis.fetch = originalFetch;
    restoreProviderEnv(savedEnv);
  }
});

test("eBay sold adapter rejects records missing required sale evidence", { concurrency: false }, async () => {
  const savedEnv = saveProviderEnv();
  const originalFetch = globalThis.fetch;
  try {
    clearProviderEnv();
    process.env.EBAY_CLIENT_ID = "test-ebay";
    process.env.EBAY_ACCESS_TOKEN = "test-ebay-token";

    let payload: unknown = { itemSales: [ebaySoldItemFixture()] };
    globalThis.fetch = (async (input: string | URL) => {
      const url = String(input);
      if (url.includes("/buy/marketplace-insights/v1_beta/item_sales/search")) return jsonResponse(payload);
      throw new Error(`Unexpected test URL: ${url}`);
    }) as typeof fetch;

    const missingEvidenceCases = [
      ["sold timestamp", { lastSoldDate: undefined }],
      ["price", { price: undefined, soldPrice: undefined, salePrice: undefined }],
      ["provider identity", { itemId: undefined, legacyItemId: undefined, epid: undefined, gtin: undefined, brand: undefined }],
      ["canonical URL", { itemWebUrl: undefined, itemUrl: undefined, url: undefined, link: undefined }],
      ["condition", { condition: undefined, conditionDisplayName: undefined, itemCondition: undefined }],
    ] as const;

    for (const [field, overrides] of missingEvidenceCases) {
      payload = { itemSales: [ebaySoldItemFixture(overrides)] };
      const response = await searchSoldComps("camera", 10);
      assert.deepEqual(response.comps, [], `a record missing its ${field} must not become a sold comp`);
    }
  } finally {
    globalThis.fetch = originalFetch;
    restoreProviderEnv(savedEnv);
  }
});

test("StockX sold adapter uses catalog identity and completed order data only", { concurrency: false }, async () => {
  const savedEnv = saveProviderEnv();
  const originalFetch = globalThis.fetch;
  try {
    clearProviderEnv();
    process.env.STOCKX_API_KEY = "test-stockx";
    process.env.STOCKX_REFRESH_TOKEN = "test-stockx-refresh";
    process.env.STOCKX_CLIENT_ID = "test-stockx-client";
    process.env.STOCKX_CLIENT_SECRET = "test-stockx-secret";
    assert.deepEqual(availableSoldProviderIds(), ["stockx"]);

    const calls: Array<{ url: string; headers: Headers }> = [];
    globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, headers: new Headers(init?.headers) });
      if (url.includes("accounts.stockx.com/oauth/token")) {
        assert.equal(init?.method, "POST");
        assert.equal(new Headers(init?.headers).get("content-type"), "application/x-www-form-urlencoded");
        const body = new URLSearchParams(String(init?.body));
        assert.equal(body.get("grant_type"), "refresh_token");
        assert.equal(body.get("client_id"), "test-stockx-client");
        assert.equal(body.get("client_secret"), "test-stockx-secret");
        assert.equal(body.get("audience"), "gateway.stockx.com");
        assert.equal(body.get("refresh_token"), "test-stockx-refresh");
        return jsonResponse({
          access_token: "test-stockx-access-token",
          expires_in: 43200,
          token_type: "Bearer",
        });
      }
      if (url.includes("/v2/catalog/search")) {
        assert.equal(new Headers(init?.headers).get("x-api-key"), "test-stockx");
        assert.equal(new Headers(init?.headers).get("authorization"), "Bearer test-stockx-access-token");
        return jsonResponse({
          products: [{
            productId: "stockx-camera",
            urlKey: "example-camera",
            title: "Example Camera",
            brand: "Example",
            styleId: "CAM-001",
            productAttributes: { colorway: "Black" },
          }],
        });
      }
      if (url.includes("/v2/selling/orders/history")) {
        assert.equal(new Headers(init?.headers).get("x-api-key"), "test-stockx");
        assert.equal(new Headers(init?.headers).get("authorization"), "Bearer test-stockx-access-token");
        assert.equal(new URL(url).searchParams.get("orderStatus"), "COMPLETED");
        assert.equal(new URL(url).searchParams.get("productId"), "stockx-camera");
        return jsonResponse({
          orders: [
            {
              orderNumber: "order-1",
              status: "COMPLETED",
              createdAt: "2026-09-20T10:00:00.000Z",
              updatedAt: "2026-09-21T10:00:00.000Z",
              condition: "New",
              currencyCode: "USD",
              payout: { salePrice: "100", currencyCode: "USD" },
              product: { productId: "stockx-camera", productName: "Example Camera", styleId: "CAM-001" },
              variant: { variantId: "variant-1", variantName: "One Size", variantValue: "One Size" },
            },
            {
              orderNumber: "order-2",
              status: "CANCELED",
              createdAt: "2026-09-21T10:00:00.000Z",
              payout: { salePrice: "900", currencyCode: "USD" },
              currencyCode: "USD",
              product: { productId: "stockx-camera", productName: "Example Camera" },
            },
            {
              orderNumber: "order-3",
              status: "COMPLETED",
              payout: { salePrice: "900", currencyCode: "USD" },
              currencyCode: "USD",
              product: { productId: "stockx-camera", productName: "Example Camera" },
            },
            {
              createdAt: "2026-09-22T10:00:00.000Z",
              condition: "New",
              payout: { salePrice: "800", currencyCode: "USD" },
              product: { productId: "stockx-camera", productName: "Example Camera" },
            },
          ],
        });
      }
      throw new Error(`Unexpected test URL: ${url}`);
    }) as typeof fetch;

    const response = await searchSoldComps("camera", 10);
    assert.deepEqual(response.providers_queried, ["stockx"]);
    assert.equal(response.comps.length, 1);
    assert.deepEqual(response.comps[0], {
      title: "Example Camera",
      sold_price: 100,
      currency: "USD",
      sold_at: "2026-09-20T10:00:00.000Z",
      source: "stockx",
      normalized_price: 15000,
      condition: "new",
      url: "https://stockx.com/example-camera",
      identity: {
        brand: "Example",
        mpn: "CAM-001",
        model: "Example Camera",
        color: "Black",
        condition: "New",
        version: "One Size",
        accessories: [],
      },
    });
    assert.ok(calls.some(({ url }) => url.includes("/v2/catalog/search")));
    const health = (await sourceHealth()).find((provider) => provider.id === "stockx");
    assert.equal(health?.configured, true);
    assert.equal(health?.available, true);
    assert.equal(health?.sold_comps_capable, true);
  } finally {
    globalThis.fetch = originalFetch;
    restoreProviderEnv(savedEnv);
  }
});

test("StockX sold adapter requires explicit completed status and structured sale evidence", { concurrency: false }, async () => {
  const savedEnv = saveProviderEnv();
  const originalFetch = globalThis.fetch;
  try {
    clearProviderEnv();
    process.env.STOCKX_API_KEY = "test-stockx";
    process.env.STOCKX_ACCESS_TOKEN = "test-stockx-access-token";

    globalThis.fetch = (async (input: string | URL) => {
      const url = String(input);
      if (url.includes("/v2/catalog/search")) {
        return jsonResponse({
          products: [{
            productId: "stockx-camera",
            urlKey: "example-camera",
            title: "Example Camera",
            brand: "Example",
            styleId: "CAM-001",
          }],
        });
      }
      if (url.includes("/v2/selling/orders/history")) {
        return jsonResponse({
          orders: [
            {
              completedAt: "2026-09-20T10:00:00.000Z",
              condition: "New",
              payout: { salePrice: "100", currencyCode: "USD" },
              product: { productId: "stockx-camera", productName: "Example Camera" },
            },
            {
              orderStatus: "COMPLETED",
              completedAt: "2026-09-20T10:00:00.000Z",
              payout: { salePrice: "100", currencyCode: "USD" },
              product: { productId: "stockx-camera", productName: "Example Camera" },
            },
          ],
        });
      }
      throw new Error(`Unexpected test URL: ${url}`);
    }) as typeof fetch;

    const response = await searchSoldComps("camera", 10);
    assert.deepEqual(response.providers_queried, ["stockx"]);
    assert.deepEqual(response.comps, []);
  } finally {
    globalThis.fetch = originalFetch;
    restoreProviderEnv(savedEnv);
  }
});

test("sold adapter rejects unsupported eBay marketplace configuration before requesting sales", { concurrency: false }, async () => {
  const savedEnv = saveProviderEnv();
  const originalFetch = globalThis.fetch;
  try {
    clearProviderEnv();
    process.env.EBAY_CLIENT_ID = "test-ebay";
    process.env.EBAY_ACCESS_TOKEN = "test-ebay-token";
    process.env.EBAY_MARKETPLACE_ID = "EBAY_JP";
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      throw new Error("unsupported marketplace should not call eBay");
    }) as typeof fetch;

    const response = await searchSoldComps("camera", 10);
    assert.deepEqual(response, { comps: [], providers_queried: ["ebay"] });
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    restoreProviderEnv(savedEnv);
  }
});

test("discovery providers are never queried for sold-price evidence", { concurrency: false }, async () => {
  const savedEnv = saveProviderEnv();
  const originalFetch = globalThis.fetch;
  try {
    clearProviderEnv();
    process.env.SERPAPI_KEY = "test-serpapi";
    globalThis.fetch = (async () => {
      throw new Error("discovery provider should not be queried");
    }) as typeof fetch;

    assert.deepEqual(availableSoldProviderIds(), []);
    const response = await searchSoldComps("camera", 10);
    assert.deepEqual(response, { comps: [], providers_queried: [] });
  } finally {
    globalThis.fetch = originalFetch;
    restoreProviderEnv(savedEnv);
  }
});

test("optional adapters activate only when their secrets are present", { concurrency: false }, async () => {
  const savedEnv = saveProviderEnv();
  const originalFetch = globalThis.fetch;
  try {
    clearProviderEnv();
    assert.deepEqual(availableProviderIds("products"), []);
    process.env.STOCKX_API_KEY = "test-stockx";
    assert.deepEqual(availableSoldProviderIds(), []);
    const stockxHealth = (await sourceHealth()).find((provider) => provider.id === "stockx");
    assert.equal(stockxHealth?.configured, false);
    assert.equal(stockxHealth?.available, false);
    assert.equal(stockxHealth?.sold_comps_capable, false);

    process.env.KEEPA_API_KEY = "test-keepa";
    process.env.APIFY_TOKEN = "test-apify";
    globalThis.fetch = (async (input: string | URL) => {
      const url = String(input);
      if (url.includes("api.keepa.com/search")) {
        return jsonResponse({
          products: [{
            asin: "B000TEST01",
            title: "Keepa camera",
            stats: { current: [-1, 12345] },
          }],
        });
      }
      if (url.includes("api.apify.com")) {
        if (url.includes("test~structured")) {
          return jsonResponse([{
            providerOwnedItemId: "structured-camera",
            providerOwnedTitle: "Structured Apify camera",
            providerOwnedPrice: 88000,
            providerOwnedCurrency: "JPY",
            providerOwnedUrl: "https://merchant.example/structured-camera",
          }]);
        }
        return jsonResponse([{
          id: "apify-camera",
          title: "Apify camera",
          price: "¥99,000",
          url: "https://merchant.example/apify-camera",
        }]);
      }
      throw new Error(`Unexpected test URL: ${url}`);
    }) as typeof fetch;

    assert.deepEqual(availableProviderIds("products"), ["keepa", "apify"]);
    const response = await searchMarket("camera", "products", 10);
    assert.deepEqual(response.providers_queried, ["keepa", "apify"]);
    assert.deepEqual(
      response.results.flatMap((result) => result.observations.map((observation) => observation.source)),
      ["keepa"],
    );
    assert.equal(response.discovery?.length, 1);
    assert.equal(response.discovery?.[0]?.source, "apify");
    assert.equal(response.discovery?.[0]?.kind, "DISCOVERY_ONLY");

    delete process.env.KEEPA_API_KEY;
    process.env.APIFY_ACTOR_ID = "test~structured";
    process.env.APIFY_STRUCTURED_ACTOR_ID = "test~structured";
    const structuredResponse = await searchMarket("camera", "products", 10);
    assert.deepEqual(structuredResponse.providers_queried, ["apify"]);
    assert.equal(structuredResponse.results[0]?.observations[0]?.source, "apify");
    assert.equal(structuredResponse.results[0]?.observations[0]?.value, 88000);
  } finally {
    globalThis.fetch = originalFetch;
    restoreProviderEnv(savedEnv);
  }
});