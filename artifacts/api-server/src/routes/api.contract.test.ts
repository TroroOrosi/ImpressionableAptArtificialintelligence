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