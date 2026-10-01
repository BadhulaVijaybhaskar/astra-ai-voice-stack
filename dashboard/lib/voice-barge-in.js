/**
 * Astra Voice. Platform-wide barge-in / interrupt handling.
 *
 * Employee-agnostic: any realtime employee uses the same playback-stop budget,
 * spoken_text-only interrupt context, and tool-safety rules.
 *
 * Budgets (playback_stop after user speech detected):
 *   target ≤200ms · ok ≤300ms · fail >500ms
 *
 * No em dashes. Commas and periods only.
 */
'use strict';

const PLAYBACK_STOP_TARGET_MS = 200;
const PLAYBACK_STOP_OK_MS = 300;
const PLAYBACK_STOP_FAIL_MS = 500;

/**
 * Evaluate barge-in playback_stop latency against platform budget.
 */
function evaluatePlaybackStop(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) {
    return { status: 'incomplete', ms: null, target_ms: PLAYBACK_STOP_TARGET_MS };
  }
  let status = 'PASS';
  if (n > PLAYBACK_STOP_FAIL_MS) status = 'HARD_FAIL';
  else if (n > PLAYBACK_STOP_OK_MS) status = 'MISS';
  else if (n > PLAYBACK_STOP_TARGET_MS) status = 'OK';
  return {
    status,
    ms: n,
    target_ms: PLAYBACK_STOP_TARGET_MS,
    ok_ms: PLAYBACK_STOP_OK_MS,
    fail_ms: PLAYBACK_STOP_FAIL_MS,
  };
}

/**
 * Build interrupt context for the next LLM turn after barge-in.
 * Only include text the caller actually heard (spoken_text), never the
 * full buffered/unspoken assistant draft.
 */
function buildInterruptContext(opts = {}) {
  const spoken = String(opts.spoken_text || opts.spokenText || '').trim();
  const truncated = !!opts.truncated || !!spoken;
  return {
    interrupted: true,
    spoken_text: spoken,
    // Explicitly omit unspoken remainder from model context.
    unspoken_text: null,
    truncated,
    note: 'Continue from what the caller heard. Do not repeat unspoken draft.',
    platform: 'shared_realtime_path',
  };
}

/**
 * Tool safety under barge-in: in-flight tools may finish but must not
 * speak their result over the new user turn. Never start a new tool from
 * an interrupted turn. Idempotent booking/write tools stay safe.
 */
function planToolSafetyOnBargeIn(opts = {}) {
  const inFlight = Array.isArray(opts.in_flight_tools) ? opts.in_flight_tools : [];
  return {
    cancel_new_tools: true,
    allow_in_flight_to_finish: true,
    suppress_tool_speech_until_next_turn: true,
    in_flight_tools: inFlight.map((t) => ({
      name: String((t && t.name) || t || ''),
      finish_quietly: true,
      idempotent_required: /book|cal\.com|write|schedule|create/i.test(
        String((t && t.name) || t || '')
      ),
    })),
    rule: 'Interrupted turn: no new tools; finish in-flight quietly; next turn owns speech.',
  };
}

/**
 * Platform barge-in plan (employee-agnostic).
 */
function planBargeIn(opts = {}) {
  const stopEval = evaluatePlaybackStop(opts.playback_stop_ms);
  return {
    platform: 'shared_realtime_path',
    employee_agnostic: true,
    playback_stop: stopEval,
    interrupt_context: buildInterruptContext(opts),
    tool_safety: planToolSafetyOnBargeIn(opts),
    budgets: {
      playback_stop_target_ms: PLAYBACK_STOP_TARGET_MS,
      playback_stop_ok_ms: PLAYBACK_STOP_OK_MS,
      playback_stop_fail_ms: PLAYBACK_STOP_FAIL_MS,
    },
  };
}

module.exports = {
  PLAYBACK_STOP_TARGET_MS,
  PLAYBACK_STOP_OK_MS,
  PLAYBACK_STOP_FAIL_MS,
  evaluatePlaybackStop,
  buildInterruptContext,
  planToolSafetyOnBargeIn,
  planBargeIn,
};
