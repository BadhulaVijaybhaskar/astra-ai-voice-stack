/**
 * Astra Voice. Call-scoped voice lock sessions.
 *
 * One routing path for Browser Talk, inbound PSTN, and outbound PSTN:
 *   start → establish voice_lock from persona starting route (or pipeline TTS)
 *   mid-call language switch → same provider + speaker when supported
 *   end → drop lock (never persist voice_lock onto contact / next call)
 *
 * preferred_language may seed the NEXT call's initial language only.
 * voice_switch_policy defaults to locked (Astra + Maya).
 *
 * Does NOT mutate Maya production TTS / Dograh WF8.
 * Does NOT place PSTN.
 * No em dashes anywhere. Commas and periods only.
 */
'use strict';

const crypto = require('crypto');
const personaRouter = require('./voice-persona-router');

/** In-memory active call voice sessions. Not durable across process restarts. */
const ACTIVE = new Map();

const CHANNELS = Object.freeze({
  BROWSER: 'browser',
  INBOUND_PSTN: 'inbound_pstn',
  OUTBOUND_PSTN: 'outbound_pstn',
  PREVIEW: 'preview',
});

function nowIso() {
  return new Date().toISOString();
}

function genSessionId(prefix) {
  return String(prefix || 'cvs_') + crypto.randomBytes(8).toString('hex');
}

function publicSession(row) {
  if (!row) return null;
  return {
    call_session_id: row.id,
    channel: row.channel,
    employee_id: row.employee_id,
    initial_language: row.initial_language,
    current_language: row.current_language,
    preferred_language: row.preferred_language || null,
    voice_lock: personaRouter.publicVoiceLock(row.voice_lock),
    voice_switch_policy: row.voice_switch_policy,
    locked: true,
    route_semantics: 'call_start_only',
    created_at: row.created_at,
    updated_at: row.updated_at,
    workflow_run_id: row.workflow_run_id || null,
    call_id: row.call_id || null,
  };
}

/**
 * Establish call-start voice lock for any channel.
 * preferred_language is start-seed only. voice_lock is per-call only.
 */
function startCallVoiceSession(input = {}) {
  const channel = String(input.channel || CHANNELS.BROWSER).trim().toLowerCase() || CHANNELS.BROWSER;
  const preferredLanguage = personaRouter.normalizeLanguageCode(
    input.preferred_language || input.preferredLanguage || '',
  ) || null;

  const established = personaRouter.resolveCallVoice({
    employee: input.employee,
    employee_id: input.employee_id || input.employeeId,
    persona: input.persona || input.persona_id || input.personaId,
    language: input.language || input.initial_language,
    preferred_language: preferredLanguage,
    mode: input.mode || 'astra_auto',
    provider: input.provider,
    pipelineTts: input.pipelineTts || input.pipeline_tts,
    voice_switch_policy: input.voice_switch_policy || input.voiceSwitchPolicy || input.policy,
    forceLocked: input.forceLocked,
  });

  if (!established.ok) {
    return established;
  }

  const id = String(input.call_session_id || input.sessionId || '').trim() || genSessionId('cvs_');
  const row = {
    id,
    channel,
    employee_id: established.employee_id,
    initial_language: established.initial_language,
    current_language: established.current_language || established.initial_language,
    preferred_language: preferredLanguage,
    voice_lock: established.voice_lock,
    voice_switch_policy: established.voice_switch_policy
      || personaRouter.DEFAULT_VOICE_SWITCH_POLICY,
    workflow_run_id: input.workflow_run_id || input.workflowRunId || null,
    call_id: input.call_id || input.callId || null,
    created_at: nowIso(),
    updated_at: nowIso(),
  };
  ACTIVE.set(id, row);

  return {
    ok: true,
    ...publicSession(row),
    route: established.route,
    persona: established.persona || null,
    source: established.source,
    mode: established.mode,
  };
}

function getCallVoiceSession(callSessionId) {
  const id = String(callSessionId || '').trim();
  if (!id) return null;
  return publicSession(ACTIVE.get(id) || null);
}

function bindCallVoiceSession(callSessionId, meta = {}) {
  const id = String(callSessionId || '').trim();
  const row = ACTIVE.get(id);
  if (!row) {
    return { ok: false, error: 'Call voice session not found', code: 'call_voice_session_missing' };
  }
  if (meta.workflow_run_id || meta.workflowRunId) {
    row.workflow_run_id = String(meta.workflow_run_id || meta.workflowRunId);
  }
  if (meta.call_id || meta.callId) {
    row.call_id = String(meta.call_id || meta.callId);
  }
  row.updated_at = nowIso();
  ACTIVE.set(id, row);
  return { ok: true, ...publicSession(row) };
}

/**
 * Mid-call language change. Speaker/provider stay locked unless policy allows
 * fallback AND locked engine cannot speak the target language.
 */
function applyCallLanguage(callSessionId, language, opts = {}) {
  const id = String(callSessionId || '').trim();
  const row = ACTIVE.get(id);
  if (!row) {
    return { ok: false, error: 'Call voice session not found', code: 'call_voice_session_missing' };
  }

  const resolved = personaRouter.resolveLockedVoice(row.voice_lock, language, {
    voice_switch_policy: opts.voice_switch_policy || opts.policy || row.voice_switch_policy,
    persona: row.voice_lock && row.voice_lock.persona,
    mode: opts.mode || 'astra_auto',
  });

  if (!resolved.ok) {
    return {
      ...resolved,
      call_session_id: id,
      employee_id: row.employee_id,
      initial_language: row.initial_language,
      current_language: row.current_language,
      voice_lock: personaRouter.publicVoiceLock(row.voice_lock),
      voice_switch_policy: row.voice_switch_policy,
    };
  }

  // Keep lock identity when speaker unchanged. Only replace lock when
  // fallback_allowed explicitly re-resolved a different voice.
  if (resolved.speaker_unchanged !== false && resolved.locked !== false) {
    row.current_language = resolved.language;
  } else if (resolved.voice_lock) {
    row.voice_lock = Object.freeze({
      provider: resolved.voice_lock.provider,
      speaker: resolved.voice_lock.speaker,
      model: resolved.voice_lock.model || '',
      persona: resolved.voice_lock.persona || row.voice_lock.persona || null,
    });
    row.current_language = resolved.language;
  } else {
    row.current_language = resolved.language;
  }
  row.updated_at = nowIso();
  ACTIVE.set(id, row);

  return {
    ok: true,
    ...publicSession(row),
    route: resolved.route,
    speaker_unchanged: !!resolved.speaker_unchanged,
    provider_unchanged: !!resolved.provider_unchanged,
    source: resolved.source,
  };
}

/**
 * End call: drop voice_lock. Optionally return preferred_language to persist
 * on the contact for the NEXT call start seed (not a voice_lock).
 */
function endCallVoiceSession(callSessionId, opts = {}) {
  const id = String(callSessionId || '').trim();
  const row = ACTIVE.get(id);
  if (!row) {
    return { ok: true, ended: false, code: 'already_ended' };
  }
  ACTIVE.delete(id);
  const detected = personaRouter.normalizeLanguageCode(
    opts.detected_language || opts.detectedLanguage || row.current_language || '',
  ) || null;
  return {
    ok: true,
    ended: true,
    call_session_id: id,
    employee_id: row.employee_id,
    // Hint only. Caller may store preferred_language on contact. Never store voice_lock.
    preferred_language_for_next_call: detected || row.preferred_language || null,
    voice_lock_persisted: false,
  };
}

/**
 * Shared Browser / PSTN preflight: resolve what voice_lock WOULD be without
 * requiring a live Dograh session. Used by unit tests and PSTN dry-run paths.
 */
function resolveChannelVoice(input = {}) {
  const channel = String(input.channel || CHANNELS.BROWSER).trim().toLowerCase();
  const started = startCallVoiceSession({ ...input, channel });
  if (!started.ok) return started;
  // Immediate ephemeral resolve for dry-run: do not leave orphan sessions unless asked.
  if (input.persist === true) return started;
  endCallVoiceSession(started.call_session_id);
  return {
    ok: true,
    ephemeral: true,
    channel,
    employee_id: started.employee_id,
    initial_language: started.initial_language,
    voice_lock: started.voice_lock,
    voice_switch_policy: started.voice_switch_policy,
    route: started.route,
    source: started.source,
    same_logic_as: ['browser', 'inbound_pstn', 'outbound_pstn'],
  };
}

/**
 * Context variables attached to Dograh / telephony session mint.
 * Never includes credentials.
 */
function voiceLockContextVariables(session) {
  if (!session || !session.voice_lock) return {};
  const lock = session.voice_lock;
  return {
    astra_voice_lock_provider: lock.provider || '',
    astra_voice_lock_speaker: lock.speaker || lock.voice_id || '',
    astra_voice_lock_persona: lock.persona || lock.persona_id || '',
    astra_voice_lock_model: lock.model || '',
    astra_voice_switch_policy: session.voice_switch_policy
      || personaRouter.DEFAULT_VOICE_SWITCH_POLICY,
    astra_voice_initial_language: session.initial_language || '',
    astra_voice_current_language: session.current_language || session.initial_language || '',
    astra_call_session_id: session.call_session_id || '',
    // TTS snapshot follows the lock (speaker stays for the call).
    astra_tts_provider: lock.provider || '',
    astra_tts_voice: lock.speaker || lock.voice_id || '',
    astra_tts_language: session.current_language || session.initial_language || '',
  };
}

function clearAllCallVoiceSessions() {
  ACTIVE.clear();
}

function activeCallVoiceSessionCount() {
  return ACTIVE.size;
}

module.exports = {
  CHANNELS,
  startCallVoiceSession,
  getCallVoiceSession,
  bindCallVoiceSession,
  applyCallLanguage,
  endCallVoiceSession,
  resolveChannelVoice,
  voiceLockContextVariables,
  publicSession,
  clearAllCallVoiceSessions,
  activeCallVoiceSessionCount,
};
