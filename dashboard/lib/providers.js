/**
 * Astra AI. Provider-agnostic engine.
 *
 * Four registries, each a uniform set of implemented adapters:
 *   stt        : deepgram, intentionally fixed
 *   tts        : rumik
 *   llm        : groq + gemini
 *   telephony  : vobiz via Dograh
 *
 * Every adapter declares { id, label, needs:[envKeys], ... }. `live` means the
 * adapter is implemented and configured, never merely that a key exists.
 * LLM_PROVIDER, LLM_MODEL, TTS_PROVIDER and TTS_MODEL select server defaults.
 * A tenant-safe selection contains provider and model IDs only. Secrets remain
 * in process.env and can never be supplied through a tenant request.
 *
 * Deepgram handles streaming and batch transcription, Rumik keeps the verified
 * browser UA, Groq handles the primary reasoning path, and
 * outbound VoBiz calls always go through Dograh. Never call the raw VoBiz API.
 *
 * No em dashes anywhere. Commas and periods only.
 */
'use strict';

const { httpsPost, httpsGet } = require('./core');

// Rumik sits behind Cloudflare, which 403s non-browser user-agents. NEVER remove.
const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';

const RUMIK_HOST = 'silk-api.rumik.ai';
const GEMINI_HOST = 'generativelanguage.googleapis.com';
const DEEPGRAM_HOST = 'api.deepgram.com';
const GROQ_HOST = 'api.groq.com';
const MAX_TEXT = 2000; // Rumik hard cap

const TTS_MODELS = new Set(['muga', 'mulberry']);
const TTS_SPEAKERS = new Set(['speaker_1', 'speaker_2', 'speaker_3', 'speaker_4']);
const PROVIDER_ID_RE = /^[a-z][a-z0-9_-]{0,63}$/;
const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const PROVIDER_LAYERS = new Set(['stt', 'tts', 'llm', 'telephony']);

// A capability error that route handlers can map to an HTTP status cleanly.
class ProviderError extends Error {
  constructor(message, status = 502, code = 'provider_error', detail) {
    super(message);
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

// True when EVERY env key in `keys` is present and non-empty.
function hasEnv(keys) {
  return keys.every((k) => !!(process.env[k] && String(process.env[k]).trim()));
}

// Build the standard "this adapter is a stub" error.
function notConfigured(label, needs) {
  return new ProviderError(
    `${label} is not configured. Add ${needs.join(', ')} to .env to enable it.`,
    501,
    'not_configured',
    { needs },
  );
}

function validModelId(value, label = 'model') {
  const model = String(value || '').trim();
  if (!MODEL_ID_RE.test(model)) {
    throw new ProviderError(`${label} is invalid`, 422, 'invalid_model');
  }
  return model;
}

function commaListEnv(name) {
  return String(process.env[name] || '').split(',').map((value) => value.trim()).filter(Boolean);
}

function selectedModel(adapter, requestedModel) {
  const globalModel = adapter.id === configuredDefaultId(adapter.layer)
    ? process.env[`${adapter.layer.toUpperCase()}_MODEL`] : '';
  const model = validModelId(requestedModel || globalModel || adapter.model, `${adapter.label} model`);
  if (adapter.models && !adapter.models.has(model)) {
    throw new ProviderError(`${model} is not supported by ${adapter.label}`, 422, 'unsupported_model');
  }
  const allowed = adapter.modelAllowlistEnv ? commaListEnv(adapter.modelAllowlistEnv) : [];
  if (allowed.length && !allowed.includes(model)) {
    throw new ProviderError(`${model} is not enabled for ${adapter.label}`, 422, 'model_not_enabled');
  }
  return model;
}

/* ==========================================================================
   TTS LAYER
   ========================================================================== */

const ttsRumik = {
  id: 'rumik',
  label: 'Rumik Silk',
  layer: 'tts',
  needs: ['RUMIK_API_KEY'],
  implemented: true,
  models: TTS_MODELS,
  get live() { return hasEnv(this.needs); },
  get model() { return process.env.RUMIK_MODEL || 'mulberry'; },

  // Synthesize one utterance. Returns { buffer (WAV bytes), credits, chars }.
  // Reuses the verified /v1/tts call exactly: Bearer key + browser UA, mulberry
  // takes speaker/f0_up_key/description, both models take optional sampling args.
  async synthesize(opts) {
    const key = process.env.RUMIK_API_KEY;
    if (!key) throw notConfigured(this.label, this.needs);

    const model = selectedModel(this, opts.model);
    const text = String(opts.text || '').slice(0, MAX_TEXT);
    if (!text.trim()) throw new ProviderError('text is required', 422, 'no_text');

    const payload = { model, text };
    if (model === 'mulberry') {
      if (opts.description) payload.description = String(opts.description).slice(0, 500);
      if (opts.speaker && TTS_SPEAKERS.has(opts.speaker)) payload.speaker = opts.speaker;
      if (Number.isFinite(opts.f0_up_key)) {
        payload.f0_up_key = Math.max(-12, Math.min(12, opts.f0_up_key | 0));
      }
    }
    for (const k of ['temperature', 'top_p', 'top_k', 'repetition_penalty', 'max_new_tokens']) {
      if (Number.isFinite(opts[k])) payload[k] = opts[k];
    }

    const buf = Buffer.from(JSON.stringify(payload));
    const up = await httpsPost(RUMIK_HOST, '/v1/tts', {
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json',
      'Content-Length': buf.length,
      'User-Agent': BROWSER_UA,
    }, buf);

    if (up.status !== 200) {
      throw new ProviderError('rumik synthesis failed', up.status, 'upstream',
        up.buffer.toString('utf8').slice(0, 300));
    }
    return {
      buffer: up.buffer,
      credits: up.headers['x-credits-used'] || '',
      chars: text.length,
    };
  },

  // Mint a one-shot streaming session. Returns { ws_url, token } from Rumik.
  async wsConnect(opts) {
    const key = process.env.RUMIK_API_KEY;
    if (!key) throw notConfigured(this.label, this.needs);
    const model = selectedModel(this, opts.model);
    const buf = Buffer.from(JSON.stringify({
      model,
      text: String(opts.text || '').slice(0, MAX_TEXT),
    }));
    const up = await httpsPost(RUMIK_HOST, '/v1/tts/ws-connect', {
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json',
      'Content-Length': buf.length,
      'User-Agent': BROWSER_UA,
    }, buf);
    if (up.status !== 200) {
      throw new ProviderError('rumik mint failed', up.status, 'upstream',
        up.buffer.toString('utf8').slice(0, 300));
    }
    let data;
    try { data = JSON.parse(up.buffer.toString('utf8')); } catch { data = {}; }
    return data; // { ws_url, token }
  },
};

/* ==========================================================================
   LLM LAYER. Speech recognition intentionally remains Deepgram only.
   ========================================================================== */

const DEFAULT_SYSTEM = 'You are Astra AI, a warm, concise voice assistant. Reply in 1 to 3 short spoken sentences. No markdown, no lists, no emojis. This will be read aloud.';

const sttDeepgram = {
  id: 'deepgram',
  label: 'Deepgram Nova-3',
  layer: 'stt',
  needs: ['DEEPGRAM_API_KEY'],
  implemented: true,
  get live() { return hasEnv(this.needs); },
  get model() { return process.env.DEEPGRAM_MODEL || 'nova-3'; },

  async mintToken() {
    const key = process.env.DEEPGRAM_API_KEY;
    if (!key) throw notConfigured(this.label, this.needs);
    const body = Buffer.from(JSON.stringify({ ttl_seconds: 60 }));
    const up = await httpsPost(DEEPGRAM_HOST, '/v1/auth/grant', {
      'Authorization': `Token ${key}`,
      'Content-Type': 'application/json',
      'Content-Length': body.length,
    }, body);
    let data = {}; try { data = JSON.parse(up.buffer.toString('utf8')); } catch {}
    if (up.status !== 200 || !data.access_token) {
      throw new ProviderError('deepgram token grant failed', up.status, 'upstream',
        (data.err_msg || data.error || up.buffer.toString('utf8')).slice(0, 300));
    }
    return { access_token: data.access_token, expires_in: data.expires_in || 60, model: this.model };
  },

  async transcribe(opts) {
    const key = process.env.DEEPGRAM_API_KEY;
    if (!key) throw notConfigured(this.label, this.needs);
    const audio = Buffer.from(String(opts.audio || ''), 'base64');
    if (audio.length < 200) throw new ProviderError('no audio', 422, 'no_audio');
    const mime = String(opts.mime || 'audio/webm').split(';')[0];
    const started = Date.now();
    const path = `/v1/listen?model=${encodeURIComponent(this.model)}&language=multi&smart_format=true&punctuate=true&utterances=false`;
    const up = await httpsPost(DEEPGRAM_HOST, path, {
      'Authorization': `Token ${key}`,
      'Content-Type': mime,
      'Content-Length': audio.length,
    }, audio);
    let data = {}; try { data = JSON.parse(up.buffer.toString('utf8')); } catch {}
    if (up.status !== 200) {
      throw new ProviderError('deepgram transcription failed', up.status, 'upstream',
        (data.err_msg || data.error || up.buffer.toString('utf8')).slice(0, 300));
    }
    const alt = (((data.results || {}).channels || [])[0] || {}).alternatives || [];
    return {
      text: String((alt[0] || {}).transcript || '').trim(),
      provider: 'deepgram',
      model: this.model,
      latency_ms: Date.now() - started,
    };
  },
};

const llmGroq = {
  id: 'groq',
  label: 'Groq Llama 3.3 70B',
  layer: 'llm',
  needs: ['GROQ_API_KEY'],
  implemented: true,
  modelAllowlistEnv: 'GROQ_ALLOWED_MODELS',
  get live() { return hasEnv(this.needs); },
  get model() { return process.env.GROQ_MODEL || 'llama-3.3-70b-versatile'; },

  async chat(opts) {
    const key = process.env.GROQ_API_KEY;
    if (!key) throw notConfigured(this.label, this.needs);
    const history = Array.isArray(opts.messages) ? opts.messages.slice(-16) : [];
    const messages = [{ role: 'system', content: String(opts.system || DEFAULT_SYSTEM).slice(0, 3000) }]
      .concat(history.filter((m) => m && m.text).map((m) => ({
        role: (m.role === 'assistant' || m.role === 'model') ? 'assistant' : 'user',
        content: String(m.text).slice(0, 4000),
      })));
    if (messages.length < 2) throw new ProviderError('no messages', 422, 'no_messages');
    const model = selectedModel(this, opts.model);
    const payload = Buffer.from(JSON.stringify({
      model,
      messages,
      temperature: 0.7,
      max_completion_tokens: 400,
      stream: false,
    }));
    const started = Date.now();
    const up = await httpsPost(GROQ_HOST, '/openai/v1/chat/completions', {
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json',
      'Content-Length': payload.length,
    }, payload);
    let data = {}; try { data = JSON.parse(up.buffer.toString('utf8')); } catch {}
    if (up.status !== 200) {
      throw new ProviderError('groq response failed', up.status, 'upstream',
        (((data.error || {}).message) || up.buffer.toString('utf8')).slice(0, 300));
    }
    const choice = (data.choices || [])[0] || {};
    return {
      text: String(((choice.message || {}).content) || '').trim() || 'Sorry, I did not catch that.',
      finish: choice.finish_reason || null,
      provider: 'groq',
      model,
      latency_ms: Date.now() - started,
    };
  },
};

const llmGemini = {
  id: 'gemini',
  label: 'Google Gemini',
  layer: 'llm',
  needs: ['GEMINI_API_KEY'],
  implemented: true,
  modelAllowlistEnv: 'GEMINI_ALLOWED_MODELS',
  get live() { return hasEnv(this.needs); },
  get model() { return process.env.GEMINI_MODEL || 'gemini-flash-latest'; },

  // The conversation brain. Reuses the verified generateContent call with
  // thinkingConfig.thinkingBudget 0 for low voice-loop latency.
  // Returns { text, finish }.
  async chat(opts) {
    const key = process.env.GEMINI_API_KEY;
    if (!key) throw notConfigured(this.label, this.needs);

    const model = selectedModel(this, opts.model);
    const history = Array.isArray(opts.messages) ? opts.messages.slice(-16) : [];
    const system = String(opts.system || DEFAULT_SYSTEM).slice(0, 2000);
    const contents = history
      .filter((m) => m && m.text)
      .map((m) => ({
        role: (m.role === 'assistant' || m.role === 'model') ? 'model' : 'user',
        parts: [{ text: String(m.text).slice(0, 4000) }],
      }));
    if (!contents.length) throw new ProviderError('no messages', 422, 'no_messages');

    const payload = {
      systemInstruction: { parts: [{ text: system }] },
      contents,
      generationConfig: {
        maxOutputTokens: 400,
        temperature: 0.8,
        thinkingConfig: { thinkingBudget: 0 },
      },
    };
    const started = Date.now();
    let buf = Buffer.from(JSON.stringify(payload));
    let up = await httpsPost(GEMINI_HOST,
      `/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${key}`,
      { 'Content-Type': 'application/json', 'Content-Length': buf.length }, buf);

    let data; try { data = JSON.parse(up.buffer.toString('utf8')); } catch { data = {}; }
    // Some Gemini aliases reject thinkingConfig even though the same models
    // accept the rest of the request. Retry once without that optional field.
    if (up.status === 400 && /invalid argument/i.test((data.error && data.error.message) || '')) {
      delete payload.generationConfig.thinkingConfig;
      buf = Buffer.from(JSON.stringify(payload));
      up = await httpsPost(GEMINI_HOST,
        `/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${key}`,
        { 'Content-Type': 'application/json', 'Content-Length': buf.length }, buf);
      try { data = JSON.parse(up.buffer.toString('utf8')); } catch { data = {}; }
    }
    if (up.status !== 200) {
      throw new ProviderError('gemini error', up.status, 'upstream',
        (data.error && data.error.message) || '');
    }
    const cand = (data.candidates || [])[0] || {};
    const parts = (cand.content && cand.content.parts) || [];
    const text = parts.map((p) => p.text || '').join('').trim();
    return {
      text: text || 'Sorry, I did not catch that.',
      finish: cand.finishReason || null,
      provider: this.id,
      model,
      latency_ms: Date.now() - started,
    };
  },
};

/* ==========================================================================
   TELEPHONY LAYER. VoBiz through Dograh.
   ========================================================================== */

function dograhConnection() {
  const raw = String(process.env.DOGRAH_BASE_URL || '').trim();
  let parsed;
  try { parsed = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`); } catch {
    throw new ProviderError('DOGRAH_BASE_URL is invalid', 503, 'not_configured');
  }
  if (parsed.protocol !== 'https:') {
    throw new ProviderError('DOGRAH_BASE_URL must use HTTPS', 503, 'not_configured');
  }
  return {
    host: parsed.host,
    prefix: parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/$/, ''),
    dashboard: parsed.origin + '/',
  };
}

function positiveIntEnv(name) {
  const value = Number(process.env[name]);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ProviderError(`${name} must be a positive integer`, 503, 'not_configured');
  }
  return value;
}

function parseJsonResponse(up) {
  try { return JSON.parse(up.buffer.toString('utf8') || '{}'); } catch { return {}; }
}

function upstreamMessage(data, fallback) {
  if (!data || typeof data !== 'object') return fallback;
  if (typeof data.detail === 'string') return data.detail;
  if (typeof data.message === 'string') return data.message;
  if (typeof data.error === 'string') return data.error;
  return fallback;
}

function upstreamStatus(status) {
  // An invalid Dograh service credential is not an expired Astra AI user session.
  // Never forward 401/403, because the browser correctly treats those as a
  // reason to sign the current Astra AI user out.
  if (status === 401 || status === 403) return 502;
  return status || 502;
}

/** Positive integer from options, or null when missing / invalid. */
function positiveIntOption(value) {
  if (value == null || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) return null;
  return n;
}

/**
 * Pull a stable provider run / call id from a Dograh initiate-call response.
 * Accepts common top-level and nested aliases, plus a few response headers.
 * Returns null when none exist (never invents a fake id).
 */
function extractProviderRunId(data, headers) {
  if (data && typeof data === 'object') {
    const bags = [data];
    if (data.data && typeof data.data === 'object' && !Array.isArray(data.data)) {
      bags.push(data.data);
    }
    const keys = [
      'id', 'run_id', 'runId', 'workflow_run_id', 'workflowRunId',
      'call_id', 'callId', 'telephony_call_id', 'telephonyCallId',
    ];
    for (const bag of bags) {
      for (const key of keys) {
        if (bag[key] == null || bag[key] === '') continue;
        const id = String(bag[key]).trim();
        // Skip run *names* like WR-TEL-OUT-... here; those are not numeric ids.
        if (/^WR-TEL-/i.test(id)) continue;
        if (id) return id;
      }
    }
  }
  if (headers && typeof headers === 'object') {
    const headerKeys = [
      'x-workflow-run-id', 'x-run-id', 'x-call-id',
      'workflow-run-id', 'run-id',
    ];
    for (const key of headerKeys) {
      const raw = headers[key] != null ? headers[key] : headers[key.toLowerCase()];
      if (raw == null || raw === '') continue;
      const id = String(Array.isArray(raw) ? raw[0] : raw).trim();
      if (id && !/^WR-TEL-/i.test(id)) return id;
    }
  }
  return null;
}

/**
 * Parse Dograh's initiate-call success message for the run name
 * (e.g. "Call initiated successfully with run name WR-TEL-OUT-63869822").
 * Returns null when the message does not contain a recognizable name.
 */
function extractProviderRunName(data) {
  if (!data || typeof data !== 'object') return null;
  const bags = [data];
  if (data.data && typeof data.data === 'object' && !Array.isArray(data.data)) {
    bags.push(data.data);
  }
  for (const bag of bags) {
    for (const key of ['name', 'run_name', 'runName', 'workflow_run_name', 'workflowRunName']) {
      if (bag[key] == null || bag[key] === '') continue;
      const name = String(bag[key]).trim();
      if (/^WR-TEL-[A-Za-z0-9_-]+$/i.test(name)) return name;
    }
    const message = bag.message != null ? String(bag.message) : '';
    const match = message.match(/\b(WR-TEL-[A-Za-z0-9_-]+)\b/i);
    if (match) return match[1];
  }
  return null;
}

/** Normalize phones to trailing digits for fuzzy match (last 10). */
function phoneMatchKey(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (!digits) return '';
  return digits.length > 10 ? digits.slice(-10) : digits;
}

/**
 * Pick the best matching Dograh workflow run for an outbound dial that
 * returned no explicit id. Prefer exact run-name match, then phone + recent
 * created_at window. Never invents an id.
 */
function matchRecentWorkflowRun(runs, { phoneE164, runName, sinceMs = 120000, nowMs } = {}) {
  if (!Array.isArray(runs) || !runs.length) return null;
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const wantName = runName ? String(runName).trim() : '';
  const wantPhone = phoneMatchKey(phoneE164);

  if (wantName) {
    const byName = runs.find((run) => {
      const name = String(run && (run.name || run.run_name || run.runName) || '').trim();
      return name && name === wantName;
    });
    if (byName && byName.id != null && byName.id !== '') return byName;
  }

  if (!wantPhone) return null;
  let best = null;
  let bestAge = Infinity;
  for (const run of runs) {
    if (!run || run.id == null || run.id === '') continue;
    const ctx = (run.initial_context && typeof run.initial_context === 'object')
      ? run.initial_context
      : {};
    const runPhone = phoneMatchKey(
      run.to_number || run.toE164 || run.to || run.callee_number
      || ctx.phone_number || ctx.caller_number || ctx.to_number || '',
    );
    if (!runPhone || runPhone !== wantPhone) continue;
    const createdRaw = run.created_at || run.createdAt || run.started_at || run.startedAt;
    const created = createdRaw ? Date.parse(createdRaw) : NaN;
    if (!Number.isFinite(created)) {
      if (!best) best = run;
      continue;
    }
    const age = now - created;
    if (age < 0 || age > sinceMs) continue;
    if (age < bestAge) {
      bestAge = age;
      best = run;
    }
  }
  return best;
}

const telVobiz = {
  id: 'vobiz',
  label: 'VoBiz via Dograh',
  layer: 'telephony',
  needs: [
    'DOGRAH_BASE_URL', 'DOGRAH_API_KEY', 'DOGRAH_WORKFLOW_ID',
    'DOGRAH_TELEPHONY_CONFIG_ID', 'DOGRAH_PHONE_NUMBER_ID',
  ],
  implemented: true,
  get live() { return hasEnv(this.needs); },
  get did() { return String(process.env.VOBIZ_NUMBER || '').replace(/[^0-9+]/g, ''); },
  get dashboard() { return dograhConnection().dashboard; },

  async request(method, pathname, payload) {
    if (!hasEnv(this.needs)) throw notConfigured(this.label, this.needs);
    const connection = dograhConnection();
    const headers = { 'X-API-Key': process.env.DOGRAH_API_KEY };
    let up;
    if (method === 'POST') {
      const buf = Buffer.from(JSON.stringify(payload || {}));
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = buf.length;
      up = await httpsPost(connection.host, connection.prefix + pathname, headers, buf);
    } else {
      up = await httpsGet(connection.host, connection.prefix + pathname, headers);
    }
    return { up, data: parseJsonResponse(up) };
  },

  // Report the VoBiz configuration and numbers as Dograh sees them. Reading
  // status through Dograh verifies the same control plane used for live calls.
  async status() {
    const configId = positiveIntEnv('DOGRAH_TELEPHONY_CONFIG_ID');
    const phoneNumberId = positiveIntEnv('DOGRAH_PHONE_NUMBER_ID');
    const configsResult = await this.request('GET', '/api/v1/organizations/telephony-configs');
    if (configsResult.up.status < 200 || configsResult.up.status >= 300) {
      throw new ProviderError('Could not read VoBiz status from Dograh', upstreamStatus(configsResult.up.status),
        'upstream', upstreamMessage(configsResult.data, 'Dograh telephony status failed.'));
    }
    const configs = Array.isArray(configsResult.data.configurations)
      ? configsResult.data.configurations : [];
    const config = configs.find((row) => Number(row.id) === configId);
    if (!config || String(config.provider || '').toLowerCase() !== 'vobiz') {
      throw new ProviderError('VoBiz is not configured in Dograh', 503, 'not_configured',
        `Expected Dograh telephony configuration ${configId} with provider vobiz.`);
    }

    const numbersResult = await this.request('GET',
      `/api/v1/organizations/telephony-configs/${configId}/phone-numbers`);
    if (numbersResult.up.status < 200 || numbersResult.up.status >= 300) {
      throw new ProviderError('Could not read VoBiz numbers from Dograh', upstreamStatus(numbersResult.up.status),
        'upstream', upstreamMessage(numbersResult.data, 'Dograh phone-number status failed.'));
    }
    const numbers = Array.isArray(numbersResult.data.phone_numbers)
      ? numbersResult.data.phone_numbers : [];
    const selectedNumber = numbers.find((row) => Number(row.id) === phoneNumberId);
    if (!selectedNumber || selectedNumber.is_active === false) {
      throw new ProviderError('The VoBiz caller ID is not active in Dograh', 503, 'not_configured',
        `Expected active Dograh phone number ${phoneNumberId}.`);
    }
    const dids = numbers.map((row) => ({
      id: row.id,
      number: row.address || row.address_normalized,
      status: row.is_active === false ? 'inactive' : 'active',
      label: row.label || '',
      isDefaultCallerId: !!row.is_default_caller_id,
      inboundWorkflowId: row.inbound_workflow_id,
      inboundWorkflowName: row.inbound_workflow_name || '',
    }));
    return {
      connected: true,
      provider: 'vobiz',
      orchestrator: 'dograh',
      configuration: {
        id: config.id,
        name: config.name,
        isDefaultOutbound: !!config.is_default_outbound,
      },
      dids,
      did: selectedNumber.address || selectedNumber.address_normalized || this.did,
      workflowId: positiveIntEnv('DOGRAH_WORKFLOW_ID'),
      dashboard: this.dashboard,
    };
  },

  // Place one real paid call through Dograh. The HTTP route above this adapter
  // is the sole confirm guard, and this method makes exactly one initiate call.
  async dial(rawNumber, options = {}) {
    if (!hasEnv(this.needs)) throw notConfigured(this.label, this.needs);
    let num = String(rawNumber || '').replace(/[^0-9]/g, '');
    if (num.length === 12 && num.startsWith('91')) num = num.slice(2);
    if (num.length !== 10) {
      throw new ProviderError('need a 10-digit Indian mobile (national format)', 422, 'bad_number');
    }
    return this.initiateCall('+91' + num, options);
  },

  // Outbound initiate-call with an E.164 destination. Used by the callback
  // webhook and by dial() after national-number normalization.
  // Prefer options.workflowId / telephonyConfigId / fromPhoneNumberId when they
  // are positive integers. Env fallback for number ids is allowed only for
  // legacy ops paths. Product dials set failClosedNumbers and must pass
  // resolved Astra Phone Number mappings (no silent DOGRAH_* number fallback).
  //
  // Dograh often returns only `{ message: "... run name WR-TEL-OUT-..." }` with
  // no workflow_run_id. When that happens we (1) parse the run name, (2) try a
  // best-effort pre-create + pass workflow_run_id, then (3) reconcile against
  // recent workflow runs by name/phone. Never invent a fake id.
  async initiateCall(phoneE164, options = {}) {
    if (!hasEnv(this.needs)) throw notConfigured(this.label, this.needs);
    const phone = String(phoneE164 || '').trim();
    if (!/^\+[1-9]\d{6,14}$/.test(phone)) {
      throw new ProviderError('phone must be E.164 (+ and 7 to 15 digits)', 422, 'bad_number');
    }
    const failClosedNumbers = options.failClosedNumbers === true;
    const workflowId = positiveIntOption(options.workflowId) || positiveIntEnv('DOGRAH_WORKFLOW_ID');
    let telephonyConfigId = positiveIntOption(options.telephonyConfigId);
    let fromPhoneNumberId = positiveIntOption(options.fromPhoneNumberId);
    if (!failClosedNumbers) {
      telephonyConfigId = telephonyConfigId || positiveIntEnv('DOGRAH_TELEPHONY_CONFIG_ID');
      fromPhoneNumberId = fromPhoneNumberId || positiveIntEnv('DOGRAH_PHONE_NUMBER_ID');
    }
    if (!telephonyConfigId || !fromPhoneNumberId) {
      throw new ProviderError(
        'Assign a Phone Number before placing an outbound call',
        422,
        'phone_number_required',
      );
    }

    // Optional pre-create so we know the run id before dialing. Off by default
    // because many Dograh builds create the run inside initiate-call. Soft-fail
    // when Dograh does not support POST /workflow/{id}/runs.
    let precreatedRunId = positiveIntOption(options.workflowRunId);
    if (!precreatedRunId && workflowId && options.precreateRun === true) {
      try {
        const created = await this.request('POST', `/api/v1/workflow/${workflowId}/runs`, {
          mode: 'vobiz',
        });
        if (created.up.status >= 200 && created.up.status < 300) {
          const id = extractProviderRunId(created.data, created.up.headers);
          if (id) precreatedRunId = positiveIntOption(id) || id;
        }
      } catch (_) {
        // Soft-fail: dial still proceeds without a pre-created id.
      }
    }

    const payload = {
      workflow_id: workflowId,
      telephony_configuration_id: telephonyConfigId,
      from_phone_number_id: fromPhoneNumberId,
      phone_number: phone,
    };
    if (precreatedRunId != null) {
      payload.workflow_run_id = typeof precreatedRunId === 'number'
        ? precreatedRunId
        : (positiveIntOption(precreatedRunId) || precreatedRunId);
    }

    const result = await this.request('POST', '/api/v1/telephony/initiate-call', payload);
    if (result.up.status < 200 || result.up.status >= 300) {
      throw new ProviderError('Dograh could not initiate the VoBiz call', upstreamStatus(result.up.status),
        'upstream', upstreamMessage(result.data, 'The call was not placed.'));
    }

    let providerRunId = extractProviderRunId(result.data, result.up.headers)
      || (precreatedRunId != null ? String(precreatedRunId) : null);
    const providerRunName = extractProviderRunName(result.data);

    // Optional inline reconcile (off unless options.reconcile === true) so unit
    // tests that only mock POST are not forced into live GETs.
    if (!providerRunId && workflowId && options.reconcile === true) {
      try {
        const resolved = await this.resolveProviderRunAfterDial({
          workflowId,
          phoneE164: phone,
          runName: providerRunName,
        });
        if (resolved) providerRunId = resolved;
      } catch (_) {
        // Soft-fail: dialAccepted stays true; sync can attach later.
      }
    }

    return {
      status: result.up.status,
      data: result.data,
      providerRunId: providerRunId != null ? String(providerRunId) : null,
      providerRunName: providerRunName || null,
      dialAccepted: true,
      ok: true,
    };
  },

  /**
   * After a successful initiate-call that omitted workflow_run_id, look up the
   * newest matching Dograh workflow run by run name and/or destination phone.
   * Returns the run id string, or null. Never invents an id.
   */
  async resolveProviderRunAfterDial({
    workflowId, phoneE164, runName, sinceMs = 180000, limit = 20,
  } = {}) {
    if (!hasEnv(this.needs)) return null;
    const wf = positiveIntOption(workflowId)
      || (() => { try { return positiveIntEnv('DOGRAH_WORKFLOW_ID'); } catch { return null; } })();
    if (!wf && !runName && !phoneE164) return null;
    const listed = await this.listCallRuns({ workflowId: wf || undefined, limit });
    if (listed.stubbed || !Array.isArray(listed.runs) || !listed.runs.length) return null;
    const matched = matchRecentWorkflowRun(listed.runs, {
      phoneE164,
      runName,
      sinceMs,
    });
    if (!matched || matched.id == null || matched.id === '') return null;
    return String(matched.id);
  },

  /**
   * Best-effort list of recent workflow runs / call logs from Dograh.
   * Prefers the real Dograh path GET /api/v1/workflow/{id}/runs (singular).
   * Returns { runs, endpoint, stubbed } without throwing when shapes are
   * uncertain (caller seeds demos only when Dograh is not live).
   */
  async listCallRuns(options = {}) {
    if (!hasEnv(this.needs)) {
      return { runs: [], endpoint: null, stubbed: true, reason: 'not_configured' };
    }
    const limit = Math.max(1, Math.min(100, Number(options.limit) || 20));
    const page = Math.max(1, Number(options.page) || 1);
    const workflowId = Number.isInteger(options.workflowId) && options.workflowId > 0
      ? options.workflowId
      : (() => { try { return positiveIntEnv('DOGRAH_WORKFLOW_ID'); } catch { return null; } })();

    const candidates = [];
    if (workflowId) {
      // Canonical Dograh path (singular workflow).
      candidates.push(`/api/v1/workflow/${workflowId}/runs?page=${page}&limit=${limit}`);
      // Legacy / mistaken plural path kept last for older forks.
      candidates.push(`/api/v1/workflows/${workflowId}/runs?limit=${limit}`);
    }
    candidates.push(
      `/api/v1/workflow-runs?limit=${limit}`,
      `/api/v1/telephony/calls?limit=${limit}`,
    );

    for (const pathname of candidates) {
      try {
        const result = await this.request('GET', pathname);
        if (result.up.status < 200 || result.up.status >= 300) continue;
        const data = result.data || {};
        const runs = Array.isArray(data.runs) ? data.runs
          : Array.isArray(data.workflow_runs) ? data.workflow_runs
            : Array.isArray(data.calls) ? data.calls
              : Array.isArray(data.items) ? data.items
                : Array.isArray(data) ? data
                  : [];
        if (!runs.length && !Array.isArray(data.runs) && !Array.isArray(data.calls)
          && !Array.isArray(data.workflow_runs) && !Array.isArray(data.items)
          && !Array.isArray(data)) {
          // Endpoint responded but shape unknown. Keep trying.
          continue;
        }
        return { runs, endpoint: pathname, stubbed: false, workflowId };
      } catch (_) {
        // Try the next candidate.
      }
    }
    return {
      runs: [],
      endpoint: null,
      stubbed: true,
      reason: 'endpoints_unreachable_or_unknown_shape',
      tried: candidates,
      workflowId,
    };
  },

  async getCallRun(runId, options = {}) {
    if (!hasEnv(this.needs)) {
      return { run: null, stubbed: true, reason: 'not_configured' };
    }
    const id = encodeURIComponent(String(runId || '').trim());
    if (!id) return { run: null, stubbed: true, reason: 'missing_id' };
    const workflowId = Number.isInteger(options.workflowId) && options.workflowId > 0
      ? options.workflowId
      : (() => { try { return positiveIntEnv('DOGRAH_WORKFLOW_ID'); } catch { return null; } })();
    const candidates = [];
    if (workflowId) {
      candidates.push(`/api/v1/workflow/${workflowId}/runs/${id}`);
      candidates.push(`/api/v1/workflows/${workflowId}/runs/${id}`);
    }
    candidates.push(
      `/api/v1/workflow-runs/${id}`,
      `/api/v1/telephony/calls/${id}`,
    );
    for (const pathname of candidates) {
      try {
        const result = await this.request('GET', pathname);
        if (result.up.status < 200 || result.up.status >= 300) continue;
        return { run: result.data, endpoint: pathname, stubbed: false };
      } catch (_) { /* next */ }
    }
    return { run: null, stubbed: true, reason: 'not_found_or_unreachable', tried: candidates };
  },

  async getCallRecording(runId, options = {}) {
    if (!hasEnv(this.needs)) {
      return { available: false, stubbed: true, reason: 'not_configured' };
    }
    const id = encodeURIComponent(String(runId || '').trim());
    if (!id) return { available: false, stubbed: true, reason: 'missing_id' };
    const workflowId = Number.isInteger(options.workflowId) && options.workflowId > 0
      ? options.workflowId
      : (() => { try { return positiveIntEnv('DOGRAH_WORKFLOW_ID'); } catch { return null; } })();
    const candidates = [];
    if (workflowId) {
      candidates.push(`/api/v1/workflow/${workflowId}/runs/${id}/recording`);
      candidates.push(`/api/v1/workflow/${workflowId}/runs/${id}`);
    }
    candidates.push(
      `/api/v1/workflow-runs/${id}/recording`,
      `/api/v1/telephony/calls/${id}/recording`,
    );
    for (const pathname of candidates) {
      try {
        const connection = dograhConnection();
        const headers = { 'X-API-Key': process.env.DOGRAH_API_KEY };
        const up = await httpsGet(connection.host, connection.prefix + pathname, headers);
        if (up.status < 200 || up.status >= 300) continue;
        const contentType = String(up.headers['content-type'] || 'application/octet-stream');
        if (contentType.includes('json')) {
          const data = parseJsonResponse(up);
          const url = data.url || data.recording_url || data.recordingUrl
            || (data.recording && (data.recording.url || data.recording.mixed))
            || null;
          if (url && /^https?:\/\//i.test(String(url))) {
            return { available: true, redirectUrl: url, endpoint: pathname, stubbed: false };
          }
          // Detail endpoint may only confirm availability via storage keys.
          if (data.recording || data.recording_url || data.has_recording) {
            continue;
          }
          continue;
        }
        return {
          available: true,
          buffer: up.buffer,
          contentType,
          endpoint: pathname,
          stubbed: false,
        };
      } catch (_) { /* next */ }
    }
    return { available: false, stubbed: true, reason: 'not_found_or_unreachable', tried: candidates };
  },
};

/* ==========================================================================
   Registries + lookups + describeProviders for GET /api/providers
   ========================================================================== */

const registries = { stt: {}, tts: {}, llm: {}, telephony: {} };
const requiredMethods = {
  stt: ['transcribe', 'mintToken'],
  tts: ['synthesize', 'wsConnect'],
  llm: ['chat'],
  telephony: ['status', 'dial', 'initiateCall'],
};

function registerProvider(layer, adapter, options = {}) {
  if (!PROVIDER_LAYERS.has(layer)) {
    throw new ProviderError(`Unknown provider layer: ${layer}`, 500, 'invalid_provider_layer');
  }
  if (!adapter || adapter.implemented !== true || adapter.layer !== layer || !PROVIDER_ID_RE.test(String(adapter.id || ''))) {
    throw new ProviderError(`Invalid ${layer} provider adapter`, 500, 'invalid_provider_adapter');
  }
  for (const method of requiredMethods[layer]) {
    if (typeof adapter[method] !== 'function') {
      throw new ProviderError(`${adapter.id} does not implement ${layer}.${method}`, 500, 'invalid_provider_adapter');
    }
  }
  if (registries[layer][adapter.id] && !options.replace) {
    throw new ProviderError(`${layer} provider ${adapter.id} is already registered`, 409, 'duplicate_provider');
  }
  registries[layer][adapter.id] = adapter;
  return adapter;
}

registerProvider('stt', sttDeepgram);
registerProvider('tts', ttsRumik);
registerProvider('llm', llmGroq);
registerProvider('llm', llmGemini);
registerProvider('telephony', telVobiz);

function configuredDefaultId(layer) {
  if (layer === 'stt') return 'deepgram';
  const envName = `${layer.toUpperCase()}_PROVIDER`;
  return String(process.env[envName] || ({ tts: 'rumik', llm: 'groq', telephony: 'vobiz' })[layer] || '').trim().toLowerCase();
}

function get(layer, id) {
  if (!PROVIDER_LAYERS.has(layer)) {
    throw new ProviderError(`Unknown provider layer: ${layer}`, 422, 'invalid_provider_layer');
  }
  const providerId = String(id || configuredDefaultId(layer)).trim().toLowerCase();
  if (layer === 'stt' && providerId !== 'deepgram') {
    throw new ProviderError('Deepgram is the only supported STT provider', 422, 'stt_provider_fixed');
  }
  const adapter = registries[layer][providerId];
  if (!adapter) {
    throw new ProviderError(`Unsupported ${layer} provider: ${providerId}`, 422, 'unsupported_provider');
  }
  return adapter;
}

// Resolve a tenant-safe selection. Only provider and model identifiers are
// accepted. Provider secrets always come from server-side environment values.
function resolveSelection(layer, selection = {}) {
  if (!selection || typeof selection !== 'object' || Array.isArray(selection)) {
    throw new ProviderError('Provider selection must be an object', 422, 'invalid_provider_selection');
  }
  const allowed = new Set(['provider', 'model']);
  const secretLike = Object.keys(selection).find((key) => !allowed.has(key));
  if (secretLike) {
    throw new ProviderError(`Provider selection cannot include ${secretLike}`, 422, 'unsafe_provider_selection');
  }
  const adapter = get(layer, selection.provider);
  const resolved = { provider: adapter.id, adapter };
  if (layer === 'llm' || layer === 'tts' || layer === 'stt') {
    resolved.model = selectedModel(adapter, selection.model);
  }
  return resolved;
}

// Convenience accessors preserve the existing route contract while making the
// LLM and TTS defaults environment-selectable at process start.
const stt = get('stt');
const tts = get('tts');
const llm = get('llm');
const telephony = get('telephony');

// Shape used by GET /api/providers so the UI can render active vs ready-to-wire.
function describeProviders() {
  const out = {};
  for (const [layer, reg] of Object.entries(registries)) {
    out[layer] = Object.values(reg).map((a) => ({
      id: a.id,
      label: a.label,
      implemented: true,
      live: a.live,
      selected: a.id === configuredDefaultId(layer),
      model: (layer === 'llm' || layer === 'tts' || layer === 'stt') ? selectedModel(a) : undefined,
      needs: a.needs,
    }));
  }
  return out;
}

module.exports = {
  ProviderError,
  registries, registerProvider, get, resolveSelection, describeProviders,
  stt, tts, llm, telephony,
  MAX_TEXT, TTS_MODELS, TTS_SPEAKERS,
  BROWSER_UA, MODEL_ID_RE,
  extractProviderRunId, extractProviderRunName, matchRecentWorkflowRun,
  phoneMatchKey, positiveIntOption,
};
