'use strict';

/**
 * Plivo secondary telephony provider. All network calls mocked.
 * Never places live calls or purchases numbers.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  PlivoProvider,
  DograhVobizProvider,
  createDefaultTelephonyProvider,
  listTelephonyProviderStatuses,
  TelephonyProviderError,
} = require('../lib/telephony-provider');
const {
  createMockPlivoClient,
  createPlivoClient,
  credentialsConfigured,
} = require('../lib/plivo-client');
const phoneNumbers = require('../lib/phone-numbers');
const org = require('../lib/org');

const MOCK_INVENTORY = [
  {
    number: '918012345678',
    country: 'IN',
    type: 'local',
    city: 'Bengaluru',
    region: 'KA',
    monthly_rental_rate: '0.80',
    setup_rate: '0.00',
    voice_enabled: true,
    sms_enabled: false,
    voice_rate: '0.009',
  },
  {
    number: '918098765432',
    country: 'IN',
    type: 'mobile',
    city: 'Mumbai',
    monthly_rental_rate: '1.20',
    setup_rate: '0.50',
    voice_enabled: true,
    sms_enabled: true,
  },
];

const MOCK_OWNED = [
  {
    number: '14155550100',
    country: 'US',
    type: 'local',
    voice_enabled: true,
    alias: 'Lab line',
  },
];

function mockClient(extra) {
  return createMockPlivoClient({
    inventory: MOCK_INVENTORY.slice(),
    owned: MOCK_OWNED.slice(),
    ...(extra || {}),
  });
}

test('Plivo needs_setup when credentials missing', async () => {
  const prevId = process.env.PLIVO_AUTH_ID;
  const prevTok = process.env.PLIVO_AUTH_TOKEN;
  delete process.env.PLIVO_AUTH_ID;
  delete process.env.PLIVO_AUTH_TOKEN;
  try {
    assert.equal(credentialsConfigured(), false);
    const provider = new PlivoProvider({
      plivoClient: createPlivoClient({ authId: '', authToken: '' }),
    });
    const status = await provider.connectionStatus();
    assert.equal(status.status, 'needs_setup');
    assert.equal(status.connected, false);
    assert.equal(JSON.stringify(status).includes('Auth'), false);
  } finally {
    if (prevId != null) process.env.PLIVO_AUTH_ID = prevId;
    else delete process.env.PLIVO_AUTH_ID;
    if (prevTok != null) process.env.PLIVO_AUTH_TOKEN = prevTok;
    else delete process.env.PLIVO_AUTH_TOKEN;
  }
});

test('Plivo validateReadOnly PASS matrix with mock inventory', async () => {
  const provider = new PlivoProvider({ plivoClient: mockClient() });
  const checks = await provider.validateReadOnly();
  assert.equal(checks.PLIVO_AUTH, 'PASS');
  assert.equal(checks.ACCOUNT, 'PASS');
  assert.equal(checks.BALANCE, 'PASS');
  assert.equal(checks.OWNED_NUMBERS, 'PASS');
  assert.equal(checks.NUMBER_SEARCH, 'PASS');
  assert.equal(checks.PRICING, 'PASS');
  assert.equal(checks.AUDIO_STREAMING, 'PASS');
  assert.equal(checks.OUTBOUND_API, 'PASS');
  assert.equal(checks.INBOUND_CONFIG, 'PASS');

  const status = await provider.connectionStatus();
  assert.equal(status.status, 'connected');
  assert.equal(status.buyEligible, true);
  assert.equal(JSON.stringify(status).includes('mock-plivo-token'), false);
  assert.equal(JSON.stringify(status).includes('MAOCKAUTHID'), false);
});

test('Plivo India search returns real mock rows, never invents empty catalog as available', async () => {
  const provider = new PlivoProvider({
    plivoClient: mockClient({ inventory: [] }),
  });
  const empty = await provider.searchAvailableNumbers({ country: 'IN' });
  assert.equal(empty.available, false);
  assert.equal(empty.numbers.length, 0);
  assert.equal(empty.marketplace.livePurchaseEnabled, false);

  const withStock = new PlivoProvider({ plivoClient: mockClient() });
  const listed = await withStock.searchAvailableNumbers({ country: 'IN' });
  assert.equal(listed.available, true);
  assert.ok(listed.numbers.length >= 1);
  assert.equal(listed.numbers[0].e164.startsWith('+'), true);
  assert.equal(listed.numbers[0].purchaseAvailable, false);
  assert.ok(listed.numbers[0].monthlyFee != null);
});

test('Plivo purchase always refused', async () => {
  const provider = new PlivoProvider({ plivoClient: mockClient() });
  await assert.rejects(
    () => provider.purchaseNumber({
      tenantId: 't1', e164: '+918012345678', confirm: true,
    }),
    (err) => err instanceof TelephonyProviderError && err.code === 'plivo_purchase_disabled',
  );
});

test('Plivo outbound is dry-run only (no execute)', async () => {
  const provider = new PlivoProvider({ plivoClient: mockClient() });
  const result = await provider.createOutboundCall('t1', '+919999999999', {
    from: '+918065353938',
    answerUrl: 'https://example.test/answer',
  });
  assert.equal(result.ok, true);
  assert.equal(result.dryRun, true);
  assert.equal(result.executed, false);
  assert.ok(result.payload);
  assert.equal(result.payload.to, '+919999999999');
});

test('Plivo inbound XML + stream capability documented', async () => {
  const provider = new PlivoProvider({ plivoClient: mockClient() });
  const cfg = await provider.configureNumber('pn_x', 't1', {
    streamUrl: 'wss://example.test/stream',
    speak: 'Connecting',
  });
  assert.equal(cfg.ok, true);
  assert.match(cfg.inbound.answerXml, /<Stream/);
  assert.match(cfg.inbound.answerXml, /wss:\/\/example\.test\/stream/);
  assert.ok(Array.isArray(cfg.inbound.applications));
  const stream = provider.audioStreaming();
  assert.equal(stream.supported, true);
  assert.equal(stream.transport, 'websocket');
});

test('Plivo handleWebhook normalizes status callback without secrets', async () => {
  const provider = new PlivoProvider({ plivoClient: mockClient() });
  const event = await provider.handleWebhook({
    CallUUID: 'abc-123',
    CallStatus: 'completed',
    From: '+918065353938',
    To: '+919876543210',
    Direction: 'outbound',
    Duration: '42',
  });
  assert.equal(event.ok, true);
  assert.equal(event.event.callUuid, 'abc-123');
  assert.equal(event.event.status, 'completed');
  assert.equal(JSON.stringify(event).includes('token'), false);
});

test('Plivo recording metadata path', async () => {
  const provider = new PlivoProvider({
    plivoClient: mockClient({
      recordings: {
        call_1: [{
          recording_id: 'rec_1',
          call_uuid: 'call_1',
          recording_url: 'https://media.plivo.example/rec.mp3',
          recording_duration_ms: 12000,
        }],
      },
    }),
  });
  const rec = await provider.getRecording('call_1');
  assert.equal(rec.mode, 'redirect');
  assert.match(rec.url, /^https:\/\//);
});

test('createDefaultTelephonyProvider stays DograhVobiz (Maya path unchanged)', () => {
  const db = { phoneNumbers: [], agents: [], employees: [], workflows: [], calls: [], providerResources: [] };
  const core = {
    db: () => db,
    async mutate(fn) { fn(db); },
  };
  const provider = createDefaultTelephonyProvider(core);
  assert.ok(provider instanceof DograhVobizProvider);
  assert.equal(provider instanceof PlivoProvider, false);
  const seeded = phoneNumbers.seedPlatformInventory(db);
  assert.ok(seeded, 'seedPlatformInventory must return the platform DID row');
  assert.equal(seeded.e164, '+918065353938');
  assert.equal(seeded.provider, 'dograh_vobiz');
  assert.equal(seeded.e164, phoneNumbers.MAYA_PROTECTED_E164);
  assert.equal(db.phoneNumbers.length >= 1, true);
});

test('listTelephonyProviderStatuses returns VoBiz + Plivo without secrets', async () => {
  process.env.PLIVO_AUTH_TOKEN = 'super-secret-plivo-token-xyz';
  process.env.PLIVO_AUTH_ID = 'MAXSECRETID99';
  try {
    const payload = await listTelephonyProviderStatuses({
      plivoProvider: new PlivoProvider({ plivoClient: mockClient() }),
      telephony: { live: false },
    });
    assert.equal(payload.activeProvider, 'vobiz');
    assert.equal(payload.providers.length, 2);
    assert.equal(payload.providers[0].id, 'vobiz');
    assert.equal(payload.providers[0].label, 'VoBiz');
    assert.equal(payload.providers[1].id, 'plivo');
    assert.equal(payload.providers[1].status, 'connected');
    const text = JSON.stringify(payload);
    assert.equal(text.includes('super-secret-plivo-token-xyz'), false);
    assert.equal(text.includes('MAXSECRETID99'), false);
    assert.equal(text.includes('mock-plivo-token'), false);
    const guard = org.assertNoSecretValues(payload);
    assert.equal(guard.ok, true);
  } finally {
    delete process.env.PLIVO_AUTH_TOKEN;
    delete process.env.PLIVO_AUTH_ID;
  }
});

test('NUMBER_SEARCH NOT AVAILABLE when India inventory empty', async () => {
  const provider = new PlivoProvider({
    plivoClient: mockClient({ inventory: [] }),
  });
  const checks = await provider.validateReadOnly();
  assert.equal(checks.NUMBER_SEARCH, 'NOT AVAILABLE');
  const status = await provider.connectionStatus();
  // Auth/account still pass. Search empty is not a hard connection error.
  assert.ok(['connected', 'error'].includes(status.status));
  assert.equal(status.buyEligible, false);
});
