/**
 * Astra Voice. Groq streaming + first-safe-phrase flush for sub-1000ms first audio.
 *
 * NEVER wait for llm_complete before starting TTS. Emit the first safe natural
 * phrase as soon as it is ready; the rest of the answer continues concurrently.
 *
 * Latency != shorter answers. max_completion_tokens stays ample for detailed
 * explanations. Adaptive length is a prompt concern, not a token cap.
 *
 * Groq rate-limit (exact):
 *   HTTP status: 429
 *   Body: { error: { message, type: "tokens"|"requests", code: "rate_limit_exceeded" } }
 *   Headers: retry-after (seconds), x-ratelimit-*
 * Bounded fallback: at most one short wait when retry-after <= 2s, else speak a
 * brief bridge immediately. Never empty / silent answers. No retry storms.
 *
 * No em dashes. Commas and periods only.
 */
'use strict';

const https = require('https');
const { extractFirstSafePhrase } = require('./turn-latency');

const GROQ_HOST = 'api.groq.com';
const GROQ_RL_STATUS = 429;
const GROQ_RL_CODE = 'rate_limit_exceeded';
const GROQ_RL_TYPES = Object.freeze(['tokens', 'requests', 'rate_limit']);
const GROQ_RL_MAX_RETRY_AFTER_S = 2;
const GROQ_RL_MAX_ATTEMPTS = 2; // initial + one bounded retry

const RATE_LIMIT_FALLBACK_PHRASE = 'One moment. I am still with you.';
const RATE_LIMIT_FALLBACK_TEXT =
  'One moment. I am still with you. Please say that again, or I can continue from where we left off.';

function buildMessages(opts) {
  const history = Array.isArray(opts.messages) ? opts.messages.slice(-12) : [];
  const system = String(opts.system || '').slice(0, 3500);
  const messages = [{ role: 'system', content: system || 'You are a warm voice assistant.' }]
    .concat(history.filter((m) => m && (m.text || m.content)).map((m) => ({
      role: (m.role === 'assistant' || m.role === 'model') ? 'assistant' : 'user',
      content: String(m.text || m.content || '').slice(0, 1500),
    })));
  return messages;
}

/**
 * Parse Groq OpenAI-compatible error body.
 * Rate limit shape:
 *   { error: { message: "...", type: "tokens"|"requests", code: "rate_limit_exceeded" } }
 */
function parseGroqErrorBody(raw) {
  const text = String(raw || '');
  let data = null;
  try { data = JSON.parse(text); } catch { data = null; }
  const err = (data && data.error && typeof data.error === 'object') ? data.error : {};
  const code = err.code != null ? String(err.code) : null;
  const type = err.type != null ? String(err.type) : null;
  const message = String(err.message || text || 'groq upstream error').slice(0, 300);
  return { message, type, code, raw: text.slice(0, 300) };
}

function isGroqRateLimit(status, parsed) {
  if (Number(status) === GROQ_RL_STATUS) return true;
  if (parsed && parsed.code === GROQ_RL_CODE) return true;
  if (parsed && GROQ_RL_TYPES.includes(String(parsed.type || ''))) return true;
  return false;
}

function readRetryAfterSeconds(headers) {
  if (!headers) return null;
  const raw = headers['retry-after'] || headers['Retry-After'];
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function rateLimitMeta(status, parsed, headers) {
  return {
    http_status: Number(status) || GROQ_RL_STATUS,
    error_code: (parsed && parsed.code) || GROQ_RL_CODE,
    error_type: (parsed && parsed.type) || null,
    error_category: 'groq_rate_limit',
    retry_after_s: readRetryAfterSeconds(headers),
    message: (parsed && parsed.message) || 'Rate limit exceeded',
  };
}

/**
 * Bounded spoken fallback. Never empty. Prefer brief ack + continue.
 */
function buildRateLimitFallback(opts, rlMeta) {
  const phrase = RATE_LIMIT_FALLBACK_PHRASE;
  const text = RATE_LIMIT_FALLBACK_TEXT;
  const model = String(opts.model || process.env.GROQ_MODEL || 'llama-3.3-70b-versatile');
  if (typeof opts.onFirstPhrase === 'function') {
    opts.onFirstPhrase({
      at_ms: Date.now(),
      phrase,
      phrase_ttfb_ms: 0,
      rate_limit_fallback: true,
    });
  }
  if (typeof opts.onDone === 'function') {
    opts.onDone({
      text,
      finish: 'rate_limit_fallback',
      provider: 'groq',
      model,
      latency_ms: 0,
      first_token_ms: null,
      first_phrase: phrase,
      first_phrase_ms: 0,
      streamed: false,
      rate_limited: true,
      rate_limit: rlMeta,
    });
  }
  return {
    text,
    finish: 'rate_limit_fallback',
    provider: 'groq',
    model,
    latency_ms: 0,
    first_token_ms: null,
    first_phrase: phrase,
    first_phrase_ms: 0,
    streamed: false,
    rate_limited: true,
    rate_limit: rlMeta,
  };
}

function streamOnce(opts, messages, model, key) {
  const payload = Buffer.from(JSON.stringify({
    model,
    messages,
    temperature: opts.temperature != null ? opts.temperature : 0.7,
    // Keep headroom for detailed explanations. Do not shorten answers for latency.
    max_completion_tokens: opts.max_completion_tokens != null ? opts.max_completion_tokens : 500,
    stream: true,
  }));

  const started = Date.now();
  let full = '';
  let firstTokenMs = null;
  let firstPhraseMs = null;
  let firstPhrase = null;
  let finish = null;
  let sseBuf = '';

  return new Promise((resolve, reject) => {
    const req = https.request({
      host: GROQ_HOST,
      path: '/openai/v1/chat/completions',
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + key,
        'Content-Type': 'application/json',
        'Content-Length': payload.length,
        Accept: 'text/event-stream',
      },
    }, (resp) => {
      if (resp.statusCode && resp.statusCode >= 400) {
        const parts = [];
        resp.on('data', (d) => parts.push(d));
        resp.on('end', () => {
          const body = Buffer.concat(parts).toString('utf8');
          const parsed = parseGroqErrorBody(body);
          const err = new Error(
            isGroqRateLimit(resp.statusCode, parsed)
              ? ('groq rate limited: ' + parsed.message)
              : ('groq stream failed: ' + parsed.message)
          );
          err.status = resp.statusCode;
          err.code = isGroqRateLimit(resp.statusCode, parsed) ? GROQ_RL_CODE : 'upstream';
          err.groq_error = parsed;
          err.rate_limit = isGroqRateLimit(resp.statusCode, parsed)
            ? rateLimitMeta(resp.statusCode, parsed, resp.headers)
            : null;
          err.headers = resp.headers;
          reject(err);
        });
        return;
      }

      resp.on('data', (chunk) => {
        sseBuf += chunk.toString('utf8');
        const lines = sseBuf.split(/\n/);
        sseBuf = lines.pop() || '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const data = trimmed.slice(5).trim();
          if (!data) continue;
          if (data === '[DONE]') continue;
          let parsed;
          try { parsed = JSON.parse(data); } catch { continue; }
          const choice = (parsed.choices || [])[0] || {};
          const delta = (choice.delta && choice.delta.content) || '';
          if (choice.finish_reason) finish = choice.finish_reason;
          if (!delta) continue;
          if (firstTokenMs == null) {
            firstTokenMs = Date.now() - started;
            if (typeof opts.onFirstToken === 'function') {
              opts.onFirstToken({ at_ms: Date.now(), text: delta, ttft_ms: firstTokenMs });
            }
          }
          full += delta;
          if (typeof opts.onDelta === 'function') {
            opts.onDelta({ text: delta, full });
          }
          if (!firstPhrase) {
            const phrase = extractFirstSafePhrase(full, opts.phraseOpts || {});
            if (phrase) {
              firstPhrase = phrase;
              firstPhraseMs = Date.now() - started;
              if (typeof opts.onFirstPhrase === 'function') {
                opts.onFirstPhrase({
                  at_ms: Date.now(),
                  phrase,
                  phrase_ttfb_ms: firstPhraseMs,
                });
              }
            }
          }
        }
      });
      resp.on('end', () => {
        const text = full.trim() || 'Sorry, I did not catch that.';
        resolve({
          text,
          finish: finish || 'stop',
          provider: 'groq',
          model,
          latency_ms: Date.now() - started,
          first_token_ms: firstTokenMs,
          first_phrase: firstPhrase,
          first_phrase_ms: firstPhraseMs,
          streamed: true,
        });
      });
      resp.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(Number(opts.timeoutMs) || 45000, () => req.destroy(new Error('groq stream timeout')));
    req.write(payload);
    req.end();
  });
}

/**
 * Stream Groq chat completions. Invokes:
 *   onFirstToken({ at_ms, text })
 *   onFirstPhrase({ at_ms, phrase })  once extractFirstSafePhrase succeeds
 *   onDelta({ text, full })
 *   onDone({ text, finish, latency_ms, first_token_ms, first_phrase_ms, model })
 *
 * On 429 / rate_limit_exceeded: at most one short retry when retry-after <= 2s;
 * otherwise immediate spoken fallback (never silent).
 */
async function streamGroqChat(opts = {}) {
  const key = process.env.GROQ_API_KEY;
  if (!key) {
    const err = new Error('Groq is not configured');
    err.code = 'not_configured';
    err.status = 501;
    throw err;
  }
  const model = String(opts.model || process.env.GROQ_MODEL || 'llama-3.3-70b-versatile');
  const messages = buildMessages(opts);
  if (messages.length < 2) {
    const err = new Error('no messages');
    err.code = 'no_messages';
    err.status = 422;
    throw err;
  }

  let lastErr = null;
  for (let attempt = 1; attempt <= GROQ_RL_MAX_ATTEMPTS; attempt++) {
    try {
      const result = await streamOnce(opts, messages, model, key);
      if (typeof opts.onDone === 'function') opts.onDone(result);
      return result;
    } catch (e) {
      lastErr = e;
      const rl = e && e.rate_limit;
      if (!rl && !(e && e.code === GROQ_RL_CODE) && !(e && e.status === GROQ_RL_STATUS)) {
        throw e;
      }
      const meta = rl || rateLimitMeta(e.status, e.groq_error, e.headers);
      const retryAfter = meta.retry_after_s;
      const canShortRetry = attempt < GROQ_RL_MAX_ATTEMPTS
        && retryAfter != null
        && retryAfter <= GROQ_RL_MAX_RETRY_AFTER_S;
      if (canShortRetry) {
        await sleep(Math.ceil(retryAfter * 1000));
        continue;
      }
      // No long waits. Speak immediately.
      return buildRateLimitFallback(opts, meta);
    }
  }
  // Exhausted bounded attempts. Still never silent.
  const meta = (lastErr && lastErr.rate_limit)
    || rateLimitMeta(GROQ_RL_STATUS, lastErr && lastErr.groq_error, lastErr && lastErr.headers);
  return buildRateLimitFallback(opts, meta);
}

/**
 * Classify a Groq upstream failure for tests / handlers.
 */
function classifyGroqUpstreamError(status, body, headers) {
  const parsed = parseGroqErrorBody(body);
  if (isGroqRateLimit(status, parsed)) {
    return {
      kind: 'rate_limit',
      ...rateLimitMeta(status, parsed, headers),
    };
  }
  return {
    kind: 'upstream',
    http_status: Number(status) || null,
    error_code: parsed.code,
    error_type: parsed.type,
    message: parsed.message,
  };
}

module.exports = {
  streamGroqChat,
  buildMessages,
  extractFirstSafePhrase,
  parseGroqErrorBody,
  isGroqRateLimit,
  classifyGroqUpstreamError,
  rateLimitMeta,
  buildRateLimitFallback,
  GROQ_RL_STATUS,
  GROQ_RL_CODE,
  GROQ_RL_TYPES,
  GROQ_RL_MAX_RETRY_AFTER_S,
  GROQ_RL_MAX_ATTEMPTS,
  RATE_LIMIT_FALLBACK_PHRASE,
  RATE_LIMIT_FALLBACK_TEXT,
};
