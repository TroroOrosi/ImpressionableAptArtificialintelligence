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
            {
              title: "Sold camera",
              price: { value: "100", currency: "USD" },
              lastSoldDate: "2026-09-19T10:00:00.000Z",
              condition: "USED",
              itemWebUrl: "https://www.ebay.example/sold-camera",
              itemId: "sold-camera",
              gtin: "4900000000001",
              brand: "Example",
            },
            {
              title: "Not a completed sale",
              price: { value: "200", currency: "USD" },
              itemWebUrl: "https://www.ebay.example/missing-date",
              itemId: "missing-date",
            },
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