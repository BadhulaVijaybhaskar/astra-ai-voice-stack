'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const browserTalkTts = require('../lib/browser-talk-tts');

test('Browser Talk mint remaps dead Rumik mulberry onto bulbul:v3 / priya', () => {
  const sel = browserTalkTts.resolveMintSelection({ model: 'mulberry' });
  assert.equal(sel.provider, 'sarvam');
  assert.equal(sel.model, 'bulbul:v3');
  assert.equal(sel.speaker, 'priya');
  assert.equal(sel.mode, 'http_stream');
  assert.ok(sel.remapped_from);

  const mint = browserTalkTts.buildCustomerMintPayload(sel);
  const check = browserTalkTts.assertMintMapsToPriya(mint);
  assert.equal(check.ok, true, JSON.stringify(check));
  assert.equal(mint.ws_url, null);
  assert.equal(mint.stream_path, '/api/tts/stream');
  assert.equal(JSON.stringify(mint).includes('rumik'), false);
});

test('explicit Sarvam bulbul keeps priya when speaker blank or Rumik speaker_*', () => {
  const a = browserTalkTts.resolveMintSelection({
    provider: 'sarvam', model: 'bulbul:v3', speaker: 'speaker_1',
  });
  assert.equal(a.speaker, 'priya');
  assert.equal(a.model, 'bulbul:v3');

  const b = browserTalkTts.resolveMintSelection({
    provider: 'sarvam', model: 'bulbul:v3', speaker: 'priya',
  });
  assert.equal(b.speaker, 'priya');
  assert.equal(browserTalkTts.assertMintMapsToPriya(
    browserTalkTts.buildCustomerMintPayload(b),
  ).ok, true);
});
