/**
 * Astra Voice. Groq streaming + first-safe-phrase flush for sub-1000ms first audio.
 *
 * NEVER wait for llm_complete before starting TTS. Emit the first safe natural
 * phrase as soon as it is ready; the rest of the answer continues concurrently.
 *
 * LATENCY P0.2: on HTTP 429 / rate_limit, do a bounded fast fallback to an
 * alternate Groq model (or a cached short ack). Never long blocking retries.
 * Never return an empty answer on a live turn.
 *
 * Latency != shorter answers. max_completion_tokens stays ample for detailed
 * explanations. Adaptive length is a prompt concern, not a token cap.
 *
 * No em dashes. Commas and periods only.
 */
'use strict';

const https = require('https');
const { extractFirstSafePhrase } = require('./turn-latency');
const { upstreamHttpsAgent } = require('./core');

const GROQ_HOST = 'api.groq.com';

/** Primary conversational model (Maya stack). */
const PRIMARY_MODEL = () => process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
/** Fast alternate for rate-limit / cold-path recovery. Still Groq. */
const FALLBACK_MODEL = () => process.env.GROQ_FALLBACK_MODEL || 'llama-3.1-8b-instant';

const RATE_LIMIT_ACK = Object.freeze({
  hi: 'Haan, ek second. Main detail mein batati hoon.',
  en: 'Yes. One moment, I am pulling that together.',
  te: 'సరే. ఒక్క క్షణం, వివరాలు చెప్తాను.',
  hinglish: 'Haan, ek second. Main detail mein batati hoon.',
});

function detectAckLanguage(text) {
  const s = String(text || '');
  if (/[\u0C00-\u0C7F]/.test(s)) return 'te';
  if (/[\u0900-\u097F]/.test(s)) return 'hi';
  if (/kar\s*sakte|bilkul|haan|demo\s*schedule|book\s*kar/i.test(s)) return 'hinglish';
  return 'en';
}

function rateLimitAckSpeech(userText) {
  const lang = detectAckLanguage(userText);
  return {
    language: lang,
    text: RATE_LIMIT_ACK[lang] || RATE_LIMIT_ACK.en,
  };
}

/**
 * Classify Groq upstream failures. Exact category for latency/rate-limit traces.
 */
function classifyGroqError(status, bodyText) {
  const statusCode = Number(status) || 0;
  const body = String(bodyText || '').toLowerCase();
  const is429 = statusCode === 429;
  const isRateLimit = is429
    || /rate[_ ]?limit|too many requests|tokens per (minute|day)|requests per (minute|day)|tpm|rpm/i.test(body);
  let category = 'upstream';
  if (isRateLimit) category = 'rate_limit';
  else if (statusCode === 503 || statusCode === 502) category = 'unavailable';
  else if (statusCode === 401 || statusCode === 403) category = 'auth';
  else if (statusCode >= 400) category = 'client_or_upstream';
  return {
    status: statusCode,
    category,
    rate_limited: isRateLimit,
    retryable: isRateLimit || statusCode === 503 || statusCode === 502,
    body_snippet: String(bodyText || '').slice(0, 240),
  };
}

function buildMessages(opts) {
  // Hot path: recent turns only. Full historical transcripts stay out of TTFT.
  const history = Array.isArray(opts.messages) ? opts.messages.slice(-12) : [];
  const system = String(opts.system || '').slice(0, 3500);
  const messages = [{ role: 'system', content: system || 'You are a warm voice assistant.' }]
    .concat(history.filter((m) => m && (m.text || m.content)).map((m) => ({
      role: (m.role === 'assistant' || m.role === 'model') ? 'assistant' : 'user',
      content: String(m.text || m.content || '').slice(0, 1500),
    })));
  return messages;
}

function lastUserText(messages) {
  const hist = Array.isArray(messages) ? messages : [];
  for (let i = hist.length - 1; i >= 0; i--) {
    const m = hist[i];
    if (!m) continue;
    if (m.role === 'user' || m.role === 'human') return String(m.text || m.content || '');
  }
  return '';
}

function openGroqStream(payloadBuf, key, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      host: GROQ_HOST,
      path: '/openai/v1/chat/completions',
      method: 'POST',
      agent: upstreamHttpsAgent,
      headers: {
        Authorization: 'Bearer ' + key,
        'Content-Type': 'application/json',
        'Content-Length': payloadBuf.length,
        Accept: 'text/event-stream',
      },
    }, (resp) => {
      resolve({ req, resp });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs || 45000, () => req.destroy(new Error('groq stream timeout')));
    req.write(payloadBuf);
    req.end();
  });
}

async function consumeGroqSse(resp, opts, started, model) {
  let full = '';
  let firstTokenMs = null;
  let firstPhraseMs = null;
  let firstPhrase = null;
  let finish = null;
  let sseBuf = '';

  await new Promise((resolve, reject) => {
    resp.on('data', (chunk) => {
      sseBuf += chunk.toString('utf8');
      const lines = sseBuf.split(/\n/);
      sseBuf = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const data = trimmed.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        let parsed;
        try { parsed = JSON.parse(data); } catch { continue; }
        const choice = (parsed.choices || [])[0] || {};
        const delta = (choice.delta && choice.delta.content) || '';
        if (choice.finish_reason) finish = choice.finish_reason;
        if (!delta) continue;
        if (firstTokenMs == null) {
          firstTokenMs = Date.now() - started;
          if (typeof opts.onFirstToken === 'function') {
            // Emit relative TTFT for client monotonic traces. Do NOT mix
            // server wall clocks into client stage marks.
            opts.onFirstToken({
              at_ms: Date.now(),
              text: delta,
              ttft_ms: firstTokenMs,
              model,
            });
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
                model,
              });
            }
          }
        }
      }
    });
    resp.on('end', resolve);
    resp.on('error', reject);
  });

  return {
    text: full.trim(),
    finish: finish || 'stop',
    first_token_ms: firstTokenMs,
    first_phrase: firstPhrase,
    first_phrase_ms: firstPhraseMs,
    model,
  };
}

/**
 * Stream Groq chat completions. Invokes:
 *   onFirstToken({ at_ms, text, ttft_ms, model })
 *   onFirstPhrase({ at_ms, phrase, phrase_ttfb_ms, model })  once extractFirstSafePhrase succeeds
 *   onDelta({ text, full })
 *   onRateLimit({ status, category, attempt, fallback_model })
 *   onDone({ text, finish, latency_ms, first_token_ms, first_phrase_ms, model, rate_limited, fallback_used })
 *
 * Rate-limit policy (P0.2): at most one immediate fallback to GROQ_FALLBACK_MODEL.
 * No multi-second exponential backoff on the live voice path. If both fail,
 * emit a cached short ack as first_phrase so TTS is never empty.
 */
async function streamGroqChat(opts = {}) {
  const key = process.env.GROQ_API_KEY;
  if (!key) {
    const err = new Error('Groq is not configured');
    err.code = 'not_configured';
    err.status = 501;
    throw err;
  }
  const primary = String(opts.model || PRIMARY_MODEL());
  const fallbackModel = String(opts.fallbackModel || FALLBACK_MODEL());
  const messages = buildMessages(opts);
  if (messages.length < 2) {
    const err = new Error('no messages');
    err.code = 'no_messages';
    err.status = 422;
    throw err;
  }

  const started = Date.now();
  let rateLimited = false;
  let fallbackUsed = false;
  let lastClass = null;
  let usedModel = primary;

  async function attempt(model) {
    const payload = Buffer.from(JSON.stringify({
      model,
      messages,
      temperature: opts.temperature != null ? opts.temperature : 0.7,
      // Keep headroom for detailed explanations. Do not shorten answers for latency.
      max_completion_tokens: opts.max_completion_tokens != null ? opts.max_completion_tokens : 500,
      stream: true,
    }));
    const { resp } = await openGroqStream(payload, key, opts.timeoutMs);
    if (resp.statusCode && resp.statusCode >= 400) {
      const parts = [];
      for await (const d of resp) parts.push(d);
      const body = Buffer.concat(parts).toString('utf8').slice(0, 400);
      const classified = classifyGroqError(resp.statusCode, body);
      const err = new Error('groq stream failed: ' + body);
      err.status = resp.statusCode;
      err.code = classified.category;
      err.groq = classified;
      throw err;
    }
    return consumeGroqSse(resp, opts, started, model);
  }

  let out;
  try {
    out = await attempt(primary);
  } catch (e) {
    lastClass = e.groq || classifyGroqError(e.status, e.message);
    if (lastClass.rate_limited || lastClass.category === 'unavailable') {
      rateLimited = !!lastClass.rate_limited || lastClass.category === 'rate_limit';
      if (typeof opts.onRateLimit === 'function') {
        opts.onRateLimit({
          status: lastClass.status,
          category: lastClass.category,
          attempt: 1,
          fallback_model: fallbackModel,
          body_snippet: lastClass.body_snippet,
        });
      }
      // Bound: one fast alternate Groq model. No long blocking retries.
      if (fallbackModel && fallbackModel !== primary && opts.allowFallback !== false) {
        try {
          fallbackUsed = true;
          usedModel = fallbackModel;
          out = await attempt(fallbackModel);
        } catch (e2) {
          lastClass = e2.groq || classifyGroqError(e2.status, e2.message);
          out = null;
        }
      } else {
        out = null;
      }
    } else {
      throw e;
    }
  }

  if (!out || !out.text) {
    // Cached short ack path: never leave the caller with silence / empty answer.
    const ack = rateLimitAckSpeech(lastUserText(opts.messages));
    if (typeof opts.onFirstPhrase === 'function') {
      opts.onFirstPhrase({
        at_ms: Date.now(),
        phrase: ack.text,
        phrase_ttfb_ms: Date.now() - started,
        model: usedModel,
        rate_limit_ack: true,
      });
    }
    const result = {
      text: ack.text + ' Could you repeat that so I can answer fully?',
      finish: 'rate_limit_ack',
      provider: 'groq',
      model: usedModel,
      latency_ms: Date.now() - started,
      first_token_ms: null,
      first_phrase: ack.text,
      first_phrase_ms: Date.now() - started,
      streamed: false,
      rate_limited: true,
      fallback_used: fallbackUsed,
      groq_error: lastClass,
    };
    if (typeof opts.onDone === 'function') opts.onDone(result);
    return result;
  }

  const text = out.text || 'Sorry, I did not catch that.';
  const result = {
    text,
    finish: out.finish || 'stop',
    provider: 'groq',
    model: usedModel,
    latency_ms: Date.now() - started,
    first_token_ms: out.first_token_ms,
    first_phrase: out.first_phrase,
    first_phrase_ms: out.first_phrase_ms,
    streamed: true,
    rate_limited: rateLimited,
    fallback_used: fallbackUsed,
  };
  if (typeof opts.onDone === 'function') opts.onDone(result);
  return result;
}

module.exports = {
  streamGroqChat,
  buildMessages,
  extractFirstSafePhrase,
  classifyGroqError,
  rateLimitAckSpeech,
  RATE_LIMIT_ACK,
  PRIMARY_MODEL,
  FALLBACK_MODEL,
};
