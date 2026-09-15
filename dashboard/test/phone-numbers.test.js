'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const phoneNumbers = require('../lib/phone-numbers');
const { DograhVobizProvider, TelephonyProviderError } = require('../lib/telephony-provider');

test('seedPlatformInventory is idempotent and available until assigned', () => {
  const db = { phoneNumbers: [], providerResources: [], agents: [] };
  const a = phoneNumbers.seedPlatformInventory(db);
  const b = phoneNumbers.seedPlatformInventory(db);
  assert.equal(db.phoneNumbers.length, 1);
  assert.equal(a.id, b.id);
  assert.equal(a.e164, '+918065353938');
  assert.equal(a.label, 'AstraNova Main Line');
  assert.equal(a.status, 'available');
  assert.equal(a.tenantId, null);
  assert.equal(a.providerMetadata.dograhTelephonyConfigId, 2);
  assert.equal(a.providerMetadata.dograhPhoneNumberId, 3);
  assert.equal(a.providerMetadata.inboundWorkflowId, 8);
  assert.equal(db.providerResources.length, 1);
});

test('publicPhoneNumber hides provider mapping and keys', () => {
  const n = {
    id: 'pn_1', e164: '+918065353938', label: 'Main', country: 'IN', numberType: 'local',
    capabilities: ['inbound', 'outbound'], status: 'available', assignedAgentId: null,
    inboundEnabled: true, outboundEnabled: true, createdAt: 't', updatedAt: 't',
    provider: 'dograh_vobiz', providerNumberId: '3',
    providerMetadata: { dograhPhoneNumberId: 3, apiKey: 'secret' },
  };
  const pub = phoneNumbers.publicPhoneNumber(n);
  assert.equal(pub.id, 'pn_1');
  assert.equal(pub.e164, '+918065353938');
  assert.equal(pub.provider, undefined);
  assert.equal(pub.providerNumberId, undefined);
  assert.equal(pub.providerMetadata, undefined);
  assert.equal(JSON.stringify(pub).includes('dograh'), false);
  assert.equal(JSON.stringify(pub).includes('secret'), false);
});

test('assign and unassign update agent telephony.did and status', () => {
  const db = { phoneNumbers: [], providerResources: [], agents: [] };
  phoneNumbers.seedPlatformInventory(db);
  const tenantId = 't_a';
  const otherTenant = 't_b';
  db.agents.push({
    id: 'ag_1', tenantId, name: 'Desk', telephony: { did: '' },
  });
  db.agents.push({
    id: 'ag_other', tenantId: otherTenant, name: 'Other', telephony: { did: '' },
  });

  const badAgent = phoneNumbers.assignNumber(db, {
    numberId: phoneNumbers.PLATFORM_SEED_ID, tenantId, agentId: 'ag_other',
  });
  assert.equal(badAgent.ok, false);
  assert.equal(badAgent.code, 'agent_not_found');

  const assigned = phoneNumbers.assignNumber(db, {
    numberId: phoneNumbers.PLATFORM_SEED_ID,
    tenantId,
    agentId: 'ag_1',
    inboundEnabled: true,
    outboundEnabled: false,
  });
  assert.equal(assigned.ok, true);
  assert.equal(assigned.number.status, 'assigned');
  assert.equal(assigned.number.tenantId, tenantId);
  assert.equal(assigned.number.assignedAgentId, 'ag_1');
  assert.equal(assigned.number.outboundEnabled, false);
  assert.equal(db.agents[0].telephony.did, '918065353938');
  assert.equal(db.agents[0].telephony.phoneNumberId, phoneNumbers.PLATFORM_SEED_ID);
  assert.equal(phoneNumbers.listAvailableInventory(db).length, 0);
  assert.equal(phoneNumbers.listTenantNumbers(db, tenantId).length, 1);

  const cross = phoneNumbers.assignNumber(db, {
    numberId: phoneNumbers.PLATFORM_SEED_ID,
    tenantId: otherTenant,
    agentId: 'ag_other',
  });
  assert.equal(cross.ok, false);
  assert.equal(cross.status, 403);

  const un = phoneNumbers.unassignNumber(db, {
    numberId: phoneNumbers.PLATFORM_SEED_ID,
    tenantId,
  });
  assert.equal(un.ok, true);
  assert.equal(un.number.status, 'available');
  assert.equal(un.number.tenantId, null);
  assert.equal(db.agents[0].telephony.did, '');
  assert.equal(phoneNumbers.listAvailableInventory(db).length, 1);
});

test('tenant isolation on unassign and patch', () => {
  const db = { phoneNumbers: [], providerResources: [], agents: [] };
  phoneNumbers.seedPlatformInventory(db);
  db.agents.push({ id: 'ag_1', tenantId: 't_a', name: 'A', telephony: { did: '' } });
  phoneNumbers.assignNumber(db, { numberId: phoneNumbers.PLATFORM_SEED_ID, tenantId: 't_a', agentId: 'ag_1' });

  const forbidden = phoneNumbers.unassignNumber(db, { numberId: phoneNumbers.PLATFORM_SEED_ID, tenantId: 't_b' });
  assert.equal(forbidden.ok, false);
  assert.equal(forbidden.status, 403);

  const patchForbidden = phoneNumbers.patchNumber(db, {
    numberId: phoneNumbers.PLATFORM_SEED_ID, tenantId: 't_b', inboundEnabled: false,
  });
  assert.equal(patchForbidden.ok, false);
  assert.equal(patchForbidden.status, 403);

  const patched = phoneNumbers.patchNumber(db, {
    numberId: phoneNumbers.PLATFORM_SEED_ID, tenantId: 't_a', inboundEnabled: false, outboundEnabled: true,
  });
  assert.equal(patched.ok, true);
  assert.equal(patched.number.inboundEnabled, false);
  assert.equal(patched.number.outboundEnabled, true);
});

test('DograhVobizProvider.purchaseNumber returns 501 purchase_deferred', async () => {
  const provider = new DograhVobizProvider({ core: null });
  await assert.rejects(
    () => provider.purchaseNumber({ e164: '+919999999999' }),
    (err) => {
      assert.ok(err instanceof TelephonyProviderError);
      assert.equal(err.status, 501);
      assert.equal(err.code, 'purchase_deferred');
      return true;
    },
  );
});

test('HTTP phone-numbers routes: available, assign, unassign, purchase 501, tenant isolation', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'astra-pn-'));
  const dbFile = path.join(tmpDir, 'db.json');
  process.env.RAPIDX_DB_FILE = dbFile;

  // Fresh module load so core picks up the temp DB file.
  delete require.cache[require.resolve('../lib/core')];
  delete require.cache[require.resolve('../lib/phone-numbers')];
  delete require.cache[require.resolve('../lib/telephony-provider')];
  const core = require('../lib/core');
  const pn = require('../lib/phone-numbers');
  const { createDefaultTelephonyProvider } = require('../lib/telephony-provider');
  const telephonyProvider = createDefaultTelephonyProvider(core);

  await core.mutate((d) => { pn.seedPlatformInventory(d); });

  const tenantA = core.genId('t_');
  const tenantB = core.genId('t_');
  const userA = core.genId('u_');
  const userB = core.genId('u_');
  const agentA = core.genId('ag_');
  const now = new Date().toISOString();
  await core.mutate((d) => {
    d.tenants.push(
      { id: tenantA, name: 'A', slug: 'a', createdAt: now, branding: { color: '#6B21A8' }, providers: { stt: 'deepgram', tts: 'rumik', llm: 'groq', telephony: 'vobiz' }, plan: 'studio', status: 'active', privacyMode: 'standard' },
      { id: tenantB, name: 'B', slug: 'b', createdAt: now, branding: { color: '#6B21A8' }, providers: { stt: 'deepgram', tts: 'rumik', llm: 'groq', telephony: 'vobiz' }, plan: 'studio', status: 'active', privacyMode: 'standard' },
    );
    d.users.push(
      { id: userA, tenantId: tenantA, email: 'a@astra.local', name: 'A', passHash: core.hashPassword('password-aaaa'), role: 'owner', status: 'active', createdAt: now },
      { id: userB, tenantId: tenantB, email: 'b@astra.local', name: 'B', passHash: core.hashPassword('password-bbbb'), role: 'owner', status: 'active', createdAt: now },
    );
    d.agents.push({
      id: agentA, tenantId: tenantA, name: 'Reception', persona: '', greeting: '',
      tts: { provider: 'rumik', model: 'mulberry', speaker: 'speaker_1', f0_up_key: 0 },
      telephony: { did: '' }, createdAt: now,
    });
  });

  const cookieA = 'rxv_sess=' + await core.createSession(userA, tenantA);
  const cookieB = 'rxv_sess=' + await core.createSession(userB, tenantB);

  function matchRoute(route) {
    if (route === '/api/phone-numbers') return { action: 'list' };
    if (route === '/api/phone-numbers/available') return { action: 'available' };
    if (route === '/api/phone-numbers/purchase') return { action: 'purchase' };
    const assign = route.match(/^\/api\/phone-numbers\/([^/]+)\/assign$/);
    if (assign) return { action: 'assign', id: decodeURIComponent(assign[1]) };
    const unassign = route.match(/^\/api\/phone-numbers\/([^/]+)\/unassign$/);
    if (unassign) return { action: 'unassign', id: decodeURIComponent(unassign[1]) };
    const one = route.match(/^\/api\/phone-numbers\/([^/]+)$/);
    if (one) return { action: 'one', id: decodeURIComponent(one[1]) };
    return null;
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1');
    const route = url.pathname;
    const matched = matchRoute(route);

    if (req.method === 'GET' && matched && matched.action === 'list') {
      return core.requireAuth(req, res, (rq, rs, ctx) => {
        const agentsById = new Map(core.db().agents.filter((a) => a.tenantId === ctx.tenant.id).map((a) => [a.id, a]));
        const numbers = pn.listTenantNumbers(core.db(), ctx.tenant.id).map((n) => pn.publicPhoneNumber(n, agentsById));
        core.sendJson(rs, 200, { numbers });
      });
    }
    if (req.method === 'GET' && matched && matched.action === 'available') {
      return core.requireAuth(req, res, async (rq, rs, ctx) => {
        const numbers = await telephonyProvider.listInventory(ctx.tenant.id);
        core.sendJson(rs, 200, { numbers });
      });
    }
    if (req.method === 'POST' && matched && matched.action === 'purchase') {
      return core.requireAuth(req, res, async (rq, rs) => {
        try {
          await telephonyProvider.purchaseNumber();
        } catch (e) {
          core.sendJson(rs, e.status || 502, { error: e.message, code: e.code });
        }
      });
    }
    if (req.method === 'POST' && matched && matched.action === 'assign') {
      const body = await core.readBody(req);
      return core.requireAuth(req, res, async (rq, rs, ctx) => {
        try {
          const number = await telephonyProvider.assignNumber(matched.id, ctx.tenant.id, {
            agentId: body.agentId,
            inboundEnabled: body.inboundEnabled,
            outboundEnabled: body.outboundEnabled,
          });
          core.sendJson(rs, 200, { number });
        } catch (e) {
          core.sendJson(rs, e.status || 502, { error: e.message, code: e.code });
        }
      }, body);
    }
    if (req.method === 'POST' && matched && matched.action === 'unassign') {
      return core.requireAuth(req, res, async (rq, rs, ctx) => {
        try {
          const number = await telephonyProvider.unassignNumber(matched.id, ctx.tenant.id);
          core.sendJson(rs, 200, { number });
        } catch (e) {
          core.sendJson(rs, e.status || 502, { error: e.message, code: e.code });
        }
      });
    }
    if (req.method === 'PATCH' && matched && matched.action === 'one') {
      const body = await core.readBody(req);
      return core.requireAuth(req, res, async (rq, rs, ctx) => {
        let result;
        await core.mutate((d) => {
          result = pn.patchNumber(d, {
            numberId: matched.id,
            tenantId: ctx.tenant.id,
            inboundEnabled: body.inboundEnabled,
            outboundEnabled: body.outboundEnabled,
          });
        });
        if (!result.ok) return core.sendJson(rs, result.status, { error: result.error, code: result.code });
        core.sendJson(rs, 200, { number: pn.publicPhoneNumber(result.number) });
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

  const available = await request('GET', '/api/phone-numbers/available', null, cookieA);
  assert.equal(available.status, 200);
  assert.equal(available.body.numbers.length, 1);
  assert.equal(available.body.numbers[0].e164, '+918065353938');
  assert.equal(available.body.numbers[0].label, 'AstraNova Main Line');
  assert.equal(JSON.stringify(available.body).includes('dograh'), false);
  assert.equal(JSON.stringify(available.body).includes('providerMetadata'), false);
  const numberId = available.body.numbers[0].id;

  const purchase = await request('POST', '/api/phone-numbers/purchase', { country: 'IN' }, cookieA);
  assert.equal(purchase.status, 501);
  assert.equal(purchase.body.code, 'purchase_deferred');

  const assigned = await request('POST', '/api/phone-numbers/' + numberId + '/assign', {
    agentId: agentA, inboundEnabled: true, outboundEnabled: true,
  }, cookieA);
  assert.equal(assigned.status, 200);
  assert.equal(assigned.body.number.status, 'assigned');
  assert.equal(assigned.body.number.assignedAgentId, agentA);

  const mine = await request('GET', '/api/phone-numbers', null, cookieA);
  assert.equal(mine.status, 200);
  assert.equal(mine.body.numbers.length, 1);

  const otherList = await request('GET', '/api/phone-numbers', null, cookieB);
  assert.equal(otherList.status, 200);
  assert.equal(otherList.body.numbers.length, 0);

  const otherUnassign = await request('POST', '/api/phone-numbers/' + numberId + '/unassign', {}, cookieB);
  assert.equal(otherUnassign.status, 403);

  const otherAvailable = await request('GET', '/api/phone-numbers/available', null, cookieB);
  assert.equal(otherAvailable.status, 200);
  assert.equal(otherAvailable.body.numbers.length, 0, 'assigned number must leave shared inventory');

  const toggled = await request('PATCH', '/api/phone-numbers/' + numberId, { inboundEnabled: false }, cookieA);
  assert.equal(toggled.status, 200);
  assert.equal(toggled.body.number.inboundEnabled, false);

  const unassigned = await request('POST', '/api/phone-numbers/' + numberId + '/unassign', {}, cookieA);
  assert.equal(unassigned.status, 200);
  assert.equal(unassigned.body.number.status, 'available');

  const availableAgain = await request('GET', '/api/phone-numbers/available', null, cookieA);
  assert.equal(availableAgain.body.numbers.length, 1);
});
