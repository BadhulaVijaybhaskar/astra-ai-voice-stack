/**
 * Astra Voice. Turn latency instrumentation (LATENCY P0 / P0.2).
 *
 * PRIMARY METRIC: speech_end → first audible response (tts_first_audio /
 * playback_start). Ordinary target <=1000 ms (stretch <=1200, hard fail >2500).
 * Tool turns: first spoken ack <=1200 ms; tools stay in the background.
 * This is NOT a mandate to shorten useful answers. Once speech starts, Maya
 * may continue for as long as the question needs.
 *
 * P0.2 MEASUREMENT (blocking): one monotonic clock per turn.
 *   t0 speech_end
 *   t1 stt_final
 *   t2 llm_request
 *   t3 llm_first_token
 *   t4 first_safe_phrase
 *   t5 tts_request
 *   t6 tts_first_audio (first audio byte)
 *   t7 playback_start
 * Derived (same origin, never sum medians across unrelated turns):
 *   STT=t1-t0, orchestration=t2-t1, Groq TTFT=t3-t2, phrase_accum=t4-t3,
 *   TTS TTFB=t6-t5, playback_buffer=t7-t6, TOTAL=t7-t0
 *
 * Why prior Hostinger medians looked inconsistent (Groq TTFT P50 ~808 +
 * TTS first-byte ~1876 while TOTAL first audio P50 1764):
 *   1) Server wall clocks were mixed into client stage marks (llm_first_token
 *      used server Date.now while speech_end used client Date.now).
 *   2) UI "Brain" used full stream latency_ms, not TTFT.
 *   3) TTS duration used performance.now while stages used Date.now.
 *   4) Stages run in parallel (TTS starts while LLM continues), so TTFT+TTFB
 *      are not additive to TOTAL even with a perfect clock.
 *   5) Medians of stage gaps across different turns are not the median of
 *      per-turn sums. Always report per-turn stage_trace, then percentile
 *      each derived gap independently, and never sum those percentiles.
 *
 * Streaming model: start TTS on the first safe natural phrase while the LLM
 * continues the rest concurrently. Booking may speak an immediate ack, then
 * collect details; tools may continue async. Silent wait >4s before first
 * audio = FAIL.
 *
 * Baseline tip 7f03dd0 (Hostinger Maya WF8): median 14403ms, max 54597ms.
 * Live flawed P0.1 sample: FIRST_AUDIO P50 1764 / P90 3257 / P95 3362;
 * HI booking ack P50 707; 6/22 turns Groq rate-limited → empty (P0.2 fix).
 *
 * In-memory ring buffer only. No em dashes. Commas and periods only.
 */
'use strict';

const crypto = require('crypto');

/** Full stage list (includes secondary / post-audio stages). */
const STAGE_ORDER = Object.freeze([
  'speech_end',
  'stt_final',
  'llm_request',
  'llm_first_token',
  'first_safe_phrase',
  'llm_complete',
  'tool_start',
  'tool_complete',
  'tts_request',
  'tts_first_audio',
  'playback_start',
  'response_complete',
]);

/**
 * Critical first-audio path (t0–t7). One monotonic origin required.
 * Map: t0..t7 labels ↔ stage names.
 */
const CRITICAL_PATH = Object.freeze([
  { t: 't0', stage: 'speech_end' },
  { t: 't1', stage: 'stt_final' },
  { t: 't2', stage: 'llm_request' },
  { t: 't3', stage: 'llm_first_token' },
  { t: 't4', stage: 'first_safe_phrase' },
  { t: 't5', stage: 'tts_request' },
  { t: 't6', stage: 'tts_first_audio' },
  { t: 't7', stage: 'playback_start' },
]);

const DERIVED_GAPS = Object.freeze([
  { key: 'STT', from: 't0', to: 't1', desc: 'speech_end → stt_final' },
  { key: 'orchestration', from: 't1', to: 't2', desc: 'stt_final → llm_request' },
  { key: 'Groq_TTFT', from: 't2', to: 't3', desc: 'llm_request → llm_first_token' },
  { key: 'phrase_accum', from: 't3', to: 't4', desc: 'llm_first_token → first_safe_phrase' },
  { key: 'TTS_TTFB', from: 't5', to: 't6', desc: 'tts_request → tts_first_audio' },
  { key: 'playback_buffer', from: 't6', to: 't7', desc: 'tts_first_audio → playback_start' },
  { key: 'TOTAL', from: 't0', to: 't7', desc: 'speech_end → playback_start' },
]);

const MEASUREMENT_SEMANTICS = Object.freeze({
  clock: 'one_monotonic_per_turn',
  origin: 'speech_end (t0)',
  unit: 'ms',
  never_sum_medians: true,
  why_prior_medians_inconsistent: [
    'Server Date.now mixed into client llm_first_token while speech_end used client Date.now',
    'UI Brain metric used full stream latency_ms, not Groq TTFT',
    'TTS duration used performance.now while stage marks used Date.now',
    'TTFT and TTS TTFB overlap in parallel with phrase accumulation; they are not a serial sum',
    'Percentiles of unrelated stage gaps across turns are not additive to TOTAL percentile',
  ],
  correct_report: 'Percentile each derived gap (STT, Groq_TTFT, TTS_TTFB, TOTAL) independently from per-turn stage_trace. Never add P50(TTFT)+P50(TTFB) and compare to P50(TOTAL).',
});

/** Latency targets. Answer quality is NOT traded for these numbers. */
const TARGETS = Object.freeze({
  first_audio_target_ms: 1000,
  first_audio_stretch_ms: 1200,
  first_audio_hard_fail_ms: 2500,
  /** @deprecated alias kept for older report readers */
  first_audio_target_min_ms: 800,
  first_audio_target_max_ms: 1000,
  first_audio_p50_ms: 1000,
  tool_assisted_first_audio_ms: 1200,
  stt_final_target_ms: 250,
  silent_wait_fail_ms: 4000,
  critical_slow_first_audio_ms: 2500,
  max_llm_before_first_speech: 1,
});

const BASELINE_BEFORE = Object.freeze({
  tip: '7f03dd0',
  employee_id: 'emp_33eae8ef454680f0',
  dograh_workflow_id: '8',
  tts: 'sarvam bulbul:v3 priya',
  did: '+918065353938',
  /** Historical field was end-to-end / first-spoken mixed; treat as first-audio proxy until remeasured. */
  first_audio_median_ms: 14403,
  mixed_median_ms: 25800,
  max_ms: 54597,
  bottleneck: 'WF8 LLM/tool especially booking (speech blocked on tools)',
});

/** Flawed live Hostinger sample after P0.1 (method inconsistent). Not acceptance. */
const LIVE_BASELINE_FLAWED_P01 = Object.freeze({
  label: 'Hostinger Browser Talk after P0.1 (flawed measurement)',
  FIRST_AUDIO_P50: 1764,
  FIRST_AUDIO_P90: 3257,
  FIRST_AUDIO_P95: 3362,
  HI_BOOKING_ACK_P50: 707,
  reported_groq_ttft_approx: 808,
  reported_tts_first_byte_approx: 1876,
  groq_rate_limited_turns: '6/22',
  note: 'Medians were NOT additive. Fix measurement (P0.2) before trusting stage sums.',
});

const QUALITY_GATES = Object.freeze([
  'ANSWER_COMPLETENESS',
  'NATURAL_PACING',
  'CUSTOMER_NOT_RUSHED',
  'DEMO_PUSH_REDUCED',
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
    language_bucket: meta.language_bucket
      ? String(meta.language_bucket).slice(0, 40)
      : null,
    created_at: new Date().toISOString(),
    stages: {},
    /** Relative offsets from speech_end (t0). Preferred clock for reports. */
    stage_trace: {},
    deltas_ms: {},
    derived_ms: {},
    absolute_ms: {},
    first_audio_ms: null,
    total_response_duration_ms: null,
    total_speech_end_to_playback_ms: null,
    silent_wait_ms: null,
    silent_wait_fail: false,
    tool_assisted: false,
    booking_ack: false,
    streamed_first_phrase: false,
    rate_limited: false,
    fallback_used: false,
    llm_calls_before_first_speech: null,
    slow: false,
    meets_first_audio_target: null,
    meets_tool_first_audio_target: null,
    slow_threshold_ms: Number(meta.slow_threshold_ms) || TARGETS.critical_slow_first_audio_ms,
    quality: {
      ANSWER_COMPLETENESS: meta.quality && meta.quality.ANSWER_COMPLETENESS != null
        ? meta.quality.ANSWER_COMPLETENESS
        : null,
      NATURAL_PACING: meta.quality && meta.quality.NATURAL_PACING != null
        ? meta.quality.NATURAL_PACING
        : null,
      CUSTOMER_NOT_RUSHED: meta.quality && meta.quality.CUSTOMER_NOT_RUSHED != null
        ? meta.quality.CUSTOMER_NOT_RUSHED
        : null,
      DEMO_PUSH_REDUCED: meta.quality && meta.quality.DEMO_PUSH_REDUCED != null
        ? meta.quality.DEMO_PUSH_REDUCED
        : null,
    },
    notes: [],
  };
}

function markStage(trace, stage, atMs, extra = {}) {
  if (!trace || !STAGE_ORDER.includes(stage)) {
    return { ok: false, error: 'unknown_stage', stage };
  }
  const t = Number.isFinite(Number(atMs)) ? Number(atMs) : nowMs();
  const prev = trace.stages[stage];
  if (prev && (stage === 'tts_first_audio' || stage === 'playback_start' || stage === 'llm_first_token' || stage === 'first_safe_phrase')) {
    if (t >= prev.at_ms) {
      recompute(trace);
      return { ok: true, trace, kept_earlier: true };
    }
  }
  trace.stages[stage] = {
    at_ms: t,
    at_iso: new Date(t).toISOString(),
    ...extra,
  };
  if (stage === 'tool_start' || stage === 'tool_complete') {
    trace.tool_assisted = true;
  }
  if (extra && (extra.booking_ack || extra.detail === 'booking_ack')) {
    trace.booking_ack = true;
  }
  if (extra && (extra.streamed_first_phrase || extra.detail === 'first_safe_phrase' || stage === 'first_safe_phrase')) {
    trace.streamed_first_phrase = true;
  }
  recompute(trace);
  return { ok: true, trace };
}

/**
 * Apply relative stage_trace offsets (ms from speech_end). Preferred path.
 * Builds commensurate absolute stages from a single origin wall clock.
 */
function applyStageTrace(trace, stageTrace, originWallMs) {
  if (!trace || !stageTrace || typeof stageTrace !== 'object') return trace;
  const origin = Number.isFinite(Number(originWallMs))
    ? Number(originWallMs)
    : (trace.stages.speech_end && trace.stages.speech_end.at_ms) || nowMs();

  // Accept either stage names or t0..t7 keys.
  const nameByT = {};
  for (const row of CRITICAL_PATH) nameByT[row.t] = row.stage;

  const offsets = {};
  for (const [key, raw] of Object.entries(stageTrace)) {
    const stage = nameByT[key] || key;
    if (!STAGE_ORDER.includes(stage)) continue;
    const offset = Number(raw);
    if (!Number.isFinite(offset) || offset < 0) continue;
    offsets[stage] = offset;
  }
  if (offsets.speech_end == null) offsets.speech_end = 0;

  for (const [stage, offset] of Object.entries(offsets)) {
    markStage(trace, stage, origin + offset, { from_stage_trace: true });
  }
  trace.stage_trace = { ...offsets };
  recompute(trace);
  return trace;
}

function buildStageTraceFromStages(trace) {
  const stages = trace.stages || {};
  if (!stages.speech_end) return { ...(trace.stage_trace || {}) };
  const origin = stages.speech_end.at_ms;
  const out = { ...(trace.stage_trace || {}) };
  for (const row of CRITICAL_PATH) {
    if (stages[row.stage]) {
      out[row.stage] = Math.max(0, stages[row.stage].at_ms - origin);
      out[row.t] = out[row.stage];
    }
  }
  // Also include secondary stages as absolute-from-t0 for debugging.
  for (const stage of STAGE_ORDER) {
    if (stages[stage] && out[stage] == null) {
      out[stage] = Math.max(0, stages[stage].at_ms - origin);
    }
  }
  return out;
}

function computeDerived(stageTrace) {
  const st = stageTrace || {};
  const tVal = (label) => {
    const row = CRITICAL_PATH.find((r) => r.t === label);
    if (!row) return null;
    if (st[label] != null) return Number(st[label]);
    if (st[row.stage] != null) return Number(st[row.stage]);
    return null;
  };
  const derived = {};
  for (const gap of DERIVED_GAPS) {
    const a = tVal(gap.from);
    const b = tVal(gap.to);
    if (a == null || b == null) {
      derived[gap.key] = null;
      continue;
    }
    derived[gap.key] = Math.max(0, b - a);
  }
  // Extra: phrase → tts_request (queue/mint) when both present.
  const t4 = tVal('t4');
  const t5 = tVal('t5');
  if (t4 != null && t5 != null) {
    derived.phrase_to_tts_request = Math.max(0, t5 - t4);
  }
  return derived;
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
  if (stages.tool_start && stages.tool_complete) {
    deltas.tool_start_to_tool_complete = Math.max(
      0,
      stages.tool_complete.at_ms - stages.tool_start.at_ms,
    );
  }
  if (stages.speech_end && stages.tts_first_audio) {
    deltas.speech_end_to_first_audio = Math.max(
      0,
      stages.tts_first_audio.at_ms - stages.speech_end.at_ms,
    );
  }
  if (stages.speech_end && stages.playback_start) {
    deltas.speech_end_to_playback_start = Math.max(
      0,
      stages.playback_start.at_ms - stages.speech_end.at_ms,
    );
  }
  if (stages.speech_end && stages.response_complete) {
    deltas.speech_end_to_response_complete = Math.max(
      0,
      stages.response_complete.at_ms - stages.speech_end.at_ms,
    );
  }
  // Critical-path adjacent gaps (prefer these for first-audio bottleneck).
  for (let i = 1; i < CRITICAL_PATH.length; i++) {
    const prev = CRITICAL_PATH[i - 1].stage;
    const cur = CRITICAL_PATH[i].stage;
    if (stages[prev] && stages[cur]) {
      deltas['crit_' + prev + '_to_' + cur] = Math.max(
        0,
        stages[cur].at_ms - stages[prev].at_ms,
      );
    }
  }
  trace.deltas_ms = deltas;

  const absolute = {};
  if (stages.speech_end) {
    const origin = stages.speech_end.at_ms;
    for (const stage of STAGE_ORDER) {
      if (stages[stage]) absolute[stage] = Math.max(0, stages[stage].at_ms - origin);
    }
  }
  trace.absolute_ms = absolute;

  const stageTrace = buildStageTraceFromStages(trace);
  trace.stage_trace = stageTrace;
  trace.derived_ms = computeDerived(stageTrace);

  let firstAudio = null;
  if (stages.speech_end) {
    const candidates = [];
    if (stages.tts_first_audio) candidates.push(stages.tts_first_audio.at_ms);
    if (stages.playback_start) candidates.push(stages.playback_start.at_ms);
    if (candidates.length) {
      firstAudio = Math.max(0, Math.min(...candidates) - stages.speech_end.at_ms);
    }
  }
  // Prefer TOTAL derived from stage_trace when present.
  if (trace.derived_ms && trace.derived_ms.TOTAL != null) {
    firstAudio = trace.derived_ms.TOTAL;
  }
  trace.first_audio_ms = firstAudio;
  trace.silent_wait_ms = firstAudio;
  trace.silent_wait_fail = firstAudio != null && firstAudio > TARGETS.silent_wait_fail_ms;

  // Back-compat alias used by older UI / docs.
  if (stages.speech_end && stages.playback_start) {
    trace.total_speech_end_to_playback_ms = Math.max(
      0,
      stages.playback_start.at_ms - stages.speech_end.at_ms,
    );
  } else {
    trace.total_speech_end_to_playback_ms = firstAudio;
  }

  if (stages.speech_end && stages.response_complete) {
    trace.total_response_duration_ms = Math.max(
      0,
      stages.response_complete.at_ms - stages.speech_end.at_ms,
    );
  } else {
    trace.total_response_duration_ms = null;
  }

  const threshold = Number(trace.slow_threshold_ms) || TARGETS.critical_slow_first_audio_ms;
  trace.slow = firstAudio != null && firstAudio >= threshold;

  if (firstAudio == null) {
    trace.meets_first_audio_target = null;
    trace.meets_tool_first_audio_target = null;
  } else if (trace.tool_assisted || trace.booking_ack) {
    trace.meets_tool_first_audio_target = firstAudio <= TARGETS.tool_assisted_first_audio_ms;
    trace.meets_first_audio_target = firstAudio <= TARGETS.first_audio_stretch_ms;
  } else {
    trace.meets_first_audio_target = firstAudio <= TARGETS.first_audio_target_ms;
    trace.meets_tool_first_audio_target = null;
  }
  trace.first_audio_hard_fail = firstAudio != null && firstAudio > TARGETS.first_audio_hard_fail_ms;

  if (trace.llm_calls_before_first_speech != null) {
    trace.multi_llm_before_first_speech = Number(trace.llm_calls_before_first_speech)
      > TARGETS.max_llm_before_first_speech;
  }

  return trace;
}

function ingestTurnTiming(body = {}) {
  const existing = body.turn_id
    ? traces.find((t) => t.turn_id === String(body.turn_id))
    : null;
  const trace = existing || createTurnTrace(body);

  if (body.language_bucket) {
    trace.language_bucket = String(body.language_bucket).slice(0, 40);
  }
  if (body.booking_ack) trace.booking_ack = true;
  if (body.tool_assisted) trace.tool_assisted = true;
  if (body.streamed_first_phrase) trace.streamed_first_phrase = true;
  if (body.rate_limited) trace.rate_limited = true;
  if (body.fallback_used) trace.fallback_used = true;
  if (body.llm_calls_before_first_speech != null) {
    trace.llm_calls_before_first_speech = Number(body.llm_calls_before_first_speech);
  }

  if (body.quality && typeof body.quality === 'object') {
    for (const gate of QUALITY_GATES) {
      if (body.quality[gate] != null) {
        const v = body.quality[gate];
        trace.quality[gate] = (v === true || v === 'PASS' || v === 'pass')
          ? 'PASS'
          : (v === false || v === 'FAIL' || v === 'fail')
            ? 'FAIL'
            : String(v).slice(0, 20);
      }
    }
  }

  // Preferred: monotonic relative offsets.
  if (body.stage_trace && typeof body.stage_trace === 'object') {
    const originWall = body.speech_end_wall_ms
      || body.speech_end_ms
      || (body.stages && typeof body.stages.speech_end === 'number' && body.stages.speech_end)
      || (trace.stages.speech_end && trace.stages.speech_end.at_ms)
      || nowMs();
    applyStageTrace(trace, body.stage_trace, originWall);
  }

  if (body.stages && typeof body.stages === 'object') {
    for (const stage of STAGE_ORDER) {
      const raw = body.stages[stage];
      if (raw == null) continue;
      if (typeof raw === 'number') markStage(trace, stage, raw);
      else if (typeof raw === 'object' && raw.at_ms != null) {
        markStage(trace, stage, raw.at_ms, {
          detail: raw.detail ? String(raw.detail).slice(0, 200) : undefined,
          booking_ack: !!raw.booking_ack,
          streamed_first_phrase: !!raw.streamed_first_phrase,
          tool: raw.tool ? String(raw.tool).slice(0, 80) : undefined,
        });
      }
    }
  }

  const aliases = {
    speech_end_ms: 'speech_end',
    stt_final_ms: 'stt_final',
    llm_request_ms: 'llm_request',
    llm_first_token_ms: 'llm_first_token',
    first_safe_phrase_ms: 'first_safe_phrase',
    llm_complete_ms: 'llm_complete',
    tool_start_ms: 'tool_start',
    tool_complete_ms: 'tool_complete',
    tts_request_ms: 'tts_request',
    tts_first_audio_ms: 'tts_first_audio',
    playback_start_ms: 'playback_start',
    response_complete_ms: 'response_complete',
  };
  for (const [key, stage] of Object.entries(aliases)) {
    if (body[key] != null) markStage(trace, stage, body[key]);
  }

  if (body.note) trace.notes.push(String(body.note).slice(0, 300));
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
      ttft_ms: body.llm.ttft_ms != null ? Number(body.llm.ttft_ms) : undefined,
      fallback_model: body.llm.fallback_model
        ? String(body.llm.fallback_model).slice(0, 80)
        : undefined,
      rate_limited: !!body.llm.rate_limited,
    };
  }
  if (body.tts) {
    trace.tts = {
      provider: String(body.tts.provider || '').slice(0, 40),
      model: String(body.tts.model || '').slice(0, 80),
      keep_alive: body.tts.keep_alive != null ? !!body.tts.keep_alive : undefined,
      warm_mint: body.tts.warm_mint != null ? !!body.tts.warm_mint : undefined,
    };
  }
  if (body.tool) {
    trace.tool = {
      name: String(body.tool.name || body.tool.tool || '').slice(0, 80),
      detail: body.tool.detail ? String(body.tool.detail).slice(0, 200) : undefined,
    };
  }
  if (body.first_phrase) {
    trace.first_phrase = String(body.first_phrase).slice(0, 240);
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
    language_bucket: trace.language_bucket || null,
    created_at: trace.created_at,
    stages: { ...trace.stages },
    stage_trace: { ...(trace.stage_trace || {}) },
    derived_ms: { ...(trace.derived_ms || {}) },
    deltas_ms: { ...trace.deltas_ms },
    absolute_ms: { ...trace.absolute_ms },
    first_audio_ms: trace.first_audio_ms,
    first_audio_hard_fail: !!trace.first_audio_hard_fail,
    total_response_duration_ms: trace.total_response_duration_ms,
    total_speech_end_to_playback_ms: trace.total_speech_end_to_playback_ms,
    silent_wait_ms: trace.silent_wait_ms,
    silent_wait_fail: !!trace.silent_wait_fail,
    tool_assisted: !!trace.tool_assisted,
    booking_ack: !!trace.booking_ack,
    streamed_first_phrase: !!trace.streamed_first_phrase,
    rate_limited: !!trace.rate_limited,
    fallback_used: !!trace.fallback_used,
    llm_calls_before_first_speech: trace.llm_calls_before_first_speech,
    multi_llm_before_first_speech: !!trace.multi_llm_before_first_speech,
    first_phrase: trace.first_phrase || null,
    slow: !!trace.slow,
    meets_first_audio_target: trace.meets_first_audio_target,
    meets_tool_first_audio_target: trace.meets_tool_first_audio_target,
    slow_threshold_ms: trace.slow_threshold_ms,
    targets: { ...TARGETS },
    quality: { ...trace.quality },
    stt: trace.stt || null,
    llm: trace.llm || null,
    tts: trace.tts || null,
    tool: trace.tool || null,
    notes: (trace.notes || []).slice(),
    bottleneck: identifyBottleneck(trace),
    measurement: MEASUREMENT_SEMANTICS,
  };
}

/**
 * Prefer critical-path gaps that delay first audio. Ignore post-audio gaps
 * (playback→response_complete, llm_complete after speech) for first-audio BN.
 */
function identifyBottleneck(trace) {
  const derived = trace.derived_ms || {};
  const candidates = [
    ['STT', derived.STT],
    ['orchestration', derived.orchestration],
    ['Groq_TTFT', derived.Groq_TTFT],
    ['phrase_accum', derived.phrase_accum],
    ['phrase_to_tts_request', derived.phrase_to_tts_request],
    ['TTS_TTFB', derived.TTS_TTFB],
    ['playback_buffer', derived.playback_buffer],
  ].filter(([, v]) => v != null);
  if (candidates.length) {
    candidates.sort((a, b) => Number(b[1]) - Number(a[1]));
    return { stage_gap: candidates[0][0], ms: candidates[0][1], path: 'critical' };
  }
  const deltas = trace.deltas_ms || {};
  let bestKey = null;
  let bestMs = -1;
  for (const [k, v] of Object.entries(deltas)) {
    if (k === 'speech_end_to_response_complete') continue;
    if (k.includes('response_complete')) continue;
    if (Number(v) > bestMs) {
      bestMs = Number(v);
      bestKey = k;
    }
  }
  if (!bestKey) return null;
  return { stage_gap: bestKey, ms: bestMs, path: 'legacy_adjacent' };
}

function listTraces(opts = {}) {
  const limit = Math.min(100, Math.max(1, Number(opts.limit) || 20));
  const slowOnly = !!opts.slowOnly;
  const silentFailOnly = !!opts.silentFailOnly;
  let rows = traces.slice();
  if (slowOnly) rows = rows.filter((t) => t.slow);
  if (silentFailOnly) rows = rows.filter((t) => t.silent_wait_fail);
  if (opts.employee_id) {
    rows = rows.filter((t) => t.employee_id === String(opts.employee_id));
  }
  if (opts.language_bucket) {
    rows = rows.filter((t) => t.language_bucket === String(opts.language_bucket));
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

function percentile(values, p) {
  const nums = (values || []).filter((v) => Number.isFinite(Number(v))).map(Number).sort((a, b) => a - b);
  if (!nums.length) return null;
  if (nums.length === 1) return nums[0];
  const rank = (Math.max(0, Math.min(100, Number(p))) / 100) * (nums.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return nums[lo];
  const w = rank - lo;
  return Math.round(nums[lo] * (1 - w) + nums[hi] * w);
}

function median(values) {
  return percentile(values, 50);
}

function firstAudioStats(list) {
  const vals = (list || []).map((r) => r.first_audio_ms).filter((v) => v != null);
  return {
    n: vals.length,
    P50: percentile(vals, 50),
    P90: percentile(vals, 90),
    P95: percentile(vals, 95),
    max: vals.length ? Math.max(...vals) : null,
  };
}

function totalDurationStats(list) {
  const vals = (list || []).map((r) => r.total_response_duration_ms).filter((v) => v != null);
  return {
    n: vals.length,
    P50: percentile(vals, 50),
    P90: percentile(vals, 90),
    P95: percentile(vals, 95),
    max: vals.length ? Math.max(...vals) : null,
  };
}

/** Percentile each derived gap independently. Never sum these P50s. */
function derivedGapStats(list) {
  const out = {};
  for (const gap of DERIVED_GAPS) {
    const vals = (list || [])
      .map((r) => r.derived_ms && r.derived_ms[gap.key])
      .filter((v) => v != null);
    out[gap.key] = {
      n: vals.length,
      P50: percentile(vals, 50),
      P90: percentile(vals, 90),
      P95: percentile(vals, 95),
      desc: gap.desc,
    };
  }
  out._warning = 'Do NOT sum P50(Groq_TTFT)+P50(TTS_TTFB) and compare to P50(TOTAL). Report each independently from per-turn stage_trace.';
  return out;
}

function qualityRollup(rows) {
  const out = {};
  for (const gate of QUALITY_GATES) {
    const marks = rows.map((r) => r.quality && r.quality[gate]).filter((v) => v === 'PASS' || v === 'FAIL');
    if (!marks.length) {
      out[gate] = 'PENDING_HOSTINGER';
      continue;
    }
    out[gate] = marks.every((v) => v === 'PASS') ? 'PASS' : 'FAIL';
  }
  return out;
}

/**
 * Final report fields for LATENCY P0 (Hostinger Browser Talk evidence).
 */
function summarizeEvidence(opts = {}) {
  const rows = listTraces({ limit: 100, employee_id: opts.employee_id });
  const byBucket = (bucket) => rows.filter((r) => r.language_bucket === bucket);

  const english = byBucket('english');
  const telugu = byBucket('telugu');
  const mixed = byBucket('mixed');
  const hindi = byBucket('hindi').concat(byBucket('hindi_booking'));

  const silentFails = rows.filter((r) => r.silent_wait_fail);
  const rateLimited = rows.filter((r) => r.rate_limited);
  const multiLlm = rows.filter((r) => r.multi_llm_before_first_speech);
  const bottlenecks = rows.map((r) => r.bottleneck && r.bottleneck.stage_gap).filter(Boolean);
  const bottleneckCounts = {};
  for (const b of bottlenecks) bottleneckCounts[b] = (bottleneckCounts[b] || 0) + 1;
  const BOTTLENECKS = Object.entries(bottleneckCounts)
    .map(([stage_gap, count]) => ({ stage_gap, count }))
    .sort((a, b) => b.count - a.count);

  const allFirst = firstAudioStats(rows);
  const allTotal = totalDurationStats(rows);
  const STAGE_BREAKDOWN = derivedGapStats(rows);

  const designedOk = true;
  const ready = allFirst.P50 != null
    && allFirst.P50 <= TARGETS.first_audio_p50_ms
    && silentFails.length === 0
    && rateLimited.length === 0;

  return {
    primary_metric: 'speech_end → first audible response (NOT total answer length)',
    measurement: MEASUREMENT_SEMANTICS,
    critical_path: CRITICAL_PATH.slice(),
    first_audio_target_ms: [TARGETS.first_audio_target_min_ms, TARGETS.first_audio_target_max_ms],
    baseline_before: { ...BASELINE_BEFORE },
    live_baseline_flawed_p01: { ...LIVE_BASELINE_FLAWED_P01 },
    targets: { ...TARGETS },
    sample_count: rows.length,
    ENGLISH: {
      FIRST_AUDIO: firstAudioStats(english),
      TOTAL_RESPONSE_DURATION: totalDurationStats(english),
      STAGE_BREAKDOWN: derivedGapStats(english),
    },
    TELUGU: {
      FIRST_AUDIO: firstAudioStats(telugu),
      TOTAL_RESPONSE_DURATION: totalDurationStats(telugu),
      STAGE_BREAKDOWN: derivedGapStats(telugu),
    },
    MIXED: {
      FIRST_AUDIO: firstAudioStats(mixed),
      TOTAL_RESPONSE_DURATION: totalDurationStats(mixed),
      STAGE_BREAKDOWN: derivedGapStats(mixed),
    },
    HINDI_BOOKING: {
      FIRST_AUDIO: firstAudioStats(hindi),
      TOTAL_RESPONSE_DURATION: totalDurationStats(hindi),
      STAGE_BREAKDOWN: derivedGapStats(hindi),
    },
    FIRST_AUDIO: allFirst,
    TOTAL_RESPONSE_DURATION: allTotal,
    STAGE_BREAKDOWN,
    BOTTLENECKS,
    BEFORE_MEDIAN_MS: BASELINE_BEFORE.first_audio_median_ms,
    AFTER_FIRST_AUDIO_P50_MS: allFirst.P50,
    AFTER_FIRST_AUDIO_P90_MS: allFirst.P90,
    AFTER_FIRST_AUDIO_P95_MS: allFirst.P95,
    AFTER_TOTAL_RESPONSE_P50_MS: allTotal.P50,
    SILENT_WAITS: {
      fail_count: silentFails.length,
      fail_threshold_ms: TARGETS.silent_wait_fail_ms,
      fails: silentFails.slice(0, 10).map((r) => ({
        turn_id: r.turn_id,
        silent_wait_ms: r.silent_wait_ms,
        language_bucket: r.language_bucket,
      })),
    },
    GROQ_RATE_LIMIT: {
      fail_count: rateLimited.length,
      turns: rateLimited.slice(0, 10).map((r) => ({
        turn_id: r.turn_id,
        fallback_used: r.fallback_used,
        language_bucket: r.language_bucket,
      })),
    },
    MULTI_LLM_BEFORE_FIRST_SPEECH: {
      fail_count: multiLlm.length,
      max_allowed: TARGETS.max_llm_before_first_speech,
    },
    ANSWER_COMPLETENESS: qualityRollup(rows).ANSWER_COMPLETENESS,
    NATURAL_PACING: qualityRollup(rows).NATURAL_PACING,
    CUSTOMER_NOT_RUSHED: qualityRollup(rows).CUSTOMER_NOT_RUSHED,
    DEMO_PUSH_REDUCED: qualityRollup(rows).DEMO_PUSH_REDUCED,
    READY_FOR_PSTN_QA: ready
      ? 'CONDITIONAL_AFTER_HOSTINGER_BROWSER_TALK'
      : (designedOk ? 'NO_PENDING_HOSTINGER_MEASUREMENT' : 'NO'),
    notes: [
      'Do not optimize total response duration by shortening useful answers.',
      'Streaming starts TTS on the first safe natural phrase while LLM continues.',
      'Turn length is adaptive: simple concise, explanation detailed, qualify consultative, booking action-oriented.',
      'Never sum medians of Groq TTFT and TTS TTFB across turns.',
      'Harness / synthetic numbers are non-acceptance. Live Hostinger replaces AFTER_*.',
    ],
  };
}

function formatEvidenceLine(trace) {
  const t = publicTrace(trace);
  if (!t) return '';
  const bn = t.bottleneck;
  const d = t.derived_ms || {};
  return [
    t.turn_id,
    t.first_audio_ms != null ? ('first_audio=' + t.first_audio_ms + 'ms') : 'first_audio=incomplete',
    d.Groq_TTFT != null ? ('ttft=' + d.Groq_TTFT + 'ms') : 'ttft=n/a',
    d.TTS_TTFB != null ? ('tts_ttfb=' + d.TTS_TTFB + 'ms') : 'tts_ttfb=n/a',
    t.total_response_duration_ms != null
      ? ('total_response=' + t.total_response_duration_ms + 'ms')
      : 'total_response=incomplete',
    t.rate_limited ? 'RATE_LIMITED' : (t.silent_wait_fail ? 'SILENT_WAIT_FAIL' : (t.slow ? 'SLOW' : 'ok')),
    bn ? ('bottleneck=' + bn.stage_gap + '@' + bn.ms + 'ms') : 'bottleneck=n/a',
  ].join(' | ');
}

/**
 * Designed budget comparison (code-path intent). Live Hostinger numbers replace
 * AFTER_* once Browser Talk samples are posted. First audio improves via
 * streaming / early ack / tighter STT. Total response duration may stay long
 * when explanations are detailed — that is intentional.
 */
function syntheticBudgetComparison() {
  return {
    before: {
      first_audio_ms: 14403,
      total_response_duration_ms: 18000,
      notes: 'Baseline tip 7f03dd0: speech blocked on full LLM+tools before any TTS',
    },
    after_designed: {
      first_audio_ms: 1000,
      total_response_duration_ms: 'adaptive (not optimized down)',
      mechanism: 'stream first safe phrase to TTS; booking ack parallel with tools; aggregation off; Groq RL fallback; TTS keep-alive',
      notes: 'Answer completeness preserved. Total duration may exceed first audio by design. Harness numbers are non-acceptance.',
    },
    flawed_p01_live: { ...LIVE_BASELINE_FLAWED_P01 },
    targets: { ...TARGETS },
    measurement: MEASUREMENT_SEMANTICS,
  };
}

/**
 * Extract the first safe natural phrase from a growing LLM buffer so TTS can
 * start while generation continues. Prefers sentence end (.!?।) after enough
 * content. Does not truncate the eventual full answer.
 */
function extractFirstSafePhrase(buffer, opts = {}) {
  const text = String(buffer || '').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  const minChars = Number(opts.minChars) || 24;
  const minWords = Number(opts.minWords) || 4;
  if (text.length < minChars) return null;

  const sentenceRe = /[.!?।](?:\s|$)/g;
  let match;
  let last = null;
  while ((match = sentenceRe.exec(text)) != null) {
    const phrase = text.slice(0, match.index + 1).trim();
    const words = phrase.split(/\s+/).filter(Boolean);
    if (phrase.length >= minChars && words.length >= minWords) {
      last = phrase;
      break;
    }
  }
  if (last) return last;

  // Soft break on comma / pause only when already substantial.
  const soft = text.match(/^(.{40,160}[,;:])\s/);
  if (soft) {
    const phrase = soft[1].trim();
    if (phrase.split(/\s+/).length >= minWords) return phrase;
  }
  return null;
}

/**
 * Invariant checks for a stage_trace (used by tests + report validation).
 */
function assertStageTraceInvariants(stageTrace) {
  const st = stageTrace || {};
  const errors = [];
  const t0 = st.t0 != null ? st.t0 : st.speech_end;
  if (t0 != null && Number(t0) !== 0) {
    errors.push('t0/speech_end offset must be 0');
  }
  let prev = -1;
  for (const row of CRITICAL_PATH) {
    const v = st[row.t] != null ? Number(st[row.t]) : (st[row.stage] != null ? Number(st[row.stage]) : null);
    if (v == null) continue;
    if (v < prev) errors.push(row.t + '/' + row.stage + ' went backwards');
    prev = v;
  }
  const derived = computeDerived(st);
  if (derived.TOTAL != null && derived.STT != null && derived.orchestration != null
    && derived.Groq_TTFT != null && derived.phrase_accum != null
    && derived.TTS_TTFB != null && derived.playback_buffer != null) {
    // Serial sum of critical gaps may be LESS than TOTAL when phrase→tts gap
    // exists, or MORE when stages overlap. Only check non-negative.
    for (const [k, v] of Object.entries(derived)) {
      if (v != null && v < 0) errors.push('derived ' + k + ' negative');
    }
  }
  return { ok: errors.length === 0, errors, derived };
}

module.exports = {
  STAGE_ORDER,
  CRITICAL_PATH,
  DERIVED_GAPS,
  MEASUREMENT_SEMANTICS,
  TARGETS,
  BASELINE_BEFORE,
  LIVE_BASELINE_FLAWED_P01,
  QUALITY_GATES,
  createTurnTrace,
  markStage,
  applyStageTrace,
  buildStageTraceFromStages,
  computeDerived,
  recompute,
  ingestTurnTiming,
  publicTrace,
  identifyBottleneck,
  listTraces,
  getTrace,
  clearTraces,
  formatEvidenceLine,
  summarizeEvidence,
  syntheticBudgetComparison,
  extractFirstSafePhrase,
  assertStageTraceInvariants,
  percentile,
  median,
  firstAudioStats,
  totalDurationStats,
  derivedGapStats,
  nowMs,
  genTurnId,
};
