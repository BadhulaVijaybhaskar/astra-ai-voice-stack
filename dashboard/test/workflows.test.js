'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const workflows = require('../lib/workflows');
const { DograhWorkflowProvider } = require('../lib/workflow-provider');
const phoneNumbers = require('../lib/phone-numbers');

test('templates include receptionist through blank', () => {
  const keys = workflows.listTemplates().map((t) => t.key);
  for (const k of ['receptionist', 'outbound_sales', 'support', 'appointment', 'lead_qual', 'payment_reminder', 'survey', 'blank']) {
    assert.ok(keys.includes(k), 'missing template ' + k);
  }
  const g = workflows.getTemplate('outbound_sales').graph();
  assert.ok(Array.isArray(g.nodes));
  assert.ok(g.nodes.some((n) => /permission/i.test(n.name)));
  assert.ok(g.nodes.some((n) => /discovery/i.test(n.name)));
  assert.ok(g.nodes.some((n) => /reschedule|book/i.test(n.name)));
});

test('seedTenantReceptionist imports Dograh id 8 as AstraNova Receptionist', () => {
  const db = { tenants: [{ id: 't1' }], workflows: [], providerResources: [], agents: [] };
  const a = workflows.seedTenantReceptionist(db, 't1', 'u1');
  const b = workflows.seedTenantReceptionist(db, 't1', 'u1');
  assert.equal(a.id, b.id);
  assert.equal(a.name, 'AstraNova Receptionist');
  assert.equal(a.direction, 'inbound');
  assert.equal(a.status, 'published');
  assert.equal(String(a.providerWorkflowId), '8');
  assert.equal(db.workflows.length, 1);
  assert.equal(db.providerResources.length, 1);
  assert.equal(db.providerResources[0].resourceType, 'workflow');
});

test('publicWorkflow hides providerWorkflowId for normal users', () => {
  const row = {
    id: 'wf_1', tenantId: 't1', name: 'AstraNova Receptionist', description: 'x',
    type: 'receptionist', templateKey: 'receptionist', direction: 'inbound',
    status: 'published', version: 1, graphJson: { version: 1, nodes: [] },
    agentId: null, provider: 'dograh', providerWorkflowId: '8',
    syncStatus: 'imported', syncError: null,
    createdAt: 't', updatedAt: 't', publishedAt: 't',
  };
  const pub = workflows.publicWorkflow(row, { includeProvider: false });
  assert.equal(pub.name, 'AstraNova Receptionist');
  assert.equal(pub.providerWorkflowId, undefined);
  assert.equal(pub.provider, undefined);
  assert.equal(JSON.stringify(pub).includes('dograh'), false);
  assert.equal(JSON.stringify(pub).includes('"8"'), false);

  const admin = workflows.publicWorkflow(row, { includeProvider: true });
  assert.equal(admin.providerWorkflowId, '8');
  assert.equal(admin.provider, 'dograh');
});

test('tenant isolation: findWorkflow and listWorkflows never cross tenants', () => {
  const db = { workflows: [], providerResources: [], agents: [], tenants: [] };
  const a = workflows.createWorkflow(db, 't_a', { templateKey: 'blank', name: 'A flow' }, 'u_a');
  const b = workflows.createWorkflow(db, 't_b', { templateKey: 'blank', name: 'B flow' }, 'u_b');
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal(workflows.listWorkflows(db, 't_a').length, 1);
  assert.equal(workflows.listWorkflows(db, 't_b').length, 1);
  assert.equal(workflows.findWorkflow(db, 't_a', b.workflow.id), null);
  assert.equal(workflows.findWorkflow(db, 't_b', a.workflow.id), null);
  const cross = workflows.updateWorkflow(db, 't_a', b.workflow.id, { name: 'Hijack' });
  assert.equal(cross.ok, false);
  assert.equal(cross.status, 404);
});

test('publish soft-fails when Dograh is offline but keeps mapping', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'astra-wf-pub-'));
  const dbFile = path.join(tmpDir, 'db.json');
  process.env.RAPIDX_DB_FILE = dbFile;
  for (const key of Object.keys(require.cache)) {
    if (key.includes(`${path.sep}dashboard${path.sep}`)) delete require.cache[key];
  }
  const core = require('../lib/core');
  core.loadEnv();
  fs.writeFileSync(dbFile, JSON.stringify({
    schemaVersion: 7,
    tenants: [], users: [], agents: [], usage: [], sessions: [],
    wallets: [], ledger: [], paymentIntents: [], supportTickets: [],
    supportMessages: [], auditEvents: [], presets: [], byonConnections: [],
    hvacJobs: [], hvacSettings: [], paymentEvents: [], demoLinks: [],
    callbackJobs: [], phoneNumbers: [], providerResources: [], calls: [],
    knowledgeEntries: [], integrationWebhooks: [], campaigns: [], campaignLeads: [],
    workflows: [],
  }, null, 2));

  // Rebuild after cache clear.
  const wf = require('../lib/workflows');
  const { DograhWorkflowProvider: Provider } = require('../lib/workflow-provider');

  await core.mutate((d) => {
    d.tenants.push({ id: 't1', name: 'T', slug: 't', createdAt: new Date().toISOString() });
    const created = wf.createWorkflow(d, 't1', { templateKey: 'receptionist', name: 'Live map' }, 'u1');
    created.workflow.providerWorkflowId = '8';
  });
  const id = core.db().workflows[0].id;
  const provider = new Provider({
    core,
    telephony: { live: false, request: async () => { throw new Error('nope'); } },
  });
  const result = await provider.publishWorkflow('t1', id, { providerWorkflowId: '8' });
  assert.equal(result.workflow.status, 'published');
  assert.equal(String(result.providerWorkflowId), '8');
  assert.ok(['mapped_offline', 'sync_failed', 'synced'].includes(result.syncStatus));

  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  delete process.env.RAPIDX_DB_FILE;
});

test('assign number accepts Astra inboundWorkflowId and resolves Dograh id', () => {
  const db = {
    phoneNumbers: [], providerResources: [], agents: [], workflows: [], tenants: [{ id: 't1' }],
  };
  phoneNumbers.seedPlatformInventory(db);
  const seeded = workflows.seedTenantReceptionist(db, 't1', 'u1');
  db.agents.push({
    id: 'ag_1', tenantId: 't1', name: 'Ria', telephony: {},
  });
  const assigned = phoneNumbers.assignNumber(db, {
    numberId: phoneNumbers.PLATFORM_SEED_ID,
    tenantId: 't1',
    agentId: 'ag_1',
    inboundEnabled: true,
    outboundEnabled: true,
    inboundWorkflowId: seeded.id,
    resolveProviderWorkflowId: workflows.resolveProviderWorkflowId,
  });
  assert.equal(assigned.ok, true);
  assert.equal(assigned.number.inboundWorkflowId, seeded.id);
  assert.equal(assigned.number.providerMetadata.inboundWorkflowId, 8);
  const pub = phoneNumbers.publicPhoneNumber(assigned.number, new Map([['ag_1', db.agents[0]]]), new Map([[seeded.id, seeded]]));
  assert.equal(pub.inboundWorkflowId, seeded.id);
  assert.equal(pub.inboundWorkflowName, 'AstraNova Receptionist');
  assert.equal(JSON.stringify(pub).includes('dograh'), false);

  const dial = phoneNumbers.outboundDialContext(db, 't1');
  assert.equal(dial.workflowId, 8);
});

test('HTTP workflow APIs enforce tenant isolation and hide provider id', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'astra-wf-http-'));
  const dbFile = path.join(tmpDir, 'db.json');
  process.env.RAPIDX_DB_FILE = dbFile;

  for (const key of Object.keys(require.cache)) {
    if (key.includes(`${path.sep}dashboard${path.sep}`)) delete require.cache[key];
  }

  const core = require('../lib/core');
  core.loadEnv();
  fs.writeFileSync(dbFile, JSON.stringify({
    schemaVersion: 7,
    tenants: [], users: [], agents: [], usage: [], sessions: [],
    wallets: [], ledger: [], paymentIntents: [], supportTickets: [],
    supportMessages: [], auditEvents: [], presets: [], byonConnections: [],
    hvacJobs: [], hvacSettings: [], paymentEvents: [], demoLinks: [],
    callbackJobs: [], phoneNumbers: [], providerResources: [], calls: [],
    knowledgeEntries: [], integrationWebhooks: [], campaigns: [], campaignLeads: [],
    workflows: [],
  }, null, 2));

  const wf = require('../lib/workflows');
  const { createDefaultWorkflowProvider } = require('../lib/workflow-provider');
  const workflowProvider = createDefaultWorkflowProvider({
    core,
    telephony: { live: false },
  });

  const tenantA = core.genId('t_');
  const tenantB = core.genId('t_');
  const userA = core.genId('u_');
  const userB = core.genId('u_');
  const now = new Date().toISOString();

  await core.mutate((d) => {
    d.tenants.push(
      { id: tenantA, name: 'A', slug: 'a', createdAt: now, plan: 'starter', status: 'active' },
      { id: tenantB, name: 'B', slug: 'b', createdAt: now, plan: 'starter', status: 'active' },
    );
    d.users.push(
      {
        id: userA, tenantId: tenantA, email: 'a@astra.local', name: 'A',
        passHash: core.hashPassword('workflow-test-password'), role: 'owner', status: 'active', createdAt: now,
      },
      {
        id: userB, tenantId: tenantB, email: 'b@astra.local', name: 'B',
        passHash: core.hashPassword('workflow-test-password'), role: 'owner', status: 'active', createdAt: now,
      },
    );
    wf.seedTenantReceptionist(d, tenantA, userA);
    wf.seedTenantReceptionist(d, tenantB, userB);
  });

  const tokenA = await core.createSession(userA, tenantA);
  const tokenB = await core.createSession(userB, tenantB);
  const cookieA = 'rxv_sess=' + tokenA;
  const cookieB = 'rxv_sess=' + tokenB;

  function includeProvider(ctx) {
    return ctx.user.role === 'super_admin';
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1');
    const route = url.pathname;

    if (route === '/api/workflow-templates' && req.method === 'GET') {
      return core.requireAuth(req, res, () => {
        core.sendJson(res, 200, { templates: wf.listTemplates() });
      });
    }
    if (route === '/api/workflows' && req.method === 'GET') {
      return core.requireAuth(req, res, async (rq, rs, ctx) => {
        await core.mutate((d) => { wf.seedTenantReceptionist(d, ctx.tenant.id, ctx.user.id); });
        core.sendJson(rs, 200, {
          workflows: wf.listWorkflows(core.db(), ctx.tenant.id).map((row) => wf.publicWorkflow(row, {
            includeProvider: includeProvider(ctx),
          })),
        });
      });
    }
    if (route === '/api/workflows' && req.method === 'POST') {
      const body = await core.readBody(req);
      return core.requireAuth(req, res, async (rq, rs, ctx) => {
        let result;
        await core.mutate((d) => {
          result = wf.createWorkflow(d, ctx.tenant.id, body, ctx.user.id);
        });
        if (!result.ok) return core.sendJson(rs, result.status, { error: result.error, code: result.code });
        core.sendJson(rs, 201, {
          workflow: wf.publicWorkflow(result.workflow, { includeProvider: includeProvider(ctx) }),
        });
      }, body);
    }
    const one = route.match(/^\/api\/workflows\/([^/]+)$/);
    if (one && req.method === 'GET') {
      const id = decodeURIComponent(one[1]);
      return core.requireAuth(req, res, (rq, rs, ctx) => {
        const row = wf.findWorkflow(core.db(), ctx.tenant.id, id);
        if (!row) return core.sendJson(rs, 404, { error: 'workflow not found', code: 'not_found' });
        core.sendJson(rs, 200, {
          workflow: wf.publicWorkflow(row, { includeProvider: includeProvider(ctx) }),
        });
      });
    }
    if (one && req.method === 'PATCH') {
      const id = decodeURIComponent(one[1]);
      const body = await core.readBody(req, 256 * 1024);
      return core.requireAuth(req, res, async (rq, rs, ctx) => {
        let result;
        await core.mutate((d) => {
          result = wf.updateWorkflow(d, ctx.tenant.id, id, body);
        });
        if (!result.ok) return core.sendJson(rs, result.status, { error: result.error, code: result.code });
        core.sendJson(rs, 200, {
          workflow: wf.publicWorkflow(result.workflow, { includeProvider: includeProvider(ctx) }),
        });
      }, body);
    }
    const publish = route.match(/^\/api\/workflows\/([^/]+)\/publish$/);
    if (publish && req.method === 'POST') {
      const id = decodeURIComponent(publish[1]);
      const body = await core.readBody(req);
      return core.requireAuth(req, res, async (rq, rs, ctx) => {
        try {
          const result = await workflowProvider.publishWorkflow(ctx.tenant.id, id, {
            providerWorkflowId: body.providerWorkflowId,
          });
          const row = wf.findWorkflow(core.db(), ctx.tenant.id, id);
          core.sendJson(rs, 200, {
            workflow: wf.publicWorkflow(row, { includeProvider: includeProvider(ctx) }),
            syncStatus: result.syncStatus,
          });
        } catch (e) {
          core.sendJson(rs, e.status || 502, { error: e.message, code: e.code });
        }
      }, body);
    }
    if (route === '/api/workflows/import' && req.method === 'POST') {
      const body = await core.readBody(req);
      return core.requireRole(req, res, 'owner', async (rq, rs, ctx) => {
        let result;
        await core.mutate((d) => {
          result = wf.importFromProvider(d, ctx.tenant.id, body, ctx.user.id);
        });
        if (!result.ok) return core.sendJson(rs, result.status, { error: result.error, code: result.code });
        core.sendJson(rs, result.created ? 201 : 200, {
          workflow: wf.publicWorkflow(result.workflow, { includeProvider: includeProvider(ctx) }),
          created: result.created,
        });
      }, body);
    }
    core.sendJson(res, 404, { error: 'missing' });
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => core.sendJson(res, 500, { error: e.message }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  t.after(() => {
    server.close();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
    delete process.env.RAPIDX_DB_FILE;
  });

  function request(method, route, body, cookie) {
    return new Promise((resolve, reject) => {
      const payload = body ? JSON.stringify(body) : null;
      const req = http.request({
        hostname: '127.0.0.1', port, path: route, method,
        headers: {
          Cookie: cookie,
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null });
        });
      });
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  const templates = await request('GET', '/api/workflow-templates', null, cookieA);
  assert.equal(templates.status, 200);
  assert.ok(templates.body.templates.length >= 8);

  const listA = await request('GET', '/api/workflows', null, cookieA);
  assert.equal(listA.status, 200);
  assert.ok(listA.body.workflows.some((w) => w.name === 'AstraNova Receptionist'));
  assert.equal(JSON.stringify(listA.body).includes('providerWorkflowId'), false);
  assert.equal(JSON.stringify(listA.body).includes('"8"'), false);

  const created = await request('POST', '/api/workflows', {
    templateKey: 'outbound_sales', name: 'Sales flow A',
  }, cookieA);
  assert.equal(created.status, 201);
  assert.equal(created.body.workflow.status, 'draft');
  const wfId = created.body.workflow.id;

  const crossGet = await request('GET', '/api/workflows/' + wfId, null, cookieB);
  assert.equal(crossGet.status, 404);

  const patched = await request('PATCH', '/api/workflows/' + wfId, {
    name: 'Sales flow A v2',
    graphJson: created.body.workflow.graphJson,
  }, cookieA);
  assert.equal(patched.status, 200);
  assert.equal(patched.body.workflow.name, 'Sales flow A v2');

  const published = await request('POST', '/api/workflows/' + wfId + '/publish', {}, cookieA);
  assert.equal(published.status, 200);
  assert.equal(published.body.workflow.status, 'published');

  const listB = await request('GET', '/api/workflows', null, cookieB);
  assert.equal(listB.body.workflows.some((w) => w.id === wfId), false);
});
