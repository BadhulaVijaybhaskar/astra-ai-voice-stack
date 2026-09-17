'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const core = require('../lib/core');
const org = require('../lib/org');
const providers = require('../lib/providers');
const employees = require('../lib/employees');
const phoneNumbers = require('../lib/phone-numbers');
const leads = require('../lib/leads');
const callJobs = require('../lib/call-jobs');
const calls = require('../lib/calls');
const timeline = require('../lib/timeline');
const analytics = require('../lib/analytics');
const plans = require('../lib/plans');

const PROVIDER_BRAND_RE = /vobiz|dograh|deepgram|rumik|groq/i;

function baseDb() {
  return {
    schemaVersion: 13,
    tenants: [
      { id: 't_a', name: 'Acme Voice', status: 'active', plan: 'starter' },
      { id: 't_b', name: 'Other Co', status: 'active', plan: 'starter' },
    ],
    users: [],
    agents: [{ id: 'ag_1', tenantId: 't_a', name: 'Desk', greeting: 'Hello from Desk', telephony: { did: '' } }],
    employees: [],
    phoneNumbers: [],
    providerResources: [],
    workflows: [],
    campaigns: [],
    campaignLeads: [],
    leads: [],
    callJobs: [],
    calls: [],
    knowledgeEntries: [],
    supportTickets: [],
    wallets: [{ id: 'w1', tenantId: 't_a', currency: 'INR', balancePaise: 0, createdAt: 't', updatedAt: 't' }],
    ledger: [],
  };
}

function addLedgerEntry(d, tenantId, amountPaise, type, reference, actorUserId, metadata = {}) {
  const key = String(reference || '');
  if (key && d.ledger.some((x) => x.tenantId === tenantId && x.idempotencyKey === key)) return null;
  let wallet = d.wallets.find((w) => w.tenantId === tenantId);
  const now = new Date().toISOString();
  if (!wallet) {
    wallet = { id: 'wal_1', tenantId, currency: 'INR', balancePaise: 0, createdAt: now, updatedAt: now };
    d.wallets.push(wallet);
  }
  if (!Number.isInteger(amountPaise) || wallet.balancePaise + amountPaise < 0) {
    throw new Error('invalid wallet adjustment');
  }
  wallet.balancePaise += amountPaise;
  wallet.updatedAt = now;
  const entry = {
    id: 'led_' + d.ledger.length,
    tenantId,
    type,
    amountPaise,
    balanceAfterPaise: wallet.balancePaise,
    idempotencyKey: key,
    actorUserId,
    metadata,
    createdAt: now,
  };
  d.ledger.push(entry);
  return entry;
}

function assertNoProviderLeak(value, label) {
  const blob = JSON.stringify(value);
  assert.equal(blob.includes('providerRunId'), false, label + ' leaked providerRunId');
  assert.equal(PROVIDER_BRAND_RE.test(blob), false, label + ' leaked provider brand');
  assert.equal(blob.toLowerCase().includes('dograh'), false, label + ' leaked dograh');
  assert.equal(blob.toLowerCase().includes('vobiz'), false, label + ' leaked vobiz');
}

test('Phase 21: buildDiagnosticsConsole is Super Admin scoped and leak-safe', () => {
  const described = providers.describeProviders();
  const db = baseDb();
  db.tenants[0].status = 'suspended';
  const payload = org.buildDiagnosticsConsole({
    described,
    db,
    deploy: { gitSha: 'abc123', deployedAt: '2026-09-17T12:00:00Z', ref: 'refs/heads/main' },
    version: '1.0.0',
    uptimeSec: 12.8,
  });
  assert.equal(payload.ok, true);
  assert.equal(payload.scope, 'super_admin');
  assert.equal(payload.customerVisible, false);
  assert.equal(payload.overview.suspendedTenants, 1);
  assert.equal(payload.overview.tenants, 2);
  assert.equal(payload.schemaVersion, 13);
  assert.equal(payload.deploy.gitSha, 'abc123');
  assert.equal(payload.deploy.uptimeSec, 12);
  assert.ok(payload.providers.stt || payload.providers.tts || payload.providers.llm);
  assert.equal(payload.capabilities.providerInventory, true);
  assert.equal(payload.capabilities.tenantSuspendActivate, true);
  assert.equal(payload.capabilities.testCreditGrant, true);
  const check = org.assertNoSecretValues(payload, {
    DEEPGRAM_API_KEY: 'secret-deepgram-zzzzzzzz',
    RUMIK_API_KEY: 'secret-rumik-yyyyyyyy',
  });
  assert.equal(check.ok, true);
});

test('Phase 21: tenant suspend/activate remains available on tenant model', () => {
  const db = baseDb();
  const tenant = db.tenants[0];
  assert.equal(tenant.status, 'active');
  tenant.status = 'suspended';
  assert.equal(tenant.status, 'suspended');
  tenant.status = 'active';
  assert.equal(tenant.status, 'active');
  const diag = org.buildDiagnosticsConsole({ described: { stt: [], tts: [], llm: [], telephony: [] }, db });
  assert.equal(diag.overview.activeTenants, 2);
});

test('Phase 21: test credit grant polish stays idempotent and customer-safe', () => {
  const db = baseDb();
  const grant = plans.grantTestCredits(db, 't_a', 2500, 'sa_1', 'phase21:test', 'qa sandbox', addLedgerEntry);
  assert.equal(grant.ok, true);
  assert.equal(grant.duplicate, false);
  assert.equal(db.wallets[0].balancePaise, 2500);
  assert.equal(db.ledger[0].type, 'test_credit');
  const again = plans.grantTestCredits(db, 't_a', 2500, 'sa_1', 'phase21:test', 'qa sandbox', addLedgerEntry);
  assert.equal(again.duplicate, true);
  assert.equal(db.wallets[0].balancePaise, 2500);
  const ent = plans.publicEntitlements(db, db.tenants[0]);
  assert.equal(ent.credits.balancePaise, 2500);
  assertNoProviderLeak(ent, 'entitlements');
});

test('Phase 22: north-star journey with mocked confirm:true dial (no live phone)', () => {
  const db = baseDb();
  phoneNumbers.seedPlatformInventory(db);

  const emp = employees.createEmployee(db, 't_a', {
    name: 'Ria',
    templateKey: 'receptionist',
    compose: false,
    agentId: 'ag_1',
  }, 'u_1');
  assert.equal(emp.ok, true);

  const instructions = employees.updateInstructions(db, 't_a', emp.employee.id, {
    brief: 'Reception for Acme',
    greeting: 'Namaste, Acme speaking.',
    instructions: 'Be warm. Capture name and reason.',
  });
  assert.equal(instructions.ok, true);

  const training = employees.createAndAttachKnowledge(db, 't_a', emp.employee.id, {
    title: 'Office hours',
    content: 'We are open 9 to 6 IST on weekdays.',
  }, 'u_1');
  assert.equal(training.ok, true);

  const outcomes = employees.setOutcomes(db, 't_a', emp.employee.id, [
    { key: 'qualified', label: 'Qualified', success: true },
    { key: 'callback', label: 'Callback', success: false },
  ]);
  assert.equal(outcomes.ok, true);

  const assigned = phoneNumbers.assignNumber(db, {
    numberId: phoneNumbers.PLATFORM_SEED_ID,
    tenantId: 't_a',
    employeeId: emp.employee.id,
  });
  assert.equal(assigned.ok, true);
  assert.equal(assigned.number.assignedEmployeeId, emp.employee.id);

  const lead = leads.createLead(db, 't_a', {
    name: 'Priya',
    phone: '9876543210',
    employeeId: emp.employee.id,
  }, 'u_1');
  assert.equal(lead.ok, true);
  assert.equal(lead.lead.employeeId, emp.employee.id);

  // Mocked dial path: CallJob with confirm:true semantics, no live telephony.
  const job = callJobs.createCallJob(db, 't_a', {
    toE164: lead.lead.phone,
    leadId: lead.lead.id,
    employeeId: emp.employee.id,
    agentId: emp.employee.agentId,
    phoneNumberId: emp.employee.phoneNumberId,
    source: 'instant',
    confirm: true,
  }, 'u_1');
  assert.equal(job.ok, true);
  assert.equal(job.job.status, 'queued');

  callJobs.updateCallJobStatus(db, 't_a', job.job.id, 'dialing');
  const completed = callJobs.updateCallJobStatus(db, 't_a', job.job.id, 'completed', {
    providerRunId: 'mock_run_phase22',
    resultCallId: 'call_phase22',
  });
  assert.equal(completed.ok, true);
  assert.equal(completed.job.providerRunId, 'mock_run_phase22');

  db.calls.push({
    id: 'call_phase22',
    tenantId: 't_a',
    agentId: emp.employee.agentId,
    employeeId: emp.employee.id,
    leadId: lead.lead.id,
    direction: 'outbound',
    fromE164: assigned.number.e164 || '+918000000001',
    toE164: lead.lead.phone,
    status: 'completed',
    startedAt: '2026-09-17T10:00:00.000Z',
    endedAt: '2026-09-17T10:01:30.000Z',
    durationSec: 90,
    outcome: 'qualified',
    providerRunId: 'mock_run_phase22',
    createdAt: '2026-09-17T10:00:00.000Z',
    updatedAt: '2026-09-17T10:01:30.000Z',
  });
  leads.updateLead(db, 't_a', lead.lead.id, {
    status: 'qualified',
    outcomeKey: 'qualified',
    lastCallId: 'call_phase22',
    lastCallJobId: job.job.id,
  });

  const listedJobs = callJobs.listCallJobs(db, 't_a', { employeeId: emp.employee.id });
  assert.ok(listedJobs.length >= 1);
  assertNoProviderLeak(listedJobs, 'call job list');

  const pubJob = callJobs.publicCallJob(completed.job);
  assert.equal(pubJob.resultCallId, 'call_phase22');
  assert.equal('providerRunId' in pubJob, false);
  assertNoProviderLeak(pubJob, 'public call job');

  const pubLead = leads.publicLead(lead.lead);
  assert.equal('providerRunId' in pubLead, false);
  assertNoProviderLeak(pubLead, 'public lead');

  const pubCall = calls.publicCall(db.calls[0], new Map([['ag_1', db.agents[0]]]), { detail: true });
  assert.equal('providerRunId' in pubCall, false);
  assertNoProviderLeak(pubCall, 'public call');

  const empTl = timeline.buildEmployeeTimeline(db, 't_a', emp.employee.id, { limit: 50 });
  assert.equal(empTl.ok, true);
  assert.equal(empTl.timeline.empty, false);
  assertNoProviderLeak(empTl.timeline, 'employee timeline');

  const emptyPerf = analytics.buildDashboard(baseDb(), 't_a');
  assert.equal(emptyPerf.calls.totals.calls, 0);
  assert.equal(emptyPerf.calls.totals.conversionRatePct, null);
  assert.equal(emptyPerf.leads.totals.leads, 0);
  assertNoProviderLeak(emptyPerf, 'honest empty performance');

  const livePerf = analytics.buildDashboard(db, 't_a');
  assert.ok(livePerf.calls.totals.calls >= 1);
  assertNoProviderLeak(livePerf, 'performance with real calls');

  const cross = phoneNumbers.assignNumber(db, {
    numberId: phoneNumbers.PLATFORM_SEED_ID,
    tenantId: 't_b',
    employeeId: emp.employee.id,
  });
  assert.equal(cross.ok, false);
});

test('Phase 22 A-gate: anon health sanitized; providers/diagnostics Super Admin only; no providerRunId in customer JSON', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'astra-p21-'));
  const dbFile = path.join(tmpDir, 'db.json');
  process.env.RAPIDX_DB_FILE = dbFile;
  process.env.DEEPGRAM_API_KEY = 'phase22-deepgram-secret-key';
  process.env.RUMIK_API_KEY = 'phase22-rumik-secret-key';
  process.env.GIT_SHA = 'phase22sha01';

  for (const key of Object.keys(require.cache)) {
    if (key.includes('/dashboard/lib/')) delete require.cache[key];
  }
  const coreMod = require('../lib/core');
  const orgMod = require('../lib/org');
  const providersMod = require('../lib/providers');

  const tenantId = coreMod.genId('t_');
  const ownerId = coreMod.genId('u_');
  const adminId = coreMod.genId('u_');
  const superId = coreMod.genId('u_');
  const now = new Date().toISOString();
  await coreMod.mutate((d) => {
    d.tenants.push({
      id: tenantId, name: 'Gate Co', slug: 'gate-co', createdAt: now,
      branding: { color: '#6B21A8' }, providers: {}, plan: 'starter', status: 'active', privacyMode: 'standard',
    });
    d.users.push(
      { id: ownerId, tenantId, email: 'owner@gate.local', name: 'Owner', passHash: coreMod.hashPassword('password-ownerxx'), role: 'owner', status: 'active', createdAt: now },
      { id: adminId, tenantId, email: 'admin@gate.local', name: 'Admin', passHash: coreMod.hashPassword('password-adminxx'), role: 'admin', status: 'active', createdAt: now },
      { id: superId, tenantId, email: 'super@gate.local', name: 'Super', passHash: coreMod.hashPassword('password-superxxx'), role: 'super_admin', status: 'active', createdAt: now },
    );
  });
  const cookieOwner = 'rxv_sess=' + await coreMod.createSession(ownerId, tenantId);
  const cookieAdmin = 'rxv_sess=' + await coreMod.createSession(adminId, tenantId);
  const cookieSuper = 'rxv_sess=' + await coreMod.createSession(superId, tenantId);

  async function handle(req, res) {
    const route = (req.url || '').split('?')[0];
    if (req.method === 'GET' && route === '/api/health') {
      const ctx = await coreMod.getSession(req);
      if (!ctx || ctx.user.role !== 'super_admin') {
        return coreMod.sendJson(res, 200, orgMod.publicHealthPayload({
          uptime: 3,
          version: '1.0.0',
          gitSha: process.env.GIT_SHA,
          deployedAt: null,
        }));
      }
      const payload = orgMod.detailedHealthPayload(providersMod.describeProviders());
      payload.gitSha = process.env.GIT_SHA;
      payload.version = '1.0.0';
      return coreMod.sendJson(res, 200, payload);
    }
    if (req.method === 'GET' && route === '/api/admin/providers') {
      return coreMod.requireRole(req, res, 'super_admin', (rq, rs) => {
        coreMod.sendJson(rs, 200, { providers: orgMod.providerHealthSummary(providersMod.describeProviders()) });
      });
    }
    if (req.method === 'GET' && route === '/api/admin/diagnostics') {
      return coreMod.requireRole(req, res, 'super_admin', (rq, rs) => {
        const payload = orgMod.buildDiagnosticsConsole({
          described: providersMod.describeProviders(),
          db: coreMod.db(),
          deploy: { gitSha: process.env.GIT_SHA },
          version: '1.0.0',
          uptimeSec: 3,
        });
        coreMod.sendJson(rs, 200, { diagnostics: payload });
      });
    }
    if (req.method === 'GET' && route === '/api/leads') {
      return coreMod.requireAuth(req, res, (rq, rs, ctx) => {
        const rows = (coreMod.db().leads || [])
          .filter((l) => l.tenantId === ctx.tenant.id)
          .map((l) => leads.publicLead(l));
        coreMod.sendJson(rs, 200, { leads: rows });
      });
    }
    coreMod.sendJson(res, 404, { error: 'missing' });
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => coreMod.sendJson(res, 500, { error: e.message }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  t.after(() => {
    server.close();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
    delete process.env.RAPIDX_DB_FILE;
    delete process.env.DEEPGRAM_API_KEY;
    delete process.env.RUMIK_API_KEY;
    delete process.env.GIT_SHA;
  });

  function request(method, routePath, cookie) {
    return new Promise((resolve, reject) => {
      http.request({
        hostname: '127.0.0.1',
        port,
        path: routePath,
        method,
        headers: cookie ? { Cookie: cookie } : {},
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null, text });
        });
      }).on('error', reject).end();
    });
  }

  const anonHealth = await request('GET', '/api/health');
  assert.equal(anonHealth.status, 200);
  assert.equal(anonHealth.body.ok, true);
  assert.equal(anonHealth.body.providers, undefined);
  assert.equal(PROVIDER_BRAND_RE.test(anonHealth.text), false);

  const ownerHealth = await request('GET', '/api/health', cookieOwner);
  assert.equal(ownerHealth.body.providers, undefined);
  assert.equal(PROVIDER_BRAND_RE.test(JSON.stringify(ownerHealth.body)), false);

  const superHealth = await request('GET', '/api/health', cookieSuper);
  assert.equal(superHealth.status, 200);
  assert.ok(superHealth.body.providers);

  const adminProviders = await request('GET', '/api/admin/providers', cookieAdmin);
  assert.equal(adminProviders.status, 403);
  const ownerProviders = await request('GET', '/api/admin/providers', cookieOwner);
  assert.equal(ownerProviders.status, 403);
  const superProviders = await request('GET', '/api/admin/providers', cookieSuper);
  assert.equal(superProviders.status, 200);
  assert.equal(JSON.stringify(superProviders.body).includes('phase22-deepgram-secret-key'), false);

  const adminDiag = await request('GET', '/api/admin/diagnostics', cookieAdmin);
  assert.equal(adminDiag.status, 403);
  const superDiag = await request('GET', '/api/admin/diagnostics', cookieSuper);
  assert.equal(superDiag.status, 200);
  assert.equal(superDiag.body.diagnostics.customerVisible, false);
  assert.equal(JSON.stringify(superDiag.body).includes('phase22-rumik-secret-key'), false);

  await coreMod.mutate((d) => {
    d.leads = d.leads || [];
    d.leads.push({
      id: 'lead_gate',
      tenantId,
      name: 'Gate Lead',
      phone: '+919811122233',
      status: 'new',
      providerRunId: 'should-not-leak',
      dograhWorkflowId: 99,
      createdAt: now,
      updatedAt: now,
    });
  });
  const leadList = await request('GET', '/api/leads', cookieOwner);
  assert.equal(leadList.status, 200);
  assert.equal(leadList.body.leads.length, 1);
  assert.equal('providerRunId' in leadList.body.leads[0], false);
  assert.equal(JSON.stringify(leadList.body).includes('providerRunId'), false);
  assert.equal(JSON.stringify(leadList.body).includes('dograh'), false);
});
