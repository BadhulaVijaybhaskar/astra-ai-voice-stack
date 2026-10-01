/**
 * Astra Voice. Groq streaming + first-safe-phrase flush for sub-1000ms first audio.
 *
 * NEVER wait for llm_complete before starting TTS. Emit the first safe natural
 * phrase as soon as it is ready; the rest of the answer continues concurrently.
 *
 * Latency != shorter answers. max_completion_tokens stays ample for detailed
 * explanations. Adaptive length is a prompt concern, not a token cap.
 *
 * No em dashes. Commas and periods only.
 */
'use strict';

const https = require('https');
const { extractFirstSafePhrase } = require('./turn-latency');

const GROQ_HOST = 'api.groq.com';

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
 * Stream Groq chat completions. Invokes:
 *   onFirstToken({ at_ms, text })
 *   onFirstPhrase({ at_ms, phrase })  once extractFirstSafePhrase succeeds
 *   onDelta({ text, full })
 *   onDone({ text, finish, latency_ms, first_token_ms, first_phrase_ms, model })
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

  await new Promise((resolve, reject) => {
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
          const body = Buffer.concat(parts).toString('utf8').slice(0, 300);
          const err = new Error('groq stream failed: ' + body);
          err.status = resp.statusCode;
          err.code = 'upstream';
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
      resp.on('end', resolve);
      resp.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(Number(opts.timeoutMs) || 45000, () => req.destroy(new Error('groq stream timeout')));
    req.write(payload);
    req.end();
  });

  const text = full.trim() || 'Sorry, I did not catch that.';
  const result = {
    text,
    finish: finish || 'stop',
    provider: 'groq',
    model,
    latency_ms: Date.now() - started,
    first_token_ms: firstTokenMs,
    first_phrase: firstPhrase,
    first_phrase_ms: firstPhraseMs,
    streamed: true,
  };
  if (typeof opts.onDone === 'function') opts.onDone(result);
  return result;
}

module.exports = {
  streamGroqChat,
  buildMessages,
  extractFirstSafePhrase,
};
