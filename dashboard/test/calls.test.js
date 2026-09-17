'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const calls = require('../lib/calls');
const { DograhVobizProvider } = require('../lib/telephony-provider');

test('seedDemoCalls is idempotent per tenant providerRunId', () => {
  const db = {
    calls: [], providerResources: [],
    agents: [{ id: 'ag_1', tenantId: 't_a', name: 'Desk' }], phoneNumbers: [],
  };
  const a = calls.seedDemoCalls(db, 't_a');
  const b = calls.seedDemoCalls(db, 't_a');
  assert.equal(a.created, 2);
  assert.equal(b.created, 0);
  assert.equal(b.updated, 2);
  assert.equal(db.calls.length, 2);
  assert.equal(db.calls.every((c) => c.tenantId === 't_a'), true);
  assert.equal(db.providerResources.length, 2);
});

test('upsertCallFromProvider is idempotent on providerRunId', () => {
  const db = { calls: [], providerResources: [], agents: [], phoneNumbers: [] };
  const first = calls.upsertCallFromProvider(db, 't_a', {
    providerRunId: 'run_1',
    direction: 'inbound',
    fromE164: '+919999999999',
    toE164: '+918065353938',
    status: 'completed',
    summary: 'first',
  });
  const second = calls.upsertCallFromProvider(db, 't_a', {
    providerRunId: 'run_1',
    direction: 'inbound',
    summary: 'updated',
    outcome: 'booked',
  });
  assert.equal(first.created, true);
  assert.equal(second.updated, true);
  assert.equal(db.calls.length, 1);
  assert.equal(db.calls[0].summary, 'updated');
  assert.equal(db.calls[0].outcome, 'booked');
});

test('publicCall hides provider secrets and uses Astra recording path', () => {
  const call = {
    id: 'call_1', tenantId: 't_a', agentId: 'ag_1', phoneNumberId: 'pn_1',
    direction: 'inbound', fromE164: '+9198', toE164: '+9180', status: 'completed',
    startedAt: 't', endedAt: 't', durationSec: 30, outcome: 'ok', summary: 's',
    extractedData: { x: 1 }, transcript: [{ role: 'user', text: 'hi' }],
    latency: { totalMs: 100, sttMs: 10, llmMs: 50, ttsMs: 40 },
    recordingAvailable: true,
    provider: 'dograh_vobiz', providerRunId: 'run_x',
    providerMetadata: { providerRunId: 'run_x', recordingUrl: 'https://dograh.example/rec?token=secret' },
    dograhWorkflowId: '8', workflowVersion: 'v2',
    createdAt: 't', updatedAt: 't',
  };
  const agents = new Map([['ag_1', { id: 'ag_1', name: 'Desk' }]]);
  const pub = calls.publicCall(call, agents, { detail: true });
  assert.equal(pub.agentName, 'Desk');
  assert.equal(pub.recordingUrl, '/api/calls/call_1/recording');
  assert.equal(pub.provider, undefined);
  assert.equal(pub.providerRunId, undefined);
  assert.equal(pub.providerMetadata, undefined);
  assert.equal(pub.dograhWorkflowId, undefined);
  assert.equal(JSON.stringify(pub).includes('secret'), false);
  assert.equal(JSON.stringify(pub).includes('dograh'), false);
  assert.equal(JSON.stringify(pub).includes('providerRunId'), false);
  assert.equal(JSON.stringify(pub).includes('run_x'), false);
  assert.deepEqual(pub.extractedData, { x: 1 });
  assert.equal(pub.latency.totalMs, 100);
});

test('tenant isolation: findCallForTenant and listTenantCalls', () => {
  const db = { calls: [], providerResources: [], agents: [], phoneNumbers: [] };
  calls.upsertCallFromProvider(db, 't_a', { providerRunId: 'a1', summary: 'A' });
  calls.upsertCallFromProvider(db, 't_b', { providerRunId: 'b1', summary: 'B' });
  const listA = calls.listTenantCalls(db, 't_a');
  assert.equal(listA.length, 1);
  assert.equal(listA[0].summary, 'A');
  const cross = calls.findCallForTenant(db, listA[0].id, 't_b');
  assert.equal(cross.ok, false);
  assert.equal(cross.status, 403);
  const own = calls.findCallForTenant(db, listA[0].id, 't_a');
  assert.equal(own.ok, true);
});

test('mapDograhRunToCallInput accepts flexible aliases', () => {
  const mapped = calls.mapDograhRunToCallInput({
    run_id: 42,
    call_direction: 'outbound',
    from_number: '+918065353938',
    to_number: '+919811122233',
    status: 'completed',
    duration: 55,
    summary: 'ok',
    extracted_data: { permission: true },
    transcript: [{ speaker: 'agent', content: 'Hello' }],
    recording_url: 'https://example.com/r.mp3',
    latency: { total_ms: 900, stt_ms: 100, llm_ms: 500, tts_ms: 300 },
  }, { agentId: 'ag_1' });
  assert.equal(mapped.providerRunId, '42');
  assert.equal(mapped.direction, 'outbound');
  assert.equal(mapped.durationSec, 55);
  assert.equal(mapped.recordingAvailable, true);
  assert.equal(mapped.transcript[0].role, 'agent');
  assert.equal(mapped.latency.totalMs, 900);
  assert.equal(mapped.agentId, 'ag_1');
});

test('DograhVobizProvider.syncCalls seeds demos when Dograh stubbed', async () => {
  const store = {
    _db: {
      calls: [], providerResources: [],
      agents: [{ id: 'ag_1', tenantId: 't_a', name: 'Desk' }],
      phoneNumbers: [],
    },
    db() { return this._db; },
    async mutate(fn) { fn(this._db); },
  };
  const tel = {
    live: false,
    async listCallRuns() { return { runs: [], stubbed: true, reason: 'not_configured' }; },
  };
  const provider = new DograhVobizProvider({ core: store, telephony: tel });
  const first = await provider.syncCalls('t_a');
  assert.equal(first.ok, true);
  assert.equal(first.stubbed, true);
  assert.ok(first.total >= 2);
  const second = await provider.syncCalls('t_a');
  assert.equal(second.ok, true);
  assert.equal(store._db.calls.length, first.total);
});

test('HTTP calls routes: list, detail, sync idempotency, recording 404, tenant isolation', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'astra-calls-'));
  const dbFile = path.join(tmpDir, 'db.json');
  process.env.RAPIDX_DB_FILE = dbFile;

  delete require.cache[require.resolve('../lib/core')];
  delete require.cache[require.resolve('../lib/calls')];
  delete require.cache[require.resolve('../lib/telephony-provider')];
  const core = require('../lib/core');
  const { createDefaultTelephonyProvider } = require('../lib/telephony-provider');
  const telephonyProvider = createDefaultTelephonyProvider(core);

  const tenantA = core.genId('t_');
  const tenantB = core.genId('t_');
  const userA = core.genId('u_');
  const userB = core.genId('u_');
  const agentA = core.genId('ag_');
  const now = new Date().toISOString();
  await core.mutate((d) => {
    d.tenants.push(
      {
        id: tenantA, name: 'A', slug: 'a', createdAt: now, branding: { color: '#6B21A8' },
        providers: { stt: 'deepgram', tts: 'rumik', llm: 'groq', telephony: 'vobiz' },
        plan: 'studio', status: 'active', privacyMode: 'standard',
      },
      {
        id: tenantB, name: 'B', slug: 'b', createdAt: now, branding: { color: '#6B21A8' },
        providers: { stt: 'deepgram', tts: 'rumik', llm: 'groq', telephony: 'vobiz' },
        plan: 'studio', status: 'active', privacyMode: 'standard',
      },
    );
    d.users.push(
      {
        id: userA, tenantId: tenantA, email: 'a-calls@astra.local', name: 'A',
        passHash: core.hashPassword('password-aaaa'), role: 'owner', status: 'active', createdAt: now,
      },
      {
        id: userB, tenantId: tenantB, email: 'b-calls@astra.local', name: 'B',
        passHash: core.hashPassword('password-bbbb'), role: 'owner', status: 'active', createdAt: now,
      },
    );
    d.agents.push({
      id: agentA, tenantId: tenantA, name: 'Reception', persona: '', greeting: '',
      tts: { provider: 'rumik', model: 'mulberry', speaker: 'speaker_1', f0_up_key: 0 },
      telephony: { did: '' }, createdAt: now,
    });
  });

  const cookieA = 'rxv_sess=' + await core.createSession(userA, tenantA);
  const cookieB = 'rxv_sess=' + await core.createSession(userB, tenantB);

  function matchCallsRoute(route) {
    if (route === '/api/calls') return { action: 'list' };
    if (route === '/api/calls/sync') return { action: 'sync' };
    const recording = route.match(/^\/api\/calls\/([^/]+)\/recording$/);
    if (recording) return { action: 'recording', id: decodeURIComponent(recording[1]) };
    const one = route.match(/^\/api\/calls\/([^/]+)$/);
    if (one) return { action: 'detail', id: decodeURIComponent(one[1]) };
    return null;
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1');
    const route = url.pathname;
    const matched = matchCallsRoute(route);

    if (req.method === 'GET' && matched && matched.action === 'list') {
      return core.requireAuth(req, res, async (rq, rs, ctx) => {
        const list = await telephonyProvider.listCalls(ctx.tenant.id, {
          agentId: url.searchParams.get('agentId') || undefined,
          direction: url.searchParams.get('direction') || undefined,
          limit: url.searchParams.get('limit') || undefined,
        });
        core.sendJson(rs, 200, { calls: list });
      });
    }
    if (req.method === 'GET' && matched && matched.action === 'detail') {
      return core.requireAuth(req, res, async (rq, rs, ctx) => {
        try {
          const call = await telephonyProvider.getCall(matched.id, ctx.tenant.id);
          core.sendJson(rs, 200, { call });
        } catch (e) {
          core.sendJson(rs, e.status || 502, { error: e.message, code: e.code });
        }
      });
    }
    if (req.method === 'GET' && matched && matched.action === 'recording') {
      return core.requireAuth(req, res, async (rq, rs, ctx) => {
        try {
          await telephonyProvider.getRecording(matched.id, ctx.tenant.id);
          core.sendJson(rs, 200, { ok: true });
        } catch (e) {
          core.sendJson(rs, e.status || 502, { error: e.message, code: e.code });
        }
      });
    }
    if (req.method === 'POST' && matched && matched.action === 'sync') {
      const body = await core.readBody(req);
      return core.requireAuth(req, res, async (rq, rs, ctx) => {
        const result = await telephonyProvider.syncCalls(ctx.tenant.id, body || {});
        core.sendJson(rs, 200, result);
      }, body);
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

  function request(method, route, body, cookie) {
    return new Promise((resolve, reject) => {
      const payload = body ? JSON.stringify(body) : null;
      const req = http.request({
        hostname: '127.0.0.1', port, path: route, method,
        headers: {
          Cookie: cookie || '',
          'Content-Type': 'application/json',
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let data = null;
          try { data = JSON.parse(raw || 'null'); } catch { data = raw; }
          resolve({ status: res.statusCode, data });
        });
      });
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  const sync1 = await request('POST', '/api/calls/sync', {}, cookieA);
  assert.equal(sync1.status, 200);
  assert.equal(sync1.data.ok, true);
  assert.ok(sync1.data.total >= 2);

  const sync2 = await request('POST', '/api/calls/sync', {}, cookieA);
  assert.equal(sync2.status, 200);
  assert.equal(sync2.data.total, sync1.data.total);

  const listA = await request('GET', '/api/calls?limit=20', null, cookieA);
  assert.equal(listA.status, 200);
  assert.ok(Array.isArray(listA.data.calls));
  assert.ok(listA.data.calls.length >= 2);
  const sample = listA.data.calls[0];
  assert.ok(sample.id);
  assert.ok(['inbound', 'outbound'].includes(sample.direction));
  assert.equal(sample.provider, undefined);
  assert.equal(JSON.stringify(sample).includes('dograh'), false);

  const detail = await request('GET', '/api/calls/' + encodeURIComponent(sample.id), null, cookieA);
  assert.equal(detail.status, 200);
  assert.ok(detail.data.call);
  assert.ok(detail.data.call.transcript != null);
  assert.ok(detail.data.call.latency);
  assert.ok(detail.data.call.extractedData);

  const recording = await request('GET', '/api/calls/' + encodeURIComponent(sample.id) + '/recording', null, cookieA);
  assert.equal(recording.status, 404);
  assert.equal(recording.data.code, 'recording_not_found');

  const listB = await request('GET', '/api/calls', null, cookieB);
  assert.equal(listB.status, 200);
  assert.equal((listB.data.calls || []).some((c) => c.id === sample.id), false);

  const crossDetail = await request('GET', '/api/calls/' + encodeURIComponent(sample.id), null, cookieB);
  assert.ok(crossDetail.status === 403 || crossDetail.status === 404);

  const imported = await request('POST', '/api/calls/sync', {
    import: [{
      providerRunId: 'manual_run_1',
      direction: 'inbound',
      fromE164: '+919700000001',
      toE164: '+918065353938',
      status: 'completed',
      summary: 'manual import',
      outcome: 'qualified',
    }],
  }, cookieA);
  assert.equal(imported.status, 200);
  assert.ok(imported.data.imported);
  const listAfter = await request('GET', '/api/calls?limit=50', null, cookieA);
  assert.ok(listAfter.data.calls.some((c) => c.summary === 'manual import'));

  const inboundOnly = await request('GET', '/api/calls?direction=inbound', null, cookieA);
  assert.equal(inboundOnly.status, 200);
  assert.ok(inboundOnly.data.calls.every((c) => c.direction === 'inbound'));
});
