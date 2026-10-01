/**
 * Call-level voice lock + languageVoiceConfig tests.
 *
 * Validation matrix:
 *   INITIAL LANGUAGE ROUTING
 *   SESSION VOICE LOCK
 *   MID-CALL LANGUAGE SWITCH
 *   SPEAKER STAYS SAME
 *   NEW CALL MAY PICK NEW VOICE
 *   BROWSER/PSTN SAME LOGIC
 *   CUSTOMER PREFERRED LANGUAGE REUSED
 *   languageVoiceConfig save (preview text never persisted)
 *
 * No live TTS keys. No PSTN dials. Maya WF8 untouched.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const router = require('../lib/voice-persona-router');
const callVoice = require('../lib/call-voice-session');
const employees = require('../lib/employees');

function freshDb() {
  return {
    employees: [],
    agents: [],
    workflows: [],
    calls: [],
    leads: [],
    phoneNumbers: [],
    knowledge: [],
  };
}

test('INITIAL LANGUAGE ROUTING: Vaani Telugu starts on Sarvam neha and locks', () => {
  const started = router.createSessionVoiceLock({
    employee: { id: 'emp_f85510806c9de004', name: 'Vaani', voice: { language: 'te-IN', persona_id: 'vaani' } },
    language: 'te-IN',
    mode: 'astra_auto',
  });
  assert.equal(started.ok, true);
  assert.equal(started.initial_language, 'te-IN');
  assert.equal(started.voice_lock.provider, 'sarvam');
  assert.equal(started.voice_lock.speaker, 'neha');
  assert.equal(started.voice_lock.persona, 'vaani');
  assert.equal(started.voice_switch_policy, 'locked');
  assert.equal(started.route_semantics, 'call_start_only');
});

test('SESSION VOICE LOCK: Hindi start locks priya; English multilingual locks Sarvam (not Rumik)', () => {
  const hi = router.createSessionVoiceLock({
    persona: 'vaani', language: 'hi-IN', mode: 'astra_auto',
  });
  assert.equal(hi.voice_lock.speaker, 'priya');
  assert.equal(hi.voice_lock.provider, 'sarvam');

  // Vaani allows Indic languages via persona routes. EN start must lock a
  // Sarvam speaker so mid-call language_code (EN↔TE/HI) works under locked policy.
  // Do NOT lock Rumik speaker_2 (English-only → Indic silence).
  const en = router.createSessionVoiceLock({
    persona: 'vaani', language: 'en-IN', mode: 'astra_auto',
  });
  assert.equal(en.voice_lock.provider, 'sarvam');
  assert.ok(en.voice_lock.speaker);
  const mid = router.resolveLockedVoice(en.voice_lock, 'te-IN', { voice_switch_policy: 'locked' });
  assert.equal(mid.ok, true);
  assert.equal(mid.language, 'te-IN');
  assert.equal(mid.speaker_unchanged, true);
});

test('MID-CALL LANGUAGE SWITCH + SPEAKER STAYS SAME: Sarvam lock keeps speaker', () => {
  const started = router.createSessionVoiceLock({
    persona: 'vaani', language: 'te-IN', mode: 'astra_auto',
  });
  const mid = router.resolveLockedVoice(started.voice_lock, 'hi-IN', {
    voice_switch_policy: 'locked',
  });
  assert.equal(mid.ok, true);
  assert.equal(mid.speaker_unchanged, true);
  assert.equal(mid.provider_unchanged, true);
  assert.equal(mid.route.provider, 'sarvam');
  assert.equal(mid.route.voice_id, 'neha');
  assert.equal(mid.route.language, 'hi-IN');
  assert.equal(mid.source, 'voice_lock');
});

test('locked_voice_language_unsupported: Rumik lock cannot speak Hindi', () => {
  // Explicit Rumik lock (English-only employee / forced provider). Multilingual
  // Vaani Auto no longer creates Rumik locks at EN start.
  const rumikLock = {
    provider: 'rumik',
    speaker: 'speaker_2',
    model: 'mulberry',
    persona: 'vaani',
  };
  const mid = router.resolveLockedVoice(rumikLock, 'hi-IN', {
    voice_switch_policy: 'locked',
  });
  assert.equal(mid.ok, false);
  assert.equal(mid.code, 'locked_voice_language_unsupported');
  assert.equal(mid.voice_lock.speaker, 'speaker_2');
  assert.equal(mid.voice_lock.provider, 'rumik');
});

test('NEW CALL MAY PICK NEW VOICE: Call A te→neha, Call B hi→priya, Call C ta→ishita', () => {
  const a = router.createSessionVoiceLock({ persona: 'vaani', language: 'te-IN' });
  const b = router.createSessionVoiceLock({ persona: 'vaani', language: 'hi-IN' });
  const c = router.createSessionVoiceLock({ persona: 'vaani', language: 'ta-IN' });
  assert.equal(a.voice_lock.speaker, 'neha');
  assert.equal(b.voice_lock.speaker, 'priya');
  assert.equal(c.voice_lock.speaker, 'ishita');
  // Locks are independent session objects.
  assert.notEqual(a.voice_lock.speaker, b.voice_lock.speaker);
});

test('BROWSER/PSTN SAME LOGIC: resolveChannelVoice matches createSessionVoiceLock', () => {
  callVoice.clearAllCallVoiceSessions();
  const employee = {
    id: 'emp_f85510806c9de004',
    name: 'Vaani',
    voice: { language: 'hi-IN', persona_id: 'vaani' },
  };
  const browser = callVoice.resolveChannelVoice({
    employee, channel: 'browser', language: 'hi-IN', mode: 'astra_auto',
  });
  const inbound = callVoice.resolveChannelVoice({
    employee, channel: 'inbound_pstn', language: 'hi-IN', mode: 'astra_auto',
  });
  const outbound = callVoice.resolveChannelVoice({
    employee, channel: 'outbound_pstn', language: 'hi-IN', mode: 'astra_auto',
  });
  assert.equal(browser.ok, true);
  assert.equal(inbound.ok, true);
  assert.equal(outbound.ok, true);
  assert.deepEqual(browser.voice_lock, inbound.voice_lock);
  assert.deepEqual(browser.voice_lock, outbound.voice_lock);
  assert.equal(browser.voice_lock.speaker, 'priya');
  assert.deepEqual(browser.same_logic_as, ['browser', 'inbound_pstn', 'outbound_pstn']);
});

test('CUSTOMER PREFERRED LANGUAGE REUSED: seeds start only, not voice_lock across calls', () => {
  callVoice.clearAllCallVoiceSessions();
  const employee = {
    id: 'emp_f85510806c9de004',
    name: 'Vaani',
    voice: { language: 'en-IN', persona_id: 'vaani' },
  };
  const call1 = callVoice.startCallVoiceSession({
    employee,
    preferred_language: 'te-IN',
    channel: 'browser',
  });
  assert.equal(call1.ok, true);
  assert.equal(call1.initial_language, 'te-IN');
  assert.equal(call1.voice_lock.speaker, 'neha');

  const ended = callVoice.endCallVoiceSession(call1.call_session_id, {
    detected_language: 'hi-IN',
  });
  assert.equal(ended.voice_lock_persisted, false);
  assert.equal(ended.preferred_language_for_next_call, 'hi-IN');

  // Next call uses preferred_language hint only. New lock may differ.
  const call2 = callVoice.startCallVoiceSession({
    employee,
    preferred_language: ended.preferred_language_for_next_call,
    channel: 'outbound_pstn',
  });
  assert.equal(call2.initial_language, 'hi-IN');
  assert.equal(call2.voice_lock.speaker, 'priya');
  assert.notEqual(call1.call_session_id, call2.call_session_id);
  callVoice.endCallVoiceSession(call2.call_session_id);
});

test('call session applyCallLanguage keeps speaker under locked policy', () => {
  callVoice.clearAllCallVoiceSessions();
  const s = callVoice.startCallVoiceSession({
    persona: 'vaani',
    language: 'ta-IN',
    channel: 'browser',
  });
  const mid = callVoice.applyCallLanguage(s.call_session_id, 'kn-IN');
  assert.equal(mid.ok, true);
  assert.equal(mid.speaker_unchanged, true);
  assert.equal(mid.voice_lock.speaker, 'ishita');
  assert.equal(mid.current_language, 'kn-IN');
  callVoice.endCallVoiceSession(s.call_session_id);
});

test('Maya default policy is locked; production_protected freezes Sarvam priya', () => {
  assert.equal(router.normalizeVoiceSwitchPolicy(undefined, { personaId: 'maya' }), 'locked');
  const started = router.createSessionVoiceLock({
    persona: 'maya', language: 'en-IN', mode: 'astra_auto',
  });
  assert.equal(started.voice_switch_policy, 'locked');
  // Investor freeze: Maya production TTS is Sarvam bulbul:v3 priya (not Deepgram Helena,
  // not languageVoiceConfig tanya). Mid-call only updates language_code.
  assert.equal(started.voice_lock.provider, 'sarvam');
  assert.equal(started.voice_lock.speaker, 'priya');
  const mid = router.resolveLockedVoice(started.voice_lock, 'te-IN', { policy: 'locked' });
  assert.equal(mid.ok, true);
  assert.equal(mid.language, 'te-IN');
  assert.equal(mid.speaker_unchanged, true);
  assert.equal(mid.route.voice_id, 'priya');
});

test('languageVoiceConfig overrides persona starting route; preview text never saved', () => {
  const db = freshDb();
  db.employees.push({
    id: 'emp_f85510806c9de004',
    tenantId: 't_a',
    name: 'Vaani',
    status: 'ACTIVE',
    voice: { language: 'en-IN', persona_id: 'vaani', speaker: 'speaker_2' },
    knowledgeIds: [],
    outcomes: [],
    actions: [],
  });
  const saved = employees.setEmployeeLanguageVoiceConfig(db, 't_a', 'emp_f85510806c9de004', {
    language: 'hi-IN',
    languageVoiceConfig: {
      'en-IN': { voice_id: 'priya', speed: 1.0, preview_text: 'SHOULD_NOT_SAVE' },
      'hi-IN': { voice_id: 'priya', speed: 0.95, test_text: 'nope' },
      'te-IN': { voice_id: 'neha', speed: 1.0 },
    },
  });
  assert.equal(saved.ok, true);
  assert.equal(saved.preview_text_saved, false);
  assert.equal(saved.language, 'hi-IN');
  assert.equal(saved.languageVoiceConfig['en-IN'].voice_id, 'priya');
  assert.equal(saved.languageVoiceConfig['hi-IN'].speed, 0.95);
  assert.equal(saved.languageVoiceConfig['en-IN'].preview_text, undefined);
  assert.equal(saved.languageVoiceConfig['hi-IN'].test_text, undefined);

  const pub = employees.publicEmployee(saved.employee, db);
  assert.equal(pub.voice.languageVoiceConfig['te-IN'].voice_id, 'neha');
  const blob = JSON.stringify(pub.voice.languageVoiceConfig);
  assert.equal(blob.includes('SHOULD_NOT_SAVE'), false);
  assert.equal(blob.includes('preview_text'), false);

  // Call start uses languageVoiceConfig over persona Rumik English route.
  const lock = router.createSessionVoiceLock({
    employee: saved.employee,
    language: 'en-IN',
    mode: 'astra_auto',
  });
  assert.equal(lock.ok, true);
  assert.equal(lock.source, 'language_voice_config');
  assert.equal(lock.voice_lock.speaker, 'priya');
  assert.equal(lock.voice_lock.provider, 'sarvam');
});

test('Maya production persona map English Deepgram Helena unchanged in Auto catalog', () => {
  const en = router.resolvePersonaRoute('maya', 'en-IN', 'astra_auto');
  assert.equal(en.route.provider, 'deepgram');
  assert.equal(en.route.voice_id, 'aura-2-helena-en');
  const hi = router.resolvePersonaRoute('maya', 'hi-IN', 'astra_auto');
  assert.equal(hi.route.voice_id, 'priya');
  assert.equal(router.getPersona('maya').production_protected, true);
});

test('debugRouteSummary marks routes as call start only', () => {
  const rows = router.debugRouteSummary('vaani');
  assert.ok(rows.some((r) => /call start/.test(r.summary)));
});

test('PER-LANGUAGE VOICE SELECTOR: compatibleVoicesForLanguage filters by language', () => {
  const hi = router.compatibleVoicesForLanguage('hi-IN');
  assert.ok(hi.length > 0);
  assert.ok(hi.some((v) => v.voice_id === 'priya'));
  // English-only Rumik speakers must not appear for Hindi.
  assert.equal(hi.some((v) => v.voice_id === 'speaker_2'), false);
  const en = router.compatibleVoicesForLanguage('en-IN');
  assert.ok(en.some((v) => v.voice_id === 'priya' || v.voice_id === 'speaker_2' || v.voice_id === 'aura-2-helena-en'));
  // Public-facing fields omit provider brand as a required picker field.
  assert.ok(hi.every((v) => v.voice_id && v.display_name));
});

test('PER-LANGUAGE SPEED: languageVoiceConfig speed is locked at call start', () => {
  const employee = {
    id: 'emp_f85510806c9de004',
    name: 'Vaani',
    voice: {
      language: 'hi-IN',
      languageVoiceConfig: {
        'hi-IN': { voice_id: 'priya', speed: 0.95 },
        'te-IN': { voice_id: 'neha', speed: 1.1 },
      },
    },
  };
  const started = router.createSessionVoiceLock({ employee, language: 'hi-IN' });
  assert.equal(started.ok, true);
  assert.equal(started.voice_lock.speaker, 'priya');
  assert.equal(started.voice_lock.speed, 0.95);
  const mid = router.resolveLockedVoice(started.voice_lock, 'te-IN');
  assert.equal(mid.ok, true);
  assert.equal(mid.speed_unchanged, true);
  assert.equal(mid.route.speed, 0.95);
  assert.equal(mid.route.voice_id, 'priya'); // do NOT re-read te-IN neha
});

test('NATIVE PREVIEW samples exist for all Astra languages', () => {
  for (const lang of ['en-IN', 'hi-IN', 'te-IN', 'ta-IN', 'kn-IN', 'ml-IN', 'mr-IN', 'bn-IN', 'gu-IN', 'pa-IN']) {
    const text = router.getPreviewText(lang, 'Maya');
    assert.ok(text && text.length <= 500, lang);
    assert.match(text, /Maya/);
  }
});

test('SAVE/RELOAD + RESTART PERSISTENCE: languageVoiceConfig survives db round-trip', () => {
  const db = freshDb();
  db.employees.push({
    id: 'emp_f85510806c9de004',
    tenantId: 't_a',
    name: 'Vaani',
    status: 'ACTIVE',
    voice: { language: 'en-IN' },
    knowledgeIds: [],
    outcomes: [],
    actions: [],
  });
  const saved = employees.setEmployeeLanguageVoiceConfig(db, 't_a', 'emp_f85510806c9de004', {
    language: 'te-IN',
    languageVoiceConfig: {
      'en-IN': { voice_id: 'priya', speed: 1 },
      'te-IN': { voice_id: 'neha', speed: 1.05 },
    },
  });
  assert.equal(saved.ok, true);
  // Simulate restart: re-read employee row from db.
  const reloaded = employees.findEmployee(db, 't_a', 'emp_f85510806c9de004');
  assert.equal(reloaded.voice.languageVoiceConfig['te-IN'].voice_id, 'neha');
  assert.equal(reloaded.voice.languageVoiceConfig['te-IN'].speed, 1.05);
  // Public payload hides internal provider fields.
  const pub = employees.publicEmployee(reloaded, db);
  assert.equal(pub.voice.languageVoiceConfig['te-IN'].provider, undefined);
  assert.equal(pub.voice.languageVoiceConfig['te-IN'].model, undefined);
  // Internal row may keep provider for call-start resolution.
  assert.ok(reloaded.voice.languageVoiceConfig['te-IN'].provider === 'sarvam'
    || reloaded.voice.languageVoiceConfig['te-IN'].voice_id === 'neha');
});

test('CALL-START VOICE RESOLUTION uses languageVoiceConfig then locks speed', () => {
  const employee = {
    id: 'emp_f85510806c9de004',
    name: 'Vaani',
    voice: {
      language: 'ta-IN',
      languageVoiceConfig: {
        'ta-IN': { voice_id: 'ishita', speed: 0.9, provider: 'sarvam', model: 'bulbul:v3' },
      },
    },
  };
  const started = callVoice.startCallVoiceSession({
    employee, language: 'ta-IN', channel: 'browser',
  });
  assert.equal(started.voice_lock.speaker, 'ishita');
  assert.equal(started.voice_lock.speed, 0.9);
  const vars = callVoice.voiceLockContextVariables(started);
  assert.equal(vars.astra_tts_voice, 'ishita');
  assert.equal(vars.astra_tts_speed, '0.9');
  assert.equal(vars.astra_voice_lock_speed, '0.9');
  callVoice.endCallVoiceSession(started.call_session_id);
});

test('SESSION VOICE LOCK does not re-read another language config mid-call', () => {
  const employee = {
    id: 'emp_f85510806c9de004',
    name: 'Vaani',
    voice: {
      language: 'hi-IN',
      languageVoiceConfig: {
        'hi-IN': { voice_id: 'priya', speed: 0.95 },
        'te-IN': { voice_id: 'neha', speed: 1.2 },
      },
    },
  };
  const s = callVoice.startCallVoiceSession({ employee, language: 'hi-IN', channel: 'browser' });
  const mid = callVoice.applyCallLanguage(s.call_session_id, 'te-IN');
  assert.equal(mid.ok, true);
  assert.equal(mid.voice_lock.speaker, 'priya');
  assert.equal(mid.voice_lock.speed, 0.95);
  assert.notEqual(mid.voice_lock.speaker, 'neha');
  callVoice.endCallVoiceSession(s.call_session_id);
});

test('DEFAULT MAYA: seed draft from persona without overwriting existing or production', () => {
  const db = freshDb();
  db.employees.push({
    id: 'emp_33eae8ef454680f0',
    tenantId: 't_a',
    name: 'Maya',
    status: 'ACTIVE',
    voice: { language: 'en-IN' },
    knowledgeIds: [],
    outcomes: [],
    actions: [],
  });
  const seeded = employees.setEmployeeLanguageVoiceConfig(db, 't_a', 'emp_33eae8ef454680f0', {
    seed_from_persona: true,
  });
  assert.equal(seeded.ok, true);
  assert.equal(seeded.seeded, true);
  assert.equal(seeded.production_protected, true);
  assert.ok(seeded.languageVoiceConfig['hi-IN']);
  assert.equal(seeded.languageVoiceConfig['hi-IN'].voice_id, 'priya');
  // Second seed does not overwrite.
  const again = employees.setEmployeeLanguageVoiceConfig(db, 't_a', 'emp_33eae8ef454680f0', {
    seed_from_persona: true,
  });
  assert.equal(again.seeded, false);
  assert.equal(again.reason, 'already_configured');
});

test('PER-ROW merge save patches one language only', () => {
  const db = freshDb();
  db.employees.push({
    id: 'emp_f85510806c9de004',
    tenantId: 't_a',
    name: 'Vaani',
    status: 'ACTIVE',
    voice: {
      language: 'en-IN',
      languageVoiceConfig: {
        'en-IN': { voice_id: 'priya', speed: 1 },
        'hi-IN': { voice_id: 'priya', speed: 1 },
      },
    },
    knowledgeIds: [],
    outcomes: [],
    actions: [],
  });
  const patched = employees.setEmployeeLanguageVoiceConfig(db, 't_a', 'emp_f85510806c9de004', {
    merge: true,
    language: 'hi-IN',
    voice_id: 'suhani',
    speed: 0.85,
  });
  assert.equal(patched.ok, true);
  assert.equal(patched.languageVoiceConfig['hi-IN'].voice_id, 'suhani');
  assert.equal(patched.languageVoiceConfig['hi-IN'].speed, 0.85);
  assert.equal(patched.languageVoiceConfig['en-IN'].voice_id, 'priya');
});
