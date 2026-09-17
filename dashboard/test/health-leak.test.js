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
  const body = org.publicHealthPayload({
    uptime: 12.7,
    version: '1.0.0',
    gitSha: 'abc123def',
    deployedAt: '2026-09-17T09:00:00Z',
  });
  assert.equal(body.ok, true);
  assert.equal(body.uptime, 12);
  assert.equal(body.version, '1.0.0');
  assert.equal(body.gitSha, 'abc123def');
  assert.equal(body.deployedAt, '2026-09-17T09:00:00Z');
  assert.equal(body.providers, undefined);
  assert.equal(body.models, undefined);
  assert.equal(body.selected, undefined);
  const blob = JSON.stringify(body);
  assert.equal(PROVIDER_BRAND_RE.test(blob), false);
});

test('deployIdentity never invents a SHA', () => {
  assert.deepEqual(org.deployIdentity({}), { gitSha: null, deployedAt: null, ref: null });
  assert.equal(org.deployIdentity({ GIT_SHA: ' deadbeef ' }).gitSha, 'deadbeef');
  assert.equal(org.deployIdentity({}, { versionFileText: 'cafe0123\n' }).gitSha, 'cafe0123');
  assert.equal(org.deployIdentity({ DEPLOYED_AT: '2026-09-17T01:02:03Z' }).deployedAt, '2026-09-17T01:02:03Z');
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

test('publicTelephonyStatus strips provider and orchestrator branding', () => {
  const body = org.publicTelephonyStatus({
    connected: true,
    provider: 'vobiz',
    orchestrator: 'dograh',
    dashboard: 'https://dograh.example/ops',
    workflowId: 8,
    did: '+919999999999',
    dids: [{
      id: 3,
      number: '+919999999999',
      status: 'active',
      label: 'Main',
      isDefaultCallerId: true,
      inboundWorkflowId: 8,
      inboundWorkflowName: 'Dograh Receptionist',
    }],
    configuration: { id: 2, name: 'Default trunk', isDefaultOutbound: true },
  });
  assert.equal(body.connected, true);
  assert.equal(body.did, '+919999999999');
  assert.equal(body.dids.length, 1);
  assert.equal(body.provider, undefined);
  assert.equal(body.orchestrator, undefined);
  assert.equal(body.dashboard, undefined);
  assert.equal(body.workflowId, undefined);
  assert.equal(body.dids[0].inboundWorkflowId, undefined);
  assert.equal(body.dids[0].inboundWorkflowName, undefined);
  assert.equal(Object.prototype.hasOwnProperty.call(body.dids[0], 'inboundWorkflowId'), false);
  const blob = JSON.stringify(body);
  assert.equal(PROVIDER_BRAND_RE.test(blob), false);
  assert.equal(blob.includes('"inboundWorkflowId":8'), false);
  assert.equal(blob.includes('Dograh'), false);
});

test('publicTelephonyStatus keeps Astra wf_* inboundWorkflowId only', () => {
  const body = org.publicTelephonyStatus({
    connected: true,
    dids: [{
      id: 3,
      number: '+919999999999',
      status: 'active',
      label: 'Main',
      isDefaultCallerId: true,
      inboundWorkflowId: 'wf_abc123',
      inboundWorkflowName: 'should not leak',
    }],
  });
  assert.equal(body.dids[0].inboundWorkflowId, 'wf_abc123');
  assert.equal(body.dids[0].inboundWorkflowName, undefined);
});

test('versionPayload reads GIT_SHA from env and never invents', () => {
  assert.deepEqual(org.versionPayload({}, { version: '1.0.0' }), {
    gitSha: null,
    ref: null,
    version: '1.0.0',
    builtAt: null,
  });
  assert.equal(org.versionPayload({ GIT_SHA: '  abc123  ' }, { version: '1.0.0' }).gitSha, 'abc123');
  assert.equal(org.versionPayload({ GITHUB_SHA: 'def456' }).gitSha, 'def456');
  assert.equal(org.versionPayload({ GIT_SHA: 'abc', GITHUB_SHA: 'def' }).gitSha, 'abc');
  assert.equal(org.versionPayload({ BUILT_AT: '2026-09-17T00:00:00Z' }).builtAt, '2026-09-17T00:00:00Z');
  assert.equal(org.versionPayload({ GIT_REF: 'refs/heads/main' }).ref, 'refs/heads/main');
});

test('unauthenticated GET /api/version is auth-gated (401)', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'astra-ver-auth-'));
  const dbFile = path.join(tmpDir, 'db.json');
  process.env.RAPIDX_DB_FILE = dbFile;
  process.env.GIT_SHA = 'feedface01';
  process.env.BUILT_AT = '2026-09-17T09:00:00Z';

  for (const key of Object.keys(require.cache)) {
    if (key.includes('/dashboard/lib/')) delete require.cache[key];
  }
  const core = require('../lib/core');
  const orgMod = require('../lib/org');

  const tenantId = core.genId('t_');
  const userId = core.genId('u_');
  const now = new Date().toISOString();
  await core.mutate((d) => {
    d.tenants.push({
      id: tenantId, name: 'Ver', slug: 'ver', createdAt: now,
      branding: { color: '#6B21A8' }, providers: {}, plan: 'starter', status: 'active', privacyMode: 'standard',
    });
    d.users.push({
      id: userId, tenantId, email: 'ver@astra.local', name: 'Ver',
      passHash: core.hashPassword('password-verxxxx'), role: 'owner', status: 'active', createdAt: now,
    });
  });
  const cookie = 'rxv_sess=' + await core.createSession(userId, tenantId);

  async function handle(req, res) {
    const route = (req.url || '').split('?')[0];
    if (req.method === 'GET' && route === '/api/version') {
      return core.requireAuth(req, res, (rq, rs) => {
        core.sendJson(rs, 200, orgMod.versionPayload(process.env, { version: '1.0.0' }));
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
    delete process.env.GIT_SHA;
    delete process.env.BUILT_AT;
  });

  function request(pathName, cookieHeader) {
    return new Promise((resolve, reject) => {
      http.get({
        hostname: '127.0.0.1', port, path: pathName,
        headers: cookieHeader ? { Cookie: cookieHeader } : {},
      }, (r) => {
        const chunks = [];
        r.on('data', (c) => chunks.push(c));
        r.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({ status: r.statusCode, body: text ? JSON.parse(text) : null });
        });
      }).on('error', reject);
    });
  }

  const anon = await request('/api/version');
  assert.equal(anon.status, 401);

  const authed = await request('/api/version', cookie);
  assert.equal(authed.status, 200);
  assert.equal(authed.body.gitSha, 'feedface01');
  assert.equal(authed.body.version, '1.0.0');
  assert.equal(authed.body.builtAt, '2026-09-17T09:00:00Z');
});

test('unauthenticated health serializer shape never advertises brands', () => {
  // Mirrors apiHealth for anonymous / non-super_admin callers.
  const payload = org.publicHealthPayload({
    uptime: 1,
    version: '1.0.0',
    gitSha: 'abc',
    deployedAt: null,
  });
  const text = JSON.stringify(payload);
  assert.match(text, /"ok":true/);
  assert.match(text, /"gitSha":"abc"/);
  assert.doesNotMatch(text, PROVIDER_BRAND_RE);
  assert.equal(payload.providers, undefined);
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
