'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const org = require('../lib/org');

const PROVIDER_BRAND_RE = /vobiz|dograh|deepgram|rumik|groq/i;

test('publicHealthPayload has no provider brand strings', () => {
  const body = org.publicHealthPayload();
  assert.equal(body.ok, true);
  assert.equal(body.providers, undefined);
  assert.equal(body.models, undefined);
  assert.equal(body.selected, undefined);
  const blob = JSON.stringify(body);
  assert.equal(PROVIDER_BRAND_RE.test(blob), false);
});

test('detailedHealthPayload keeps provider inventory for super_admin path', () => {
  const described = {
    stt: [{ id: 'deepgram', live: true, selected: true, model: 'nova-3' }],
    tts: [{ id: 'rumik', live: true, selected: true, model: 'mulberry' }],
    llm: [{ id: 'groq', live: true, selected: true, model: 'llama' }],
    telephony: [{ id: 'vobiz', live: true, selected: true }],
  };
  const body = org.detailedHealthPayload(described);
  assert.equal(body.ok, true);
  assert.equal(body.providers.tts.rumik, true);
  assert.equal(body.selected.telephony.provider, 'vobiz');
  assert.equal(body.models.stt, 'nova-3');
  const check = org.assertNoSecretValues(body, { RUMIK_API_KEY: 'secret-rumik-key-zzzz' });
  assert.equal(check.ok, true);
});

test('unauthenticated health serializer shape never advertises brands', () => {
  // Mirrors apiHealth for anonymous / non-super_admin callers.
  const payload = org.publicHealthPayload();
  const text = JSON.stringify(payload);
  assert.match(text, /"ok":true/);
  assert.doesNotMatch(text, PROVIDER_BRAND_RE);
});
