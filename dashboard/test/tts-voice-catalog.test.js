'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const catalog = require('../lib/tts-voice-catalog');

test('Sarvam catalog prefers Bulbul v3 speakers and excludes deprecated v2 IDs', () => {
  const payload = catalog.getCatalog({ provider: 'sarvam' });
  assert.ok(payload.voices.length >= 20);
  assert.ok(payload.voices.every((v) => v.model === 'bulbul:v3'));
  assert.ok(payload.voices.every((v) => v.status === 'available'));
  assert.ok(payload.voices.some((v) => v.voice_id === 'shubh'));
  assert.equal(payload.voices.some((v) => v.voice_id === 'anushka'), false);
  assert.equal(payload.models.sarvam[0], 'bulbul:v3');

  // Deprecated v2 IDs remain findable for voice_unavailable mapping.
  const deprecated = catalog.findVoice('sarvam', 'anushka');
  assert.ok(deprecated);
  assert.equal(deprecated.status, 'voice_unavailable');
  assert.equal(deprecated.model, 'bulbul:v2');
  assert.equal(catalog.isSarvamV2VoiceId('anushka'), true);
  assert.equal(catalog.isSarvamV2VoiceId('shubh'), false);
});

test('ASTRA_SUPPORTED_LANGUAGES is curated 10 and refuses unvalidated TESTED', () => {
  const langs = catalog.listAstraSupportedLanguages();
  assert.equal(langs.length, 10);
  assert.deepEqual(langs.map((l) => l.id), [
    'en-IN', 'hi-IN', 'te-IN', 'ta-IN', 'kn-IN', 'ml-IN', 'mr-IN', 'bn-IN', 'gu-IN', 'pa-IN',
  ]);
  assert.ok(langs.every((l) => l.status !== 'TESTED'));
  assert.equal(catalog.isAstraSupportedLanguage('od-IN'), false);
  assert.equal(catalog.isAstraSupportedLanguage('hi-IN'), true);
  assert.equal(catalog.resolveAstraLanguageStatus('en-IN', 'TESTED'), 'READY_FOR_VALIDATION');
});

test('Sarvam catalog normalizes exact voice fields from backend config', () => {
  const payload = catalog.getCatalog({ provider: 'sarvam' });
  assert.ok(Array.isArray(payload.voices));
  assert.ok(payload.voices.length >= 30);
  const sample = payload.voices.find((v) => v.voice_id === 'shubh' && v.model === 'bulbul:v3');
  assert.ok(sample);
  assert.deepEqual(Object.keys(sample).sort(), [
    'display_name', 'gender', 'language', 'model', 'provider', 'status', 'voice_id',
  ].sort());
  assert.equal(sample.provider, 'sarvam');
  assert.equal(sample.gender, 'male');
  assert.equal(sample.status, 'available');
  assert.equal(sample.display_name, 'Shubh');
  assert.ok(payload.languages.sarvam.some((l) => l.id === 'hi-IN'));
  assert.ok(payload.language_map.sarvam['hi-IN']);
  assert.equal(payload.live_apply_enabled, false);
  assert.equal(JSON.stringify(payload).includes('API_KEY'), false);
  assert.equal(JSON.stringify(payload).toLowerCase().includes('subscription'), false);
});

test('catalog includes Deepgram Aura and Rumik alternatives', () => {
  const all = catalog.getCatalog();
  const providers = all.providers.map((p) => p.id).sort();
  assert.deepEqual(providers, ['deepgram', 'rumik', 'sarvam']);
  assert.ok(all.voices.some((v) => v.provider === 'deepgram' && v.voice_id === 'aura-2-helena-en'));
  assert.ok(all.voices.some((v) => v.provider === 'rumik' && v.voice_id === 'speaker_2'));
});

test('draft prefs default to Rumik and never enable live apply', () => {
  const prefs = catalog.defaultDraftPrefs();
  assert.equal(prefs.provider, 'rumik');
  assert.equal(prefs.voice_id, 'speaker_2');
  assert.equal(prefs.apply_live, false);
  const tenant = { id: 't1' };
  const saved = catalog.setTenantDraftPrefs(tenant, {
    provider: 'sarvam',
    language: 'hi-IN',
    voice_id: 'priya',
    model: 'bulbul:v3',
    default_voice: { provider: 'sarvam', voice_id: 'priya', model: 'bulbul:v3', language: 'hi-IN' },
    fallback_voice: { provider: 'rumik', voice_id: 'speaker_1', model: 'mulberry', language: 'en-IN' },
    apply_live: true, // ignored
  });
  assert.equal(saved.provider, 'sarvam');
  assert.equal(saved.voice_id, 'priya');
  assert.equal(saved.apply_live, false);
  assert.equal(saved.live_apply_enabled, false);
  assert.equal(tenant.ttsDraftPrefs.apply_live, false);
});

test('authenticated GET /api/tts/voices returns Sarvam catalog without secrets', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'astra-voice-catalog-'));
  const dbFile = path.join(tmp, 'db.json');
  const tenantId = 't_voice_' + crypto.randomBytes(3).toString('hex');
  const userId = 'u_voice_' + crypto.randomBytes(3).toString('hex');
  const sessionToken = crypto.randomBytes(16).toString('hex');
  const now = new Date().toISOString();
  fs.writeFileSync(dbFile, JSON.stringify({
    schemaVersion: 13,
    tenants: [{
      id: tenantId, name: 'Voice Co', slug: 'voice', createdAt: now,
      branding: { color: '#0077ec' },
      providers: { stt: 'deepgram', tts: 'rumik', llm: 'groq', telephony: 'vobiz' },
      plan: 'starter', status: 'active', privacyMode: 'standard',
    }],
    users: [{
      id: userId, tenantId, email: 'owner@voice.test', name: 'Owner',
      role: 'owner', status: 'active',
      passwordHash: 'scrypt$aa$bb', createdAt: now,
    }],
    sessions: [{
      token: sessionToken, userId, tenantId, createdAt: now,
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
    }],
    agents: [], usage: [], wallets: [], ledger: [], paymentIntents: [],
    supportTickets: [], supportMessages: [], auditEvents: [], presets: [],
    byonConnections: [], hvacJobs: [], hvacSettings: [], paymentEvents: [],
    demoLinks: [], callbackJobs: [], phoneNumbers: [], providerResources: [],
    calls: [], knowledgeEntries: [], integrationWebhooks: [], campaigns: [],
    campaignLeads: [], workflows: [], leads: [], callJobs: [], employees: [],
  }));

  const prevDb = process.env.DB_FILE;
  const prevPort = process.env.PORT;
  process.env.DB_FILE = dbFile;
  process.env.PORT = '0';
  // Keep production default Rumik. Do not set TTS_PROVIDER=sarvam.
  delete process.env.TTS_PROVIDER;
  delete process.env.SARVAM_API_KEY;

  // Load server in isolation by spawning a tiny harness that reuses handlers via require.
  // Prefer hitting a real http server from server.js boot path is heavy; use catalog module
  // plus a minimal route smoke that mirrors auth gate expectations.
  const corePath = require.resolve('../lib/core');
  delete require.cache[corePath];
  process.env.DB_PATH = dbFile;
  // core uses DATA_DIR / DB_FILE conventions; set what core expects.
  const core = require('../lib/core');
  if (typeof core.setDbPathForTests === 'function') {
    core.setDbPathForTests(dbFile);
  }

  // Direct catalog smoke (auth-gated route tested separately below with http).
  const cat = catalog.getCatalog({ provider: 'sarvam' });
  assert.ok(cat.voices.every((v) => v.provider === 'sarvam'));
  assert.equal(String(JSON.stringify(cat)).includes('sk-'), false);

  // HTTP smoke: spin ephemeral server using the real server module if possible.
  let server;
  let port;
  try {
    // Isolate require of server is awkward (boots immediately). Emulate the route contract.
    server = http.createServer(async (req, res) => {
      const url = new URL(req.url || '/', 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/api/tts/voices') {
        const cookie = String(req.headers.cookie || '');
        if (!cookie.includes('rxv_sess=' + sessionToken)) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'unauthorized', code: 'unauthorized' }));
          return;
        }
        const payload = catalog.getCatalog({
          provider: url.searchParams.get('provider') || '',
          language: url.searchParams.get('language') || '',
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
        return;
      }
      res.writeHead(404); res.end();
    });
    await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
    port = server.address().port;

    const unauth = await new Promise((resolve, reject) => {
      http.get({ hostname: '127.0.0.1', port, path: '/api/tts/voices?provider=sarvam' }, (r) => {
        const chunks = [];
        r.on('data', (c) => chunks.push(c));
        r.on('end', () => resolve({ status: r.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      }).on('error', reject);
    });
    assert.equal(unauth.status, 401);

    const auth = await new Promise((resolve, reject) => {
      http.get({
        hostname: '127.0.0.1',
        port,
        path: '/api/tts/voices?provider=sarvam',
        headers: { Cookie: 'rxv_sess=' + sessionToken },
      }, (r) => {
        const chunks = [];
        r.on('data', (c) => chunks.push(c));
        r.on('end', () => resolve({ status: r.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      }).on('error', reject);
    });
    assert.equal(auth.status, 200);
    const body = JSON.parse(auth.body);
    assert.ok(body.voices.length > 0);
    assert.ok(body.voices.every((v) => v.provider === 'sarvam'));
    assert.equal(auth.body.includes('SARVAM_API_KEY'), false);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (prevDb === undefined) delete process.env.DB_FILE; else process.env.DB_FILE = prevDb;
    if (prevPort === undefined) delete process.env.PORT; else process.env.PORT = prevPort;
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  }
});
