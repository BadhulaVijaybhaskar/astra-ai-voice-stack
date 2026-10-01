/**
 * ASR sanity guard + multilingual STT path tests (PSTN QA P0-1).
 * No live provider keys. No PSTN.
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const asr = require('../lib/asr-sanity-guard');

test('rejects known garbage failure transcript', () => {
  const r = asr.evaluateTranscript(asr.QA_FIXTURES.garbage_failure, { confidence: 0.9 });
  assert.equal(r.ok, false);
  assert.equal(r.action, 'reject');
  assert.ok(r.reasons.includes('semantic_garbage'));
});

test('accepts TE-EN hot leads phrase', () => {
  const r = asr.evaluateTranscript(asr.QA_FIXTURES.te_en_hot_leads, { confidence: 0.82 });
  assert.equal(r.ok, true);
  assert.equal(r.action, 'accept');
  assert.equal(r.is_booking_intent, false);
});

test('accepts Telugu mixed lead qualification phrase', () => {
  const r = asr.evaluateTranscript(asr.QA_FIXTURES.telugu_mixed, { confidence: 0.7 });
  assert.equal(r.ok, true);
  assert.equal(r.action, 'accept');
  assert.equal(r.has_indic_script, true);
});

test('low confidence triggers clarify, not accept', () => {
  const r = asr.evaluateTranscript('hot leads should be passed to the sales team', {
    confidence: 0.2,
  });
  assert.equal(r.ok, false);
  assert.equal(r.action, 'clarify');
  assert.ok(r.reasons.includes('low_confidence'));
});

test('Hindi booking intent detected and not treated as garbage', () => {
  const r = asr.evaluateTranscript(asr.QA_FIXTURES.hindi_booking, { confidence: 0.8 });
  assert.equal(r.action, 'accept');
  assert.equal(r.is_booking_intent, true);
  assert.equal(asr.isBookingOrScheduleIntent(asr.QA_FIXTURES.hindi_booking), true);
});

test('validated multilingual STT path is Deepgram nova-3 multi', () => {
  assert.equal(asr.VALIDATED_MULTILINGUAL_STT.provider, 'deepgram');
  assert.equal(asr.VALIDATED_MULTILINGUAL_STT.model, 'nova-3-general');
  assert.equal(asr.VALIDATED_MULTILINGUAL_STT.language, 'multi');
  const pref = asr.preferValidatedMultilingualStt({
    provider: 'deepgram',
    model: 'nova-3-general',
    language: 'multi',
  });
  assert.equal(pref.matches_validated_path, true);
});

test('buildSttTrace marks llm_input_allowed false for garbage', () => {
  const trace = asr.buildSttTrace({
    stt: asr.VALIDATED_MULTILINGUAL_STT,
    partials: ['jc hot', 'jc hot need matters'],
    final: asr.QA_FIXTURES.garbage_failure,
    confidence: 0.55,
    phrase_fixture: 'garbage_failure',
  });
  assert.equal(trace.llm_input_allowed, false);
  assert.equal(trace.guard.action, 'reject');
  assert.equal(trace.provider, 'deepgram');
});

test('clarificationPrompt returns a short ask-again line on reject', () => {
  const r = asr.evaluateTranscript(asr.QA_FIXTURES.garbage_failure);
  const line = asr.clarificationPrompt(r);
  assert.ok(/repeat|catch|again/i.test(line));
});
