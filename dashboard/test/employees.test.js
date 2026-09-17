'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const employees = require('../lib/employees');
const { seedPresets } = require('../lib/agent-types');

function emptyDb() {
  return {
    schemaVersion: 9,
    tenants: [{ id: 't_a', name: 'A' }, { id: 't_b', name: 'B' }],
    users: [],
    agents: [],
    workflows: [],
    calls: [],
    leads: [],
    phoneNumbers: [],
    knowledgeEntries: [],
    presets: [],
    providerResources: [],
    employees: [],
  };
}

test('job templates cover receptionist through custom', () => {
  const keys = employees.listJobTemplates().map((t) => t.key);
  for (const k of [
    'receptionist', 'instant_lead_caller', 'lead_qualification', 'outbound_sales',
    'support', 'appointment', 'payment_reminder', 'survey', 'custom',
  ]) {
    assert.ok(keys.includes(k), 'missing template ' + k);
  }
  const blob = JSON.stringify(employees.listJobTemplates());
  assert.equal(blob.toLowerCase().includes('dograh'), false);
  assert.equal(blob.toLowerCase().includes('vobiz'), false);
  assert.equal(blob.toLowerCase().includes('deepgram'), false);
  assert.equal(blob.toLowerCase().includes('groq'), false);
  assert.equal(blob.toLowerCase().includes('rumik'), false);
});

test('createEmployee composes agent + workflow relationships, not a blob copy', () => {
  const db = emptyDb();
  seedPresets(db);
  const created = employees.createEmployee(db, 't_a', {
    templateKey: 'receptionist',
    name: 'Front Desk Maya',
    description: 'Greet callers and take messages for AstraNova.',
  }, 'u1');
  assert.equal(created.ok, true);
  assert.equal(created.composed, true);
  assert.equal(created.employee.status, 'READY');
  assert.ok(created.employee.agentId);
  assert.ok(created.employee.workflowId);
  assert.equal(db.agents.length, 1);
  assert.equal(db.workflows.length, 1);
  assert.equal(db.agents[0].id, created.employee.agentId);
  assert.equal(db.workflows[0].id, created.employee.workflowId);
  assert.equal(db.workflows[0].agentId, created.employee.agentId);
  assert.equal(db.employees.length, 1);

  const pub = employees.publicEmployee(created.employee, db);
  assert.equal(pub.name, 'Front Desk Maya');
  assert.equal(pub.role, 'Receptionist');
  assert.equal(pub.channel, 'inbound');
  assert.equal(pub.callsToday, 0);
  assert.equal(pub.leads, 0);
  assert.equal(pub.qualified, 0);
  assert.equal(pub.lastActiveAt, null);
  assert.equal(JSON.stringify(pub).toLowerCase().includes('dograh'), false);
  assert.equal(JSON.stringify(pub).toLowerCase().includes('rumik'), false);
});

test('metrics stay honest: zeros when empty, real counts when present', () => {
  const db = emptyDb();
  seedPresets(db);
  const created = employees.createEmployee(db, 't_a', {
    templateKey: 'instant_lead_caller',
    name: 'Lead Bot',
  }, 'u1');
  const emp = created.employee;
  const today = new Date().toISOString().slice(0, 10);

  db.calls.push({
    id: 'call_1', tenantId: 't_a', agentId: emp.agentId, employeeId: emp.id,
    startedAt: today + 'T10:00:00.000Z', outcome: 'qualified', extractedData: { qualified: true },
  });
  db.calls.push({
    id: 'call_old', tenantId: 't_a', agentId: emp.agentId,
    startedAt: '2020-01-01T10:00:00.000Z', outcome: 'no_answer', extractedData: {},
  });
  db.calls.push({
    id: 'call_other', tenantId: 't_b', agentId: emp.agentId,
    startedAt: today + 'T11:00:00.000Z', outcome: 'qualified', extractedData: { qualified: true },
  });
  db.leads.push({
    id: 'lead_1', tenantId: 't_a', agentId: emp.agentId, employeeId: emp.id,
    updatedAt: today + 'T12:00:00.000Z',
  });

  const metrics = employees.computeMetrics(db, emp);
  assert.equal(metrics.callsToday, 1);
  assert.equal(metrics.leads, 1);
  assert.equal(metrics.qualified, 1);
  assert.equal(metrics.lastActiveAt, today + 'T12:00:00.000Z');
});

test('tenant isolation and lifecycle transitions', () => {
  const db = emptyDb();
  seedPresets(db);
  const a = employees.createEmployee(db, 't_a', { templateKey: 'support', name: 'Support A' }, 'u1');
  const b = employees.createEmployee(db, 't_b', { templateKey: 'support', name: 'Support B' }, 'u2');
  assert.equal(employees.listEmployees(db, 't_a').length, 1);
  assert.equal(employees.listEmployees(db, 't_b').length, 1);
  assert.equal(employees.findEmployee(db, 't_a', b.employee.id), null);

  const cross = employees.updateEmployee(db, 't_a', b.employee.id, { name: 'Hijack' });
  assert.equal(cross.ok, false);
  assert.equal(cross.status, 404);

  const live = employees.setEmployeeStatus(db, 't_a', a.employee.id, 'LIVE');
  assert.equal(live.ok, true);
  assert.equal(live.employee.status, 'LIVE');

  const pause = employees.pauseEmployee(db, 't_a', a.employee.id);
  assert.equal(pause.ok, true);
  assert.equal(pause.employee.status, 'PAUSED');

  const resume = employees.resumeEmployee(db, 't_a', a.employee.id);
  assert.equal(resume.ok, true);
  assert.equal(resume.employee.status, 'LIVE');

  const archived = employees.setEmployeeStatus(db, 't_a', a.employee.id, 'ARCHIVED');
  assert.equal(archived.ok, true);

  const badLive = employees.setEmployeeStatus(db, 't_a', a.employee.id, 'LIVE');
  assert.equal(badLive.ok, false);
  assert.equal(badLive.code, 'bad_transition');
});

test('filters: channel and status', () => {
  const db = emptyDb();
  seedPresets(db);
  employees.createEmployee(db, 't_a', { templateKey: 'receptionist', name: 'In' }, 'u1');
  employees.createEmployee(db, 't_a', { templateKey: 'instant_lead_caller', name: 'IL' }, 'u1');
  const draft = employees.createEmployee(db, 't_a', {
    templateKey: 'custom', name: 'Drafty', compose: false,
  }, 'u1');
  assert.equal(draft.employee.status, 'DRAFT');

  assert.equal(employees.listEmployees(db, 't_a', { filter: 'inbound' }).length, 1);
  assert.equal(employees.listEmployees(db, 't_a', { filter: 'instant_lead' }).length, 1);
  assert.equal(employees.listEmployees(db, 't_a', { filter: 'draft' }).length, 1);
  assert.equal(employees.listEmployees(db, 't_a', { filter: 'ready' }).length, 2);
});

test('HTTP employee APIs enforce tenant isolation and hide provider terms', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'astra-emp-http-'));
  const dbFile = path.join(tmpDir, 'db.json');
  process.env.RAPIDX_DB_FILE = dbFile;

  for (const key of Object.keys(require.cache)) {
    if (key.includes(`${path.sep}dashboard${path.sep}`)) delete require.cache[key];
  }

  const core = require('../lib/core');
  core.loadEnv();
  fs.writeFileSync(dbFile, JSON.stringify({
    schemaVersion: 9,
    tenants: [], users: [], agents: [], usage: [], sessions: [],
    wallets: [], ledger: [], paymentIntents: [], supportTickets: [],
    supportMessages: [], auditEvents: [], presets: [], byonConnections: [],
    hvacJobs: [], hvacSettings: [], paymentEvents: [], demoLinks: [],
    callbackJobs: [], phoneNumbers: [], providerResources: [], calls: [],
    knowledgeEntries: [], integrationWebhooks: [], campaigns: [], campaignLeads: [],
    workflows: [], leads: [], callJobs: [], employees: [],
  }, null, 2));

  const emp = require('../lib/employees');
  const { seedPresets: seed } = require('../lib/agent-types');
  const workflows = require('../lib/workflows');

  const tenantA = core.genId('t_');
  const tenantB = core.genId('t_');
  const userA = core.genId('u_');
  const userB = core.genId('u_');
  const now = new Date().toISOString();

  await core.mutate((d) => {
    seed(d);
    d.tenants.push(
      { id: tenantA, name: 'A', slug: 'a', createdAt: now, plan: 'starter', status: 'active' },
      { id: tenantB, name: 'B', slug: 'b', createdAt: now, plan: 'starter', status: 'active' },
    );
    d.users.push(
      {
        id: userA, tenantId: tenantA, email: 'a@astra.local', name: 'A',
        passHash: core.hashPassword('employee-test-password'), role: 'owner', status: 'active', createdAt: now,
      },
      {
        id: userB, tenantId: tenantB, email: 'b@astra.local', name: 'B',
        passHash: core.hashPassword('employee-test-password'), role: 'owner', status: 'active', createdAt: now,
      },
    );
    emp.createEmployee(d, tenantA, { templateKey: 'appointment', name: 'Booker A' }, userA);
    emp.createEmployee(d, tenantB, { templateKey: 'survey', name: 'Survey B' }, userB);
  });

  const tokenA = await core.createSession(userA, tenantA);
  const tokenB = await core.createSession(userB, tenantB);
  const cookieA = 'rxv_sess=' + tokenA;
  const cookieB = 'rxv_sess=' + tokenB;

  async function handle(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1');
    const route = url.pathname;

    if (route === '/api/employees/templates' && req.method === 'GET') {
      return core.requireAuth(req, res, () => {
        core.sendJson(res, 200, { templates: emp.listJobTemplates() });
      });
    }
    if (route === '/api/employees' && req.method === 'GET') {
      return core.requireAuth(req, res, (rq, rs, ctx) => {
        const filter = url.searchParams.get('filter') || 'all';
        core.sendJson(rs, 200, {
          employees: emp.listEmployees(core.db(), ctx.tenant.id, { filter }),
        });
      });
    }
    if (route === '/api/employees' && req.method === 'POST') {
      const body = await core.readBody(req);
      return core.requireAuth(req, res, async (rq, rs, ctx) => {
        let result;
        await core.mutate((d) => {
          result = emp.createEmployee(d, ctx.tenant.id, body, ctx.user.id);
        });
        if (!result.ok) return core.sendJson(rs, result.status, { error: result.error, code: result.code });
        core.sendJson(rs, 201, {
          employee: emp.publicEmployee(result.employee, core.db()),
          composed: !!result.composed,
        });
      }, body);
    }
    const one = route.match(/^\/api\/employees\/([^/]+)$/);
    if (one && req.method === 'GET') {
      const id = decodeURIComponent(one[1]);
      return core.requireAuth(req, res, (rq, rs, ctx) => {
        const row = emp.findEmployee(core.db(), ctx.tenant.id, id);
        if (!row) return core.sendJson(rs, 404, { error: 'employee not found', code: 'not_found' });
        const workflow = row.workflowId
          ? workflows.findWorkflow(core.db(), ctx.tenant.id, row.workflowId)
          : null;
        core.sendJson(rs, 200, {
          employee: emp.publicEmployee(row, core.db()),
          workflow: workflow ? workflows.publicWorkflow(workflow, { includeProvider: false }) : null,
        });
      });
    }
    const status = route.match(/^\/api\/employees\/([^/]+)\/status$/);
    if (status && req.method === 'POST') {
      const id = decodeURIComponent(status[1]);
      const body = await core.readBody(req);
      return core.requireAuth(req, res, async (rq, rs, ctx) => {
        let result;
        await core.mutate((d) => {
          result = emp.setEmployeeStatus(d, ctx.tenant.id, id, body.status);
        });
        if (!result.ok) return core.sendJson(rs, result.status, { error: result.error, code: result.code });
        core.sendJson(rs, 200, { employee: emp.publicEmployee(result.employee, core.db()) });
      }, body);
    }
    const pause = route.match(/^\/api\/employees\/([^/]+)\/pause$/);
    if (pause && req.method === 'POST') {
      const id = decodeURIComponent(pause[1]);
      return core.requireAuth(req, res, async (rq, rs, ctx) => {
        let result;
        await core.mutate((d) => { result = emp.pauseEmployee(d, ctx.tenant.id, id); });
        if (!result.ok) return core.sendJson(rs, result.status, { error: result.error, code: result.code });
        core.sendJson(rs, 200, { employee: emp.publicEmployee(result.employee, core.db()) });
      });
    }
    core.sendJson(res, 404, { error: 'not found' });
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      core.sendJson(res, 500, { error: String(e.message || e) });
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  function req(method, urlPath, cookie, body) {
    return new Promise((resolve, reject) => {
      const data = body != null ? JSON.stringify(body) : null;
      const r = http.request({
        hostname: '127.0.0.1',
        port,
        path: urlPath,
        method,
        headers: {
          Cookie: cookie,
          ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
        },
      }, (res) => {
        let raw = '';
        res.on('data', (c) => { raw += c; });
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(raw); } catch (_) { json = raw; }
          resolve({ status: res.statusCode, body: json });
        });
      });
      r.on('error', reject);
      if (data) r.write(data);
      r.end();
    });
  }

  const listA = await req('GET', '/api/employees', cookieA);
  assert.equal(listA.status, 200);
  assert.equal(listA.body.employees.length, 1);
  assert.equal(listA.body.employees[0].name, 'Booker A');
  assert.equal(JSON.stringify(listA.body).toLowerCase().includes('dograh'), false);

  const crossGet = await req('GET', '/api/employees/' + encodeURIComponent(listA.body.employees[0].id), cookieB);
  assert.equal(crossGet.status, 404);

  const created = await req('POST', '/api/employees', cookieA, {
    templateKey: 'lead_qualification',
    name: 'Qualifier',
    description: 'Qualify inbound interest and book a demo.',
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.employee.status, 'READY');
  assert.ok(created.body.employee.agentId);
  assert.ok(created.body.employee.workflowId);
  assert.equal(created.body.composed, true);

  const detail = await req('GET', '/api/employees/' + encodeURIComponent(created.body.employee.id), cookieA);
  assert.equal(detail.status, 200);
  assert.ok(detail.body.workflow);
  assert.equal(detail.body.workflow.providerWorkflowId, undefined);
  assert.equal(JSON.stringify(detail.body).toLowerCase().includes('dograh'), false);

  const templates = await req('GET', '/api/employees/templates', cookieA);
  assert.equal(templates.status, 200);
  assert.ok(templates.body.templates.length >= 9);

  const goLive = await req('POST', '/api/employees/' + encodeURIComponent(created.body.employee.id) + '/status', cookieA, {
    status: 'LIVE',
  });
  assert.equal(goLive.status, 200);
  assert.equal(goLive.body.employee.status, 'LIVE');

  const paused = await req('POST', '/api/employees/' + encodeURIComponent(created.body.employee.id) + '/pause', cookieA, {});
  assert.equal(paused.status, 200);
  assert.equal(paused.body.employee.status, 'PAUSED');

  await new Promise((resolve) => server.close(resolve));
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  delete process.env.RAPIDX_DB_FILE;
});
