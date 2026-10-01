/**
 * P0.2 Groq rate-limit fallback + safe-phrase + pre-speech LLM budget tests.
 * Does not call live Groq. Does not place PSTN.
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const https = require('https');
const llmStream = require('../lib/llm-stream');
const fast = require('../lib/voice-fast-path');

test('classifyGroqError maps 429 TPM/RPM bodies to rate_limit', () => {
  const a = llmStream.classifyGroqError(429, '{"error":{"message":"Rate limit reached for model"}}');
  assert.equal(a.category, 'rate_limit');
  assert.equal(a.rate_limited, true);
  assert.equal(a.status, 429);
  const b = llmStream.classifyGroqError(503, 'service unavailable');
  assert.equal(b.category, 'unavailable');
  assert.equal(b.retryable, true);
  const c = llmStream.classifyGroqError(400, 'bad request');
  assert.equal(c.rate_limited, false);
});

test('rateLimitAckSpeech never empty across HI/EN/TE', () => {
  for (const text of ['Haan batao', 'tell me more', 'మరిన్ని వివరాలు']) {
    const ack = llmStream.rateLimitAckSpeech(text);
    assert.ok(ack.text && ack.text.trim().length >= 12);
  }
});

test('streamGroqChat on 429 emits rate_limit then cached ack (no empty answer)', async () => {
  const original = https.request;
  let calls = 0;
  https.request = (opts, cb) => {
    calls += 1;
    const handlers = {};
    const req = {
      on(ev, fn) { handlers[ev] = fn; return req; },
      setTimeout() { return req; },
      write() { return req; },
      end() {
        const resp = {
          statusCode: 429,
          on(ev, fn) {
            if (ev === 'data') queueMicrotask(() => fn(Buffer.from('Rate limit exceeded TPM')));
            if (ev === 'end') queueMicrotask(() => fn());
            return resp;
          },
          [Symbol.asyncIterator]: async function* () {
            yield Buffer.from('Rate limit exceeded TPM');
          },
        };
        queueMicrotask(() => cb(resp));
      },
      destroy() {},
    };
    return req;
  };

  process.env.GROQ_API_KEY = process.env.GROQ_API_KEY || 'test-key-not-live';
  const events = [];
  try {
    const out = await llmStream.streamGroqChat({
      model: 'llama-3.3-70b-versatile',
      fallbackModel: 'llama-3.1-8b-instant',
      messages: [{ role: 'user', text: 'How do you qualify leads?' }],
      system: 'You are Maya.',
      onRateLimit: (ev) => events.push({ type: 'rate_limit', ...ev }),
      onFirstPhrase: (ev) => events.push({ type: 'first_phrase', ...ev }),
      timeoutMs: 2000,
    });
    assert.equal(out.rate_limited, true);
    assert.ok(out.text && out.text.length > 10, 'must not return empty answer');
    assert.ok(events.some((e) => e.type === 'rate_limit'));
    assert.ok(events.some((e) => e.type === 'first_phrase' && e.rate_limit_ack));
    assert.ok(calls >= 1);
  } finally {
    https.request = original;
  }
});

test('ordinary turn plan allows exactly one pre-speech LLM', () => {
  const plan = fast.planPreSpeechLlm('Explain how hot leads are routed.');
  assert.equal(plan.max_llm_before_first_speech, 1);
  assert.equal(plan.allowed_before_first_speech[0].role, 'main_conversational');
  assert.ok(plan.deferred_after_first_speech.some((d) => d.role === 'call_summarizer'));
});
