/**
 * Astra Voice. Turn latency instrumentation (LATENCY P0).
 *
 * PRIMARY METRIC: speech_end → first audible response (tts_first_audio /
 * playback_start). Ordinary target <=1000 ms (stretch <=1200, hard fail >2500).
 * Tool turns: first spoken ack <=1200 ms; tools stay in the background.
 * This is NOT a mandate to shorten useful answers. Once speech starts, Maya
 * may continue for as long as the question needs.
 *
 * SECONDARY: total_response_duration_ms (speech_end → response_complete when
 * the full answer finishes). Report FIRST AUDIO P50/P90/P95 separately from
 * TOTAL RESPONSE DURATION.
 *
 * Stages (absolute ms from speech_end):
 *   speech_end, stt_final, llm_request, llm_first_token, llm_complete,
 *   tool_start, tool_complete, tts_request, tts_first_audio, playback_start,
 *   response_complete
 *
 * Streaming model: start TTS on the first safe natural phrase while the LLM
 * continues the rest concurrently. Booking may speak an immediate ack, then
 * collect details; tools may continue async. Silent wait >4s before first
 * audio = FAIL.
 *
 * Baseline tip 7f03dd0 (Hostinger Maya WF8): median 14403ms, max 54597ms,
 * mixed ~25800ms. Bottleneck: WF8 LLM/tool especially booking.
 *
 * In-memory ring buffer only. No em dashes. Commas and periods only.
 */
'use strict';

const crypto = require('crypto');

const STAGE_ORDER = Object.freeze([
  'speech_end',
  'stt_final',
  'llm_request',
  'llm_first_token',
  'llm_complete',
  'tool_start',
  'tool_complete',
  'tts_request',
  'tts_first_audio',
  'playback_start',
  'response_complete',
]);

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
    deltas_ms: {},
    absolute_ms: {},
    first_audio_ms: null,
    total_response_duration_ms: null,
    total_speech_end_to_playback_ms: null,
    silent_wait_ms: null,
    silent_wait_fail: false,
    tool_assisted: false,
    booking_ack: false,
    streamed_first_phrase: false,
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
  if (prev && (stage === 'tts_first_audio' || stage === 'playback_start' || stage === 'llm_first_token')) {
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
  if (extra && (extra.streamed_first_phrase || extra.detail === 'first_safe_phrase')) {
    trace.streamed_first_phrase = true;
  }
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
  trace.deltas_ms = deltas;

  const absolute = {};
  if (stages.speech_end) {
    const origin = stages.speech_end.at_ms;
    for (const stage of STAGE_ORDER) {
      if (stages[stage]) absolute[stage] = Math.max(0, stages[stage].at_ms - origin);
    }
  }
  trace.absolute_ms = absolute;

  let firstAudio = null;
  if (stages.speech_end) {
    const candidates = [];
    if (stages.tts_first_audio) candidates.push(stages.tts_first_audio.at_ms);
    if (stages.playback_start) candidates.push(stages.playback_start.at_ms);
    if (candidates.length) {
      firstAudio = Math.max(0, Math.min(...candidates) - stages.speech_end.at_ms);
    }
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
    };
  }
  if (body.tts) {
    trace.tts = {
      provider: String(body.tts.provider || '').slice(0, 40),
      model: String(body.tts.model || '').slice(0, 80),
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
  };
}

function identifyBottleneck(trace) {
  const deltas = trace.deltas_ms || {};
  let bestKey = null;
  let bestMs = -1;
  for (const [k, v] of Object.entries(deltas)) {
    // Prefer gaps that delay first audio over total-duration gaps.
    if (k === 'speech_end_to_response_complete') continue;
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
  const bottlenecks = rows.map((r) => r.bottleneck && r.bottleneck.stage_gap).filter(Boolean);
  const bottleneckCounts = {};
  for (const b of bottlenecks) bottleneckCounts[b] = (bottleneckCounts[b] || 0) + 1;
  const BOTTLENECKS = Object.entries(bottleneckCounts)
    .map(([stage_gap, count]) => ({ stage_gap, count }))
    .sort((a, b) => b.count - a.count);

  const allFirst = firstAudioStats(rows);
  const allTotal = totalDurationStats(rows);

  const designedOk = true; // code path enables streaming first phrase; live confirm on Hostinger
  const ready = allFirst.P50 != null
    && allFirst.P50 <= TARGETS.first_audio_p50_ms
    && silentFails.length === 0;

  return {
    primary_metric: 'speech_end → first audible response (NOT total answer length)',
    first_audio_target_ms: [TARGETS.first_audio_target_min_ms, TARGETS.first_audio_target_max_ms],
    baseline_before: { ...BASELINE_BEFORE },
    targets: { ...TARGETS },
    sample_count: rows.length,
    ENGLISH: {
      FIRST_AUDIO: firstAudioStats(english),
      TOTAL_RESPONSE_DURATION: totalDurationStats(english),
    },
    TELUGU: {
      FIRST_AUDIO: firstAudioStats(telugu),
      TOTAL_RESPONSE_DURATION: totalDurationStats(telugu),
    },
    MIXED: {
      FIRST_AUDIO: firstAudioStats(mixed),
      TOTAL_RESPONSE_DURATION: totalDurationStats(mixed),
    },
    HINDI_BOOKING: {
      FIRST_AUDIO: firstAudioStats(hindi),
      TOTAL_RESPONSE_DURATION: totalDurationStats(hindi),
    },
    FIRST_AUDIO: allFirst,
    TOTAL_RESPONSE_DURATION: allTotal,
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
    ],
  };
}

function formatEvidenceLine(trace) {
  const t = publicTrace(trace);
  if (!t) return '';
  const bn = t.bottleneck;
  return [
    t.turn_id,
    t.first_audio_ms != null ? ('first_audio=' + t.first_audio_ms + 'ms') : 'first_audio=incomplete',
    t.total_response_duration_ms != null
      ? ('total_response=' + t.total_response_duration_ms + 'ms')
      : 'total_response=incomplete',
    t.silent_wait_fail ? 'SILENT_WAIT_FAIL' : (t.slow ? 'SLOW' : 'ok'),
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
      mechanism: 'stream first safe phrase to TTS; booking ack parallel with tools; aggregation off',
      notes: 'Answer completeness preserved. Total duration may exceed first audio by design.',
    },
    targets: { ...TARGETS },
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

  // Soft break on comma / em-equivalent pause only when already substantial.
  const soft = text.match(/^(.{40,160}[,;:])\s/);
  if (soft) {
    const phrase = soft[1].trim();
    if (phrase.split(/\s+/).length >= minWords) return phrase;
  }
  return null;
}

module.exports = {
  STAGE_ORDER,
  TARGETS,
  BASELINE_BEFORE,
  QUALITY_GATES,
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
  summarizeEvidence,
  syntheticBudgetComparison,
  extractFirstSafePhrase,
  percentile,
  median,
  firstAudioStats,
  totalDurationStats,
  nowMs,
  genTurnId,
};
