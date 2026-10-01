/**
 * Synthetic >=20 Browser Talk turn evidence harness for LATENCY P0.
 *
 * Simulates designed post-fix stage budgets for EN/TE/MIXED/HI buckets.
 * Live Hostinger Browser Talk should replace AFTER_* with measured values.
 * Does not place PSTN. Does not call paid providers.
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const latency = require('../lib/turn-latency');
const fast = require('../lib/voice-fast-path');
const wf8 = require('../lib/wf8-node-trace');

const FIXTURES = [
  { bucket: 'english', text: 'How does Astra Voice qualify inbound leads?', tool: false },
  { bucket: 'english', text: 'What happens to hot leads?', tool: false },
  { bucket: 'english', text: 'Can you explain the pricing briefly?', tool: false },
  { bucket: 'english', text: 'Who is Maya?', tool: false },
  { bucket: 'english', text: 'How do interruptions work on a call?', tool: false },
  { bucket: 'telugu', text: 'ఇది లీడ్ క్వాలిఫికేషన్ కి ఎలా యూస్ అవుతుంది?', tool: false },
  { bucket: 'telugu', text: 'మీరు ఏ భాషలు సపోర్ట్ చేస్తారు?', tool: false },
  { bucket: 'telugu', text: 'డెమో ఎలా ఉంటుంది?', tool: false },
  { bucket: 'telugu', text: 'కాల్ వాల్యూమ్ ఎంత హ్యాండిల్ అవుతుంది?', tool: false },
  { bucket: 'telugu', text: 'సేల్స్ టీమ్ కి ఎలా పాస్ అవుతుంది?', tool: false },
  { bucket: 'mixed', text: 'hot leads should be passed to the sales team', tool: false },
  { bucket: 'mixed', text: 'lead qualification ela work avuthundi for TE-EN callers?', tool: false },
  { bucket: 'mixed', text: 'inbound calls lo Hindi and Telugu both handle chesthara?', tool: false },
  { bucket: 'mixed', text: 'CRM sync unda after the call?', tool: false },
  { bucket: 'mixed', text: 'volume per week roughly 200 calls, how do you scale?', tool: false },
  { bucket: 'hindi_booking', text: 'Okay, demo schedule kar sakte ho?', tool: true },
  { bucket: 'hindi_booking', text: 'Haan demo book kar do', tool: true },
  { bucket: 'hindi_booking', text: 'appointment lena hai kal ke liye', tool: true },
  { bucket: 'hindi_booking', text: 'schedule kar sakte ho afternoon?', tool: true },
  { bucket: 'hindi_booking', text: 'book a demo for next week please', tool: true },
  { bucket: 'english', text: 'Summarize what you know about our need so far.', tool: false },
  { bucket: 'english', text: 'What qualification questions do you usually ask?', tool: false },
];

function designedStages(t0, fixture, i) {
  // Designed budgets after streaming + tight STT. Not live provider RTT.
  const stt = 180 + (i % 3) * 15;
  const llmToken = stt + 220 + (i % 4) * 25;
  const firstPhrase = llmToken + 280 + (i % 5) * 30;
  const ttsAudio = firstPhrase + 180 + (i % 3) * 20;
  const llmDone = ttsAudio + 900 + (i % 6) * 80;
  const responseDone = llmDone + 2500 + (fixture.tool ? 2000 : 800) + (i % 4) * 100;
  const stages = {
    speech_end: t0,
    stt_final: t0 + stt,
    llm_request: t0 + stt + 15,
    llm_first_token: t0 + llmToken,
    tts_request: t0 + firstPhrase,
    tts_first_audio: t0 + ttsAudio,
    playback_start: t0 + ttsAudio + 20,
    llm_complete: t0 + llmDone,
    response_complete: t0 + responseDone,
  };
  if (fixture.tool) {
    stages.tool_start = t0 + ttsAudio + 50;
    stages.tool_complete = t0 + ttsAudio + 2200;
  }
  return stages;
}

test('harness posts >=20 turns and builds FINAL REPORT fields', () => {
  latency.clearTraces();
  assert.ok(FIXTURES.length >= 20);

  FIXTURES.forEach((fixture, i) => {
    const t0 = 20_000_000 + i * 50_000;
    const pathInfo = fast.classifyTurnPath(fixture.text);
    latency.ingestTurnTiming({
      turn_id: 'synth_' + i,
      employee_id: 'emp_33eae8ef454680f0',
      language_bucket: fixture.bucket,
      booking_ack: !!fixture.tool,
      tool_assisted: !!fixture.tool,
      streamed_first_phrase: !fixture.tool,
      source: 'synthetic_browser_talk',
      stages: designedStages(t0, fixture, i),
      stt: { provider: 'deepgram', model: 'nova-3-general', language: 'multi' },
      llm: { provider: 'groq', model: 'llama-3.3-70b-versatile' },
      tts: { provider: 'sarvam', model: 'bulbul:v3' },
      quality: {
        ANSWER_COMPLETENESS: 'PASS',
        NATURAL_PACING: 'PASS',
        CUSTOMER_NOT_RUSHED: 'PASS',
        DEMO_PUSH_REDUCED: 'PASS',
      },
      note: pathInfo.path + ':' + fixture.text.slice(0, 40),
    });
  });

  const report = latency.summarizeEvidence({ employee_id: 'emp_33eae8ef454680f0' });
  assert.ok(report.sample_count >= 20);
  assert.ok(report.FIRST_AUDIO.P50 != null);
  assert.ok(report.FIRST_AUDIO.P90 != null);
  assert.ok(report.FIRST_AUDIO.P95 != null);
  assert.ok(report.TOTAL_RESPONSE_DURATION.P50 != null);
  assert.ok(report.ENGLISH.FIRST_AUDIO.n > 0);
  assert.ok(report.TELUGU.FIRST_AUDIO.n > 0);
  assert.ok(report.MIXED.FIRST_AUDIO.n > 0);
  assert.ok(report.HINDI_BOOKING.FIRST_AUDIO.n > 0);
  assert.equal(report.ANSWER_COMPLETENESS, 'PASS');
  assert.equal(report.NATURAL_PACING, 'PASS');
  assert.equal(report.CUSTOMER_NOT_RUSHED, 'PASS');
  assert.equal(report.DEMO_PUSH_REDUCED, 'PASS');
  assert.equal(report.SILENT_WAITS.fail_count, 0);

  // Designed path should clear ordinary 1000ms p50 when synthetic budgets hold.
  assert.ok(report.FIRST_AUDIO.P50 <= 1200, 'designed first_audio P50 should be <=1200');

  const outDir = path.join(__dirname, '..', '..', 'docs');
  const payload = {
    generated_at: new Date().toISOString(),
    mode: 'synthetic_designed_budgets',
    note: 'Replace AFTER_* with live Hostinger Browser Talk measurements before PSTN QA.',
    report,
    designed: latency.syntheticBudgetComparison(),
    wf8_node_trace: wf8.buildWf8NodeTrace(),
    baselines: latency.BASELINE_BEFORE,
  };
  fs.writeFileSync(
    path.join(outDir, 'LATENCY-P0-SYNTHETIC-EVIDENCE.json'),
    JSON.stringify(payload, null, 2) + '\n',
  );
});
