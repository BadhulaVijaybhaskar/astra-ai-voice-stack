/**
 * Astra Voice. Shared multilingual call/session runtime (platform-wide).
 *
 * Every AI Employee call/session gets:
 *   primary_language, allowed_languages[], languageVoiceConfig{}, STT multi
 *
 * Primary means ONLY:
 *   - default greeting language
 *   - default initial recognition preference
 *   - default response language before caller language is known
 * Primary must NOT permanently lock the call to one language.
 *
 * Per turn: audio → multilingual STT → detect language → transcript →
 * ASR guard → LLM → response language → TTS language_code.
 *
 * Employee-name agnostic. No Maya/Vaani/Telugu-only fast paths.
 * Does NOT mutate production Dograh WF8. Does NOT change PSTN number.
 * No em dashes anywhere. Commas and periods only.
 */
'use strict';

const voiceCatalog = require('./tts-voice-catalog');
const asrSanityGuard = require('./asr-sanity-guard');

/** Curated EN + Indic product languages (platform catalog). */
const PLATFORM_LANGUAGES = Object.freeze(
  voiceCatalog.listAstraSupportedLanguages().map((l) => Object.freeze({
    id: l.id,
    label: l.label,
    nativeLabel: l.nativeLabel,
    status: l.status,
  })),
);

const PLATFORM_LANGUAGE_IDS = Object.freeze(PLATFORM_LANGUAGES.map((l) => l.id));
const PLATFORM_LANGUAGE_SET = new Set(PLATFORM_LANGUAGE_IDS);

const INDIC_LANGUAGE_IDS = Object.freeze(
  PLATFORM_LANGUAGE_IDS.filter((id) => id !== 'en-IN'),
);

/** Validated multilingual STT for every employee (shared). */
const PLATFORM_STT = Object.freeze({
  provider: asrSanityGuard.VALIDATED_MULTILINGUAL_STT.provider,
  model: asrSanityGuard.VALIDATED_MULTILINGUAL_STT.model,
  language: asrSanityGuard.VALIDATED_MULTILINGUAL_STT.language,
});

/**
 * Unicode script ranges for platform Indic languages + Devanagari family.
 * Used for per-turn language detection and ASR guard Indic awareness.
 */
const SCRIPT_RANGES = Object.freeze([
  Object.freeze({ id: 'te-IN', re: /[\u0C00-\u0C7F]/ }),
  Object.freeze({ id: 'ta-IN', re: /[\u0B80-\u0BFF]/ }),
  Object.freeze({ id: 'kn-IN', re: /[\u0C80-\u0CFF]/ }),
  Object.freeze({ id: 'ml-IN', re: /[\u0D00-\u0D7F]/ }),
  Object.freeze({ id: 'bn-IN', re: /[\u0980-\u09FF]/ }),
  Object.freeze({ id: 'gu-IN', re: /[\u0A80-\u0AFF]/ }),
  Object.freeze({ id: 'pa-IN', re: /[\u0A00-\u0A7F]/ }),
  // Devanagari shared by Hindi + Marathi. Disambiguate with lastKnown / primary.
  Object.freeze({ id: 'hi-IN', re: /[\u0900-\u097F]/, also: ['mr-IN'] }),
]);

/** Localized recovery when STT/ASR fails. Never silence. */
const RECOVERY_BY_LANGUAGE = Object.freeze({
  'en-IN': "Sorry, I didn't catch that. Could you say it again?",
  'hi-IN': 'माफ़ कीजिए, मैं सुन नहीं पाया। क्या आप फिर से कह सकते हैं?',
  'te-IN': 'క్షమించండి, నాకు అర్థం కాలేదు. మళ్లీ చెప్పగలరా?',
  'ta-IN': 'மன்னிக்கவும், எனக்குப் புரியவில்லை. மீண்டும் சொல்ல முடியுமா?',
  'kn-IN': 'ಕ್ಷಮಿಸಿ, ನನಗೆ ಅರ್ಥವಾಗಲಿಲ್ಲ. ದಯವಿಟ್ಟು ಮತ್ತೆ ಹೇಳುತ್ತೀರಾ?',
  'ml-IN': 'ക്ഷമിക്കണം, എനിക്ക് മനസ്സിലായില്ല. വീണ്ടും പറയാമോ?',
  'mr-IN': 'माफ करा, मला समजले नाही. पुन्हा सांगाल का?',
  'bn-IN': 'দুঃখিত, আমি বুঝতে পারিনি। আপনি কি আবার বলতে পারেন?',
  'gu-IN': 'માફ કરશો, મને સમજાયું નહીં. શું તમે ફરી કહી શકો?',
  'pa-IN': 'ਮਾਫ਼ ਕਰਨਾ, ਮੈਨੂੰ ਸਮਝ ਨਹੀਂ ਆਇਆ। ਕੀ ਤੁਸੀਂ ਫਿਰ ਕਹਿ ਸਕਦੇ ਹੋ?',
});

/** Romanized / code-switch cues for Indic languages (Latin script). */
const TRANSLIT_CUES = Object.freeze({
  'hi-IN': /\b(haan|ji|namaste|kya|hai|hain|kar|sakte|bilkul|nahi|accha|theek|demo\s*schedule)\b/i,
  'te-IN': /\b(ela|elaa|undi|unnayi|cheyyali|cheyali|meeru|nenu|emi|gada|kadha|avuna|ledg?e?s?\s*ni|team\s*ki)\b/i,
  'ta-IN': /\b(epdi|irukku|sollunga|naan|unga|venum|seri|thanks?\s*unga)\b/i,
  'kn-IN': /\b(hege|ide|maadi|nanna|nimma|bedi|sari)\b/i,
  'ml-IN': /\b(entha|undu|cheyyu|njan|ningal|sheri)\b/i,
  'mr-IN': /\b(kay|aahe|kara|mala|tumhi|barobar)\b/i,
  'bn-IN': /\b(ki|ache|koro|ami|apni|thik)\b/i,
  'gu-IN': /\b(shu|che|karo|hu[n]?|tame|barabar)\b/i,
  'pa-IN': /\b(ki|hai|karo|main|tusi|theek)\b/i,
});

function normalizeLanguageCode(raw, fallback) {
  const s = String(raw || '').trim();
  if (PLATFORM_LANGUAGE_SET.has(s)) return s;
  const lower = s.toLowerCase().replace('_', '-');
  const aliases = {
    en: 'en-IN', english: 'en-IN', 'en-in': 'en-IN', 'en-us': 'en-IN', multi: '',
    hi: 'hi-IN', hindi: 'hi-IN', 'hi-in': 'hi-IN', hinglish: 'hi-IN',
    te: 'te-IN', telugu: 'te-IN', 'te-in': 'te-IN',
    ta: 'ta-IN', tamil: 'ta-IN', 'ta-in': 'ta-IN',
    kn: 'kn-IN', kannada: 'kn-IN', 'kn-in': 'kn-IN',
    ml: 'ml-IN', malayalam: 'ml-IN', 'ml-in': 'ml-IN',
    mr: 'mr-IN', marathi: 'mr-IN', 'mr-in': 'mr-IN',
    bn: 'bn-IN', bengali: 'bn-IN', 'bn-in': 'bn-IN',
    gu: 'gu-IN', gujarati: 'gu-IN', 'gu-in': 'gu-IN',
    pa: 'pa-IN', punjabi: 'pa-IN', 'pa-in': 'pa-IN',
  };
  if (aliases[lower]) return aliases[lower];
  if (fallback && PLATFORM_LANGUAGE_SET.has(fallback)) return fallback;
  return '';
}

function isIndicLanguage(lang) {
  const id = normalizeLanguageCode(lang);
  return !!id && id !== 'en-IN' && PLATFORM_LANGUAGE_SET.has(id);
}

function isPlatformLanguage(lang) {
  return PLATFORM_LANGUAGE_SET.has(normalizeLanguageCode(lang));
}

/**
 * Derive allowed_languages for an employee.
 * Explicit allowed_languages → else languageVoiceConfig keys → else [primary].
 * Always intersects with platform catalog. Always includes primary.
 */
function resolveAllowedLanguages(employee, opts = {}) {
  const voice = (employee && employee.voice) || {};
  const primary = normalizeLanguageCode(
    opts.primary_language
      || opts.primaryLanguage
      || voice.language
      || employee && employee.language
      || opts.language,
    'en-IN',
  ) || 'en-IN';

  const cfg = voice.languageVoiceConfig || opts.languageVoiceConfig || {};
  let allowed = [];
  const explicit = opts.allowed_languages || opts.allowedLanguages
    || voice.allowed_languages || voice.allowedLanguages
    || employee && employee.allowed_languages
    || employee && employee.allowedLanguages;

  if (Array.isArray(explicit) && explicit.length) {
    allowed = explicit.map((l) => normalizeLanguageCode(l)).filter(Boolean);
  } else if (cfg && typeof cfg === 'object' && Object.keys(cfg).length) {
    allowed = Object.keys(cfg).map((k) => normalizeLanguageCode(k)).filter(Boolean);
  } else if (opts.persona_language_routes && typeof opts.persona_language_routes === 'object') {
    allowed = Object.keys(opts.persona_language_routes)
      .map((k) => normalizeLanguageCode(k)).filter(Boolean);
  }

  // No languageVoiceConfig and no explicit list → primary only (not full catalog).
  if (!allowed.length) allowed = [primary];

  const set = new Set(allowed.filter((id) => PLATFORM_LANGUAGE_SET.has(id)));
  set.add(primary);
  return PLATFORM_LANGUAGE_IDS.filter((id) => set.has(id));
}

/**
 * Enforce validated multilingual STT for shared runtime.
 * Never lock STT to primary_language alone.
 */
function enforceMultilingualStt(stt) {
  const cur = stt && typeof stt === 'object' ? stt : {};
  const provider = String(cur.provider || PLATFORM_STT.provider).toLowerCase() || PLATFORM_STT.provider;
  const model = String(cur.model || PLATFORM_STT.model) || PLATFORM_STT.model;
  // Force multi for Deepgram nova-3 path. Sarvam unknown is also multilingual.
  let language = String(cur.language || '').trim();
  if (provider === 'deepgram' || !language || language === 'en' || language === 'en-IN') {
    language = PLATFORM_STT.language;
  }
  if (provider === 'sarvam' && (!language || language === 'en-IN')) {
    language = 'unknown';
  }
  // Prefer nova-3-general when Deepgram and model is blank / flux-only without TE.
  let outModel = model;
  if (provider === 'deepgram' && (!outModel || /flux/i.test(outModel))) {
    outModel = PLATFORM_STT.model;
  }
  return {
    provider: provider === 'deepgram' || provider === 'sarvam' ? provider : PLATFORM_STT.provider,
    model: provider === 'deepgram' ? (/nova-3/i.test(outModel) ? outModel : PLATFORM_STT.model) : outModel,
    language: provider === 'deepgram' ? PLATFORM_STT.language : language,
    credentials_ref: cur.credentials_ref || (provider === 'sarvam' ? 'cred_sarvam' : 'cred_deepgram'),
    multilingual: true,
    rationale: 'Platform multilingual STT: caller may start or switch any allowed language without session restart.',
  };
}

/**
 * Detect language from a transcript turn.
 * Prefers native script, then transliteration cues, then lastKnown, then primary.
 * Supports code-switching: returns dominant language within allowed set.
 */
function detectLanguageFromTranscript(text, opts = {}) {
  const raw = String(text || '').trim();
  const allowed = Array.isArray(opts.allowed_languages)
    ? opts.allowed_languages.map((l) => normalizeLanguageCode(l)).filter(Boolean)
    : PLATFORM_LANGUAGE_IDS.slice();
  const allowedSet = new Set(allowed.length ? allowed : PLATFORM_LANGUAGE_IDS);
  const primary = normalizeLanguageCode(opts.primary_language || opts.primary, 'en-IN') || 'en-IN';
  const lastKnown = normalizeLanguageCode(opts.last_known || opts.lastKnown || opts.current_language)
    || primary;

  if (!raw) {
    return {
      language: lastKnown,
      confidence: 0,
      source: 'empty_fallback_last_known',
      code_switch: false,
      dominant: lastKnown,
      scripts_found: [],
    };
  }

  const scriptsFound = [];
  for (const row of SCRIPT_RANGES) {
    if (row.re.test(raw)) scriptsFound.push(row.id);
  }

  let detected = '';
  let source = 'none';
  let codeSwitch = false;

  if (scriptsFound.length) {
    // Prefer exact script match in allowed set.
    const preferred = scriptsFound.find((id) => allowedSet.has(id));
    if (preferred) {
      detected = preferred;
      source = 'indic_script';
    } else if (scriptsFound.includes('hi-IN')) {
      // Devanagari: prefer lastKnown if Marathi/Hindi, else Hindi if allowed.
      if (allowedSet.has(lastKnown) && (lastKnown === 'hi-IN' || lastKnown === 'mr-IN')) {
        detected = lastKnown;
        source = 'devanagari_last_known';
      } else if (allowedSet.has('hi-IN')) {
        detected = 'hi-IN';
        source = 'devanagari_hindi';
      } else if (allowedSet.has('mr-IN')) {
        detected = 'mr-IN';
        source = 'devanagari_marathi';
      }
    }
    const hasLatin = /[A-Za-z]{3,}/.test(raw);
    codeSwitch = hasLatin && scriptsFound.length > 0;
  }

  if (!detected) {
    for (const id of allowed) {
      if (id === 'en-IN') continue;
      const cue = TRANSLIT_CUES[id];
      if (cue && cue.test(raw)) {
        detected = id;
        source = 'transliteration_cue';
        codeSwitch = /[A-Za-z]{3,}/.test(raw) && /\b(the|and|to|for|team|leads?|sales|demo|call)\b/i.test(raw);
        break;
      }
    }
  }

  if (!detected) {
    // Latin-only English (or unknown). Stay on lastKnown only when lastKnown
    // was Indic AND text has strong English-only shape with no translit cues.
    if (/[A-Za-z]/.test(raw) && !scriptsFound.length) {
      detected = allowedSet.has('en-IN') ? 'en-IN' : lastKnown;
      source = 'latin_english';
    } else {
      detected = lastKnown;
      source = 'fallback_last_known';
    }
  }

  if (!allowedSet.has(detected)) {
    detected = allowedSet.has(lastKnown) ? lastKnown : (allowedSet.has(primary) ? primary : (allowed[0] || 'en-IN'));
    source = 'clamped_to_allowed';
  }

  return {
    language: detected,
    confidence: source === 'indic_script' ? 0.95
      : source === 'transliteration_cue' ? 0.75
        : source === 'latin_english' ? 0.7
          : 0.4,
    source,
    code_switch: codeSwitch || (scriptsFound.length > 0 && /[A-Za-z]{3,}/.test(raw)),
    dominant: detected,
    scripts_found: scriptsFound,
    raw_preview: raw.slice(0, 120),
  };
}

/**
 * Response language selection: reply in caller's current detected language.
 * Heavy code-switch → dominant/current. Do not randomly switch.
 */
function selectResponseLanguage(detection, opts = {}) {
  const primary = normalizeLanguageCode(opts.primary_language || opts.primary, 'en-IN') || 'en-IN';
  const lastKnown = normalizeLanguageCode(opts.last_known || opts.lastKnown || opts.current_language) || primary;
  const allowed = Array.isArray(opts.allowed_languages) ? opts.allowed_languages : PLATFORM_LANGUAGE_IDS;
  const allowedSet = new Set(allowed);

  if (!detection || !detection.language) {
    return {
      response_language: lastKnown,
      reason: 'no_detection_use_last_known',
    };
  }

  let lang = normalizeLanguageCode(detection.language) || lastKnown;
  if (!allowedSet.has(lang)) {
    lang = allowedSet.has(lastKnown) ? lastKnown : primary;
  }

  // Uncertain detection: keep last known unless script evidence is strong.
  if (detection.confidence < 0.55 && detection.source !== 'indic_script') {
    return {
      response_language: lastKnown,
      reason: 'low_confidence_sticky',
      detected: detection.language,
    };
  }

  return {
    response_language: lang,
    reason: detection.code_switch ? 'dominant_code_switch' : 'follow_caller',
    detected: detection.language,
    code_switch: !!detection.code_switch,
  };
}

function recoveryPrompt(language, opts = {}) {
  const lang = normalizeLanguageCode(language || opts.last_known || opts.primary, 'en-IN') || 'en-IN';
  if (opts.action === 'reject') {
    const byLang = {
      'en-IN': 'I did not catch that clearly. Could you say that again in one short sentence?',
      'hi-IN': 'मुझे साफ़ सुनाई नहीं दिया। क्या आप एक छोटे वाक्य में फिर से कह सकते हैं?',
      'te-IN': 'నాకు స్పష్టంగా వినిపించలేదు. ఒక చిన్న వాక్యంలో మళ్లీ చెప్పగలరా?',
      'ta-IN': 'எனக்குத் தெளிவாகக் கேட்கவில்லை. ஒரு சிறிய வாக்கியத்தில் மீண்டும் சொல்ல முடியுமா?',
    };
    return byLang[lang] || byLang['en-IN'];
  }
  return RECOVERY_BY_LANGUAGE[lang] || RECOVERY_BY_LANGUAGE['en-IN'];
}

/**
 * Build shared multilingual runtime snapshot at call/session creation.
 * employee config → shared runtime (every AI Employee).
 */
function buildSessionMultilingualRuntime(employee, opts = {}) {
  const voice = (employee && employee.voice) || {};
  const primary = normalizeLanguageCode(
    opts.primary_language
      || opts.language
      || opts.initial_language
      || voice.language
      || (employee && employee.language),
    'en-IN',
  ) || 'en-IN';

  const allowed = resolveAllowedLanguages(employee, {
    primary_language: primary,
    allowed_languages: opts.allowed_languages,
    languageVoiceConfig: opts.languageVoiceConfig || voice.languageVoiceConfig,
    persona_language_routes: opts.persona_language_routes,
  });

  const stt = enforceMultilingualStt(opts.stt || (opts.pipeline && opts.pipeline.stt));
  const langVoiceCfg = voice.languageVoiceConfig || opts.languageVoiceConfig || {};

  return {
    primary_language: primary,
    allowed_languages: allowed,
    languageVoiceConfig: langVoiceCfg && typeof langVoiceCfg === 'object' ? langVoiceCfg : {},
    stt,
    greeting_language: primary,
    response_language: primary,
    current_language: primary,
    platform_languages: PLATFORM_LANGUAGE_IDS.slice(),
    multilingual: allowed.length > 1 || allowed.some(isIndicLanguage),
    semantics: {
      primary: 'greeting_and_initial_preference_only',
      mid_call: 'follow_detected_caller_language_within_allowed',
      code_switch: 'respond_in_dominant_current_language',
      stt: 'deepgram_nova3_multi_or_equivalent',
      silent_failure: 'forbidden_use_recovery_prompt',
    },
  };
}

/**
 * Context variables for Dograh / telephony mint (no secrets).
 */
function multilingualContextVariables(runtime) {
  if (!runtime) return {};
  return {
    astra_primary_language: runtime.primary_language || '',
    astra_allowed_languages: Array.isArray(runtime.allowed_languages)
      ? runtime.allowed_languages.join(',')
      : '',
    astra_response_language: runtime.response_language || runtime.primary_language || '',
    astra_stt_provider: runtime.stt && runtime.stt.provider || PLATFORM_STT.provider,
    astra_stt_model: runtime.stt && runtime.stt.model || PLATFORM_STT.model,
    astra_stt_language: runtime.stt && runtime.stt.language || PLATFORM_STT.language,
    astra_multilingual: runtime.multilingual ? '1' : '0',
  };
}

/**
 * Assess whether a locked speaker can cover the employee's allowed languages.
 * Does NOT remount or suggest a different speaker. Validation / observability only.
 * Deliberate configured fallback remains a product policy elsewhere
 * (voice_switch_policy=fallback_allowed), never a silent swap here.
 */
function assessMultilingualVoiceCompatibility(voiceLock, employee, opts = {}) {
  const lock = voiceLock && typeof voiceLock === 'object' ? voiceLock : null;
  const provider = String((lock && lock.provider) || '').toLowerCase();
  const speaker = String((lock && (lock.speaker || lock.voice_id)) || '').trim();
  const runtime = opts.runtime || buildSessionMultilingualRuntime(employee, {
    language: opts.initial_language,
    primary_language: opts.initial_language,
    languageVoiceConfig: opts.languageVoiceConfig,
    allowed_languages: opts.allowed_languages,
    persona_language_routes: opts.persona_language_routes,
  });
  if (opts.persona_language_routes
    && (!runtime.allowed_languages || runtime.allowed_languages.length <= 1)) {
    runtime.allowed_languages = resolveAllowedLanguages(employee, {
      primary_language: runtime.primary_language,
      languageVoiceConfig: opts.languageVoiceConfig
        || (employee && employee.voice && employee.voice.languageVoiceConfig),
      persona_language_routes: opts.persona_language_routes,
      allowed_languages: opts.allowed_languages,
    });
    runtime.multilingual = runtime.allowed_languages.length > 1
      || runtime.allowed_languages.some(isIndicLanguage);
  }

  const incompatible = [];
  for (const lang of runtime.allowed_languages || []) {
    if (!personaRouterLockedSupports(provider, speaker, lang)) {
      incompatible.push(lang);
    }
  }

  const multilingualNeedsSarvam = runtime.multilingual
    && (runtime.allowed_languages || []).some(isIndicLanguage);
  const englishOnlyLocked = provider === 'rumik' || provider === 'deepgram';

  return {
    prefer_sarvam: multilingualNeedsSarvam,
    speaker_compatible: incompatible.length === 0,
    incompatible_languages: incompatible,
    locked_provider: provider || null,
    locked_speaker: speaker || null,
    warning: (multilingualNeedsSarvam && englishOnlyLocked)
      ? 'Selected speaker is English-only while employee allows Indic languages. Mid-call Indic will fail under locked policy. Choose a multilingual Sarvam speaker in UI.'
      : (incompatible.length
        ? `Selected speaker does not support: ${incompatible.join(', ')}`
        : null),
    reason: incompatible.length === 0
      ? 'speaker_covers_allowed_languages'
      : 'speaker_incompatible_with_some_allowed',
  };
}

/** Local support check without circular require on voice-persona-router. */
function personaRouterLockedSupports(provider, speaker, language) {
  const pid = String(provider || '').toLowerCase();
  const lang = normalizeLanguageCode(language);
  if (!pid || !lang) return false;
  if (pid === 'sarvam') {
    // Bulbul speakers are multilingual via language_code.
    return true;
  }
  if (pid === 'rumik' || pid === 'deepgram') {
    return !isIndicLanguage(lang) && (lang === 'en-IN' || lang === 'en-US' || /^en([-_]|$)/i.test(lang));
  }
  return false;
}

/**
 * @deprecated Prefer assessMultilingualVoiceCompatibility. Kept for callers that
 * only need a boolean "employee is multilingual with Indic" signal. Never returns
 * a forced voice_id swap (no silent priya remount).
 */
function preferMultilingualVoiceLock(employee, initialLanguage, opts = {}) {
  const assessment = assessMultilingualVoiceCompatibility(
    opts.voice_lock || opts.proposed_lock || null,
    employee,
    {
      initial_language: initialLanguage,
      languageVoiceConfig: opts.languageVoiceConfig,
      allowed_languages: opts.allowed_languages,
      persona_language_routes: opts.persona_language_routes,
      runtime: opts.runtime,
    },
  );
  return {
    prefer_sarvam: !!assessment.prefer_sarvam,
    reason: assessment.reason,
    warning: assessment.warning,
    speaker_compatible: assessment.speaker_compatible,
    incompatible_languages: assessment.incompatible_languages,
    // Intentionally omit voice_id / provider remount fields.
  };
}

/**
 * Process one user turn: detect language, select response language, ASR guard,
 * recovery when needed. Shared by Browser Talk + chat APIs.
 */
function processUserTurn(text, opts = {}) {
  const runtime = opts.runtime || buildSessionMultilingualRuntime(opts.employee, opts);
  const raw = String(text || '').trim();
  const detection = detectLanguageFromTranscript(raw, {
    allowed_languages: runtime.allowed_languages,
    primary_language: runtime.primary_language,
    last_known: opts.current_language || runtime.current_language || runtime.primary_language,
  });
  const response = selectResponseLanguage(detection, {
    allowed_languages: runtime.allowed_languages,
    primary_language: runtime.primary_language,
    last_known: opts.current_language || runtime.current_language || runtime.primary_language,
  });

  const guard = asrSanityGuard.evaluateTranscript(raw, {
    confidence: opts.confidence,
    stt: runtime.stt,
    expectedLanguage: response.response_language,
    allowed_languages: runtime.allowed_languages,
  });

  const needsRecovery = !raw
    || guard.action === 'reject'
    || guard.action === 'clarify';

  const recoveryLang = response.response_language
    || opts.current_language
    || runtime.primary_language;

  return {
    raw_transcript: raw,
    final_transcript: guard.action === 'accept' ? raw : raw,
    detected_language: detection.language,
    detection,
    response_language: response.response_language,
    response,
    asr_guard: guard,
    llm_input_allowed: guard.action === 'accept' && !!raw,
    needs_recovery: needsRecovery,
    recovery_prompt: needsRecovery
      ? recoveryPrompt(recoveryLang, { action: guard.action })
      : null,
    stt: runtime.stt,
    primary_language: runtime.primary_language,
    allowed_languages: runtime.allowed_languages,
  };
}

module.exports = {
  PLATFORM_LANGUAGES,
  PLATFORM_LANGUAGE_IDS,
  INDIC_LANGUAGE_IDS,
  PLATFORM_STT,
  SCRIPT_RANGES,
  RECOVERY_BY_LANGUAGE,
  normalizeLanguageCode,
  isIndicLanguage,
  isPlatformLanguage,
  resolveAllowedLanguages,
  enforceMultilingualStt,
  detectLanguageFromTranscript,
  selectResponseLanguage,
  recoveryPrompt,
  buildSessionMultilingualRuntime,
  multilingualContextVariables,
  preferMultilingualVoiceLock,
  assessMultilingualVoiceCompatibility,
  processUserTurn,
};
