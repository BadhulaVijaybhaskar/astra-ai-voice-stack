/**
 * Astra Voice. Dograh model-configuration voice discovery adapter.
 *
 * Primary source (verified against Dograh OSS UI + routes):
 *   GET /api/v1/organizations/model-configurations/v2/defaults
 *   see dograh-hq/dograh ui ModelConfigurationV2 + api/routes/organization.py
 *
 * Returns managed (Dograh) voice/speed/language defaults and BYOK TTS provider
 * JSON schemas (Deepgram, Sarvam, Rumik, etc.). Never scrapes HTML.
 * Never returns API keys. Falls back to a local mirror when Dograh is offline.
 *
 * No em dashes anywhere. Commas and periods only.
 */
'use strict';

const { httpsGet } = require('./core');

const DOGRAH_DEFAULTS_PATH = '/api/v1/organizations/model-configurations/v2/defaults';
const DOGRAH_CONFIG_PATH = '/api/v1/organizations/model-configurations/v2';

const FALLBACK_DOGRAH = Object.freeze({
  voices: Object.freeze(['default']),
  allow_custom_input: true,
  speeds: Object.freeze([0.8, 1.0, 1.2]),
  speed_range: Object.freeze({ min: 0.5, max: 2.0, step: 0.1 }),
  languages: Object.freeze([
    'multi', 'en', 'en-US', 'en-IN', 'hi', 'hi-IN', 'ta', 'te', 'bn', 'mr', 'gu', 'kn', 'ml', 'pa',
  ]),
  multilingual_languages: Object.freeze(['en', 'es', 'fr', 'de', 'hi', 'ru', 'pt', 'ja', 'it', 'nl']),
  defaults: Object.freeze({ voice: 'default', speed: 1.0, language: 'multi' }),
});

function dograhConnection() {
  const raw = String(process.env.DOGRAH_BASE_URL || '').trim();
  if (!raw) return null;
  let url;
  try { url = new URL(raw); } catch { return null; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const prefix = url.pathname.replace(/\/$/, '');
  return { host: url.host, prefix: prefix === '/' ? '' : prefix, protocol: url.protocol };
}

function hasDograhCreds() {
  return !!(process.env.DOGRAH_BASE_URL && String(process.env.DOGRAH_BASE_URL).trim()
    && process.env.DOGRAH_API_KEY && String(process.env.DOGRAH_API_KEY).trim());
}

function stripSecrets(value, depth = 0) {
  if (depth > 12) return null;
  if (Array.isArray(value)) return value.map((v) => stripSecrets(v, depth + 1));
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    const key = String(k).toLowerCase();
    if (key.includes('api_key') || key.includes('apikey') || key.includes('secret')
      || key.includes('password') || key.includes('token') || key === 'authorization') {
      continue;
    }
    out[k] = stripSecrets(v, depth + 1);
  }
  return out;
}

function examplesFromSchemaProp(prop) {
  if (!prop || typeof prop !== 'object') return [];
  const examples = [];
  if (Array.isArray(prop.examples)) examples.push(...prop.examples);
  if (prop.example != null) examples.push(prop.example);
  if (prop.default != null) examples.push(prop.default);
  if (prop.json_schema_extra && Array.isArray(prop.json_schema_extra.examples)) {
    examples.push(...prop.json_schema_extra.examples);
  }
  // OpenAPI / pydantic sometimes nests examples under schema.extra-like keys
  if (Array.isArray(prop.enum)) examples.push(...prop.enum);
  return [...new Set(examples.map((x) => String(x)).filter(Boolean))];
}

function modelOptionsVoices(prop) {
  const extra = prop && (prop.json_schema_extra || prop);
  const modelOptions = extra && extra.model_options;
  if (!modelOptions || typeof modelOptions !== 'object') return {};
  const out = {};
  for (const [model, voices] of Object.entries(modelOptions)) {
    if (Array.isArray(voices)) out[model] = voices.map(String);
  }
  return out;
}

/**
 * Parse a Dograh BYOK TTS provider JSON Schema into a maintainable voice list.
 */
function parseTtsProviderSchema(providerId, schema) {
  const s = schema && typeof schema === 'object' ? schema : {};
  const props = s.properties && typeof s.properties === 'object' ? s.properties : {};
  const title = String(s.title || providerId);
  const voiceProp = props.voice || props.speaker || {};
  const modelProp = props.model || {};
  const languageProp = props.language || props.language_code || {};
  const speedProp = props.speed || {};
  const voices = examplesFromSchemaProp(voiceProp);
  const models = examplesFromSchemaProp(modelProp);
  const languages = examplesFromSchemaProp(languageProp);
  const modelVoices = modelOptionsVoices(voiceProp);
  const speedSupported = !!speedProp && Object.keys(speedProp).length > 0;
  const defaultVoice = voiceProp.default != null ? String(voiceProp.default) : (voices[0] || '');
  const defaultModel = modelProp.default != null ? String(modelProp.default) : (models[0] || '');
  const defaultLanguage = languageProp.default != null ? String(languageProp.default) : (languages[0] || '');
  return {
    provider: String(providerId),
    label: title,
    models,
    languages,
    voices,
    model_voices: modelVoices,
    speed_supported: speedSupported,
    defaults: {
      voice: defaultVoice,
      model: defaultModel,
      language: defaultLanguage,
    },
  };
}

function normalizeDograhManagedBlock(raw) {
  const d = raw && typeof raw === 'object' ? raw : {};
  const voices = Array.isArray(d.voices) && d.voices.length
    ? d.voices.map(String)
    : FALLBACK_DOGRAH.voices.slice();
  const speeds = Array.isArray(d.speeds) && d.speeds.length
    ? d.speeds.map(Number).filter(Number.isFinite)
    : FALLBACK_DOGRAH.speeds.slice();
  const languages = Array.isArray(d.languages) && d.languages.length
    ? d.languages.map(String)
    : FALLBACK_DOGRAH.languages.slice();
  const multilingual = Array.isArray(d.multilingual_languages)
    ? d.multilingual_languages.map(String)
    : FALLBACK_DOGRAH.multilingual_languages.slice();
  const defaults = d.defaults && typeof d.defaults === 'object' ? d.defaults : {};
  const speedRange = d.speed_range && typeof d.speed_range === 'object'
    ? {
      min: Number(d.speed_range.min) || 0.5,
      max: Number(d.speed_range.max) || 2.0,
      step: Number(d.speed_range.step) || 0.1,
    }
    : { ...FALLBACK_DOGRAH.speed_range };
  return {
    voices,
    allow_custom_input: d.allow_custom_input !== false,
    speeds,
    speed_range: speedRange,
    languages,
    multilingual_languages: multilingual,
    defaults: {
      voice: String(defaults.voice || FALLBACK_DOGRAH.defaults.voice),
      speed: Number.isFinite(Number(defaults.speed)) ? Number(defaults.speed) : 1.0,
      language: String(defaults.language || FALLBACK_DOGRAH.defaults.language),
    },
  };
}

async function fetchDograhJson(pathname) {
  if (!hasDograhCreds()) {
    return { ok: false, reason: 'not_configured', status: 0, data: null };
  }
  const connection = dograhConnection();
  if (!connection) {
    return { ok: false, reason: 'invalid_base_url', status: 0, data: null };
  }
  const headers = {
    'X-API-Key': String(process.env.DOGRAH_API_KEY),
    Accept: 'application/json',
  };
  let up;
  try {
    up = await httpsGet(connection.host, connection.prefix + pathname, headers);
  } catch (e) {
    return { ok: false, reason: 'network', status: 0, data: null, error: String(e && e.message || e) };
  }
  let data = null;
  try { data = JSON.parse(up.buffer.toString('utf8')); } catch { data = null; }
  if (up.status < 200 || up.status >= 300 || !data) {
    return {
      ok: false,
      reason: 'upstream',
      status: up.status,
      data: null,
      error: data && (data.detail || data.error) ? String(data.detail || data.error) : 'Dograh defaults request failed',
    };
  }
  return { ok: true, reason: 'live', status: up.status, data: stripSecrets(data) };
}

/**
 * Discover Dograh voice catalog.
 * @returns {Promise<{ source: 'live'|'fallback', dograh: object, byok_tts: object[], raw_keys: string[], error?: string }>}
 */
async function discoverDograhVoiceCatalog() {
  const result = await fetchDograhJson(DOGRAH_DEFAULTS_PATH);
  if (!result.ok) {
    return {
      source: 'fallback',
      path: DOGRAH_DEFAULTS_PATH,
      dograh: normalizeDograhManagedBlock(FALLBACK_DOGRAH),
      byok_tts: [],
      realtime_providers: [],
      error: result.error || result.reason,
      status: result.status,
    };
  }
  const data = result.data;
  const dograh = normalizeDograhManagedBlock(data.dograh);
  const ttsSchemas = (((data.byok || {}).pipeline || {}).tts) || {};
  const byok_tts = Object.entries(ttsSchemas).map(([id, schema]) => parseTtsProviderSchema(id, schema));
  const realtimeSchemas = (((data.byok || {}).realtime || {}).realtime) || {};
  const realtime_providers = Object.entries(realtimeSchemas).map(([id, schema]) => {
    const parsed = parseTtsProviderSchema(id, schema);
    return { ...parsed, mode: 'speech_to_speech' };
  });
  return {
    source: 'live',
    path: DOGRAH_DEFAULTS_PATH,
    dograh,
    byok_tts,
    realtime_providers,
    status: result.status,
  };
}

async function fetchDograhEffectiveConfig() {
  const result = await fetchDograhJson(DOGRAH_CONFIG_PATH);
  if (!result.ok) return { source: 'unavailable', effective: null, error: result.error || result.reason };
  const effective = result.data && result.data.effective_configuration
    ? stripSecrets(result.data.effective_configuration)
    : null;
  return { source: 'live', effective, configuration: stripSecrets(result.data.configuration || null) };
}

module.exports = {
  DOGRAH_DEFAULTS_PATH,
  DOGRAH_CONFIG_PATH,
  FALLBACK_DOGRAH,
  hasDograhCreds,
  discoverDograhVoiceCatalog,
  fetchDograhEffectiveConfig,
  parseTtsProviderSchema,
  normalizeDograhManagedBlock,
  stripSecrets,
};
