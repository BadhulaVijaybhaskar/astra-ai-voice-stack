/**
 * Platform multilingual runtime tests (P0 language switching).
 * No live provider keys. No PSTN. No Maya-specific hardcodes.
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const multilingual = require('../lib/multilingual-runtime');
const asr = require('../lib/asr-sanity-guard');
const callVoice = require('../lib/call-voice-session');
const personaRouter = require('../lib/voice-persona-router');
const fs = require('fs');
const path = require('path');

test('platform languages are curated EN+Indic (10)', () => {
  assert.equal(multilingual.PLATFORM_LANGUAGE_IDS.length, 10);
  for (const id of ['en-IN', 'hi-IN', 'te-IN', 'ta-IN', 'kn-IN', 'ml-IN', 'mr-IN', 'bn-IN', 'gu-IN', 'pa-IN']) {
    assert.ok(multilingual.PLATFORM_LANGUAGE_IDS.includes(id), id);
  }
});

test('STT enforce stays nova-3-general multi (never Flux)', () => {
  const stt = multilingual.enforceMultilingualStt({
    provider: 'deepgram',
    model: 'flux-general-multi',
    language: 'multi',
  });
  assert.equal(stt.provider, 'deepgram');
  assert.equal(stt.model, 'nova-3-general');
  assert.equal(stt.language, 'multi');
});

test('detect Telugu-first and EN→TE mid-call', () => {
  const te = multilingual.detectLanguageFromTranscript(
    'నమస్కారం, నేను మాయా',
    { allowed_languages: multilingual.PLATFORM_LANGUAGE_IDS, primary_language: 'en-IN' },
  );
  assert.equal(te.language, 'te-IN');
  assert.ok(te.source === 'indic_script');

  const hi = multilingual.detectLanguageFromTranscript(
    'नमस्ते, डेमो शेड्यूल कर सकते हो?',
    { allowed_languages: multilingual.PLATFORM_LANGUAGE_IDS, primary_language: 'en-IN', last_known: 'en-IN' },
  );
  assert.equal(hi.language, 'hi-IN');

  const ta = multilingual.detectLanguageFromTranscript(
    'வணக்கம், நான் உதவ முடியும்',
    { allowed_languages: multilingual.PLATFORM_LANGUAGE_IDS, primary_language: 'en-IN' },
  );
  assert.equal(ta.language, 'ta-IN');
});

test('code-switch TE+EN and HI+EN accepted by ASR guard + detection', () => {
  const mixed = 'Basically hot leads ni sales team ki immediate ga pass cheyyali.';
  const det = multilingual.detectLanguageFromTranscript(mixed, {
    allowed_languages: multilingual.PLATFORM_LANGUAGE_IDS,
    primary_language: 'en-IN',
    last_known: 'en-IN',
  });
  assert.ok(det.language === 'te-IN' || det.language === 'en-IN');
  const guard = asr.evaluateTranscript(mixed, { confidence: 0.8 });
  assert.equal(guard.action, 'accept');

  const teEn = asr.evaluateTranscript(asr.QA_FIXTURES.telugu_mixed, { confidence: 0.7 });
  assert.equal(teEn.action, 'accept');
  assert.equal(teEn.has_indic_script, true);

  const hiEn = asr.evaluateTranscript(asr.QA_FIXTURES.hindi_booking, { confidence: 0.8 });
  assert.equal(hiEn.action, 'accept');
});

test('ASR guard accepts Tamil/Kannada scripts and short ji', () => {
  assert.equal(asr.hasIndicScript('வணக்கம்'), true);
  assert.equal(asr.hasIndicScript('ನಮಸ್ಕಾರ'), true);
  const ji = asr.evaluateTranscript('ji', { confidence: 0.9 });
  assert.equal(ji.action, 'accept');
});

test('response language follows caller; recovery never empty', () => {
  const det = multilingual.detectLanguageFromTranscript('ఎలా ఉంది?', {
    allowed_languages: ['en-IN', 'te-IN', 'hi-IN'],
    primary_language: 'en-IN',
  });
  const resp = multilingual.selectResponseLanguage(det, {
    allowed_languages: ['en-IN', 'te-IN', 'hi-IN'],
    primary_language: 'en-IN',
    last_known: 'en-IN',
  });
  assert.equal(resp.response_language, 'te-IN');
  const line = multilingual.recoveryPrompt('te-IN');
  assert.ok(line && line.length > 5);
  assert.ok(/మళ్లీ|క్షమించండి/.test(line));
});

test('primary_language + allowed_languages never null on session', () => {
  callVoice.clearAllCallVoiceSessions();
  const emp = {
    id: 'emp_test_multi',
    name: 'Test Employee',
    voice: {
      language: 'te-IN',
      languageVoiceConfig: {
        'en-IN': { voice_id: 'priya', speed: 1 },
        'te-IN': { voice_id: 'priya', speed: 1.1 },
        'hi-IN': { voice_id: 'priya', speed: 1 },
      },
    },
  };
  const s = callVoice.startCallVoiceSession({
    employee: emp,
    persona: 'vaani',
    language: 'te-IN',
    mode: 'astra_auto',
  });
  assert.equal(s.ok, true);
  assert.equal(s.primary_language, 'te-IN');
  assert.ok(Array.isArray(s.allowed_languages) && s.allowed_languages.length >= 2);
  assert.ok(s.allowed_languages.includes('te-IN'));
  assert.ok(s.allowed_languages.includes('en-IN'));
  assert.equal(s.tts_language, 'te-IN');
  assert.equal(s.stt.language, 'multi');
});

test('locked Sarvam speaker: mid-call EN↔TE keeps UI-selected Tanya (no priya freeze)', () => {
  callVoice.clearAllCallVoiceSessions();
  const emp = {
    id: 'emp_ui',
    name: 'Any Employee',
    voice: {
      language: 'te-IN',
      languageVoiceConfig: {
        'en-IN': { voice_id: 'tanya', speed: 1 },
        'te-IN': { voice_id: 'tanya', speed: 1.1 },
      },
    },
  };
  // Maya persona must behave like any other: UI Tanya wins (no production_protected→priya).
  const started = callVoice.startCallVoiceSession({
    employee: emp,
    persona: 'maya',
    language: 'te-IN',
    forceLocked: true,
  });
  assert.equal(started.ok, true);
  assert.equal(started.voice_lock.provider, 'sarvam');
  assert.equal(started.voice_lock.speaker, 'tanya');
  assert.equal(started.current_language, 'te-IN');

  const toEn = callVoice.applyCallLanguage(started.call_session_id, 'en-IN');
  assert.equal(toEn.ok, true);
  assert.equal(toEn.voice_lock.speaker, 'tanya');
  assert.equal(toEn.current_language, 'en-IN');
  assert.equal(toEn.tts_language, 'en-IN');
  assert.equal(toEn.speaker_unchanged, true);

  const backTe = callVoice.applyCallLanguage(started.call_session_id, 'te-IN');
  assert.equal(backTe.ok, true);
  assert.equal(backTe.voice_lock.speaker, 'tanya');
  assert.equal(backTe.current_language, 'te-IN');
});

test('UI-selected Rumik speaker is locked as-is (no silent Sarvam remount)', () => {
  const lock = personaRouter.createSessionVoiceLock({
    employee: {
      id: 'emp_vaani_like',
      voice: {
        language: 'en-IN',
        languageVoiceConfig: {
          'en-IN': { voice_id: 'speaker_2', provider: 'rumik', speed: 1 },
          'te-IN': { voice_id: 'neha', speed: 1 },
          'hi-IN': { voice_id: 'priya', speed: 1 },
        },
      },
    },
    persona: 'vaani',
    language: 'en-IN',
    mode: 'astra_auto',
  });
  assert.equal(lock.ok, true);
  assert.equal(lock.source, 'language_voice_config');
  assert.equal(lock.voice_lock.provider, 'rumik');
  assert.equal(lock.voice_lock.speaker, 'speaker_2');
  // Mid-call TE fails under locked policy — do not silently swap to neha/priya.
  const mid = personaRouter.resolveLockedVoice(lock.voice_lock, 'te-IN', { policy: 'locked' });
  assert.equal(mid.ok, false);
  assert.equal(mid.code, 'locked_voice_language_unsupported');
  assert.ok(lock.multilingual_compat);
  assert.equal(lock.multilingual_compat.speaker_compatible, false);
});

test('Dograh language=multi must NOT use Flux (overlay ban)', () => {
  const factory = fs.readFileSync(
    path.join(__dirname, '..', '..', 'rumik-overlay-local', 'service_factory.py'),
    'utf8',
  );
  assert.ok(/if language == "multi":\s*\n\s*return False/.test(factory)
    || /language == "multi"[\s\S]{0,80}return False/.test(factory));
  assert.ok(/nova-3-general/.test(factory));
});

test('processUserTurn exposes turn observability fields', () => {
  const turn = multilingual.processUserTurn('ఇది ఎలా పని చేస్తుంది?', {
    employee: {
      voice: {
        language: 'en-IN',
        languageVoiceConfig: { 'en-IN': { voice_id: 'priya' }, 'te-IN': { voice_id: 'priya' } },
      },
    },
    confidence: 0.85,
  });
  assert.equal(turn.detected_language, 'te-IN');
  assert.equal(turn.response_language, 'te-IN');
  assert.equal(turn.llm_input_allowed, true);
  assert.ok(turn.primary_language);
  assert.ok(Array.isArray(turn.allowed_languages));
  assert.equal(turn.stt.language, 'multi');
});
