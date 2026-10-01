/**
 * Astra Voice multilingual persona routing tests.
 *
 * Covers:
 *   - resolvePersonaRoute(persona, language, mode)
 *   - Rumik mode blocks unsupported languages
 *   - Astra Auto returns Sarvam for hi/te/ta for Vaani
 *   - Fallback never picks English-only engine for Indic
 *   - Multilingual preview does not mutate employee.primaryLanguage
 *
 * No live TTS keys required.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const router = require('../lib/voice-persona-router');
const voicePreview = require('../lib/voice-preview');

test('resolvePersonaRoute: Vaani Astra Auto maps English to Rumik', () => {
  const r = router.resolvePersonaRoute('vaani', 'en-IN', 'astra_auto');
  assert.equal(r.ok, true);
  assert.equal(r.route.provider, 'rumik');
  assert.equal(r.route.voice_id, 'speaker_2');
  assert.equal(r.route.model, 'mulberry');
  assert.equal(r.persona.persona_id, 'vaani');
  assert.equal(r.persona.display_name, 'Vaani');
  assert.equal(r.mode, 'astra_auto');
});

test('resolvePersonaRoute: Vaani Astra Auto returns Sarvam for hi/te/ta', () => {
  for (const [lang, voice] of [
    ['hi-IN', 'priya'],
    ['te-IN', 'neha'],
    ['ta-IN', 'ishita'],
  ]) {
    const r = router.resolvePersonaRoute('vaani', lang, 'astra_auto');
    assert.equal(r.ok, true, lang + ' should resolve');
    assert.equal(r.route.provider, 'sarvam', lang + ' provider');
    assert.equal(r.route.voice_id, voice, lang + ' voice');
    assert.equal(r.route.model, 'bulbul:v3');
    assert.equal(r.language, lang);
  }
});

test('resolvePersonaRoute: Vaani Auto covers all ASTRA_SUPPORTED_LANGUAGES with compatible engines', () => {
  const langs = require('../lib/tts-voice-catalog').listAstraSupportedLanguages();
  for (const l of langs) {
    const r = router.resolvePersonaRoute('vaani', l.id, 'auto');
    assert.equal(r.ok, true, l.id + ' missing route');
    if (l.id === 'en-IN') {
      assert.equal(r.route.provider, 'rumik');
    } else {
      assert.equal(r.route.provider, 'sarvam', l.id + ' must not use Rumik');
      assert.equal(router.isEnglishOnlyProvider(r.route.provider), false);
    }
  }
});

test('Rumik mode blocks unsupported languages (Hindi/Telugu/Tamil)', () => {
  for (const lang of ['hi-IN', 'te-IN', 'ta-IN', 'kn-IN']) {
    const r = router.resolvePersonaRoute('vaani', lang, 'rumik');
    assert.equal(r.ok, false, lang + ' must be blocked in Rumik mode');
    assert.equal(r.code, 'provider_language_unsupported');
    assert.deepEqual(r.supported, ['en-IN']);
  }
  const en = router.resolvePersonaRoute('vaani', 'en-IN', 'rumik');
  assert.equal(en.ok, true);
  assert.equal(en.route.provider, 'rumik');
});

test('languagesForMode: Astra Auto uses persona routes; Rumik is English-only', () => {
  const auto = router.languagesForMode('vaani', 'astra_auto');
  assert.ok(auto.length >= 10);
  assert.ok(auto.some((l) => l.id === 'hi-IN'));
  assert.ok(auto.some((l) => l.id === 'te-IN'));
  assert.ok(auto.every((l) => l.supported === true));

  const rumik = router.languagesForMode('vaani', 'rumik');
  assert.equal(rumik.length, 1);
  assert.equal(rumik[0].id, 'en-IN');
});

test('fallback never picks English-only engine for Indic', () => {
  for (const lang of ['hi-IN', 'te-IN', 'ta-IN', 'kn-IN', 'ml-IN', 'mr-IN', 'bn-IN', 'gu-IN', 'pa-IN']) {
    const fb = router.resolveFallbackRoute('vaani', lang, 'sarvam', { failedVoiceId: 'priya' });
    assert.equal(fb.ok, true, lang + ' should have fallback');
    assert.equal(router.isEnglishOnlyProvider(fb.route.provider), false, lang);
    assert.notEqual(fb.route.provider, 'rumik', lang);
    assert.notEqual(fb.route.provider, 'deepgram', lang);
    assert.equal(fb.route.provider, 'sarvam');
  }

  // If only English-only candidates existed, resolver must refuse.
  const fakePersona = {
    persona_id: 'custom_bad',
    display_name: 'Bad',
    style: 'natural',
    gender: 'female',
    language_routes: {
      'te-IN': { provider: 'sarvam', voice_id: 'neha', model: 'bulbul:v3', language: 'te-IN' },
    },
    language_fallbacks: {
      // Intentionally invalid English-only fallback for Telugu.
      'te-IN': [
        { provider: 'rumik', voice_id: 'speaker_2', model: 'mulberry', language: 'en-IN' },
        { provider: 'deepgram', voice_id: 'aura-2-helena-en', model: 'aura-2', language: 'en-IN' },
      ],
    },
  };
  const refused = router.resolveFallbackRoute(fakePersona, 'te-IN', 'sarvam');
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'fallback_unavailable');
});

test('multilingual preview does not mutate employee.primaryLanguage', () => {
  const employee = {
    id: 'emp_f85510806c9de004',
    name: 'Vaani',
    voice: { language: 'en-IN', persona_id: 'vaani' },
    language: 'en-IN',
  };
  const snap = router.applyPreviewLanguage(employee, 'te-IN');
  assert.equal(snap.primaryLanguage, 'en-IN');
  assert.equal(snap.previewLanguage, 'te-IN');
  assert.equal(snap.mutated, false);
  assert.equal(employee.voice.language, 'en-IN');
  assert.equal(employee.language, 'en-IN');
});

test('resolvePersonaId recognizes Vaani / Maya without inventing Maya for strangers', () => {
  assert.equal(router.resolvePersonaId({ name: 'Vaani' }), 'vaani');
  assert.equal(router.resolvePersonaId({ id: 'emp_f85510806c9de004', name: 'Desk' }), 'vaani');
  assert.equal(router.resolvePersonaId({ id: 'emp_33eae8ef454680f0' }), 'maya');
  assert.equal(router.resolvePersonaId({ name: 'Maya' }), 'maya');
  assert.equal(router.resolvePersonaId({ name: 'Arjun', id: 'emp_other' }), null);
});

test('personaDisplayLabel and public persona never include credentials', () => {
  assert.equal(router.personaDisplayLabel('vaani'), 'Vaani · Natural');
  const pub = router.publicPersona(router.VAANI_PERSONA);
  const blob = JSON.stringify(pub).toLowerCase();
  assert.equal(blob.includes('api_key'), false);
  assert.equal(blob.includes('secret'), false);
  assert.equal(blob.includes('token'), false);
  assert.ok(pub.language_routes['hi-IN']);
  assert.equal(pub.language_routes['hi-IN'].provider, 'sarvam');
});

test('Maya persona map exists for Auto but is marked production_protected', () => {
  const p = router.getPersona('maya');
  assert.equal(p.production_protected, true);
  const r = router.resolvePersonaRoute('maya', 'te-IN', 'astra_auto');
  assert.equal(r.ok, true);
  assert.equal(r.route.provider, 'sarvam');
  // English production-ish route stays Deepgram Helena in the map (draft Auto only).
  const en = router.resolvePersonaRoute('maya', 'en-IN', 'astra_auto');
  assert.equal(en.route.provider, 'deepgram');
  assert.equal(en.route.voice_id, 'aura-2-helena-en');
});

test('getPreviewText returns native-language copy', () => {
  const hi = router.getPreviewText('hi-IN', 'Vaani');
  assert.match(hi, /नमस्ते/);
  assert.match(hi, /Vaani/);
  const te = router.getPreviewText('te-IN', 'Vaani');
  assert.match(te, /నమస్కారం/);
  const en = router.getPreviewText('en-IN', 'Vaani');
  assert.match(en, /Hello/);
});

test('voice-preview: Rumik mode rejects Hindi before upstream call', async () => {
  process.env.RUMIK_API_KEY = process.env.RUMIK_API_KEY || 'rk_test_local';
  delete process.env.RUMIK_NEEDS_FUNDING;
  await assert.rejects(
    () => voicePreview.synthesizePreview({
      provider: 'rumik',
      voice_id: 'speaker_2',
      language: 'hi-IN',
      text: 'नमस्ते',
      persona_id: 'vaani',
    }),
    (err) => err.code === 'provider_language_unsupported' && err.status === 422,
  );
});

test('voice-preview: Auto + Vaani + Telugu resolves Sarvam route without mutating primary language', async () => {
  // Avoid live Sarvam call: expect funding/credentials gate or success shape.
  // Route resolution happens before synthesize; assert via resolvePersonaRoute + applyPreviewLanguage.
  const employee = {
    id: 'emp_f85510806c9de004',
    name: 'Vaani',
    voice: { language: 'en-IN', persona_id: 'vaani' },
  };
  const primaryBefore = employee.voice.language;
  const resolved = router.resolvePersonaRoute('vaani', 'te-IN', 'astra_auto');
  assert.equal(resolved.ok, true);
  assert.equal(resolved.route.provider, 'sarvam');
  assert.equal(resolved.route.voice_id, 'neha');

  // Simulate preview language override isolation.
  const isolation = router.applyPreviewLanguage(employee, 'te-IN');
  assert.equal(isolation.primaryLanguage, 'en-IN');
  assert.equal(employee.voice.language, primaryBefore);

  // If Sarvam is unfunded / unconfigured, synthesizePreview must fail clearly (never fake success).
  delete process.env.SARVAM_API_KEY;
  delete process.env.SARVAM_NEEDS_FUNDING;
  await assert.rejects(
    () => voicePreview.synthesizePreview({
      provider: 'auto',
      language: 'te-IN',
      persona_id: 'vaani',
      employeeId: employee.id,
      findEmployee: (id) => (id === employee.id ? employee : null),
    }),
    (err) => err.code === 'needs_credentials' || err.code === 'needs_funding'
      || err.code === 'voice_unavailable' || err.code === 'audio_generation_failed',
  );
  assert.equal(employee.voice.language, 'en-IN', 'primary language must remain en-IN');
});

test('invalid Auto route with English-only engine for Indic is rejected', () => {
  const bad = {
    persona_id: 'vaani',
    display_name: 'Vaani',
    style: 'natural',
    gender: 'female',
    language_routes: {
      'te-IN': { provider: 'rumik', voice_id: 'speaker_2', model: 'mulberry', language: 'te-IN' },
    },
  };
  // getPersona merges with canonical Vaani when persona_id matches. Use a custom id.
  const custom = {
    persona_id: 'custom_x',
    display_name: 'Custom',
    style: 'natural',
    gender: 'female',
    language_routes: {
      'te-IN': { provider: 'rumik', voice_id: 'speaker_2', model: 'mulberry', language: 'te-IN' },
    },
  };
  const r = router.resolvePersonaRoute(custom, 'te-IN', 'astra_auto');
  assert.equal(r.ok, false);
  assert.equal(r.code, 'invalid_persona_route');
  void bad;
});
