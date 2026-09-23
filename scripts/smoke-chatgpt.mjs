import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

export async function smokeChatgpt(rawBase, fetcher = fetch) {
  const target = new URL(rawBase);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(target.hostname);
  assert.ok(target.protocol === 'https:' || (target.protocol === 'http:' && local), 'HTTPS is required outside loopback');
  assert.ok(!target.username && !target.password && target.pathname === '/' && !target.search && !target.hash, 'Supply the service origin, not an endpoint URL');
  const base = target.origin;
  let id = 0;
  let protocol;
  const request = (path, init = {}) => fetcher(`${base}${path}`, { ...init, redirect: 'error', signal: AbortSignal.timeout(20000) });
  const post = body => request('/api/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(protocol ? { 'MCP-Protocol-Version': protocol } : {}) },
    body: JSON.stringify(body),
  });
  const rpc = async (method, params) => {
    const callId = ++id;
    const response = await post({ jsonrpc: '2.0', id: callId, method, ...(params ? { params } : {}) });
    assert.equal(response.status, 200, `MCP ${method}: HTTP ${response.status}`);
    const body = await response.json();
    assert.equal(body.id, callId, 'Mismatched JSON-RPC id');
    assert.ok(!body.error && body.result && !body.result.isError, `${method} returned an error`);
    return body.result;
  };
  const getJson = async path => {
    const response = await request(path);
    assert.equal(response.status, 200, `GET ${path}: HTTP ${response.status}`);
    return response.json();
  };
  assert.equal((await getJson('/api/healthz')).status, 'ok');
  const initialized = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'market-intel-smoke', version: '1.0.0' } });
  assert.ok(initialized.capabilities.tools);
  protocol = initialized.protocolVersion;
  const notification = await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.equal(notification.status, 202);
  assert.equal(await notification.text(), '');
  await rpc('ping');
  const tools = (await rpc('tools/list')).tools;
  for (const name of ['search_products', 'search_auctions', 'fetch_listing', 'get_price_history', 'get_sold_comps', 'compare_offers', 'verify_current_price', 'get_source_health', 'get_source_coverage', 'get_setup_bundle']) {
    const tool = tools.find(t => t.name === name);
    assert.ok(tool, `Missing ${name}`);
    assert.equal(tool.annotations?.readOnlyHint, true);
  }
  const call = async (name, args = {}) => {
    const result = await rpc('tools/call', { name, arguments: args });
    assert.ok(result.structuredContent && !Array.isArray(result.structuredContent));
    return JSON.parse(result.content.find(c => c.type === 'text').text);
  };
  const health = await call('get_source_health');
  assert.ok(Array.isArray(health));
  const coverage = await call('get_source_coverage');
  assert.equal(typeof coverage.measured_coverage_percent, 'number');
  const bundle = await call('get_setup_bundle');
  assert.equal(bundle.connection.mcp_url, `${base}/api/mcp`);
  assert.equal(bundle.schedule_migration.mode, 'preserve_existing');
  const unsupported = await call('verify_current_price', { url: 'https://unknown.example/connection-smoke' });
  assert.equal(unsupported.status, 'UNVERIFIED');
  assert.equal(unsupported.actionable, false);
  assert.equal((await getJson('/api/v1/public/setup-bundle')).connection.mcp_url, `${base}/api/mcp`);
  assert.equal(typeof (await getJson('/api/v1/public/source-coverage')).measured_coverage_percent, 'number');
  const noStream = await request('/api/mcp');
  assert.equal(noStream.status, 405);
  return {
    checked_at: new Date().toISOString(), base_url: base, http_mcp_smoke: 'PASSED',
    tool_count: tools.length, protocol, configured_providers: health.filter(p => p.configured).length,
    registry_coverage_percent: coverage.measured_coverage_percent,
    live_price_provider_calls: 'NOT_TESTED', durable_storage: 'NOT_VERIFIED',
    chatgpt_native_registration: 'NOT_VERIFIED', scheduled_run: 'NOT_VERIFIED',
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.argv[2]) { console.error('Usage: node scripts/smoke-chatgpt.mjs https://SERVICE_ORIGIN'); process.exitCode = 2; }
  else {
    try { console.log(JSON.stringify(await smokeChatgpt(process.argv[2]), null, 2)); }
    catch (error) { console.error(`Connection smoke failed: ${error instanceof Error ? error.message : 'unknown error'}`); process.exitCode = 1; }
  }
}
