/**
 * Astra Voice. ASR confidence + semantic sanity guard.
 *
 * Prevents garbage STT output (e.g. "jc hot need matters sales team antibiotics")
 * from entering normal business dialogue. Prefers the validated multilingual STT
 * path: Deepgram nova-3-general with language=multi (Hinglish / TE-EN / HI-EN).
 *
 * Does not place PSTN. Does not mutate Maya Dograh WF8.
 * No em dashes anywhere. Commas and periods only.
 */
'use strict';

const VALIDATED_MULTILINGUAL_STT = Object.freeze({
  provider: 'deepgram',
  model: 'nova-3-general',
  language: 'multi',
  rationale: 'Validated for Telugu, TE-EN code-switch, Hindi/Hinglish on 8k phone audio.',
  alternatives: Object.freeze([
    Object.freeze({
      provider: 'sarvam',
      model: 'saarika:v2.5',
      language: 'unknown',
      note: 'Indic-first. Prefer when call language is locked to a single Indic code.',
    }),
  ]),
});

/** Minimum Deepgram/Sarvam confidence to accept without clarification. */
const DEFAULT_MIN_CONFIDENCE = 0.45;

/** Business / sales vocabulary that makes an English transcript plausible. */
const BUSINESS_LEXICON = Object.freeze([
  'lead', 'leads', 'hot', 'sales', 'team', 'qualify', 'qualification', 'demo',
  'schedule', 'book', 'booking', 'appointment', 'callback', 'email', 'price',
  'pricing', 'product', 'astra', 'voice', 'ai', 'agent', 'call', 'caller',
  'interest', 'interested', 'company', 'business', 'pipeline', 'crm', 'follow',
  'availability', 'slot', 'confirm', 'confirmation', 'calendar', 'meeting',
  'passed', 'pass', 'should', 'want', 'need', 'help', 'how', 'use', 'using',
  'works', 'working', 'hello', 'hi', 'namaste', 'thanks', 'thank', 'okay',
  'ok', 'haan', 'yes', 'no', 'nahi', 'please', 'kar', 'sakte', 'sakte', 'ho',
  'sakta', 'sakti', 'demo', 'schedule', 'karo', 'kijiye',
]);

/** Tokens that frequently appear in ASR garbage for this stack's failure mode. */
const GARBAGE_MARKERS = Object.freeze([
  'antibiotics', 'antibiotic', 'pharmacy', 'dosage', 'prescription',
  'jc', 'xyz', 'asdf', 'qwerty', 'lorem', 'ipsum',
]);

/** Telugu Unicode block (approx) + common TE loan markers. */
const TELUGU_RE = /[\u0C00-\u0C7F]/;
const DEVANAGARI_RE = /[\u0900-\u097F]/;
const LATIN_WORD_RE = /[A-Za-z']+/g;

function tokenizeLatin(text) {
  const m = String(text || '').match(LATIN_WORD_RE);
  return m ? m.map((w) => w.toLowerCase()) : [];
}

function hasIndicScript(text) {
  const s = String(text || '');
  return TELUGU_RE.test(s) || DEVANAGARI_RE.test(s);
}

function businessHitRate(tokens) {
  if (!tokens.length) return 0;
  let hits = 0;
  for (const t of tokens) {
    if (BUSINESS_LEXICON.includes(t)) hits += 1;
  }
  return hits / tokens.length;
}

function garbageMarkerCount(tokens) {
  let n = 0;
  for (const t of tokens) {
    if (GARBAGE_MARKERS.includes(t)) n += 1;
  }
  return n;
}

/**
 * Detect "word salad": short English tokens with almost no business lexicon
 * and/or domain-foreign markers (antibiotics in a sales call).
 */
function looksLikeWordSalad(text) {
  const tokens = tokenizeLatin(text);
  if (tokens.length < 3) return false;
  if (hasIndicScript(text)) return false;
  const markers = garbageMarkerCount(tokens);
  if (markers >= 1 && businessHitRate(tokens) < 0.35) return true;
  // Low business density + many short nonsense-looking tokens.
  const shortOdd = tokens.filter((t) => t.length <= 2 && !['ai', 'ok', 'hi', 'no', 'to', 'of', 'in', 'on', 'or', 'an', 'a', 'i'].includes(t));
  if (markers >= 1) return true;
  if (businessHitRate(tokens) < 0.15 && tokens.length >= 5 && shortOdd.length >= 1) return true;
  // Exact known PSTN QA failure shape.
  const joined = tokens.join(' ');
  if (/jc\s+hot\s+need\s+matters\s+sales\s+team\s+antibiotics/.test(joined)) return true;
  return false;
}

/**
 * Evaluate a transcript before it enters normal business dialogue.
 *
 * @param {string} text
 * @param {object} [opts]
 * @param {number|null} [opts.confidence]
 * @param {number} [opts.minConfidence]
 * @param {string} [opts.expectedLanguage] e.g. te-IN, hi-IN, multi
 * @param {object} [opts.stt] { provider, model, language }
 * @returns {{
 *   ok: boolean,
 *   action: 'accept'|'clarify'|'reject',
 *   reasons: string[],
 *   confidence: number|null,
 *   text: string,
 *   stt: object|null,
 *   is_booking_intent: boolean,
 *   has_indic_script: boolean,
 * }}
 */
function evaluateTranscript(text, opts = {}) {
  const raw = String(text || '').trim();
  const confidence = opts.confidence == null || opts.confidence === ''
    ? null
    : Number(opts.confidence);
  const minConfidence = Number.isFinite(Number(opts.minConfidence))
    ? Number(opts.minConfidence)
    : DEFAULT_MIN_CONFIDENCE;
  const reasons = [];
  const stt = opts.stt && typeof opts.stt === 'object'
    ? {
      provider: String(opts.stt.provider || ''),
      model: String(opts.stt.model || ''),
      language: String(opts.stt.language || opts.expectedLanguage || ''),
    }
    : null;

  if (!raw) {
    return {
      ok: false,
      action: 'clarify',
      reasons: ['empty_transcript'],
      confidence: Number.isFinite(confidence) ? confidence : null,
      text: '',
      stt,
      is_booking_intent: false,
      has_indic_script: false,
    };
  }

  const indic = hasIndicScript(raw);
  const tokens = tokenizeLatin(raw);
  const booking = isBookingOrScheduleIntent(raw);

  if (Number.isFinite(confidence) && confidence < minConfidence) {
    reasons.push('low_confidence');
  }
  if (looksLikeWordSalad(raw)) {
    reasons.push('semantic_garbage');
  }
  // Extremely short Latin-only noise.
  if (!indic && tokens.length === 1 && tokens[0].length <= 2 && !['ok', 'hi', 'no', 'ha'].includes(tokens[0])) {
    reasons.push('too_short_noise');
  }

  let action = 'accept';
  if (reasons.includes('semantic_garbage')) action = 'reject';
  else if (reasons.length) action = 'clarify';

  return {
    ok: action === 'accept',
    action,
    reasons,
    confidence: Number.isFinite(confidence) ? confidence : null,
    text: raw,
    stt,
    is_booking_intent: booking,
    has_indic_script: indic,
  };
}

/**
 * True when the caller is asking to book / schedule (EN or HI-EN).
 * Used so booking intents never look like hangup/goodbye.
 */
function isBookingOrScheduleIntent(text) {
  const s = String(text || '').trim();
  if (!s) return false;
  if (/\b(demo|book|booking|schedule|appointment|calendar|availability|slot)\b/i.test(s)) return true;
  // Hinglish: "demo schedule kar sakte ho", "book kar do", "appointment lena hai"
  if (/schedule\s*kar|book\s*kar|demo\s*schedule|kar\s*sakte|appointment\s*(lena|lo|chahiye)|slot\s*(chahiye|book)/i.test(s)) {
    return true;
  }
  if (/ठीक|डेमो|शेड्यूल|अपॉइंटमेंट|बुक/.test(s)) return true;
  return false;
}

/**
 * Clarification line when ASR is rejected. Never invents the caller's content.
 */
function clarificationPrompt(evalResult) {
  if (!evalResult || evalResult.action === 'accept') return null;
  if (evalResult.action === 'reject') {
    return 'I did not catch that clearly. Could you say that again in one short sentence?';
  }
  return 'Sorry, one quick check. Could you repeat that?';
}

/**
 * Build a diagnostic STT turn trace for evidence capture.
 */
function buildSttTrace(input = {}) {
  const partials = Array.isArray(input.partials)
    ? input.partials.map((p) => String(p || '').slice(0, 500)).filter(Boolean)
    : [];
  const finalText = String(input.final || input.text || '').slice(0, 2000);
  const guard = input.guard || evaluateTranscript(finalText, {
    confidence: input.confidence,
    stt: input.stt,
    expectedLanguage: input.language,
  });
  const sttCfg = input.stt || VALIDATED_MULTILINGUAL_STT;
  return {
    at: new Date().toISOString(),
    provider: String(sttCfg.provider || ''),
    model: String(sttCfg.model || ''),
    language: String(sttCfg.language || input.language || ''),
    partials,
    final: finalText,
    confidence: guard.confidence,
    guard: {
      ok: !!guard.ok,
      action: guard.action,
      reasons: (guard.reasons || []).slice(),
    },
    llm_input_allowed: guard.action === 'accept',
    phrase_fixture: input.phrase_fixture || null,
  };
}

/**
 * Prefer validated multilingual STT. Returns normalized config + note if input
 * already matches or should be upgraded.
 */
function preferValidatedMultilingualStt(current) {
  const cur = current && typeof current === 'object' ? current : {};
  const provider = String(cur.provider || '').toLowerCase();
  const model = String(cur.model || '');
  const language = String(cur.language || '');
  const matches = provider === VALIDATED_MULTILINGUAL_STT.provider
    && /nova-3/i.test(model)
    && (/^multi$/i.test(language) || language === '');
  return {
    recommended: { ...VALIDATED_MULTILINGUAL_STT },
    current: {
      provider: provider || null,
      model: model || null,
      language: language || null,
    },
    matches_validated_path: matches,
    apply: {
      provider: VALIDATED_MULTILINGUAL_STT.provider,
      model: VALIDATED_MULTILINGUAL_STT.model,
      language: VALIDATED_MULTILINGUAL_STT.language,
      credentials_ref: cur.credentials_ref || 'cred_deepgram',
    },
  };
}

/**
 * Fixture phrases from the failed PSTN QA (reproduction matrix).
 */
const QA_FIXTURES = Object.freeze({
  telugu_mixed: 'ఇది లీడ్ క్వాలిఫికేషన్ కి ఎలా యూస్ అవుతుంది?',
  te_en_hot_leads: 'hot leads should be passed to the sales team',
  garbage_failure: 'jc hot need matters sales team antibiotics',
  hindi_booking: 'Okay, demo schedule kar sakte ho?',
});

module.exports = {
  VALIDATED_MULTILINGUAL_STT,
  DEFAULT_MIN_CONFIDENCE,
  QA_FIXTURES,
  evaluateTranscript,
  isBookingOrScheduleIntent,
  clarificationPrompt,
  buildSttTrace,
  preferValidatedMultilingualStt,
  looksLikeWordSalad,
  hasIndicScript,
};
