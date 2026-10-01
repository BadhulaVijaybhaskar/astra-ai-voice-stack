'use strict';

/**
 * Phone Numbers workspace: marketplace search, gated purchase, assignment,
 * Dograh mapping, Connected verification. Never live-buys in tests.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const phoneNumbers = require('../lib/phone-numbers');
const {
  DograhVobizProvider,
  TelephonyProviderError,
} = require('../lib/telephony-provider');
const { createMockVobizClient } = require('../lib/vobiz-client');

function makeCore(db) {
  return {
    db: () => db,
    async mutate(fn) {
      fn(db);
      return db;
    },
  };
}

function seedTenant(db) {
  phoneNumbers.seedPlatformInventory(db);
  db.agents = db.agents || [];
  db.employees = db.employees || [];
  db.workflows = db.workflows || [];
  db.calls = db.calls || [];
  db.agents.push({
    id: 'ag_maya',
    tenantId: 't1',
    name: 'Maya',
    telephony: { did: '' },
  });
  db.agents.push({
    id: 'ag_vaani',
    tenantId: 't1',
    name: 'Vaani',
    telephony: { did: '' },
  });
  db.employees.push({
    id: 'emp_maya',
    tenantId: 't1',
    name: 'Maya',
    agentId: 'ag_maya',
    phoneNumberId: null,
    status: 'ACTIVE',
  });
  db.employees.push({
    id: 'emp_vaani',
    tenantId: 't1',
    name: 'Vaani',
    agentId: 'ag_vaani',
    phoneNumberId: null,
    status: 'ACTIVE',
  });
}

const MOCK_INVENTORY = [
  {
    id: 'inv_1',
    e164: '+918045670001',
    country: 'IN',
    region: 'Karnataka',
    city: 'Bengaluru',
    type: 'local',
    capabilities: { voice: true, sms: false },
    monthly_fee: 500,
    setup_fee: 0,
    currency: 'INR',
  },
  {
    id: 'inv_2',
    e164: '+918045670002',
    country: 'IN',
    region: 'Telangana',
    city: 'Hyderabad',
    type: 'local',
    capabilities: { voice: true, sms: true },
    monthly_fee: 550,
    setup_fee: 100,
    taxes: 18,
    currency: 'INR',
  },
];

test('NUMBER SEARCH API: mock VoBiz inventory filters by country/city/type', async () => {
  const db = { phoneNumbers: [], providerResources: [], agents: [], employees: [], workflows: [], calls: [] };
  seedTenant(db);
  const provider = new DograhVobizProvider({
    core: makeCore(db),
    useMockVobiz: true,
    mockInventory: MOCK_INVENTORY,
    simulatePurchases: true,
    telephony: { live: false },
  });
  const all = await provider.searchAvailableNumbers({ country: 'IN' });
  assert.equal(all.ok, true);
  assert.equal(all.source, 'mock');
  assert.equal(all.numbers.length, 2);
  assert.equal(all.marketplace.searchLive, true);

  const hyd = await provider.searchAvailableNumbers({ country: 'IN', city: 'Hyderabad' });
  assert.equal(hyd.numbers.length, 1);
  assert.equal(hyd.numbers[0].e164, '+918045670002');
  assert.ok(hyd.numbers[0].monthlyFee === 550);
  assert.ok(hyd.numbers[0].capabilities.includes('sms'));
});

test('PRICING: returns real fees only, never invents', async () => {
  const db = { phoneNumbers: [], providerResources: [], agents: [], employees: [], workflows: [], calls: [] };
  const provider = new DograhVobizProvider({
    core: makeCore(db),
    useMockVobiz: true,
    mockInventory: MOCK_INVENTORY,
    simulatePurchases: true,
    telephony: { live: false },
  });
  const pricing = await provider.getPricing('+918045670002');
  assert.equal(pricing.monthlyFee, 550);
  assert.equal(pricing.setupFee, 100);
  assert.equal(pricing.taxes, 18);
  assert.equal(pricing.currency, 'INR');
});

test('PURCHASE FLOW READY: confirm required, live buy gated, simulate provisions + Connected', async () => {
  const db = { phoneNumbers: [], providerResources: [], agents: [], employees: [], workflows: [], calls: [] };
  seedTenant(db);
  const provider = new DograhVobizProvider({
    core: makeCore(db),
    useMockVobiz: true,
    mockInventory: MOCK_INVENTORY.slice(),
    simulatePurchases: true,
    telephony: { live: false },
  });

  await assert.rejects(
    () => provider.purchaseNumber({
      tenantId: 't1',
      e164: '+918045670001',
      monthlyFee: 500,
      setupFee: 0,
    }),
    (err) => err instanceof TelephonyProviderError && err.code === 'needs_confirm',
  );

  // Without simulate and without live flag, refuse (safety).
  const liveGated = new DograhVobizProvider({
    core: makeCore(db),
    vobizClient: createMockVobizClient(MOCK_INVENTORY.slice()),
    simulatePurchases: false,
    telephony: { live: false },
  });
  // Force non-mock path: override id so purchaseFromInventory gate applies via env.
  liveGated.vobiz = createVobizLikeDisabled();
  await assert.rejects(
    () => liveGated.purchaseNumber({
      tenantId: 't1',
      e164: '+918045670001',
      confirm: true,
      monthlyFee: 500,
      setupFee: 0,
    }),
    (err) => err.code === 'live_purchase_disabled' || err.code === 'vobiz_not_configured',
  );

  const bought = await provider.purchaseNumber({
    tenantId: 't1',
    e164: '+918045670001',
    confirm: true,
    simulate: true,
    expectedMonthlyFee: 500,
    expectedSetupFee: 0,
    monthlyFee: 500,
    setupFee: 0,
    currency: 'INR',
    employeeId: 'emp_vaani',
    country: 'IN',
    numberType: 'local',
  });
  assert.equal(bought.ok, true);
  assert.equal(bought.simulated, true);
  assert.equal(bought.livePurchase, false);
  assert.equal(bought.steps.provision, true);
  assert.equal(bought.steps.astraPersist, true);
  assert.equal(bought.steps.assign, true);
  assert.equal(bought.steps.dograhBind, true);
  assert.equal(bought.steps.answerUrl, true);
  assert.equal(bought.steps.hangup, true);
  assert.equal(bought.steps.websocket, true);
  assert.equal(bought.steps.verify, true);
  assert.equal(bought.connected, true);
  assert.equal(bought.number.assignedEmployeeId, 'emp_vaani');
  assert.equal(bought.number.e164, '+918045670001');
  assert.equal(JSON.stringify(bought.number).includes('dograh'), false);
  assert.equal(JSON.stringify(bought.number).includes('vobiz'), false);

  // Maya seed mapping unchanged.
  const mayaNum = db.phoneNumbers.find((n) => n.e164 === '+918065353938');
  assert.ok(mayaNum);
  assert.equal(mayaNum.id, phoneNumbers.PLATFORM_SEED_ID);
});

function createVobizLikeDisabled() {
  return {
    id: 'vobiz',
    configured: false,
    async listInventoryNumbers() {
      const err = new Error('not configured');
      err.code = 'vobiz_not_configured';
      err.status = 503;
      throw err;
    },
    async getNumberPricing() {
      const err = new Error('not configured');
      err.code = 'vobiz_not_configured';
      err.status = 503;
      throw err;
    },
    async purchaseFromInventory() {
      const err = new Error('Live number purchase is disabled');
      err.code = 'live_purchase_disabled';
      err.status = 403;
      throw err;
    },
  };
}

test('EMPLOYEE ASSIGNMENT: no silent moves; Maya protected; Vaani can receive new number', async () => {
  const db = { phoneNumbers: [], providerResources: [], agents: [], employees: [], workflows: [], calls: [] };
  seedTenant(db);
  // Assign Maya the protected platform number.
  const mayaAssign = phoneNumbers.assignNumber(db, {
    numberId: phoneNumbers.PLATFORM_SEED_ID,
    tenantId: 't1',
    employeeId: 'emp_maya',
  });
  assert.equal(mayaAssign.ok, true);
  assert.equal(mayaAssign.number.assignedEmployeeId, 'emp_maya');
  assert.equal(mayaAssign.number.e164, '+918065353938');

  // Silent move to Vaani must fail.
  const silent = phoneNumbers.assignNumber(db, {
    numberId: phoneNumbers.PLATFORM_SEED_ID,
    tenantId: 't1',
    employeeId: 'emp_vaani',
  });
  assert.equal(silent.ok, false);
  assert.ok(silent.code === 'reassign_confirm_required' || silent.code === 'protected_number');
  assert.equal(db.employees.find((e) => e.id === 'emp_maya').phoneNumberId, phoneNumbers.PLATFORM_SEED_ID);

  // Explicit confirm can move (product allows with confirm), but Maya mapping
  // stays unless confirmed. Confirm path:
  const moved = phoneNumbers.assignNumber(db, {
    numberId: phoneNumbers.PLATFORM_SEED_ID,
    tenantId: 't1',
    employeeId: 'emp_vaani',
    confirmReassign: true,
  });
  assert.equal(moved.ok, true);

  // Restore Maya for remaining checks.
  phoneNumbers.assignNumber(db, {
    numberId: phoneNumbers.PLATFORM_SEED_ID,
    tenantId: 't1',
    employeeId: 'emp_maya',
    confirmReassign: true,
  });

  // Release of Maya number blocked.
  const release = phoneNumbers.softReleaseNumber(db, {
    numberId: phoneNumbers.PLATFORM_SEED_ID,
    tenantId: 't1',
    confirm: true,
  });
  assert.equal(release.ok, false);
  assert.equal(release.code, 'protected_number');
});

test('DOGRAH MAPPING + CALLBACK CONFIG + ASTRA PERSISTENCE on simulated purchase', async () => {
  const db = { phoneNumbers: [], providerResources: [], agents: [], employees: [], workflows: [], calls: [] };
  seedTenant(db);
  const provider = new DograhVobizProvider({
    core: makeCore(db),
    useMockVobiz: true,
    mockInventory: MOCK_INVENTORY.slice(),
    simulatePurchases: true,
    telephony: { live: false },
  });
  const bought = await provider.purchaseNumber({
    tenantId: 't1',
    e164: '+918045670002',
    confirm: true,
    simulate: true,
    monthlyFee: 550,
    setupFee: 100,
    taxes: 18,
    currency: 'INR',
    employeeId: 'emp_vaani',
  });
  assert.equal(bought.steps.dograhBind, true);
  assert.equal(bought.steps.telephonyApp, true);
  assert.equal(bought.steps.answerUrl, true);
  assert.equal(bought.steps.hangup, true);
  assert.equal(bought.steps.websocket, true);

  const row = db.phoneNumbers.find((n) => n.e164 === '+918045670002');
  assert.ok(row);
  assert.equal(row.tenantId, 't1');
  assert.equal(row.assignedEmployeeId, 'emp_vaani');
  assert.ok(row.providerMetadata.dograhTelephonyConfigId);
  assert.ok(row.providerMetadata.dograhPhoneNumberId);
  assert.equal(row.providerMetadata.answerUrlConfigured, true);
  assert.equal(row.providerMetadata.hangupUrlConfigured, true);
  assert.equal(row.connectionStatus, 'connected');
  assert.ok(db.providerResources.some((r) => r.astraResourceId === row.id));

  const status = await provider.getNumberStatus(row.id, 't1');
  assert.equal(status.validatedWithoutCall, true);
  assert.equal(status.connected, true);
});

test('USAGE never invents metrics; Connected only after verify gates', async () => {
  const db = { phoneNumbers: [], providerResources: [], agents: [], employees: [], workflows: [], calls: [] };
  seedTenant(db);
  const provider = new DograhVobizProvider({
    core: makeCore(db),
    useMockVobiz: true,
    mockInventory: [],
    telephony: { live: false },
  });
  phoneNumbers.assignNumber(db, {
    numberId: phoneNumbers.PLATFORM_SEED_ID,
    tenantId: 't1',
    employeeId: 'emp_maya',
  });
  const usage = await provider.getUsage('t1');
  assert.equal(usage.estimated, false);
  assert.equal(usage.rows.length, 1);
  assert.equal(usage.rows[0].todayCalls, null);
  assert.equal(usage.rows[0].todayMinutes, null);

  const pub = provider.publicize(
    db.phoneNumbers.find((n) => n.id === phoneNumbers.PLATFORM_SEED_ID),
    't1',
  );
  assert.equal(pub.connected, true);
  assert.equal(pub.todayCalls, null);
  assert.equal(pub.todayMinutes, null);
});

test('price mismatch rejects purchase', async () => {
  const db = { phoneNumbers: [], providerResources: [], agents: [], employees: [], workflows: [], calls: [] };
  seedTenant(db);
  const provider = new DograhVobizProvider({
    core: makeCore(db),
    useMockVobiz: true,
    mockInventory: MOCK_INVENTORY.slice(),
    simulatePurchases: true,
    telephony: { live: false },
  });
  await assert.rejects(
    () => provider.purchaseNumber({
      tenantId: 't1',
      e164: '+918045670001',
      confirm: true,
      simulate: true,
      expectedMonthlyFee: 1,
      expectedSetupFee: 0,
      monthlyFee: 500,
      setupFee: 0,
    }),
    (err) => err.code === 'price_mismatch',
  );
});
