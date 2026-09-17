'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const org = require('../lib/org');

test('publicWorkspace aliases organization and workspace to tenant name', () => {
  const pub = org.publicWorkspace({
    id: 't1', name: 'Acme', slug: 'acme', createdAt: 't',
    branding: { color: '#6B21A8' }, providers: {}, plan: 'starter', status: 'active', privacyMode: 'standard',
  });
  assert.equal(pub.workspaceName, 'Acme');
  assert.equal(pub.organizationName, 'Acme');
  assert.equal(pub.plan, 'starter');
});

test('sanitizeTenantUpdate accepts workspaceName and validates color', () => {
  const ok = org.sanitizeTenantUpdate({ workspaceName: 'Nova Desk', color: '#06B6D4' });
  assert.equal(ok.ok, true);
  assert.equal(ok.name, 'Nova Desk');
  assert.equal(ok.color, '#06B6D4');
  const bad = org.sanitizeTenantUpdate({ name: '' });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'bad_name');
});

test('providerHealthSummary never includes secret values', () => {
  const described = {
    stt: [{ id: 'deepgram', label: 'Deepgram', live: true, selected: true, needs: ['DEEPGRAM_API_KEY'], model: 'nova-3' }],
    tts: [{ id: 'rumik', label: 'Rumik', live: false, selected: true, needs: ['RUMIK_API_KEY'] }],
    llm: [], telephony: [],
  };
  const health = org.providerHealthSummary(described);
  assert.equal(health.stt[0].configured, true);
  assert.equal(health.tts[0].configured, false);
  assert.deepEqual(health.stt[0].needs, ['DEEPGRAM_API_KEY']);
  const env = { DEEPGRAM_API_KEY: 'super-secret-deepgram-key-12345', RUMIK_API_KEY: 'rumik-secret-value-xyz' };
  assert.equal(org.assertNoSecretValues(health, env).ok, true);
  assert.equal(org.assertNoSecretValues({ leak: env.DEEPGRAM_API_KEY }, env).ok, false);
});

test('tenant update and audit require owner; admin providers hide secrets', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'astra-org-'));
  const dbFile = path.join(tmpDir, 'db.json');
  process.env.RAPIDX_DB_FILE = dbFile;
  process.env.DEEPGRAM_API_KEY = 'test-deepgram-secret-abcdef';
  process.env.RUMIK_API_KEY = 'test-rumik-secret-ghijkl';

  delete require.cache[require.resolve('../lib/core')];
  delete require.cache[require.resolve('../lib/providers')];
  delete require.cache[require.resolve('../lib/org')];
  const core = require('../lib/core');
  const providers = require('../lib/providers');
  const orgMod = require('../lib/org');

  const tenantId = core.genId('t_');
  const ownerId = core.genId('u_');
  const memberId = core.genId('u_');
  const adminId = core.genId('u_');
  const superId = core.genId('u_');
  const now = new Date().toISOString();
  await core.mutate((d) => {
    d.tenants.push({
      id: tenantId, name: 'Workspace One', slug: 'workspace-one', createdAt: now,
      branding: { color: '#6B21A8' }, providers: { stt: 'deepgram', tts: 'rumik', llm: 'groq', telephony: 'vobiz' },
      plan: 'starter', status: 'active', privacyMode: 'standard',
    });
    d.users.push(
      { id: ownerId, tenantId, email: 'owner@astra.local', name: 'Owner', passHash: core.hashPassword('password-owner'), role: 'owner', status: 'active', createdAt: now },
      { id: memberId, tenantId, email: 'member@astra.local', name: 'Member', passHash: core.hashPassword('password-member'), role: 'member', status: 'active', createdAt: now },
      { id: adminId, tenantId, email: 'admin@astra.local', name: 'Admin', passHash: core.hashPassword('password-adminx'), role: 'admin', status: 'active', createdAt: now },
      { id: superId, tenantId, email: 'super@astra.local', name: 'Super', passHash: core.hashPassword('password-superxx'), role: 'super_admin', status: 'active', createdAt: now },
    );
    d.auditEvents.push({
      id: core.genId('aud_'), tenantId, actorUserId: ownerId, action: 'auth.signup',
      targetType: 'tenant', targetId: tenantId, metadata: {}, createdAt: now,
    });
  });

  const cookieOwner = 'rxv_sess=' + await core.createSession(ownerId, tenantId);
  const cookieMember = 'rxv_sess=' + await core.createSession(memberId, tenantId);
  const cookieAdmin = 'rxv_sess=' + await core.createSession(adminId, tenantId);
  const cookieSuper = 'rxv_sess=' + await core.createSession(superId, tenantId);

  async function handle(req, res) {
    const route = (req.url || '').split('?')[0];
    if (req.method === 'GET' && route === '/api/audit') {
      return core.requireRole(req, res, 'owner', (rq, rs, ctx) => {
        core.sendJson(rs, 200, {
          auditEvents: core.db().auditEvents.filter((e) => e.tenantId === ctx.tenant.id).map(orgMod.publicAuditEvent),
        });
      });
    }
    if (req.method === 'GET' && route === '/api/admin/providers') {
      return core.requireRole(req, res, 'super_admin', (rq, rs) => {
        const health = orgMod.providerHealthSummary(providers.describeProviders());
        core.sendJson(rs, 200, { providers: health });
      });
    }
    if (req.method === 'GET' && route === '/api/admin/diagnostics') {
      return core.requireRole(req, res, 'super_admin', (rq, rs) => {
        const payload = orgMod.buildDiagnosticsConsole({
          described: providers.describeProviders(),
          db: core.db(),
          deploy: { gitSha: 'testsha' },
          version: '1.0.0',
          uptimeSec: 1,
        });
        core.sendJson(rs, 200, { diagnostics: payload });
      });
    }
    if (req.method === 'POST' && route === '/api/tenant/update') {
      const body = await core.readBody(req);
      return core.requireRole(req, res, 'owner', async (rq, rs, ctx) => {
        const parsed = orgMod.sanitizeTenantUpdate(body);
        if (!parsed.ok) return core.sendJson(rs, parsed.status, { error: parsed.error, code: parsed.code });
        let tenant;
        await core.mutate((d) => {
          const row = d.tenants.find((x) => x.id === ctx.tenant.id);
          row.name = parsed.name;
          if (parsed.color) row.branding = Object.assign({}, row.branding || {}, { color: parsed.color });
          d.auditEvents.push({
            id: core.genId('aud_'), tenantId: ctx.tenant.id, actorUserId: ctx.user.id,
            action: 'tenant.updated', targetType: 'tenant', targetId: row.id,
            metadata: { name: row.name }, createdAt: new Date().toISOString(),
          });
          tenant = row;
        });
        core.sendJson(rs, 200, { tenant: orgMod.publicWorkspace(tenant) });
      }, body);
    }
    core.sendJson(res, 404, { error: 'missing' });
  }

  const server = http.createServer((req, res) => { handle(req, res).catch((e) => core.sendJson(res, 500, { error: e.message })); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  t.after(() => {
    server.close();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
    delete process.env.RAPIDX_DB_FILE;
  });

  function request(method, route, body, cookie) {
    return new Promise((resolve, reject) => {
      const payload = body ? JSON.stringify(body) : null;
      const req = http.request({
        hostname: '127.0.0.1', port, path: route, method,
        headers: {
          Cookie: cookie,
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null });
        });
      });
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  const memberDenied = await request('GET', '/api/audit', null, cookieMember);
  assert.equal(memberDenied.status, 403);

  const ownerAudit = await request('GET', '/api/audit', null, cookieOwner);
  assert.equal(ownerAudit.status, 200);
  assert.ok(ownerAudit.body.auditEvents.length >= 1);

  const memberUpdate = await request('POST', '/api/tenant/update', { name: 'Nope' }, cookieMember);
  assert.equal(memberUpdate.status, 403);

  const ownerUpdate = await request('POST', '/api/tenant/update', { name: 'Nova Workspace', color: '#06B6D4' }, cookieOwner);
  assert.equal(ownerUpdate.status, 200);
  assert.equal(ownerUpdate.body.tenant.workspaceName, 'Nova Workspace');
  assert.equal(ownerUpdate.body.tenant.organizationName, 'Nova Workspace');

  const adminDenied = await request('GET', '/api/admin/providers', null, cookieAdmin);
  assert.equal(adminDenied.status, 403);

  const health = await request('GET', '/api/admin/providers', null, cookieSuper);
  assert.equal(health.status, 200);
  const blob = JSON.stringify(health.body);
  assert.equal(blob.includes('test-deepgram-secret-abcdef'), false);
  assert.equal(blob.includes('test-rumik-secret-ghijkl'), false);
  assert.ok(blob.includes('configured'));
  assert.ok(Array.isArray(health.body.providers.stt));

  const ownerDeniedDiag = await request('GET', '/api/admin/diagnostics', null, cookieOwner);
  assert.equal(ownerDeniedDiag.status, 403);
  const adminDeniedDiag = await request('GET', '/api/admin/diagnostics', null, cookieAdmin);
  assert.equal(adminDeniedDiag.status, 403);
  const diag = await request('GET', '/api/admin/diagnostics', null, cookieSuper);
  assert.equal(diag.status, 200);
  assert.equal(diag.body.diagnostics.scope, 'super_admin');
  assert.equal(diag.body.diagnostics.customerVisible, false);
  assert.ok(diag.body.diagnostics.providers);
  assert.equal(JSON.stringify(diag.body).includes('test-deepgram-secret-abcdef'), false);
});
