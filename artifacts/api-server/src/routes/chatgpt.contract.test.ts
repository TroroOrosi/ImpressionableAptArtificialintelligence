import test from "node:test";
import assert from "node:assert/strict";
import app from "../app";

async function withServer(run: (base: string) => Promise<void>) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test port");
  try { await run(`http://127.0.0.1:${address.port}`); }
  finally { await new Promise<void>(resolve => server.close(() => resolve())); }
}
type ErrorReply = { error: { code: number } };
type ToolReply<T> = { result: { structuredContent: T; content: Array<{ type: string; text: string }> } };
type SetupReply = {
  connection: { mcp_url: string; chatgpt_registration: string };
  schedule_migration: { auto_create: boolean };
  full_schedule_pack: unknown[];
  core_6_pack: unknown[];
};
const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
const body = (method: string, params?: unknown) => JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });

test("Express acknowledges MCP notifications without a body and uses no-store", () => withServer(async base => {
  const r = await fetch(`${base}/api/mcp`, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });
  assert.equal(r.status, 202); assert.equal(await r.text(), "");
  assert.equal(r.headers.get("cache-control"), "no-store");
  assert.equal((await fetch(`${base}/api/mcp`)).status, 405);
}));
test("malformed JSON returns a JSON-RPC parse error, not HTML", () => withServer(async base => {
  const r = await fetch(`${base}/api/mcp`, { method: "POST", headers, body: "{broken" });
  assert.equal(r.status, 400);
  assert.equal((await r.json() as ErrorReply).error.code, -32700);
}));
test("MCP rejects unknown tools and missing search arguments before providers", () => withServer(async base => {
  for (const params of [{ name: "invented" }, { name: "search_products", arguments: {} }]) {
    const r = await fetch(`${base}/api/mcp`, { method: "POST", headers, body: body("tools/call", params) });
    assert.equal((await r.json() as ErrorReply).error.code, -32602);
  }
}));
test("MCP keeps array payloads in text and object structuredContent", () => withServer(async base => {
  const r = await fetch(`${base}/api/mcp`, { method: "POST", headers, body: body("tools/call", { name: "get_source_health" }) });
  const result = (await r.json() as ToolReply<{ items: unknown[] }>).result;
  assert.ok(Array.isArray(result.structuredContent.items));
  assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent.items);
}));
test("public aliases and MCP setup use canonical origin and preserve schedule migration policy", { concurrency: false }, () => withServer(async base => {
  const saved = process.env.PUBLIC_BASE_URL;
  try {
    process.env.PUBLIC_BASE_URL = "https://canonical.example";
    const r = await fetch(`${base}/api/v1/public/setup-bundle`, { headers: { "x-forwarded-host": "untrusted.example" } });
    assert.equal(r.headers.get("cache-control"), "no-store");
    const setup = await r.json() as SetupReply;
    assert.equal(setup.connection.mcp_url, "https://canonical.example/api/mcp");
    assert.equal(setup.schedule_migration.auto_create, false);
    assert.equal(setup.full_schedule_pack.length, 14);
    assert.equal(setup.core_6_pack.length, 6);
    assert.equal((await fetch(`${base}/api/v1/public/source-coverage`)).status, 200);
    const tool = await fetch(`${base}/api/mcp`, { method: "POST", headers, body: body("tools/call", { name: "get_setup_bundle" }) });
    assert.equal((await tool.json() as ToolReply<SetupReply>).result.structuredContent.connection.chatgpt_registration, "NOT_VERIFIED");
  } finally { if (saved === undefined) delete process.env.PUBLIC_BASE_URL; else process.env.PUBLIC_BASE_URL = saved; }
}));
