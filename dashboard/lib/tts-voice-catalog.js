/**
 * Astra Voice. TTS voice catalog (Sarvam, Deepgram Aura, Rumik).
 *
 * Single backend config for officially documented voice / model identifiers.
 * Sarvam has no public voice-list API for our account shape, so this file is
 * the source of truth. Update here without frontend changes.
 *
 * Normalized voice shape (exact field names):
 *   { provider, voice_id, display_name, language, model, gender, status }
 *
 * Never includes API keys. Catalog alone does not change live TTS defaults.
 * No em dashes anywhere. Commas and periods only.
 */
'use strict';

const PROVIDERS = Object.freeze([
  Object.freeze({ id: 'sarvam', label: 'Sarvam', layer: 'tts' }),
  Object.freeze({ id: 'deepgram', label: 'Deepgram Aura', layer: 'tts' }),
  Object.freeze({ id: 'rumik', label: 'Rumik', layer: 'tts' }),
]);

/** Official Bulbul languages (docs.sarvam.ai). */
const SARVAM_LANGUAGES = Object.freeze([
  Object.freeze({ id: 'en-IN', label: 'English (India)' }),
  Object.freeze({ id: 'hi-IN', label: 'Hindi' }),
  Object.freeze({ id: 'bn-IN', label: 'Bengali' }),
  Object.freeze({ id: 'ta-IN', label: 'Tamil' }),
  Object.freeze({ id: 'te-IN', label: 'Telugu' }),
  Object.freeze({ id: 'kn-IN', label: 'Kannada' }),
  Object.freeze({ id: 'ml-IN', label: 'Malayalam' }),
  Object.freeze({ id: 'mr-IN', label: 'Marathi' }),
  Object.freeze({ id: 'gu-IN', label: 'Gujarati' }),
  Object.freeze({ id: 'pa-IN', label: 'Punjabi' }),
  Object.freeze({ id: 'od-IN', label: 'Odia' }),
]);

/**
 * Bulbul v3 speakers from Sarvam docs (speaker names are lowercase).
 * Gender from official Male / Female lists on change-the-speaker-voice.
 */
const SARVAM_V3_SPEAKERS = Object.freeze([
  { voice_id: 'shubh', gender: 'male', status: 'available' },
  { voice_id: 'aditya', gender: 'male', status: 'available' },
  { voice_id: 'rahul', gender: 'male', status: 'available' },
  { voice_id: 'rohan', gender: 'male', status: 'available' },
  { voice_id: 'amit', gender: 'male', status: 'available' },
  { voice_id: 'dev', gender: 'male', status: 'available' },
  { voice_id: 'ratan', gender: 'male', status: 'available' },
  { voice_id: 'varun', gender: 'male', status: 'available' },
  { voice_id: 'manan', gender: 'male', status: 'available' },
  { voice_id: 'sumit', gender: 'male', status: 'available' },
  { voice_id: 'kabir', gender: 'male', status: 'available' },
  { voice_id: 'aayan', gender: 'male', status: 'available' },
  { voice_id: 'ashutosh', gender: 'male', status: 'available' },
  { voice_id: 'advait', gender: 'male', status: 'available' },
  { voice_id: 'anand', gender: 'male', status: 'available' },
  { voice_id: 'tarun', gender: 'male', status: 'available' },
  { voice_id: 'sunny', gender: 'male', status: 'available' },
  { voice_id: 'mani', gender: 'male', status: 'available' },
  { voice_id: 'gokul', gender: 'male', status: 'available' },
  { voice_id: 'vijay', gender: 'male', status: 'available' },
  { voice_id: 'mohit', gender: 'male', status: 'available' },
  { voice_id: 'rehan', gender: 'male', status: 'available' },
  { voice_id: 'soham', gender: 'male', status: 'available' },
  { voice_id: 'ritu', gender: 'female', status: 'available' },
  { voice_id: 'priya', gender: 'female', status: 'available' },
  { voice_id: 'neha', gender: 'female', status: 'available' },
  { voice_id: 'pooja', gender: 'female', status: 'available' },
  { voice_id: 'simran', gender: 'female', status: 'available' },
  { voice_id: 'kavya', gender: 'female', status: 'available' },
  { voice_id: 'ishita', gender: 'female', status: 'available' },
  { voice_id: 'shreya', gender: 'female', status: 'available' },
  { voice_id: 'roopa', gender: 'female', status: 'available' },
  { voice_id: 'tanya', gender: 'female', status: 'available' },
  { voice_id: 'shruti', gender: 'female', status: 'available' },
  { voice_id: 'suhani', gender: 'female', status: 'available' },
  { voice_id: 'kavitha', gender: 'female', status: 'available' },
  { voice_id: 'rupali', gender: 'female', status: 'available' },
]);

/** Legacy Bulbul v2 speakers (docs default anushka). */
const SARVAM_V2_SPEAKERS = Object.freeze([
  { voice_id: 'anushka', gender: 'female', status: 'legacy' },
  { voice_id: 'abhilash', gender: 'male', status: 'legacy' },
  { voice_id: 'manisha', gender: 'female', status: 'legacy' },
  { voice_id: 'vidya', gender: 'female', status: 'legacy' },
  { voice_id: 'arya', gender: 'female', status: 'legacy' },
  { voice_id: 'karun', gender: 'male', status: 'legacy' },
  { voice_id: 'hitesh', gender: 'male', status: 'legacy' },
]);

/**
 * Per-language recommended speakers (Sarvam best-practices docs).
 * Used for language mappings in the catalog response.
 */
const SARVAM_LANGUAGE_RECOMMENDATIONS = Object.freeze({
  'en-IN': Object.freeze({ male: ['ratan'], female: ['ishita'] }),
  'hi-IN': Object.freeze({ male: ['shubh', 'ashutosh'], female: ['priya', 'suhani'] }),
  'te-IN': Object.freeze({ male: ['shubh', 'ratan'], female: ['neha', 'priya'] }),
  'kn-IN': Object.freeze({ male: ['shubh', 'ratan'], female: ['neha', 'ishita'] }),
  'bn-IN': Object.freeze({ male: ['rehan'], female: ['roopa', 'suhani'] }),
  'ta-IN': Object.freeze({ male: ['ratan', 'rohan'], female: ['ishita', 'ritu'] }),
  'od-IN': Object.freeze({ male: ['shubh'], female: ['ritu', 'pooja'] }),
  'ml-IN': Object.freeze({ male: ['shubh'], female: ['pooja'] }),
  'mr-IN': Object.freeze({ male: ['ratan'], female: ['priya', 'ritu'] }),
  'pa-IN': Object.freeze({ male: ['mani'], female: ['roopa', 'suhani'] }),
  'gu-IN': Object.freeze({ male: ['ratan'], female: ['priya', 'ritu'] }),
});

/** Featured Deepgram Aura-2 English voices (developers.deepgram.com). */
const DEEPGRAM_AURA_VOICES = Object.freeze([
  { voice_id: 'aura-2-helena-en', display_name: 'Helena', gender: 'female', language: 'en', model: 'aura-2', status: 'available' },
  { voice_id: 'aura-2-thalia-en', display_name: 'Thalia', gender: 'female', language: 'en', model: 'aura-2', status: 'available' },
  { voice_id: 'aura-2-andromeda-en', display_name: 'Andromeda', gender: 'female', language: 'en', model: 'aura-2', status: 'available' },
  { voice_id: 'aura-2-apollo-en', display_name: 'Apollo', gender: 'male', language: 'en', model: 'aura-2', status: 'available' },
  { voice_id: 'aura-2-arcas-en', display_name: 'Arcas', gender: 'male', language: 'en', model: 'aura-2', status: 'available' },
  { voice_id: 'aura-2-aries-en', display_name: 'Aries', gender: 'male', language: 'en', model: 'aura-2', status: 'available' },
  { voice_id: 'aura-2-asteria-en', display_name: 'Asteria', gender: 'female', language: 'en', model: 'aura-2', status: 'available' },
  { voice_id: 'aura-2-athena-en', display_name: 'Athena', gender: 'female', language: 'en', model: 'aura-2', status: 'available' },
  { voice_id: 'aura-2-luna-en', display_name: 'Luna', gender: 'female', language: 'en', model: 'aura-2', status: 'available' },
  { voice_id: 'aura-2-orion-en', display_name: 'Orion', gender: 'male', language: 'en', model: 'aura-2', status: 'available' },
  { voice_id: 'aura-2-orpheus-en', display_name: 'Orpheus', gender: 'male', language: 'en', model: 'aura-2', status: 'available' },
  { voice_id: 'aura-2-zeus-en', display_name: 'Zeus', gender: 'male', language: 'en', model: 'aura-2', status: 'available' },
  { voice_id: 'aura-asteria-en', display_name: 'Asteria (Aura 1)', gender: 'female', language: 'en', model: 'aura-1', status: 'legacy' },
  { voice_id: 'aura-orion-en', display_name: 'Orion (Aura 1)', gender: 'male', language: 'en', model: 'aura-1', status: 'legacy' },
]);

/** Rumik Silk speakers already used by the Studio. */
const RUMIK_VOICES = Object.freeze([
  { voice_id: 'speaker_1', display_name: 'Speaker 1', gender: '', language: 'en-IN', model: 'mulberry', status: 'available' },
  { voice_id: 'speaker_2', display_name: 'Speaker 2', gender: '', language: 'en-IN', model: 'mulberry', status: 'available' },
  { voice_id: 'speaker_3', display_name: 'Speaker 3', gender: '', language: 'en-IN', model: 'mulberry', status: 'available' },
  { voice_id: 'speaker_4', display_name: 'Speaker 4', gender: '', language: 'en-IN', model: 'mulberry', status: 'available' },
  { voice_id: 'muga', display_name: 'Muga', gender: '', language: 'en-IN', model: 'muga', status: 'available' },
]);

function titleCase(id) {
  return String(id || '')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function normalizeVoiceRow(row) {
  return {
    provider: String(row.provider || ''),
    voice_id: String(row.voice_id || ''),
    display_name: String(row.display_name || titleCase(row.voice_id) || ''),
    language: String(row.language || ''),
    model: String(row.model || ''),
    gender: String(row.gender || ''),
    status: String(row.status || 'available'),
  };
}

function buildSarvamVoices() {
  const out = [];
  // Multilingual speakers: one catalog row per speaker with language "" so the
  // UI can pair any Sarvam language mapping with any speaker. Language filter
  // uses language_map / languages rather than per-row language exclusivity.
  for (const s of SARVAM_V3_SPEAKERS) {
    out.push(normalizeVoiceRow({
      provider: 'sarvam',
      voice_id: s.voice_id,
      display_name: titleCase(s.voice_id),
      language: '',
      model: 'bulbul:v3',
      gender: s.gender,
      status: s.status,
    }));
  }
  for (const s of SARVAM_V2_SPEAKERS) {
    out.push(normalizeVoiceRow({
      provider: 'sarvam',
      voice_id: s.voice_id,
      display_name: titleCase(s.voice_id) + ' (v2)',
      language: '',
      model: 'bulbul:v2',
      gender: s.gender,
      status: s.status,
    }));
  }
  return out;
}

function buildDeepgramVoices() {
  return DEEPGRAM_AURA_VOICES.map((v) => normalizeVoiceRow({
    provider: 'deepgram',
    voice_id: v.voice_id,
    display_name: v.display_name,
    language: v.language,
    model: v.model,
    gender: v.gender,
    status: v.status,
  }));
}

function buildRumikVoices() {
  return RUMIK_VOICES.map((v) => normalizeVoiceRow({
    provider: 'rumik',
    voice_id: v.voice_id,
    display_name: v.display_name,
    language: v.language,
    model: v.model,
    gender: v.gender,
    status: v.status,
  }));
}

function listProviders() {
  return PROVIDERS.map((p) => ({ id: p.id, label: p.label }));
}

function listAllVoices() {
  return buildSarvamVoices().concat(buildDeepgramVoices(), buildRumikVoices());
}

function filterVoices(opts = {}) {
  const provider = opts.provider ? String(opts.provider).trim().toLowerCase() : '';
  const language = opts.language ? String(opts.language).trim() : '';
  const model = opts.model ? String(opts.model).trim() : '';
  let voices = listAllVoices();
  if (provider) voices = voices.filter((v) => v.provider === provider);
  if (model) voices = voices.filter((v) => v.model === model);
  if (language) {
    voices = voices.filter((v) => {
      if (!v.language) return true; // multilingual (Sarvam)
      if (v.language === language) return true;
      // Deepgram en matches en-IN / en-US selection in UI.
      if (v.language === 'en' && /^en([-_]|$)/i.test(language)) return true;
      return false;
    });
  }
  return voices;
}

function getCatalog(opts = {}) {
  const provider = opts.provider ? String(opts.provider).trim().toLowerCase() : '';
  const voices = filterVoices(opts);
  const payload = {
    voices,
    providers: listProviders(),
    models: {
      sarvam: ['bulbul:v3', 'bulbul:v2'],
      deepgram: ['aura-2', 'aura-1'],
      rumik: ['mulberry', 'muga'],
    },
    languages: {
      sarvam: SARVAM_LANGUAGES.map((l) => ({ ...l })),
      deepgram: [{ id: 'en', label: 'English' }],
      rumik: [{ id: 'en-IN', label: 'English (India)' }],
    },
    language_map: {
      sarvam: SARVAM_LANGUAGE_RECOMMENDATIONS,
    },
    // Live production TTS is unchanged by this catalog. Draft prefs only.
    live_apply_enabled: false,
    source: 'config',
  };
  if (provider) {
    payload.provider = provider;
    payload.languages_for_provider = (payload.languages[provider] || []).slice();
  }
  return payload;
}

function findVoice(provider, voiceId) {
  const p = String(provider || '').trim().toLowerCase();
  const id = String(voiceId || '').trim();
  return listAllVoices().find((v) => v.provider === p && v.voice_id === id) || null;
}

const DRAFT_PROVIDERS = new Set(['sarvam', 'deepgram', 'rumik']);

function normalizeDraftVoiceRef(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const provider = String(raw.provider || '').trim().toLowerCase();
  if (!DRAFT_PROVIDERS.has(provider)) return null;
  const voice_id = String(raw.voice_id || raw.speaker || '').trim().slice(0, 80);
  if (!voice_id) return null;
  const model = String(raw.model || '').trim().slice(0, 40);
  const language = String(raw.language || '').trim().slice(0, 16);
  const known = findVoice(provider, voice_id);
  return {
    provider,
    voice_id,
    display_name: known ? known.display_name : titleCase(voice_id),
    language: language || (known && known.language) || '',
    model: model || (known && known.model) || '',
    gender: known ? known.gender : '',
    status: known ? known.status : 'available',
  };
}

function defaultDraftPrefs() {
  // Matches current production Rumik default. Draft only, never auto-applied.
  return {
    provider: 'rumik',
    language: 'en-IN',
    voice_id: 'speaker_2',
    model: 'mulberry',
    default_voice: normalizeDraftVoiceRef({
      provider: 'rumik', voice_id: 'speaker_2', model: 'mulberry', language: 'en-IN',
    }),
    fallback_voice: normalizeDraftVoiceRef({
      provider: 'rumik', voice_id: 'speaker_1', model: 'mulberry', language: 'en-IN',
    }),
    apply_live: false,
    updatedAt: null,
  };
}

function normalizeDraftPrefs(input, existing) {
  const base = existing && typeof existing === 'object' ? existing : defaultDraftPrefs();
  const b = input && typeof input === 'object' ? input : {};
  const provider = DRAFT_PROVIDERS.has(String(b.provider || '').trim().toLowerCase())
    ? String(b.provider).trim().toLowerCase()
    : (DRAFT_PROVIDERS.has(base.provider) ? base.provider : 'rumik');
  const language = String(b.language != null ? b.language : base.language || 'en-IN').trim().slice(0, 16) || 'en-IN';
  const voice_id = String(b.voice_id != null ? b.voice_id : base.voice_id || 'speaker_2').trim().slice(0, 80) || 'speaker_2';
  const model = String(b.model != null ? b.model : base.model || '').trim().slice(0, 40);
  const known = findVoice(provider, voice_id);
  const default_voice = normalizeDraftVoiceRef(b.default_voice != null ? b.default_voice : base.default_voice)
    || normalizeDraftVoiceRef({ provider, voice_id, model: model || (known && known.model), language });
  const fallback_voice = normalizeDraftVoiceRef(b.fallback_voice != null ? b.fallback_voice : base.fallback_voice)
    || normalizeDraftVoiceRef({ provider: 'rumik', voice_id: 'speaker_1', model: 'mulberry', language: 'en-IN' });
  return {
    provider,
    language,
    voice_id,
    model: model || (known && known.model) || (provider === 'sarvam' ? 'bulbul:v3' : provider === 'deepgram' ? 'aura-2' : 'mulberry'),
    default_voice,
    fallback_voice,
    // Hard-gated: this PR never flips live production TTS.
    apply_live: false,
    updatedAt: b.updatedAt || base.updatedAt || null,
  };
}

function publicDraftPrefs(prefs) {
  const n = normalizeDraftPrefs(prefs);
  return {
    provider: n.provider,
    language: n.language,
    voice_id: n.voice_id,
    model: n.model,
    default_voice: n.default_voice,
    fallback_voice: n.fallback_voice,
    apply_live: false,
    live_apply_enabled: false,
    updatedAt: n.updatedAt,
    note: 'Draft preferences only. Live production TTS and Dograh workflow voices are unchanged.',
  };
}

function getTenantDraftPrefs(tenant) {
  return publicDraftPrefs(tenant && tenant.ttsDraftPrefs);
}

function setTenantDraftPrefs(tenant, body) {
  const next = normalizeDraftPrefs(body, tenant && tenant.ttsDraftPrefs);
  next.updatedAt = new Date().toISOString();
  next.apply_live = false;
  tenant.ttsDraftPrefs = next;
  return publicDraftPrefs(next);
}

module.exports = {
  PROVIDERS,
  SARVAM_LANGUAGES,
  SARVAM_LANGUAGE_RECOMMENDATIONS,
  getCatalog,
  listAllVoices,
  filterVoices,
  findVoice,
  listProviders,
  normalizeVoiceRow,
  normalizeDraftVoiceRef,
  defaultDraftPrefs,
  normalizeDraftPrefs,
  publicDraftPrefs,
  getTenantDraftPrefs,
  setTenantDraftPrefs,
};
