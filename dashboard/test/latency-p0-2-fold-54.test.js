/**
 * #54→#55 fold + platform barge-in smoke tests.
 * No live providers. No PSTN.
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const fast = require('../lib/voice-fast-path');
const barge = require('../lib/voice-barge-in');
const maya = require('../lib/maya-conversation-policy');
const wf8 = require('../lib/wf8-node-trace');

test('fold: GLOBAL_PROMPT_HOT exported and used in Maya graph', () => {
  assert.ok(maya.GLOBAL_PROMPT_HOT && /WHO YOU ARE/.test(maya.GLOBAL_PROMPT_HOT));
  assert.ok(/FIRST AUDIO/.test(maya.GLOBAL_PROMPT_HOT));
  const g = maya.buildMayaWorkflowGraph();
  const global = g.nodes.find((n) => n.type === 'globalNode');
  assert.equal(global.data.prompt, maya.GLOBAL_PROMPT_HOT);
  assert.ok(g.meta && g.meta.pre_speech_policy);
});

test('fold: prefer_local_policy on all Maya workflow edges', () => {
  const g = maya.buildMayaWorkflowGraph();
  assert.ok(g.edges.length >= 4);
  for (const e of g.edges) {
    assert.equal(e.data.prefer_local_policy, true, e.id);
  }
  const wfPath = path.join(__dirname, '..', '..', 'workflows', 'maya-receptionist.json');
  const wf = JSON.parse(fs.readFileSync(wfPath, 'utf8'));
  for (const e of wf.edges || []) {
    assert.equal(!!(e.data && e.data.prefer_local_policy), true, e.id);
  }
});

test('fold: Sarvam TOKEN aggregation + min_buffer_size≥50 in overlay', () => {
  const factory = fs.readFileSync(
    path.join(__dirname, '..', '..', 'rumik-overlay-local', 'service_factory.py'),
    'utf8'
  );
  assert.ok(/TextAggregationMode\.TOKEN/.test(factory));
  assert.ok(/silence_time_s\s*=\s*0\.2/.test(factory));
  // Sarvam rejects min_buffer_size < 50 (HTTP 422) → TTS WS dead → PSTN silence
  assert.ok(/max\(50,\s*int\(min_buf\)\)|else 50/.test(factory));
  assert.ok(/def create_llm_service\(/.test(factory));
  assert.ok(/return create_llm_service_with_model_override\(/.test(factory));
  const registry = fs.readFileSync(
    path.join(__dirname, '..', '..', 'rumik-overlay-local', 'registry.py'),
    'utf8'
  );
  assert.ok(/min_buffer_size:\s*int\s*=\s*Field\(\s*default=50/.test(registry));
});

test('keep #55: planPreSpeechLlm + planFirstAudio employee-agnostic', () => {
  const a = fast.planPreSpeechLlm('Explain pricing.');
  assert.equal(a.max_llm_before_first_speech, 1);
  const book = fast.planPreSpeechLlm('demo schedule kar sakte ho?');
  assert.equal(book.max_llm_before_first_speech, 0);
  const first = fast.planFirstAudio('Hello');
  assert.equal(first.platform, 'shared_realtime_path');
  const sys = fast.buildFirstResponseSystem({ employeeCore: 'You are Emp A.' });
  assert.ok(/Emp A/.test(sys.system));
  const sys2 = fast.buildFirstResponseSystem({ employeeCore: 'You are Emp B.' });
  assert.ok(/Emp B/.test(sys2.system));
});

test('platform barge-in: playback_stop budget + spoken_text-only interrupt', () => {
  assert.equal(barge.evaluatePlaybackStop(150).status, 'PASS');
  assert.equal(barge.evaluatePlaybackStop(250).status, 'OK');
  assert.equal(barge.evaluatePlaybackStop(400).status, 'MISS');
  const ctx = barge.buildInterruptContext({
    spoken_text: 'Yes, I can help with',
    unspoken_draft: 'a full demo schedule tomorrow at three.',
  });
  assert.equal(ctx.spoken_text, 'Yes, I can help with');
  assert.equal(ctx.unspoken_text, null);
  const plan = barge.planBargeIn({
    spoken_text: 'Hello',
    playback_stop_ms: 180,
    in_flight_tools: [{ name: 'calcom_book' }],
  });
  assert.equal(plan.employee_agnostic, true);
  assert.equal(plan.tool_safety.cancel_new_tools, true);
  assert.equal(plan.tool_safety.in_flight_tools[0].idempotent_required, true);
});

test('wf8 trace keeps pre_speech_llm_budget after #54 fold', () => {
  const trace = wf8.buildWf8NodeTrace();
  assert.equal(trace.pre_speech_llm_budget.max_llm_before_first_speech, 1);
  assert.equal(trace.pre_speech_llm_budget.booking_ack_llm_before_first_speech, 0);
  assert.ok(trace.pre_speech_policy);
  assert.ok(trace.edges.every((e) => e.prefer_local_policy === true));
});
