/**
 * Astra AI. Zero-dependency Node server (the product, multi-tenant).
 *
 * Pure Node http/https/crypto/fs. No npm, no build step, no framework. Run with
 * `node server.js` and it serves the JSON API plus the static public/ site on
 * PORT (default 8787). Secrets stay server side, runtime state lives in data/.
 *
 * Routes are EXACTLY per SPEC section 4. Every agents/usage/telephony route is
 * tenant scoped through the session. The live provider calls (Deepgram, Groq, Rumik,
 * VoBiz through Dograh) are isolated in lib/providers.js.
 *
 * No em dashes anywhere. Commas and periods only.
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer, WebSocket } = require('ws');

const core = require('./lib/core');
core.loadEnv();
const providers = require('./lib/providers');
const payu = require('./lib/payu');
const demoLinks = require('./lib/demo-links');
const callback = require('./lib/callback');
const phoneNumbers = require('./lib/phone-numbers');
const calls = require('./lib/calls');
const { createDefaultTelephonyProvider, TelephonyProviderError } = require('./lib/telephony-provider');
const { AGENT_TYPES, seedPresets, publicPreset, applyPresetToAgent, normalizeAgentType } = require('./lib/agent-types');
const org = require('./lib/org');
const knowledge = require('./lib/knowledge');
const integrations = require('./lib/integrations');
const campaigns = require('./lib/campaigns');
const analytics = require('./lib/analytics');
const plans = require('./lib/plans');
const pkg = require('./package.json');
const STARTED_AT_MS = Date.now();
const APP_VERSION = String((pkg && pkg.version) || '1.0.0');

function readVersionFileText() {
  try {
    return fs.readFileSync(path.join(__dirname, 'VERSION'), 'utf8');
  } catch (_) {
    return null;
  }
}

function currentDeployIdentity() {
  return org.deployIdentity(process.env, { versionFileText: readVersionFileText() });
}
const workflows = require('./lib/workflows');
const leads = require('./lib/leads');
const callJobs = require('./lib/call-jobs');
const employees = require('./lib/employees');
const timeline = require('./lib/timeline');
const { createDefaultWorkflowProvider, WorkflowProviderError } = require('./lib/workflow-provider');

const telephonyProvider = createDefaultTelephonyProvider(core);
const workflowProvider = createDefaultWorkflowProvider({ core, telephony: providers.telephony });

const PORT = parseInt(process.env.PORT || '8787', 10);
const DEFAULT_PROVIDERS = Object.freeze({
  stt: providers.stt.id,
  tts: providers.tts.id,
  llm: providers.llm.id,
  telephony: providers.telephony.id,
});

/* ==========================================================================
   Boot: ensure data/ + db.json, seed the demo tenant, migrate legacy agents.
   ========================================================================== */

const DEMO_EMAIL = String(process.env.TEST_USER_EMAIL || '').trim().toLowerCase();
const DEMO_PASS = String(process.env.TEST_USER_PASSWORD || '');
const DEMO_TENANT = String(process.env.TEST_USER_TENANT || 'Astra AI Test');
const TRIAL_CREDIT_PAISE = 1000;
const CREDIT_PACKS = Object.freeze({
  starter: Object.freeze({ amount: '200.00', currency: 'INR', credits: 20000, productinfo: 'Astra AI Starter Credits' }),
  growth: Object.freeze({ amount: '500.00', currency: 'INR', credits: 50000, productinfo: 'Astra AI Growth Credits' }),
  scale: Object.freeze({ amount: '1000.00', currency: 'INR', credits: 100000, productinfo: 'Astra AI Scale Credits' }),
});

function payuConfig() {
  if (!process.env.PAYU_KEY || !process.env.PAYU_SALT) return null;
  return { key: process.env.PAYU_KEY, salt: process.env.PAYU_SALT, env: process.env.PAYU_ENV === 'production' ? 'production' : 'test' };
}

function readForm(req, cap = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (chunk) => { size += chunk.length; if (size > cap) { reject(new Error('payload too large')); req.destroy(); } else chunks.push(chunk); });
    req.on('end', () => resolve(Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString('utf8')))));
    req.on('error', reject);
  });
}

function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

// Pull legacy agents from _legacy/agents.legacy.json or root agents.json (first
// that exists). Returns an array, never throws.
function readLegacyAgents() {
  const candidates = [
    path.join(core.ROOT, '_legacy', 'agents.legacy.json'),
    path.join(core.ROOT, 'agents.json'),
  ];
  for (const f of candidates) {
    try {
      const arr = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (Array.isArray(arr) && arr.length) return arr;
    } catch (_) { /* try next */ }
  }
  return [];
}

// Normalize a legacy agent (flat model/speaker/created) into the SPEC shape
// (nested tts object, createdAt ISO), scoped to the given tenant.
function migrateLegacyAgent(legacy, tenantId) {
  const model = legacy.model === 'muga' ? 'muga' : providers.tts.model;
  const speaker = providers.TTS_SPEAKERS.has(legacy.speaker) ? legacy.speaker : 'speaker_1';
  return {
    id: legacy.id || core.genId('ag_'),
    tenantId,
    name: String(legacy.name || 'Untitled Agent').slice(0, 60),
    persona: String(legacy.persona || '').slice(0, 1500),
    tts: {
      provider: providers.tts.id,
      model,
      speaker,
      f0_up_key: Number.isFinite(legacy.f0_up_key) ? legacy.f0_up_key : 0,
    },
    greeting: String(legacy.greeting || '').slice(0, 300),
    telephony: { did: String(legacy.did || providers.telephony.did) },
    createdAt: legacy.created ? new Date(legacy.created).toISOString() : new Date().toISOString(),
  };
}

async function boot() {
  // Force a load so a missing/corrupt db.json resolves to a clean default.
  const existing = core.db();
  await core.mutate((d) => {
    seedPresets(d);
    phoneNumbers.seedPlatformInventory(d);
    workflows.seedAllTenants(d);
  });

  const hasDemo = DEMO_EMAIL && existing.users.some((u) => u.email === DEMO_EMAIL);

  if (DEMO_EMAIL && DEMO_PASS.length >= 12 && !hasDemo) {
    const tenantId = core.genId('t_');
    const userId = core.genId('u_');
    const nowIso = new Date().toISOString();
    const legacy = readLegacyAgents();

    await core.mutate((d) => {
      d.tenants.push({
        id: tenantId,
        name: DEMO_TENANT,
        slug: makeSlug(DEMO_TENANT, new Set(d.tenants.map((t) => t.slug))),
        createdAt: nowIso,
        branding: { color: '#6B21A8' },
        providers: { ...DEFAULT_PROVIDERS },
        plan: 'starter',
        status: 'active', privacyMode: 'standard', includedNumbers: 1,
      });
      d.users.push({
        id: userId,
        tenantId,
        email: DEMO_EMAIL,
        name: 'Astra AI Demo',
        passHash: core.hashPassword(DEMO_PASS),
        role: process.env.TEST_USER_SUPER_ADMIN === 'true' ? 'super_admin' : 'owner', status: 'active',
        createdAt: nowIso,
      });
      d.wallets.push({ id: core.genId('wal_'), tenantId, currency: 'INR', balancePaise: 0, createdAt: nowIso, updatedAt: nowIso });
      addLedgerEntry(d, tenantId, TRIAL_CREDIT_PAISE, 'trial_grant', `trial:${tenantId}`, userId, { amountInr: 10, source: 'test_bootstrap' });
      plans.grantPlanCredits(d, tenantId, 'starter', userId, addLedgerEntry);
      // Migrate any legacy agents into the demo tenant.
      for (const la of legacy) d.agents.push(migrateLegacyAgent(la, tenantId));
      workflows.seedTenantReceptionist(d, tenantId, userId);
    });

    console.log(`  Seeded env-configured test tenant "${DEMO_TENANT}" with ${legacy.length} migrated agent(s).`);
  }

  // Migrate the old provider selection without rewriting tenant data by hand.
  if (core.db().tenants.some((t) => t.providers && t.providers.telephony === 'voicelink')) {
    await core.mutate((d) => {
      d.tenants.forEach((t) => {
        if (t.providers && t.providers.telephony === 'voicelink') t.providers.telephony = 'vobiz';
      });
    });
  }

  // Fill missing or stale selections from the configured adapter defaults.
  // Existing valid selections remain intact so boot never forces a tenant back
  // to one specific LLM or TTS provider.
  if (core.db().tenants.some((t) => !t.providers || !t.providers.stt || !t.providers.tts || !t.providers.llm || !t.providers.telephony)) {
    await core.mutate((d) => {
      d.tenants.forEach((t) => {
        t.providers = { ...DEFAULT_PROVIDERS, ...(t.providers || {}) };
      });
    });
  }
}

/* ==========================================================================
   Public-facing serialization (never leak passHash, scope to tenant).
   ========================================================================== */
function publicUser(u) {
  return { id: u.id, tenantId: u.tenantId, email: u.email, name: u.name, role: u.role, status: u.status, createdAt: u.createdAt };
}
function publicTenant(t) {
  // Workspace and organization are product aliases for the same tenant record.
  return org.publicWorkspace(t);
}
function publicAgent(a) {
  return {
    id: a.id, name: a.name, persona: a.persona, tts: a.tts,
    greeting: a.greeting, telephony: a.telephony, presetId: a.presetId || null,
    agentType: a.agentType || 'custom',
    direction: a.direction || null,
    // Dograh workflow ids stay server-side. Opaque keys may surface for outbound.
    workflowKey: a.dograhWorkflowKey || null,
    createdAt: a.createdAt,
  };
}

// Slugify a company name into a tenant slug, ensuring uniqueness.
function makeSlug(name, taken) {
  const base = String(name || 'tenant').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'tenant';
  let slug = base; let n = 2;
  while (taken.has(slug)) { slug = `${base}-${n++}`; }
  return slug;
}

// Bump a usage counter for today for a tenant. field in {chars, calls, llmTokens}.
async function bumpUsage(tenantId, field, amount) {
  const day = todayUtc();
  await core.mutate((d) => {
    let row = d.usage.find((r) => r.tenantId === tenantId && r.day === day);
    if (!row) { row = { tenantId, day, chars: 0, calls: 0, llmTokens: 0 }; d.usage.push(row); }
    row[field] = (row[field] || 0) + amount;
  });
}

function publicWallet(w) {
  return { id: w.id, tenantId: w.tenantId, currency: w.currency, balancePaise: w.balancePaise, balanceInr: w.balancePaise / 100, updatedAt: w.updatedAt };
}

function addLedgerEntry(d, tenantId, amountPaise, type, reference, actorUserId, metadata = {}) {
  const key = String(reference || '');
  if (key && d.ledger.some((x) => x.tenantId === tenantId && x.idempotencyKey === key)) return null;
  let wallet = d.wallets.find((w) => w.tenantId === tenantId);
  const now = new Date().toISOString();
  if (!wallet) {
    wallet = { id: core.genId('wal_'), tenantId, currency: 'INR', balancePaise: 0, createdAt: now, updatedAt: now };
    d.wallets.push(wallet);
  }
  if (!Number.isInteger(amountPaise) || wallet.balancePaise + amountPaise < 0) throw new Error('invalid wallet adjustment');
  wallet.balancePaise += amountPaise;
  wallet.updatedAt = now;
  const entry = { id: core.genId('led_'), tenantId, type, amountPaise, balanceAfterPaise: wallet.balancePaise, idempotencyKey: key || core.genId('idem_'), actorUserId, metadata, createdAt: now };
  d.ledger.push(entry);
  return entry;
}

function addAudit(d, ctx, action, targetType, targetId, metadata = {}) {
  d.auditEvents.push({ id: core.genId('aud_'), tenantId: ctx.tenant.id, actorUserId: ctx.impersonator ? ctx.impersonator.id : ctx.user.id, subjectUserId: ctx.impersonator ? ctx.user.id : null, action, targetType, targetId, metadata, createdAt: new Date().toISOString() });
}

function rejectImpersonated(res, ctx) {
  if (!ctx.impersonator) return false;
  core.sendJson(res, 403, { error: 'This action is blocked while viewing as another user', code: 'impersonation_read_only' });
  return true;
}

/* ==========================================================================
   Auth routes
   ========================================================================== */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function apiSignup(req, res, body) {
  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');
  const name = String(body.name || '').trim().slice(0, 80) || 'Owner';
  const company = String(body.company || '').trim().slice(0, 80) || `${name}'s Workspace`;

  if (!EMAIL_RE.test(email)) return core.sendJson(res, 422, { error: 'valid email required', code: 'bad_email' });
  if (password.length < 12) return core.sendJson(res, 422, { error: 'password must be at least 12 characters', code: 'weak_password' });
  if (core.db().users.some((u) => u.email === email)) {
    return core.sendJson(res, 409, { error: 'an account with this email already exists', code: 'email_taken' });
  }

  const tenantId = core.genId('t_');
  const userId = core.genId('u_');
  const nowIso = new Date().toISOString();
  let tenant; let user;

  await core.mutate((d) => {
    const taken = new Set(d.tenants.map((t) => t.slug));
    tenant = {
      id: tenantId, name: company, slug: makeSlug(company, taken), createdAt: nowIso,
      branding: { color: '#6B21A8' },
      providers: { ...DEFAULT_PROVIDERS },
      plan: 'starter',
      status: 'active', privacyMode: 'standard', includedNumbers: 1,
    };
    user = {
      id: userId, tenantId, email, name,
      passHash: core.hashPassword(password), role: 'owner', status: 'active', createdAt: nowIso,
    };
    d.tenants.push(tenant);
    d.users.push(user);
    d.wallets.push({ id: core.genId('wal_'), tenantId, currency: 'INR', balancePaise: 0, createdAt: nowIso, updatedAt: nowIso });
    addLedgerEntry(d, tenantId, TRIAL_CREDIT_PAISE, 'trial_grant', `trial:${tenantId}`, userId, { amountInr: 10 });
    plans.grantPlanCredits(d, tenantId, 'starter', userId, addLedgerEntry);
    workflows.seedTenantReceptionist(d, tenantId, userId);
    addAudit(d, { tenant, user }, 'auth.signup', 'tenant', tenantId);
  });

  const token = await core.createSession(userId, tenantId);
  core.send(res, 200, JSON.stringify({ user: publicUser(user), tenant: publicTenant(tenant) }), {
    'Content-Type': 'application/json',
    'Set-Cookie': core.sessionCookie(token),
  });
}

async function apiLogin(req, res, body) {
  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');
  const d = core.db();
  const user = d.users.find((u) => u.email === email);
  // Same generic error whether the user is missing or the password is wrong.
  if (!user || !core.verifyPassword(password, user.passHash)) {
    return core.sendJson(res, 401, { error: 'invalid email or password', code: 'bad_creds' });
  }
  const tenant = d.tenants.find((t) => t.id === user.tenantId);
  if (!tenant) return core.sendJson(res, 401, { error: 'invalid email or password', code: 'bad_creds' });

  const token = await core.createSession(user.id, user.tenantId);
  core.send(res, 200, JSON.stringify({ user: publicUser(user), tenant: publicTenant(tenant) }), {
    'Content-Type': 'application/json',
    'Set-Cookie': core.sessionCookie(token),
  });
}

async function apiLogout(req, res) {
  await core.destroySession(req);
  core.send(res, 200, JSON.stringify({ ok: true }), {
    'Content-Type': 'application/json',
    'Set-Cookie': core.clearCookie(),
  });
}

/* ==========================================================================
   Authed routes (ctx = { user, tenant, session, body })
   ========================================================================== */

function apiMe(req, res, ctx) {
  core.sendJson(res, 200, { user: publicUser(ctx.user), tenant: publicTenant(ctx.tenant), impersonation: ctx.impersonator ? { actor: publicUser(ctx.impersonator), reason: ctx.session.impersonationReason, expiresAt: new Date(ctx.session.exp).toISOString() } : null });
}

const HVAC_TIMEZONE = 'Asia/Kolkata';
const HVAC_OUTCOMES = new Set(['new', 'booked', 'routed', 'follow_up', 'closed', 'abandoned']);
function calHeaders(version) {
  if (!process.env.CALCOM_API_KEY) throw new providers.ProviderError('Cal.com is not configured', 503, 'calendar_not_configured');
  return { Authorization: `Bearer ${process.env.CALCOM_API_KEY}`, 'cal-api-version': version, Accept: 'application/json' };
}
function calRequest(method, pathname, version, payload) {
  return new Promise((resolve, reject) => {
    const data = payload ? Buffer.from(JSON.stringify(payload)) : null;
    const headers = calHeaders(version);
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = String(data.length); }
    const upstream = require('https').request({ host: 'api.cal.com', path: pathname, method, headers }, (resp) => {
      const parts = []; resp.on('data', (part) => parts.push(part)); resp.on('end', () => {
        let body = {}; try { body = JSON.parse(Buffer.concat(parts).toString('utf8') || '{}'); } catch (_) {}
        if (resp.statusCode < 200 || resp.statusCode >= 300) return reject(new providers.ProviderError(body.message || body.error || 'Cal.com request failed', resp.statusCode || 502, 'calendar_upstream'));
        resolve(body);
      });
    });
    upstream.on('error', reject); upstream.setTimeout(20000, () => upstream.destroy(new Error('Cal.com timeout')));
    if (data) upstream.write(data); upstream.end();
  });
}
function tenantHvacJobs(tenantId) { return core.db().hvacJobs.filter((job) => job.tenantId === tenantId); }
function publicHvacJob(job) { return { id: job.id, callerName: job.callerName, phone: job.phone, email: job.email || '', service: job.service, urgency: job.urgency, outcome: job.outcome, assignedTo: job.assignedTo || '', notes: job.notes || '', appointment: job.appointment || null, createdAt: job.createdAt, updatedAt: job.updatedAt }; }
function apiHvacDesk(req, res, ctx) {
  const jobs = tenantHvacJobs(ctx.tenant.id).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const count = (outcome) => jobs.filter((job) => job.outcome === outcome).length;
  core.sendJson(res, 200, { timezone: HVAC_TIMEZONE, calendarConfigured: Boolean(process.env.CALCOM_API_KEY), jobs: jobs.map(publicHvacJob), stats: { calls: jobs.length, booked: count('booked'), routed: count('routed'), followUp: count('follow_up') } });
}
async function apiHvacEventTypes(req, res) {
  try { const result = await calRequest('GET', '/v2/event-types', '2024-06-14'); core.sendJson(res, 200, { eventTypes: (result.data || []).map((event) => ({ id: event.id, title: event.title, slug: event.slug, lengthInMinutes: event.lengthInMinutes, locations: event.locations || [] })) }); }
  catch (e) { handleProviderError(res, e); }
}
async function apiHvacSlots(req, res) {
  try {
    const q = new URL(req.url, 'http://local').searchParams; const eventTypeId = Number(q.get('eventTypeId')); const start = String(q.get('start') || ''); const end = String(q.get('end') || '');
    if (!Number.isInteger(eventTypeId) || !/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) return core.sendJson(res, 422, { error: 'event type and date range required', code: 'bad_calendar_query' });
    const result = await calRequest('GET', `/v2/slots?eventTypeId=${eventTypeId}&start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}&timeZone=${encodeURIComponent(HVAC_TIMEZONE)}&format=range`, '2024-09-04');
    core.sendJson(res, 200, { timezone: HVAC_TIMEZONE, slots: result.data || {} });
  } catch (e) { handleProviderError(res, e); }
}
async function apiHvacJobSave(req, res, ctx) {
  const b = ctx.body || {}; const callerName = String(b.callerName || '').trim().slice(0, 100); const phone = String(b.phone || '').trim().slice(0, 32);
  if (!callerName || !phone) return core.sendJson(res, 422, { error: 'caller name and phone are required', code: 'missing_contact' });
  const outcome = HVAC_OUTCOMES.has(b.outcome) ? b.outcome : 'new'; const now = new Date().toISOString(); let job;
  await core.mutate((d) => {
    job = b.id ? d.hvacJobs.find((item) => item.id === String(b.id) && item.tenantId === ctx.tenant.id) : null;
    if (!job) { job = { id: core.genId('hvac_'), tenantId: ctx.tenant.id, createdAt: now, appointment: null }; d.hvacJobs.push(job); }
    Object.assign(job, { callerName, phone, email: String(b.email || '').trim().slice(0, 180), service: String(b.service || 'General HVAC').trim().slice(0, 80), urgency: String(b.urgency || 'normal').trim().slice(0, 30), outcome, assignedTo: String(b.assignedTo || '').trim().slice(0, 80), notes: String(b.notes || '').trim().slice(0, 2000), updatedAt: now });
    addAudit(d, ctx, 'hvac.job.saved', 'hvac_job', job.id, { outcome: job.outcome });
  });
  core.sendJson(res, 200, { job: publicHvacJob(job) });
}
async function apiHvacBook(req, res, ctx) {
  const b = ctx.body || {}; const eventTypeId = Number(b.eventTypeId); const start = String(b.start || ''); const attendee = b.attendee || {};
  if (!Number.isInteger(eventTypeId) || Number(eventTypeId) <= 0 || !/^\d{4}-\d{2}-\d{2}T/.test(start)) return core.sendJson(res, 422, { error: 'event type and appointment time are required', code: 'bad_booking' });
  const name = String(attendee.name || '').trim(); const email = String(attendee.email || '').trim().toLowerCase(); const phone = String(attendee.phone || '').trim();
  if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !phone) return core.sendJson(res, 422, { error: 'attendee name, email and phone are required for Cal.com booking', code: 'missing_booking_contact' });
  try {
    const booking = await calRequest('POST', '/v2/bookings', '2026-02-25', { eventTypeId, start: new Date(start).toISOString(), attendee: { name, email, phoneNumber: phone, timeZone: HVAC_TIMEZONE, language: 'en' }, metadata: { source: 'rumik_hvac_desk', service: String(b.service || 'General HVAC').slice(0, 80), urgency: String(b.urgency || 'normal').slice(0, 30), jobId: String(b.jobId || '') } });
    const now = new Date().toISOString(); let job;
    await core.mutate((d) => {
      job = b.jobId ? d.hvacJobs.find((item) => item.id === String(b.jobId) && item.tenantId === ctx.tenant.id) : null;
      if (!job) { job = { id: core.genId('hvac_'), tenantId: ctx.tenant.id, callerName: name, phone, email, service: String(b.service || 'General HVAC').slice(0, 80), urgency: String(b.urgency || 'normal').slice(0, 30), assignedTo: '', notes: '', createdAt: now }; d.hvacJobs.push(job); }
      job.outcome = 'booked'; job.updatedAt = now; job.appointment = { calBookingUid: booking.data && booking.data.uid, eventTypeId, start: booking.data && booking.data.start, end: booking.data && booking.data.end, status: booking.data && booking.data.status, timezone: HVAC_TIMEZONE };
      addAudit(d, ctx, 'hvac.booking.created', 'hvac_job', job.id, { eventTypeId, bookingUid: job.appointment.calBookingUid || '' });
    });
    core.sendJson(res, 201, { booking: booking.data, job: publicHvacJob(job) });
  } catch (e) { handleProviderError(res, e); }
}

function apiAgentsList(req, res, ctx) {
  const agents = core.db().agents
    .filter((a) => a.tenantId === ctx.tenant.id)
    .map(publicAgent);
  core.sendJson(res, 200, { agents });
}

async function apiAgentsCreate(req, res, ctx) {
  const b = ctx.body || {};
  const preset = b.presetId ? core.db().presets.find((p) => p.id === String(b.presetId) && (p.isSystem || p.tenantId === ctx.tenant.id)) : null;
  if (b.presetId && !preset) return core.sendJson(res, 404, { error: 'preset not found', code: 'not_found' });
  const ttsIn = b.tts || {};
  const model = ttsIn.model === 'muga' ? 'muga' : providers.tts.model;
  const speaker = providers.TTS_SPEAKERS.has(ttsIn.speaker) ? ttsIn.speaker : 'speaker_1';
  const f0 = Number.isFinite(ttsIn.f0_up_key) ? Math.max(-12, Math.min(12, ttsIn.f0_up_key | 0)) : 0;

  const overrides = {
    name: b.name != null ? b.name : undefined,
    persona: b.persona != null ? b.persona : undefined,
    greeting: b.greeting != null ? b.greeting : undefined,
    agentType: b.agentType != null ? normalizeAgentType(b.agentType, preset ? preset.agentType : 'custom') : undefined,
  };
  if (Object.prototype.hasOwnProperty.call(b, 'dograhWorkflowId')) overrides.dograhWorkflowId = b.dograhWorkflowId;
  if (Object.prototype.hasOwnProperty.call(b, 'dograhWorkflowKey')) overrides.dograhWorkflowKey = b.dograhWorkflowKey;

  const agent = applyPresetToAgent({
    id: core.genId('ag_'),
    tenantId: ctx.tenant.id,
    tts: { provider: providers.tts.id, model, speaker, f0_up_key: f0 },
    telephony: { did: String(b.did || providers.telephony.did).replace(/[^0-9]/g, '') || providers.telephony.did },
    createdAt: new Date().toISOString(),
  }, preset, overrides);

  if (!agent.name) agent.name = 'Untitled Agent';
  if (agent.persona == null) agent.persona = '';
  if (agent.greeting == null) agent.greeting = '';

  await core.mutate((d) => { d.agents.push(agent); });
  core.sendJson(res, 200, { agent: publicAgent(agent) });
}

async function apiAgentsUpdate(req, res, ctx) {
  const b = ctx.body || {};
  const id = String(b.id || '');
  const d = core.db();
  const agent = d.agents.find((a) => a.id === id);
  if (!agent) return core.sendJson(res, 404, { error: 'agent not found', code: 'not_found' });
  if (agent.tenantId !== ctx.tenant.id) {
    return core.sendJson(res, 403, { error: 'not your agent', code: 'forbidden' });
  }
  let updated;
  await core.mutate((dd) => {
    const a = dd.agents.find((x) => x.id === id);
    if (b.name != null) a.name = String(b.name).slice(0, 60);
    if (b.persona != null) a.persona = String(b.persona).slice(0, 1500);
    if (b.greeting != null) a.greeting = String(b.greeting).slice(0, 300);
    if (b.did != null) {
      const did = String(b.did).replace(/[^0-9]/g, '');
      a.telephony = { ...(a.telephony || {}), did: did || providers.telephony.did };
    }
    if (b.tts && typeof b.tts === 'object') {
      const t = a.tts || { provider: providers.tts.id };
      if (b.tts.model != null) t.model = b.tts.model === 'muga' ? 'muga' : providers.tts.model;
      if (providers.TTS_SPEAKERS.has(b.tts.speaker)) t.speaker = b.tts.speaker;
      if (Number.isFinite(b.tts.f0_up_key)) t.f0_up_key = Math.max(-12, Math.min(12, b.tts.f0_up_key | 0));
      t.provider = providers.tts.id;
      a.tts = t;
    }
    updated = a;
  });
  core.sendJson(res, 200, { agent: publicAgent(updated) });
}

async function apiAgentsDelete(req, res, ctx) {
  const id = String((ctx.body || {}).id || '');
  const agent = core.db().agents.find((a) => a.id === id);
  if (!agent) return core.sendJson(res, 404, { error: 'agent not found', code: 'not_found' });
  if (agent.tenantId !== ctx.tenant.id) {
    return core.sendJson(res, 403, { error: 'not your agent', code: 'forbidden' });
  }
  await core.mutate((d) => { d.agents = d.agents.filter((a) => a.id !== id); });
  core.sendJson(res, 200, { ok: true });
}

// POST /api/tts -> Rumik WAV bytes. Increments tenant usage.chars.
async function apiTts(req, res, ctx) {
  const b = ctx.body || {};
  try {
    const selected = providers.resolveSelection('tts', { provider: b.provider, model: b.model });
    const out = await selected.adapter.synthesize({
      text: b.text,
      model: selected.model,
      speaker: b.speaker,
      f0_up_key: b.f0_up_key,
      description: b.description,
    });
    // Count usage only on a real synthesis.
    bumpUsage(ctx.tenant.id, 'chars', out.chars).catch(() => {});
    core.mutate((d) => {
      plans.debitUsage(d, ctx.tenant.id, { chars: out.chars, calls: 0 }, ctx.user.id, addLedgerEntry);
    }).catch(() => {});
    core.send(res, 200, out.buffer, {
      'Content-Type': 'audio/wav',
      'Content-Length': out.buffer.length,
      'X-Credits-Used': out.credits,
      'X-Chars': String(out.chars),
    });
  } catch (e) {
    handleProviderError(res, e);
  }
}

// POST /api/ws-connect -> { ws_url, token } (Rumik streaming mint).
async function apiWsConnect(req, res, ctx) {
  const b = ctx.body || {};
  try {
    const selected = providers.resolveSelection('tts', { provider: b.provider, model: b.model });
    const data = await selected.adapter.wsConnect({ text: b.text, model: selected.model });
    core.sendJson(res, 200, { ...data, provider: selected.provider, model: selected.model });
  } catch (e) {
    handleProviderError(res, e);
  }
}

// POST /api/chat -> { text, finish, provider, model, latency_ms } (Groq brain).
async function apiChat(req, res, ctx) {
  const b = ctx.body || {};
  try {
    const selected = providers.resolveSelection('llm', { provider: b.provider, model: b.model });
    const out = await selected.adapter.chat({ messages: b.messages, system: b.system, model: selected.model });
    // Rough token accounting for the usage view (4 chars ~= 1 token).
    const approxTokens = Math.ceil((out.text || '').length / 4);
    bumpUsage(ctx.tenant.id, 'llmTokens', approxTokens).catch(() => {});
    core.sendJson(res, 200, out);
  } catch (e) {
    handleProviderError(res, e);
  }
}

// POST /api/stt -> { text, provider, model, latency_ms } (Deepgram Nova-3).
async function apiStt(req, res, ctx) {
  const b = ctx.body || {};
  try {
    const out = await providers.stt.transcribe({ audio: b.audio, mime: b.mime });
    core.sendJson(res, 200, out);
  } catch (e) {
    handleProviderError(res, e);
  }
}

async function mintDograhVoiceSession(req, context) {
  const token = String(process.env.DOGRAH_EMBED_TOKEN || '').trim();
  const base = String(process.env.DOGRAH_BASE_URL || '').replace(/\/$/, '');
  if (!token || !base) {
    const error = new Error('realtime voice session is not configured');
    error.status = 503; error.code = 'voice_session_unavailable'; throw error;
  }
  const requestOrigin = String(req.headers.origin || `https://${req.headers.host || ''}`);
  const upstream = await fetch(base + '/api/v1/public/embed/init', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: requestOrigin },
    body: JSON.stringify({ token, context_variables: {
      source: String(context.source || 'rumik_studio'),
      tenant_id: String(context.tenantId || ''),
      agent_id: String(context.agentId || ''),
      demo_link_id: String(context.demoLinkId || ''),
      max_session_seconds: String(context.maxSessionSeconds || ''),
    } }),
    signal: AbortSignal.timeout(12000),
  });
  const text = await upstream.text(); let data = {};
  try { data = JSON.parse(text); } catch (_) {}
  if (!upstream.ok) {
    const error = new Error(String(data.detail || 'Dograh could not start the realtime voice session'));
    error.status = upstream.status; error.code = 'voice_session_failed'; throw error;
  }
  const sessionToken = String(data.session_token || '');
  let turnCredentials = null;
  if (sessionToken) {
    try {
      const turnUpstream = await fetch(base + '/api/v1/public/embed/turn-credentials/' + encodeURIComponent(sessionToken), {
        method: 'GET', headers: { Origin: requestOrigin }, signal: AbortSignal.timeout(8000),
      });
      if (turnUpstream.ok) {
        const turnData = await turnUpstream.json();
        if (Array.isArray(turnData.uris) && turnData.uris.length && turnData.username && turnData.password) {
          turnCredentials = {
            uris: turnData.uris,
            username: String(turnData.username),
            password: String(turnData.password),
            ttl: Number(turnData.ttl || 0),
          };
        }
      }
    } catch (_) {}
  }
  return {
    sessionToken: data.session_token, workflowRunId: data.workflow_run_id,
    workflowId: data.config && data.config.workflow_id,
    signalingUrl: base.replace(/^http/, 'ws') + '/api/v1/ws/public/signaling/' + encodeURIComponent(data.session_token),
    turnCredentials,
    runtime: 'Dograh SmallWebRTC',
  };
}

async function apiVoiceSession(req, res, ctx) {
  try {
    const session = await mintDograhVoiceSession(req, {
      source: 'rumik_studio', tenantId: ctx.tenant.id, agentId: (ctx.body || {}).agentId,
    });
    core.sendJson(res, 200, session);
  } catch (error) {
    core.sendJson(res, error.status || 502, { error: error.message || 'Dograh realtime voice session failed', code: error.code || 'voice_session_failed' });
  }
}

function tenantDemoLinks(tenantId) {
  return core.db().demoLinks.filter((link) => link.tenantId === tenantId);
}

function apiDemoLinksList(req, res, ctx) {
  const links = tenantDemoLinks(ctx.tenant.id)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((link) => demoLinks.publicDemoLink(link));
  core.sendJson(res, 200, { demoLinks: links });
}

async function apiDemoLinksCreate(req, res, ctx) {
  if (rejectImpersonated(res, ctx)) return;
  const body = ctx.body || {};
  const agent = core.db().agents.find((item) => item.id === String(body.agentId || '') && item.tenantId === ctx.tenant.id);
  if (!agent) return core.sendJson(res, 404, { error: 'agent not found', code: 'not_found' });
  const generated = demoLinks.createDemoToken();
  const limits = demoLinks.normalizeDemoLimits(body);
  const link = {
    id: generated.id, tokenHash: generated.tokenHash, tenantId: ctx.tenant.id, agentId: agent.id,
    label: String(body.label || `${agent.name} demo`).trim().slice(0, 80) || `${agent.name} demo`,
    status: 'active', starts: 0, createdBy: ctx.user.id, createdAt: new Date().toISOString(),
    ...limits,
  };
  await core.mutate((database) => {
    database.demoLinks.push(link);
    addAudit(database, ctx, 'demo_link.created', 'demo_link', link.id, { agentId: agent.id, expiresAt: link.expiresAt, maxStarts: link.maxStarts });
  });
  core.sendJson(res, 201, { demoLink: demoLinks.publicDemoLink(link), sharePath: `/demo/${generated.token}` });
}

async function apiDemoLinksRevoke(req, res, ctx) {
  if (rejectImpersonated(res, ctx)) return;
  const id = String((ctx.body || {}).id || '');
  const link = core.db().demoLinks.find((item) => item.id === id && item.tenantId === ctx.tenant.id);
  if (!link) return core.sendJson(res, 404, { error: 'demo link not found', code: 'not_found' });
  await core.mutate((database) => {
    const target = database.demoLinks.find((item) => item.id === id && item.tenantId === ctx.tenant.id);
    target.status = 'revoked'; target.revokedAt = new Date().toISOString(); target.revokedBy = ctx.user.id;
    addAudit(database, ctx, 'demo_link.revoked', 'demo_link', id, { agentId: target.agentId });
  });
  core.sendJson(res, 200, { ok: true });
}

function publicDemoContext(token) {
  const database = core.db();
  const link = demoLinks.findDemoLink(database, token);
  if (!link) return null;
  const tenant = database.tenants.find((item) => item.id === link.tenantId && item.status === 'active');
  const agent = database.agents.find((item) => item.id === link.agentId && item.tenantId === link.tenantId);
  if (!tenant || !agent) return null;
  const color = String((tenant.branding || {}).color || '#6B21A8');
  return { link, tenant, agent, color: /^#[0-9A-Fa-f]{6}$/.test(color) ? color : '#6B21A8' };
}

function apiPublicDemoMeta(req, res, token) {
  const context = publicDemoContext(token);
  if (!context) return core.sendJson(res, 404, { error: 'demo link not found', code: 'not_found' });
  const status = demoLinks.demoLinkStatus(context.link);
  core.sendJson(res, 200, {
    demo: { id: context.link.id, label: context.link.label, status, expiresAt: context.link.expiresAt, maxSessionSeconds: context.link.maxSessionSeconds },
    brand: { name: context.tenant.name, color: context.color },
    agent: { name: context.agent.name, greeting: String(context.agent.greeting || '').slice(0, 300) },
  });
}

async function apiPublicDemoSession(req, res, token) {
  const context = publicDemoContext(token);
  if (!context) return core.sendJson(res, 404, { error: 'demo link not found', code: 'not_found' });
  let reserved = false;
  try {
    await core.mutate((database) => {
      const target = database.demoLinks.find((item) => item.id === context.link.id);
      const status = demoLinks.demoLinkStatus(target);
      if (status !== 'active') {
        const error = new Error(`this demo link is ${status}`);
        error.status = 410; error.code = `demo_${status}`; throw error;
      }
      target.starts = Number(target.starts || 0) + 1;
      target.lastStartedAt = new Date().toISOString();
      reserved = true;
    });
    const session = await mintDograhVoiceSession(req, {
      source: 'public_demo', tenantId: context.tenant.id, agentId: context.agent.id,
      demoLinkId: context.link.id, maxSessionSeconds: context.link.maxSessionSeconds,
    });
    core.sendJson(res, 200, { ...session, maxSessionSeconds: context.link.maxSessionSeconds });
  } catch (error) {
    if (reserved) await core.mutate((database) => {
      const target = database.demoLinks.find((item) => item.id === context.link.id);
      if (target) target.starts = Math.max(0, Number(target.starts || 0) - 1);
    }).catch(() => {});
    core.sendJson(res, error.status || 502, { error: error.message || 'realtime demo failed', code: error.code || 'voice_session_failed' });
  }
}

// GET /api/telephony/status -> connection + DIDs. Provider brand names are Super Admin only.
async function apiTelephonyStatus(req, res, ctx) {
  try {
    const status = await providers.telephony.status();
    const rich = Object.assign({}, status, {
      provider: status.provider || 'vobiz',
      orchestrator: status.orchestrator || 'dograh',
    });
    if (ctx && ctx.user && ctx.user.role === 'super_admin') {
      return core.sendJson(res, 200, rich);
    }
    return core.sendJson(res, 200, org.publicTelephonyStatus(rich));
  } catch (e) {
    handleProviderError(res, e);
  }
}

// POST /api/telephony/dial -> places a REAL paid call. GUARDED behind confirm.
async function apiTelephonyDial(req, res, ctx) {
  const b = ctx.body || {};
  if (b.confirm !== true) {
    return core.sendJson(res, 400, {
      error: 'confirm required: this places a REAL paid call',
      code: 'needs_confirm',
    });
  }
  let workflowId;
  if (ctx.tenant.privacyMode === 'no_recording') {
    workflowId = Number(process.env.DOGRAH_NO_RECORDING_WORKFLOW_ID || 0);
    if (!Number.isInteger(workflowId) || workflowId <= 0) {
      return core.sendJson(res, 409, {
        error: 'HIPAA mode blocks phone calls until a verified no-recording Dograh workflow is configured',
        code: 'privacy_workflow_required',
      });
    }
  }
  try {
    // Provider returns server-only { status, data, providerRunId, ok, call }.
    // Customer response is { call: publicCall(...) } only. Never forward
    // providerRunId, Dograh ids, or raw upstream data.
    const r = await telephonyProvider.createOutboundCall(ctx.tenant.id, b.number, {
      workflowId: b.workflowId || workflowId,
      phoneNumberId: b.phoneNumberId,
    });
    // Count the dial attempt against today's usage.
    bumpUsage(ctx.tenant.id, 'calls', 1).catch(() => {});
    core.mutate((d) => {
      plans.debitUsage(d, ctx.tenant.id, { chars: 0, calls: 1 }, ctx.user.id, addLedgerEntry);
    }).catch(() => {});

    let callRow = r.call || null;
    if (!callRow && r.providerRunId) {
      await core.mutate((d) => {
        const up = calls.upsertCallFromProvider(d, ctx.tenant.id, {
          providerRunId: r.providerRunId,
          direction: 'outbound',
          toE164: phoneNumbers.normalizeE164(b.number) || null,
          status: (r.data && (r.data.status || r.data.state)) || 'queued',
          source: 'outbound_dial',
        });
        if (up && up.ok !== false) callRow = up.call;
      });
    }
    if (!callRow) {
      return core.sendJson(res, 502, {
        error: 'Call was placed but could not be tracked',
        code: 'call_not_tracked',
      });
    }
    const pub = calls.publicCall(callRow, agentsMapForTenant(ctx.tenant.id));
    core.sendJson(res, 200, { call: pub });
  } catch (e) {
    handleProviderError(res, e);
  }
}

/* ==========================================================================
   Phone Numbers control plane (Astra-first resources, tenant scoped)
   ========================================================================== */

function agentsMapForTenant(tenantId) {
  return new Map(
    core.db().agents.filter((a) => a.tenantId === tenantId).map((a) => [a.id, a]),
  );
}

function workflowsMapForTenant(tenantId) {
  return new Map(
    (core.db().workflows || []).filter((w) => w.tenantId === tenantId).map((w) => [w.id, w]),
  );
}

function employeesMapForTenant(tenantId) {
  return new Map(
    (core.db().employees || []).filter((e) => e.tenantId === tenantId).map((e) => [e.id, e]),
  );
}

function includeWorkflowProvider(ctx) {
  return !!(ctx && ctx.user && ctx.user.role === 'super_admin');
}

function serializeWorkflow(row, ctx) {
  return workflows.publicWorkflow(row, {
    includeProvider: includeWorkflowProvider(ctx),
    agentsById: agentsMapForTenant(ctx.tenant.id),
    assignedNumber: workflows.assignedNumberForWorkflow(core.db(), row),
  });
}

function serializePhoneNumber(n, tenantId) {
  return phoneNumbers.publicPhoneNumber(
    n,
    agentsMapForTenant(tenantId),
    workflowsMapForTenant(tenantId),
    employeesMapForTenant(tenantId),
  );
}

function apiPhoneNumbersList(req, res, ctx) {
  const url = new URL(req.url || '/', 'http://localhost');
  const q = url.searchParams.get('q') || url.searchParams.get('search') || '';
  const numbers = phoneNumbers.listTenantNumbers(core.db(), ctx.tenant.id, { q })
    .map((n) => serializePhoneNumber(n, ctx.tenant.id));
  core.sendJson(res, 200, { numbers });
}

async function apiPhoneNumbersAvailable(req, res, ctx) {
  try {
    const numbers = await telephonyProvider.listInventory(ctx.tenant.id);
    core.sendJson(res, 200, { numbers });
  } catch (e) {
    handleProviderError(res, e);
  }
}

async function apiPhoneNumbersAssign(req, res, ctx) {
  if (rejectImpersonated(res, ctx)) return;
  const b = ctx.body || {};
  const employeeId = String(b.employeeId || '').trim();
  const agentId = String(b.agentId || '').trim();
  if (!employeeId && !agentId) {
    return core.sendJson(res, 422, { error: 'employeeId or agentId is required', code: 'validation' });
  }
  try {
    const number = await telephonyProvider.assignNumber(ctx.params.id, ctx.tenant.id, {
      employeeId: employeeId || undefined,
      agentId: agentId || undefined,
      inboundEnabled: b.inboundEnabled,
      outboundEnabled: b.outboundEnabled,
      inboundWorkflowId: b.inboundWorkflowId,
      outboundWorkflowId: b.outboundWorkflowId,
    });
    await core.mutate((d) => {
      addAudit(d, ctx, 'phone_number.assigned', 'phone_number', number.id, {
        employeeId: number.assignedEmployeeId || employeeId || null,
        agentId: number.assignedAgentId || agentId || null,
        e164: number.e164,
        inboundWorkflowId: number.inboundWorkflowId || null,
        outboundWorkflowId: number.outboundWorkflowId || null,
      });
    });
    core.sendJson(res, 200, { number });
  } catch (e) {
    handleProviderError(res, e);
  }
}

async function apiPhoneNumbersUnassign(req, res, ctx) {
  if (rejectImpersonated(res, ctx)) return;
  try {
    const number = await telephonyProvider.unassignNumber(ctx.params.id, ctx.tenant.id);
    await core.mutate((d) => {
      addAudit(d, ctx, 'phone_number.unassigned', 'phone_number', number.id, {
        e164: number.e164,
      });
    });
    core.sendJson(res, 200, { number });
  } catch (e) {
    handleProviderError(res, e);
  }
}

async function apiPhoneNumbersPatch(req, res, ctx) {
  if (rejectImpersonated(res, ctx)) return;
  const b = ctx.body || {};
  let result;
  try {
    await core.mutate((d) => {
      result = phoneNumbers.patchNumber(d, {
        numberId: ctx.params.id,
        tenantId: ctx.tenant.id,
        inboundEnabled: b.inboundEnabled,
        outboundEnabled: b.outboundEnabled,
        inboundWorkflowId: b.inboundWorkflowId,
        outboundWorkflowId: b.outboundWorkflowId,
        inboundGreeting: b.inboundGreeting !== undefined ? b.inboundGreeting : b.greeting,
        inboundHours: b.inboundHours !== undefined ? b.inboundHours : b.hours,
        answer: b.answer,
        resolveProviderWorkflowId: workflows.resolveProviderWorkflowId,
      });
      if (result.ok) {
        addAudit(d, ctx, 'phone_number.updated', 'phone_number', result.number.id, {
          inboundEnabled: result.number.inboundEnabled,
          outboundEnabled: result.number.outboundEnabled,
          inboundWorkflowId: result.number.inboundWorkflowId || null,
          outboundWorkflowId: result.number.outboundWorkflowId || null,
        });
      }
    });
  } catch (e) {
    return handleProviderError(res, e);
  }
  if (!result.ok) {
    return core.sendJson(res, result.status, { error: result.error, code: result.code });
  }
  core.sendJson(res, 200, { number: serializePhoneNumber(result.number, ctx.tenant.id) });
}

function apiPhoneNumbersInboundGet(req, res, ctx) {
  const result = phoneNumbers.getInboundConfig(core.db(), ctx.tenant.id, ctx.params.id);
  if (!result.ok) return core.sendJson(res, result.status, { error: result.error, code: result.code });
  core.sendJson(res, 200, { inbound: result.inbound });
}

async function apiPhoneNumbersInboundPut(req, res, ctx) {
  if (rejectImpersonated(res, ctx)) return;
  let result;
  await core.mutate((d) => {
    result = phoneNumbers.setInboundConfig(d, ctx.tenant.id, ctx.params.id, ctx.body || {});
    if (result.ok) {
      addAudit(d, ctx, 'phone_number.inbound_updated', 'phone_number', ctx.params.id, {
        answer: result.inbound.answer,
        hasGreeting: !!(result.inbound.greeting || ''),
        hoursMode: result.inbound.hours && result.inbound.hours.mode,
      });
    }
  });
  if (!result.ok) return core.sendJson(res, result.status, { error: result.error, code: result.code });
  core.sendJson(res, 200, { inbound: result.inbound });
}

async function apiPhoneNumbersPurchase(req, res) {
  try {
    await telephonyProvider.purchaseNumber();
  } catch (e) {
    handleProviderError(res, e);
  }
}

function matchPhoneNumberRoute(route) {
  if (route === '/api/phone-numbers') return { action: 'list' };
  if (route === '/api/phone-numbers/available') return { action: 'available' };
  if (route === '/api/phone-numbers/purchase') return { action: 'purchase' };
  const assign = route.match(/^\/api\/phone-numbers\/([^/]+)\/assign$/);
  if (assign) return { action: 'assign', id: decodeURIComponent(assign[1]) };
  const unassign = route.match(/^\/api\/phone-numbers\/([^/]+)\/unassign$/);
  if (unassign) return { action: 'unassign', id: decodeURIComponent(unassign[1]) };
  const inbound = route.match(/^\/api\/phone-numbers\/([^/]+)\/inbound$/);
  if (inbound) return { action: 'inbound', id: decodeURIComponent(inbound[1]) };
  const one = route.match(/^\/api\/phone-numbers\/([^/]+)$/);
  if (one) return { action: 'one', id: decodeURIComponent(one[1]) };
  return null;
}

/* ==========================================================================
   Calls control plane (tenant-scoped history + Dograh sync)
   ========================================================================== */

function matchCallsRoute(route) {
  // Conversations is the customer-facing alias for Calls (Phase 12).
  if (route === '/api/calls' || route === '/api/conversations') return { action: 'list' };
  if (route === '/api/calls/sync' || route === '/api/conversations/sync') return { action: 'sync' };
  const recording = route.match(/^\/api\/(?:calls|conversations)\/([^/]+)\/recording$/);
  if (recording) return { action: 'recording', id: decodeURIComponent(recording[1]) };
  const one = route.match(/^\/api\/(?:calls|conversations)\/([^/]+)$/);
  if (one) return { action: 'detail', id: decodeURIComponent(one[1]) };
  return null;
}

async function apiCallsList(req, res, ctx) {
  try {
    const url = new URL(req.url || '/', 'http://localhost');
    const filters = {
      agentId: url.searchParams.get('agentId') || undefined,
      employeeId: url.searchParams.get('employeeId') || undefined,
      direction: url.searchParams.get('direction') || undefined,
      status: url.searchParams.get('status') || undefined,
      outcome: url.searchParams.get('outcome') || undefined,
      limit: url.searchParams.get('limit') || undefined,
    };
    const list = await telephonyProvider.listCalls(ctx.tenant.id, filters);
    // Prefer Conversations language when requested via /api/conversations.
    const asConversations = String(req.url || '').includes('/api/conversations');
    if (asConversations) {
      core.sendJson(res, 200, {
        conversations: list,
        count: list.length,
        empty: list.length === 0,
      });
    } else {
      core.sendJson(res, 200, { calls: list, count: list.length, empty: list.length === 0 });
    }
  } catch (e) {
    handleProviderError(res, e);
  }
}

async function apiCallsDetail(req, res, ctx) {
  try {
    const call = await telephonyProvider.getCall(ctx.params.id, ctx.tenant.id);
    const asConversations = String(req.url || '').includes('/api/conversations');
    if (asConversations) core.sendJson(res, 200, { conversation: call });
    else core.sendJson(res, 200, { call });
  } catch (e) {
    handleProviderError(res, e);
  }
}

async function apiCallsSync(req, res, ctx) {
  if (rejectImpersonated(res, ctx)) return;
  try {
    const body = ctx.body || {};
    const result = await telephonyProvider.syncCalls(ctx.tenant.id, {
      limit: body.limit,
      import: body.import,
    });
    await core.mutate((d) => {
      addAudit(d, ctx, 'calls.synced', 'calls', null, {
        stubbed: result.stubbed,
        fetched: result.fetched,
        created: result.created,
        updated: result.updated,
      });
    });
    core.sendJson(res, 200, result);
  } catch (e) {
    handleProviderError(res, e);
  }
}

async function apiCallsRecording(req, res, ctx) {
  try {
    const result = await telephonyProvider.getRecording(ctx.params.id, ctx.tenant.id);
    if (result.mode === 'redirect' && result.url) {
      res.writeHead(302, {
        Location: result.url,
        'Cache-Control': 'private, no-store',
      });
      return res.end();
    }
    if (result.mode === 'proxy' && result.buffer) {
      res.writeHead(200, {
        'Content-Type': result.contentType || 'audio/mpeg',
        'Content-Length': result.buffer.length,
        'Cache-Control': 'private, max-age=60',
      });
      return res.end(result.buffer);
    }
    return core.sendJson(res, 404, { error: 'recording not available', code: 'recording_not_found' });
  } catch (e) {
    handleProviderError(res, e);
  }
}

/* ==========================================================================
   Workflows control plane (Astra-first, Dograh execution mapping)
   ========================================================================== */

function matchWorkflowRoute(route) {
  if (route === '/api/workflow-templates') return { action: 'templates' };
  if (route === '/api/workflows') return { action: 'list_or_create' };
  if (route === '/api/workflows/import') return { action: 'import' };
  const publish = route.match(/^\/api\/workflows\/([^/]+)\/publish$/);
  if (publish) return { action: 'publish', id: decodeURIComponent(publish[1]) };
  const one = route.match(/^\/api\/workflows\/([^/]+)$/);
  if (one) return { action: 'one', id: decodeURIComponent(one[1]) };
  return null;
}

function apiWorkflowTemplates(req, res) {
  core.sendJson(res, 200, { templates: workflows.listTemplates() });
}

async function apiWorkflowsList(req, res, ctx) {
  await core.mutate((d) => { workflows.seedTenantReceptionist(d, ctx.tenant.id, ctx.user.id); });
  core.sendJson(res, 200, {
    workflows: workflows.listWorkflows(core.db(), ctx.tenant.id).map((w) => serializeWorkflow(w, ctx)),
  });
}

async function apiWorkflowsGet(req, res, ctx) {
  await core.mutate((d) => { workflows.seedTenantReceptionist(d, ctx.tenant.id, ctx.user.id); });
  const row = workflows.findWorkflow(core.db(), ctx.tenant.id, ctx.params.id);
  if (!row) return core.sendJson(res, 404, { error: 'workflow not found', code: 'not_found' });
  core.sendJson(res, 200, { workflow: serializeWorkflow(row, ctx) });
}

async function apiWorkflowsCreate(req, res, ctx) {
  if (rejectImpersonated(res, ctx)) return;
  let result;
  await core.mutate((d) => {
    result = workflows.createWorkflow(d, ctx.tenant.id, ctx.body || {}, ctx.user.id);
    if (result.ok) {
      addAudit(d, ctx, 'workflow.created', 'workflow', result.workflow.id, {
        name: result.workflow.name,
        templateKey: result.workflow.templateKey,
      });
    }
  });
  if (!result.ok) return core.sendJson(res, result.status, { error: result.error, code: result.code });
  core.sendJson(res, 201, { workflow: serializeWorkflow(result.workflow, ctx) });
}

async function apiWorkflowsPatch(req, res, ctx) {
  if (rejectImpersonated(res, ctx)) return;
  let result;
  await core.mutate((d) => {
    result = workflows.updateWorkflow(d, ctx.tenant.id, ctx.params.id, ctx.body || {});
    if (result.ok) {
      addAudit(d, ctx, 'workflow.updated', 'workflow', result.workflow.id, {
        name: result.workflow.name,
        status: result.workflow.status,
      });
    }
  });
  if (!result.ok) return core.sendJson(res, result.status, { error: result.error, code: result.code });
  core.sendJson(res, 200, { workflow: serializeWorkflow(result.workflow, ctx) });
}

async function apiWorkflowsPublish(req, res, ctx) {
  if (rejectImpersonated(res, ctx)) return;
  const b = ctx.body || {};
  try {
    // Ensure the row exists before provider publish.
    const existing = workflows.findWorkflow(core.db(), ctx.tenant.id, ctx.params.id);
    if (!existing) return core.sendJson(res, 404, { error: 'workflow not found', code: 'not_found' });

    const result = await workflowProvider.publishWorkflow(ctx.tenant.id, ctx.params.id, {
      providerWorkflowId: b.providerWorkflowId,
    });
    await core.mutate((d) => {
      addAudit(d, ctx, 'workflow.published', 'workflow', ctx.params.id, {
        syncStatus: result.syncStatus,
        providerWorkflowId: includeWorkflowProvider(ctx) ? result.providerWorkflowId : undefined,
      });
    });
    const row = workflows.findWorkflow(core.db(), ctx.tenant.id, ctx.params.id);
    core.sendJson(res, 200, {
      workflow: serializeWorkflow(row, ctx),
      syncStatus: result.syncStatus,
      syncError: includeWorkflowProvider(ctx) ? result.syncError : (result.syncError ? 'Provider sync reported an issue. Ask a Super Admin for details.' : null),
    });
  } catch (e) {
    handleProviderError(res, e);
  }
}

async function apiWorkflowsImport(req, res, ctx) {
  if (rejectImpersonated(res, ctx)) return;
  if (!core.hasRole(ctx.user, 'owner')) {
    return core.sendJson(res, 403, { error: 'owner or admin required to import workflows', code: 'forbidden' });
  }
  const b = ctx.body || {};
  const providerWorkflowId = String(b.providerWorkflowId || '').trim();
  if (!providerWorkflowId) {
    return core.sendJson(res, 422, { error: 'providerWorkflowId is required', code: 'validation' });
  }

  // Best-effort fetch remote definition for graph seed.
  let remoteGraph = null;
  let remoteName = null;
  try {
    const remote = await workflowProvider.getWorkflow(providerWorkflowId);
    if (remote && remote.workflow) {
      remoteName = remote.workflow.name || remote.workflow.title || null;
      if (remote.workflow.definition || remote.workflow.graph || remote.workflow.nodes) {
        remoteGraph = remote.workflow.definition || remote.workflow.graph
          || { nodes: remote.workflow.nodes, edges: remote.workflow.edges || [] };
      }
    }
  } catch (_) { /* soft */ }

  let result;
  await core.mutate((d) => {
    result = workflows.importFromProvider(d, ctx.tenant.id, {
      providerWorkflowId,
      name: b.name || remoteName || undefined,
      description: b.description,
      templateKey: b.templateKey || 'receptionist',
      direction: b.direction,
      graphJson: b.graphJson || remoteGraph || undefined,
      agentId: b.agentId,
      syncStatus: 'imported',
    }, ctx.user.id);
    if (result.ok) {
      addAudit(d, ctx, 'workflow.imported', 'workflow', result.workflow.id, {
        providerWorkflowId: includeWorkflowProvider(ctx) ? providerWorkflowId : undefined,
        created: result.created,
      });
    }
  });
  if (!result.ok) return core.sendJson(res, result.status, { error: result.error, code: result.code });
  core.sendJson(res, result.created ? 201 : 200, {
    workflow: serializeWorkflow(result.workflow, ctx),
    created: result.created,
  });
}

// POST /api/callback (alias /api/outbound/callback). Shared-secret outbound trigger.
// Body: { phone, when?, name?, note?, source? }. Never accepts provider API keys.
async function apiOutboundCallback(req, res, body) {
  const auth = callback.authorizeCallback(req.headers['x-callback-secret'], process.env.CALLBACK_SECRET);
  if (!auth.ok) {
    return core.sendJson(res, auth.status, { ok: false, error: auth.error, code: auth.code });
  }
  const parsed = callback.parseCallbackRequest(body);
  if (!parsed.ok) {
    return core.sendJson(res, parsed.status, { ok: false, error: parsed.error, code: parsed.code });
  }

  if (parsed.whenInfo.mode === 'scheduled') {
    const job = {
      id: core.genId('cbjob_'),
      phone: parsed.phone,
      when: parsed.whenInfo.when,
      name: parsed.name || '',
      note: parsed.note || '',
      source: parsed.source || '',
      status: 'pending',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      call_id: null,
      error: null,
    };
    await core.mutate((d) => {
      d.callbackJobs.push(job);
    });
    return core.sendJson(res, 202, {
      ok: true,
      scheduled: true,
      job_id: job.id,
      when: job.when,
      phone: job.phone,
    });
  }

  try {
    const r = await providers.telephony.initiateCall(parsed.phone);
    const summary = callback.summarizeCallResult(r.data);
    return core.sendJson(res, 200, {
      ok: true,
      scheduled: false,
      call_id: summary.call_id,
      dograh: summary,
      phone: parsed.phone,
      name: parsed.name || undefined,
      source: parsed.source || undefined,
    });
  } catch (e) {
    if (e instanceof providers.ProviderError) {
      return core.sendJson(res, e.status || 502, {
        ok: false,
        error: e.message,
        code: e.code || 'provider_error',
        detail: e.detail,
      });
    }
    return core.sendJson(res, 502, { ok: false, error: String((e && e.message) || e), code: 'upstream' });
  }
}

const CALLBACK_POLL_MS = 15000;
let _callbackPollBusy = false;

async function processDueCallbackJobs(nowMs = Date.now()) {
  if (_callbackPollBusy) return;
  _callbackPollBusy = true;
  try {
    const due = (core.db().callbackJobs || []).filter((job) => (
      job.status === 'pending' && Date.parse(job.when) <= nowMs
    ));
    for (const job of due) {
      try {
        const r = await providers.telephony.initiateCall(job.phone);
        const summary = callback.summarizeCallResult(r.data);
        await core.mutate((d) => {
          const row = d.callbackJobs.find((j) => j.id === job.id);
          if (!row || row.status !== 'pending') return;
          row.status = 'completed';
          row.call_id = summary.call_id;
          row.updatedAt = new Date().toISOString();
          row.error = null;
        });
      } catch (e) {
        const message = e instanceof providers.ProviderError
          ? e.message
          : String((e && e.message) || e);
        await core.mutate((d) => {
          const row = d.callbackJobs.find((j) => j.id === job.id);
          if (!row || row.status !== 'pending') return;
          row.status = 'failed';
          row.error = message.slice(0, 300);
          row.updatedAt = new Date().toISOString();
        });
      }
    }
  } finally {
    _callbackPollBusy = false;
  }
}

function startCallbackJobPoller() {
  setInterval(() => {
    processDueCallbackJobs().catch((err) => {
      console.error('  callback job poller:', err && err.message ? err.message : err);
    });
  }, CALLBACK_POLL_MS);
}

// GET /api/usage -> tenant scoped daily rows + totals, with a rough INR cost.
function apiUsage(req, res, ctx) {
  const rows = core.db().usage
    .filter((u) => u.tenantId === ctx.tenant.id)
    .sort((a, b) => (a.day < b.day ? -1 : 1));
  // Economics estimate for the promotional AI layer. Telephony and other
  // carrier-inclusive costs are tracked separately and are not implied here.
  const INR_PER_1K_CHARS = 0.12;
  const INR_PER_CALL = 0.9;
  const days = rows.map((r) => ({
    day: r.day,
    chars: r.chars || 0,
    calls: r.calls || 0,
    llmTokens: r.llmTokens || 0,
    costInr: Math.round(((r.chars || 0) / 1000 * INR_PER_1K_CHARS + (r.calls || 0) * INR_PER_CALL) * 100) / 100,
  }));
  const totals = days.reduce((acc, d) => ({
    chars: acc.chars + d.chars,
    calls: acc.calls + d.calls,
    llmTokens: acc.llmTokens + d.llmTokens,
    costInr: Math.round((acc.costInr + d.costInr) * 100) / 100,
  }), { chars: 0, calls: 0, llmTokens: 0, costInr: 0 });
  core.sendJson(res, 200, { days, totals });
}

function apiAgentTypes(req, res) {
  core.sendJson(res, 200, { agentTypes: AGENT_TYPES.map((t) => ({ ...t, recommendedPresetIds: [...t.recommendedPresetIds] })) });
}

function apiPresets(req, res, ctx) {
  const presets = core.db().presets
    .filter((p) => p.isSystem || p.tenantId === ctx.tenant.id)
    .map(publicPreset);
  core.sendJson(res, 200, { presets });
}

function apiWallet(req, res, ctx) {
  const d = core.db();
  const wallet = d.wallets.find((w) => w.tenantId === ctx.tenant.id);
  const ledger = d.ledger.filter((x) => x.tenantId === ctx.tenant.id).slice(-100).reverse();
  const usage = d.usage.filter((x) => x.tenantId === ctx.tenant.id).slice(-30);
  const plan = plans.publicPlan(ctx.tenant.plan || 'starter');
  const entitlements = plans.publicEntitlements(d, ctx.tenant);
  core.sendJson(res, 200, {
    wallet: publicWallet(wallet || { id: null, tenantId: ctx.tenant.id, currency: 'INR', balancePaise: 0 }),
    ledger,
    plan,
    entitlements,
    packs: Object.keys(CREDIT_PACKS).map((id) => ({
      id,
      amountInr: Number(CREDIT_PACKS[id].amount),
      creditsPaise: CREDIT_PACKS[id].credits,
      productinfo: CREDIT_PACKS[id].productinfo,
    })),
    usageDays: usage,
    payuEnv: (payuConfig() && payuConfig().env) || (process.env.PAYU_ENV === 'production' ? 'production' : 'test'),
    payuConfigured: !!payuConfig(),
    // Customer packaging never surfaces provider invoices.
    providerInvoices: null,
  });
}

function apiBillingEntitlements(req, res, ctx) {
  const entitlements = plans.publicEntitlements(core.db(), ctx.tenant);
  core.sendJson(res, 200, { entitlements, plan: plans.publicPlan(ctx.tenant.plan || 'starter') });
}

function apiPlansList(req, res) {
  core.sendJson(res, 200, { plans: plans.listPlans().map((p) => plans.publicPlan(p.id)) });
}

async function apiPlansUpgrade(req, res, ctx) {
  if (rejectImpersonated(res, ctx)) return;
  const planId = String((ctx.body || {}).planId || '');
  if (!plans.PLANS[planId]) return core.sendJson(res, 422, { error: 'unknown plan', code: 'bad_plan' });
  let result;
  await core.mutate((d) => {
    result = plans.upgradePlan(d, ctx.tenant.id, planId, ctx.user.id, addLedgerEntry);
    if (result.ok && result.granted) addAudit(d, ctx, 'billing.plan.upgraded', 'tenant', ctx.tenant.id, { planId });
  });
  if (!result.ok) return core.sendJson(res, result.status, { error: result.error, code: result.code });
  core.sendJson(res, 200, result);
}

function apiPaymentIntents(req, res, ctx) {
  const intents = core.db().paymentIntents.filter((x) => x.tenantId === ctx.tenant.id).map((x) => ({ ...x, gatewayPayload: undefined, intentToken: undefined, customer: undefined }));
  core.sendJson(res, 200, { paymentIntents: intents });
}

async function apiPaymentIntentCreate(req, res, ctx) {
  if (rejectImpersonated(res, ctx)) return;
  const b = ctx.body || {};
  const packId = String(b.packId || '');
  let base;
  try { base = payu.createPaymentIntent({ packId, packs: CREDIT_PACKS, tenantId: ctx.tenant.id, userId: ctx.user.id }); }
  catch (e) { return core.sendJson(res, 422, { error: e.message, code: 'bad_pack' }); }
  const customer = { firstname: String(b.firstname || ctx.user.name || 'Customer').trim().slice(0, 60), email: ctx.user.email, phone: String(b.phone || '').trim().slice(0, 20) };
  const intent = { id: core.genId('pay_'), provider: 'payu', ...base, customer, amountPaise: Math.round(Number(base.amount) * 100), updatedAt: base.createdAt };
  let checkout = null; const cfg = payuConfig();
  if (cfg && process.env.RAPIDX_PUBLIC_URL) {
    try {
      const origin = String(process.env.RAPIDX_PUBLIC_URL).replace(/\/$/, '');
      checkout = payu.buildCheckout({ intent, customer, successUrl: `${origin}/api/payu/callback`, failureUrl: `${origin}/api/payu/return`, config: cfg });
    } catch (e) { return core.sendJson(res, 503, { error: 'PayU checkout configuration is invalid', code: 'payu_config' }); }
  }
  await core.mutate((d) => { d.paymentIntents.push(intent); addAudit(d, ctx, 'billing.payment_intent.created', 'payment_intent', intent.id, { packId, amountPaise: intent.amountPaise }); });
  core.sendJson(res, 201, { paymentIntent: { ...intent, intentToken: undefined, customer: undefined }, checkoutReady: !!checkout, checkout, message: checkout ? undefined : 'PayU is not configured. The intent is saved but cannot be paid yet.' });
}

async function apiPayuCallback(req, res, payload) {
  const cfg = payuConfig();
  if (!cfg) return core.sendJson(res, 503, { error: 'PayU is not configured', code: 'payu_unavailable' });
  const intent = core.db().paymentIntents.find((x) => x.txnid === String(payload.txnid || ''));
  const eventId = core.genId('pevt_');
  const safePayload = Object.fromEntries(Object.entries(payload || {}).filter(([k]) => !/hash|salt|key|card|token/i.test(k)).map(([k, v]) => [k, String(v).slice(0, 500)]));
  if (!intent) {
    await core.mutate((d) => d.paymentEvents.push({ id: eventId, provider: 'payu', txnid: String(payload.txnid || ''), status: 'rejected', reason: 'intent_not_found', payload: safePayload, createdAt: new Date().toISOString() }));
    return core.sendJson(res, 404, { error: 'payment intent not found', code: 'not_found' });
  }
  const callback = payu.verifyCallback({ payload, intent, customer: intent.customer, config: cfg });
  await core.mutate((d) => d.paymentEvents.push({ id: eventId, provider: 'payu', tenantId: intent.tenantId, paymentIntentId: intent.id, txnid: intent.txnid, status: callback.valid ? 'verified_hash' : 'rejected', reason: callback.reason, payload: safePayload, createdAt: new Date().toISOString() }));
  if (!callback.valid || !callback.creditable) return core.sendJson(res, 400, { error: callback.reason, code: 'payu_callback_rejected' });
  let verification;
  try { verification = await payu.verifyPayment({ intent, config: cfg }); }
  catch (_) { return core.sendJson(res, 502, { error: 'PayU verification unavailable', code: 'payu_verify_failed' }); }
  if (!verification.verified) return core.sendJson(res, 409, { error: verification.reason, code: 'payu_not_verified' });
  let entry; let duplicate = false;
  await core.mutate((d) => {
    const stored = d.paymentIntents.find((x) => x.id === intent.id);
    if (stored.status === 'credited') { duplicate = true; return; }
    entry = addLedgerEntry(d, stored.tenantId, stored.credits, 'payment_credit', `payu:${stored.txnid}`, stored.userId, { paymentIntentId: stored.id, payuId: verification.payuId, packId: stored.packId });
    if (!entry) { duplicate = true; stored.status = 'credited'; return; }
    stored.status = 'credited'; stored.payuId = verification.payuId; stored.updatedAt = new Date().toISOString();
    d.auditEvents.push({ id: core.genId('aud_'), tenantId: stored.tenantId, actorUserId: stored.userId, action: 'billing.payment.credited', targetType: 'payment_intent', targetId: stored.id, metadata: { ledgerId: entry.id }, createdAt: stored.updatedAt });
  });
  core.sendJson(res, 200, { ok: true, credited: !duplicate, duplicate });
}

function apiPayuReturn(req, res, payload) {
  const result = payu.classifyBrowserReturn(payload);
  core.sendJson(res, 202, { ...result, message: 'Payment is pending server verification. A browser return never credits the wallet.' });
}

function apiSupportList(req, res, ctx) {
  const d = core.db();
  const tickets = d.supportTickets.filter((x) => x.tenantId === ctx.tenant.id).map((t) => ({ ...t, messages: d.supportMessages.filter((m) => m.ticketId === t.id && m.tenantId === ctx.tenant.id && !m.internal) }));
  core.sendJson(res, 200, { tickets });
}

async function apiSupportCreate(req, res, ctx) {
  const b = ctx.body || {};
  const subject = String(b.subject || '').trim().slice(0, 120);
  const message = String(b.message || '').trim().slice(0, 5000);
  if (!subject || !message) return core.sendJson(res, 422, { error: 'subject and message required', code: 'bad_ticket' });
  const now = new Date().toISOString();
  const ticket = { id: core.genId('tic_'), tenantId: ctx.tenant.id, createdBy: ctx.user.id, subject, priority: ['low', 'normal', 'high', 'urgent'].includes(b.priority) ? b.priority : 'normal', status: 'open', createdAt: now, updatedAt: now };
  const first = { id: core.genId('msg_'), ticketId: ticket.id, tenantId: ctx.tenant.id, authorUserId: ctx.user.id, body: message, internal: false, createdAt: now };
  await core.mutate((d) => { d.supportTickets.push(ticket); d.supportMessages.push(first); addAudit(d, ctx, 'support.ticket.created', 'ticket', ticket.id); });
  core.sendJson(res, 201, { ticket: { ...ticket, messages: [first] } });
}

async function apiSupportReply(req, res, ctx) {
  const b = ctx.body || {};
  const ticket = core.db().supportTickets.find((t) => t.id === String(b.ticketId || '') && t.tenantId === ctx.tenant.id);
  if (!ticket) return core.sendJson(res, 404, { error: 'ticket not found', code: 'not_found' });
  const text = String(b.message || '').trim().slice(0, 5000);
  if (!text) return core.sendJson(res, 422, { error: 'message required', code: 'bad_message' });
  const msg = { id: core.genId('msg_'), ticketId: ticket.id, tenantId: ctx.tenant.id, authorUserId: ctx.user.id, body: text, internal: false, createdAt: new Date().toISOString() };
  await core.mutate((d) => { d.supportMessages.push(msg); const t = d.supportTickets.find((x) => x.id === ticket.id); t.updatedAt = msg.createdAt; addAudit(d, ctx, 'support.ticket.replied', 'ticket', ticket.id); });
  core.sendJson(res, 201, { message: msg });
}

function apiByonList(req, res, ctx) {
  const connections = core.db().byonConnections.filter((x) => x.tenantId === ctx.tenant.id).map((x) => ({ ...x, credentials: undefined }));
  core.sendJson(res, 200, { connections });
}

function apiPrivacyGet(req, res, ctx) { core.sendJson(res, 200, { mode: ctx.tenant.privacyMode || 'standard' }); }

async function apiByonSave(req, res, ctx) {
  const b = ctx.body || {};
  const provider = String(b.provider || '').toLowerCase();
  if (!['vobiz', 'twilio', 'telnyx', 'plivo', 'vonage', 'sip'].includes(provider)) return core.sendJson(res, 422, { error: 'unsupported BYON provider', code: 'bad_provider' });
  const address = String(b.address || '').replace(/[^0-9+]/g, '').slice(0, 32);
  if (!address) return core.sendJson(res, 422, { error: 'phone address required', code: 'bad_address' });
  const connection = { id: core.genId('byon_'), tenantId: ctx.tenant.id, provider, address, label: String(b.label || '').slice(0, 64), status: 'pending_verification', createdBy: ctx.user.id, createdAt: new Date().toISOString() };
  await core.mutate((d) => { d.byonConnections.push(connection); addAudit(d, ctx, 'telephony.byon.created', 'byon_connection', connection.id, { provider, address }); });
  core.sendJson(res, 201, { connection });
}

async function apiPrivacyMode(req, res, ctx) {
  const mode = String((ctx.body || {}).mode || '');
  if (!['standard', 'metadata_only', 'no_recording'].includes(mode)) return core.sendJson(res, 422, { error: 'invalid privacy mode', code: 'bad_privacy_mode' });
  await core.mutate((d) => { const t = d.tenants.find((x) => x.id === ctx.tenant.id); t.privacyMode = mode; addAudit(d, ctx, 'tenant.privacy_mode.updated', 'tenant', t.id, { mode }); });
  core.sendJson(res, 200, { mode });
}

function apiMembers(req, res, ctx) {
  core.sendJson(res, 200, { users: core.db().users.filter((u) => u.tenantId === ctx.tenant.id).map(publicUser) });
}

function apiAudit(req, res, ctx) {
  const events = core.db().auditEvents
    .filter((e) => e.tenantId === ctx.tenant.id)
    .slice(-200)
    .reverse()
    .map(org.publicAuditEvent);
  core.sendJson(res, 200, { auditEvents: events });
}

async function apiTenantUpdate(req, res, ctx) {
  if (rejectImpersonated(res, ctx)) return;
  const parsed = org.sanitizeTenantUpdate(ctx.body || {});
  if (!parsed.ok) return core.sendJson(res, parsed.status, { error: parsed.error, code: parsed.code });
  let tenant;
  await core.mutate((d) => {
    const row = d.tenants.find((t) => t.id === ctx.tenant.id);
    if (!row) throw new Error('tenant missing');
    row.name = parsed.name;
    if (parsed.color) row.branding = Object.assign({}, row.branding || {}, { color: parsed.color });
    addAudit(d, ctx, 'tenant.updated', 'tenant', row.id, { name: row.name });
    tenant = row;
  });
  core.sendJson(res, 200, { tenant: publicTenant(tenant) });
}

function apiAdminProviderHealth(req, res) {
  const described = providers.describeProviders();
  const health = org.providerHealthSummary(described);
  const check = org.assertNoSecretValues(health);
  if (!check.ok) {
    return core.sendJson(res, 500, { error: 'provider health refused to leak secrets', code: 'secret_guard' });
  }
  core.sendJson(res, 200, { providers: health });
}

// GET /api/admin/diagnostics -> Super Admin diagnostics console (Phase 21).
// Provider inventory + tenant overview. Customers never receive this payload.
function apiAdminDiagnostics(req, res) {
  const id = currentDeployIdentity();
  const payload = org.buildDiagnosticsConsole({
    described: providers.describeProviders(),
    db: core.db(),
    deploy: { gitSha: id.gitSha, deployedAt: id.deployedAt, ref: id.ref },
    uptimeSec: (Date.now() - STARTED_AT_MS) / 1000,
    version: APP_VERSION,
  });
  const check = org.assertNoSecretValues(payload);
  if (!check.ok) {
    return core.sendJson(res, 500, { error: 'diagnostics refused to leak secrets', code: 'secret_guard' });
  }
  core.sendJson(res, 200, { diagnostics: payload });
}

/* ==========================================================================
   Knowledge Base + Integrations (Sprint 4)
   ========================================================================== */

function apiKnowledgeList(req, res, ctx) {
  const entries = knowledge.listTenantEntries(core.db(), ctx.tenant.id).map(knowledge.publicKnowledgeEntry);
  core.sendJson(res, 200, { entries });
}

async function apiKnowledgeCreate(req, res, ctx) {
  if (rejectImpersonated(res, ctx)) return;
  let result;
  await core.mutate((d) => {
    result = knowledge.createEntry(d, ctx.tenant.id, ctx.body || {}, ctx.user.id);
    if (result.ok) addAudit(d, ctx, 'knowledge.created', 'knowledge_entry', result.entry.id, { title: result.entry.title });
  });
  if (!result.ok) return core.sendJson(res, result.status, { error: result.error, code: result.code });
  core.sendJson(res, 201, { entry: knowledge.publicKnowledgeEntry(result.entry) });
}

async function apiKnowledgeUpdate(req, res, ctx) {
  if (rejectImpersonated(res, ctx)) return;
  const id = String((ctx.body && ctx.body.id) || ctx.params && ctx.params.id || '');
  let result;
  await core.mutate((d) => {
    result = knowledge.updateEntry(d, ctx.tenant.id, id, ctx.body || {});
    if (result.ok) addAudit(d, ctx, 'knowledge.updated', 'knowledge_entry', result.entry.id, { status: result.entry.status });
  });
  if (!result.ok) return core.sendJson(res, result.status, { error: result.error, code: result.code });
  core.sendJson(res, 200, { entry: knowledge.publicKnowledgeEntry(result.entry) });
}

async function apiKnowledgeDelete(req, res, ctx) {
  if (rejectImpersonated(res, ctx)) return;
  const id = String((ctx.body && ctx.body.id) || '');
  let result;
  await core.mutate((d) => {
    result = knowledge.deleteEntry(d, ctx.tenant.id, id);
    if (result.ok) addAudit(d, ctx, 'knowledge.deleted', 'knowledge_entry', id);
  });
  if (!result.ok) return core.sendJson(res, result.status, { error: result.error, code: result.code });
  core.sendJson(res, 200, { ok: true });
}

function apiKnowledgeRetrieve(req, res, ctx) {
  const url = new URL(req.url, 'http://localhost');
  const q = String(url.searchParams.get('q') || (ctx.body && ctx.body.q) || '').trim();
  const limit = Number(url.searchParams.get('limit') || (ctx.body && ctx.body.limit) || 5);
  const hits = knowledge.retrieveForQuery(core.db(), ctx.tenant.id, q, limit);
  core.sendJson(res, 200, { hits, query: q });
}

function apiIntegrationsList(req, res, ctx) {
  const webhooks = integrations.listWebhooks(core.db(), ctx.tenant.id).map(integrations.publicWebhook);
  core.sendJson(res, 200, {
    webhooks,
    crm: integrations.listCrmConnectors(),
    events: [...integrations.WEBHOOK_EVENTS],
  });
}

async function apiIntegrationsWebhookCreate(req, res, ctx) {
  if (rejectImpersonated(res, ctx)) return;
  let result;
  await core.mutate((d) => {
    result = integrations.createWebhook(d, ctx.tenant.id, ctx.body || {}, ctx.user.id);
    if (result.ok) addAudit(d, ctx, 'integrations.webhook.created', 'webhook', result.webhook.id, { events: result.webhook.events });
  });
  if (!result.ok) return core.sendJson(res, result.status, { error: result.error, code: result.code });
  core.sendJson(res, 201, {
    webhook: integrations.publicWebhook(result.webhook),
    secretOnce: result.secretOnce,
    message: 'Copy the secret now. Only its hash is stored.',
  });
}

async function apiIntegrationsWebhookUpdate(req, res, ctx) {
  if (rejectImpersonated(res, ctx)) return;
  const id = String((ctx.body && ctx.body.id) || '');
  let result;
  await core.mutate((d) => {
    result = integrations.updateWebhook(d, ctx.tenant.id, id, ctx.body || {});
    if (result.ok) addAudit(d, ctx, 'integrations.webhook.updated', 'webhook', result.webhook.id);
  });
  if (!result.ok) return core.sendJson(res, result.status, { error: result.error, code: result.code });
  core.sendJson(res, 200, {
    webhook: integrations.publicWebhook(result.webhook),
    secretOnce: result.secretOnce,
  });
}

async function apiIntegrationsWebhookDelete(req, res, ctx) {
  if (rejectImpersonated(res, ctx)) return;
  const id = String((ctx.body && ctx.body.id) || '');
  let result;
  await core.mutate((d) => {
    result = integrations.deleteWebhook(d, ctx.tenant.id, id);
    if (result.ok) addAudit(d, ctx, 'integrations.webhook.deleted', 'webhook', id);
  });
  if (!result.ok) return core.sendJson(res, result.status, { error: result.error, code: result.code });
  core.sendJson(res, 200, { ok: true });
}

async function apiIntegrationsLeadCreated(req, res, ctx) {
  if (rejectImpersonated(res, ctx)) return;
  const b = ctx.body || {};
  const lead = {
    name: String(b.name || '').trim().slice(0, 120),
    phone: String(b.phone || '').trim().slice(0, 32),
    email: String(b.email || '').trim().slice(0, 160),
    meta: b.meta && typeof b.meta === 'object' ? b.meta : {},
  };
  if (!lead.phone && !lead.email) {
    return core.sendJson(res, 422, { error: 'phone or email required', code: 'bad_lead' });
  }
  let queued = 0;
  await core.mutate((d) => {
    const targets = integrations.listWebhooks(d, ctx.tenant.id)
      .filter((w) => w.status === 'active' && (w.events || []).includes('lead.created'));
    queued = targets.length;
    const ts = new Date().toISOString();
    for (const wh of targets) {
      wh.lastDeliveryAt = ts;
      wh.lastDeliveryStatus = 'stub_queued';
    }
    addAudit(d, ctx, 'integrations.lead.created', 'lead', lead.phone || lead.email, { webhookCount: queued });
  });
  core.sendJson(res, 202, { ok: true, queued, lead, message: 'lead.created queued to matching webhooks (stub delivery).' });
}

/* ==========================================================================
   Campaigns + Analytics (Sprint 5)
   ========================================================================== */

function apiCampaignsList(req, res, ctx) {
  core.sendJson(res, 200, { campaigns: campaigns.listCampaigns(core.db(), ctx.tenant.id) });
}

async function apiCampaignsCreate(req, res, ctx) {
  if (rejectImpersonated(res, ctx)) return;
  let result;
  await core.mutate((d) => {
    result = campaigns.createCampaign(d, ctx.tenant.id, ctx.body || {}, ctx.user.id);
    if (result.ok) addAudit(d, ctx, 'campaign.created', 'campaign', result.campaign.id, { name: result.campaign.name });
  });
  if (!result.ok) return core.sendJson(res, result.status, { error: result.error, code: result.code });
  core.sendJson(res, 201, { campaign: campaigns.publicCampaign(result.campaign, campaigns.countLeads(core.db(), result.campaign.id)) });
}

async function apiCampaignsAddLeads(req, res, ctx) {
  if (rejectImpersonated(res, ctx)) return;
  const b = ctx.body || {};
  const id = String(b.campaignId || b.id || '');
  let result;
  await core.mutate((d) => {
    result = campaigns.addLeads(d, ctx.tenant.id, id, b.leads != null ? b.leads : b.text);
    if (result.ok) addAudit(d, ctx, 'campaign.leads.added', 'campaign', id, { added: result.added });
  });
  if (!result.ok) return core.sendJson(res, result.status, { error: result.error, code: result.code });
  core.sendJson(res, 200, result);
}

async function apiCampaignsStatus(req, res, ctx) {
  if (rejectImpersonated(res, ctx)) return;
  const b = ctx.body || {};
  const id = String(b.campaignId || b.id || '');
  let result;
  await core.mutate((d) => {
    result = campaigns.setCampaignStatus(d, ctx.tenant.id, id, String(b.status || ''));
    if (result.ok) addAudit(d, ctx, 'campaign.status', 'campaign', id, { status: result.campaign.status });
  });
  if (!result.ok) return core.sendJson(res, result.status, { error: result.error, code: result.code });
  core.sendJson(res, 200, { campaign: campaigns.publicCampaign(result.campaign, campaigns.countLeads(core.db(), result.campaign.id)) });
}

async function apiCampaignsAttachEmployee(req, res, ctx) {
  if (rejectImpersonated(res, ctx)) return;
  const b = ctx.body || {};
  const id = String(b.campaignId || b.id || '');
  const employeeId = b.employeeId != null && String(b.employeeId).trim()
    ? String(b.employeeId).trim()
    : null;
  let result;
  await core.mutate((d) => {
    result = campaigns.setCampaignEmployee(d, ctx.tenant.id, id, employeeId);
    if (result.ok) {
      addAudit(d, ctx, 'campaign.employee', 'campaign', id, {
        employeeId: result.campaign.employeeId || null,
        agentId: result.campaign.agentId || null,
      });
    }
  });
  if (!result.ok) return core.sendJson(res, result.status, { error: result.error, code: result.code });
  core.sendJson(res, 200, {
    campaign: campaigns.publicCampaign(result.campaign, campaigns.countLeads(core.db(), result.campaign.id)),
  });
}

async function apiCampaignsEnqueue(req, res, ctx) {
  if (rejectImpersonated(res, ctx)) return;
  const b = ctx.body || {};
  const id = String(b.campaignId || b.id || '');
  let result;
  await core.mutate((d) => {
    result = campaigns.enqueueCampaign(d, ctx.tenant.id, id, { confirm: b.confirm === true });
    if (result.ok) addAudit(d, ctx, 'campaign.enqueued', 'campaign', id, { enqueued: result.enqueued, confirm: true });
  });
  if (!result.ok) return core.sendJson(res, result.status, { error: result.error, code: result.code });

  // Soft real dial: advance stub_queued leads through the shared outbound helper.
  const dialedResults = [];
  for (const item of result.results || []) {
    if (item.status !== 'stub_queued') {
      dialedResults.push(item);
      continue;
    }
    const leadRow = (core.db().campaignLeads || []).find(
      (l) => l.id === item.id && l.tenantId === ctx.tenant.id,
    );
    const campaign = campaigns.findCampaign(core.db(), ctx.tenant.id, id);
    if (!leadRow) {
      dialedResults.push({ id: item.id, status: 'failed', error: 'lead missing after enqueue' });
      continue;
    }
    const dial = await placeOutboundCallJob({
      tenantId: ctx.tenant.id,
      userId: ctx.user.id,
      toE164: leadRow.phone,
      agentId: campaign && campaign.agentId,
      employeeId: campaign && campaign.employeeId,
      campaignLeadId: leadRow.id,
      source: 'campaign',
      ctx,
    });
    await core.mutate((d) => {
      const row = (d.campaignLeads || []).find((l) => l.id === leadRow.id && l.tenantId === ctx.tenant.id);
      if (!row) return;
      if (dial.ok) {
        row.status = 'dialed';
        row.dialedAt = new Date().toISOString();
        row.lastError = null;
      } else {
        row.status = 'failed';
        row.lastError = String(dial.error || 'dial failed').slice(0, 200);
      }
    });
    dialedResults.push({
      id: item.id,
      status: dial.ok ? 'dialed' : 'failed',
      error: dial.ok ? undefined : dial.error,
      jobId: dial.jobId || null,
      callId: dial.callId || null,
    });
  }
  core.sendJson(res, 200, { ...result, results: dialedResults });
}

/* ==========================================================================
   Instant Leads + CallJobs (P0 vertical slice)
   ========================================================================== */

function matchLeadsRoute(route) {
  if (route === '/api/leads') return { action: 'list_or_create' };
  const call = route.match(/^\/api\/leads\/([^/]+)\/call$/);
  if (call) return { action: 'call', id: decodeURIComponent(call[1]) };
  const tl = route.match(/^\/api\/leads\/([^/]+)\/timeline$/);
  if (tl) return { action: 'timeline', id: decodeURIComponent(tl[1]) };
  const one = route.match(/^\/api\/leads\/([^/]+)$/);
  if (one) return { action: 'one', id: decodeURIComponent(one[1]) };
  return null;
}

function matchCallJobsRoute(route) {
  if (route === '/api/call-jobs') return { action: 'list' };
  const one = route.match(/^\/api\/call-jobs\/([^/]+)$/);
  if (one) return { action: 'one', id: decodeURIComponent(one[1]) };
  return null;
}

/**
 * Prefer explicit wf_ id, then a workflow linked to the employee/agent.
 * Phone-number outbound workflow remains a createOutboundCall fallback.
 */
function resolveLeadWorkflowId(db, tenantId, { workflowId, agentId }) {
  if (workflowId) {
    const wf = workflows.findWorkflow(db, tenantId, workflowId);
    if (wf) return wf.id;
  }
  if (!agentId) return null;
  const linked = (db.workflows || []).filter(
    (w) => w.tenantId === tenantId && w.agentId === String(agentId) && w.status !== 'archived',
  );
  const prefer = linked.find((w) => w.direction === 'outbound' || w.direction === 'both')
    || linked.find((w) => w.status === 'published')
    || linked[0];
  return prefer ? prefer.id : null;
}

/**
 * Shared dial helper: CallJob → createOutboundCall (canonical #14 path) → Call.
 * Passes only Astra pn_/wf_ ids. Never invents providerRunId. No Dograh ids in
 * the public response.
 */
async function placeOutboundCallJob({
  tenantId, userId, toE164, agentId, workflowId, phoneNumberId,
  leadId, campaignLeadId, employeeId, source, idempotencyKey, ctx,
}) {
  let jobId = null;
  let jobCreated = true;
  let astraWorkflowId = workflowId || null;
  let astraPhoneNumberId = phoneNumberId || null;
  let astraAgentId = agentId || null;
  let astraEmployeeId = employeeId || null;

  await core.mutate((d) => {
    if (astraEmployeeId) {
      const emp = (d.employees || []).find(
        (e) => e.id === String(astraEmployeeId) && e.tenantId === tenantId,
      );
      if (emp) {
        if (!astraAgentId) astraAgentId = emp.agentId || null;
        if (!astraWorkflowId) astraWorkflowId = emp.workflowId || null;
        if (!astraPhoneNumberId) astraPhoneNumberId = emp.phoneNumberId || null;
      }
    }
    astraWorkflowId = resolveLeadWorkflowId(d, tenantId, {
      workflowId: astraWorkflowId,
      agentId: astraAgentId,
    });
    if (!astraPhoneNumberId) {
      const dialCtx = phoneNumbers.outboundDialContext(d, tenantId);
      if (dialCtx) astraPhoneNumberId = dialCtx.phoneNumberId || null;
    }
    if (!astraEmployeeId && leadId) {
      const leadRow = leads.findLead(d, tenantId, leadId);
      if (leadRow && leadRow.employeeId) astraEmployeeId = leadRow.employeeId;
    }
    const created = callJobs.createCallJob(d, tenantId, {
      toE164,
      agentId: astraAgentId,
      workflowId: astraWorkflowId,
      phoneNumberId: astraPhoneNumberId,
      leadId: leadId || null,
      campaignLeadId: campaignLeadId || null,
      employeeId: astraEmployeeId || null,
      source: source || 'instant',
      idempotencyKey: idempotencyKey || null,
    }, userId);
    if (!created.ok) throw Object.assign(new Error(created.error), { status: created.status, code: created.code });
    jobId = created.job.id;
    jobCreated = created.created !== false;
    if (!jobCreated) {
      // Idempotent reuse. Do not dial again for the same key or active lead job.
      return;
    }
    if (leadId) {
      leads.updateLead(d, tenantId, leadId, { status: 'calling', lastCallJobId: jobId, lastError: null });
    }
    if (ctx) {
      addAudit(d, ctx, 'calljob.created', 'call_job', jobId, { leadId, source: source || 'instant' });
    }
  });

  if (!jobCreated) {
    const existingJob = callJobs.findCallJob(core.db(), tenantId, jobId);
    return {
      ok: existingJob && (existingJob.status === 'completed' || existingJob.status === 'queued' || existingJob.status === 'dialing'),
      reused: true,
      status: existingJob && existingJob.status === 'failed' ? 502 : 200,
      code: existingJob && existingJob.status === 'failed' ? 'dial_failed' : undefined,
      error: existingJob && existingJob.status === 'failed' ? (existingJob.lastError || 'dial failed') : undefined,
      jobId,
      callId: (existingJob && existingJob.resultCallId) || null,
      job: callJobs.publicCallJob(existingJob),
      call: existingJob && existingJob.resultCallId
        ? calls.publicCall(calls.findCall(core.db(), existingJob.resultCallId), agentsMapForTenant(tenantId), { detail: false })
        : null,
    };
  }

  await core.mutate((d) => {
    callJobs.updateCallJobStatus(d, tenantId, jobId, 'dialing', {
      phoneNumberId: astraPhoneNumberId,
      workflowId: astraWorkflowId,
      agentId: astraAgentId,
    });
  });

  let upstream;
  try {
    // Canonical dial contract from P0b/P0c: Astra ids only. Provider resolution
    // and Call upsert on real providerRunId happen inside createOutboundCall.
    upstream = await telephonyProvider.createOutboundCall(tenantId, toE164, {
      workflowId: astraWorkflowId || undefined,
      phoneNumberId: astraPhoneNumberId || undefined,
    });
  } catch (e) {
    const msg = String((e && e.message) || e).slice(0, 240);
    await core.mutate((d) => {
      callJobs.updateCallJobStatus(d, tenantId, jobId, 'failed', { lastError: msg });
      if (leadId) leads.updateLead(d, tenantId, leadId, { status: 'failed', lastError: msg });
      if (ctx) addAudit(d, ctx, 'calljob.failed', 'call_job', jobId, { error: msg });
    });
    return {
      ok: false,
      status: e.status || e.statusCode || 502,
      code: e.code || 'dial_failed',
      error: msg,
      jobId,
      job: callJobs.publicCallJob(callJobs.findCallJob(core.db(), tenantId, jobId)),
    };
  }

  const providerRunId = upstream && upstream.providerRunId != null
    ? String(upstream.providerRunId)
    : null;
  let callRow = (upstream && upstream.call) || null;

  // Never invent providerRunId. Without a real run id the Call cannot be tracked.
  if (!providerRunId && !callRow) {
    const msg = 'Call was placed but could not be tracked';
    await core.mutate((d) => {
      callJobs.updateCallJobStatus(d, tenantId, jobId, 'failed', {
        lastError: msg,
        phoneNumberId: astraPhoneNumberId,
        workflowId: astraWorkflowId,
      });
      if (leadId) leads.updateLead(d, tenantId, leadId, { status: 'failed', lastError: msg });
      if (ctx) addAudit(d, ctx, 'calljob.failed', 'call_job', jobId, { code: 'call_not_tracked' });
    });
    return {
      ok: false,
      status: 502,
      code: 'call_not_tracked',
      error: msg,
      jobId,
      job: callJobs.publicCallJob(callJobs.findCallJob(core.db(), tenantId, jobId)),
    };
  }

  let resultCallId = callRow ? callRow.id : null;

  await core.mutate((d) => {
    if (providerRunId) {
      const up = calls.upsertCallFromProvider(d, tenantId, {
        providerRunId,
        direction: 'outbound',
        toE164,
        fromE164: callRow && callRow.fromE164,
        agentId: astraAgentId,
        phoneNumberId: astraPhoneNumberId || (callRow && callRow.phoneNumberId) || null,
        status: (upstream.data && (upstream.data.status || upstream.data.state)) || (callRow && callRow.status) || 'queued',
        source: source || 'instant',
      });
      if (up && up.ok !== false) {
        callRow = up.call;
        resultCallId = up.call.id;
      }
    } else if (callRow && astraAgentId) {
      const found = calls.findCall(d, callRow.id);
      if (found && found.tenantId === tenantId) {
        found.agentId = astraAgentId;
        found.source = source || found.source || 'instant';
        found.updatedAt = new Date().toISOString();
        callRow = found;
        resultCallId = found.id;
      }
    }

    callJobs.updateCallJobStatus(d, tenantId, jobId, 'completed', {
      providerRunId: providerRunId || null,
      resultCallId,
      lastError: null,
      phoneNumberId: astraPhoneNumberId,
      workflowId: astraWorkflowId,
      agentId: astraAgentId,
    });
    if (leadId) {
      leads.updateLead(d, tenantId, leadId, {
        status: 'called',
        lastCallJobId: jobId,
        lastCallId: resultCallId,
        lastError: null,
      });
    }
    if (ctx) {
      addAudit(d, ctx, 'calljob.completed', 'call_job', jobId, {
        callId: resultCallId,
        leadId: leadId || null,
      });
    }
  });

  bumpUsage(tenantId, 'calls', 1).catch(() => {});
  core.mutate((d) => {
    plans.debitUsage(d, tenantId, { chars: 0, calls: 1 }, userId, addLedgerEntry);
  }).catch(() => {});

  return {
    ok: true,
    jobId,
    callId: resultCallId,
    job: callJobs.publicCallJob(callJobs.findCallJob(core.db(), tenantId, jobId)),
    call: resultCallId
      ? calls.publicCall(calls.findCall(core.db(), resultCallId), agentsMapForTenant(tenantId), { detail: false })
      : null,
  };
}

function apiLeadsList(req, res, ctx) {
  const url = new URL(req.url || '/', 'http://localhost');
  const list = leads.listLeads(core.db(), ctx.tenant.id, {
    status: url.searchParams.get('status') || undefined,
    employeeId: url.searchParams.get('employeeId') || undefined,
    agentId: url.searchParams.get('agentId') || undefined,
    limit: url.searchParams.get('limit') || undefined,
  });
  core.sendJson(res, 200, { leads: list });
}

async function apiLeadsCreate(req, res, ctx) {
  if (rejectImpersonated(res, ctx)) return;
  let result;
  await core.mutate((d) => {
    result = leads.createLead(d, ctx.tenant.id, ctx.body || {}, ctx.user.id);
    if (result.ok && result.created) {
      addAudit(d, ctx, 'lead.created', 'lead', result.lead.id, {
        phone: result.lead.phone,
        employeeId: result.lead.employeeId || null,
      });
    }
  });
  if (!result.ok) return core.sendJson(res, result.status, { error: result.error, code: result.code });
  core.sendJson(res, result.created ? 201 : 200, {
    lead: leads.publicLead(result.lead),
    created: result.created,
  });
}

function apiLeadsGet(req, res, ctx) {
  const lead = leads.findLead(core.db(), ctx.tenant.id, ctx.params.id);
  if (!lead) return core.sendJson(res, 404, { error: 'lead not found', code: 'not_found' });
  const jobs = callJobs.listCallJobs(core.db(), ctx.tenant.id, { leadId: lead.id, limit: 10 });
  core.sendJson(res, 200, { lead: leads.publicLead(lead), jobs });
}

async function apiLeadsPatch(req, res, ctx) {
  if (rejectImpersonated(res, ctx)) return;
  let result;
  await core.mutate((d) => {
    result = leads.updateLead(d, ctx.tenant.id, ctx.params.id, ctx.body || {});
    if (result.ok) {
      addAudit(d, ctx, 'lead.updated', 'lead', result.lead.id, {
        status: result.lead.status,
        employeeId: result.lead.employeeId || null,
      });
    }
  });
  if (!result.ok) return core.sendJson(res, result.status, { error: result.error, code: result.code });
  core.sendJson(res, 200, { lead: leads.publicLead(result.lead) });
}

async function apiLeadsCall(req, res, ctx) {
  if (rejectImpersonated(res, ctx)) return;
  const b = ctx.body || {};
  if (b.confirm !== true) {
    return core.sendJson(res, 400, {
      error: 'confirm:true required. This places a real outbound call.',
      code: 'needs_confirm',
    });
  }
  const lead = leads.findLead(core.db(), ctx.tenant.id, ctx.params.id);
  if (!lead) return core.sendJson(res, 404, { error: 'lead not found', code: 'not_found' });

  let agentId = b.agentId ? String(b.agentId) : lead.agentId;
  let workflowId = b.workflowId ? String(b.workflowId) : lead.workflowId;
  let phoneNumberId = b.phoneNumberId ? String(b.phoneNumberId) : lead.phoneNumberId;
  if (lead.employeeId && (!agentId || !workflowId)) {
    const emp = employees.findEmployee(core.db(), ctx.tenant.id, lead.employeeId);
    if (emp) {
      if (!agentId) agentId = emp.agentId || null;
      if (!workflowId) workflowId = emp.workflowId || null;
      if (!phoneNumberId) phoneNumberId = emp.phoneNumberId || null;
    }
  }
  if (agentId) {
    const agent = core.db().agents.find((a) => a.id === agentId && a.tenantId === ctx.tenant.id);
    if (!agent) return core.sendJson(res, 404, { error: 'agent not found', code: 'agent_not_found' });
  }

  let privacyWorkflowId;
  if (ctx.tenant.privacyMode === 'no_recording') {
    privacyWorkflowId = Number(process.env.DOGRAH_NO_RECORDING_WORKFLOW_ID || 0);
    if (!Number.isInteger(privacyWorkflowId) || privacyWorkflowId <= 0) {
      return core.sendJson(res, 409, {
        error: 'privacy mode blocks outbound until a verified no-recording workflow is configured',
        code: 'privacy_workflow_required',
      });
    }
  }

  const dial = await placeOutboundCallJob({
    tenantId: ctx.tenant.id,
    userId: ctx.user.id,
    toE164: lead.phone,
    agentId,
    workflowId: workflowId || privacyWorkflowId || null,
    phoneNumberId,
    leadId: lead.id,
    employeeId: lead.employeeId || null,
    source: 'instant',
    idempotencyKey: b.idempotencyKey ? String(b.idempotencyKey) : null,
    ctx,
  });

  if (!dial.ok) {
    return core.sendJson(res, dial.status || 502, {
      error: dial.error || 'dial failed',
      code: dial.code || 'dial_failed',
      job: dial.job,
    });
  }
  core.sendJson(res, 200, {
    ok: true,
    job: dial.job,
    call: dial.call,
    lead: leads.publicLead(leads.findLead(core.db(), ctx.tenant.id, lead.id)),
  });
}

/* ==========================================================================
   AI Employees (Phases 1 to 4): composition over Agent / Workflow / Number
   ========================================================================== */

function matchEmployeesRoute(route) {
  if (route === '/api/employees') return { action: 'list_or_create' };
  if (route === '/api/employees/templates') return { action: 'templates' };
  if (route === '/api/employees/languages') return { action: 'languages' };
  if (route === '/api/employees/action-types') return { action: 'action_types' };
  const pause = route.match(/^\/api\/employees\/([^/]+)\/pause$/);
  if (pause) return { action: 'pause', id: decodeURIComponent(pause[1]) };
  const resume = route.match(/^\/api\/employees\/([^/]+)\/resume$/);
  if (resume) return { action: 'resume', id: decodeURIComponent(resume[1]) };
  const status = route.match(/^\/api\/employees\/([^/]+)\/status$/);
  if (status) return { action: 'status', id: decodeURIComponent(status[1]) };
  const instructions = route.match(/^\/api\/employees\/([^/]+)\/instructions$/);
  if (instructions) return { action: 'instructions', id: decodeURIComponent(instructions[1]) };
  const workflow = route.match(/^\/api\/employees\/([^/]+)\/workflow$/);
  if (workflow) return { action: 'workflow', id: decodeURIComponent(workflow[1]) };
  const timelineRoute = route.match(/^\/api\/employees\/([^/]+)\/timeline$/);
  if (timelineRoute) return { action: 'timeline', id: decodeURIComponent(timelineRoute[1]) };
  const training = route.match(/^\/api\/employees\/([^/]+)\/training$/);
  if (training) return { action: 'training', id: decodeURIComponent(training[1]) };
  const knowledgeOne = route.match(/^\/api\/employees\/([^/]+)\/knowledge\/([^/]+)$/);
  if (knowledgeOne) {
    return {
      action: 'knowledge_one',
      id: decodeURIComponent(knowledgeOne[1]),
      knowledgeId: decodeURIComponent(knowledgeOne[2]),
    };
  }
  const knowledge = route.match(/^\/api\/employees\/([^/]+)\/knowledge$/);
  if (knowledge) return { action: 'knowledge', id: decodeURIComponent(knowledge[1]) };
  const outcomes = route.match(/^\/api\/employees\/([^/]+)\/outcomes$/);
  if (outcomes) return { action: 'outcomes', id: decodeURIComponent(outcomes[1]) };
  const actions = route.match(/^\/api\/employees\/([^/]+)\/actions$/);
  if (actions) return { action: 'actions', id: decodeURIComponent(actions[1]) };
  const actionExec = route.match(/^\/api\/employees\/([^/]+)\/actions\/execute$/);
  if (actionExec) return { action: 'actions_execute', id: decodeURIComponent(actionExec[1]) };
  const language = route.match(/^\/api\/employees\/([^/]+)\/language$/);
  if (language) return { action: 'language', id: decodeURIComponent(language[1]) };
  const empLeads = route.match(/^\/api\/employees\/([^/]+)\/leads$/);
  if (empLeads) return { action: 'leads', id: decodeURIComponent(empLeads[1]) };
  const one = route.match(/^\/api\/employees\/([^/]+)$/);
  if (one) return { action: 'one', id: decodeURIComponent(one[1]) };
  return null;
}

function apiEmployeeTemplates(req, res, ctx) {
  core.sendJson(res, 200, { templates: employees.listJobTemplates() });
}

function apiEmployeeLanguages(req, res) {
  core.sendJson(res, 200, { languages: employees.listSupportedLanguages() });
}

function apiEmployeeActionTypes(req, res) {
  core.sendJson(res, 200, { types: employees.listActionTypes() });
}

function apiEmployeesList(req, res, ctx) {
  const url = new URL(req.url || '/', 'http://localhost');
  const list = employees.listEmployees(core.db(), ctx.tenant.id, {
    filter: url.searchParams.get('filter') || url.searchParams.get('status') || url.searchParams.get('channel') || 'all',
    limit: url.searchParams.get('limit') || undefined,
  });
  core.sendJson(res, 200, { employees: list });
}

function apiEmployeesGet(req, res, ctx) {
  const row = employees.findEmployee(core.db(), ctx.tenant.id, ctx.params.id);
  if (!row) return core.sendJson(res, 404, { error: 'employee not found', code: 'not_found' });
  const pub = employees.publicEmployee(row, core.db());
  const agent = row.agentId
    ? core.db().agents.find((a) => a.id === row.agentId && a.tenantId === ctx.tenant.id)
    : null;
  const workflow = row.workflowId
    ? workflows.findWorkflow(core.db(), ctx.tenant.id, row.workflowId)
    : null;
  const knowledgeEntries = (row.knowledgeIds || [])
    .map((kid) => (core.db().knowledgeEntries || []).find((e) => e.id === kid && e.tenantId === ctx.tenant.id))
    .filter(Boolean)
    .map((k) => knowledge.publicKnowledgeEntry(k));
  core.sendJson(res, 200, {
    employee: pub,
    agent: agent ? publicAgent(agent) : null,
    workflow: workflow ? workflows.publicWorkflow(workflow, { includeProvider: false }) : null,
    knowledge: knowledgeEntries,
  });
}

async function apiEmployeesCreate(req, res, ctx) {
  if (rejectImpersonated(res, ctx)) return;
  let result;
  await core.mutate((d) => {
    result = employees.createEmployee(d, ctx.tenant.id, ctx.body || {}, ctx.user.id);
    if (result.ok && result.created) {
      addAudit(d, ctx, 'employee.created', 'employee', result.employee.id, {
        templateKey: result.employee.templateKey,
        status: result.employee.status,
      });
    }
  });
  if (!result.ok) return core.sendJson(res, result.status, { error: result.error, code: result.code });
  core.sendJson(res, 201, {
    employee: employees.publicEmployee(result.employee, core.db()),
    composed: !!result.composed,
  });
}

async function apiEmployeesPatch(req, res, ctx) {
  if (rejectImpersonated(res, ctx)) return;
  let result;
  await core.mutate((d) => {
    result = employees.updateEmployee(d, ctx.tenant.id, ctx.params.id, ctx.body || {});
    if (result.ok) {
      addAudit(d, ctx, 'employee.updated', 'employee', result.employee.id, {
        status: result.employee.status,
      });
    }
  });
  if (!result.ok) return core.sendJson(res, result.status, { error: result.error, code: result.code });
  core.sendJson(res, 200, { employee: employees.publicEmployee(result.employee, core.db()) });
}

async function apiEmployeesStatus(req, res, ctx) {
  if (rejectImpersonated(res, ctx)) return;
  const next = String((ctx.body || {}).status || '');
  let result;
  await core.mutate((d) => {
    result = employees.setEmployeeStatus(d, ctx.tenant.id, ctx.params.id, next);
    if (result.ok) {
      addAudit(d, ctx, 'employee.status', 'employee', result.employee.id, { status: result.employee.status });
    }
  });
  if (!result.ok) return core.sendJson(res, result.status, { error: result.error, code: result.code });
  core.sendJson(res, 200, { employee: employees.publicEmployee(result.employee, core.db()) });
}

async function apiEmployeesPause(req, res, ctx) {
  if (rejectImpersonated(res, ctx)) return;
  let result;
  await core.mutate((d) => {
    result = employees.pauseEmployee(d, ctx.tenant.id, ctx.params.id);
    if (result.ok) addAudit(d, ctx, 'employee.paused', 'employee', result.employee.id, {});
  });
  if (!result.ok) return core.sendJson(res, result.status, { error: result.error, code: result.code });
  core.sendJson(res, 200, { employee: employees.publicEmployee(result.employee, core.db()) });
}

async function apiEmployeesResume(req, res, ctx) {
  if (rejectImpersonated(res, ctx)) return;
  let result;
  await core.mutate((d) => {
    result = employees.resumeEmployee(d, ctx.tenant.id, ctx.params.id);
    if (result.ok) addAudit(d, ctx, 'employee.resumed', 'employee', result.employee.id, {});
  });
  if (!result.ok) return core.sendJson(res, result.status, { error: result.error, code: result.code });
  core.sendJson(res, 200, { employee: employees.publicEmployee(result.employee, core.db()) });
}

function apiEmployeesInstructionsGet(req, res, ctx) {
  const result = employees.getInstructions(core.db(), ctx.tenant.id, ctx.params.id);
  if (!result.ok) return core.sendJson(res, result.status, { error: result.error, code: result.code });
  core.sendJson(res, 200, result.instructions);
}

async function apiEmployeesInstructionsPut(req, res, ctx) {
  if (rejectImpersonated(res, ctx)) return;
  let result;
  await core.mutate((d) => {
    result = employees.updateInstructions(d, ctx.tenant.id, ctx.params.id, ctx.body || {});
    if (result.ok) {
      addAudit(d, ctx, 'employee.instructions_updated', 'employee', ctx.params.id, {});
    }
  });
  if (!result.ok) return core.sendJson(res, result.status, { error: result.error, code: result.code });
  core.sendJson(res, 200, result.instructions);
}

function apiEmployeesTrainingGet(req, res, ctx) {
  const result = employees.listTraining(core.db(), ctx.tenant.id, ctx.params.id);
  if (!result.ok) return core.sendJson(res, result.status, { error: result.error, code: result.code });
  core.sendJson(res, 200, result.training);
}

async function apiEmployeesKnowledgePost(req, res, ctx) {
  if (rejectImpersonated(res, ctx)) return;
  const b = ctx.body || {};
  let result;
  await core.mutate((d) => {
    if (b.create === true || (b.title && (b.content || b.sourceUrl))) {
      result = employees.createAndAttachKnowledge(d, ctx.tenant.id, ctx.params.id, b, ctx.user.id);
      if (result.ok) {
        addAudit(d, ctx, 'employee.knowledge_created', 'employee', ctx.params.id, {
          knowledgeId: result.entry.id,
        });
      }
    } else {
      result = employees.attachKnowledge(d, ctx.tenant.id, ctx.params.id, b.knowledgeId || b.id);
      if (result.ok) {
        addAudit(d, ctx, 'employee.knowledge_attached', 'employee', ctx.params.id, {
          knowledgeId: b.knowledgeId || b.id,
        });
      }
    }
  });
  if (!result.ok) return core.sendJson(res, result.status, { error: result.error, code: result.code });
  const payload = { training: result.training };
  if (result.entry) payload.entry = knowledge.publicKnowledgeEntry(result.entry);
  core.sendJson(res, result.entry ? 201 : 200, payload);
}

async function apiEmployeesKnowledgeDetach(req, res, ctx) {
  if (rejectImpersonated(res, ctx)) return;
  let result;
  await core.mutate((d) => {
    result = employees.detachKnowledge(d, ctx.tenant.id, ctx.params.id, ctx.params.knowledgeId);
    if (result.ok) {
      addAudit(d, ctx, 'employee.knowledge_detached', 'employee', ctx.params.id, {
        knowledgeId: ctx.params.knowledgeId,
      });
    }
  });
  if (!result.ok) return core.sendJson(res, result.status, { error: result.error, code: result.code });
  core.sendJson(res, 200, { training: result.training });
}

function apiEmployeesOutcomesGet(req, res, ctx) {
  const result = employees.getOutcomes(core.db(), ctx.tenant.id, ctx.params.id);
  if (!result.ok) return core.sendJson(res, result.status, { error: result.error, code: result.code });
  core.sendJson(res, 200, result.outcomes);
}

async function apiEmployeesOutcomesPut(req, res, ctx) {
  if (rejectImpersonated(res, ctx)) return;
  const list = (ctx.body || {}).outcomes != null ? (ctx.body || {}).outcomes : (ctx.body || {}).definitions;
  let result;
  await core.mutate((d) => {
    result = employees.setOutcomes(d, ctx.tenant.id, ctx.params.id, list);
    if (result.ok) {
      addAudit(d, ctx, 'employee.outcomes_updated', 'employee', ctx.params.id, {
        count: result.outcomes.count,
      });
    }
  });
  if (!result.ok) return core.sendJson(res, result.status, { error: result.error, code: result.code });
  core.sendJson(res, 200, result.outcomes);
}

function apiEmployeesActionsGet(req, res, ctx) {
  const result = employees.getActions(core.db(), ctx.tenant.id, ctx.params.id);
  if (!result.ok) return core.sendJson(res, result.status, { error: result.error, code: result.code });
  core.sendJson(res, 200, result.actions);
}

async function apiEmployeesActionsPut(req, res, ctx) {
  if (rejectImpersonated(res, ctx)) return;
  const list = (ctx.body || {}).actions != null ? (ctx.body || {}).actions : (ctx.body || {}).definitions;
  let result;
  await core.mutate((d) => {
    result = employees.setActions(d, ctx.tenant.id, ctx.params.id, list);
    if (result.ok) {
      addAudit(d, ctx, 'employee.actions_updated', 'employee', ctx.params.id, {
        count: result.actions.count,
      });
    }
  });
  if (!result.ok) return core.sendJson(res, result.status, { error: result.error, code: result.code });
  core.sendJson(res, 200, result.actions);
}

async function apiEmployeesActionsExecute(req, res, ctx) {
  if (rejectImpersonated(res, ctx)) return;
  const result = employees.executeActionHook(core.db(), ctx.tenant.id, ctx.params.id, ctx.body || {});
  if (!result.ok) return core.sendJson(res, result.status, { error: result.error, code: result.code });
  // Foundation only: audit the hook intent without performing CRM I/O.
  await core.mutate((d) => {
    addAudit(d, ctx, 'employee.action_hook', 'employee', ctx.params.id, {
      actionKey: result.execution.actionKey,
      actionType: result.execution.actionType,
      status: result.execution.status,
    });
  });
  core.sendJson(res, 200, result.execution);
}

async function apiEmployeesLanguagePut(req, res, ctx) {
  if (rejectImpersonated(res, ctx)) return;
  const language = (ctx.body || {}).language != null
    ? (ctx.body || {}).language
    : (ctx.body || {}).id;
  let result;
  await core.mutate((d) => {
    result = employees.setEmployeeLanguage(d, ctx.tenant.id, ctx.params.id, language);
    if (result.ok) {
      addAudit(d, ctx, 'employee.language_updated', 'employee', ctx.params.id, {
        language: result.language,
      });
    }
  });
  if (!result.ok) {
    return core.sendJson(res, result.status, {
      error: result.error,
      code: result.code,
      supported: result.supported,
    });
  }
  core.sendJson(res, 200, {
    employee: employees.publicEmployee(result.employee, core.db()),
    language: result.language,
    languages: result.languages,
  });
}

function apiEmployeesLeadsList(req, res, ctx) {
  const row = employees.findEmployee(core.db(), ctx.tenant.id, ctx.params.id);
  if (!row) return core.sendJson(res, 404, { error: 'employee not found', code: 'not_found' });
  const url = new URL(req.url || '/', 'http://localhost');
  const list = leads.listLeads(core.db(), ctx.tenant.id, {
    employeeId: row.id,
    status: url.searchParams.get('status') || undefined,
    limit: url.searchParams.get('limit') || 50,
  });
  core.sendJson(res, 200, {
    employeeId: row.id,
    leads: list,
    count: list.length,
  });
}

function apiEmployeesWorkflowGet(req, res, ctx) {
  const result = employees.getWorkflow(core.db(), ctx.tenant.id, ctx.params.id);
  if (!result.ok) return core.sendJson(res, result.status, { error: result.error, code: result.code });
  core.sendJson(res, 200, result.workflow);
}

async function apiEmployeesWorkflowPut(req, res, ctx) {
  if (rejectImpersonated(res, ctx)) return;
  let result;
  await core.mutate((d) => {
    result = employees.updateWorkflow(d, ctx.tenant.id, ctx.params.id, ctx.body || {});
    if (result.ok) {
      addAudit(d, ctx, 'employee.workflow_updated', 'employee', ctx.params.id, {
        workflowId: result.workflow.workflowId,
        steps: (result.workflow.steps || []).length,
      });
    }
  });
  if (!result.ok) return core.sendJson(res, result.status, { error: result.error, code: result.code });
  core.sendJson(res, 200, result.workflow);
}

function apiEmployeesTimelineGet(req, res, ctx) {
  const url = new URL(req.url || '/', 'http://localhost');
  const result = timeline.buildEmployeeTimeline(core.db(), ctx.tenant.id, ctx.params.id, {
    limit: url.searchParams.get('limit') || 50,
  });
  if (!result.ok) return core.sendJson(res, result.status, { error: result.error, code: result.code });
  core.sendJson(res, 200, result.timeline);
}

function apiLeadsTimelineGet(req, res, ctx) {
  const url = new URL(req.url || '/', 'http://localhost');
  const result = timeline.buildLeadTimeline(core.db(), ctx.tenant.id, ctx.params.id, {
    limit: url.searchParams.get('limit') || 50,
  });
  if (!result.ok) return core.sendJson(res, result.status, { error: result.error, code: result.code });
  core.sendJson(res, 200, result.timeline);
}

function apiCallJobsList(req, res, ctx) {
  const url = new URL(req.url || '/', 'http://localhost');
  const list = callJobs.listCallJobs(core.db(), ctx.tenant.id, {
    status: url.searchParams.get('status') || undefined,
    leadId: url.searchParams.get('leadId') || undefined,
    employeeId: url.searchParams.get('employeeId') || undefined,
    agentId: url.searchParams.get('agentId') || undefined,
    limit: url.searchParams.get('limit') || 50,
  });
  core.sendJson(res, 200, {
    jobs: list,
    count: list.length,
    empty: list.length === 0,
  });
}

function apiCallJobsGet(req, res, ctx) {
  const job = callJobs.findCallJob(core.db(), ctx.tenant.id, ctx.params.id);
  if (!job) return core.sendJson(res, 404, { error: 'call job not found', code: 'not_found' });
  const enrich = callJobs.enrichForJob(core.db(), ctx.tenant.id, job);
  core.sendJson(res, 200, {
    job: callJobs.publicCallJob(
      { ...job, employeeId: job.employeeId || enrich.employeeId || null },
      {
        leadName: enrich.leadName,
        employeeName: enrich.employeeName,
        callStatus: enrich.callStatus,
        callOutcome: enrich.callOutcome,
      },
    ),
  });
}

function apiCampaignsLeads(req, res, ctx) {
  const url = new URL(req.url, 'http://localhost');
  const id = String(url.searchParams.get('campaignId') || '');
  const result = campaigns.listLeads(core.db(), ctx.tenant.id, id);
  if (!result.ok) return core.sendJson(res, result.status, { error: result.error, code: result.code });
  core.sendJson(res, 200, result);
}

function apiAnalytics(req, res, ctx) {
  const dash = analytics.buildDashboard(core.db(), ctx.tenant.id);
  core.sendJson(res, 200, { analytics: dash, performance: dash });
}

async function apiMemberRole(req, res, ctx) {
  const b = ctx.body || {};
  const role = String(b.role || '');
  if (!['owner', 'member'].includes(role)) return core.sendJson(res, 422, { error: 'tenant roles are owner or member', code: 'bad_role' });
  const target = core.db().users.find((u) => u.id === String(b.userId || '') && u.tenantId === ctx.tenant.id);
  if (!target) return core.sendJson(res, 404, { error: 'user not found', code: 'not_found' });
  await core.mutate((d) => { const u = d.users.find((x) => x.id === target.id); u.role = role; addAudit(d, ctx, 'member.role.updated', 'user', u.id, { role }); });
  core.sendJson(res, 200, { user: publicUser({ ...target, role }) });
}

function apiAdminOverview(req, res) {
  const d = core.db();
  core.sendJson(res, 200, { totals: { tenants: d.tenants.length, users: d.users.length, openTickets: d.supportTickets.filter((t) => t.status !== 'closed').length, walletPaise: d.wallets.reduce((n, w) => n + w.balancePaise, 0), calls: d.usage.reduce((n, u) => n + (u.calls || 0), 0) } });
}

function apiAdminTenants(req, res) {
  const d = core.db();
  core.sendJson(res, 200, { tenants: d.tenants.map((t) => ({ ...publicTenant(t), users: d.users.filter((u) => u.tenantId === t.id).length, wallet: publicWallet(d.wallets.find((w) => w.tenantId === t.id) || { id: null, tenantId: t.id, currency: 'INR', balancePaise: 0 }) })) });
}

function apiAdminUsers(req, res) { core.sendJson(res, 200, { users: core.db().users.map(publicUser) }); }

function apiAdminAudit(req, res) {
  core.sendJson(res, 200, { auditEvents: core.db().auditEvents.slice(-500).reverse().map(org.publicAuditEvent) });
}

function apiAdminTickets(req, res) {
  const d = core.db();
  core.sendJson(res, 200, { tickets: d.supportTickets.map((t) => ({ ...t, messages: d.supportMessages.filter((m) => m.ticketId === t.id) })) });
}

function apiAdminPaymentEvents(req, res) { core.sendJson(res, 200, { events: core.db().paymentEvents.slice(-500).reverse() }); }

function apiAdminTenantDetail(req, res) {
  const url = new URL(req.url, 'http://localhost'); const tenantId = String(url.searchParams.get('tenantId') || ''); const d = core.db();
  const tenant = d.tenants.find((t) => t.id === tenantId);
  if (!tenant) return core.sendJson(res, 404, { error: 'tenant not found', code: 'not_found' });
  core.sendJson(res, 200, { tenant: publicTenant(tenant), users: d.users.filter((u) => u.tenantId === tenantId).map(publicUser), agents: d.agents.filter((a) => a.tenantId === tenantId).map(publicAgent), numbers: d.byonConnections.filter((x) => x.tenantId === tenantId).map((x) => ({ id: x.id, provider: x.provider, address: x.address, label: x.label, status: x.status, createdAt: x.createdAt })), usage: d.usage.filter((x) => x.tenantId === tenantId).slice(-100).reverse(), tickets: d.supportTickets.filter((x) => x.tenantId === tenantId), wallet: publicWallet(d.wallets.find((w) => w.tenantId === tenantId) || { id: null, tenantId, currency: 'INR', balancePaise: 0 }), ledger: d.ledger.filter((x) => x.tenantId === tenantId).slice(-100).reverse() });
}

async function apiAdminImpersonate(req, res, ctx) {
  if (ctx.impersonator) return core.sendJson(res, 409, { error: 'nested impersonation is not allowed', code: 'nested_impersonation' });
  const b = ctx.body || {}; const reason = String(b.reason || '').trim().slice(0, 240); const target = core.db().users.find((u) => u.id === String(b.userId || ''));
  if (!reason || !target) return core.sendJson(res, 422, { error: 'valid userId and reason required', code: 'bad_impersonation' });
  if (!core.verifyPassword(String(b.password || ''), ctx.user.passHash)) return core.sendJson(res, 401, { error: 'password re-authentication failed', code: 'reauth_failed' });
  if (target.role === 'super_admin' || target.status !== 'active') return core.sendJson(res, 403, { error: 'that account cannot be impersonated', code: 'impersonation_forbidden' });
  const tenant = core.db().tenants.find((t) => t.id === target.tenantId);
  if (!tenant || tenant.status !== 'active') return core.sendJson(res, 409, { error: 'target tenant is not active', code: 'target_inactive' });
  const token = await core.createImpersonationSession(ctx.user.id, target.id, tenant.id, reason);
  await core.mutate((d) => addAudit(d, ctx, 'admin.impersonation.started', 'user', target.id, { reason }));
  core.send(res, 200, JSON.stringify({ ok: true, user: publicUser(target), tenant: publicTenant(tenant) }), { 'Content-Type': 'application/json', 'Set-Cookie': core.sessionCookie(token) });
}

async function apiImpersonationExit(req, res, ctx) {
  if (!ctx.impersonator) return core.sendJson(res, 409, { error: 'not impersonating', code: 'not_impersonating' });
  const actor = ctx.impersonator; const tenant = core.db().tenants.find((t) => t.id === actor.tenantId); const token = await core.createSession(actor.id, actor.tenantId);
  await core.mutate((d) => addAudit(d, ctx, 'admin.impersonation.ended', 'user', ctx.user.id));
  core.send(res, 200, JSON.stringify({ ok: true, user: publicUser(actor), tenant: publicTenant(tenant) }), { 'Content-Type': 'application/json', 'Set-Cookie': core.sessionCookie(token) });
}

async function apiAdminTenantStatus(req, res, ctx) {
  if (rejectImpersonated(res, ctx)) return;
  const b = ctx.body || {};
  const status = String(b.status || '');
  if (!['active', 'suspended', 'closed'].includes(status)) return core.sendJson(res, 422, { error: 'invalid status', code: 'bad_status' });
  const tenant = core.db().tenants.find((t) => t.id === String(b.tenantId || ''));
  if (!tenant) return core.sendJson(res, 404, { error: 'tenant not found', code: 'not_found' });
  await core.mutate((d) => { d.tenants.find((t) => t.id === tenant.id).status = status; if (status !== 'active') d.sessions = d.sessions.filter((s) => s.tenantId !== tenant.id); addAudit(d, ctx, 'admin.tenant.status', 'tenant', tenant.id, { status }); });
  core.sendJson(res, 200, { tenant: publicTenant({ ...tenant, status }) });
}

async function apiAdminUserStatus(req, res, ctx) {
  if (rejectImpersonated(res, ctx)) return;
  const b = ctx.body || {};
  const status = String(b.status || '');
  if (!['active', 'suspended', 'deleted'].includes(status)) return core.sendJson(res, 422, { error: 'invalid status', code: 'bad_status' });
  const user = core.db().users.find((u) => u.id === String(b.userId || ''));
  if (!user) return core.sendJson(res, 404, { error: 'user not found', code: 'not_found' });
  if (user.id === ctx.user.id) return core.sendJson(res, 409, { error: 'cannot change your own status', code: 'self_target' });
  await core.mutate((d) => { const u = d.users.find((x) => x.id === user.id); u.status = status; if (status === 'deleted') { u.email = `deleted-${u.id}@invalid.local`; u.name = 'Deleted user'; u.passHash = ''; } d.sessions = d.sessions.filter((s) => s.userId !== user.id); addAudit(d, ctx, 'admin.user.status', 'user', user.id, { status }); });
  core.sendJson(res, 200, { ok: true });
}

async function apiAdminUserRole(req, res, ctx) {
  if (rejectImpersonated(res, ctx)) return;
  const b = ctx.body || {};
  const role = String(b.role || '');
  if (!['super_admin', 'admin', 'owner', 'member'].includes(role)) return core.sendJson(res, 422, { error: 'invalid role', code: 'bad_role' });
  const user = core.db().users.find((u) => u.id === String(b.userId || ''));
  if (!user) return core.sendJson(res, 404, { error: 'user not found', code: 'not_found' });
  if (user.id === ctx.user.id && role !== 'super_admin') return core.sendJson(res, 409, { error: 'cannot remove your own super admin role', code: 'self_target' });
  await core.mutate((d) => { d.users.find((u) => u.id === user.id).role = role; addAudit(d, ctx, 'admin.user.role', 'user', user.id, { role }); });
  core.sendJson(res, 200, { user: publicUser({ ...user, role }) });
}

async function apiAdminWalletAdjust(req, res, ctx) {
  if (rejectImpersonated(res, ctx)) return;
  const b = ctx.body || {};
  const amountPaise = Number(b.amountPaise);
  const tenantId = String(b.tenantId || '');
  if (!core.db().tenants.some((t) => t.id === tenantId) || !Number.isInteger(amountPaise) || amountPaise === 0 || Math.abs(amountPaise) > 100000000) return core.sendJson(res, 422, { error: 'valid tenantId and amountPaise required', code: 'bad_adjustment' });
  const idempotencyKey = String(b.idempotencyKey || '').trim().slice(0, 120);
  if (!idempotencyKey) return core.sendJson(res, 422, { error: 'idempotencyKey required', code: 'idempotency_required' });
  let entry;
  try { await core.mutate((d) => { entry = addLedgerEntry(d, tenantId, amountPaise, 'admin_adjustment', `admin:${idempotencyKey}`, ctx.user.id, { reason: String(b.reason || '').slice(0, 200) }); if (entry) addAudit(d, ctx, 'admin.wallet.adjusted', 'tenant', tenantId, { amountPaise, ledgerId: entry.id }); }); }
  catch (e) { return core.sendJson(res, 409, { error: e.message, code: 'wallet_rejected' }); }
  if (!entry) return core.sendJson(res, 200, { duplicate: true });
  core.sendJson(res, 201, { ledgerEntry: entry });
}

async function apiAdminTestCredits(req, res, ctx) {
  if (rejectImpersonated(res, ctx)) return;
  const b = ctx.body || {};
  const tenantId = String(b.tenantId || '');
  if (!core.db().tenants.some((t) => t.id === tenantId)) {
    return core.sendJson(res, 404, { error: 'tenant not found', code: 'not_found' });
  }
  const amountPaise = Number(b.amountPaise != null ? b.amountPaise : b.creditsPaise);
  const idempotencyKey = String(b.idempotencyKey || '').trim().slice(0, 120);
  if (!idempotencyKey) {
    return core.sendJson(res, 422, { error: 'idempotencyKey required', code: 'idempotency_required' });
  }
  let result;
  try {
    await core.mutate((d) => {
      result = plans.grantTestCredits(
        d,
        tenantId,
        amountPaise,
        ctx.user.id,
        `test:${idempotencyKey}`,
        b.reason || 'test credits',
        addLedgerEntry,
      );
      if (result.ok && result.ledgerEntry && !result.duplicate) {
        addAudit(d, ctx, 'admin.wallet.test_credits', 'tenant', tenantId, {
          amountPaise,
          ledgerId: result.ledgerEntry.id,
        });
      }
    });
  } catch (e) {
    return core.sendJson(res, 409, { error: e.message, code: 'wallet_rejected' });
  }
  if (!result.ok) return core.sendJson(res, result.status, { error: result.error, code: result.code });
  if (result.duplicate) return core.sendJson(res, 200, { duplicate: true, ledgerEntry: result.ledgerEntry });
  core.sendJson(res, 201, { ledgerEntry: result.ledgerEntry, grantKind: 'test' });
}

async function apiAdminTicketReply(req, res, ctx) {
  const b = ctx.body || {};
  const ticket = core.db().supportTickets.find((t) => t.id === String(b.ticketId || ''));
  const text = String(b.message || '').trim().slice(0, 5000);
  if (!ticket || !text) return core.sendJson(res, 422, { error: 'valid ticketId and message required', code: 'bad_reply' });
  const msg = { id: core.genId('msg_'), ticketId: ticket.id, tenantId: ticket.tenantId, authorUserId: ctx.user.id, body: text, internal: !!b.internal, createdAt: new Date().toISOString() };
  await core.mutate((d) => { d.supportMessages.push(msg); const t = d.supportTickets.find((x) => x.id === ticket.id); t.status = b.status === 'closed' ? 'closed' : 'waiting_on_customer'; t.updatedAt = msg.createdAt; addAudit(d, ctx, 'admin.ticket.replied', 'ticket', ticket.id, { status: t.status }); });
  core.sendJson(res, 201, { message: msg });
}

async function apiAdminTicketUpdate(req, res, ctx) {
  const b = ctx.body || {}; const ticket = core.db().supportTickets.find((t) => t.id === String(b.ticketId || ''));
  if (!ticket) return core.sendJson(res, 404, { error: 'ticket not found', code: 'not_found' });
  const status = ['open', 'in_progress', 'waiting_on_customer', 'resolved', 'closed'].includes(String(b.status || '')) ? String(b.status) : ticket.status;
  const priority = ['low', 'normal', 'high', 'urgent'].includes(String(b.priority || '')) ? String(b.priority) : ticket.priority;
  await core.mutate((d) => { const t = d.supportTickets.find((x) => x.id === ticket.id); t.status = status; t.priority = priority; t.assignedTo = b.assignedTo ? String(b.assignedTo) : t.assignedTo || ctx.user.id; t.updatedAt = new Date().toISOString(); addAudit(d, ctx, 'admin.ticket.updated', 'ticket', ticket.id, { status, priority, assignedTo: t.assignedTo }); });
  core.sendJson(res, 200, { ok: true });
}

// GET /api/providers -> authed registry so Settings can render active vs available.
// Never public: provider ids/labels are an inventory leak when unauthenticated.
function apiProviders(req, res, ctx) {
  const payload = providers.describeProviders();
  const check = org.assertNoSecretValues(payload);
  if (!check.ok) {
    return core.sendJson(res, 500, { error: 'provider registry refused to leak secrets', code: 'secret_guard' });
  }
  core.sendJson(res, 200, payload);
}

// GET /api/version -> authenticated deploy proof (gitSha from env, never invented).
function apiVersion(req, res) {
  const id = currentDeployIdentity();
  core.sendJson(res, 200, {
    gitSha: id.gitSha,
    ref: id.ref,
    version: APP_VERSION,
    builtAt: id.deployedAt,
  });
}

// GET /api/health -> public readiness + deploy identity. Provider inventory is super_admin only.
async function apiHealth(req, res) {
  const id = currentDeployIdentity();
  const ctx = await core.getSession(req);
  if (!ctx || ctx.user.role !== 'super_admin') {
    return core.sendJson(res, 200, org.publicHealthPayload({
      uptime: (Date.now() - STARTED_AT_MS) / 1000,
      version: APP_VERSION,
      gitSha: id.gitSha,
      deployedAt: id.deployedAt,
    }));
  }
  const payload = org.detailedHealthPayload(providers.describeProviders());
  payload.uptime = Math.floor((Date.now() - STARTED_AT_MS) / 1000);
  payload.version = APP_VERSION;
  payload.gitSha = id.gitSha;
  payload.deployedAt = id.deployedAt;
  const check = org.assertNoSecretValues(payload);
  if (!check.ok) {
    return core.sendJson(res, 500, { error: 'provider health refused to leak secrets', code: 'secret_guard' });
  }
  core.sendJson(res, 200, payload);
}

/* ==========================================================================
   Map a ProviderError (or anything) to a clean JSON HTTP response.
   ========================================================================== */
function handleProviderError(res, e) {
  if (e instanceof providers.ProviderError || e instanceof TelephonyProviderError || e instanceof WorkflowProviderError) {
    return core.sendJson(res, e.status || 502, {
      error: e.message,
      code: e.code || 'provider_error',
      detail: e.detail,
    });
  }
  core.sendJson(res, 502, { error: String((e && e.message) || e), code: 'upstream' });
}

/* ==========================================================================
   Router
   ========================================================================== */

const server = http.createServer(async (req, res) => {
  const ip = req.socket.remoteAddress || 'local';
  const route = (req.url || '/').split('?')[0];

  try {
    if (route.startsWith('/api/')) {
      if (!core.rateOk(ip)) return core.sendJson(res, 429, { error: 'rate limited', code: 'rate' });

      if ((route === '/api/payu/callback' || route === '/api/payu/webhook' || route === '/api/payu/return') && req.method === 'POST') {
        let form;
        try { form = await readForm(req); }
        catch (e) { return core.sendJson(res, 400, { error: e.message, code: 'bad_form' }); }
        return (route.endsWith('/callback') || route.endsWith('/webhook')) ? apiPayuCallback(req, res, form) : apiPayuReturn(req, res, form);
      }

      // ---- Public GET routes ----
      if (route === '/api/health' && req.method === 'GET') return apiHealth(req, res);
      if (route.startsWith('/api/public/demo/') && req.method === 'GET') {
        const token = decodeURIComponent(route.slice('/api/public/demo/'.length));
        if (token.includes('/')) return core.sendJson(res, 404, { error: 'demo link not found', code: 'not_found' });
        return apiPublicDemoMeta(req, res, token);
      }

      // ---- Authed GET routes ----
      if (req.method === 'GET') {
        const pnGet = matchPhoneNumberRoute(route);
        if (pnGet) {
          if (pnGet.action === 'list') return core.requireAuth(req, res, apiPhoneNumbersList);
          if (pnGet.action === 'available') return core.requireAuth(req, res, apiPhoneNumbersAvailable);
          if (pnGet.action === 'inbound') {
            return core.requireAuth(req, res, (rq, rs, ctx) => apiPhoneNumbersInboundGet(rq, rs, { ...ctx, params: { id: pnGet.id } }));
          }
          return core.sendJson(res, 404, { error: 'no such endpoint', code: 'not_found' });
        }
        const callsGet = matchCallsRoute(route);
        if (callsGet) {
          if (callsGet.action === 'list') return core.requireAuth(req, res, apiCallsList);
          if (callsGet.action === 'detail') {
            return core.requireAuth(req, res, (rq, rs, ctx) => apiCallsDetail(rq, rs, { ...ctx, params: { id: callsGet.id } }));
          }
          if (callsGet.action === 'recording') {
            return core.requireAuth(req, res, (rq, rs, ctx) => apiCallsRecording(rq, rs, { ...ctx, params: { id: callsGet.id } }));
          }
          return core.sendJson(res, 404, { error: 'no such endpoint', code: 'not_found' });
        }
        const wfGet = matchWorkflowRoute(route);
        if (wfGet) {
          if (wfGet.action === 'templates') return core.requireAuth(req, res, apiWorkflowTemplates);
          if (wfGet.action === 'list_or_create') return core.requireAuth(req, res, apiWorkflowsList);
          if (wfGet.action === 'one') {
            return core.requireAuth(req, res, (rq, rs, ctx) => apiWorkflowsGet(rq, rs, { ...ctx, params: { id: wfGet.id } }));
          }
          return core.sendJson(res, 404, { error: 'no such endpoint', code: 'not_found' });
        }
        if (route === '/api/me') return core.requireAuth(req, res, apiMe);
        if (route === '/api/version') return core.requireAuth(req, res, apiVersion);
        if (route === '/api/providers') return core.requireAuth(req, res, apiProviders);
        if (route === '/api/agents') return core.requireAuth(req, res, apiAgentsList);
        if (route === '/api/usage') return core.requireAuth(req, res, apiUsage);
        if (route === '/api/telephony/status') return core.requireAuth(req, res, apiTelephonyStatus);
        if (route === '/api/presets') return core.requireAuth(req, res, apiPresets);
        if (route === '/api/agent-types') return core.requireAuth(req, res, apiAgentTypes);
        if (route === '/api/wallet') return core.requireAuth(req, res, apiWallet);
        if (route === '/api/plans') return core.requireAuth(req, res, apiPlansList);
        if (route === '/api/billing/entitlements') return core.requireAuth(req, res, apiBillingEntitlements);
        if (route === '/api/payment-intents') return core.requireAuth(req, res, apiPaymentIntents);
        if (route === '/api/support/tickets') return core.requireAuth(req, res, apiSupportList);
        if (route === '/api/byon') return core.requireAuth(req, res, apiByonList);
        if (route === '/api/privacy') return core.requireAuth(req, res, apiPrivacyGet);
        if (route === '/api/members') return core.requireRole(req, res, 'owner', apiMembers);
        if (route === '/api/audit') return core.requireRole(req, res, 'owner', apiAudit);
        if (route === '/api/demo-links') return core.requireRole(req, res, 'owner', apiDemoLinksList);
        if (route === '/api/admin/overview') return core.requireRole(req, res, 'super_admin', apiAdminOverview);
        if (route === '/api/admin/tenants') return core.requireRole(req, res, 'super_admin', apiAdminTenants);
        if (route === '/api/admin/users') return core.requireRole(req, res, 'super_admin', apiAdminUsers);
        if (route === '/api/admin/audit') return core.requireRole(req, res, 'admin', apiAdminAudit);
        if (route === '/api/admin/tickets') return core.requireRole(req, res, 'admin', apiAdminTickets);
        if (route === '/api/admin/tenant-detail') return core.requireRole(req, res, 'super_admin', apiAdminTenantDetail);
        if (route === '/api/admin/payment-events') return core.requireRole(req, res, 'admin', apiAdminPaymentEvents);
        if (route === '/api/admin/providers') return core.requireRole(req, res, 'super_admin', apiAdminProviderHealth);
        if (route === '/api/admin/diagnostics') return core.requireRole(req, res, 'super_admin', apiAdminDiagnostics);
        if (route === '/api/knowledge') return core.requireAuth(req, res, apiKnowledgeList);
        if (route === '/api/knowledge/retrieve') return core.requireAuth(req, res, apiKnowledgeRetrieve);
        if (route === '/api/integrations') return core.requireAuth(req, res, apiIntegrationsList);
        if (route === '/api/campaigns') return core.requireAuth(req, res, apiCampaignsList);
        if (route === '/api/campaigns/leads') return core.requireAuth(req, res, apiCampaignsLeads);
        if (route === '/api/analytics') return core.requireAuth(req, res, apiAnalytics);
        if (route === '/api/performance') return core.requireAuth(req, res, apiAnalytics);
        const leadsGet = matchLeadsRoute(route);
        if (leadsGet) {
          if (leadsGet.action === 'list_or_create') return core.requireAuth(req, res, apiLeadsList);
          if (leadsGet.action === 'one') {
            return core.requireAuth(req, res, (rq, rs, ctx) => apiLeadsGet(rq, rs, { ...ctx, params: { id: leadsGet.id } }));
          }
          if (leadsGet.action === 'timeline') {
            return core.requireAuth(req, res, (rq, rs, ctx) => apiLeadsTimelineGet(rq, rs, { ...ctx, params: { id: leadsGet.id } }));
          }
          return core.sendJson(res, 404, { error: 'no such endpoint', code: 'not_found' });
        }
        const callJobsGet = matchCallJobsRoute(route);
        if (callJobsGet) {
          if (callJobsGet.action === 'list') return core.requireAuth(req, res, apiCallJobsList);
          if (callJobsGet.action === 'one') {
            return core.requireAuth(req, res, (rq, rs, ctx) => apiCallJobsGet(rq, rs, { ...ctx, params: { id: callJobsGet.id } }));
          }
          return core.sendJson(res, 404, { error: 'no such endpoint', code: 'not_found' });
        }
        const empGet = matchEmployeesRoute(route);
        if (empGet) {
          if (empGet.action === 'templates') return core.requireAuth(req, res, apiEmployeeTemplates);
          if (empGet.action === 'languages') return core.requireAuth(req, res, apiEmployeeLanguages);
          if (empGet.action === 'action_types') return core.requireAuth(req, res, apiEmployeeActionTypes);
          if (empGet.action === 'list_or_create') return core.requireAuth(req, res, apiEmployeesList);
          if (empGet.action === 'one') {
            return core.requireAuth(req, res, (rq, rs, ctx) => apiEmployeesGet(rq, rs, { ...ctx, params: { id: empGet.id } }));
          }
          if (empGet.action === 'instructions') {
            return core.requireAuth(req, res, (rq, rs, ctx) => apiEmployeesInstructionsGet(rq, rs, { ...ctx, params: { id: empGet.id } }));
          }
          if (empGet.action === 'workflow') {
            return core.requireAuth(req, res, (rq, rs, ctx) => apiEmployeesWorkflowGet(rq, rs, { ...ctx, params: { id: empGet.id } }));
          }
          if (empGet.action === 'timeline') {
            return core.requireAuth(req, res, (rq, rs, ctx) => apiEmployeesTimelineGet(rq, rs, { ...ctx, params: { id: empGet.id } }));
          }
          if (empGet.action === 'training') {
            return core.requireAuth(req, res, (rq, rs, ctx) => apiEmployeesTrainingGet(rq, rs, { ...ctx, params: { id: empGet.id } }));
          }
          if (empGet.action === 'outcomes') {
            return core.requireAuth(req, res, (rq, rs, ctx) => apiEmployeesOutcomesGet(rq, rs, { ...ctx, params: { id: empGet.id } }));
          }
          if (empGet.action === 'actions') {
            return core.requireAuth(req, res, (rq, rs, ctx) => apiEmployeesActionsGet(rq, rs, { ...ctx, params: { id: empGet.id } }));
          }
          if (empGet.action === 'leads') {
            return core.requireAuth(req, res, (rq, rs, ctx) => apiEmployeesLeadsList(rq, rs, { ...ctx, params: { id: empGet.id } }));
          }
          return core.sendJson(res, 404, { error: 'no such endpoint', code: 'not_found' });
        }
        if (route === '/api/hvac/desk') return core.requireAuth(req, res, apiHvacDesk);
        if (route === '/api/hvac/event-types') return core.requireAuth(req, res, apiHvacEventTypes);
        if (route === '/api/hvac/slots') return core.requireAuth(req, res, apiHvacSlots);
        return core.sendJson(res, 404, { error: 'no such endpoint', code: 'not_found' });
      }

      // ---- PATCH phone number toggles / workflow drafts / employees / leads ----
      if (req.method === 'PATCH') {
        const pnPatch = matchPhoneNumberRoute(route);
        if (pnPatch && (pnPatch.action === 'one' || pnPatch.action === 'inbound')) {
          let body;
          try { body = await core.readBody(req); }
          catch (e) {
            const tooBig = /too large/.test(String(e.message));
            return core.sendJson(res, tooBig ? 413 : 400, { error: e.message, code: tooBig ? 'too_large' : 'bad_body' });
          }
          if (pnPatch.action === 'inbound') {
            return core.requireAuth(req, res, (rq, rs, ctx) => apiPhoneNumbersInboundPut(rq, rs, { ...ctx, params: { id: pnPatch.id } }), body);
          }
          return core.requireAuth(req, res, (rq, rs, ctx) => apiPhoneNumbersPatch(rq, rs, { ...ctx, params: { id: pnPatch.id } }), body);
        }
        const wfPatch = matchWorkflowRoute(route);
        if (wfPatch && wfPatch.action === 'one') {
          let body;
          try { body = await core.readBody(req, 256 * 1024); }
          catch (e) {
            const tooBig = /too large/.test(String(e.message));
            return core.sendJson(res, tooBig ? 413 : 400, { error: e.message, code: tooBig ? 'too_large' : 'bad_body' });
          }
          return core.requireAuth(req, res, (rq, rs, ctx) => apiWorkflowsPatch(rq, rs, { ...ctx, params: { id: wfPatch.id } }), body);
        }
        const leadsPatch = matchLeadsRoute(route);
        if (leadsPatch && leadsPatch.action === 'one') {
          let body;
          try { body = await core.readBody(req); }
          catch (e) {
            const tooBig = /too large/.test(String(e.message));
            return core.sendJson(res, tooBig ? 413 : 400, { error: e.message, code: tooBig ? 'too_large' : 'bad_body' });
          }
          return core.requireAuth(req, res, (rq, rs, ctx) => apiLeadsPatch(rq, rs, { ...ctx, params: { id: leadsPatch.id } }), body);
        }
        const empPatch = matchEmployeesRoute(route);
        if (empPatch) {
          let body;
          try { body = await core.readBody(req, 256 * 1024); }
          catch (e) {
            const tooBig = /too large/.test(String(e.message));
            return core.sendJson(res, tooBig ? 413 : 400, { error: e.message, code: tooBig ? 'too_large' : 'bad_body' });
          }
          if (empPatch.action === 'one') {
            return core.requireAuth(req, res, (rq, rs, ctx) => apiEmployeesPatch(rq, rs, { ...ctx, params: { id: empPatch.id } }), body);
          }
          if (empPatch.action === 'instructions') {
            return core.requireAuth(req, res, (rq, rs, ctx) => apiEmployeesInstructionsPut(rq, rs, { ...ctx, params: { id: empPatch.id } }), body);
          }
          if (empPatch.action === 'workflow') {
            return core.requireAuth(req, res, (rq, rs, ctx) => apiEmployeesWorkflowPut(rq, rs, { ...ctx, params: { id: empPatch.id } }), body);
          }
          if (empPatch.action === 'outcomes') {
            return core.requireAuth(req, res, (rq, rs, ctx) => apiEmployeesOutcomesPut(rq, rs, { ...ctx, params: { id: empPatch.id } }), body);
          }
          if (empPatch.action === 'actions') {
            return core.requireAuth(req, res, (rq, rs, ctx) => apiEmployeesActionsPut(rq, rs, { ...ctx, params: { id: empPatch.id } }), body);
          }
          if (empPatch.action === 'language') {
            return core.requireAuth(req, res, (rq, rs, ctx) => apiEmployeesLanguagePut(rq, rs, { ...ctx, params: { id: empPatch.id } }), body);
          }
        }
        return core.sendJson(res, 405, { error: 'method not allowed', code: 'method' });
      }

      if (req.method === 'PUT') {
        const pnPut = matchPhoneNumberRoute(route);
        if (pnPut && pnPut.action === 'inbound') {
          let body;
          try { body = await core.readBody(req); }
          catch (e) {
            const tooBig = /too large/.test(String(e.message));
            return core.sendJson(res, tooBig ? 413 : 400, { error: e.message, code: tooBig ? 'too_large' : 'bad_body' });
          }
          return core.requireAuth(req, res, (rq, rs, ctx) => apiPhoneNumbersInboundPut(rq, rs, { ...ctx, params: { id: pnPut.id } }), body);
        }
        const empPut = matchEmployeesRoute(route);
        if (empPut && (empPut.action === 'instructions' || empPut.action === 'outcomes' || empPut.action === 'workflow'
          || empPut.action === 'actions' || empPut.action === 'language')) {
          let body;
          try { body = await core.readBody(req, 256 * 1024); }
          catch (e) {
            const tooBig = /too large/.test(String(e.message));
            return core.sendJson(res, tooBig ? 413 : 400, { error: e.message, code: tooBig ? 'too_large' : 'bad_body' });
          }
          if (empPut.action === 'instructions') {
            return core.requireAuth(req, res, (rq, rs, ctx) => apiEmployeesInstructionsPut(rq, rs, { ...ctx, params: { id: empPut.id } }), body);
          }
          if (empPut.action === 'workflow') {
            return core.requireAuth(req, res, (rq, rs, ctx) => apiEmployeesWorkflowPut(rq, rs, { ...ctx, params: { id: empPut.id } }), body);
          }
          if (empPut.action === 'actions') {
            return core.requireAuth(req, res, (rq, rs, ctx) => apiEmployeesActionsPut(rq, rs, { ...ctx, params: { id: empPut.id } }), body);
          }
          if (empPut.action === 'language') {
            return core.requireAuth(req, res, (rq, rs, ctx) => apiEmployeesLanguagePut(rq, rs, { ...ctx, params: { id: empPut.id } }), body);
          }
          return core.requireAuth(req, res, (rq, rs, ctx) => apiEmployeesOutcomesPut(rq, rs, { ...ctx, params: { id: empPut.id } }), body);
        }
        return core.sendJson(res, 405, { error: 'method not allowed', code: 'method' });
      }

      if (req.method === 'DELETE') {
        const empDel = matchEmployeesRoute(route);
        if (empDel && empDel.action === 'knowledge_one') {
          return core.requireAuth(req, res, (rq, rs, ctx) => apiEmployeesKnowledgeDetach(rq, rs, {
            ...ctx,
            params: { id: empDel.id, knowledgeId: empDel.knowledgeId },
          }));
        }
        return core.sendJson(res, 405, { error: 'method not allowed', code: 'method' });
      }

      if (req.method !== 'POST') {
        return core.sendJson(res, 405, { error: 'method not allowed', code: 'method' });
      }

      // ---- POST routes: read the body once, with a bigger cap for STT audio ----
      let body;
      try {
        body = await core.readBody(req, route === '/api/stt' ? 12 * 1024 * 1024 : 64 * 1024);
      } catch (e) {
        const tooBig = /too large/.test(String(e.message));
        return core.sendJson(res, tooBig ? 413 : 400, {
          error: e.message, code: tooBig ? 'too_large' : 'bad_body',
        });
      }

      // Public POST (auth) routes.
      if (route === '/api/auth/signup') return apiSignup(req, res, body);
      if (route === '/api/auth/login') return apiLogin(req, res, body);
      if (route === '/api/auth/logout') return apiLogout(req, res);
      if (route === '/api/auth/impersonation/exit') return core.requireAuth(req, res, apiImpersonationExit, body);
      if (route === '/api/callback' || route === '/api/outbound/callback') {
        return apiOutboundCallback(req, res, body);
      }
      if (route.startsWith('/api/public/demo/') && route.endsWith('/session')) {
        const token = decodeURIComponent(route.slice('/api/public/demo/'.length, -'/session'.length));
        if (token.includes('/') || !core.rateOk(`demo-start:${ip}`, 5, 5)) return core.sendJson(res, token.includes('/') ? 404 : 429, { error: token.includes('/') ? 'demo link not found' : 'too many demo starts, try again shortly', code: token.includes('/') ? 'not_found' : 'demo_rate' });
        return apiPublicDemoSession(req, res, token);
      }

      // Authed POST routes (tenant scoped through requireAuth).
      const callsPost = matchCallsRoute(route);
      if (callsPost && callsPost.action === 'sync') {
        return core.requireAuth(req, res, apiCallsSync, body);
      }
      const wfPost = matchWorkflowRoute(route);
      if (wfPost) {
        if (wfPost.action === 'list_or_create') {
          return core.requireAuth(req, res, apiWorkflowsCreate, body);
        }
        if (wfPost.action === 'import') {
          return core.requireRole(req, res, 'owner', apiWorkflowsImport, body);
        }
        if (wfPost.action === 'publish') {
          return core.requireAuth(req, res, (rq, rs, ctx) => apiWorkflowsPublish(rq, rs, { ...ctx, params: { id: wfPost.id } }), body);
        }
        return core.sendJson(res, 404, { error: 'no such endpoint', code: 'not_found' });
      }
      const pnPost = matchPhoneNumberRoute(route);
      if (pnPost) {
        if (pnPost.action === 'assign') {
          return core.requireAuth(req, res, (rq, rs, ctx) => apiPhoneNumbersAssign(rq, rs, { ...ctx, params: { id: pnPost.id } }), body);
        }
        if (pnPost.action === 'unassign') {
          return core.requireAuth(req, res, (rq, rs, ctx) => apiPhoneNumbersUnassign(rq, rs, { ...ctx, params: { id: pnPost.id } }), body);
        }
        if (pnPost.action === 'purchase') {
          return core.requireAuth(req, res, apiPhoneNumbersPurchase, body);
        }
        return core.sendJson(res, 404, { error: 'no such endpoint', code: 'not_found' });
      }
      if (route === '/api/agents') return core.requireAuth(req, res, apiAgentsCreate, body);
      if (route === '/api/agents/update') return core.requireAuth(req, res, apiAgentsUpdate, body);
      if (route === '/api/agents/delete') return core.requireAuth(req, res, apiAgentsDelete, body);
      if (route === '/api/tts') return core.requireAuth(req, res, apiTts, body);
      if (route === '/api/ws-connect') return core.requireAuth(req, res, apiWsConnect, body);
      if (route === '/api/chat') return core.requireAuth(req, res, apiChat, body);
      if (route === '/api/stt') return core.requireAuth(req, res, apiStt, body);
      if (route === '/api/voice/session') return core.requireAuth(req, res, apiVoiceSession, body);
      if (route === '/api/demo-links') return core.requireRole(req, res, 'owner', apiDemoLinksCreate, body);
      if (route === '/api/demo-links/revoke') return core.requireRole(req, res, 'owner', apiDemoLinksRevoke, body);
      if (route === '/api/telephony/dial') return core.requireAuth(req, res, apiTelephonyDial, body);
      if (route === '/api/payment-intents') return core.requireAuth(req, res, apiPaymentIntentCreate, body);
      if (route === '/api/plans/upgrade') return core.requireRole(req, res, 'owner', apiPlansUpgrade, body);
      if (route === '/api/support/tickets') return core.requireAuth(req, res, apiSupportCreate, body);
      if (route === '/api/support/tickets/reply') return core.requireAuth(req, res, apiSupportReply, body);
      if (route === '/api/tenant/update') return core.requireRole(req, res, 'owner', apiTenantUpdate, body);
      if (route === '/api/knowledge') return core.requireAuth(req, res, apiKnowledgeCreate, body);
      if (route === '/api/knowledge/update') return core.requireAuth(req, res, apiKnowledgeUpdate, body);
      if (route === '/api/knowledge/delete') return core.requireAuth(req, res, apiKnowledgeDelete, body);
      if (route === '/api/knowledge/retrieve') return core.requireAuth(req, res, apiKnowledgeRetrieve, body);
      if (route === '/api/integrations/webhooks') return core.requireRole(req, res, 'owner', apiIntegrationsWebhookCreate, body);
      if (route === '/api/integrations/webhooks/update') return core.requireRole(req, res, 'owner', apiIntegrationsWebhookUpdate, body);
      if (route === '/api/integrations/webhooks/delete') return core.requireRole(req, res, 'owner', apiIntegrationsWebhookDelete, body);
      if (route === '/api/integrations/lead-created') return core.requireAuth(req, res, apiIntegrationsLeadCreated, body);
      if (route === '/api/campaigns') return core.requireAuth(req, res, apiCampaignsCreate, body);
      if (route === '/api/campaigns/leads') return core.requireAuth(req, res, apiCampaignsAddLeads, body);
      if (route === '/api/campaigns/status') return core.requireAuth(req, res, apiCampaignsStatus, body);
      if (route === '/api/campaigns/employee') return core.requireAuth(req, res, apiCampaignsAttachEmployee, body);
      if (route === '/api/campaigns/enqueue') return core.requireAuth(req, res, apiCampaignsEnqueue, body);
      const leadsPost = matchLeadsRoute(route);
      if (leadsPost) {
        if (leadsPost.action === 'list_or_create') {
          return core.requireAuth(req, res, apiLeadsCreate, body);
        }
        if (leadsPost.action === 'call') {
          return core.requireAuth(req, res, (rq, rs, ctx) => apiLeadsCall(rq, rs, { ...ctx, params: { id: leadsPost.id } }), body);
        }
        return core.sendJson(res, 404, { error: 'no such endpoint', code: 'not_found' });
      }
      const empPost = matchEmployeesRoute(route);
      if (empPost) {
        if (empPost.action === 'list_or_create') {
          return core.requireAuth(req, res, apiEmployeesCreate, body);
        }
        if (empPost.action === 'status') {
          return core.requireAuth(req, res, (rq, rs, ctx) => apiEmployeesStatus(rq, rs, { ...ctx, params: { id: empPost.id } }), body);
        }
        if (empPost.action === 'pause') {
          return core.requireAuth(req, res, (rq, rs, ctx) => apiEmployeesPause(rq, rs, { ...ctx, params: { id: empPost.id } }), body);
        }
        if (empPost.action === 'resume') {
          return core.requireAuth(req, res, (rq, rs, ctx) => apiEmployeesResume(rq, rs, { ...ctx, params: { id: empPost.id } }), body);
        }
        if (empPost.action === 'knowledge') {
          return core.requireAuth(req, res, (rq, rs, ctx) => apiEmployeesKnowledgePost(rq, rs, { ...ctx, params: { id: empPost.id } }), body);
        }
        if (empPost.action === 'instructions') {
          return core.requireAuth(req, res, (rq, rs, ctx) => apiEmployeesInstructionsPut(rq, rs, { ...ctx, params: { id: empPost.id } }), body);
        }
        if (empPost.action === 'outcomes') {
          return core.requireAuth(req, res, (rq, rs, ctx) => apiEmployeesOutcomesPut(rq, rs, { ...ctx, params: { id: empPost.id } }), body);
        }
        if (empPost.action === 'actions') {
          return core.requireAuth(req, res, (rq, rs, ctx) => apiEmployeesActionsPut(rq, rs, { ...ctx, params: { id: empPost.id } }), body);
        }
        if (empPost.action === 'actions_execute') {
          return core.requireAuth(req, res, (rq, rs, ctx) => apiEmployeesActionsExecute(rq, rs, { ...ctx, params: { id: empPost.id } }), body);
        }
        if (empPost.action === 'language') {
          return core.requireAuth(req, res, (rq, rs, ctx) => apiEmployeesLanguagePut(rq, rs, { ...ctx, params: { id: empPost.id } }), body);
        }
        return core.sendJson(res, 404, { error: 'no such endpoint', code: 'not_found' });
      }
      if (route === '/api/byon') return core.requireRole(req, res, 'owner', apiByonSave, body);
      if (route === '/api/privacy') return core.requireRole(req, res, 'owner', apiPrivacyMode, body);
      if (route === '/api/members/role') return core.requireRole(req, res, 'owner', apiMemberRole, body);
      if (route === '/api/admin/tenants/status') return core.requireRole(req, res, 'super_admin', apiAdminTenantStatus, body);
      if (route === '/api/admin/users/status') return core.requireRole(req, res, 'super_admin', apiAdminUserStatus, body);
      if (route === '/api/admin/users/role') return core.requireRole(req, res, 'super_admin', apiAdminUserRole, body);
      if (route === '/api/admin/wallet/adjust') return core.requireRole(req, res, 'admin', apiAdminWalletAdjust, body);
      if (route === '/api/admin/wallet/test-credits') return core.requireRole(req, res, 'admin', apiAdminTestCredits, body);
      if (route === '/api/admin/tickets/reply') return core.requireRole(req, res, 'admin', apiAdminTicketReply, body);
      if (route === '/api/admin/tickets/update') return core.requireRole(req, res, 'admin', apiAdminTicketUpdate, body);
      if (route === '/api/admin/impersonations') return core.requireRole(req, res, 'super_admin', apiAdminImpersonate, body);
      if (route === '/api/hvac/jobs') return core.requireAuth(req, res, apiHvacJobSave, body);
      if (route === '/api/hvac/book') return core.requireAuth(req, res, apiHvacBook, body);

      return core.sendJson(res, 404, { error: 'no such endpoint', code: 'not_found' });
    }

    if (req.method === 'GET' && route.startsWith('/demo/')) {
      req.url = '/demo.html';
    }

    // Ops console is Super Admin only. Anonymous and customer sessions go to the product app.
    // Always noindex so the ops URL is not a customer or crawl path.
    if ((req.method === 'GET' || req.method === 'HEAD') && (route === '/console.html' || route === '/console')) {
      const ctx = await core.getSession(req);
      if (!(ctx && ctx.user && ctx.user.role === 'super_admin')) {
        res.writeHead(302, {
          Location: '/app.html',
          'Cache-Control': 'no-store',
          'X-Robots-Tag': 'noindex, nofollow',
        });
        return res.end();
      }
      const file = path.join(core.PUBLIC_DIR, 'console.html');
      return fs.readFile(file, (err, data) => {
        if (err) return core.send(res, 404, 'not found');
        if (req.method === 'HEAD') {
          return core.send(res, 200, '', {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store',
            'X-Robots-Tag': 'noindex, nofollow',
            'Content-Length': Buffer.byteLength(data),
          });
        }
        core.send(res, 200, data, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'X-Robots-Tag': 'noindex, nofollow',
        });
      });
    }

    // Everything else is a static file from public/.
    core.serveStatic(req, res);
  } catch (e) {
    core.sendJson(res, 500, { error: String((e && e.message) || e), code: 'server' });
  }
});

/* ==========================================================================
   Authenticated Deepgram live transcription proxy.

   The browser sends MediaRecorder chunks to this same-origin socket. The
   permanent Deepgram API key remains server side, while Deepgram's interim and
   final Results events are relayed unchanged for word-by-word UI updates.
   ========================================================================== */

const sttWss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });

function rejectUpgrade(socket, status, label) {
  if (!socket.writable) return socket.destroy();
  socket.write(`HTTP/1.1 ${status} ${label}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

server.on('upgrade', async (req, socket, head) => {
  const route = (req.url || '').split('?')[0];
  if (route !== '/api/stt/stream') return rejectUpgrade(socket, 404, 'Not Found');

  const ip = req.socket.remoteAddress || 'local';
  if (!core.rateOk(ip)) return rejectUpgrade(socket, 429, 'Too Many Requests');

  try {
    const ctx = await core.getSession(req);
    if (!ctx) return rejectUpgrade(socket, 401, 'Unauthorized');
    sttWss.handleUpgrade(req, socket, head, (client) => {
      sttWss.emit('connection', client, req, ctx);
    });
  } catch (_) {
    rejectUpgrade(socket, 500, 'Internal Server Error');
  }
});

sttWss.on('connection', (client) => {
  const key = process.env.DEEPGRAM_API_KEY;
  if (!key) {
    client.send(JSON.stringify({ type: 'ProxyError', message: 'Deepgram is not configured.' }));
    return client.close(1011, 'Deepgram unavailable');
  }

  const query = new URLSearchParams({
    model: providers.stt.model,
    language: 'multi',
    smart_format: 'true',
    punctuate: 'true',
    interim_results: 'true',
    endpointing: '300',
    utterance_end_ms: '1000',
    vad_events: 'true',
  });
  const upstream = new WebSocket(`wss://api.deepgram.com/v1/listen?${query}`, {
    headers: { Authorization: `Token ${key}` },
    maxPayload: 1024 * 1024,
  });
  let upstreamReady = false;
  let closed = false;

  const closeBoth = () => {
    if (closed) return;
    closed = true;
    clearInterval(keepAlive);
    if (client.readyState === WebSocket.OPEN) client.close();
    if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) upstream.close();
  };

  const keepAlive = setInterval(() => {
    if (upstream.readyState === WebSocket.OPEN) upstream.send(JSON.stringify({ type: 'KeepAlive' }));
  }, 4000);

  upstream.on('open', () => {
    upstreamReady = true;
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({ type: 'ProxyReady', provider: 'deepgram', model: providers.stt.model }));
    }
  });
  upstream.on('message', (data, isBinary) => {
    if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary });
  });
  upstream.on('error', () => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({ type: 'ProxyError', message: 'Deepgram live stream failed.' }));
    }
    closeBoth();
  });
  upstream.on('close', () => closeBoth());

  client.on('message', (data, isBinary) => {
    if (!upstreamReady || upstream.readyState !== WebSocket.OPEN) return;
    if (isBinary) upstream.send(data, { binary: true });
    else upstream.send(data.toString());
  });
  client.on('error', () => closeBoth());
  client.on('close', () => closeBoth());
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`\n  PORT ${PORT} is already in use. Stop the other process or set PORT to a free port, for example: PORT=8788 node server.js\n`);
    process.exit(1);
  }
  console.error('  server error:', e.message);
  process.exit(1);
});

// Boot then listen.
boot().then(() => {
  server.listen(PORT, () => {
    const live = providers.describeProviders();
    const flag = (layer, id) => (live[layer].find((p) => p.id === id) || {}).live ? 'ok' : 'MISSING';
    console.log('\n  Astra AI  ready');
    console.log(`  Marketing : http://localhost:${PORT}/`);
    console.log(`  Console   : http://localhost:${PORT}/app.html`);
    if (DEMO_EMAIL) console.log(`  Test login: ${DEMO_EMAIL}`);
    console.log(`  Providers : deepgram ${flag('stt', 'deepgram')}  groq ${flag('llm', 'groq')}  rumik ${flag('tts', 'rumik')}  vobiz ${flag('telephony', 'vobiz')}\n`);
    startCallbackJobPoller();
  });
}).catch((e) => {
  console.error('  boot failed:', e.message);
  process.exit(1);
});
