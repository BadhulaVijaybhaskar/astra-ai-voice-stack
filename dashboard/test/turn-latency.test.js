/**
 * Sub-1000ms latency instrumentation + streaming phrase tests.
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const latency = require('../lib/turn-latency');
const fast = require('../lib/voice-fast-path');
const wf8 = require('../lib/wf8-node-trace');
const { extractFirstSafePhrase } = require('../lib/llm-stream');

test('STAGE_ORDER includes tools and response_complete', () => {
  assert.deepEqual(latency.STAGE_ORDER, [
    'speech_end',
    'stt_final',
    'llm_request',
    'llm_first_token',
    'llm_complete',
    'tool_start',
    'tool_complete',
    'tts_request',
    'tts_first_audio',
    'playback_start',
    'response_complete',
  ]);
});

test('first_audio absolute durations and hard-fail >2500', () => {
  latency.clearTraces();
  const t0 = 1_000_000;
  const result = latency.ingestTurnTiming({
    language_bucket: 'english',
    stages: {
      speech_end: t0,
      stt_final: t0 + 200,
      llm_request: t0 + 220,
      llm_first_token: t0 + 450,
      tts_request: t0 + 500,
      tts_first_audio: t0 + 900,
      playback_start: t0 + 920,
      llm_complete: t0 + 1800,
      response_complete: t0 + 4200,
    },
  });
  assert.equal(result.trace.first_audio_ms, 900);
  assert.equal(result.trace.absolute_ms.tts_first_audio, 900);
  assert.equal(result.trace.total_response_duration_ms, 4200);
  assert.equal(result.trace.meets_first_audio_target, true);
  assert.equal(result.trace.first_audio_hard_fail, false);
  assert.equal(result.trace.silent_wait_fail, false);
});

test('booking ack tool path marks first_audio target 1200', () => {
  latency.clearTraces();
  const t0 = 5_000_000;
  const result = latency.ingestTurnTiming({
    language_bucket: 'hindi_booking',
    booking_ack: true,
    tool_assisted: true,
    stages: {
      speech_end: t0,
      stt_final: t0 + 180,
      tool_start: t0 + 200,
      tts_request: t0 + 220,
      tts_first_audio: t0 + 950,
      playback_start: t0 + 970,
      tool_complete: t0 + 3500,
      response_complete: t0 + 6000,
    },
  });
  assert.equal(result.trace.first_audio_ms, 950);
  assert.equal(result.trace.meets_tool_first_audio_target, true);
  assert.ok(result.trace.total_response_duration_ms > result.trace.first_audio_ms);
});

test('extractFirstSafePhrase finds natural opening without truncating later text', () => {
  const buf = 'Yes. Astra Voice can qualify inbound leads. It also routes hot ones to sales while you keep talking about volume and timeline.';
  const phrase = extractFirstSafePhrase(buf);
  assert.ok(phrase);
  assert.match(phrase, /Yes\./);
  assert.ok(buf.length > phrase.length, 'full answer must remain longer than first phrase');
  assert.ok(buf.startsWith(phrase) || buf.indexOf(phrase.slice(0, 10)) === 0);
});

test('classifyTurnPath booking speaks ack and does not block tools on first audio', () => {
  const path = fast.classifyTurnPath('Okay, demo schedule kar sakte ho?');
  assert.equal(path.path, 'tool');
  assert.equal(path.tools_block_first_audio, false);
  assert.ok(path.ack.text.includes('Demo') || path.ack.text.includes('book'));
  assert.equal(path.first_audio_target_ms, 1200);
});

test('WF8 node trace marks End Call NO and Booking ACK_ONLY', () => {
  const trace = wf8.buildWf8NodeTrace();
  const end = trace.nodes.find((n) => n.type === 'endCall');
  const book = trace.nodes.find((n) => /book/i.test(n.name));
  assert.equal(end.required_for_first_response, 'NO');
  assert.equal(book.required_for_first_response, 'ACK_ONLY');
  assert.equal(trace.dograh_workflow_id, '8');
});

test('prompt audit and static cache', () => {
  fast.clearStaticCache();
  const a = fast.getCachedStatic('maya', () => 'hello-policy');
  const b = fast.getCachedStatic('maya', () => 'hello-policy');
  assert.equal(a.cache_hit, false);
  assert.equal(b.cache_hit, true);
  const audit = fast.auditPromptTokens({
    global: 'x'.repeat(400),
    deferred: 'y'.repeat(8000),
    __required: { global: true, deferred: false },
  });
  assert.ok(audit.approx_tokens > 0);
});

test('summarizeEvidence exposes FIRST AUDIO P50/P90/P95 separate from TOTAL', () => {
  latency.clearTraces();
  for (let i = 0; i < 5; i++) {
    const t0 = 10_000_000 + i * 100000;
    latency.ingestTurnTiming({
      language_bucket: i % 2 ? 'mixed' : 'english',
      quality: {
        ANSWER_COMPLETENESS: 'PASS',
        NATURAL_PACING: 'PASS',
        CUSTOMER_NOT_RUSHED: 'PASS',
        DEMO_PUSH_REDUCED: 'PASS',
      },
      stages: {
        speech_end: t0,
        tts_first_audio: t0 + 900 + i * 20,
        playback_start: t0 + 920 + i * 20,
        response_complete: t0 + 5000 + i * 100,
      },
    });
  }
  const report = latency.summarizeEvidence();
  assert.ok(report.FIRST_AUDIO.P50 != null);
  assert.ok(report.TOTAL_RESPONSE_DURATION.P50 != null);
  assert.ok(report.TOTAL_RESPONSE_DURATION.P50 > report.FIRST_AUDIO.P50);
  assert.equal(report.ANSWER_COMPLETENESS, 'PASS');
  assert.equal(report.CUSTOMER_NOT_RUSHED, 'PASS');
});
