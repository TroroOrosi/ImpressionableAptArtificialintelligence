import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { handleMcpHttp, TOOL_DEFINITIONS, publicBaseUrl, createCallLimiter } from '../artifacts/api-server/src/market/mcp.ts';

const rpc = (method, params, id = 1) => ({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
const handlers = Object.fromEntries(TOOL_DEFINITIONS.map(t => [t.name, async () => ({ status: 'UNVERIFIED', actionable: false })]));
const run = (body, options = {}, tools = handlers) => handleMcpHttp({ method: 'POST', body, headers: {}, ...options }, tools);

test('initialize negotiates a supported version and declares tools, without a UI or session', async () => {
  const r = await run(rpc('initialize', { protocolVersion: '2099-01-01', capabilities: {}, clientInfo: { name: 'test', version: '1' } }, 0));
  assert.equal(r.status, 200);
  assert.equal(r.body.id, 0);
  assert.equal(r.body.result.protocolVersion, '2025-06-18');
  assert.deepEqual(r.body.result.capabilities, { tools: {} });
  assert.equal(r.headers['Cache-Control'], 'no-store');
  assert.equal(r.headers['Mcp-Session-Id'], undefined);
});
test('older supported protocol is negotiated, unsupported HTTP protocol is rejected', async () => {
  assert.equal((await run(rpc('initialize', { protocolVersion: '2025-03-26' }))).body.result.protocolVersion, '2025-03-26');
  assert.equal((await run(rpc('ping'), { headers: { 'mcp-protocol-version': '2099-01-01' } })).status, 400);
});
test('initialization and cancellation notifications get 202 and no JSON body', async () => {
  for (const method of ['notifications/initialized', 'notifications/cancelled', 'notifications/unknown']) {
    const r = await run({ jsonrpc: '2.0', method });
    assert.equal(r.status, 202);
    assert.equal(r.body, undefined);
  }
});
test('notifications never invoke a tool', async () => {
  let called = false;
  const r = await run({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'get_source_health' } }, {}, { get_source_health: () => { called = true; } });
  assert.equal(r.status, 202);
  assert.equal(called, false);
});
test('ping and unsupported GET/DELETE implement Streamable HTTP', async () => {
  assert.deepEqual((await run(rpc('ping'))).body.result, {});
  for (const method of ['GET', 'DELETE', 'PUT']) {
    const r = await run(undefined, { method });
    assert.equal(r.status, 405);
    assert.equal(r.headers.Allow, 'POST');
  }
});
test('descriptors have explicit parameters, required keys and honest read-only annotations', async () => {
  const tools = (await run(rpc('tools/list'))).body.result.tools;
  const byName = Object.fromEntries(tools.map(t => [t.name, t]));
  assert.deepEqual(byName.search_products.inputSchema.required, ['q']);
  assert.equal(byName.search_products.inputSchema.properties.limit.maximum, 50);
  assert.deepEqual(byName.fetch_listing.inputSchema.required, ['url']);
  assert.ok(byName.get_price_history.inputSchema.properties.identity);
  assert.ok(byName.get_sold_comps.inputSchema.properties.market);
  assert.ok(byName.get_setup_bundle);
  for (const t of tools) {
    assert.equal(t.annotations.readOnlyHint, true);
    assert.equal(t.annotations.destructiveHint, false);
    assert.equal(t.inputSchema.additionalProperties, false);
  }
});
test('invalid JSON-RPC and invalid argument shapes do not execute a provider', async () => {
  for (const body of [null, [], {}, { jsonrpc: '1.0', id: 1, method: 'ping' }, rpc('ping', undefined, null)]) {
    assert.equal((await run(body)).body.error.code, -32600);
  }
  for (const args of [{}, { q: 'a' }, { q: 'camera', limit: 0 }, { q: 'camera', limit: 51 }, { q: 'camera', limit: '5' }, { q: 'camera', extra: 1 }]) {
    assert.equal((await run(rpc('tools/call', { name: 'search_products', arguments: args }))).body.error.code, -32602);
  }
  assert.equal((await run(rpc('tools/call', { name: 'get_source_health', arguments: [] }))).body.error.code, -32602);
  assert.equal((await run(rpc('tools/call', { name: 'fetch_listing', arguments: { url: 'file:///etc/passwd' } }))).body.error.code, -32602);
});
test('unknown methods and tools fail explicitly instead of fabricated empty success', async () => {
  assert.equal((await run(rpc('unknown'))).body.error.code, -32601);
  assert.equal((await run(rpc('tools/call', { name: 'invented', arguments: {} }))).body.error.code, -32602);
});
test('tool result preserves evidence, object structuredContent and false actionable', async () => {
  const r = await run(rpc('tools/call', { name: 'verify_current_price', arguments: { url: 'https://example.com/a' } }));
  assert.equal(r.body.result.structuredContent.actionable, false);
  assert.equal(JSON.parse(r.body.result.content[0].text).status, 'UNVERIFIED');
});
test('array results remain compatible in text, but structuredContent is an object', async () => {
  const r = await run(rpc('tools/call', { name: 'get_source_health' }), {}, { get_source_health: () => [{ available: false }] });
  assert.deepEqual(r.body.result.structuredContent, { items: [{ available: false }] });
  assert.deepEqual(JSON.parse(r.body.result.content[0].text), [{ available: false }]);
});
test('tool execution failures use isError, without leaking provider credentials', async () => {
  const r = await run(rpc('tools/call', { name: 'get_source_health' }), {}, { get_source_health: () => { throw new Error('token=do-not-leak'); } });
  assert.equal(r.body.result.isError, true);
  assert.doesNotMatch(JSON.stringify(r), /do-not-leak/);
});
test('Origin validation rejects hostile browser origins but permits nonbrowser clients', async () => {
  assert.equal((await run(rpc('ping'), { headers: { origin: 'https://evil.example' } })).status, 403);
  assert.equal((await run(rpc('ping'), { headers: { origin: 'null' } })).status, 403);
  assert.equal((await run(rpc('ping'), { headers: { origin: 'https://chatgpt.com' } })).status, 200);
  assert.equal((await run(rpc('ping'), { headers: { origin: 'https://chatgpt.com.evil.example' } })).status, 403);
  assert.equal((await run(rpc('ping'), { headers: { origin: 'https://intel.example' }, allowedOrigins: ['https://intel.example'] })).status, 200);
  assert.equal((await run(rpc('ping'))).status, 200);
});
test('configured public URL wins over forwarded headers and rejects credentials/paths', () => {
  assert.equal(publicBaseUrl('https://stable.example/', { host: 'evil.example' }, 'http'), 'https://stable.example');
  assert.equal(publicBaseUrl(undefined, { 'x-forwarded-host': 'intel.example.com', 'x-forwarded-proto': 'https' }, 'http'), 'https://intel.example.com');
  for (const url of ['https://user:pass@intel.example', 'https://intel.example/mcp', 'https://intel.example?a=1', 'javascript:alert(1)', 'http://intel.example']) assert.throws(() => publicBaseUrl(url, {}, 'http'));
});
test('bounded per-process limiter refills and never evicts active buckets to bypass limits', () => {
  let now = 100000;
  const limit = createCallLimiter({ minuteLimit: 2, dayLimit: 3, maxKeys: 2, now: () => now });
  assert.equal(limit('a'), true); assert.equal(limit('a'), true); assert.equal(limit('a'), false);
  assert.equal(limit('b'), true); assert.equal(limit('c'), false);
  now += 60000;
  assert.equal(limit('a'), true); assert.equal(limit('a'), false);
  now += 86400000;
  assert.equal(limit('c'), true);
});
test('actual HTTP initialize -> initialized -> list -> call roundtrip', async () => {
  const server = createServer(async (req, res) => {
    let data = ''; for await (const chunk of req) data += chunk;
    const r = await handleMcpHttp({ method: req.method, headers: req.headers, body: data ? JSON.parse(data) : undefined }, handlers);
    res.writeHead(r.status, { 'content-type': 'application/json', ...r.headers });
    res.end(r.body === undefined ? undefined : JSON.stringify(r.body));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/mcp`;
  const send = body => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify(body) });
  try {
    assert.equal((await (await send(rpc('initialize', { protocolVersion: '2025-06-18' }))).json()).result.protocolVersion, '2025-06-18');
    const initialized = await send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    assert.equal(initialized.status, 202); assert.equal(await initialized.text(), '');
    assert.equal((await (await send(rpc('tools/list'))).json()).result.tools.length, 10);
    assert.equal((await (await send(rpc('tools/call', { name: 'get_source_coverage' }))).json()).result.structuredContent.actionable, false);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
