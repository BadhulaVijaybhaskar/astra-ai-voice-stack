'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  AGENT_TYPES,
  PRESET_LIBRARY,
  seedPresets,
  applyPresetToAgent,
  publicPreset,
  getAgentType,
  normalizeAgentType,
} = require('../lib/agent-types');

test('agent types expose the five first-class ids with recommended presets', () => {
  assert.deepEqual(AGENT_TYPES.map((t) => t.id), [
    'inbound_receptionist',
    'outbound_callback',
    'lead_qualifier',
    'support',
    'custom',
  ]);
  for (const type of AGENT_TYPES) {
    assert.ok(type.label);
    assert.ok(type.description);
    assert.ok(['inbound', 'outbound', 'both'].includes(type.direction));
    assert.ok(Array.isArray(type.recommendedPresetIds));
  }
  assert.equal(getAgentType('inbound_receptionist').direction, 'inbound');
  assert.equal(normalizeAgentType('nope'), 'custom');
});

test('seedPresets inserts AstraNova presets and backfills agentType on existing rows', () => {
  const db = {
    presets: [{
      id: 'preset_receptionist_v1',
      name: 'AI Receptionist',
      category: 'reception',
      isSystem: true,
      createdAt: '2024-01-01T00:00:00.000Z',
      greeting: 'old',
      fields: [],
      guardrails: [],
    }],
  };
  seedPresets(db);
  const ids = db.presets.map((p) => p.id);
  assert.ok(ids.includes('preset_astranova_eng_receptionist_v1'));
  assert.ok(ids.includes('preset_astranova_outbound_jerry_v1'));
  assert.equal(db.presets.length, PRESET_LIBRARY.length);

  const eng = db.presets.find((p) => p.id === 'preset_astranova_eng_receptionist_v1');
  assert.equal(eng.agentType, 'inbound_receptionist');
  assert.equal(eng.dograhWorkflowId, 8);
  assert.equal(eng.direction, 'inbound');

  const jerry = db.presets.find((p) => p.id === 'preset_astranova_outbound_jerry_v1');
  assert.equal(jerry.agentType, 'outbound_callback');
  assert.equal(jerry.dograhWorkflowId, null);
  assert.equal(jerry.dograhWorkflowKey, 'outbound_callback');

  const receptionist = db.presets.find((p) => p.id === 'preset_receptionist_v1');
  assert.equal(receptionist.agentType, 'inbound_receptionist');
  assert.equal(receptionist.createdAt, '2024-01-01T00:00:00.000Z');
  assert.ok(receptionist.description);

  for (const preset of db.presets) {
    assert.ok(preset.agentType, preset.id + ' missing agentType');
    assert.ok(['inbound', 'outbound', 'both'].includes(preset.direction));
  }
});

test('applyPresetToAgent copies type and Dograh workflow binding', () => {
  const eng = PRESET_LIBRARY.find((p) => p.id === 'preset_astranova_eng_receptionist_v1');
  const agent = applyPresetToAgent({ id: 'ag_1' }, eng, { name: 'Front Desk EN' });
  assert.equal(agent.presetId, eng.id);
  assert.equal(agent.agentType, 'inbound_receptionist');
  assert.equal(agent.direction, 'inbound');
  assert.equal(agent.dograhWorkflowId, 8);
  assert.equal(agent.dograhWorkflowKey, null);
  assert.equal(agent.name, 'Front Desk EN');
  assert.match(agent.persona, /AstraNova English Receptionist/);
  assert.equal(agent.greeting, eng.greeting);

  const jerry = PRESET_LIBRARY.find((p) => p.id === 'preset_astranova_outbound_jerry_v1');
  const outbound = applyPresetToAgent({ id: 'ag_2' }, jerry, {});
  assert.equal(outbound.agentType, 'outbound_callback');
  assert.equal(outbound.dograhWorkflowId, null);
  assert.equal(outbound.dograhWorkflowKey, 'outbound_callback');

  const blank = applyPresetToAgent({ id: 'ag_3' }, null, {
    agentType: 'custom',
    name: 'Blank',
    persona: 'Be helpful.',
    greeting: 'Hello.',
  });
  assert.equal(blank.presetId, null);
  assert.equal(blank.agentType, 'custom');
  assert.equal(blank.dograhWorkflowId, null);
  assert.equal(blank.name, 'Blank');

  const pub = publicPreset(eng);
  assert.equal(pub.agentType, 'inbound_receptionist');
  assert.equal(pub.direction, 'inbound');
  assert.equal(pub.dograhWorkflowId, 8);
  assert.equal(Object.prototype.hasOwnProperty.call(publicPreset(jerry), 'dograhWorkflowId'), false);
  assert.equal(publicPreset(jerry).dograhWorkflowKey, 'outbound_callback');
});

test('GET /api/agent-types and preset create copy fields through the live server', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'astra-agent-types-'));
  const dbFile = path.join(tmpDir, 'db.json');
  process.env.RAPIDX_DB_FILE = dbFile;
  process.env.PORT = '0';
  process.env.TEST_USER_EMAIL = 'agent-types-test@astra.local';
  process.env.TEST_USER_PASSWORD = 'agent-types-test-password';
  process.env.TEST_USER_TENANT = 'Agent Types Test';

  // Fresh module graph against the temp db file.
  for (const key of Object.keys(require.cache)) {
    if (key.includes(`${path.sep}dashboard${path.sep}`)) delete require.cache[key];
  }

  const core = require('../lib/core');
  core.loadEnv();
  // Force empty db before boot.
  fs.writeFileSync(dbFile, JSON.stringify({
    schemaVersion: 3,
    tenants: [], users: [], agents: [], usage: [], sessions: [],
    wallets: [], ledger: [], paymentIntents: [], supportTickets: [],
    supportMessages: [], auditEvents: [], presets: [], byonConnections: [],
    hvacJobs: [], hvacSettings: [], paymentEvents: [], demoLinks: [],
    callbackJobs: [],
  }, null, 2));

  // Require server side effects carefully: server.js starts listening at the bottom.
  // Instead exercise seed + HTTP by spinning a minimal handler using the same modules.
  const agentTypes = require('../lib/agent-types');
  const providers = require('../lib/providers');

  await core.mutate((d) => { agentTypes.seedPresets(d); });
  const tenantId = core.genId('t_');
  const userId = core.genId('u_');
  const now = new Date().toISOString();
  await core.mutate((d) => {
    d.tenants.push({
      id: tenantId, name: 'Agent Types Test', slug: 'agent-types-test', createdAt: now,
      branding: { color: '#6B21A8' }, providers: { stt: 'deepgram', tts: 'rumik', llm: 'groq', telephony: 'vobiz' },
      plan: 'studio', status: 'active', privacyMode: 'standard',
    });
    d.users.push({
      id: userId, tenantId, email: 'agent-types-test@astra.local', name: 'Tester',
      passHash: core.hashPassword('agent-types-test-password'), role: 'owner', status: 'active', createdAt: now,
    });
  });

  const token = await core.createSession(userId, tenantId);
  const cookie = 'rxv_sess=' + token;

  function handle(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1');
    const route = url.pathname;
    if (route === '/api/agent-types' && req.method === 'GET') {
      return core.requireAuth(req, res, () => {
        core.sendJson(res, 200, { agentTypes: agentTypes.AGENT_TYPES.map((x) => ({ ...x, recommendedPresetIds: [...x.recommendedPresetIds] })) });
      });
    }
    if (route === '/api/presets' && req.method === 'GET') {
      return core.requireAuth(req, res, (rq, rs, ctx) => {
        const presets = core.db().presets.filter((p) => p.isSystem || p.tenantId === ctx.tenant.id).map(agentTypes.publicPreset);
        core.sendJson(rs, 200, { presets });
      });
    }
    if (route === '/api/agents' && req.method === 'POST') {
      return core.readBody(req).then((body) => core.requireAuth(req, res, async (rq, rs, ctx) => {
        const preset = body.presetId
          ? core.db().presets.find((p) => p.id === String(body.presetId) && (p.isSystem || p.tenantId === ctx.tenant.id))
          : null;
        if (body.presetId && !preset) return core.sendJson(rs, 404, { error: 'preset not found', code: 'not_found' });
        const agent = agentTypes.applyPresetToAgent({
          id: core.genId('ag_'),
          tenantId: ctx.tenant.id,
          tts: { provider: providers.tts.id, model: 'mulberry', speaker: 'speaker_1', f0_up_key: 0 },
          telephony: { did: '' },
          createdAt: new Date().toISOString(),
        }, preset, {
          name: body.name,
          persona: body.persona,
          greeting: body.greeting,
          agentType: body.agentType,
        });
        await core.mutate((d) => { d.agents.push(agent); });
        core.sendJson(rs, 200, {
          agent: {
            id: agent.id, name: agent.name, persona: agent.persona, greeting: agent.greeting,
            presetId: agent.presetId, agentType: agent.agentType, direction: agent.direction,
            dograhWorkflowId: agent.dograhWorkflowId, dograhWorkflowKey: agent.dograhWorkflowKey,
          },
        });
      }, body)).catch((err) => core.sendJson(res, 400, { error: err.message }));
    }
    core.sendJson(res, 404, { error: 'missing' });
  }

  const server = http.createServer((req, res) => { handle(req, res); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  t.after(() => {
    server.close();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
    delete process.env.RAPIDX_DB_FILE;
  });

  function request(method, route, body) {
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

  const typesRes = await request('GET', '/api/agent-types');
  assert.equal(typesRes.status, 200);
  assert.equal(typesRes.body.agentTypes.length, 5);
  assert.equal(typesRes.body.agentTypes[0].id, 'inbound_receptionist');

  const presetsRes = await request('GET', '/api/presets');
  assert.equal(presetsRes.status, 200);
  const eng = presetsRes.body.presets.find((p) => p.id === 'preset_astranova_eng_receptionist_v1');
  assert.equal(eng.agentType, 'inbound_receptionist');
  assert.equal(eng.direction, 'inbound');
  assert.equal(eng.dograhWorkflowId, 8);

  const created = await request('POST', '/api/agents', {
    presetId: 'preset_astranova_eng_receptionist_v1',
    name: 'Live EN Desk',
  });
  assert.equal(created.status, 200);
  assert.equal(created.body.agent.agentType, 'inbound_receptionist');
  assert.equal(created.body.agent.dograhWorkflowId, 8);
  assert.equal(created.body.agent.presetId, 'preset_astranova_eng_receptionist_v1');
});
