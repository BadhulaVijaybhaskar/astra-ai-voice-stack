/**
 * Astra Voice. Sub-1000ms voice fast path vs tool path.
 *
 * Fast path: STT final → stream LLM → TTS on first safe phrase (no tools).
 * Tool path: speak booking/ack FIRST (<=1200ms), run tools in background,
 * then continue collecting details. Never block first audio on Cal.com.
 *
 * Also: context compaction for first-response, prompt token audit, static
 * prompt cache keys, parallel stage helpers.
 *
 * P0.2: at most one conversational LLM call before first audible response.
 * Defer classifier / language / qualification / summarizer hops until after
 * first speech (or end of call). Booking uses local ack (0 LLM before speech).
 *
 * Latency != shorter answers. Preserve answer depth.
 * No em dashes. Commas and periods only.
 */
'use strict';

const asrGuard = require('./asr-sanity-guard');
const turnLatency = require('./turn-latency');

const FIRST_AUDIO_TARGET_MS = 1000;
const FIRST_AUDIO_STRETCH_MS = 1200;
const FIRST_AUDIO_HARD_FAIL_MS = 2500;
const TOOL_ACK_TARGET_MS = 1200;
const STT_FINAL_TARGET_MS = 250;
const MAX_LLM_BEFORE_FIRST_SPEECH = 1;

const BOOKING_ACK = Object.freeze({
  hi: 'Haan, bilkul. Demo book karte hain.',
  en: 'Yes. Let us book a short demo.',
  te: 'సరే. డెమో బుక్ చేసుకుందాం.',
  hinglish: 'Haan, bilkul. Demo book karte hain.',
});

/**
 * Pick booking acknowledgement language from user text.
 */
function detectAckLanguage(text) {
  const s = String(text || '');
  if (/[\u0C00-\u0C7F]/.test(s)) return 'te';
  if (/[\u0900-\u097F]/.test(s)) return 'hi';
  if (/kar\s*sakte|bilkul|haan|demo\s*schedule|book\s*kar/i.test(s)) return 'hinglish';
  return 'en';
}

function bookingAckSpeech(userText) {
  const lang = detectAckLanguage(userText);
  return {
    language: lang,
    text: BOOKING_ACK[lang] || BOOKING_ACK.en,
    booking_intent: asrGuard.isBookingOrScheduleIntent(userText),
  };
}

/**
 * Classify whether this turn should use the fast path or the tool path.
 * Tool path still speaks first (ack); tools never gate first audio.
 */
function classifyTurnPath(userText, opts = {}) {
  const text = String(userText || '').trim();
  const booking = asrGuard.isBookingOrScheduleIntent(text);
  // Default booking enters tool path for Cal.com later, but first audio is ack.
  if (booking) {
    return {
      path: 'tool',
      reason: 'booking_intent',
      first_audio_strategy: 'ack_then_continue',
      ack: bookingAckSpeech(text),
      tools_block_first_audio: false,
      first_audio_target_ms: TOOL_ACK_TARGET_MS,
      // Local ack: zero LLM needed before first audible.
      max_llm_before_first_speech: 0,
      defer_secondary_llms: true,
      force_tools: !!opts.forceTools,
    };
  }
  return {
    path: 'fast',
    reason: 'ordinary_dialogue',
    first_audio_strategy: 'stream_first_safe_phrase',
    ack: null,
    tools_block_first_audio: false,
    first_audio_target_ms: FIRST_AUDIO_TARGET_MS,
    // One conversational Groq stream only before first speech.
    max_llm_before_first_speech: MAX_LLM_BEFORE_FIRST_SPEECH,
    defer_secondary_llms: true,
  };
}

/**
 * Plan which LLM calls are allowed before first audible response.
 * Secondary hops (classifier, language detect, qualification router,
 * summarizer) MUST wait until after first speech / end of call.
 */
function planPreSpeechLlm(userText, opts = {}) {
  const pathInfo = classifyTurnPath(userText, opts);
  const allowed = [];
  if (pathInfo.max_llm_before_first_speech >= 1) {
    allowed.push({
      role: 'main_conversational',
      timing: 'before_first_audio',
      required: true,
    });
  }
  const deferred = [
    { role: 'edge_router_classifier', timing: 'after_first_audio', required: false },
    { role: 'language_detect_llm', timing: 'after_first_audio', required: false, note: 'Prefer STT language / local detect' },
    { role: 'qualification_bank_preload', timing: 'after_first_audio', required: false },
    { role: 'call_summarizer', timing: 'after_call', required: false },
  ];
  return {
    path: pathInfo.path,
    first_audio_strategy: pathInfo.first_audio_strategy,
    max_llm_before_first_speech: pathInfo.max_llm_before_first_speech,
    allowed_before_first_speech: allowed,
    deferred_after_first_speech: deferred,
    ack: pathInfo.ack,
    invariant: 'one conversational turn → at most one LLM needed before first audible',
  };
}

/**
 * Enforce pre-speech LLM budget. Returns ok:false when a second LLM would
 * run before first audio (e.g. WF8 edge router + main).
 */
function assertSingleLlmBeforeFirstSpeech(callsBeforeFirstSpeech, pathInfo) {
  const max = pathInfo && pathInfo.max_llm_before_first_speech != null
    ? Number(pathInfo.max_llm_before_first_speech)
    : MAX_LLM_BEFORE_FIRST_SPEECH;
  const n = Number(callsBeforeFirstSpeech) || 0;
  return {
    ok: n <= max,
    calls: n,
    max,
    multi_llm_before_first_speech: n > max,
  };
}

/**
 * HI booking ack (P50 ~707ms flawed sample) vs ordinary turn architecture diff.
 * Apply the same architecture (ack-first / defer tools / fewer pre-speech LLMs)
 * to ordinary turns without hard-coding booking shortcuts into unrelated answers.
 */
function hiVsOrdinaryArchitectureDiff() {
  return {
    hindi_booking_ack: {
      first_audio_strategy: 'local_ack_zero_llm',
      llm_before_first_speech: 0,
      tools_before_first_speech: false,
      why_fast: 'Ack text is local policy. TTS starts immediately. Groq runs in parallel for follow-up (email ask), not for first syllable.',
      measured_flawed_p50_ms: 707,
    },
    ordinary_en_te_mixed: {
      first_audio_strategy: 'stream_first_safe_phrase',
      llm_before_first_speech: 1,
      tools_before_first_speech: false,
      why_slower_when_broken: 'If WF8/dashboard fires classifier + main + language + qualification before speech, Groq RPM burns and TTFT stacks. Fix is single main stream + TTS on first_safe_phrase, not a hard-coded booking ack in ordinary answers.',
    },
    architecture_to_copy: [
      'Defer secondary LLMs until after first audio',
      'Never block first audio on tools',
      'Speak as soon as a safe natural phrase (or local ack) exists',
      'Continue main LLM while TTS plays',
    ],
    do_not_copy: [
      'Do not hard-code booking ack phrases into unrelated ordinary answers',
      'Do not shorten useful explanations to hit latency',
    ],
  };
}

/**
 * Compact continuous customer context for first-response injection.
 * Preserves quality facts. Drops verbose timelines from the hot path.
 */
function compactContextForFirstResponse(injection, opts = {}) {
  const maxChars = Number(opts.maxChars) || 420;
  const raw = String(injection || '').trim();
  if (!raw) return { text: '', chars: 0, compacted: false };
  if (raw.length <= maxChars) {
    return { text: raw, chars: raw.length, compacted: false };
  }
  // Prefer lead/status/appointment lines; drop long narrative tails.
  const lines = raw.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  const prefer = [];
  const rest = [];
  for (const line of lines) {
    if (/^(name|phone|email|status|lead|appointment|timezone|company|need|summary)\b/i.test(line)
      || /booked|qualified|demo|slot/i.test(line)) {
      prefer.push(line);
    } else {
      rest.push(line);
    }
  }
  let out = '';
  for (const line of prefer.concat(rest)) {
    const next = out ? (out + '\n' + line) : line;
    if (next.length > maxChars) break;
    out = next;
  }
  if (!out) out = raw.slice(0, maxChars);
  return { text: out, chars: out.length, compacted: true, original_chars: raw.length };
}

/**
 * Build first-response system prompt: Maya core + current customer context +
 * recent turns live in messages + necessary KB snippet + language note.
 * No full historical transcripts / every tool schema.
 */
function buildFirstResponseSystem(opts = {}) {
  const parts = [];
  if (opts.mayaCore) parts.push(String(opts.mayaCore).trim());
  if (opts.customerContext) {
    const compact = compactContextForFirstResponse(opts.customerContext, {
      maxChars: opts.contextMaxChars || 420,
    });
    if (compact.text) parts.push('# CURRENT CUSTOMER\n' + compact.text);
  }
  if (opts.kbSnippet) {
    parts.push('# RELEVANT KB\n' + String(opts.kbSnippet).slice(0, 600));
  }
  if (opts.languageNote) {
    parts.push('# LANGUAGE\n' + String(opts.languageNote).slice(0, 240));
  }
  if (opts.relevantToolsNote) {
    parts.push('# TOOLS (AFTER FIRST SPEECH)\n' + String(opts.relevantToolsNote).slice(0, 400));
  }
  const system = parts.filter(Boolean).join('\n\n');
  return {
    system,
    chars: system.length,
    approx_tokens: Math.ceil(system.length / 4),
    audit: auditPromptTokens({
      maya_core: opts.mayaCore || '',
      customer: opts.customerContext || '',
      kb: opts.kbSnippet || '',
      language: opts.languageNote || '',
      tools: opts.relevantToolsNote || '',
      __required: {
        maya_core: true,
        customer: true,
        kb: false,
        language: true,
        tools: false,
      },
    }),
  };
}

/**
 * Prompt token audit (approx 4 chars / token). Flags oversized static prompts.
 */
function auditPromptTokens(parts = {}) {
  const rows = [];
  let totalChars = 0;
  for (const [name, text] of Object.entries(parts)) {
    const chars = String(text || '').length;
    const tokens = Math.ceil(chars / 4);
    totalChars += chars;
    rows.push({
      name,
      chars,
      approx_tokens: tokens,
      // Static system prompts above ~900 tokens slow TTFT on Groq.
      heavy: tokens > 900,
      required_for_first_response: parts.__required && parts.__required[name] === true
        ? 'YES'
        : (parts.__required && parts.__required[name] === false ? 'NO' : 'UNKNOWN'),
    });
  }
  const totalTokens = Math.ceil(totalChars / 4);
  return {
    parts: rows.filter((r) => r.name !== '__required'),
    total_chars: totalChars,
    approx_tokens: totalTokens,
    recommendation: totalTokens > 1200
      ? 'Defer non-essential policy blocks until after first phrase TTS starts'
      : 'Prompt size OK for sub-1000ms target when streaming',
  };
}

/** In-process cache for static Maya policy strings (workstream 12). */
const staticCache = new Map();

function getCachedStatic(key, builder) {
  const k = String(key || '');
  if (staticCache.has(k)) {
    return { value: staticCache.get(k), cache_hit: true };
  }
  const value = typeof builder === 'function' ? builder() : builder;
  staticCache.set(k, value);
  return { value, cache_hit: false };
}

function clearStaticCache() {
  staticCache.clear();
}

/**
 * Parallel helper: run independent prep work together before/while LLM streams.
 */
async function parallelPrep(tasks = {}) {
  const keys = Object.keys(tasks);
  const started = Date.now();
  const results = await Promise.all(keys.map(async (k) => {
    try {
      const value = await tasks[k]();
      return { key: k, ok: true, value };
    } catch (e) {
      return { key: k, ok: false, error: String((e && e.message) || e) };
    }
  }));
  const out = { latency_ms: Date.now() - started, results: {} };
  for (const r of results) out.results[r.key] = r;
  return out;
}

function latencyBudgets() {
  return {
    ordinary_first_audio_ms: FIRST_AUDIO_TARGET_MS,
    stretch_ms: FIRST_AUDIO_STRETCH_MS,
    hard_fail_ms: FIRST_AUDIO_HARD_FAIL_MS,
    tool_ack_ms: TOOL_ACK_TARGET_MS,
    stt_final_ms: STT_FINAL_TARGET_MS,
    max_llm_before_first_speech: MAX_LLM_BEFORE_FIRST_SPEECH,
    primary_metric: 'speech_end → first audible',
    note: 'Do not shorten useful answers to hit these budgets',
  };
}

function evaluateFirstAudio(ms, opts = {}) {
  const n = Number(ms);
  if (!Number.isFinite(n)) return { status: 'incomplete', ms: null };
  const tool = !!opts.tool_assisted;
  const target = tool ? TOOL_ACK_TARGET_MS : FIRST_AUDIO_TARGET_MS;
  let status = 'PASS';
  if (n > FIRST_AUDIO_HARD_FAIL_MS) status = 'HARD_FAIL';
  else if (n > FIRST_AUDIO_STRETCH_MS && !tool) status = 'STRETCH_MISS';
  else if (n > target) status = tool ? 'TOOL_ACK_MISS' : 'STRETCH_MISS';
  else if (!tool && n > FIRST_AUDIO_TARGET_MS) status = 'STRETCH_OK';
  return { status, ms: n, target_ms: target };
}

module.exports = {
  FIRST_AUDIO_TARGET_MS,
  FIRST_AUDIO_STRETCH_MS,
  FIRST_AUDIO_HARD_FAIL_MS,
  TOOL_ACK_TARGET_MS,
  STT_FINAL_TARGET_MS,
  MAX_LLM_BEFORE_FIRST_SPEECH,
  BOOKING_ACK,
  detectAckLanguage,
  bookingAckSpeech,
  classifyTurnPath,
  planPreSpeechLlm,
  assertSingleLlmBeforeFirstSpeech,
  hiVsOrdinaryArchitectureDiff,
  compactContextForFirstResponse,
  buildFirstResponseSystem,
  auditPromptTokens,
  getCachedStatic,
  clearStaticCache,
  parallelPrep,
  latencyBudgets,
  evaluateFirstAudio,
  extractFirstSafePhrase: turnLatency.extractFirstSafePhrase,
};
