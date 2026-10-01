'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const path = require('path');
const os = require('os');

const voicePreview = require('../lib/voice-preview');
const unified = require('../lib/voice-catalog');

const providersPath = require.resolve('../lib/providers');
const corePath = require.resolve('../lib/core');
const originalEnv = { ...process.env };

function resetEnv(values = {}) {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv, values);
}

function loadProviders(httpsPost) {
  delete require.cache[providersPath];
  delete require.cache[corePath];
  delete require.cache[require.resolve('../lib/voice-preview')];
  delete require.cache[require.resolve('../lib/voice-catalog')];
  delete require.cache[require.resolve('../lib/tts-voice-catalog')];
  const core = require(corePath);
  if (httpsPost) core.httpsPost = httpsPost;
  require.cache[corePath].exports = core;
  // Re-require voice-preview after providers so it sees mocked HTTP.
  require(providersPath);
  return require('../lib/voice-preview');
}

test.afterEach(() => {
  resetEnv();
  delete require.cache[providersPath];
  delete require.cache[corePath];
  delete require.cache[require.resolve('../lib/voice-preview')];
});

function tinyWav() {
  // Minimal RIFF WAVE header + 2 bytes of silence.
  const buf = Buffer.alloc(46);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(38, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(24000, 24);
  buf.writeUInt32LE(48000, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(2, 40);
  buf.writeInt16LE(0, 44);
  return buf;
}

test('funding gate blocks Sarvam and Rumik preview before upstream call', async () => {
  process.env.SARVAM_API_KEY = 'sk_test';
  process.env.SARVAM_NEEDS_FUNDING = '1';
  process.env.RUMIK_API_KEY = 'rk_test';
  process.env.RUMIK_NEEDS_FUNDING = '1';
  process.env.DEEPGRAM_API_KEY = 'dg_test';

  const sarvam = unified.resolveProviderState('sarvam');
  assert.equal(sarvam.state, 'needs_funding');
  assert.equal(sarvam.can_preview, false);

  const rumik = unified.resolveProviderState('rumik');
  assert.equal(rumik.state, 'needs_funding');
  assert.equal(rumik.can_preview, false);

  await assert.rejects(
    () => voicePreview.synthesizePreview({
      provider: 'sarvam',
      voice_id: 'shubh',
      language: 'te-IN',
      text: 'Hello, this is a preview from Astra Voice.',
    }),
    (err) => err.code === 'needs_funding' && err.status === 402,
  );

  await assert.rejects(
    () => voicePreview.synthesizePreview({
      provider: 'rumik',
      voice_id: 'speaker_1',
      language: 'en-IN',
    }),
    (err) => err.code === 'needs_funding',
  );

  const pub = voicePreview.publicPreviewError(new voicePreview.PreviewError('x', 402, 'needs_funding'));
  assert.equal(pub.body.error, 'Preview disabled — funding required');
  assert.equal(pub.body.category, 'needs_funding');
});

test('Deepgram Aura preview returns normalized WAV bytes when funded', async () => {
  const wav = tinyWav();
  const preview = loadProviders(async () => ({
    status: 200,
    headers: { 'content-type': 'audio/wav' },
    buffer: wav,
  }));
  process.env.DEEPGRAM_API_KEY = 'dg_test_key';
  delete process.env.SARVAM_NEEDS_FUNDING;
  delete process.env.RUMIK_NEEDS_FUNDING;

  const out = await preview.synthesizePreview({
    provider: 'deepgram',
    voice_id: 'aura-2-helena-en',
    language: 'en-IN',
    text: 'Hello, this is a preview from Astra Voice.',
  });
  assert.ok(Buffer.isBuffer(out.buffer));
  assert.ok(out.buffer.length > 12);
  assert.equal(out.contentType, 'audio/wav');
  assert.equal(out.mime_type, 'audio/wav');
  assert.equal(out.provider, 'deepgram');
  assert.equal(out.voice_id, 'aura-2-helena-en');
  assert.equal(out.buffer.toString('ascii', 0, 4), 'RIFF');
});

test('employeeId isolates preview and never invents Maya fallback', async () => {
  const wav = tinyWav();
  const preview = loadProviders(async () => ({
    status: 200,
    headers: { 'content-type': 'audio/wav' },
    buffer: wav,
  }));
  process.env.DEEPGRAM_API_KEY = 'dg_test_key';

  await assert.rejects(
    () => preview.synthesizePreview({
      provider: 'deepgram',
      voice_id: 'aura-2-helena-en',
      language: 'en-IN',
      employeeId: 'emp_missing',
      findEmployee: () => null,
    }),
    (err) => err.code === 'employee_not_found' && err.status === 404,
  );

  const employee = {
    id: 'emp_arjun',
    name: 'Arjun',
    voice: { language: 'te-IN' },
  };
  const out = await preview.synthesizePreview({
    provider: 'deepgram',
    voice_id: 'aura-2-helena-en',
    language: 'en-IN',
    employeeId: 'emp_arjun',
    findEmployee: (id) => (id === 'emp_arjun' ? employee : null),
  });
  assert.equal(out.employeeId, 'emp_arjun');
  assert.equal(out.provider, 'deepgram');
  assert.notEqual(out.provider, 'maya');
});

test('Sarvam upstream 402 maps to funding required', async () => {
  const preview = loadProviders(async () => ({
    status: 402,
    headers: { 'content-type': 'application/json' },
    buffer: Buffer.from(JSON.stringify({ message: 'Insufficient balance' })),
  }));
  process.env.SARVAM_API_KEY = 'sk_live_test';
  delete process.env.SARVAM_NEEDS_FUNDING;
  delete process.env.SARVAM_ACCOUNT_STATUS;

  await assert.rejects(
    () => preview.synthesizePreview({
      provider: 'sarvam',
      voice_id: 'shubh',
      language: 'te-IN',
      text: 'Hello',
    }),
    (err) => err.code === 'needs_funding' && /funding required/i.test(err.message),
  );
});

test('dograh managed preview is allowed via Rumik (managed_via: rumik)', async () => {
  const wav = tinyWav();
  const preview = loadProviders(async () => ({
    status: 200,
    headers: { 'content-type': 'audio/wav' },
    buffer: wav,
  }));
  process.env.RUMIK_API_KEY = 'rk_test_managed';
  delete process.env.RUMIK_NEEDS_FUNDING;
  delete process.env.RUMIK_ACCOUNT_STATUS;

  const out = await preview.synthesizePreview({
    provider: 'dograh',
    voice_id: 'default',
    language: 'en-IN',
    text: 'Hello, this is a preview from Astra Voice.',
  });
  assert.equal(out.provider, 'rumik');
  assert.equal(out.managed_via, 'rumik');
  assert.equal(out.voice_id, 'speaker_2');
  assert.ok(Buffer.isBuffer(out.buffer));
  assert.equal(out.buffer.toString('ascii', 0, 4), 'RIFF');
});

test('deprecated Sarvam Bulbul v2 speakers map to voice_unavailable', async () => {
  process.env.SARVAM_API_KEY = 'sk_test';
  delete process.env.SARVAM_NEEDS_FUNDING;
  delete process.env.SARVAM_ACCOUNT_STATUS;

  await assert.rejects(
    () => voicePreview.synthesizePreview({
      provider: 'sarvam',
      voice_id: 'anushka',
      language: 'hi-IN',
      text: 'Hello',
    }),
    (err) => err.code === 'voice_unavailable'
      && err.detail
      && err.detail.reason === 'deprecated_bulbul_v2',
  );
});

test('app.js allows Dograh managed preview (no hard-block toast)', () => {
  const src = fs.readFileSync(path.join(__dirname, '../public/assets/app.js'), 'utf8');
  assert.ok(!/if \(provider === 'dograh'\) \{\s*toast\('Voice unavailable'/.test(src));
  assert.ok(src.includes('managed_via: rumik') || src.includes('Managed (Dograh) preview is allowed via Rumik'));
});

test('POST /api/voice/preview returns audio bytes and honors funding gate', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'astra-preview-'));
  const dbFile = path.join(tmpDir, 'db.json');
  process.env.RAPIDX_DB_FILE = dbFile;
  process.env.DEEPGRAM_API_KEY = 'dg_test_key';
  delete process.env.SARVAM_NEEDS_FUNDING;
  delete process.env.RUMIK_NEEDS_FUNDING;

  delete require.cache[corePath];
  delete require.cache[providersPath];
  delete require.cache[require.resolve('../lib/voice-preview')];
  delete require.cache[require.resolve('../lib/employees')];
  delete require.cache[require.resolve('../lib/voice-catalog')];

  const core = require('../lib/core');
  core.loadEnv();

  const tenantId = core.genId('t_');
  const userId = core.genId('u_');
  const empId = core.genId('emp_');
  const now = new Date().toISOString();

  await core.mutate((d) => {
    if (!Array.isArray(d.tenants)) d.tenants = [];
    if (!Array.isArray(d.users)) d.users = [];
    if (!Array.isArray(d.sessions)) d.sessions = [];
    if (!Array.isArray(d.employees)) d.employees = [];
    d.tenants.push({
      id: tenantId,
      name: 'Preview Co',
      slug: 'preview',
      createdAt: now,
      plan: 'starter',
      status: 'active',
      privacyMode: 'standard',
    });
    d.users.push({
      id: userId,
      tenantId,
      email: 'preview@test.local',
      name: 'Preview User',
      passHash: core.hashPassword('preview-test-pass-12'),
      role: 'owner',
      status: 'active',
      createdAt: now,
    });
    d.employees.push({
      id: empId,
      tenantId,
      name: 'Preview Emp',
      status: 'READY',
      voice: { language: 'en-IN', tier: 'standard', speaker: 'aura-2-helena-en' },
      knowledgeIds: [],
      outcomes: [],
      actions: [],
      createdAt: now,
      updatedAt: now,
    });
  });

  const cookie = 'rxv_sess=' + await core.createSession(userId, tenantId);
  const employeeId = empId;

  const wav = tinyWav();
  const coreMod = require('../lib/core');
  const origPost = coreMod.httpsPost;
  coreMod.httpsPost = async (host, pathname) => {
    if (String(host).includes('deepgram') && String(pathname).includes('/v1/speak')) {
      return { status: 200, headers: { 'content-type': 'audio/wav' }, buffer: wav };
    }
    return { status: 500, headers: {}, buffer: Buffer.from('unexpected upstream') };
  };

  // Reload providers so they pick up the mocked httpsPost.
  delete require.cache[providersPath];
  require('../lib/providers');
  delete require.cache[require.resolve('../lib/voice-preview')];
  const voicePreviewMod = require('../lib/voice-preview');
  const employees = require('../lib/employees');

  const server = http.createServer(async (req, res) => {
    const route = (req.url || '').split('?')[0];
    if (req.method === 'POST' && route === '/api/voice/preview') {
      const body = await core.readBody(req);
      return core.requireAuth(req, res, async (rq, rs, ctx) => {
        try {
          const out = await voicePreviewMod.synthesizePreview({
            provider: body.provider,
            voice_id: body.voice_id,
            language: body.language,
            text: body.text,
            employeeId: body.employeeId,
            findEmployee: (id) => employees.findEmployee(core.db(), ctx.tenant.id, id),
          });
          core.send(rs, 200, out.buffer, {
            'Content-Type': out.contentType,
            'Content-Length': out.buffer.length,
            'X-Preview-Provider': out.provider,
            'X-Preview-Voice': out.voice_id,
          });
        } catch (e) {
          const pub = voicePreviewMod.publicPreviewError(
            e instanceof voicePreviewMod.PreviewError
              ? e
              : voicePreviewMod.mapUpstreamPreviewError(e, body.provider),
          );
          core.sendJson(rs, pub.status, pub.body);
        }
      }, body);
    }
    if (req.method === 'POST' && route === '/api/voice/preview-fund') {
      return core.requireAuth(req, res, async (rq, rs) => {
        process.env.SARVAM_API_KEY = 'sk';
        process.env.SARVAM_NEEDS_FUNDING = '1';
        try {
          await voicePreviewMod.synthesizePreview({
            provider: 'sarvam', voice_id: 'shubh', language: 'te-IN', text: 'Hi',
          });
          core.sendJson(rs, 500, { error: 'should have failed' });
        } catch (e) {
          const pub = voicePreviewMod.publicPreviewError(e);
          core.sendJson(rs, pub.status, pub.body);
        }
      }, {});
    }
    core.sendJson(res, 404, { error: 'not found' });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  function post(urlPath, body) {
    return new Promise((resolve, reject) => {
      const data = JSON.stringify(body);
      const r = http.request({
        hostname: '127.0.0.1',
        port,
        path: urlPath,
        method: 'POST',
        headers: {
          Cookie: cookie,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
        },
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          const ct = String(res.headers['content-type'] || '');
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: ct.includes('json') ? JSON.parse(buf.toString('utf8')) : buf,
          });
        });
      });
      r.on('error', reject);
      r.write(data);
      r.end();
    });
  }

  t.after(() => {
    coreMod.httpsPost = origPost;
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
    delete process.env.RAPIDX_DB_FILE;
  });

  const ok = await post('/api/voice/preview', {
    provider: 'deepgram',
    voice_id: 'aura-2-helena-en',
    language: 'en-IN',
    text: 'Hello, this is a preview from Astra Voice.',
    employeeId,
  });
  assert.equal(ok.status, 200);
  assert.ok(String(ok.headers['content-type'] || '').startsWith('audio/'));
  assert.ok(Buffer.isBuffer(ok.body));
  assert.equal(ok.body.toString('ascii', 0, 4), 'RIFF');
  assert.equal(ok.headers['x-preview-provider'], 'deepgram');
  assert.equal(ok.headers['x-preview-voice'], 'aura-2-helena-en');

  const cross = await post('/api/voice/preview', {
    provider: 'deepgram',
    voice_id: 'aura-2-helena-en',
    language: 'en-IN',
    employeeId: 'emp_other_tenant',
  });
  assert.equal(cross.status, 404);
  assert.equal(cross.body.code, 'employee_not_found');

  const funded = await post('/api/voice/preview-fund', {});
  assert.equal(funded.status, 402);
  assert.equal(funded.body.code, 'needs_funding');
  assert.match(funded.body.error, /funding required/i);

  await new Promise((resolve) => server.close(resolve));
});

test('app.js preview handler calls /api/voice/preview and Audio.play', () => {
  const src = fs.readFileSync(path.join(__dirname, '../public/assets/app.js'), 'utf8');
  assert.ok(src.includes("/api/voice/preview"), 'missing /api/voice/preview call');
  assert.ok(/new Audio\(previewBlobUrl\)/.test(src) || /new Audio\([^)]+\)/.test(src), 'missing Audio constructor');
  assert.ok(/await audio\.play\(\)/.test(src), 'missing await audio.play()');
  assert.ok(src.includes('createObjectURL'), 'missing createObjectURL for binary audio');
  assert.ok(src.includes('revokeObjectURL'), 'missing revokeObjectURL cleanup');
  assert.ok(src.includes('Browser playback blocked'), 'missing autoplay error category');
  assert.ok(src.includes('Preview disabled — funding required'), 'missing funding UX copy');
  // Must not treat toast-only success as playback.
  assert.ok(!/toast\('Playing draft preview[^']*', 'info'\);\s*\n\s*const who = emp\.name/.test(src));
  // Must pass employeeId for isolation.
  assert.ok(/employeeId:\s*emp\.id/.test(src), 'missing employeeId binding');
  // Must pass selected provider / voice / language.
  assert.ok(/voice_id/.test(src) && /selectedLanguage/.test(src));
});
