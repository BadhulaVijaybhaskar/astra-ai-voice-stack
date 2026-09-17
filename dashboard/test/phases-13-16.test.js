'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const core = require('../lib/core');
const phoneNumbers = require('../lib/phone-numbers');
const campaigns = require('../lib/campaigns');
const analytics = require('../lib/analytics');
const callJobs = require('../lib/call-jobs');
const employees = require('../lib/employees');

function baseDb() {
  return {
    schemaVersion: 12,
    tenants: [{ id: 't_a', name: 'A', status: 'active' }],
    users: [],
    agents: [{ id: 'ag_1', tenantId: 't_a', name: 'Desk', telephony: { did: '' } }],
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
  };
}

test('schema v12 migrates assignedEmployeeId and campaign.employeeId', () => {
  const migrated = core.migrateDb({
    schemaVersion: 11,
    phoneNumbers: [{
      id: 'pn_1', tenantId: 't_a', status: 'assigned', assignedAgentId: 'ag_1', e164: '+918011111111',
    }],
    agents: [{ id: 'ag_1', tenantId: 't_a', name: 'Desk' }],
    employees: [{
      id: 'emp_1', tenantId: 't_a', name: 'Ria', agentId: 'ag_1', phoneNumberId: 'pn_1',
      outcomes: [], knowledgeIds: [], status: 'LIVE',
    }],
    campaigns: [{ id: 'cmp_1', tenantId: 't_a', name: 'March', agentId: 'ag_1' }],
    callJobs: [],
    leads: [],
  });
  assert.ok(migrated.schemaVersion >= 12);
  assert.equal(migrated.phoneNumbers[0].assignedEmployeeId, 'emp_1');
  assert.equal(migrated.campaigns[0].employeeId, null);
});

test('assign Phone Number to Employee syncs pn_ and clears on unassign', () => {
  const db = baseDb();
  phoneNumbers.seedPlatformInventory(db);
  const emp = employees.createEmployee(db, 't_a', {
    name: 'Ria',
    templateKey: 'receptionist',
    compose: false,
    agentId: 'ag_1',
  }, 'u_1');
  assert.equal(emp.ok, true);

  const assigned = phoneNumbers.assignNumber(db, {
    numberId: phoneNumbers.PLATFORM_SEED_ID,
    tenantId: 't_a',
    employeeId: emp.employee.id,
  });
  assert.equal(assigned.ok, true);
  assert.equal(assigned.number.assignedEmployeeId, emp.employee.id);
  assert.equal(assigned.number.assignedAgentId, 'ag_1');
  assert.equal(emp.employee.phoneNumberId, phoneNumbers.PLATFORM_SEED_ID);
  assert.equal(db.agents[0].telephony.phoneNumberId, phoneNumbers.PLATFORM_SEED_ID);

  const pub = phoneNumbers.publicPhoneNumber(
    assigned.number,
    new Map([['ag_1', db.agents[0]]]),
    new Map(),
    new Map([[emp.employee.id, emp.employee]]),
  );
  assert.equal(pub.assignedEmployeeId, emp.employee.id);
  assert.equal(pub.assignedEmployeeName, 'Ria');
  assert.equal(JSON.stringify(pub).includes('dograh'), false);
  assert.equal(JSON.stringify(pub).includes('providerMetadata'), false);

  const searched = phoneNumbers.listTenantNumbers(db, 't_a', { q: 'Ria' });
  assert.equal(searched.length, 1);
  assert.equal(phoneNumbers.listTenantNumbers(db, 't_a', { q: 'nope' }).length, 0);

  const un = phoneNumbers.unassignNumber(db, {
    numberId: phoneNumbers.PLATFORM_SEED_ID,
    tenantId: 't_a',
  });
  assert.equal(un.ok, true);
  assert.equal(un.number.assignedEmployeeId, null);
  assert.equal(emp.employee.phoneNumberId, null);
});

test('campaign attaches Employee and enqueue creates CallJob with employeeId', () => {
  const db = baseDb();
  const emp = employees.createEmployee(db, 't_a', {
    name: 'Caller',
    templateKey: 'instant_lead_caller',
    compose: false,
    agentId: 'ag_1',
  }, 'u_1');
  assert.equal(emp.ok, true);

  const created = campaigns.createCampaign(db, 't_a', {
    name: 'Batch A',
    employeeId: emp.employee.id,
    ratePerMinute: 2,
  }, 'u_1');
  assert.equal(created.ok, true);
  assert.equal(created.campaign.employeeId, emp.employee.id);
  assert.equal(created.campaign.agentId, 'ag_1');

  const added = campaigns.addLeads(
    db, 't_a', created.campaign.id,
    '+919811111111, Ada\n+919822222222, Bob',
  );
  assert.equal(added.added, 2);

  const denied = campaigns.enqueueCampaign(db, 't_a', created.campaign.id, { confirm: false });
  assert.equal(denied.code, 'needs_confirm');

  // Mock dial path: create CallJobs the same way server does after stub_queued.
  const batch = campaigns.enqueueCampaign(db, 't_a', created.campaign.id, { confirm: true });
  assert.equal(batch.ok, true);
  assert.equal(batch.enqueued, 2);

  for (const item of batch.results) {
    const lead = db.campaignLeads.find((l) => l.id === item.id);
    const job = callJobs.createCallJob(db, 't_a', {
      toE164: lead.phone,
      campaignLeadId: lead.id,
      employeeId: created.campaign.employeeId,
      agentId: created.campaign.agentId,
      source: 'campaign',
    }, 'u_1');
    assert.equal(job.ok, true);
    assert.equal(job.job.employeeId, emp.employee.id);
    assert.equal(job.job.source, 'campaign');
    const pub = callJobs.publicCallJob(job.job);
    assert.equal(pub.providerRunId, undefined);
    assert.equal(JSON.stringify(pub).includes('dograh'), false);
  }
  assert.equal(callJobs.listCallJobs(db, 't_a').length, 2);
  assert.equal(callJobs.listCallJobs(db, 't_b').length, 0);
});

test('performance aggregates are honest empties and tenant scoped', () => {
  const empty = analytics.buildDashboard({
    agents: [], employees: [], calls: [], leads: [], campaigns: [], campaignLeads: [],
  }, 't_a');
  assert.equal(empty.calls.totals.calls, 0);
  assert.equal(empty.calls.totals.converted, 0);
  assert.equal(empty.calls.totals.conversionRatePct, null);
  assert.equal(empty.leads.totals.leads, 0);
  assert.equal(empty.outcomes.totals.observed, 0);

  const db = {
    agents: [{ id: 'ag_1', tenantId: 't_a', name: 'Desk' }],
    employees: [{
      id: 'emp_1', tenantId: 't_a', name: 'Ria', agentId: 'ag_1',
      outcomes: [{ key: 'qualified', label: 'Qualified', success: true }],
    }],
    calls: [
      {
        tenantId: 't_a', agentId: 'ag_1', employeeId: 'emp_1', direction: 'outbound',
        outcome: 'qualified', status: 'completed', durationSec: 30, extractedData: { qualified: true },
      },
      {
        tenantId: 't_a', agentId: 'ag_1', direction: 'inbound',
        outcome: 'no_answer', status: 'completed', durationSec: 10, extractedData: {},
      },
      {
        tenantId: 't_b', agentId: 'ag_x', outcome: 'qualified', status: 'completed', durationSec: 99,
        extractedData: { booked: true },
      },
    ],
    leads: [
      { tenantId: 't_a', employeeId: 'emp_1', status: 'new', outcomeKey: null },
      { tenantId: 't_a', employeeId: null, status: 'calling', outcomeKey: 'no_answer' },
      { tenantId: 't_b', employeeId: 'emp_x', status: 'new' },
    ],
    campaigns: [{ id: 'c1', tenantId: 't_a', status: 'running', employeeId: 'emp_1' }],
    campaignLeads: [{ id: 'l1', tenantId: 't_a', campaignId: 'c1', status: 'pending' }],
  };
  const dash = analytics.buildDashboard(db, 't_a');
  assert.equal(dash.calls.totals.calls, 2);
  assert.equal(dash.calls.totals.converted, 1);
  assert.equal(dash.calls.totals.conversionRatePct, 50);
  assert.equal(dash.calls.byEmployee.Ria, 2);
  assert.equal(dash.leads.totals.leads, 2);
  assert.equal(dash.leads.totals.connected, 1);
  assert.equal(dash.outcomes.totals.defined, 1);
  assert.equal(JSON.stringify(dash).includes('t_b'), false);
  assert.equal(JSON.stringify(dash).includes('dograh'), false);
});
