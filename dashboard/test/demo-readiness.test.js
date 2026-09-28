'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const phoneNumbers = require('../lib/phone-numbers');
const workflows = require('../lib/workflows');
const { DograhVobizProvider, TelephonyProviderError } = require('../lib/telephony-provider');
const employees = require('../lib/employees');
const org = require('../lib/org');

function makeCore(db) {
  return {
    db: () => db,
    async mutate(fn) {
      fn(db);
      return db;
    },
  };
}

test('createOutboundCall fails closed when no Phone Number is assigned', async () => {
  const db = {
    phoneNumbers: [],
    providerResources: [],
    agents: [],
    workflows: [],
    calls: [],
  };
  phoneNumbers.seedPlatformInventory(db);
  // Inventory exists but is NOT assigned to the tenant.

  let dialed = false;
  const tel = {
    live: true,
    async initiateCall() {
      dialed = true;
      throw new Error('should not dial');
    },
    async dial() {
      dialed = true;
      throw new Error('should not dial');
    },
  };

  const provider = new DograhVobizProvider({ core: makeCore(db), telephony: tel });
  await assert.rejects(
    () => provider.createOutboundCall('t1', '+919876543210', {}),
    (err) => {
      assert.ok(err instanceof TelephonyProviderError);
      assert.equal(err.code, 'phone_number_required');
      assert.equal(err.status, 422);
      return true;
    },
  );
  assert.equal(dialed, false);
});

test('createOutboundCall fails closed on invalid explicit phoneNumberId', async () => {
  const db = {
    phoneNumbers: [],
    providerResources: [],
    agents: [],
    workflows: [],
    calls: [],
  };
  phoneNumbers.seedPlatformInventory(db);
  db.agents.push({ id: 'ag_1', tenantId: 't1', name: 'Desk', telephony: { did: '' } });
  phoneNumbers.assignNumber(db, {
    numberId: phoneNumbers.PLATFORM_SEED_ID,
    tenantId: 't1',
    agentId: 'ag_1',
    outboundEnabled: true,
  });

  let dialed = false;
  const tel = {
    live: true,
    async initiateCall() { dialed = true; return { status: 200, data: {}, providerRunId: 'x', ok: true }; },
  };
  const provider = new DograhVobizProvider({ core: makeCore(db), telephony: tel });
  await assert.rejects(
    () => provider.createOutboundCall('t1', '+919876543210', { phoneNumberId: 'pn_missing' }),
    (err) => err && err.code === 'phone_number_not_found',
  );
  assert.equal(dialed, false);
});

test('createOutboundCall still resolves assigned number and sets failClosedNumbers', async () => {
  const db = {
    phoneNumbers: [],
    providerResources: [],
    agents: [],
    workflows: [],
    calls: [],
  };
  phoneNumbers.seedPlatformInventory(db);
  db.agents.push({ id: 'ag_1', tenantId: 't1', name: 'Desk', telephony: { did: '' } });
  phoneNumbers.assignNumber(db, {
    numberId: phoneNumbers.PLATFORM_SEED_ID,
    tenantId: 't1',
    agentId: 'ag_1',
    outboundEnabled: true,
  });

  let seenOpts = null;
  const tel = {
    live: true,
    async initiateCall(phone, options) {
      seenOpts = { phone, options };
      return {
        status: 200,
        data: { call_id: 'run_fc_1', status: 'queued' },
        providerRunId: 'run_fc_1',
        ok: true,
      };
    },
  };
  const provider = new DograhVobizProvider({ core: makeCore(db), telephony: tel });
  const result = await provider.createOutboundCall('t1', '+919876543210', {});
  assert.equal(seenOpts.options.telephonyConfigId, 2);
  assert.equal(seenOpts.options.fromPhoneNumberId, 3);
  assert.equal(seenOpts.options.failClosedNumbers, true);
  assert.equal(result.providerRunId, 'run_fc_1');
});

test('publicEmployee voice never leaks model or speaker ids', () => {
  const db = { employees: [], agents: [], workflows: [], calls: [], leads: [], phoneNumbers: [] };
  const created = employees.createEmployee(db, 't1', {
    templateKey: 'receptionist',
    name: 'Ria',
  }, 'u1');
  assert.equal(created.ok, true);
  const pub = employees.publicEmployee(created.employee, db);
  assert.equal(pub.voice.tier, 'standard');
  assert.equal(pub.voice.tierAvailable, true);
  assert.equal(pub.voice.profileLabel, 'Standard voice profile');
  assert.equal('model' in pub.voice, false);
  assert.equal('speaker' in pub.voice, false);
  assert.equal('f0_up_key' in pub.voice, false);
  const blob = JSON.stringify(pub);
  assert.equal(/mulberry|speaker_1|rumik|deepgram|groq|dograh|vobiz/i.test(blob), false);
});

test('non-standard voice tiers fail closed', () => {
  const db = { employees: [], agents: [], workflows: [], calls: [], leads: [], phoneNumbers: [] };
  const created = employees.createEmployee(db, 't1', {
    templateKey: 'instant_lead_caller',
    name: 'Caller',
  }, 'u1');
  assert.equal(created.ok, true);
  const denied = employees.setEmployeeVoiceTier(db, 't1', created.employee.id, 'licensed_brand');
  assert.equal(denied.ok, false);
  assert.equal(denied.code, 'voice_tier_unavailable');
  const ok = employees.setEmployeeVoiceTier(db, 't1', created.employee.id, 'standard');
  assert.equal(ok.ok, true);
  assert.equal(ok.voiceTier, 'standard');
});

test('publicProvidersPayload has no provider brand strings', () => {
  const described = {
    stt: [{ id: 'deepgram', live: true, selected: true, model: 'nova-3' }],
    tts: [{ id: 'rumik', live: true, selected: true, model: 'mulberry' }],
    llm: [{ id: 'groq', live: true, selected: true, model: 'llama' }],
    telephony: [{ id: 'vobiz', live: true, selected: true }],
  };
  const body = org.publicProvidersPayload(described);
  assert.equal(body.ready, true);
  assert.equal(body.layers.voice, true);
  assert.equal(body.layers.brain, true);
  assert.equal(body.layers.listening, true);
  assert.equal(body.layers.telephony, true);
  const blob = JSON.stringify(body);
  assert.equal(/vobiz|dograh|deepgram|rumik|groq|mulberry|nova/i.test(blob), false);
});
