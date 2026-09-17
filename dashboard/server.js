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
const { createDefaultTelephonyProvider, TelephonyProviderError } = require('./lib/telephony-provider');
const { AGENT_TYPES, seedPresets, publicPreset, applyPresetToAgent, normalizeAgentType } = require('./lib/agent-types');
const org = require('./lib/org');
const knowledge = require('./lib/knowledge');
const integrations = require('./lib/integrations');
const campaigns = require('./lib/campaigns');
const analytics = require('./lib/analytics');
const plans = require('./lib/plans');
const workflows = require('./lib/workflows');
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

// GET /api/telephony/status -> VoBiz configuration status from Dograh.
async function apiTelephonyStatus(req, res) {
  try {
    const status = await providers.telephony.status();
    core.sendJson(res, 200, { ...status, provider: 'vobiz', orchestrator: 'dograh' });
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
    const r = await telephonyProvider.createOutboundCall(ctx.tenant.id, b.number, { workflowId });
    // Count the dial attempt against today's usage.
    bumpUsage(ctx.tenant.id, 'calls', 1).catch(() => {});
    core.mutate((d) => {
      plans.debitUsage(d, ctx.tenant.id, { chars: 0, calls: 1 }, ctx.user.id, addLedgerEntry);
    }).catch(() => {});
    core.sendJson(res, r.status, r.data);
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

function apiPhoneNumbersList(req, res, ctx) {
  const agentsById = agentsMapForTenant(ctx.tenant.id);
  const workflowsById = workflowsMapForTenant(ctx.tenant.id);
  const numbers = phoneNumbers.listTenantNumbers(core.db(), ctx.tenant.id)
    .map((n) => phoneNumbers.publicPhoneNumber(n, agentsById, workflowsById));
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
  const agentId = String(b.agentId || '').trim();
  if (!agentId) {
    return core.sendJson(res, 422, { error: 'agentId is required', code: 'validation' });
  }
  try {
    const number = await telephonyProvider.assignNumber(ctx.params.id, ctx.tenant.id, {
      agentId,
      inboundEnabled: b.inboundEnabled,
      outboundEnabled: b.outboundEnabled,
      inboundWorkflowId: b.inboundWorkflowId,
      outboundWorkflowId: b.outboundWorkflowId,
    });
    await core.mutate((d) => {
      addAudit(d, ctx, 'phone_number.assigned', 'phone_number', number.id, {
        agentId, e164: number.e164,
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
  const agentsById = agentsMapForTenant(ctx.tenant.id);
  const workflowsById = workflowsMapForTenant(ctx.tenant.id);
  core.sendJson(res, 200, { number: phoneNumbers.publicPhoneNumber(result.number, agentsById, workflowsById) });
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
  const one = route.match(/^\/api\/phone-numbers\/([^/]+)$/);
  if (one) return { action: 'one', id: decodeURIComponent(one[1]) };
  return null;
}

/* ==========================================================================
   Calls control plane (tenant-scoped history + Dograh sync)
   ========================================================================== */

function matchCallsRoute(route) {
  if (route === '/api/calls') return { action: 'list' };
  if (route === '/api/calls/sync') return { action: 'sync' };
  const recording = route.match(/^\/api\/calls\/([^/]+)\/recording$/);
  if (recording) return { action: 'recording', id: decodeURIComponent(recording[1]) };
  const one = route.match(/^\/api\/calls\/([^/]+)$/);
  if (one) return { action: 'detail', id: decodeURIComponent(one[1]) };
  return null;
}

async function apiCallsList(req, res, ctx) {
  try {
    const url = new URL(req.url || '/', 'http://localhost');
    const filters = {
      agentId: url.searchParams.get('agentId') || undefined,
      direction: url.searchParams.get('direction') || undefined,
      limit: url.searchParams.get('limit') || undefined,
    };
    const list = await telephonyProvider.listCalls(ctx.tenant.id, filters);
    core.sendJson(res, 200, { calls: list });
  } catch (e) {
    handleProviderError(res, e);
  }
}

async function apiCallsDetail(req, res, ctx) {
  try {
    const call = await telephonyProvider.getCall(ctx.params.id, ctx.tenant.id);
    core.sendJson(res, 200, { call });
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
  core.sendJson(res, 200, {
    wallet: publicWallet(wallet || { id: null, tenantId: ctx.tenant.id, currency: 'INR', balancePaise: 0 }),
    ledger,
    plan,
    packs: Object.keys(CREDIT_PACKS).map((id) => ({
      id,
      amountInr: Number(CREDIT_PACKS[id].amount),
      creditsPaise: CREDIT_PACKS[id].credits,
      productinfo: CREDIT_PACKS[id].productinfo,
    })),
    usageDays: usage,
    payuEnv: (payuConfig() && payuConfig().env) || (process.env.PAYU_ENV === 'production' ? 'production' : 'test'),
    payuConfigured: !!payuConfig(),
  });
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
  core.sendJson(res, 200, result);
}

function apiCampaignsLeads(req, res, ctx) {
  const url = new URL(req.url, 'http://localhost');
  const id = String(url.searchParams.get('campaignId') || '');
  const result = campaigns.listLeads(core.db(), ctx.tenant.id, id);
  if (!result.ok) return core.sendJson(res, result.status, { error: result.error, code: result.code });
  core.sendJson(res, 200, result);
}

function apiAnalytics(req, res, ctx) {
  core.sendJson(res, 200, { analytics: analytics.buildDashboard(core.db(), ctx.tenant.id) });
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

// GET /api/providers -> the registry so Settings can render active vs available.
function apiProviders(req, res) {
  core.sendJson(res, 200, providers.describeProviders());
}

// GET /api/health -> public readiness only. Provider inventory is super_admin only.
async function apiHealth(req, res) {
  const ctx = await core.getSession(req);
  if (!ctx || ctx.user.role !== 'super_admin') {
    return core.sendJson(res, 200, org.publicHealthPayload());
  }
  const payload = org.detailedHealthPayload(providers.describeProviders());
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
      if (route === '/api/providers' && req.method === 'GET') return apiProviders(req, res);
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
        if (route === '/api/agents') return core.requireAuth(req, res, apiAgentsList);
        if (route === '/api/usage') return core.requireAuth(req, res, apiUsage);
        if (route === '/api/telephony/status') return core.requireAuth(req, res, apiTelephonyStatus);
        if (route === '/api/presets') return core.requireAuth(req, res, apiPresets);
        if (route === '/api/agent-types') return core.requireAuth(req, res, apiAgentTypes);
        if (route === '/api/wallet') return core.requireAuth(req, res, apiWallet);
        if (route === '/api/plans') return core.requireAuth(req, res, apiPlansList);
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
        if (route === '/api/admin/providers') return core.requireRole(req, res, 'admin', apiAdminProviderHealth);
        if (route === '/api/knowledge') return core.requireAuth(req, res, apiKnowledgeList);
        if (route === '/api/knowledge/retrieve') return core.requireAuth(req, res, apiKnowledgeRetrieve);
        if (route === '/api/integrations') return core.requireAuth(req, res, apiIntegrationsList);
        if (route === '/api/campaigns') return core.requireAuth(req, res, apiCampaignsList);
        if (route === '/api/campaigns/leads') return core.requireAuth(req, res, apiCampaignsLeads);
        if (route === '/api/analytics') return core.requireAuth(req, res, apiAnalytics);
        if (route === '/api/hvac/desk') return core.requireAuth(req, res, apiHvacDesk);
        if (route === '/api/hvac/event-types') return core.requireAuth(req, res, apiHvacEventTypes);
        if (route === '/api/hvac/slots') return core.requireAuth(req, res, apiHvacSlots);
        return core.sendJson(res, 404, { error: 'no such endpoint', code: 'not_found' });
      }

      // ---- PATCH phone number toggles / workflow drafts ----
      if (req.method === 'PATCH') {
        const pnPatch = matchPhoneNumberRoute(route);
        if (pnPatch && pnPatch.action === 'one') {
          let body;
          try { body = await core.readBody(req); }
          catch (e) {
            const tooBig = /too large/.test(String(e.message));
            return core.sendJson(res, tooBig ? 413 : 400, { error: e.message, code: tooBig ? 'too_large' : 'bad_body' });
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
      if (route === '/api/campaigns/enqueue') return core.requireAuth(req, res, apiCampaignsEnqueue, body);
      if (route === '/api/byon') return core.requireRole(req, res, 'owner', apiByonSave, body);
      if (route === '/api/privacy') return core.requireRole(req, res, 'owner', apiPrivacyMode, body);
      if (route === '/api/members/role') return core.requireRole(req, res, 'owner', apiMemberRole, body);
      if (route === '/api/admin/tenants/status') return core.requireRole(req, res, 'super_admin', apiAdminTenantStatus, body);
      if (route === '/api/admin/users/status') return core.requireRole(req, res, 'super_admin', apiAdminUserStatus, body);
      if (route === '/api/admin/users/role') return core.requireRole(req, res, 'super_admin', apiAdminUserRole, body);
      if (route === '/api/admin/wallet/adjust') return core.requireRole(req, res, 'admin', apiAdminWalletAdjust, body);
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
    if ((req.method === 'GET' || req.method === 'HEAD') && (route === '/console.html' || route === '/console')) {
      const ctx = await core.getSession(req);
      if (!(ctx && ctx.user && ctx.user.role === 'super_admin')) {
        res.writeHead(302, { Location: '/app.html', 'Cache-Control': 'no-store' });
        return res.end();
      }
      req.url = '/console.html';
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
