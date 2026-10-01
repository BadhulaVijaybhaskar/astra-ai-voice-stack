/**
 * Astra Voice. Multilingual persona routing + call-level voice lock.
 *
 * Product rule: AI Employee voice/persona and TTS provider are SEPARATE.
 * Customer identity is the persona (e.g. Vaani). Provider (Rumik / Sarvam /
 * Deepgram) is an internal engine chosen per language via language_routes.
 *
 * language_routes mean "starting voice when a NEW call begins in this
 * language". They do NOT change the speaker on every mid-call language switch.
 *
 * Call-level voice lock:
 *   Call start → resolve persona route for initial language → lock
 *   { provider, speaker, persona } for the entire call/session.
 *   Mid-call language may change; provider + speaker stay locked when the
 *   locked engine supports the target language_code.
 *
 * Example (Vaani, NEW call start only):
 *   Vaani + en-IN → Rumik speaker_2
 *   Vaani + hi-IN → Sarvam priya (bulbul:v3)
 *   Vaani + te-IN → Sarvam neha (bulbul:v3)
 *
 * Do NOT send Indic text to Rumik and claim multilingual support.
 * Do NOT expose provider credentials.
 * Do NOT mutate Maya production TTS / Dograh WF8.
 *
 * No em dashes anywhere. Commas and periods only.
 */
'use strict';

const voiceCatalog = require('./tts-voice-catalog');

/** Providers that only speak English in our curated Astra catalog. */
const ENGLISH_ONLY_PROVIDERS = Object.freeze(new Set(['rumik', 'deepgram']));

/** Modes where language list comes from persona language_routes. */
const AUTO_MODES = Object.freeze(new Set(['astra_auto', 'auto']));

/**
 * Session policy for mid-call language switches after voice_lock is set.
 *   locked           — never swap speaker/provider (Astra + Maya default)
 *   fallback_allowed — may resolve a new route only when explicitly enabled
 */
const VOICE_SWITCH_POLICIES = Object.freeze({
  LOCKED: 'locked',
  FALLBACK_ALLOWED: 'fallback_allowed',
});

const DEFAULT_VOICE_SWITCH_POLICY = VOICE_SWITCH_POLICIES.LOCKED;

/**
 * Native-language preview copy. Previewing must NOT change primaryLanguage.
 * Keep short (under Rumik/Sarvam preview caps).
 */
const PREVIEW_TEXT_BY_LANGUAGE = Object.freeze({
  'en-IN': 'Hello, this is {name} from Astra Voice. How can I help you today?',
  'hi-IN': 'नमस्ते, मैं Astra Voice से {name} हूँ। मैं आपकी कैसे मदद कर सकती हूँ?',
  'te-IN': 'నమస్కారం, నేను Astra Voice నుండి {name}. నేను మీకు ఎలా సహాయం చేయగలను?',
  'ta-IN': 'வணக்கம், நான் Astra Voice-இன் {name}. நான் உங்களுக்கு எப்படி உதவ முடியும்?',
  'kn-IN': 'ನಮಸ್ಕಾರ, ನಾನು Astra Voice ನಿಂದ {name}. ನಾನು ನಿಮಗೆ ಹೇಗೆ ಸಹಾಯ ಮಾಡಬಹುದು?',
  'ml-IN': 'നമസ്കാരം, ഞാൻ Astra Voice-ലെ {name} ആണ്. ഞാൻ നിങ്ങളെ എങ്ങനെ സഹായിക്കാം?',
  'mr-IN': 'नमस्कार, मी Astra Voice कडून {name} आहे. मी तुम्हाला कशी मदत करू शकते?',
  'bn-IN': 'নমস্কার, আমি Astra Voice থেকে {name}। আমি আপনাকে কীভাবে সাহায্য করতে পারি?',
  'gu-IN': 'નમસ્તે, હું Astra Voice તરફથી {name} છું. હું તમારી કેવી રીતે મદદ કરી શકું?',
  'pa-IN': 'ਸਤ ਸ੍ਰੀ ਅਕਾਲ, ਮੈਂ Astra Voice ਤੋਂ {name} ਹਾਂ। ਮੈਂ ਤੁਹਾਡੀ ਕਿਵੇਂ ਮਦਦ ਕਰ ਸਕਦੀ ਹਾਂ?',
});

function freezeRoute(route) {
  return Object.freeze({
    provider: String(route.provider || '').trim().toLowerCase(),
    voice_id: String(route.voice_id || '').trim(),
    model: String(route.model || '').trim(),
    language: String(route.language || '').trim() || undefined,
  });
}

function buildIndicSarvamRoutes(femaleByLang) {
  const routes = {};
  for (const [lang, voiceId] of Object.entries(femaleByLang)) {
    routes[lang] = freezeRoute({
      provider: 'sarvam',
      voice_id: voiceId,
      model: 'bulbul:v3',
      language: lang,
    });
  }
  return routes;
}

/**
 * Default Vaani persona map. Female Natural.
 * English → Rumik (current English engine). Indic → Sarvam Bulbul v3
 * using catalog language recommendations (female).
 */
const VAANI_INDIC_FEMALE = Object.freeze({
  'hi-IN': 'priya',
  'te-IN': 'neha',
  'ta-IN': 'ishita',
  'kn-IN': 'neha',
  'ml-IN': 'pooja',
  'mr-IN': 'priya',
  'bn-IN': 'roopa',
  'gu-IN': 'priya',
  'pa-IN': 'roopa',
});

const VAANI_PERSONA = Object.freeze({
  persona_id: 'vaani',
  display_name: 'Vaani',
  style: 'natural',
  gender: 'female',
  language_routes: Object.freeze({
    'en-IN': freezeRoute({
      provider: 'rumik', voice_id: 'speaker_2', model: 'mulberry', language: 'en-IN',
    }),
    ...buildIndicSarvamRoutes(VAANI_INDIC_FEMALE),
  }),
  /**
   * Compatible fallbacks only. Never English-only engines for Indic.
   * Secondary Sarvam female speakers from SARVAM_LANGUAGE_RECOMMENDATIONS.
   */
  language_fallbacks: Object.freeze({
    'en-IN': Object.freeze([
      freezeRoute({
        provider: 'deepgram', voice_id: 'aura-2-helena-en', model: 'aura-2', language: 'en-IN',
      }),
      freezeRoute({
        provider: 'rumik', voice_id: 'speaker_1', model: 'mulberry', language: 'en-IN',
      }),
    ]),
    'hi-IN': Object.freeze([
      freezeRoute({ provider: 'sarvam', voice_id: 'suhani', model: 'bulbul:v3', language: 'hi-IN' }),
    ]),
    'te-IN': Object.freeze([
      freezeRoute({ provider: 'sarvam', voice_id: 'priya', model: 'bulbul:v3', language: 'te-IN' }),
    ]),
    'ta-IN': Object.freeze([
      freezeRoute({ provider: 'sarvam', voice_id: 'ritu', model: 'bulbul:v3', language: 'ta-IN' }),
    ]),
    'kn-IN': Object.freeze([
      freezeRoute({ provider: 'sarvam', voice_id: 'ishita', model: 'bulbul:v3', language: 'kn-IN' }),
    ]),
    'ml-IN': Object.freeze([
      freezeRoute({ provider: 'sarvam', voice_id: 'pooja', model: 'bulbul:v3', language: 'ml-IN' }),
    ]),
    'mr-IN': Object.freeze([
      freezeRoute({ provider: 'sarvam', voice_id: 'ritu', model: 'bulbul:v3', language: 'mr-IN' }),
    ]),
    'bn-IN': Object.freeze([
      freezeRoute({ provider: 'sarvam', voice_id: 'suhani', model: 'bulbul:v3', language: 'bn-IN' }),
    ]),
    'gu-IN': Object.freeze([
      freezeRoute({ provider: 'sarvam', voice_id: 'ritu', model: 'bulbul:v3', language: 'gu-IN' }),
    ]),
    'pa-IN': Object.freeze([
      freezeRoute({ provider: 'sarvam', voice_id: 'suhani', model: 'bulbul:v3', language: 'pa-IN' }),
    ]),
  }),
});

/**
 * Maya persona map for Astra Auto language catalog only.
 * Does NOT override Maya production active TTS / Dograh WF8.
 * English stays Deepgram Helena to mirror current production-ish fixtures;
 * Indic still routes to Sarvam so Auto mode is multilingual without
 * inventing Rumik Indic support.
 */
const MAYA_INDIC_FEMALE = Object.freeze({
  'hi-IN': 'priya',
  'te-IN': 'neha',
  'ta-IN': 'ishita',
  'kn-IN': 'neha',
  'ml-IN': 'pooja',
  'mr-IN': 'priya',
  'bn-IN': 'roopa',
  'gu-IN': 'priya',
  'pa-IN': 'roopa',
});

const MAYA_PERSONA = Object.freeze({
  persona_id: 'maya',
  display_name: 'Maya',
  style: 'natural',
  gender: 'female',
  // Marker: production route must never be mutated by this module.
  production_protected: true,
  language_routes: Object.freeze({
    'en-IN': freezeRoute({
      provider: 'deepgram', voice_id: 'aura-2-helena-en', model: 'aura-2', language: 'en-IN',
    }),
    ...buildIndicSarvamRoutes(MAYA_INDIC_FEMALE),
  }),
  language_fallbacks: Object.freeze({
    'en-IN': Object.freeze([
      freezeRoute({
        provider: 'rumik', voice_id: 'speaker_2', model: 'mulberry', language: 'en-IN',
      }),
    ]),
    'hi-IN': Object.freeze([
      freezeRoute({ provider: 'sarvam', voice_id: 'suhani', model: 'bulbul:v3', language: 'hi-IN' }),
    ]),
    'te-IN': Object.freeze([
      freezeRoute({ provider: 'sarvam', voice_id: 'priya', model: 'bulbul:v3', language: 'te-IN' }),
    ]),
    'ta-IN': Object.freeze([
      freezeRoute({ provider: 'sarvam', voice_id: 'ritu', model: 'bulbul:v3', language: 'ta-IN' }),
    ]),
    'kn-IN': Object.freeze([
      freezeRoute({ provider: 'sarvam', voice_id: 'ishita', model: 'bulbul:v3', language: 'kn-IN' }),
    ]),
    'ml-IN': Object.freeze([
      freezeRoute({ provider: 'sarvam', voice_id: 'pooja', model: 'bulbul:v3', language: 'ml-IN' }),
    ]),
    'mr-IN': Object.freeze([
      freezeRoute({ provider: 'sarvam', voice_id: 'ritu', model: 'bulbul:v3', language: 'mr-IN' }),
    ]),
    'bn-IN': Object.freeze([
      freezeRoute({ provider: 'sarvam', voice_id: 'suhani', model: 'bulbul:v3', language: 'bn-IN' }),
    ]),
    'gu-IN': Object.freeze([
      freezeRoute({ provider: 'sarvam', voice_id: 'ritu', model: 'bulbul:v3', language: 'gu-IN' }),
    ]),
    'pa-IN': Object.freeze([
      freezeRoute({ provider: 'sarvam', voice_id: 'suhani', model: 'bulbul:v3', language: 'pa-IN' }),
    ]),
  }),
});

const PERSONA_BY_ID = Object.freeze({
  vaani: VAANI_PERSONA,
  maya: MAYA_PERSONA,
});

const PROVIDER_SUPPORTED_LANGUAGES = Object.freeze({
  rumik: Object.freeze(['en-IN']),
  deepgram: Object.freeze(['en-IN']),
  sarvam: Object.freeze(
    voiceCatalog.SARVAM_LANGUAGES
      .map((l) => l.id)
      .filter((id) => voiceCatalog.isAstraSupportedLanguage(id)),
  ),
});

function normalizeLanguageCode(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  if (voiceCatalog.isAstraSupportedLanguage(s)) return s;
  const lower = s.toLowerCase().replace('_', '-');
  const aliases = {
    en: 'en-IN', english: 'en-IN', 'en-in': 'en-IN', 'en-us': 'en-IN',
    hi: 'hi-IN', hindi: 'hi-IN', 'hi-in': 'hi-IN',
    te: 'te-IN', telugu: 'te-IN', 'te-in': 'te-IN',
    ta: 'ta-IN', tamil: 'ta-IN', 'ta-in': 'ta-IN',
    kn: 'kn-IN', kannada: 'kn-IN', 'kn-in': 'kn-IN',
    ml: 'ml-IN', malayalam: 'ml-IN', 'ml-in': 'ml-IN',
    mr: 'mr-IN', marathi: 'mr-IN', 'mr-in': 'mr-IN',
    bn: 'bn-IN', bengali: 'bn-IN', 'bn-in': 'bn-IN',
    gu: 'gu-IN', gujarati: 'gu-IN', 'gu-in': 'gu-IN',
    pa: 'pa-IN', punjabi: 'pa-IN', 'pa-in': 'pa-IN',
  };
  return aliases[lower] || '';
}

function isEnglishLanguage(language) {
  const code = normalizeLanguageCode(language) || String(language || '');
  return /^en([-_]|$)/i.test(code);
}

function isEnglishOnlyProvider(providerId) {
  return ENGLISH_ONLY_PROVIDERS.has(String(providerId || '').trim().toLowerCase());
}

function providerSupportsLanguage(providerId, language) {
  const pid = String(providerId || '').trim().toLowerCase();
  const lang = normalizeLanguageCode(language);
  if (!pid || !lang) return false;
  const list = PROVIDER_SUPPORTED_LANGUAGES[pid];
  if (!list) return false;
  return list.includes(lang);
}

function getPersona(personaOrId) {
  if (!personaOrId) return null;
  if (typeof personaOrId === 'string') {
    return PERSONA_BY_ID[String(personaOrId).trim().toLowerCase()] || null;
  }
  if (typeof personaOrId === 'object') {
    if (personaOrId.persona_id && PERSONA_BY_ID[personaOrId.persona_id]) {
      // Prefer seeded canonical map when id matches, merge custom routes if present.
      const base = PERSONA_BY_ID[personaOrId.persona_id];
      if (personaOrId.language_routes && typeof personaOrId.language_routes === 'object') {
        return {
          ...base,
          ...personaOrId,
          language_routes: { ...base.language_routes, ...personaOrId.language_routes },
          language_fallbacks: {
            ...(base.language_fallbacks || {}),
            ...(personaOrId.language_fallbacks || {}),
          },
        };
      }
      return { ...base, ...personaOrId, language_routes: base.language_routes };
    }
    if (personaOrId.language_routes) return personaOrId;
  }
  return null;
}

/**
 * Resolve persona id from an employee row or explicit id/name.
 * Never invents Maya for unknown employees.
 */
function resolvePersonaId(employeeOrHint) {
  if (!employeeOrHint) return null;
  if (typeof employeeOrHint === 'string') {
    const s = employeeOrHint.trim().toLowerCase();
    if (PERSONA_BY_ID[s]) return s;
    return null;
  }
  const emp = employeeOrHint;
  const explicit = String(
    (emp.voice && (emp.voice.persona_id || emp.voice.personaId))
      || emp.persona_id
      || emp.personaId
      || '',
  ).trim().toLowerCase();
  if (PERSONA_BY_ID[explicit]) return explicit;

  const name = String(emp.name || '').trim().toLowerCase();
  if (PERSONA_BY_ID[name]) return name;

  // Known protected Maya employee id.
  if (String(emp.id || '') === 'emp_33eae8ef454680f0') return 'maya';
  // Known Vaani fixture id used in isolation tests.
  if (String(emp.id || '') === 'emp_f85510806c9de004') return 'vaani';

  return null;
}

function normalizeMode(mode, provider) {
  const m = String(mode || '').trim().toLowerCase();
  if (AUTO_MODES.has(m) || m === '') {
    const p = String(provider || '').trim().toLowerCase();
    if (p && p !== 'auto') return p;
    return 'astra_auto';
  }
  return m;
}

function publicRoute(route, extra = {}) {
  if (!route) return null;
  return {
    provider: route.provider,
    voice_id: route.voice_id,
    model: route.model || '',
    language: route.language || extra.language || '',
    ...extra,
  };
}

/**
 * Core resolver.
 *
 * @param {object|string} persona Persona object or persona_id
 * @param {string} language Language code (en-IN, hi-IN, ...)
 * @param {string} mode 'astra_auto' | 'rumik' | 'sarvam' | 'deepgram' | provider id
 * @param {object} [opts]
 * @returns {{ ok: true, route, persona, language, mode, source } | { ok: false, error, code, ... }}
 */
function resolvePersonaRoute(persona, language, mode, opts = {}) {
  const resolvedPersona = getPersona(persona);
  const lang = normalizeLanguageCode(language);
  const effectiveMode = normalizeMode(mode, opts.provider);

  if (!resolvedPersona) {
    return {
      ok: false,
      error: 'Unknown voice persona',
      code: 'unknown_persona',
      language: lang || String(language || ''),
      mode: effectiveMode,
    };
  }

  if (!lang || !voiceCatalog.isAstraSupportedLanguage(lang)) {
    return {
      ok: false,
      error: 'Unsupported language',
      code: 'unsupported_language',
      persona_id: resolvedPersona.persona_id,
      language: String(language || ''),
      mode: effectiveMode,
      supported: voiceCatalog.listAstraSupportedLanguages().map((l) => l.id),
    };
  }

  // Explicit provider mode: only languages that provider genuinely supports.
  if (!AUTO_MODES.has(effectiveMode)) {
    if (!providerSupportsLanguage(effectiveMode, lang)) {
      return {
        ok: false,
        error: 'Language not supported by selected provider',
        code: 'provider_language_unsupported',
        persona_id: resolvedPersona.persona_id,
        language: lang,
        mode: effectiveMode,
        provider: effectiveMode,
        supported: (PROVIDER_SUPPORTED_LANGUAGES[effectiveMode] || []).slice(),
      };
    }
    // Prefer persona route when it matches this provider; else catalog default speaker.
    const preferred = resolvedPersona.language_routes
      && resolvedPersona.language_routes[lang];
    if (preferred && preferred.provider === effectiveMode) {
      return {
        ok: true,
        route: publicRoute(preferred, { language: lang }),
        persona: publicPersona(resolvedPersona),
        language: lang,
        mode: effectiveMode,
        source: 'persona_route',
      };
    }
    const fallbacks = (resolvedPersona.language_fallbacks
      && resolvedPersona.language_fallbacks[lang]) || [];
    const match = fallbacks.find((r) => r.provider === effectiveMode);
    if (match) {
      return {
        ok: true,
        route: publicRoute(match, { language: lang }),
        persona: publicPersona(resolvedPersona),
        language: lang,
        mode: effectiveMode,
        source: 'persona_fallback',
      };
    }
    // Provider-native default (still never claims Rumik Indic).
    const defaultVoice = defaultVoiceForProvider(effectiveMode, lang, resolvedPersona.gender);
    if (!defaultVoice) {
      return {
        ok: false,
        error: 'No compatible voice for provider and language',
        code: 'voice_unavailable',
        persona_id: resolvedPersona.persona_id,
        language: lang,
        mode: effectiveMode,
      };
    }
    return {
      ok: true,
      route: publicRoute(defaultVoice, { language: lang }),
      persona: publicPersona(resolvedPersona),
      language: lang,
      mode: effectiveMode,
      source: 'provider_default',
    };
  }

  // Astra Auto: persona language_routes are the source of truth.
  const route = resolvedPersona.language_routes
    && resolvedPersona.language_routes[lang];
  if (!route) {
    return {
      ok: false,
      error: 'No persona route for language',
      code: 'persona_route_missing',
      persona_id: resolvedPersona.persona_id,
      language: lang,
      mode: 'astra_auto',
    };
  }

  // Safety: refuse English-only engines for non-English Auto routes.
  if (!isEnglishLanguage(lang) && isEnglishOnlyProvider(route.provider)) {
    return {
      ok: false,
      error: 'Invalid persona route: English-only engine for Indic language',
      code: 'invalid_persona_route',
      persona_id: resolvedPersona.persona_id,
      language: lang,
      mode: 'astra_auto',
      provider: route.provider,
    };
  }

  return {
    ok: true,
    route: publicRoute(route, { language: lang }),
    persona: publicPersona(resolvedPersona),
    language: lang,
    mode: 'astra_auto',
    source: 'persona_route',
  };
}

function defaultVoiceForProvider(providerId, language, gender) {
  const pid = String(providerId || '').trim().toLowerCase();
  const lang = normalizeLanguageCode(language);
  const g = String(gender || 'female').toLowerCase() === 'male' ? 'male' : 'female';
  if (pid === 'rumik') {
    return freezeRoute({
      provider: 'rumik', voice_id: 'speaker_2', model: 'mulberry', language: 'en-IN',
    });
  }
  if (pid === 'deepgram') {
    return freezeRoute({
      provider: 'deepgram',
      voice_id: g === 'male' ? 'aura-2-apollo-en' : 'aura-2-helena-en',
      model: 'aura-2',
      language: 'en-IN',
    });
  }
  if (pid === 'sarvam') {
    const rec = voiceCatalog.SARVAM_LANGUAGE_RECOMMENDATIONS[lang];
    const voiceId = (rec && rec[g] && rec[g][0]) || (g === 'male' ? 'shubh' : 'priya');
    return freezeRoute({
      provider: 'sarvam', voice_id: voiceId, model: 'bulbul:v3', language: lang,
    });
  }
  return null;
}

/**
 * Pick a fallback route after preferred synthesis fails.
 * Never returns an English-only provider for non-English languages.
 */
function resolveFallbackRoute(persona, language, failedProvider, opts = {}) {
  const resolvedPersona = getPersona(persona);
  const lang = normalizeLanguageCode(language);
  if (!resolvedPersona || !lang) {
    return { ok: false, error: 'Cannot resolve fallback', code: 'fallback_unavailable' };
  }

  const failed = String(failedProvider || '').trim().toLowerCase();
  const candidates = [];
  const primary = resolvedPersona.language_routes
    && resolvedPersona.language_routes[lang];
  if (primary) candidates.push(primary);
  const extras = (resolvedPersona.language_fallbacks
    && resolvedPersona.language_fallbacks[lang]) || [];
  for (const r of extras) candidates.push(r);

  for (const route of candidates) {
    if (!route || !route.provider || !route.voice_id) continue;
    if (failed && route.provider === failed
      && route.voice_id === String(opts.failedVoiceId || '').trim()) {
      continue;
    }
    if (failed && route.provider === failed && !opts.failedVoiceId) continue;
    if (!isEnglishLanguage(lang) && isEnglishOnlyProvider(route.provider)) {
      // Hard rule: never fall back to Rumik/Deepgram for Telugu/Hindi/etc.
      continue;
    }
    if (!providerSupportsLanguage(route.provider, lang)
      && !(route.provider === 'sarvam' && voiceCatalog.isAstraSupportedLanguage(lang))) {
      continue;
    }
    return {
      ok: true,
      route: publicRoute(route, { language: lang }),
      persona: publicPersona(resolvedPersona),
      language: lang,
      source: 'fallback',
      skipped_english_only: true,
    };
  }

  return {
    ok: false,
    error: 'No compatible fallback for language',
    code: 'fallback_unavailable',
    language: lang,
    failed_provider: failed || null,
  };
}

function publicPersona(persona) {
  if (!persona) return null;
  const routes = {};
  for (const [lang, route] of Object.entries(persona.language_routes || {})) {
    routes[lang] = publicRoute(route, { language: lang });
  }
  return {
    persona_id: persona.persona_id,
    display_name: persona.display_name,
    style: persona.style || 'natural',
    gender: persona.gender || '',
    production_protected: !!persona.production_protected,
    language_routes: routes,
    // Never include credentials.
  };
}

/**
 * Languages available for the current mode/provider selection.
 * Astra Auto → persona language_routes keys (Astra curated).
 * Explicit Rumik → only Rumik-supported languages.
 */
function languagesForMode(persona, mode, provider) {
  const resolvedPersona = getPersona(persona);
  const effectiveMode = normalizeMode(mode, provider);
  const curated = voiceCatalog.listAstraSupportedLanguages();

  if (AUTO_MODES.has(effectiveMode)) {
    if (!resolvedPersona) {
      return curated.map((l) => ({ ...l, supported: true, source: 'astra' }));
    }
    const routeLangs = new Set(Object.keys(resolvedPersona.language_routes || {}));
    return curated
      .filter((l) => routeLangs.has(l.id))
      .map((l) => ({
        ...l,
        supported: true,
        source: 'persona_route',
        route: publicRoute(resolvedPersona.language_routes[l.id], { language: l.id }),
      }));
  }

  const supportedIds = new Set(PROVIDER_SUPPORTED_LANGUAGES[effectiveMode] || []);
  return curated
    .filter((l) => supportedIds.has(l.id))
    .map((l) => ({
      ...l,
      supported: true,
      source: 'provider',
      provider: effectiveMode,
    }));
}

function getPreviewText(language, displayName) {
  const lang = normalizeLanguageCode(language) || 'en-IN';
  const name = String(displayName || 'Astra').trim() || 'Astra';
  const template = PREVIEW_TEXT_BY_LANGUAGE[lang]
    || PREVIEW_TEXT_BY_LANGUAGE['en-IN'];
  return template.replace(/\{name\}/g, name);
}

function listPersonas() {
  return Object.values(PERSONA_BY_ID).map((p) => publicPersona(p));
}

function personaDisplayLabel(personaOrId) {
  const p = getPersona(personaOrId);
  if (!p) return null;
  const style = p.style ? String(p.style) : 'Natural';
  const styleLabel = style.charAt(0).toUpperCase() + style.slice(1);
  return p.display_name + ' · ' + styleLabel;
}

/**
 * Pure helper for UI/tests: preview language must not mutate employee primary.
 * Returns a shallow clone with primaryLanguage unchanged.
 */
function applyPreviewLanguage(employee, previewLanguage) {
  const emp = employee && typeof employee === 'object' ? employee : {};
  const primary = (emp.voice && emp.voice.language)
    || emp.language
    || emp.primaryLanguage
    || null;
  const preview = normalizeLanguageCode(previewLanguage) || previewLanguage;
  return {
    employee: emp,
    primaryLanguage: primary,
    previewLanguage: preview,
    mutated: false,
  };
}

function debugRouteSummary(persona) {
  const p = getPersona(persona);
  if (!p) return [];
  const curated = voiceCatalog.listAstraSupportedLanguages();
  const byId = new Map(curated.map((l) => [l.id, l]));
  return Object.entries(p.language_routes || {}).map(([lang, route]) => {
    const meta = byId.get(lang);
    return {
      language: lang,
      label: meta ? meta.label : lang,
      provider: route.provider,
      voice_id: route.voice_id,
      model: route.model || '',
      // Starting-voice map only (new call). Not a mid-call speaker switch table.
      summary: (meta ? meta.label : lang) + ' → ' + route.provider + ' / ' + route.voice_id
        + ' (call start)',
    };
  });
}

function normalizeVoiceSwitchPolicy(raw, opts = {}) {
  const s = String(raw || '').trim().toLowerCase();
  if (s === VOICE_SWITCH_POLICIES.FALLBACK_ALLOWED) {
    return VOICE_SWITCH_POLICIES.FALLBACK_ALLOWED;
  }
  if (s === VOICE_SWITCH_POLICIES.LOCKED) {
    return VOICE_SWITCH_POLICIES.LOCKED;
  }
  // Maya investor demo + Astra default: always locked unless explicitly enabled.
  if (opts.personaId === 'maya' || opts.forceLocked) {
    return VOICE_SWITCH_POLICIES.LOCKED;
  }
  return DEFAULT_VOICE_SWITCH_POLICY;
}

/**
 * Whether a locked provider+speaker can synthesize the target language.
 * Sarvam Bulbul speakers are multilingual via language_code. Rumik/Deepgram
 * are English-only in the curated Astra catalog.
 */
function lockedSpeakerSupportsLanguage(provider, speaker, language) {
  const pid = String(provider || '').trim().toLowerCase();
  const voiceId = String(speaker || '').trim();
  const lang = normalizeLanguageCode(language);
  if (!pid || !lang) return false;
  if (!providerSupportsLanguage(pid, lang)) return false;

  if (pid === 'sarvam') {
    if (!voiceId) return true;
    const known = voiceCatalog.findVoice('sarvam', voiceId);
    // Unknown ids still accepted when provider supports the language; catalog
    // rows are multilingual (language "").
    return !!known || /^[a-z0-9_-]+$/i.test(voiceId);
  }
  if (pid === 'rumik' || pid === 'deepgram') {
    return isEnglishLanguage(lang);
  }
  return providerSupportsLanguage(pid, lang);
}

function publicVoiceLock(lock) {
  if (!lock) return null;
  return {
    provider: lock.provider,
    speaker: lock.speaker,
    voice_id: lock.speaker,
    model: lock.model || '',
    persona: lock.persona || null,
    persona_id: lock.persona || null,
  };
}

/**
 * Call-start routing: resolve persona starting route for initial language and
 * create a session voice_lock. Persona language_routes apply ONLY here.
 *
 * @returns {{ ok: true, employee_id, initial_language, voice_lock, voice_switch_policy, route, source }
 *   | { ok: false, code, error, ... }}
 */
function createSessionVoiceLock(input = {}) {
  const employee = input.employee || null;
  const employeeId = String(
    (employee && employee.id) || input.employee_id || input.employeeId || '',
  ).trim() || null;
  const personaHint = input.persona || input.persona_id || input.personaId
    || resolvePersonaId(employee)
    || null;
  const persona = getPersona(personaHint);
  const personaId = persona ? persona.persona_id : (personaHint || null);
  const mode = normalizeMode(input.mode, input.provider);
  const policy = normalizeVoiceSwitchPolicy(
    input.voice_switch_policy || input.voiceSwitchPolicy || input.policy,
    { personaId, forceLocked: input.forceLocked },
  );

  // Initial language: explicit call language → contact preferred_language →
  // employee primary → en-IN. preferred_language is start-only, never a lock.
  const initialLanguage = normalizeLanguageCode(
    input.language
      || input.initial_language
      || input.preferred_language
      || input.preferredLanguage
      || (employee && employee.voice && employee.voice.language)
      || (employee && employee.language)
      || '',
  ) || 'en-IN';

  // Per-employee languageVoiceConfig overrides persona starting route when set.
  const langVoiceCfg = (employee && employee.voice && employee.voice.languageVoiceConfig)
    || input.languageVoiceConfig
    || input.language_voice_config
    || null;
  const cfgRow = langVoiceCfg && typeof langVoiceCfg === 'object'
    ? (langVoiceCfg[initialLanguage] || null)
    : null;

  let resolved;
  if (cfgRow && (cfgRow.voice_id || cfgRow.speaker)) {
    const voiceId = String(cfgRow.voice_id || cfgRow.speaker).trim();
    let provider = String(cfgRow.provider || '').trim().toLowerCase();
    let model = String(cfgRow.model || '').trim();
    if (!provider) {
      const known = voiceCatalog.findVoice('sarvam', voiceId)
        || voiceCatalog.findVoice('rumik', voiceId)
        || voiceCatalog.findVoice('deepgram', voiceId);
      if (known) {
        provider = known.provider;
        model = model || known.model || '';
      } else if (persona) {
        const personaRoute = persona.language_routes && persona.language_routes[initialLanguage];
        if (personaRoute) {
          provider = personaRoute.provider;
          model = model || personaRoute.model || '';
        }
      }
    }
    if (!provider && persona) {
      const pr = resolvePersonaRoute(persona, initialLanguage, mode, { provider: input.provider });
      if (pr.ok) {
        provider = pr.route.provider;
        model = model || pr.route.model || '';
      }
    }
    if (!provider) {
      provider = isEnglishLanguage(initialLanguage) ? 'rumik' : 'sarvam';
    }
    resolved = {
      ok: true,
      route: {
        provider,
        voice_id: voiceId,
        model: model || (provider === 'sarvam' ? 'bulbul:v3' : (provider === 'deepgram' ? 'aura-2' : 'mulberry')),
        language: initialLanguage,
        speed: cfgRow.speed != null ? Number(cfgRow.speed) : undefined,
      },
      persona: persona ? publicPersona(persona) : null,
      language: initialLanguage,
      mode,
      source: 'language_voice_config',
    };
  } else if (persona) {
    resolved = resolvePersonaRoute(persona, initialLanguage, mode, {
      provider: input.provider,
    });
  } else if (input.pipelineTts && input.pipelineTts.provider && input.pipelineTts.voice_id) {
    // No persona map: lock the employee pipeline TTS snapshot as-is.
    const pipeLang = normalizeLanguageCode(input.pipelineTts.language) || initialLanguage;
    resolved = {
      ok: true,
      route: {
        provider: String(input.pipelineTts.provider).toLowerCase(),
        voice_id: String(input.pipelineTts.voice_id),
        model: String(input.pipelineTts.model || ''),
        language: pipeLang,
      },
      persona: null,
      language: pipeLang,
      mode,
      source: 'pipeline_tts',
    };
  } else {
    return {
      ok: false,
      error: 'Cannot establish call voice lock without persona or pipeline TTS',
      code: 'voice_lock_unavailable',
      employee_id: employeeId,
      language: initialLanguage,
    };
  }

  if (!resolved.ok) {
    return {
      ...resolved,
      employee_id: employeeId,
      initial_language: initialLanguage,
      voice_switch_policy: policy,
    };
  }

  const voice_lock = Object.freeze({
    provider: resolved.route.provider,
    speaker: resolved.route.voice_id,
    model: resolved.route.model || '',
    persona: personaId,
  });

  return {
    ok: true,
    employee_id: employeeId,
    initial_language: initialLanguage,
    current_language: initialLanguage,
    voice_lock,
    voice_switch_policy: policy,
    route: {
      ...resolved.route,
      language: initialLanguage,
    },
    persona: resolved.persona || (persona ? publicPersona(persona) : null),
    mode: resolved.mode || mode,
    source: resolved.source || 'persona_route',
    // Persona routes are starting voices only.
    route_semantics: 'call_start_only',
  };
}

/**
 * Mid-call language switch under an existing voice_lock.
 * Keeps provider + speaker. Updates language_code when supported.
 * Never silently swaps speakers when policy is locked.
 */
function resolveLockedVoice(voiceLock, language, opts = {}) {
  const lock = voiceLock && typeof voiceLock === 'object' ? voiceLock : null;
  if (!lock || !lock.provider || !(lock.speaker || lock.voice_id)) {
    return {
      ok: false,
      error: 'Session voice lock missing',
      code: 'voice_lock_missing',
    };
  }
  const provider = String(lock.provider).trim().toLowerCase();
  const speaker = String(lock.speaker || lock.voice_id).trim();
  const model = String(lock.model || '').trim();
  const persona = lock.persona || lock.persona_id || null;
  const lang = normalizeLanguageCode(language);
  const policy = normalizeVoiceSwitchPolicy(
    opts.voice_switch_policy || opts.voiceSwitchPolicy || opts.policy || DEFAULT_VOICE_SWITCH_POLICY,
    { personaId: persona },
  );

  if (!lang || !voiceCatalog.isAstraSupportedLanguage(lang)) {
    return {
      ok: false,
      error: 'Unsupported language',
      code: 'unsupported_language',
      voice_lock: publicVoiceLock({ provider, speaker, model, persona }),
      language: String(language || ''),
      voice_switch_policy: policy,
    };
  }

  if (lockedSpeakerSupportsLanguage(provider, speaker, lang)) {
    return {
      ok: true,
      locked: true,
      speaker_unchanged: true,
      provider_unchanged: true,
      route: {
        provider,
        voice_id: speaker,
        speaker,
        model,
        language: lang,
      },
      voice_lock: publicVoiceLock({ provider, speaker, model, persona }),
      language: lang,
      voice_switch_policy: policy,
      source: 'voice_lock',
    };
  }

  // Locked speaker cannot speak this language.
  if (policy === VOICE_SWITCH_POLICIES.FALLBACK_ALLOWED && (persona || opts.persona)) {
    const fb = resolvePersonaRoute(persona || opts.persona, lang, opts.mode || 'astra_auto');
    if (fb.ok) {
      return {
        ok: true,
        locked: false,
        speaker_unchanged: false,
        provider_unchanged: fb.route.provider === provider,
        route: fb.route,
        voice_lock: publicVoiceLock({
          provider: fb.route.provider,
          speaker: fb.route.voice_id,
          model: fb.route.model || '',
          persona,
        }),
        language: lang,
        voice_switch_policy: policy,
        source: 'fallback_allowed_reresolve',
        previous_voice_lock: publicVoiceLock({ provider, speaker, model, persona }),
      };
    }
  }

  return {
    ok: false,
    error: 'Locked voice does not support this language',
    code: 'locked_voice_language_unsupported',
    voice_lock: publicVoiceLock({ provider, speaker, model, persona }),
    language: lang,
    voice_switch_policy: policy,
    supported_languages: (PROVIDER_SUPPORTED_LANGUAGES[provider] || []).slice(),
  };
}

/**
 * Unified Browser Talk / inbound PSTN / outbound PSTN routing entry.
 *
 * - No lock yet → call-start createSessionVoiceLock
 * - Lock present → resolveLockedVoice (speaker stays)
 * - preferred_language is used only when establishing a NEW lock
 */
function resolveCallVoice(input = {}) {
  const existingLock = input.voice_lock || input.voiceLock || null;
  const language = input.language || input.target_language || input.targetLanguage || '';
  const policy = input.voice_switch_policy || input.voiceSwitchPolicy || input.policy;

  if (existingLock && (existingLock.provider && (existingLock.speaker || existingLock.voice_id))) {
    return resolveLockedVoice(existingLock, language || input.current_language, {
      voice_switch_policy: policy,
      persona: input.persona || input.persona_id || existingLock.persona,
      mode: input.mode,
    });
  }

  return createSessionVoiceLock({
    employee: input.employee,
    employee_id: input.employee_id || input.employeeId,
    persona: input.persona || input.persona_id || input.personaId,
    language: language
      || input.initial_language
      || input.preferred_language
      || input.preferredLanguage,
    preferred_language: input.preferred_language || input.preferredLanguage,
    mode: input.mode,
    provider: input.provider,
    pipelineTts: input.pipelineTts || input.pipeline_tts,
    voice_switch_policy: policy,
    forceLocked: input.forceLocked,
  });
}

module.exports = {
  ENGLISH_ONLY_PROVIDERS,
  AUTO_MODES,
  VOICE_SWITCH_POLICIES,
  DEFAULT_VOICE_SWITCH_POLICY,
  PREVIEW_TEXT_BY_LANGUAGE,
  VAANI_PERSONA,
  MAYA_PERSONA,
  PERSONA_BY_ID,
  PROVIDER_SUPPORTED_LANGUAGES,
  normalizeLanguageCode,
  isEnglishLanguage,
  isEnglishOnlyProvider,
  providerSupportsLanguage,
  lockedSpeakerSupportsLanguage,
  normalizeVoiceSwitchPolicy,
  getPersona,
  resolvePersonaId,
  resolvePersonaRoute,
  resolveFallbackRoute,
  createSessionVoiceLock,
  resolveLockedVoice,
  resolveCallVoice,
  publicVoiceLock,
  languagesForMode,
  getPreviewText,
  listPersonas,
  publicPersona,
  personaDisplayLabel,
  applyPreviewLanguage,
  debugRouteSummary,
  defaultVoiceForProvider,
};
