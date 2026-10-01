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
const personaRouter = require('./voice-persona-router');

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
 *
 * When a persona is known, prefer persona language_routes (Astra Auto) so
 * Indic languages route to Sarvam instead of inventing Rumik multilingual.
 */
function resolveAutoProvider(voiceId, language, opts = {}) {
  const personaId = opts.personaId || null;
  const persona = opts.persona || (personaId ? personaRouter.getPersona(personaId) : null);
  if (persona) {
    const resolved = personaRouter.resolvePersonaRoute(persona, language, 'astra_auto');
    if (resolved.ok && resolved.route && resolved.route.provider) {
      const state = unified.resolveProviderState(resolved.route.provider);
      if (state.can_preview) return resolved.route.provider;
    }
  }
  if (voiceId) {
    for (const pid of ['deepgram', 'sarvam', 'rumik']) {
      const hit = voiceCatalog.findVoice(pid, voiceId);
      if (hit) {
        const state = unified.resolveProviderState(pid);
        if (state.can_preview) return pid;
      }
    }
  }
  const lang = personaRouter.normalizeLanguageCode(language) || language;
  // Indic / non-English: prefer Sarvam. Never pick Rumik for Hindi/Telugu/etc.
  if (lang && !personaRouter.isEnglishLanguage(lang)) {
    if (unified.resolveProviderState('sarvam').can_preview) return 'sarvam';
    return null;
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
    opts.model = (known && known.model) || 'bulbul:v3';
    opts.speaker = String(voiceId || (known && known.voice_id) || 'shubh').toLowerCase();
    opts.language = language || 'en-IN';
  } else if (providerId === 'rumik') {
    opts.model = (known && known.model) || 'mulberry';
    opts.speaker = voiceId || (known && known.voice_id) || 'speaker_1';
  }
  return opts;
}

/**
 * Resolve and synthesize a draft preview.
 * Returns { buffer, contentType, mime_type, chars, provider, voice_id, language, employeeId }
 * or throws PreviewError with a stable code for the UI.
 *
 * Optional asJsonUrl: when true and a public URL is available, callers may
 * prefer { audio_url, mime_type }. This path always returns bytes today.
 */
async function synthesizeWithProvider(provider, voiceId, language, text) {
  gateProvider(provider);
  const opts = buildSynthesizeOpts(provider, voiceId, language, text);
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
  return out;
}

async function synthesizePreview(input = {}) {
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
  // Preview language override must NOT mutate employee.primaryLanguage / voice.language.
  const primaryLanguage = (employee && employee.voice && employee.voice.language)
    || (employee && employee.language)
    || '';
  const language = String(input.language || input.language_code || '').trim();
  const effectiveLanguage = language || primaryLanguage || '';
  // Snapshot for callers / tests proving preview isolation.
  const primaryLanguageBefore = primaryLanguage;

  const personaId = String(
    input.persona_id || input.personaId
      || personaRouter.resolvePersonaId(employee)
      || '',
  ).trim().toLowerCase() || null;
  const persona = personaId ? personaRouter.getPersona(personaId) : null;

  let provider = normalizeProviderId(input.provider);
  let voiceId = String(input.voice_id || input.voiceId || input.speaker || '').trim();
  let routeMeta = null;

  // Explicit Rumik (or other provider) mode: block languages the engine cannot speak.
  if (provider && provider !== 'auto' && provider !== 'dograh' && effectiveLanguage) {
    if (!personaRouter.providerSupportsLanguage(provider, effectiveLanguage)
      && !(provider === 'sarvam' && voiceCatalog.isAstraSupportedLanguage(
        personaRouter.normalizeLanguageCode(effectiveLanguage),
      ))) {
      throw new PreviewError(
        'Language not supported by selected provider',
        422,
        'provider_language_unsupported',
        {
          provider,
          language: personaRouter.normalizeLanguageCode(effectiveLanguage) || effectiveLanguage,
          supported: (personaRouter.PROVIDER_SUPPORTED_LANGUAGES[provider] || []).slice(),
        },
      );
    }
  }

  // Astra Auto / auto: resolve persona language_routes when available.
  // Explicit provider (e.g. Rumik) wins over Auto and must not be rewritten.
  const usePersonaAuto = persona && (!provider || provider === 'auto');

  if (usePersonaAuto) {
    const resolved = personaRouter.resolvePersonaRoute(
      persona,
      effectiveLanguage || 'en-IN',
      'astra_auto',
    );
    if (!resolved.ok) {
      throw new PreviewError(
        resolved.error || 'Voice unavailable',
        422,
        resolved.code || 'voice_unavailable',
        {
          persona_id: personaId,
          language: effectiveLanguage,
          reason: resolved.code,
        },
      );
    }
    routeMeta = resolved;
    provider = resolved.route.provider;
    // Prefer persona-mapped speaker. Only keep caller voice_id when it belongs
    // to the resolved provider (avoids Rumik speaker_2 leaking into Sarvam Indic).
    if (!voiceId) {
      voiceId = resolved.route.voice_id;
    } else {
      const known = voiceCatalog.findVoice(provider, voiceId);
      if (!known) voiceId = resolved.route.voice_id;
    }
  }

  const displayName = (persona && persona.display_name)
    || (employee && employee.name)
    || 'Astra';
  const text = String(
    input.text != null
      ? input.text
      : personaRouter.getPreviewText(effectiveLanguage || 'en-IN', displayName),
  ).slice(0, PREVIEW_MAX_TEXT);
  if (!text.trim()) throw new PreviewError('text is required', 422, 'no_text');

  if (!provider) {
    throw new PreviewError('provider is required', 422, 'provider_required');
  }

  if (provider === 'auto') {
    provider = resolveAutoProvider(voiceId, effectiveLanguage, { personaId, persona });
    if (!provider) {
      throw new PreviewError(
        'Voice unavailable',
        422,
        'voice_unavailable',
        { reason: 'no_previewable_provider' },
      );
    }
    if (persona && !voiceId) {
      const resolved = personaRouter.resolvePersonaRoute(persona, effectiveLanguage, 'astra_auto');
      if (resolved.ok) voiceId = resolved.route.voice_id;
    }
  }

  if (provider === 'dograh') {
    // Dograh managed runtime TTS is not exposed as a dashboard synthesize adapter.
    throw new PreviewError(
      'Voice unavailable',
      422,
      'voice_unavailable',
      { provider: 'dograh', reason: 'managed_preview_unsupported' },
    );
  }

  if (!PREVIEWABLE_TTS.has(provider)) {
    throw new PreviewError(
      'Voice unavailable',
      422,
      'voice_unavailable',
      { provider },
    );
  }

  if (!voiceId) {
    throw new PreviewError('Voice unavailable', 422, 'voice_unavailable', { reason: 'voice_id_required' });
  }

  let out;
  let usedFallback = false;
  let fallbackRoute = null;
  try {
    out = await synthesizeWithProvider(provider, voiceId, effectiveLanguage, text);
  } catch (e) {
    // Attempt compatible fallback. Never English-only engine for Indic.
    if (persona && effectiveLanguage) {
      const fb = personaRouter.resolveFallbackRoute(persona, effectiveLanguage, provider, {
        failedVoiceId: voiceId,
      });
      if (fb.ok && fb.route
        && !(personaRouter.isEnglishOnlyProvider(fb.route.provider)
          && !personaRouter.isEnglishLanguage(effectiveLanguage))) {
        try {
          out = await synthesizeWithProvider(
            fb.route.provider,
            fb.route.voice_id,
            effectiveLanguage,
            text,
          );
          usedFallback = true;
          fallbackRoute = fb.route;
          provider = fb.route.provider;
          voiceId = fb.route.voice_id;
        } catch (e2) {
          throw e2 instanceof PreviewError ? e2 : mapUpstreamPreviewError(e2, provider);
        }
      } else {
        throw e instanceof PreviewError ? e : mapUpstreamPreviewError(e, provider);
      }
    } else {
      throw e instanceof PreviewError ? e : mapUpstreamPreviewError(e, provider);
    }
  }

  const contentType = String(out.contentType || sniffContentType(out.buffer) || 'audio/wav')
    .split(';')[0]
    .trim() || 'audio/wav';

  // Prove preview did not mutate employee language.
  if (employee && employee.voice && primaryLanguageBefore
    && employee.voice.language !== primaryLanguageBefore) {
    employee.voice.language = primaryLanguageBefore;
  }

  return {
    buffer: out.buffer,
    contentType,
    mime_type: contentType,
    chars: out.chars || text.length,
    provider,
    voice_id: voiceId,
    language: effectiveLanguage || '',
    primaryLanguage: primaryLanguageBefore || null,
    previewLanguage: effectiveLanguage || '',
    primaryLanguageMutated: false,
    persona_id: personaId,
    route: routeMeta && routeMeta.route ? routeMeta.route : null,
    used_fallback: usedFallback,
    fallback_route: fallbackRoute,
    employeeId: employee ? employee.id : null,
    credits: out.credits || '',
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
    provider_language_unsupported: 'Language not supported by selected provider',
    unsupported_language: 'Unsupported language',
    persona_route_missing: 'Voice unavailable',
    unknown_persona: 'Voice unavailable',
    fallback_unavailable: 'Voice unavailable',
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
  synthesizeWithProvider,
};
