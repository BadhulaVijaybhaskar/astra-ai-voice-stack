'use strict';

/**
 * Regression: customer /api/me must not expose tenant.providers or vendor ids.
 * Super Admin diagnostics remain on authorized admin surfaces.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PROVIDER_BRAND_RE = /vobiz|dograh|deepgram|rumik|groq/i;

function bustLibCache() {
  const bust = ['../lib/core', '../lib/org', '../lib/providers'];
  for (const rel of bust) {
    try { delete require.cache[require.resolve(rel)]; } catch (_) {}
  }
  const libRoot = path.resolve(__dirname, '..', 'lib') + path.sep;
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(libRoot)) delete require.cache[key];
  }
}

test('publicWorkspace strips providers unless includeProviders', () => {
  const org = require('../lib/org');
  const tenant = {
    id: 't1', name: 'Acme', slug: 'acme', createdAt: 't',
    branding: { color: '#6B21A8' },
    providers: { stt: 'deepgram', tts: 'rumik', llm: 'groq', telephony: 'vobiz' },
    plan: 'starter', status: 'active', privacyMode: 'standard',
  };
  const pub = org.publicWorkspace(tenant);
  assert.equal(Object.prototype.hasOwnProperty.call(pub, 'providers'), false);
  assert.equal(PROVIDER_BRAND_RE.test(JSON.stringify(pub)), false);

  const admin = org.publicWorkspace(tenant, { includeProviders: true });
  assert.deepEqual(admin.providers, tenant.providers);
});

test('customer GET /api/me has no providers; Super Admin diagnostics still work', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'astra-me-bound-'));
  const dbFile = path.join(tmpDir, 'db.json');
  process.env.RAPIDX_DB_FILE = dbFile;
  bustLibCache();

  const core = require('../lib/core');
  const orgMod = require('../lib/org');
  const providers = require('../lib/providers');

  const tenantId = core.genId('t_');
  const ownerId = core.genId('u_');
  const superId = core.genId('u_');
  const now = new Date().toISOString();
  const providerInventory = { stt: 'deepgram', tts: 'rumik', llm: 'groq', telephony: 'vobiz' };

  await core.mutate((d) => {
    d.tenants.push({
      id: tenantId, name: 'Boundary Co', slug: 'boundary', createdAt: now,
      branding: { color: '#6B21A8' }, providers: { ...providerInventory },
      plan: 'starter', status: 'active', privacyMode: 'standard',
    });
    d.users.push(
      {
        id: ownerId, tenantId, email: 'owner@boundary.local', name: 'Owner',
        passHash: core.hashPassword('password-ownerxxxx'), role: 'owner', status: 'active', createdAt: now,
      },
      {
        id: superId, tenantId, email: 'super@boundary.local', name: 'Super',
        passHash: core.hashPassword('password-superxxxx'), role: 'super_admin', status: 'active', createdAt: now,
      },
    );
  });

  const cookieOwner = 'rxv_sess=' + await core.createSession(ownerId, tenantId);
  const cookieSuper = 'rxv_sess=' + await core.createSession(superId, tenantId);

  async function handle(req, res) {
    const route = (req.url || '').split('?')[0];
    if (req.method === 'GET' && route === '/api/me') {
      return core.requireAuth(req, res, (rq, rs, ctx) => {
        core.sendJson(rs, 200, {
          user: {
            id: ctx.user.id, tenantId: ctx.user.tenantId, email: ctx.user.email,
            name: ctx.user.name, role: ctx.user.role, status: ctx.user.status, createdAt: ctx.user.createdAt,
          },
          tenant: orgMod.publicWorkspace(ctx.tenant),
          impersonation: null,
        });
      });
    }
    if (req.method === 'GET' && route === '/api/admin/providers') {
      return core.requireRole(req, res, 'super_admin', (rq, rs) => {
        core.sendJson(rs, 200, {
          providers: orgMod.providerHealthSummary(providers.describeProviders()),
        });
      });
    }
    if (req.method === 'GET' && route === '/api/admin/diagnostics') {
      return core.requireRole(req, res, 'super_admin', (rq, rs) => {
        const payload = orgMod.buildDiagnosticsConsole({
          described: providers.describeProviders(),
          db: core.db(),
          deploy: { gitSha: 'abc', deployedAt: null, ref: null },
        });
        core.sendJson(rs, 200, { diagnostics: payload });
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
          resolve({ status: r.statusCode, body: text ? JSON.parse(text) : null, text });
        });
      }).on('error', reject);
    });
  }

  const ownerMe = await request('/api/me', cookieOwner);
  assert.equal(ownerMe.status, 200);
  assert.equal(ownerMe.body.tenant.providers, undefined);
  assert.equal(Object.prototype.hasOwnProperty.call(ownerMe.body.tenant, 'providers'), false);
  assert.equal(PROVIDER_BRAND_RE.test(ownerMe.text), false);
  assert.equal(ownerMe.text.includes('"stt"'), false);
  assert.equal(ownerMe.text.includes('"tts"'), false);

  // Even Super Admin /api/me stays clean; diagnostics are separate surfaces.
  const superMe = await request('/api/me', cookieSuper);
  assert.equal(superMe.status, 200);
  assert.equal(Object.prototype.hasOwnProperty.call(superMe.body.tenant, 'providers'), false);
  assert.equal(PROVIDER_BRAND_RE.test(superMe.text), false);

  const ownerDiag = await request('/api/admin/diagnostics', cookieOwner);
  assert.equal(ownerDiag.status, 403);

  const superProviders = await request('/api/admin/providers', cookieSuper);
  assert.equal(superProviders.status, 200);
  assert.ok(superProviders.body.providers);
  assert.ok(Array.isArray(superProviders.body.providers.stt) || superProviders.body.providers.tts);

  const superDiag = await request('/api/admin/diagnostics', cookieSuper);
  assert.equal(superDiag.status, 200);
  assert.ok(superDiag.body.diagnostics);
  assert.ok(superDiag.body.diagnostics.providers);
});
