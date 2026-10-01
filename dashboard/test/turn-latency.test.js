/**
 * Sub-1000ms latency instrumentation + streaming phrase + P0.2 stage_trace tests.
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const latency = require('../lib/turn-latency');
const fast = require('../lib/voice-fast-path');
const wf8 = require('../lib/wf8-node-trace');
const llmStream = require('../lib/llm-stream');
const { extractFirstSafePhrase } = require('../lib/llm-stream');

test('STAGE_ORDER includes first_safe_phrase on critical path', () => {
  assert.ok(latency.STAGE_ORDER.includes('first_safe_phrase'));
  assert.deepEqual(
    latency.CRITICAL_PATH.map((r) => r.stage),
    [
      'speech_end',
      'stt_final',
      'llm_request',
      'llm_first_token',
      'first_safe_phrase',
      'tts_request',
      'tts_first_audio',
      'playback_start',
    ],
  );
});

test('monotonic stage_trace t0-t7 derived gaps (never sum medians)', () => {
  latency.clearTraces();
  const result = latency.ingestTurnTiming({
    language_bucket: 'english',
    speech_end_wall_ms: 1_000_000,
    stage_trace: {
      t0: 0,
      t1: 200,
      t2: 220,
      t3: 450,
      t4: 520,
      t5: 540,
      t6: 900,
      t7: 920,
    },
    llm_calls_before_first_speech: 1,
  });
  const d = result.trace.derived_ms;
  assert.equal(d.STT, 200);
  assert.equal(d.orchestration, 20);
  assert.equal(d.Groq_TTFT, 230);
  assert.equal(d.phrase_accum, 70);
  assert.equal(d.TTS_TTFB, 360);
  assert.equal(d.playback_buffer, 20);
  assert.equal(d.TOTAL, 920);
  assert.equal(result.trace.first_audio_ms, 920);
  assert.equal(result.trace.meets_first_audio_target, true);
  const inv = latency.assertStageTraceInvariants(result.trace.stage_trace);
  assert.equal(inv.ok, true, inv.errors.join('; '));
  // Document: serial component sum can exceed TOTAL? No: STT+orch+TTFT+phrase+TTS+playback
  // = 200+20+230+70+360+20 = 900, plus phrase_to_tts (20) = 920 == TOTAL.
  assert.equal(
    d.STT + d.orchestration + d.Groq_TTFT + d.phrase_accum
      + (d.phrase_to_tts_request || 0) + d.TTS_TTFB + d.playback_buffer,
    d.TOTAL,
  );
});

test('medians of TTFT and TTS_TTFB must not be treated as additive to TOTAL', () => {
  latency.clearTraces();
  // Turn A: high TTFT, low TTS
  latency.ingestTurnTiming({
    turn_id: 'a',
    speech_end_wall_ms: 1_000_000,
    stage_trace: { t0: 0, t1: 100, t2: 110, t3: 900, t4: 950, t5: 960, t6: 1100, t7: 1120 },
  });
  // Turn B: low TTFT, high TTS
  latency.ingestTurnTiming({
    turn_id: 'b',
    speech_end_wall_ms: 2_000_000,
    stage_trace: { t0: 0, t1: 100, t2: 110, t3: 200, t4: 250, t5: 260, t6: 1500, t7: 1520 },
  });
  const report = latency.summarizeEvidence();
  const ttftP50 = report.STAGE_BREAKDOWN.Groq_TTFT.P50;
  const ttsP50 = report.STAGE_BREAKDOWN.TTS_TTFB.P50;
  const totalP50 = report.STAGE_BREAKDOWN.TOTAL.P50;
  assert.ok(ttftP50 != null && ttsP50 != null && totalP50 != null);
  // Classic flawed method: sum of medians looks too large vs TOTAL median.
  assert.ok(
    ttftP50 + ttsP50 !== totalP50 || true,
    'identity check placeholder',
  );
  assert.ok(
    Math.abs((ttftP50 + ttsP50) - totalP50) > 50,
    'demonstrates why summing medians is wrong vs TOTAL P50',
  );
  assert.match(report.STAGE_BREAKDOWN._warning, /Do NOT sum/);
  assert.equal(report.measurement.never_sum_medians, true);
});

test('booking ack tool path marks first_audio target 1200 and 0 LLM before speech', () => {
  latency.clearTraces();
  const t0 = 5_000_000;
  const result = latency.ingestTurnTiming({
    language_bucket: 'hindi_booking',
    booking_ack: true,
    tool_assisted: true,
    llm_calls_before_first_speech: 0,
    stages: {
      speech_end: t0,
      stt_final: t0 + 180,
      first_safe_phrase: t0 + 200,
      tool_start: t0 + 200,
      tts_request: t0 + 220,
      tts_first_audio: t0 + 950,
      playback_start: t0 + 970,
      tool_complete: t0 + 3500,
      response_complete: t0 + 6000,
    },
  });
  assert.equal(result.trace.first_audio_ms, 970);
  assert.equal(result.trace.meets_tool_first_audio_target, true);
  assert.equal(result.trace.llm_calls_before_first_speech, 0);
  assert.equal(result.trace.multi_llm_before_first_speech, false);
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

test('safe-phrase flush rejects unnatural short fragments', () => {
  assert.equal(extractFirstSafePhrase('Yes.'), null);
  assert.equal(extractFirstSafePhrase('Ok.'), null);
  const ok = extractFirstSafePhrase('Haan, bilkul. Demo book karte hain right away for you.');
  assert.ok(ok);
});

test('classifyTurnPath booking speaks ack and does not block tools on first audio', () => {
  const path = fast.classifyTurnPath('Okay, demo schedule kar sakte ho?');
  assert.equal(path.path, 'tool');
  assert.equal(path.tools_block_first_audio, false);
  assert.ok(path.ack.text.includes('Demo') || path.ack.text.includes('book'));
  assert.equal(path.first_audio_target_ms, 1200);
  assert.equal(path.max_llm_before_first_speech, 0);
});

test('no multi-LLM-before-first-speech for ordinary and booking paths', () => {
  const ordinary = fast.planPreSpeechLlm('How does Astra Voice qualify leads?');
  assert.equal(ordinary.max_llm_before_first_speech, 1);
  assert.equal(ordinary.allowed_before_first_speech.length, 1);
  assert.ok(ordinary.deferred_after_first_speech.length >= 3);
  const gate = fast.assertSingleLlmBeforeFirstSpeech(1, ordinary);
  assert.equal(gate.ok, true);
  const tooMany = fast.assertSingleLlmBeforeFirstSpeech(3, ordinary);
  assert.equal(tooMany.ok, false);
  assert.equal(tooMany.multi_llm_before_first_speech, true);

  const booking = fast.planPreSpeechLlm('demo schedule kar sakte ho?');
  assert.equal(booking.max_llm_before_first_speech, 0);
  assert.equal(booking.allowed_before_first_speech.length, 0);
  assert.equal(fast.assertSingleLlmBeforeFirstSpeech(0, booking).ok, true);
  assert.equal(fast.assertSingleLlmBeforeFirstSpeech(1, booking).ok, false);
});

test('HI vs ordinary architecture diff exposes ack-first pattern without booking shortcuts', () => {
  const diff = fast.hiVsOrdinaryArchitectureDiff();
  assert.equal(diff.hindi_booking_ack.llm_before_first_speech, 0);
  assert.equal(diff.ordinary_en_te_mixed.llm_before_first_speech, 1);
  assert.ok(diff.do_not_copy.some((s) => /hard-code booking ack/i.test(s)));
  assert.ok(diff.architecture_to_copy.some((s) => /Defer secondary LLMs/i.test(s)));
});

test('Groq rate-limit classifier and cached ack path', () => {
  const c = llmStream.classifyGroqError(429, 'Rate limit exceeded: TPM');
  assert.equal(c.rate_limited, true);
  assert.equal(c.category, 'rate_limit');
  assert.equal(c.retryable, true);
  const ack = llmStream.rateLimitAckSpeech('Haan batao');
  assert.ok(ack.text.length > 10);
  assert.ok(/Haan|second|detail/i.test(ack.text));
});

test('WF8 node trace marks End Call NO and Booking ACK_ONLY + pre-speech budget', () => {
  const trace = wf8.buildWf8NodeTrace();
  const end = trace.nodes.find((n) => n.type === 'endCall');
  const book = trace.nodes.find((n) => /book/i.test(n.name));
  assert.equal(end.required_for_first_response, 'NO');
  assert.equal(book.required_for_first_response, 'ACK_ONLY');
  assert.equal(trace.dograh_workflow_id, '8');
  assert.equal(trace.pre_speech_llm_budget.max_llm_before_first_speech, 1);
  assert.equal(trace.pre_speech_llm_budget.booking_ack_llm_before_first_speech, 0);
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

test('summarizeEvidence exposes FIRST AUDIO P50/P90/P95 separate from TOTAL + STAGE_BREAKDOWN', () => {
  latency.clearTraces();
  for (let i = 0; i < 5; i++) {
    latency.ingestTurnTiming({
      language_bucket: i % 2 ? 'mixed' : 'english',
      speech_end_wall_ms: 10_000_000 + i * 100000,
      stage_trace: {
        t0: 0,
        t1: 180,
        t2: 200,
        t3: 450,
        t4: 520,
        t5: 540,
        t6: 900 + i * 20,
        t7: 920 + i * 20,
      },
      stages: {
        response_complete: 10_000_000 + i * 100000 + 5000 + i * 100,
      },
      quality: {
        ANSWER_COMPLETENESS: 'PASS',
        NATURAL_PACING: 'PASS',
        CUSTOMER_NOT_RUSHED: 'PASS',
        DEMO_PUSH_REDUCED: 'PASS',
      },
      llm_calls_before_first_speech: 1,
    });
  }
  const report = latency.summarizeEvidence();
  assert.ok(report.FIRST_AUDIO.P50 != null);
  assert.ok(report.TOTAL_RESPONSE_DURATION.P50 != null);
  assert.ok(report.TOTAL_RESPONSE_DURATION.P50 > report.FIRST_AUDIO.P50);
  assert.ok(report.STAGE_BREAKDOWN.Groq_TTFT.P50 != null);
  assert.ok(report.STAGE_BREAKDOWN.TTS_TTFB.P50 != null);
  assert.equal(report.ANSWER_COMPLETENESS, 'PASS');
  assert.equal(report.CUSTOMER_NOT_RUSHED, 'PASS');
  assert.equal(report.MULTI_LLM_BEFORE_FIRST_SPEECH.fail_count, 0);
});
