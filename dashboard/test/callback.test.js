'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const callback = require('../lib/callback');

const providersPath = require.resolve('../lib/providers');
const corePath = require.resolve('../lib/core');
const originalEnv = { ...process.env };

function resetEnv(values = {}) {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv, values);
}

function loadProviders(httpsPost) {
  delete require.cache[providersPath];
  delete require.cache[corePath];
  const core = require(corePath);
  if (httpsPost) core.httpsPost = httpsPost;
  require.cache[corePath].exports = core;
  return require(providersPath);
}

test.afterEach(() => {
  resetEnv();
  delete require.cache[providersPath];
  delete require.cache[corePath];
});

test('callback secret rejects missing or wrong values without logging secrets', () => {
  assert.equal(callback.authorizeCallback('', 'real-secret').ok, false);
  assert.equal(callback.authorizeCallback('wrong', 'real-secret').status, 401);
  assert.equal(callback.authorizeCallback('real-secret', '').code, 'unauthorized');
  assert.equal(callback.authorizeCallback('real-secret', 'real-secret').ok, true);
  assert.equal(callback.secretsEqual('a', 'b'), false);
  assert.equal(callback.secretsEqual('same', 'same'), true);
});

test('callback body validates E.164 and rejects provider secrets in the payload', () => {
  assert.equal(callback.isE164('+919876543210'), true);
  assert.equal(callback.isE164('9876543210'), false);
  assert.equal(callback.isE164('+0123'), false);

  const badKey = callback.parseCallbackRequest({
    phone: '+919876543210',
    DOGRAH_API_KEY: 'should-never-work',
  });
  assert.equal(badKey.ok, false);
  assert.equal(badKey.code, 'unsafe_body');

  const missing = callback.parseCallbackRequest({});
  assert.equal(missing.code, 'missing_phone');

  const now = callback.parseCallbackRequest({ phone: '+14155552671', when: 'now', name: 'Ada' });
  assert.equal(now.ok, true);
  assert.equal(now.whenInfo.mode, 'now');
  assert.equal(now.name, 'Ada');

  const future = callback.parseCallbackRequest({
    phone: '+14155552671',
    when: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  });
  assert.equal(future.ok, true);
  assert.equal(future.whenInfo.mode, 'scheduled');
});

test('Dograh initiateCall posts E.164 through mocked fetch for callback dials', async () => {
  resetEnv({
    DOGRAH_BASE_URL: 'https://dograh.example.com',
    DOGRAH_API_KEY: 'dograh-test-key',
    DOGRAH_WORKFLOW_ID: '7',
    DOGRAH_TELEPHONY_CONFIG_ID: '3',
    DOGRAH_PHONE_NUMBER_ID: '9',
  });
  let request;
  const providers = loadProviders(async (host, path, headers, body) => {
    request = {
      host,
      path,
      headers: { ...headers, 'X-API-Key': headers['X-API-Key'] ? '[redacted]' : undefined },
      payload: JSON.parse(body.toString('utf8')),
    };
    return {
      status: 200,
      headers: {},
      buffer: Buffer.from(JSON.stringify({ call_id: 'call_abc', status: 'queued' })),
    };
  });

  const result = await providers.telephony.initiateCall('+919876543210');
  assert.equal(request.host, 'dograh.example.com');
  assert.equal(request.path, '/api/v1/telephony/initiate-call');
  assert.equal(request.payload.phone_number, '+919876543210');
  assert.equal(request.payload.workflow_id, 7);
  assert.equal(request.payload.telephony_configuration_id, 3);
  assert.equal(request.payload.from_phone_number_id, 9);
  assert.equal(request.headers['X-API-Key'], '[redacted]');
  assert.equal(result.status, 200);
  assert.equal(result.ok, true);
  assert.equal(result.providerRunId, 'call_abc');

  const summary = callback.summarizeCallResult(result.data);
  assert.equal(summary.call_id, 'call_abc');
  assert.equal(summary.status, 'queued');

  await assert.rejects(
    () => providers.telephony.initiateCall('not-a-phone'),
    (error) => error.code === 'bad_number',
  );
});

test('initiateCall honors telephonyConfigId and fromPhoneNumberId options over env', async () => {
  resetEnv({
    DOGRAH_BASE_URL: 'https://dograh.example.com',
    DOGRAH_API_KEY: 'dograh-test-key',
    DOGRAH_WORKFLOW_ID: '7',
    DOGRAH_TELEPHONY_CONFIG_ID: '3',
    DOGRAH_PHONE_NUMBER_ID: '9',
  });
  let payload;
  const providers = loadProviders(async (_host, _path, _headers, body) => {
    payload = JSON.parse(body.toString('utf8'));
    return {
      status: 200,
      headers: {},
      buffer: Buffer.from(JSON.stringify({ workflow_run_id: 'wr_99', status: 'queued' })),
    };
  });

  const result = await providers.telephony.initiateCall('+919876543210', {
    workflowId: 11,
    telephonyConfigId: 22,
    fromPhoneNumberId: 33,
  });
  assert.equal(payload.workflow_id, 11);
  assert.equal(payload.telephony_configuration_id, 22);
  assert.equal(payload.from_phone_number_id, 33);
  assert.equal(result.providerRunId, 'wr_99');
  assert.equal(result.ok, true);
  assert.equal(result.status, 200);
  assert.equal(result.data.workflow_run_id, 'wr_99');
});

test('initiateCall extracts providerRunId from nested data and skips inventing ids', async () => {
  resetEnv({
    DOGRAH_BASE_URL: 'https://dograh.example.com',
    DOGRAH_API_KEY: 'dograh-test-key',
    DOGRAH_WORKFLOW_ID: '1',
    DOGRAH_TELEPHONY_CONFIG_ID: '1',
    DOGRAH_PHONE_NUMBER_ID: '1',
  });
  const providersNested = loadProviders(async () => ({
    status: 200,
    headers: {},
    buffer: Buffer.from(JSON.stringify({ data: { telephony_call_id: 'tel_55' }, status: 'ok' })),
  }));
  const nested = await providersNested.telephony.initiateCall('+919876543210');
  assert.equal(nested.providerRunId, 'tel_55');
  assert.equal(nested.ok, true);
  assert.equal(nested.dialAccepted, true);

  delete require.cache[providersPath];
  delete require.cache[corePath];
  const providersEmpty = loadProviders(async () => ({
    status: 202,
    headers: {},
    buffer: Buffer.from(JSON.stringify({ status: 'accepted', message: 'queued' })),
  }));
  const empty = await providersEmpty.telephony.initiateCall('+919876543210');
  assert.equal(empty.providerRunId, null);
  assert.equal(empty.ok, true);
  assert.equal(empty.dialAccepted, true);
  assert.equal(empty.status, 202);
});

test('initiateCall parses WR-TEL-OUT run name when Dograh omits workflow_run_id', async () => {
  resetEnv({
    DOGRAH_BASE_URL: 'https://dograh.example.com',
    DOGRAH_API_KEY: 'dograh-test-key',
    DOGRAH_WORKFLOW_ID: '8',
    DOGRAH_TELEPHONY_CONFIG_ID: '2',
    DOGRAH_PHONE_NUMBER_ID: '3',
  });
  const providers = loadProviders(async () => ({
    status: 200,
    headers: {},
    buffer: Buffer.from(JSON.stringify({
      message: 'Call initiated successfully with run name WR-TEL-OUT-63869822',
    })),
  }));
  const result = await providers.telephony.initiateCall('+919618824700');
  assert.equal(result.ok, true);
  assert.equal(result.dialAccepted, true);
  assert.equal(result.providerRunId, null);
  assert.equal(result.providerRunName, 'WR-TEL-OUT-63869822');
  assert.equal(providers.extractProviderRunName(result.data), 'WR-TEL-OUT-63869822');
  assert.equal(providers.extractProviderRunId(result.data), null);
});

test('matchRecentWorkflowRun prefers run name then phone+time window', () => {
  resetEnv();
  const providers = loadProviders();
  const now = Date.parse('2026-09-28T10:10:24.000Z');
  const runs = [
    {
      id: 97,
      name: 'WR-TEL-OUT-OLD',
      created_at: '2026-09-28T09:00:00.000Z',
      initial_context: { phone_number: '+919618824700' },
    },
    {
      id: 99,
      name: 'WR-TEL-OUT-63869822',
      created_at: '2026-09-28T10:10:23.792Z',
      initial_context: { phone_number: '+919618824700' },
    },
  ];
  const byName = providers.matchRecentWorkflowRun(runs, {
    runName: 'WR-TEL-OUT-63869822',
    phoneE164: '+919618824700',
    nowMs: now,
  });
  assert.equal(byName.id, 99);

  const byPhone = providers.matchRecentWorkflowRun(runs, {
    phoneE164: '+919618824700',
    nowMs: now,
    sinceMs: 120000,
  });
  assert.equal(byPhone.id, 99);

  const none = providers.matchRecentWorkflowRun(runs, {
    phoneE164: '+919999999999',
    nowMs: now,
  });
  assert.equal(none, null);
});

test('listCallRuns prefers singular /api/v1/workflow/{id}/runs path', async () => {
  resetEnv({
    DOGRAH_BASE_URL: 'https://dograh.example.com',
    DOGRAH_API_KEY: 'dograh-test-key',
    DOGRAH_WORKFLOW_ID: '8',
    DOGRAH_TELEPHONY_CONFIG_ID: '2',
    DOGRAH_PHONE_NUMBER_ID: '3',
  });
  const paths = [];
  delete require.cache[providersPath];
  delete require.cache[corePath];
  const core = require(corePath);
  core.httpsPost = async () => ({ status: 500, headers: {}, buffer: Buffer.from('{}') });
  core.httpsGet = async (_host, path) => {
    paths.push(path);
    if (path.includes('/api/v1/workflow/8/runs')) {
      return {
        status: 200,
        headers: { 'content-type': 'application/json' },
        buffer: Buffer.from(JSON.stringify({
          runs: [{ id: 99, name: 'WR-TEL-OUT-63869822', initial_context: { phone_number: '+919618824700' } }],
        })),
      };
    }
    return { status: 404, headers: {}, buffer: Buffer.from('{"detail":"not found"}') };
  };
  require.cache[corePath].exports = core;
  const providers = require(providersPath);
  const listed = await providers.telephony.listCallRuns({ workflowId: 8, limit: 10 });
  assert.equal(listed.stubbed, false);
  assert.ok(listed.endpoint.includes('/api/v1/workflow/8/runs'));
  assert.equal(listed.runs[0].id, 99);
  assert.ok(paths[0].includes('/api/v1/workflow/8/runs'));
  assert.equal(paths[0].includes('/workflows/'), false);
});

test('resolveProviderRunAfterDial matches message run name against listed runs', async () => {
  resetEnv({
    DOGRAH_BASE_URL: 'https://dograh.example.com',
    DOGRAH_API_KEY: 'dograh-test-key',
    DOGRAH_WORKFLOW_ID: '8',
    DOGRAH_TELEPHONY_CONFIG_ID: '2',
    DOGRAH_PHONE_NUMBER_ID: '3',
  });
  delete require.cache[providersPath];
  delete require.cache[corePath];
  const core = require(corePath);
  core.httpsGet = async () => ({
    status: 200,
    headers: { 'content-type': 'application/json' },
    buffer: Buffer.from(JSON.stringify({
      runs: [{
        id: 99,
        name: 'WR-TEL-OUT-63869822',
        created_at: new Date().toISOString(),
        initial_context: { phone_number: '+919618824700' },
      }],
    })),
  });
  require.cache[corePath].exports = core;
  const providers = require(providersPath);
  const id = await providers.telephony.resolveProviderRunAfterDial({
    workflowId: 8,
    phoneE164: '+919618824700',
    runName: 'WR-TEL-OUT-63869822',
  });
  assert.equal(id, '99');
});

test('dial still normalizes Indian national numbers onto initiateCall', async () => {
  resetEnv({
    DOGRAH_BASE_URL: 'https://dograh.example.com',
    DOGRAH_API_KEY: 'dograh-test-key',
    DOGRAH_WORKFLOW_ID: '1',
    DOGRAH_TELEPHONY_CONFIG_ID: '1',
    DOGRAH_PHONE_NUMBER_ID: '1',
  });
  let phone;
  const providers = loadProviders(async (_host, _path, _headers, body) => {
    phone = JSON.parse(body.toString('utf8')).phone_number;
    return { status: 201, headers: {}, buffer: Buffer.from(JSON.stringify({ id: 42 })) };
  });
  const result = await providers.telephony.dial('9876543210', {});
  assert.equal(phone, '+919876543210');
  assert.equal(callback.summarizeCallResult(result.data).call_id, '42');
  assert.equal(result.providerRunId, '42');
  assert.equal(result.ok, true);
});
