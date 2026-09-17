'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const org = require('../lib/org');

const PROVIDER_BRAND_RE = /vobiz|dograh|deepgram|rumik|groq/i;

test('publicHealthPayload has no provider brand strings', () => {
  const body = org.publicHealthPayload();
  assert.equal(body.ok, true);
  assert.equal(body.providers, undefined);
  assert.equal(body.models, undefined);
  assert.equal(body.selected, undefined);
  const blob = JSON.stringify(body);
  assert.equal(PROVIDER_BRAND_RE.test(blob), false);
});

test('detailedHealthPayload keeps provider inventory for super_admin path', () => {
  const described = {
    stt: [{ id: 'deepgram', live: true, selected: true, model: 'nova-3' }],
    tts: [{ id: 'rumik', live: true, selected: true, model: 'mulberry' }],
    llm: [{ id: 'groq', live: true, selected: true, model: 'llama' }],
    telephony: [{ id: 'vobiz', live: true, selected: true }],
  };
  const body = org.detailedHealthPayload(described);
  assert.equal(body.ok, true);
  assert.equal(body.providers.tts.rumik, true);
  assert.equal(body.selected.telephony.provider, 'vobiz');
  assert.equal(body.models.stt, 'nova-3');
  const check = org.assertNoSecretValues(body, { RUMIK_API_KEY: 'secret-rumik-key-zzzz' });
  assert.equal(check.ok, true);
});

test('unauthenticated health serializer shape never advertises brands', () => {
  // Mirrors apiHealth for anonymous / non-super_admin callers.
  const payload = org.publicHealthPayload();
  const text = JSON.stringify(payload);
  assert.match(text, /"ok":true/);
  assert.doesNotMatch(text, PROVIDER_BRAND_RE);
});

test('unauthenticated GET /api/providers is auth-gated (401)', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'astra-prov-auth-'));
  const dbFile = path.join(tmpDir, 'db.json');
  process.env.RAPIDX_DB_FILE = dbFile;

  for (const key of Object.keys(require.cache)) {
    if (key.includes('/dashboard/lib/')) delete require.cache[key];
  }
  const core = require('../lib/core');
  const providers = require('../lib/providers');

  async function handle(req, res) {
    const route = (req.url || '').split('?')[0];
    if (req.method === 'GET' && route === '/api/providers') {
      return core.requireAuth(req, res, (rq, rs) => {
        core.sendJson(rs, 200, providers.describeProviders());
      });
    }
    core.sendJson(res, 404, { error: 'missing' });
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => core.sendJson(res, 500, { error: e.message }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  t.after(() => {
    server.close();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
    delete process.env.RAPIDX_DB_FILE;
  });

  const res = await new Promise((resolve, reject) => {
    http.get({ hostname: '127.0.0.1', port, path: '/api/providers' }, (r) => {
      const chunks = [];
      r.on('data', (c) => chunks.push(c));
      r.on('end', () => resolve({
        status: r.statusCode,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    }).on('error', reject);
  });

  assert.equal(res.status, 401);
  assert.equal(PROVIDER_BRAND_RE.test(res.body), false);
});
