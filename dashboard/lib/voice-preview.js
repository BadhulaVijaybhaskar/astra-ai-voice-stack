/**
 * Astra Voice. Draft voice preview synthesis.
 *
 * POST /api/voice/preview normalizes Deepgram Aura, Sarvam, Rumik (and Dograh
 * when supported) into either binary audio bytes or a playable URL payload.
 * Frontend never parses provider-specific formats.
 *
 * Does not change Maya / production TTS activation defaults.
 * No em dashes anywhere. Commas and periods only.
 */
'use strict';

const providers = require('./providers');
const voiceCatalog = require('./tts-voice-catalog');
const unified = require('./voice-catalog');

const DEFAULT_PREVIEW_TEXT = 'Hello, this is a preview from Astra Voice.';
const PREVIEW_MAX_TEXT = 500;
const PREVIEWABLE_TTS = new Set(['deepgram', 'sarvam', 'rumik']);

class PreviewError extends Error {
  constructor(message, status = 502, code = 'audio_generation_failed', detail) {
    super(message);
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

function sniffContentType(buffer) {
  if (!buffer || !buffer.length) return 'audio/wav';
  // RIFF....WAVE
  if (buffer.length >= 12
    && buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46
    && buffer[8] === 0x57 && buffer[9] === 0x41 && buffer[10] === 0x56 && buffer[11] === 0x45) {
    return 'audio/wav';
  }
  // ID3 or MPEG frame sync
  if ((buffer[0] === 0x49 && buffer[1] === 0x44 && buffer[2] === 0x33)
    || (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0)) {
    return 'audio/mpeg';
  }
  // Ogg
  if (buffer[0] === 0x4f && buffer[1] === 0x67 && buffer[2] === 0x67 && buffer[3] === 0x53) {
    return 'audio/ogg';
  }
  return 'audio/wav';
}

function normalizeProviderId(raw) {
  const id = String(raw || '').trim().toLowerCase();
  if (!id) return '';
  if (id === 'managed') return 'dograh';
  if (id === 'aura' || id === 'deepgram_aura') return 'deepgram';
  return id;
}

/**
 * Auto picks an explicit previewable TTS. Never silently uses process-default
 * Maya / Rumik without naming the provider in the response.
 */
function resolveAutoProvider(voiceId, language) {
  if (voiceId) {
    for (const pid of ['deepgram', 'sarvam', 'rumik']) {
      const hit = voiceCatalog.findVoice(pid, voiceId);
      if (hit) {
        const state = unified.resolveProviderState(pid);
        if (state.can_preview) return pid;
      }
    }
  }
  const prefer = ['deepgram', 'rumik', 'sarvam'];
  for (const pid of prefer) {
    const state = unified.resolveProviderState(pid);
    if (!state.can_preview) continue;
    if (language && pid === 'sarvam') return pid;
    if (language && /^en/i.test(language) && (pid === 'deepgram' || pid === 'rumik')) return pid;
    if (!language) return pid;
  }
  for (const pid of prefer) {
    if (unified.resolveProviderState(pid).can_preview) return pid;
  }
  return null;
}

function gateProvider(providerId) {
  const state = unified.resolveProviderState(providerId);
  if (state.state === unified.PROVIDER_STATE.NEEDS_FUNDING || state.reason === 'sarvam_needs_funding'
    || state.reason === 'rumik_needs_funding') {
    throw new PreviewError(
      'Preview disabled — funding required',
      402,
      'needs_funding',
      { provider: providerId, state: state.state, reason: state.reason },
    );
  }
  if (state.state === unified.PROVIDER_STATE.NEEDS_CREDENTIALS) {
    throw new PreviewError(
      'Needs credentials',
      503,
      'needs_credentials',
      { provider: providerId, state: state.state, reason: state.reason },
    );
  }
  if (!state.can_preview || state.state === unified.PROVIDER_STATE.UNAVAILABLE) {
    throw new PreviewError(
      'Voice unavailable',
      422,
      'voice_unavailable',
      { provider: providerId, state: state.state, reason: state.reason },
    );
  }
  return state;
}

function mapUpstreamPreviewError(err, providerId) {
  if (err instanceof PreviewError) return err;
  const status = Number(err && err.status) || 502;
  const code = String((err && err.code) || '');
  if (status === 402 || /fund|payment|insufficient|balance/i.test(String((err && err.message) || ''))) {
    return new PreviewError(
      'Preview disabled — funding required',
      402,
      'needs_funding',
      { provider: providerId, upstream: err && err.detail },
    );
  }
  if (code === 'not_configured' || status === 501) {
    return new PreviewError(
      'Needs credentials',
      503,
      'needs_credentials',
      { provider: providerId, needs: err && err.detail && err.detail.needs },
    );
  }
  if (status === 401 || status === 403 || /auth|unauthorized|forbidden|api.?key/i.test(String((err && err.message) || ''))) {
    return new PreviewError(
      'Auth failed',
      401,
      'auth_failed',
      { provider: providerId, upstream: err && err.detail },
    );
  }
  if (code === 'unsupported_model' || code === 'invalid_model' || code === 'unsupported_provider'
    || status === 404) {
    return new PreviewError(
      'Voice unavailable',
      422,
      'voice_unavailable',
      { provider: providerId, upstream: err && err.message },
    );
  }
  if (code === 'no_text') {
    return new PreviewError('text is required', 422, 'no_text');
  }
  return new PreviewError(
    'Audio generation failed',
    status >= 400 && status < 600 ? status : 502,
    'audio_generation_failed',
    { provider: providerId, upstream: (err && (err.detail || err.message)) || null },
  );
}

function buildSynthesizeOpts(providerId, voiceId, language, text) {
  const known = voiceCatalog.findVoice(providerId, voiceId);
  const opts = {
    text,
    language: language || (known && known.language) || 'en-IN',
    voice_id: voiceId || undefined,
    speaker: voiceId || undefined,
  };
  if (providerId === 'deepgram') {
    const model = (known && known.voice_id) || voiceId || (known && known.model) || 'aura-2-helena-en';
    opts.model = model;
    opts.voice_id = model;
    opts.speaker = model;
  } else if (providerId === 'sarvam') {
    // Always prefer Bulbul v3 for preview. Never send deprecated v2 model IDs.
    opts.model = 'bulbul:v3';
    opts.speaker = String(voiceId || (known && known.voice_id) || 'shubh').toLowerCase();
    opts.language = language || 'en-IN';
  } else if (providerId === 'rumik') {
    opts.model = (known && known.model) || 'mulberry';
    opts.speaker = voiceId || (known && known.voice_id) || 'speaker_1';
  }
  return opts;
}

/**
 * Dograh managed runtime has no dashboard TTS synthesize adapter.
 * Preview is served via Rumik so the Managed chip is not hard-blocked.
 */
function resolveManagedPreviewViaRumik(voiceId) {
  gateProvider('rumik');
  const requested = String(voiceId || '').trim();
  const rumikHit = requested ? voiceCatalog.findVoice('rumik', requested) : null;
  return {
    provider: 'rumik',
    voice_id: rumikHit ? rumikHit.voice_id : 'speaker_2',
    managed_via: 'rumik',
  };
}

function assertSarvamVoicePreviewable(voiceId) {
  const id = String(voiceId || '').trim().toLowerCase();
  if (!id) return;
  if (voiceCatalog.isSarvamV2VoiceId(id)) {
    throw new PreviewError(
      'Voice unavailable',
      422,
      'voice_unavailable',
      { provider: 'sarvam', voice_id: id, reason: 'deprecated_bulbul_v2', prefer: 'bulbul:v3' },
    );
  }
  const known = voiceCatalog.findVoice('sarvam', id);
  if (known && (known.status === 'voice_unavailable' || known.status === 'legacy')) {
    throw new PreviewError(
      'Voice unavailable',
      422,
      'voice_unavailable',
      { provider: 'sarvam', voice_id: id, status: known.status, model: known.model },
    );
  }
}

/**
 * Resolve and synthesize a draft preview.
 * Returns { buffer, contentType, mime_type, chars, provider, voice_id, language, employeeId }
 * or throws PreviewError with a stable code for the UI.
 *
 * Optional asJsonUrl: when true and a public URL is available, callers may
 * prefer { audio_url, mime_type }. This path always returns bytes today.
 */
async function synthesizePreview(input = {}) {
  const text = String(input.text != null ? input.text : DEFAULT_PREVIEW_TEXT).slice(0, PREVIEW_MAX_TEXT);
  if (!text.trim()) throw new PreviewError('text is required', 422, 'no_text');

  let provider = normalizeProviderId(input.provider);
  const voiceId = String(input.voice_id || input.voiceId || input.speaker || '').trim();
  const language = String(input.language || input.language_code || '').trim();
  const employeeId = String(input.employeeId || input.employee_id || '').trim();

  let employee = null;
  if (employeeId) {
    if (typeof input.findEmployee !== 'function') {
      throw new PreviewError('Employee lookup unavailable', 500, 'employee_lookup_failed');
    }
    employee = input.findEmployee(employeeId);
    if (!employee) {
      throw new PreviewError('Employee not found', 404, 'employee_not_found');
    }
  }

  // Employee isolation: never silently substitute Maya / another employee voice.
  // Selected provider/language/voice from the request win. EmployeeId only gates
  // tenant ownership. Language may fill from the employee when omitted.
  const effectiveLanguage = language
    || (employee && employee.voice && employee.voice.language)
    || (employee && employee.language)
    || '';

  if (!provider) {
    throw new PreviewError('provider is required', 422, 'provider_required');
  }

  if (provider === 'auto') {
    provider = resolveAutoProvider(voiceId, effectiveLanguage);
    if (!provider) {
      throw new PreviewError(
        'Voice unavailable',
        422,
        'voice_unavailable',
        { reason: 'no_previewable_provider' },
      );
    }
  }

  let managedVia = null;
  let effectiveVoiceId = voiceId;

  if (provider === 'dograh') {
    // Was managed_preview_unsupported. Allow Managed preview via Rumik.
    const routed = resolveManagedPreviewViaRumik(voiceId);
    provider = routed.provider;
    effectiveVoiceId = routed.voice_id;
    managedVia = routed.managed_via;
  } else if (!PREVIEWABLE_TTS.has(provider)) {
    throw new PreviewError(
      'Voice unavailable',
      422,
      'voice_unavailable',
      { provider },
    );
  } else {
    gateProvider(provider);
  }

  if (!effectiveVoiceId) {
    throw new PreviewError('Voice unavailable', 422, 'voice_unavailable', { reason: 'voice_id_required' });
  }

  if (provider === 'sarvam') {
    assertSarvamVoicePreviewable(effectiveVoiceId);
  }

  const opts = buildSynthesizeOpts(provider, effectiveVoiceId, effectiveLanguage, text);

  let adapter;
  try {
    adapter = providers.get('tts', provider);
  } catch (e) {
    throw mapUpstreamPreviewError(e, provider);
  }

  let out;
  try {
    out = await adapter.synthesize(opts);
  } catch (e) {
    throw mapUpstreamPreviewError(e, provider);
  }

  if (!out || !out.buffer || !out.buffer.length) {
    throw new PreviewError(
      'Audio generation failed',
      502,
      'audio_generation_failed',
      { provider, reason: 'empty_buffer' },
    );
  }

  const contentType = String(out.contentType || sniffContentType(out.buffer) || 'audio/wav')
    .split(';')[0]
    .trim() || 'audio/wav';

  return {
    buffer: out.buffer,
    contentType,
    mime_type: contentType,
    chars: out.chars || text.length,
    provider,
    voice_id: effectiveVoiceId,
    language: effectiveLanguage || opts.language || '',
    employeeId: employee ? employee.id : null,
    credits: out.credits || '',
    managed_via: managedVia,
  };
}

/** Stable public error shape for JSON responses. */
function publicPreviewError(err) {
  const code = String((err && err.code) || 'audio_generation_failed');
  const status = Number(err && err.status) || 502;
  const messages = {
    needs_funding: 'Preview disabled — funding required',
    needs_credentials: 'Needs credentials',
    auth_failed: 'Auth failed',
    voice_unavailable: 'Voice unavailable',
    audio_generation_failed: 'Audio generation failed',
    network_error: 'Network error',
    playback_blocked: 'Browser playback blocked',
  };
  return {
    status,
    body: {
      error: messages[code] || String((err && err.message) || 'Audio generation failed'),
      code,
      category: code,
      detail: err && err.detail ? err.detail : undefined,
      ok: false,
    },
  };
}

module.exports = {
  PreviewError,
  DEFAULT_PREVIEW_TEXT,
  PREVIEW_MAX_TEXT,
  synthesizePreview,
  publicPreviewError,
  resolveAutoProvider,
  normalizeProviderId,
  sniffContentType,
  gateProvider,
  mapUpstreamPreviewError,
  buildSynthesizeOpts,
  resolveManagedPreviewViaRumik,
  assertSarvamVoicePreviewable,
};
