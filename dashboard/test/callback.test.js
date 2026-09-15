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

  const summary = callback.summarizeCallResult(result.data);
  assert.equal(summary.call_id, 'call_abc');
  assert.equal(summary.status, 'queued');

  await assert.rejects(
    () => providers.telephony.initiateCall('not-a-phone'),
    (error) => error.code === 'bad_number',
  );
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
});
