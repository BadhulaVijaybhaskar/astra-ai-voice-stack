'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const phoneNumbers = require('../lib/phone-numbers');
const workflows = require('../lib/workflows');
const calls = require('../lib/calls');
const { DograhVobizProvider } = require('../lib/telephony-provider');

function makeCore(db) {
  return {
    db: () => db,
    async mutate(fn) {
      fn(db);
      return db;
    },
  };
}

test('createOutboundCall resolves assigned outboundDialContext into initiateCall options', async () => {
  const db = {
    phoneNumbers: [],
    providerResources: [],
    agents: [],
    workflows: [],
    calls: [],
  };
  phoneNumbers.seedPlatformInventory(db);
  db.agents.push({ id: 'ag_1', tenantId: 't1', name: 'Desk', telephony: { did: '' } });
  const assigned = phoneNumbers.assignNumber(db, {
    numberId: phoneNumbers.PLATFORM_SEED_ID,
    tenantId: 't1',
    agentId: 'ag_1',
    outboundEnabled: true,
  });
  assert.equal(assigned.ok, true);

  let seenOpts = null;
  const tel = {
    live: true,
    async initiateCall(phone, options) {
      seenOpts = { phone, options };
      return {
        status: 200,
        data: { call_id: 'run_outbound_1', status: 'queued' },
        providerRunId: 'run_outbound_1',
        ok: true,
      };
    },
    async dial() {
      throw new Error('dial should not be used for E.164');
    },
  };

  const provider = new DograhVobizProvider({ core: makeCore(db), telephony: tel });
  const result = await provider.createOutboundCall('t1', '+919876543210', {});
  assert.equal(seenOpts.phone, '+919876543210');
  assert.equal(seenOpts.options.telephonyConfigId, 2);
  assert.equal(seenOpts.options.fromPhoneNumberId, 3);
  assert.equal(result.providerRunId, 'run_outbound_1');
  assert.equal(result.ok, true);
  assert.equal(result.status, 200);
});

test('createOutboundCall prefers explicit Astra phoneNumberId and workflowId', async () => {
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

  // Second assigned number with distinct Dograh ids. Explicit pn_ should win.
  db.phoneNumbers.push({
    id: 'pn_explicit',
    tenantId: 't1',
    provider: 'dograh_vobiz',
    providerNumberId: '55',
    e164: '+919111111111',
    label: 'Explicit',
    country: 'IN',
    numberType: 'local',
    capabilities: ['inbound', 'outbound'],
    status: 'assigned',
    assignedAgentId: 'ag_1',
    inboundEnabled: true,
    outboundEnabled: true,
    providerMetadata: {
      dograhTelephonyConfigId: 88,
      dograhPhoneNumberId: 55,
    },
    createdAt: 't',
    updatedAt: 't',
  });

  const wf = workflows.createWorkflow(db, 't1', {
    templateKey: 'outbound_sales',
    name: 'Sales dial',
  }, 'u1');
  assert.equal(wf.ok, true);
  wf.workflow.providerWorkflowId = '77';
  wf.workflow.status = 'published';

  let seenOpts = null;
  const tel = {
    live: true,
    async initiateCall(phone, options) {
      seenOpts = { phone, options };
      return {
        status: 201,
        data: { id: 'nested_ok' },
        providerRunId: 'nested_ok',
        ok: true,
      };
    },
  };

  const provider = new DograhVobizProvider({ core: makeCore(db), telephony: tel });
  const result = await provider.createOutboundCall('t1', '+919876543210', {
    phoneNumberId: 'pn_explicit',
    workflowId: wf.workflow.id,
  });
  assert.equal(seenOpts.options.telephonyConfigId, 88);
  assert.equal(seenOpts.options.fromPhoneNumberId, 55);
  assert.equal(seenOpts.options.workflowId, 77);
  assert.equal(result.providerRunId, 'nested_ok');
  assert.ok(result.call);
  assert.equal(result.call.providerRunId, 'nested_ok');

  // Minimal upsert for Full-Stack: Call exists under Astra id, public shape hides Dograh.
  const listed = calls.listTenantCalls(db, 't1', { limit: 10 });
  assert.equal(listed.length, 1);
  assert.equal(listed[0].providerRunId, 'nested_ok');
  const pub = calls.publicCall(listed[0]);
  assert.equal(pub.id, result.call.id);
  assert.equal(pub.providerRunId, undefined);
  assert.equal(pub.providerMetadata, undefined);
  assert.equal(JSON.stringify(pub).includes('dograh'), false);
  assert.equal(JSON.stringify(pub).includes('nested_ok'), false);
  assert.equal(JSON.stringify(pub).includes('providerRunId'), false);
  // Customer dial response contract: { call: publicCall(...) } only.
  const dialBody = { call: pub };
  assert.equal(Object.keys(dialBody).join(','), 'call');
  assert.equal(JSON.stringify(dialBody).includes('providerRunId'), false);
});

test('createOutboundCall keeps numeric Dograh workflowId override', async () => {
  const db = {
    phoneNumbers: [],
    providerResources: [],
    agents: [],
    workflows: [],
    calls: [],
  };
  let seenOpts = null;
  const tel = {
    live: true,
    async initiateCall(_phone, options) {
      seenOpts = options;
      return { status: 200, data: { run_id: 'r1' }, providerRunId: 'r1', ok: true };
    },
  };
  const provider = new DograhVobizProvider({ core: makeCore(db), telephony: tel });
  // Explicit server-side number ids satisfy fail-closed. No silent env fallback.
  await provider.createOutboundCall('t1', '+14155552671', {
    workflowId: 42,
    telephonyConfigId: 2,
    fromPhoneNumberId: 3,
  });
  assert.equal(seenOpts.workflowId, 42);
  assert.equal(seenOpts.telephonyConfigId, 2);
  assert.equal(seenOpts.fromPhoneNumberId, 3);
  assert.equal(seenOpts.failClosedNumbers, true);
});

test('createOutboundCall reconciles providerRunId when initiate returns only run name', async () => {
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

  const tel = {
    live: true,
    async initiateCall() {
      return {
        status: 200,
        data: { message: 'Call initiated successfully with run name WR-TEL-OUT-63869822' },
        providerRunId: null,
        providerRunName: 'WR-TEL-OUT-63869822',
        dialAccepted: true,
        ok: true,
      };
    },
    async resolveProviderRunAfterDial({ runName, phoneE164 }) {
      assert.equal(runName, 'WR-TEL-OUT-63869822');
      assert.equal(phoneE164, '+919618824700');
      return '99';
    },
  };

  const provider = new DograhVobizProvider({ core: makeCore(db), telephony: tel });
  const result = await provider.createOutboundCall('t1', '+919618824700', {});
  assert.equal(result.ok, true);
  assert.equal(result.dialAccepted, true);
  assert.equal(result.providerRunId, '99');
  assert.equal(result.providerRunName, 'WR-TEL-OUT-63869822');
  assert.ok(result.call);
  assert.equal(result.call.providerRunId, '99');
});

test('createOutboundCall stays dialAccepted without inventing id when reconcile misses', async () => {
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

  const tel = {
    live: true,
    async initiateCall() {
      return {
        status: 200,
        data: { message: 'Call initiated successfully with run name WR-TEL-OUT-XXXX' },
        providerRunId: null,
        providerRunName: 'WR-TEL-OUT-XXXX',
        dialAccepted: true,
        ok: true,
      };
    },
    async resolveProviderRunAfterDial() { return null; },
  };

  const provider = new DograhVobizProvider({ core: makeCore(db), telephony: tel });
  const result = await provider.createOutboundCall('t1', '+919618824700', {});
  assert.equal(result.ok, true);
  assert.equal(result.dialAccepted, true);
  assert.equal(result.providerRunId, null);
  assert.equal(result.call, null);
  assert.equal(db.calls.length, 0);
});
