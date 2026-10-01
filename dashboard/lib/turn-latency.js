/**
 * Astra Voice. Browser Talk turn latency instrumentation (PSTN QA P0-3).
 *
 * Captures stage timestamps so 9 to 12s delays can be attributed:
 *   speech_end → stt_final → llm_request → llm_first_token → llm_complete
 *   → tts_request → tts_first_audio → playback_start
 *
 * In-memory ring buffer only (no new product datastore). Auth routes may
 * append traces for evidence capture during Browser Talk retests.
 *
 * No em dashes anywhere. Commas and periods only.
 */
'use strict';

const crypto = require('crypto');

const STAGE_ORDER = Object.freeze([
  'speech_end',
  'stt_final',
  'llm_request',
  'llm_first_token',
  'llm_complete',
  'tts_request',
  'tts_first_audio',
  'playback_start',
]);

const MAX_TRACES = 200;
const traces = [];

function nowMs() {
  return Date.now();
}

function genTurnId() {
  return 'turn_' + crypto.randomBytes(8).toString('hex');
}

function createTurnTrace(meta = {}) {
  return {
    turn_id: String(meta.turn_id || genTurnId()),
    session_id: meta.session_id ? String(meta.session_id).slice(0, 80) : null,
    employee_id: meta.employee_id ? String(meta.employee_id).slice(0, 60) : null,
    agent_id: meta.agent_id ? String(meta.agent_id).slice(0, 60) : null,
    source: String(meta.source || 'browser_talk').slice(0, 40),
    created_at: new Date().toISOString(),
    stages: {},
    deltas_ms: {},
    total_speech_end_to_playback_ms: null,
    slow: false,
    slow_threshold_ms: Number(meta.slow_threshold_ms) || 9000,
    notes: [],
  };
}

function markStage(trace, stage, atMs, extra = {}) {
  if (!trace || !STAGE_ORDER.includes(stage)) {
    return { ok: false, error: 'unknown_stage', stage };
  }
  const t = Number.isFinite(Number(atMs)) ? Number(atMs) : nowMs();
  trace.stages[stage] = {
    at_ms: t,
    at_iso: new Date(t).toISOString(),
    ...extra,
  };
  recompute(trace);
  return { ok: true, trace };
}

function recompute(trace) {
  const stages = trace.stages || {};
  const deltas = {};
  for (let i = 1; i < STAGE_ORDER.length; i++) {
    const prev = STAGE_ORDER[i - 1];
    const cur = STAGE_ORDER[i];
    if (stages[prev] && stages[cur]) {
      deltas[prev + '_to_' + cur] = Math.max(0, stages[cur].at_ms - stages[prev].at_ms);
    }
  }
  trace.deltas_ms = deltas;
  if (stages.speech_end && stages.playback_start) {
    trace.total_speech_end_to_playback_ms = Math.max(
      0,
      stages.playback_start.at_ms - stages.speech_end.at_ms,
    );
  } else {
    trace.total_speech_end_to_playback_ms = null;
  }
  const threshold = Number(trace.slow_threshold_ms) || 9000;
  trace.slow = trace.total_speech_end_to_playback_ms != null
    && trace.total_speech_end_to_playback_ms >= threshold;
  return trace;
}

/**
 * Ingest a partial or complete client/server timing payload.
 */
function ingestTurnTiming(body = {}) {
  const existing = body.turn_id
    ? traces.find((t) => t.turn_id === String(body.turn_id))
    : null;
  const trace = existing || createTurnTrace(body);

  if (body.stages && typeof body.stages === 'object') {
    for (const stage of STAGE_ORDER) {
      const raw = body.stages[stage];
      if (raw == null) continue;
      if (typeof raw === 'number') markStage(trace, stage, raw);
      else if (typeof raw === 'object' && raw.at_ms != null) {
        markStage(trace, stage, raw.at_ms, {
          detail: raw.detail ? String(raw.detail).slice(0, 200) : undefined,
        });
      }
    }
  }

  // Flat aliases from Browser Talk client.
  const aliases = {
    speech_end_ms: 'speech_end',
    stt_final_ms: 'stt_final',
    llm_request_ms: 'llm_request',
    llm_first_token_ms: 'llm_first_token',
    llm_complete_ms: 'llm_complete',
    tts_request_ms: 'tts_request',
    tts_first_audio_ms: 'tts_first_audio',
    playback_start_ms: 'playback_start',
  };
  for (const [key, stage] of Object.entries(aliases)) {
    if (body[key] != null) markStage(trace, stage, body[key]);
  }

  if (body.note) {
    trace.notes.push(String(body.note).slice(0, 300));
  }
  if (body.stt) {
    trace.stt = {
      provider: String(body.stt.provider || '').slice(0, 40),
      model: String(body.stt.model || '').slice(0, 80),
      language: String(body.stt.language || '').slice(0, 40),
    };
  }
  if (body.llm) {
    trace.llm = {
      provider: String(body.llm.provider || '').slice(0, 40),
      model: String(body.llm.model || '').slice(0, 80),
    };
  }
  if (body.tts) {
    trace.tts = {
      provider: String(body.tts.provider || '').slice(0, 40),
      model: String(body.tts.model || '').slice(0, 80),
    };
  }

  recompute(trace);
  if (!existing) {
    traces.unshift(trace);
    while (traces.length > MAX_TRACES) traces.pop();
  }
  return { ok: true, trace: publicTrace(trace) };
}

function publicTrace(trace) {
  if (!trace) return null;
  return {
    turn_id: trace.turn_id,
    session_id: trace.session_id,
    employee_id: trace.employee_id,
    agent_id: trace.agent_id,
    source: trace.source,
    created_at: trace.created_at,
    stages: { ...trace.stages },
    deltas_ms: { ...trace.deltas_ms },
    total_speech_end_to_playback_ms: trace.total_speech_end_to_playback_ms,
    slow: !!trace.slow,
    slow_threshold_ms: trace.slow_threshold_ms,
    stt: trace.stt || null,
    llm: trace.llm || null,
    tts: trace.tts || null,
    notes: (trace.notes || []).slice(),
    bottleneck: identifyBottleneck(trace),
  };
}

/**
 * Identify the largest inter-stage gap (evidence for 9 to 12s delays).
 */
function identifyBottleneck(trace) {
  const deltas = trace.deltas_ms || {};
  let bestKey = null;
  let bestMs = -1;
  for (const [k, v] of Object.entries(deltas)) {
    if (Number(v) > bestMs) {
      bestMs = Number(v);
      bestKey = k;
    }
  }
  if (!bestKey) return null;
  return { stage_gap: bestKey, ms: bestMs };
}

function listTraces(opts = {}) {
  const limit = Math.min(100, Math.max(1, Number(opts.limit) || 20));
  const slowOnly = !!opts.slowOnly;
  let rows = traces.slice();
  if (slowOnly) rows = rows.filter((t) => t.slow);
  if (opts.employee_id) {
    rows = rows.filter((t) => t.employee_id === String(opts.employee_id));
  }
  return rows.slice(0, limit).map(publicTrace);
}

function getTrace(turnId) {
  const t = traces.find((x) => x.turn_id === String(turnId || ''));
  return t ? publicTrace(t) : null;
}

function clearTraces() {
  traces.length = 0;
}

/**
 * Format a one-line evidence summary for docs / UI.
 */
function formatEvidenceLine(trace) {
  const t = publicTrace(trace);
  if (!t) return '';
  const total = t.total_speech_end_to_playback_ms;
  const bn = t.bottleneck;
  return [
    t.turn_id,
    total != null ? ('total=' + total + 'ms') : 'total=incomplete',
    t.slow ? 'SLOW' : 'ok',
    bn ? ('bottleneck=' + bn.stage_gap + '@' + bn.ms + 'ms') : 'bottleneck=n/a',
  ].join(' | ');
}

module.exports = {
  STAGE_ORDER,
  createTurnTrace,
  markStage,
  recompute,
  ingestTurnTiming,
  publicTrace,
  identifyBottleneck,
  listTraces,
  getTrace,
  clearTraces,
  formatEvidenceLine,
  nowMs,
  genTurnId,
};
