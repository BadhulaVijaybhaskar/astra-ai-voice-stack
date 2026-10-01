/**
 * Browser Talk TTS mint resolver (LATENCY P0.3).
 *
 * Live Hostinger evidence: Rumik WS mint with model `mulberry` returns
 * unsupported_model. The voice that works for measure is Sarvam HTTP
 * bulbul:v3 speaker priya (frozen). Rumik cannot carry Sarvam priya.
 *
 * This module is employee-agnostic. No employee-named symbols. Shared seam
 * for Calling fold (phrase budget / barge-in polish / measure harness).
 *
 * Customer mint JSON exposes mode/model/speaker/stream_path only. Never
 * Dograh / VoBiz / Rumik vendor ids in customer-facing mint payloads.
 *
 * No em dashes. Commas and periods only.
 */
'use strict';

/** Frozen realtime Browser Talk voice (production measure path). */
const FROZEN_REALTIME_TTS = Object.freeze({
  provider: 'sarvam',
  model: 'bulbul:v3',
  speaker: 'priya',
  language: 'en-IN',
});

/** Rumik Silk models historically advertised by our adapters. */
const RUMIK_MODELS = new Set(['mulberry', 'muga']);
/** Sarvam Bulbul models used by Dograh overlay + Browser Talk. */
const SARVAM_MODELS = new Set(['bulbul:v3', 'bulbul:v2']);

/**
 * True when a requested model is a known-dead Rumik WS default for Browser Talk.
 * Live evidence: silk-api mulberry mint → unsupported_model.
 */
function isDeadRumikModel(model) {
  return RUMIK_MODELS.has(String(model || '').trim().toLowerCase());
}

/**
 * Resolve Browser Talk mint selection.
 *
 * Prefer explicit Sarvam bulbul + speaker. Remap Rumik mulberry/muga (and
 * blank/legacy defaults) onto frozen bulbul:v3 / priya so mint never opens a
 * dead Rumik WS that throws unsupported_model.
 *
 * @param {object} input - { provider?, model?, speaker?, voice_id?, language? }
 * @returns {{ provider: string, model: string, speaker: string, language: string,
 *   mode: 'http_stream', remapped_from: string|null, reason: string }}
 */
function resolveMintSelection(input = {}) {
  const requestedProvider = String(input.provider || '').trim().toLowerCase();
  const requestedModel = String(input.model || '').trim();
  const requestedSpeaker = String(
    input.speaker || input.voice_id || '',
  ).trim().toLowerCase();
  const language = String(input.language || input.language_code || FROZEN_REALTIME_TTS.language)
    .trim()
    .slice(0, 16) || FROZEN_REALTIME_TTS.language;

  // Explicit Sarvam path: keep model if supported, freeze speaker to priya when
  // blank or when caller still carries a Rumik speaker_* id.
  if (requestedProvider === 'sarvam' || SARVAM_MODELS.has(requestedModel)) {
    const model = SARVAM_MODELS.has(requestedModel)
      ? requestedModel
      : FROZEN_REALTIME_TTS.model;
    const speaker = (!requestedSpeaker || /^speaker_\d+$/.test(requestedSpeaker))
      ? FROZEN_REALTIME_TTS.speaker
      : requestedSpeaker;
    return {
      provider: 'sarvam',
      model,
      speaker,
      language,
      mode: 'http_stream',
      remapped_from: null,
      reason: 'explicit_sarvam_or_bulbul',
    };
  }

  // Rumik / mulberry / muga / blank → frozen Sarvam HTTP stream (priya).
  // Rumik WS cannot synthesize Sarvam priya; do not mint a dead WS.
  if (
    !requestedProvider
    || requestedProvider === 'rumik'
    || isDeadRumikModel(requestedModel)
    || !requestedModel
  ) {
    return {
      provider: FROZEN_REALTIME_TTS.provider,
      model: FROZEN_REALTIME_TTS.model,
      speaker: FROZEN_REALTIME_TTS.speaker,
      language,
      mode: 'http_stream',
      remapped_from: requestedModel || requestedProvider || 'default_rumik_mulberry',
      reason: 'rumik_ws_unsupported_remap_to_sarvam_http',
    };
  }

  // Unknown provider/model: still land on frozen path rather than a dead WS.
  return {
    provider: FROZEN_REALTIME_TTS.provider,
    model: FROZEN_REALTIME_TTS.model,
    speaker: FROZEN_REALTIME_TTS.speaker,
    language,
    mode: 'http_stream',
    remapped_from: `${requestedProvider}:${requestedModel}` || 'unknown',
    reason: 'fallback_frozen_realtime_tts',
  };
}

/**
 * Customer-safe mint payload for POST /api/ws-connect.
 * Omits vendor provider ids (Dograh / VoBiz / Rumik). Model + speaker only.
 */
function buildCustomerMintPayload(selection, extras = {}) {
  const sel = selection && typeof selection === 'object'
    ? selection
    : resolveMintSelection(selection);
  return {
    mode: 'http_stream',
    model: sel.model || FROZEN_REALTIME_TTS.model,
    speaker: sel.speaker || FROZEN_REALTIME_TTS.speaker,
    language: sel.language || FROZEN_REALTIME_TTS.language,
    stream_path: '/api/tts/stream',
    // No ws_url: dead Rumik WS path removed for Browser Talk production voice.
    ws_url: null,
    token: null,
    early_audio: true,
    full_wav_buffer: false,
    note: 'Browser Talk uses Sarvam HTTP stream (bulbul:v3). Rumik WS mulberry is unsupported and remapped.',
    keep_alive: true,
    remapped_from: sel.remapped_from || null,
    ...extras,
  };
}

/**
 * Assert mint payload is the supported Browser Talk voice (priya / bulbul:v3).
 * Used by unit tests so the unsupported_model regression cannot return silently.
 */
function assertMintMapsToPriya(mint) {
  const m = mint && typeof mint === 'object' ? mint : {};
  const model = String(m.model || '');
  const speaker = String(m.speaker || m.voice_id || '').toLowerCase();
  const mode = String(m.mode || '');
  const ok = model === FROZEN_REALTIME_TTS.model
    && speaker === FROZEN_REALTIME_TTS.speaker
    && mode === 'http_stream'
    && !m.ws_url;
  return {
    ok,
    model,
    speaker,
    mode,
    expected: {
      model: FROZEN_REALTIME_TTS.model,
      speaker: FROZEN_REALTIME_TTS.speaker,
      mode: 'http_stream',
      ws_url: null,
    },
  };
}

module.exports = {
  FROZEN_REALTIME_TTS,
  RUMIK_MODELS,
  SARVAM_MODELS,
  isDeadRumikModel,
  resolveMintSelection,
  buildCustomerMintPayload,
  assertMintMapsToPriya,
};
