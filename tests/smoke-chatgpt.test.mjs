import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { smokeChatgpt } from '../scripts/smoke-chatgpt.mjs';
import { handleMcpHttp } from '../artifacts/api-server/src/market/mcp.ts';

test('smoke rejects remote cleartext or endpoint paths before networking', async () => {
  for (const url of ['http://remote.example', 'https://remote.example/api/mcp', 'https://user:pass@remote.example']) {
    await assert.rejects(smokeChatgpt(url, () => { throw new Error('must not fetch'); }));
  }
});
test('smoke never reports success from only a healthy health endpoint', async () => {
  await assert.rejects(smokeChatgpt('https://intel.example', async url => new Response(JSON.stringify(url.endsWith('/healthz') ? { status: 'ok' } : { error: 'not_mcp' }), { status: 200 })));
});
test('smoke exercises real local HTTP while explicitly not claiming provider or ChatGPT validation', async () => {
  // Stub business handlers isolate the connection checker; this is not a production-provider test.
  let base;
  const coverage = { measured_coverage_percent: 0 };
  const bundle = () => ({ connection: { mcp_url: `${base}/api/mcp` }, schedule_migration: { mode: 'preserve_existing' } });
  const server = createServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk;
    if (req.url === '/api/mcp') {
      const r = await handleMcpHttp({ method: req.method, headers: req.headers, body: text ? JSON.parse(text) : undefined }, {
        get_source_health: () => [{ configured: false }], get_source_coverage: () => coverage,
        get_setup_bundle: bundle, verify_current_price: () => ({ status: 'UNVERIFIED', actionable: false }),
      });
      res.writeHead(r.status, r.headers); res.end(r.body ? JSON.stringify(r.body) : undefined);
    } else {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(req.url.endsWith('healthz') ? { status: 'ok' } : req.url.endsWith('setup-bundle') ? bundle() : coverage));
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  try {
    const result = await smokeChatgpt(base);
    assert.equal(result.http_mcp_smoke, 'PASSED');
    assert.equal(result.configured_providers, 0);
    assert.equal(result.live_price_provider_calls, 'NOT_TESTED');
    assert.equal(result.chatgpt_native_registration, 'NOT_VERIFIED');
    assert.equal(result.scheduled_run, 'NOT_VERIFIED');
  } finally { await new Promise(resolve => server.close(resolve)); }
});
