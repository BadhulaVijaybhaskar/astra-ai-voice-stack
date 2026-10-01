'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const dograhDiscovery = require('../lib/dograh-voice-discovery');
const unified = require('../lib/voice-catalog');

test('Dograh BYOK schema parser extracts voices/models without secrets', () => {
  const parsed = dograhDiscovery.parseTtsProviderSchema('sarvam', {
    title: 'Sarvam TTS',
    properties: {
      voice: {
        default: 'shubh',
        examples: ['shubh', 'priya'],
        json_schema_extra: { model_options: { 'bulbul:v3': ['shubh', 'priya'] } },
      },
      model: { default: 'bulbul:v3', examples: ['bulbul:v3'] },
      language: { default: 'hi-IN', examples: ['hi-IN', 'en-IN'] },
      speed: { type: 'number', default: 1.0 },
      api_key: { type: 'string' },
    },
  });
  assert.equal(parsed.provider, 'sarvam');
  assert.ok(parsed.voices.includes('shubh'));
  assert.ok(parsed.models.includes('bulbul:v3'));
  assert.equal(parsed.speed_supported, true);
  assert.equal(parsed.defaults.voice, 'shubh');
  assert.deepEqual(parsed.model_voices['bulbul:v3'], ['shubh', 'priya']);
});

test('stripSecrets removes api_key and token fields recursively', () => {
  const cleaned = dograhDiscovery.stripSecrets({
    dograh: { voices: ['default'] },
    byok: {
      pipeline: {
        tts: {
          deepgram: {
            properties: {
              voice: { default: 'aura-2-helena-en' },
              api_key: 'sk-secret-should-not-leak',
              Authorization: 'Bearer x',
            },
          },
        },
      },
    },
  });
  const json = JSON.stringify(cleaned);
  assert.equal(json.includes('sk-secret'), false);
  assert.equal(json.toLowerCase().includes('api_key'), false);
  assert.equal(json.toLowerCase().includes('authorization'), false);
  assert.equal(cleaned.byok.pipeline.tts.deepgram.properties.voice.default, 'aura-2-helena-en');
});

test('discoverDograhVoiceCatalog falls back when Dograh env is unset', async () => {
  const prevBase = process.env.DOGRAH_BASE_URL;
  const prevKey = process.env.DOGRAH_API_KEY;
  delete process.env.DOGRAH_BASE_URL;
  delete process.env.DOGRAH_API_KEY;
  try {
    const discovery = await dograhDiscovery.discoverDograhVoiceCatalog();
    assert.equal(discovery.source, 'fallback');
    assert.ok(discovery.dograh.voices.includes('default'));
    assert.ok(discovery.dograh.speeds.includes(1.0));
    assert.ok(Array.isArray(discovery.byok_tts));
    assert.equal(discovery.byok_tts.length, 0);
  } finally {
    if (prevBase === undefined) delete process.env.DOGRAH_BASE_URL; else process.env.DOGRAH_BASE_URL = prevBase;
    if (prevKey === undefined) delete process.env.DOGRAH_API_KEY; else process.env.DOGRAH_API_KEY = prevKey;
  }
});

test('GET unified catalog includes dograh managed + deepgram + sarvam + rumik', async () => {
  const prevBase = process.env.DOGRAH_BASE_URL;
  const prevKey = process.env.DOGRAH_API_KEY;
  delete process.env.DOGRAH_BASE_URL;
  delete process.env.DOGRAH_API_KEY;
  try {
    const cat = await unified.getUnifiedCatalog();
    assert.ok(Array.isArray(cat.providers));
    const ids = cat.providers.map((p) => p.provider + ':' + p.mode);
    assert.ok(ids.includes('dograh:managed'));
    assert.ok(ids.includes('deepgram:byok'));
    assert.ok(ids.includes('sarvam:byok'));
    assert.ok(ids.includes('rumik:byok'));

    const dograh = cat.providers.find((p) => p.provider === 'dograh' && p.mode === 'managed');
    assert.ok(dograh.voices.length >= 1);
    const voice = dograh.voices[0];
    for (const key of ['id', 'name', 'language', 'locale', 'gender', 'style', 'speed_supported']) {
      assert.ok(Object.prototype.hasOwnProperty.call(voice, key), 'missing ' + key);
    }
    assert.equal(voice.speed_supported, true);

    const sarvam = cat.providers.find((p) => p.provider === 'sarvam');
    assert.ok(sarvam.voices.some((v) => v.id === 'shubh'));
    assert.ok(sarvam.voices.every((v) => v.provider === 'sarvam' && v.voice_id));

    assert.deepEqual(cat.voice_modes.map((m) => m.id), ['astra_auto', 'dograh_managed', 'byok']);
    assert.deepEqual(cat.provider_options.map((p) => p.id), ['auto', 'dograh', 'deepgram', 'sarvam', 'rumik']);
    assert.equal(cat.live_apply_enabled, false);
    assert.equal(cat.set_active_enabled, false);
    assert.equal(cat.discovery.dograh, 'fallback');
    assert.ok(cat.discovery.sources.some((s) => s.includes('Dograh') || s.includes('fallback')));
    assert.equal(JSON.stringify(cat).includes('API_KEY'), false);
    assert.equal(JSON.stringify(cat).toLowerCase().includes('subscription'), false);

    // Multilingual persona maps (Vaani / Maya). No credentials.
    assert.ok(Array.isArray(cat.voice_personas));
    const vaani = cat.voice_personas.find((p) => p.persona_id === 'vaani');
    assert.ok(vaani);
    assert.equal(vaani.display_name, 'Vaani');
    assert.equal(vaani.language_routes['en-IN'].provider, 'rumik');
    assert.equal(vaani.language_routes['hi-IN'].provider, 'sarvam');
    assert.equal(vaani.language_routes['te-IN'].provider, 'sarvam');
    assert.ok(Array.isArray(cat.persona_routes_debug.vaani));
    assert.ok(cat.persona_routes_debug.vaani.some((r) => /Hindi → sarvam/i.test(r.summary)));
  } finally {
    if (prevBase === undefined) delete process.env.DOGRAH_BASE_URL; else process.env.DOGRAH_BASE_URL = prevBase;
    if (prevKey === undefined) delete process.env.DOGRAH_API_KEY; else process.env.DOGRAH_API_KEY = prevKey;
  }
});

test('unified draft prefs preserve English fallback and never apply live', () => {
  const tenant = { id: 't_voice_unified' };
  const saved = unified.setTenantUnifiedDraftPrefs(tenant, {
    voice_mode: 'byok',
    provider: 'sarvam',
    language: 'hi-IN',
    voice_id: 'priya',
    model: 'bulbul:v3',
    speed: 1.2,
    apply_live: true,
    set_active: true,
  });
  assert.equal(saved.voice_mode, 'byok');
  assert.equal(saved.provider, 'sarvam');
  assert.equal(saved.voice_id, 'priya');
  assert.equal(saved.speed, 1.2);
  assert.equal(saved.default_voice.provider, 'sarvam');
  assert.equal(saved.default_voice.voice_id, 'priya');
  assert.equal(saved.apply_live, false);
  assert.equal(saved.live_apply_enabled, false);
  assert.equal(saved.set_active_enabled, false);
  assert.equal(saved.active, null);
  assert.ok(saved.active_requested);
  assert.equal(saved.active_requested.applied, false);
  assert.equal(saved.english_fallback.provider, 'rumik');
  assert.equal(saved.english_fallback.voice_id, 'speaker_2');
  assert.equal(tenant.voiceDraftPrefs.apply_live, false);
  assert.equal(tenant.ttsDraftPrefs.apply_live, false);
});

test('provider filter returns only requested block', async () => {
  const cat = await unified.getUnifiedCatalog({ provider: 'deepgram' });
  assert.ok(cat.providers.every((p) => p.provider === 'deepgram'));
  assert.ok(cat.voices.every((v) => v.provider === 'deepgram'));
});

test('product catalog excludes openai/grok realtime and always includes Sarvam', async () => {
  const cat = await unified.getUnifiedCatalog();
  const productIds = cat.providers.map((p) => p.provider);
  assert.ok(productIds.includes('sarvam'));
  assert.ok(productIds.includes('dograh'));
  assert.ok(productIds.includes('deepgram'));
  assert.ok(productIds.includes('rumik'));
  assert.equal(productIds.includes('openai_realtime'), false);
  assert.equal(productIds.includes('grok_realtime'), false);
  assert.ok(cat.voices.every((v) => !/openai_realtime|grok_realtime/i.test(v.provider)));
  assert.ok(cat.voices.some((v) => v.provider === 'sarvam' && v.id === 'shubh'));
  assert.ok(cat.astra_supported_languages.length === 10);
  assert.deepEqual(
    cat.astra_supported_languages.map((l) => l.id),
    ['en-IN', 'hi-IN', 'te-IN', 'ta-IN', 'kn-IN', 'ml-IN', 'mr-IN', 'bn-IN', 'gu-IN', 'pa-IN'],
  );
  assert.ok(cat.astra_supported_languages.every((l) => l.status !== 'TESTED'));
  assert.equal(cat.voice_modes.find((m) => m.id === 'dograh_managed').label, 'Managed');
  const sarvamOpt = cat.provider_options.find((p) => p.id === 'sarvam');
  assert.ok(sarvamOpt);
  assert.ok(['ready', 'needs_funding', 'needs_credentials', 'unavailable'].includes(sarvamOpt.state));
});

test('Sarvam stays visible with needs_funding and preview gated', async () => {
  const prevKey = process.env.SARVAM_API_KEY;
  const prevFund = process.env.SARVAM_NEEDS_FUNDING;
  process.env.SARVAM_API_KEY = 'sk_test_sarvam';
  process.env.SARVAM_NEEDS_FUNDING = '1';
  try {
    const state = unified.resolveProviderState('sarvam');
    assert.equal(state.state, 'needs_funding');
    assert.equal(state.can_preview, false);
    assert.equal(state.can_activate, false);
    const cat = await unified.getUnifiedCatalog();
    const sarvam = cat.providers.find((p) => p.provider === 'sarvam');
    assert.ok(sarvam);
    assert.equal(sarvam.state, 'needs_funding');
    assert.ok(sarvam.voices.length >= 30);
    assert.equal(sarvam.can_preview, false);
    const opt = cat.provider_options.find((p) => p.id === 'sarvam');
    assert.equal(opt.state, 'needs_funding');
  } finally {
    if (prevKey === undefined) delete process.env.SARVAM_API_KEY;
    else process.env.SARVAM_API_KEY = prevKey;
    if (prevFund === undefined) delete process.env.SARVAM_NEEDS_FUNDING;
    else process.env.SARVAM_NEEDS_FUNDING = prevFund;
  }
});

test('product provider languages are curated Astra list, not Dograh 81', async () => {
  const cat = await unified.getUnifiedCatalog();
  const dograh = cat.providers.find((p) => p.provider === 'dograh');
  assert.ok(dograh);
  assert.equal(dograh.languages.length, 10);
  assert.ok(dograh.languages.every((l) => cat.astra_supported_languages.some((a) => a.id === l.id)));
  // Odia and other extras only under advanced_languages when present.
  assert.ok(!dograh.languages.some((l) => l.id === 'od-IN'));
});
