/**
 * LATENCY P0.2 — Groq rate-limit fallback + first-audio plan + overlay guards.
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const llmStream = require('../lib/llm-stream');
const fast = require('../lib/voice-fast-path');
const maya = require('../lib/maya-conversation-policy');
const wf8 = require('../lib/wf8-node-trace');

test('Groq RL: exact status 429 + code rate_limit_exceeded + type tokens|requests', () => {
  const body = JSON.stringify({
    error: {
      message: 'Rate limit reached for model llama-3.3-70b-versatile on tokens per minute (TPM)',
      type: 'tokens',
      code: 'rate_limit_exceeded',
    },
  });
  const classified = llmStream.classifyGroqUpstreamError(429, body, { 'retry-after': '1' });
  assert.equal(classified.kind, 'rate_limit');
  assert.equal(classified.http_status, 429);
  assert.equal(classified.error_code, 'rate_limit_exceeded');
  assert.equal(classified.error_type, 'tokens');
  assert.equal(classified.error_category, 'groq_rate_limit');
  assert.equal(classified.retry_after_s, 1);

  const reqBody = JSON.stringify({
    error: { message: 'RPM limit', type: 'requests', code: 'rate_limit_exceeded' },
  });
  const c2 = llmStream.classifyGroqUpstreamError(429, reqBody, {});
  assert.equal(c2.error_type, 'requests');
  assert.equal(c2.error_code, 'rate_limit_exceeded');
});

test('Groq RL fallback never empty and emits first phrase', () => {
  let phrase = null;
  const fb = llmStream.buildRateLimitFallback(
    {
      model: 'llama-3.3-70b-versatile',
      onFirstPhrase: (ev) => { phrase = ev.phrase; },
    },
    {
      http_status: 429,
      error_code: 'rate_limit_exceeded',
      error_type: 'tokens',
      error_category: 'groq_rate_limit',
      retry_after_s: 7,
    },
  );
  assert.ok(fb.text && fb.text.length > 10);
  assert.ok(fb.first_phrase && fb.first_phrase.length > 5);
  assert.equal(fb.finish, 'rate_limit_fallback');
  assert.equal(fb.rate_limited, true);
  assert.equal(phrase, llmStream.RATE_LIMIT_FALLBACK_PHRASE);
  assert.equal(llmStream.GROQ_RL_STATUS, 429);
  assert.equal(llmStream.GROQ_RL_CODE, 'rate_limit_exceeded');
  assert.equal(llmStream.GROQ_RL_MAX_ATTEMPTS, 2);
  assert.equal(llmStream.GROQ_RL_MAX_RETRY_AFTER_S, 2);
});

test('planFirstAudio generalizes ack-before-LLM architecture without language latency branches', () => {
  const hi = fast.planFirstAudio('Okay, demo schedule kar sakte ho?');
  assert.equal(hi.emit_before_llm, true);
  assert.equal(hi.architecture, 'ack_before_llm_then_stream');
  assert.equal(hi.wait_for_tools, false);
  assert.equal(hi.wait_for_llm_complete, false);

  const en = fast.planFirstAudio('Can Astra Voice qualify inbound leads for my team?');
  assert.equal(en.path, 'fast');
  assert.equal(en.emit_before_llm, false);
  assert.equal(en.architecture, 'stream_first_safe_phrase');
  assert.equal(en.stream_tts_on_first_phrase, true);
  assert.equal(en.wait_for_llm_complete, false);
  assert.deepEqual(en.phrase_opts, fast.ORDINARY_PHRASE_OPTS);

  const te = fast.planFirstAudio('మీరు ఏమి చేస్తారు?');
  assert.equal(te.path, 'fast');
  assert.equal(te.architecture, 'stream_first_safe_phrase');
  assert.deepEqual(te.phrase_opts, fast.ORDINARY_PHRASE_OPTS);
});

test('ordinary first-phrase opts flush earlier than legacy 24/4 defaults', () => {
  const buf = 'Yes. Astra Voice helps.';
  const phrase = fast.extractFirstSafePhrase(buf, fast.ORDINARY_PHRASE_OPTS);
  assert.ok(phrase);
  assert.match(phrase, /Yes\./);
});

test('WF8 pre-speech Groq hops are marked deferred', () => {
  const trace = wf8.buildWf8NodeTrace();
  assert.ok(Array.isArray(trace.deferred_pre_speech_groq_hops));
  const hops = Object.fromEntries(trace.deferred_pre_speech_groq_hops.map((h) => [h.hop, h]));
  assert.equal(hops.edge_router_llm.defer, true);
  assert.equal(hops.language_classifier_llm.defer, true);
  assert.equal(hops.summarizer_llm.defer, true);
  assert.equal(hops.calcom_tools.defer, true);
  assert.ok(trace.pre_speech_policy);
  assert.equal(trace.tts.voice_id, 'priya');
  assert.equal(trace.tts.model, 'bulbul:v3');
  // Hot global should be smaller than the full GLOBAL_PROMPT.
  assert.ok(maya.GLOBAL_PROMPT_HOT.length < maya.GLOBAL_PROMPT.length);
  const g = maya.buildMayaWorkflowGraph();
  assert.equal(g.nodes[0].data.prompt, maya.GLOBAL_PROMPT_HOT);
  assert.ok(g.meta.pre_speech_policy.defer_edge_router_llm_before_first_audio);
});

test('overlay guards: create_llm_service_with_model_override + Sarvam TOKEN aggregation', () => {
  const factoryPath = path.join(__dirname, '../../rumik-overlay-local/service_factory.py');
  const src = fs.readFileSync(factoryPath, 'utf8');
  assert.match(src, /def create_llm_service_with_model_override\(/);
  assert.match(src, /create_llm_service_from_provider\(/);
  assert.match(src, /TextAggregationMode\.TOKEN|aggregate_sentences\s*=\s*False/);
  assert.match(src, /silence_time_s["']?\s*:\s*0\.2|silence_time_s=0\.2/);
  assert.match(src, /min_buffer_size/);
  // create_llm_service must delegate to model-override helper (no duplicate break).
  assert.match(src, /return create_llm_service_with_model_override\(/);

  const wf = JSON.parse(fs.readFileSync(path.join(__dirname, '../../workflows/maya-receptionist.json'), 'utf8'));
  assert.equal(wf.meta.tts.voice_id, 'priya');
  assert.equal(wf.meta.tts.model, 'bulbul:v3');
  assert.equal(wf.meta.dograh_workflow_id, '8');
});
