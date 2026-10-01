/**
 * Astra Voice. Unified voice catalog facade.
 *
 * GET /api/voice/catalog aggregates:
 *   - Dograh managed + BYOK discovery (live API or fallback)
 *   - Deepgram Aura, Sarvam, Rumik from tts-voice-catalog.js
 *
 * Customer-facing voice modes: astra_auto | dograh_managed | byok
 * Provider picker: auto | dograh | deepgram | sarvam | rumik
 *
 * Never exposes API keys. Does not change live production TTS.
 * No em dashes anywhere. Commas and periods only.
 */
'use strict';

const staticCatalog = require('./tts-voice-catalog');
const dograhDiscovery = require('./dograh-voice-discovery');

const VOICE_MODES = Object.freeze([
  Object.freeze({
    id: 'astra_auto',
    label: 'Astra Auto',
    description: 'Astra Voice picks the best available engine. Dograh remains the runtime underneath.',
  }),
  Object.freeze({
    id: 'dograh_managed',
    label: 'Dograh Managed',
    description: 'Use Dograh-managed voice, language, and speed behind one service key (server-side only).',
  }),
  Object.freeze({
    id: 'byok',
    label: 'BYOK',
    description: 'Bring your own provider keys already configured on the server. Never enter keys in this UI.',
  }),
]);

const PROVIDER_OPTIONS = Object.freeze([
  Object.freeze({ id: 'auto', label: 'Auto' }),
  Object.freeze({ id: 'dograh', label: 'Dograh' }),
  Object.freeze({ id: 'deepgram', label: 'Deepgram' }),
  Object.freeze({ id: 'sarvam', label: 'Sarvam' }),
  Object.freeze({ id: 'rumik', label: 'Rumik' }),
]);

function titleCase(id) {
  return String(id || '')
    .replace(/[_:-]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

function unifyVoice(opts) {
  const provider = String(opts.provider || '');
  const id = String(opts.id || opts.voice_id || '');
  const name = String(opts.name || opts.display_name || titleCase(id) || id);
  const language = String(opts.language || '');
  const locale = String(opts.locale || language || '');
  const gender = String(opts.gender || '');
  const style = String(opts.style || '');
  const model = String(opts.model || '');
  const status = String(opts.status || 'available');
  const speed_supported = opts.speed_supported !== false;
  // Keep prior Sarvam-normalized field names alongside the unified shape.
  return {
    id,
    name,
    language,
    locale,
    gender,
    style,
    speed_supported: !!speed_supported,
    // Compat / exact prior fields
    provider,
    voice_id: id,
    display_name: name,
    model,
    status,
  };
}

function voicesFromStaticProvider(providerId) {
  return staticCatalog.filterVoices({ provider: providerId }).map((v) => unifyVoice({
    provider: v.provider,
    id: v.voice_id,
    name: v.display_name,
    language: v.language,
    locale: v.language,
    gender: v.gender,
    model: v.model,
    status: v.status,
    speed_supported: providerId === 'sarvam' || providerId === 'deepgram',
  }));
}

function voicesFromDograhManaged(dograhBlock) {
  const langs = dograhBlock.languages || ['multi'];
  const defaultLang = (dograhBlock.defaults && dograhBlock.defaults.language) || 'multi';
  return (dograhBlock.voices || ['default']).map((voiceId) => unifyVoice({
    provider: 'dograh',
    id: voiceId,
    name: voiceId === 'default' ? 'Dograh Default' : titleCase(voiceId),
    language: defaultLang,
    locale: defaultLang,
    gender: '',
    style: 'managed',
    model: 'default',
    status: 'available',
    speed_supported: true,
  })).concat(
    // Expose multilingual auto-detect as a selectable language context row helper
    // is handled via languages list; keep a single managed voice row.
    [],
  ).map((v) => ({ ...v, language: v.language || langs[0] || 'multi' }));
}

function voicesFromByokSchema(parsed) {
  const provider = parsed.provider;
  const model = (parsed.defaults && parsed.defaults.model) || (parsed.models && parsed.models[0]) || '';
  const language = (parsed.defaults && parsed.defaults.language) || (parsed.languages && parsed.languages[0]) || '';
  const modelVoices = parsed.model_voices || {};
  const rows = [];
  const seen = new Set();

  function pushVoice(voiceId, modelId) {
    const key = provider + '::' + voiceId + '::' + (modelId || '');
    if (seen.has(key) || !voiceId) return;
    seen.add(key);
    // Prefer richer static metadata when we already curate this provider.
    const known = staticCatalog.findVoice(provider, voiceId);
    rows.push(unifyVoice({
      provider,
      id: voiceId,
      name: known ? known.display_name : titleCase(voiceId),
      language: known ? known.language : language,
      locale: known ? known.language : language,
      gender: known ? known.gender : '',
      model: modelId || (known && known.model) || model,
      status: known ? known.status : 'available',
      speed_supported: parsed.speed_supported !== false,
    }));
  }

  if (Object.keys(modelVoices).length) {
    for (const [modelId, voices] of Object.entries(modelVoices)) {
      for (const voiceId of voices) pushVoice(voiceId, modelId);
    }
  }
  for (const voiceId of parsed.voices || []) pushVoice(voiceId, model);

  // If Dograh schema had no examples, fall back to our curated static list.
  if (!rows.length && ['deepgram', 'sarvam', 'rumik'].includes(provider)) {
    return voicesFromStaticProvider(provider);
  }
  return rows;
}

function buildProviderBlocks(discovery) {
  const blocks = [];
  const dograh = discovery.dograh || dograhDiscovery.normalizeDograhManagedBlock(null);

  blocks.push({
    provider: 'dograh',
    mode: 'managed',
    label: 'Dograh Managed',
    voices: voicesFromDograhManaged(dograh),
    languages: (dograh.languages || []).map((id) => ({
      id,
      label: id === 'multi' ? 'Multilingual (Auto-detect)' : id,
    })),
    speeds: dograh.speeds || [0.8, 1.0, 1.2],
    speed_range: dograh.speed_range || { min: 0.5, max: 2.0, step: 0.1 },
    defaults: dograh.defaults,
    allow_custom_input: !!dograh.allow_custom_input,
  });

  // Speech to Speech realtime providers (informational / discovery). Not selected
  // as production TTS by this PR.
  for (const rt of discovery.realtime_providers || []) {
    blocks.push({
      provider: rt.provider,
      mode: 'speech_to_speech',
      label: (rt.label || rt.provider) + ' (Speech to Speech)',
      voices: voicesFromByokSchema(rt),
      languages: (rt.languages || []).map((id) => ({ id, label: id })),
      speeds: [],
      speed_range: null,
      defaults: rt.defaults || {},
      allow_custom_input: false,
    });
  }

  const byokWanted = ['deepgram', 'sarvam', 'rumik'];
  const byokFromDograh = new Map((discovery.byok_tts || []).map((p) => [p.provider, p]));
  for (const id of byokWanted) {
    const parsed = byokFromDograh.get(id);
    const voices = parsed
      ? voicesFromByokSchema(parsed)
      : voicesFromStaticProvider(id);
    // Ensure curated static voices are present even when Dograh schema is sparse.
    if (parsed) {
      const have = new Set(voices.map((v) => v.id));
      for (const v of voicesFromStaticProvider(id)) {
        if (!have.has(v.id)) voices.push(v);
      }
    }
    blocks.push({
      provider: id,
      mode: 'byok',
      label: id === 'deepgram' ? 'Deepgram Aura' : titleCase(id),
      voices,
      languages: id === 'sarvam'
        ? staticCatalog.SARVAM_LANGUAGES.map((l) => ({ ...l }))
        : id === 'deepgram'
          ? [{ id: 'en', label: 'English' }]
          : [{ id: 'en-IN', label: 'English (India)' }],
      speeds: id === 'sarvam' ? [0.8, 1.0, 1.2] : [],
      speed_range: id === 'sarvam' ? { min: 0.5, max: 2.0, step: 0.1 } : null,
      defaults: parsed && parsed.defaults ? parsed.defaults : {},
      allow_custom_input: false,
    });
  }

  return blocks;
}

/**
 * Build the unified catalog. Prefer live Dograh discovery; always merge curated
 * Deepgram / Sarvam / Rumik rows so the UI works offline.
 */
async function getUnifiedCatalog(opts = {}) {
  const discovery = await dograhDiscovery.discoverDograhVoiceCatalog();
  const providers = buildProviderBlocks(discovery);
  const providerFilter = opts.provider ? String(opts.provider).trim().toLowerCase() : '';
  const modeFilter = opts.mode ? String(opts.mode).trim().toLowerCase() : '';
  let filtered = providers;
  if (providerFilter && providerFilter !== 'auto') {
    filtered = filtered.filter((p) => p.provider === providerFilter);
  }
  if (modeFilter) {
    filtered = filtered.filter((p) => p.mode === modeFilter);
  }

  const flatVoices = [];
  for (const block of filtered) {
    for (const v of block.voices) flatVoices.push(v);
  }

  // Also keep prior flat Sarvam-normalized list under voices for compatibility.
  const sarvamCompat = staticCatalog.getCatalog({
    provider: opts.provider === 'sarvam' ? 'sarvam' : '',
    language: opts.language || '',
    model: opts.model || '',
  });

  return {
    providers: filtered,
    voice_modes: VOICE_MODES.map((m) => ({ ...m })),
    provider_options: PROVIDER_OPTIONS.map((p) => ({ ...p })),
    voices: flatVoices,
    // Prior endpoint compatibility fields
    languages: sarvamCompat.languages,
    language_map: sarvamCompat.language_map,
    models: sarvamCompat.models,
    speed: (() => {
      const managed = providers.find((p) => p.provider === 'dograh' && p.mode === 'managed');
      return {
        options: (managed && managed.speeds) || [0.8, 1.0, 1.2],
        range: (managed && managed.speed_range) || { min: 0.5, max: 2.0, step: 0.1 },
        default: 1.0,
      };
    })(),
    discovery: {
      dograh: discovery.source,
      path: discovery.path || dograhDiscovery.DOGRAH_DEFAULTS_PATH,
      status: discovery.status || null,
      error: discovery.error || null,
      sources: [
        discovery.source === 'live'
          ? 'dograh:GET /api/v1/organizations/model-configurations/v2/defaults'
          : 'fallback:local Dograh defaults mirror',
        'config:dashboard/lib/tts-voice-catalog.js (Deepgram Aura, Sarvam, Rumik)',
      ],
    },
    live_apply_enabled: false,
    set_active_enabled: false,
    note: 'Draft catalog only. Preview and Save draft do not change Maya / production TTS. Set active is gated until an explicit apply ships.',
  };
}

function defaultUnifiedDraftPrefs() {
  const base = staticCatalog.defaultDraftPrefs();
  return {
    voice_mode: 'astra_auto',
    provider: 'auto',
    language: 'en-IN',
    voice_id: base.voice_id,
    model: base.model,
    speed: 1.0,
    default_voice: base.default_voice,
    fallback_voice: base.fallback_voice,
    // English fallback preserved until another config is validated.
    english_fallback: staticCatalog.normalizeDraftVoiceRef({
      provider: 'rumik', voice_id: 'speaker_2', model: 'mulberry', language: 'en-IN',
    }),
    apply_live: false,
    active: null,
    updatedAt: null,
  };
}

function normalizeUnifiedDraftPrefs(input, existing) {
  const base = existing && typeof existing === 'object' ? existing : defaultUnifiedDraftPrefs();
  const b = input && typeof input === 'object' ? input : {};
  const voiceModes = new Set(VOICE_MODES.map((m) => m.id));
  const providers = new Set(PROVIDER_OPTIONS.map((p) => p.id));
  const voice_mode = voiceModes.has(String(b.voice_mode || '').trim())
    ? String(b.voice_mode).trim()
    : (voiceModes.has(base.voice_mode) ? base.voice_mode : 'astra_auto');
  const provider = providers.has(String(b.provider || '').trim().toLowerCase())
    ? String(b.provider).trim().toLowerCase()
    : (providers.has(base.provider) ? base.provider : 'auto');
  const language = String(b.language != null ? b.language : base.language || 'en-IN').trim().slice(0, 16) || 'en-IN';
  const voice_id = String(b.voice_id != null ? b.voice_id : base.voice_id || 'speaker_2').trim().slice(0, 80) || 'speaker_2';
  const model = String(b.model != null ? b.model : base.model || '').trim().slice(0, 40);
  let speed = Number(b.speed != null ? b.speed : base.speed);
  if (!Number.isFinite(speed)) speed = 1.0;
  speed = Math.max(0.5, Math.min(2.0, Math.round(speed * 10) / 10));

  const resolvedProvider = provider === 'auto' || provider === 'dograh'
    ? (provider === 'dograh' ? 'dograh' : 'rumik')
    : provider;

  const default_voice = staticCatalog.normalizeDraftVoiceRef(b.default_voice)
    || staticCatalog.normalizeDraftVoiceRef({
      provider: resolvedProvider === 'dograh' ? 'rumik' : resolvedProvider,
      voice_id: voice_id === 'default' ? 'speaker_2' : voice_id,
      model,
      language,
    })
    || staticCatalog.normalizeDraftVoiceRef(base.default_voice);
  const fallback_voice = staticCatalog.normalizeDraftVoiceRef(b.fallback_voice)
    || staticCatalog.normalizeDraftVoiceRef(base.fallback_voice)
    || staticCatalog.normalizeDraftVoiceRef({
      provider: 'rumik', voice_id: 'speaker_2', model: 'mulberry', language: 'en-IN',
    });
  const english_fallback = staticCatalog.normalizeDraftVoiceRef(b.english_fallback)
    || staticCatalog.normalizeDraftVoiceRef(base.english_fallback)
    || staticCatalog.normalizeDraftVoiceRef({
      provider: 'rumik', voice_id: 'speaker_2', model: 'mulberry', language: 'en-IN',
    });

  return {
    voice_mode,
    provider,
    language,
    voice_id,
    model: model || (default_voice && default_voice.model) || 'mulberry',
    speed,
    default_voice,
    fallback_voice,
    english_fallback,
    apply_live: false,
    // Set active stores a requested marker only. Never applied to production in this PR.
    active: null,
    active_requested: (() => {
      if (b.set_active === true || b.active_requested === true) {
        return {
          voice_mode,
          provider,
          language,
          voice_id,
          model: model || (default_voice && default_voice.model) || '',
          speed,
          requestedAt: new Date().toISOString(),
          applied: false,
          note: 'Queued only. Production TTS unchanged until an explicit apply ships.',
        };
      }
      if (b.active_requested && typeof b.active_requested === 'object') {
        return { ...b.active_requested, applied: false };
      }
      if (base.active_requested && typeof base.active_requested === 'object') {
        return { ...base.active_requested, applied: false };
      }
      return null;
    })(),
    updatedAt: b.updatedAt || base.updatedAt || null,
  };
}

function publicUnifiedDraftPrefs(prefs) {
  const n = normalizeUnifiedDraftPrefs(prefs);
  return {
    voice_mode: n.voice_mode,
    provider: n.provider,
    language: n.language,
    voice_id: n.voice_id,
    model: n.model,
    speed: n.speed,
    default_voice: n.default_voice,
    fallback_voice: n.fallback_voice,
    english_fallback: n.english_fallback,
    apply_live: false,
    live_apply_enabled: false,
    set_active_enabled: false,
    active: null,
    active_requested: n.active_requested,
    updatedAt: n.updatedAt,
    note: 'Draft preferences only. Preview / Save draft / Set active do not flip Maya or production TTS.',
  };
}

function getTenantUnifiedDraftPrefs(tenant) {
  return publicUnifiedDraftPrefs(tenant && (tenant.voiceDraftPrefs || tenant.ttsDraftPrefs));
}

function setTenantUnifiedDraftPrefs(tenant, body) {
  const next = normalizeUnifiedDraftPrefs(body, tenant && (tenant.voiceDraftPrefs || tenant.ttsDraftPrefs));
  next.updatedAt = new Date().toISOString();
  next.apply_live = false;
  next.active = null;
  tenant.voiceDraftPrefs = next;
  // Keep legacy field in sync for older clients.
  tenant.ttsDraftPrefs = staticCatalog.normalizeDraftPrefs({
    provider: next.provider === 'auto' ? 'rumik' : (next.provider === 'dograh' ? 'rumik' : next.provider),
    language: next.language,
    voice_id: next.voice_id,
    model: next.model,
    default_voice: next.default_voice,
    fallback_voice: next.fallback_voice,
  }, tenant.ttsDraftPrefs);
  tenant.ttsDraftPrefs.apply_live = false;
  tenant.ttsDraftPrefs.updatedAt = next.updatedAt;
  return publicUnifiedDraftPrefs(next);
}

module.exports = {
  VOICE_MODES,
  PROVIDER_OPTIONS,
  getUnifiedCatalog,
  defaultUnifiedDraftPrefs,
  normalizeUnifiedDraftPrefs,
  publicUnifiedDraftPrefs,
  getTenantUnifiedDraftPrefs,
  setTenantUnifiedDraftPrefs,
  unifyVoice,
};
