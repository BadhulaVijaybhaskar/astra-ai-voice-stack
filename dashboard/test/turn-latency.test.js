/**
 * Browser Talk turn latency instrumentation tests (PSTN QA P0-3).
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const latency = require('../lib/turn-latency');

test('ingest marks stages and detects 9s+ slow total', () => {
  latency.clearTraces();
  const t0 = 1_000_000;
  const result = latency.ingestTurnTiming({
    session_id: 'sess_test',
    employee_id: 'emp_33eae8ef454680f0',
    source: 'browser_talk',
    stages: {
      speech_end: t0,
      stt_final: t0 + 800,
      llm_request: t0 + 850,
      llm_first_token: t0 + 4200,
      llm_complete: t0 + 6100,
      tts_request: t0 + 6150,
      tts_first_audio: t0 + 9800,
      playback_start: t0 + 10100,
    },
    stt: { provider: 'deepgram', model: 'nova-3-general', language: 'multi' },
    llm: { provider: 'groq', model: 'llama-3.3-70b-versatile' },
    tts: { provider: 'sarvam', model: 'bulbul:v3' },
  });
  assert.equal(result.ok, true);
  assert.equal(result.trace.slow, true);
  assert.equal(result.trace.total_speech_end_to_playback_ms, 10100);
  assert.ok(result.trace.bottleneck);
  assert.ok(result.trace.bottleneck.ms >= 3000);
  assert.match(latency.formatEvidenceLine(result.trace), /SLOW/);
});

test('listTraces can filter slow only', () => {
  latency.clearTraces();
  latency.ingestTurnTiming({
    stages: { speech_end: 100, playback_start: 500 },
  });
  latency.ingestTurnTiming({
    stages: { speech_end: 100, playback_start: 12000 },
  });
  const slow = latency.listTraces({ slowOnly: true });
  assert.equal(slow.length, 1);
  assert.equal(slow[0].slow, true);
});

test('STAGE_ORDER covers required Browser Talk markers', () => {
  assert.deepEqual(latency.STAGE_ORDER, [
    'speech_end',
    'stt_final',
    'llm_request',
    'llm_first_token',
    'llm_complete',
    'tts_request',
    'tts_first_audio',
    'playback_start',
  ]);
});
