'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const core = require('../lib/core');
const employees = require('../lib/employees');
const leads = require('../lib/leads');
const callJobs = require('../lib/call-jobs');
const calls = require('../lib/calls');
const timeline = require('../lib/timeline');
const { seedPresets } = require('../lib/agent-types');

function emptyDb() {
  return {
    schemaVersion: 11,
    tenants: [{ id: 't_a', name: 'A' }, { id: 't_b', name: 'B' }],
    users: [],
    agents: [],
    workflows: [],
    calls: [],
    leads: [],
    callJobs: [],
    phoneNumbers: [],
    knowledgeEntries: [],
    presets: [],
    providerResources: [],
    employees: [],
  };
}

test('schema v11 migrates callJobs.employeeId from lead', () => {
  const migrated = core.migrateDb({
    schemaVersion: 10,
    leads: [{
      id: 'lead_1', tenantId: 't_a', name: 'Ada', phone: '+919811111111',
      employeeId: 'emp_1',
    }],
    callJobs: [{
      id: 'cjob_1', tenantId: 't_a', leadId: 'lead_1', toE164: '+919811111111',
      status: 'queued',
    }],
    employees: [],
  });
  assert.equal(migrated.schemaVersion, 12);
  assert.equal(migrated.callJobs[0].employeeId, 'emp_1');
});

test('employee workflow get/update uses Steps and Instructions language', () => {
  const db = emptyDb();
  seedPresets(db);
  const created = employees.createEmployee(db, 't_a', {
    templateKey: 'outbound_sales',
    name: 'Sales Emp',
  }, 'u1');
  assert.equal(created.ok, true);

  const got = employees.getWorkflow(db, 't_a', created.employee.id);
  assert.equal(got.ok, true);
  assert.equal(got.workflow.hasWorkflow, true);
  assert.ok(got.workflow.steps.length >= 1);
  assert.equal(got.workflow.steps[0].type, 'step');
  assert.ok('guidance' in got.workflow.steps[0]);
  assert.equal(JSON.stringify(got.workflow).toLowerCase().includes('dograh'), false);
  assert.equal(JSON.stringify(got.workflow).includes('graphJson'), false);
  assert.equal(JSON.stringify(got.workflow).includes('providerWorkflowId'), false);

  const updated = employees.updateWorkflow(db, 't_a', created.employee.id, {
    name: 'Outbound sales flow',
    description: 'Permission then discovery',
    globalGuidance: 'Be brief. Never invent facts.',
    steps: [
      { name: 'Permission', guidance: 'Ask if it is a good time.' },
      { name: 'Discovery', guidance: 'Learn the need in two questions.' },
      { name: 'Book', guidance: 'Confirm next step aloud.' },
    ],
  });
  assert.equal(updated.ok, true);
  assert.equal(updated.workflow.name, 'Outbound sales flow');
  assert.equal(updated.workflow.steps.length, 3);
  assert.equal(updated.workflow.steps[1].guidance, 'Learn the need in two questions.');
  assert.equal(updated.workflow.globalGuidance, 'Be brief. Never invent facts.');

  const wf = db.workflows.find((w) => w.id === created.employee.workflowId);
  assert.ok(wf.graphJson.nodes.some((n) => n.name === 'Discovery'));
});

test('timeline builds only from real Lead/CallJob/Call events and stays empty honestly', () => {
  const db = emptyDb();
  seedPresets(db);
  const emp = employees.createEmployee(db, 't_a', {
    templateKey: 'instant_lead_caller',
    name: 'Caller',
  }, 'u1');
  const emptyTl = timeline.buildEmployeeTimeline(db, 't_a', emp.employee.id);
  assert.equal(emptyTl.ok, true);
  assert.equal(emptyTl.timeline.empty, true);
  assert.equal(emptyTl.timeline.count, 0);
  assert.deepEqual(emptyTl.timeline.events, []);

  const lead = leads.createLead(db, 't_a', {
    name: 'Priya',
    phone: '9876543210',
    employeeId: emp.employee.id,
  }, 'u1');
  assert.equal(lead.ok, true);

  const job = callJobs.createCallJob(db, 't_a', {
    toE164: lead.lead.phone,
    leadId: lead.lead.id,
    employeeId: emp.employee.id,
    agentId: emp.employee.agentId,
    source: 'instant',
  }, 'u1');
  assert.equal(job.ok, true);
  assert.equal(job.job.employeeId, emp.employee.id);
  callJobs.updateCallJobStatus(db, 't_a', job.job.id, 'dialing');
  callJobs.updateCallJobStatus(db, 't_a', job.job.id, 'completed', {
    providerRunId: 'run_real_1',
    resultCallId: 'call_real_1',
  });

  db.calls.push({
    id: 'call_real_1',
    tenantId: 't_a',
    agentId: emp.employee.agentId,
    direction: 'outbound',
    fromE164: '+918000000000',
    toE164: lead.lead.phone,
    status: 'completed',
    startedAt: '2026-03-01T10:00:00.000Z',
    endedAt: '2026-03-01T10:02:00.000Z',
    durationSec: 120,
    outcome: 'qualified',
    createdAt: '2026-03-01T10:00:00.000Z',
    updatedAt: '2026-03-01T10:02:00.000Z',
  });
  leads.updateLead(db, 't_a', lead.lead.id, {
    status: 'qualified',
    outcomeKey: 'qualified',
    lastCallId: 'call_real_1',
    lastCallJobId: job.job.id,
  });

  const empTl = timeline.buildEmployeeTimeline(db, 't_a', emp.employee.id, { limit: 50 });
  assert.equal(empTl.ok, true);
  assert.equal(empTl.timeline.empty, false);
  const types = empTl.timeline.events.map((e) => e.type);
  assert.ok(types.includes('lead_connected'));
  assert.ok(types.includes('job_queued') || types.includes('job_dialing') || types.includes('job_completed'));
  assert.ok(types.includes('call_started'));
  assert.ok(types.includes('call_ended'));
  assert.ok(types.includes('outcome_set'));
  assert.equal(JSON.stringify(empTl.timeline).toLowerCase().includes('dograh'), false);
  assert.equal(JSON.stringify(empTl.timeline).includes('providerRunId'), false);

  const leadTl = timeline.buildLeadTimeline(db, 't_a', lead.lead.id);
  assert.equal(leadTl.ok, true);
  assert.ok(leadTl.timeline.count > 0);

  const cross = timeline.buildEmployeeTimeline(db, 't_b', emp.employee.id);
  assert.equal(cross.ok, false);
});

test('call job queue list enriches employee/lead/call without provider ids', () => {
  const db = emptyDb();
  seedPresets(db);
  const emp = employees.createEmployee(db, 't_a', {
    templateKey: 'instant_lead_caller',
    name: 'Queue Emp',
  }, 'u1');
  const lead = leads.createLead(db, 't_a', {
    name: 'Queue Lead',
    phone: '+919876543210',
    employeeId: emp.employee.id,
  }, 'u1');
  const job = callJobs.createCallJob(db, 't_a', {
    toE164: '+919876543210',
    leadId: lead.lead.id,
    employeeId: emp.employee.id,
    agentId: emp.employee.agentId,
  }, 'u1');
  callJobs.updateCallJobStatus(db, 't_a', job.job.id, 'completed', {
    providerRunId: 'secret_run',
    resultCallId: 'call_q1',
  });
  db.calls.push({
    id: 'call_q1',
    tenantId: 't_a',
    agentId: emp.employee.agentId,
    direction: 'outbound',
    status: 'completed',
    outcome: 'booked',
    startedAt: '2026-03-02T10:00:00.000Z',
    createdAt: '2026-03-02T10:00:00.000Z',
    updatedAt: '2026-03-02T10:00:00.000Z',
  });

  const listed = callJobs.listCallJobs(db, 't_a', { employeeId: emp.employee.id });
  assert.equal(listed.length, 1);
  assert.equal(listed[0].employeeId, emp.employee.id);
  assert.equal(listed[0].employeeName, 'Queue Emp');
  assert.equal(listed[0].leadName, 'Queue Lead');
  assert.equal(listed[0].resultCallId, 'call_q1');
  assert.equal(listed[0].callOutcome, 'booked');
  assert.equal('providerRunId' in listed[0], false);
  assert.equal(callJobs.listCallJobs(db, 't_b', { employeeId: emp.employee.id }).length, 0);
});

test('conversations list filters by employee and outcome with honest empty', () => {
  const db = emptyDb();
  seedPresets(db);
  const emp = employees.createEmployee(db, 't_a', {
    templateKey: 'receptionist',
    name: 'Front',
  }, 'u1');
  db.calls.push({
    id: 'call_c1',
    tenantId: 't_a',
    agentId: emp.employee.agentId,
    direction: 'inbound',
    status: 'completed',
    outcome: 'message_taken',
    startedAt: '2026-03-03T10:00:00.000Z',
    createdAt: '2026-03-03T10:00:00.000Z',
    updatedAt: '2026-03-03T10:00:00.000Z',
  });
  db.calls.push({
    id: 'call_c2',
    tenantId: 't_a',
    agentId: 'ag_other',
    direction: 'outbound',
    status: 'completed',
    outcome: 'no_answer',
    startedAt: '2026-03-03T11:00:00.000Z',
    createdAt: '2026-03-03T11:00:00.000Z',
    updatedAt: '2026-03-03T11:00:00.000Z',
  });

  const byEmp = calls.listTenantCalls(db, 't_a', { employeeId: emp.employee.id });
  assert.equal(byEmp.length, 1);
  assert.equal(byEmp[0].id, 'call_c1');

  const byOutcome = calls.listTenantCalls(db, 't_a', { outcome: 'no_answer' });
  assert.equal(byOutcome.length, 1);
  assert.equal(byOutcome[0].id, 'call_c2');

  const none = calls.listTenantCalls(db, 't_a', { employeeId: 'emp_missing' });
  assert.equal(none.length, 0);

  const pub = calls.publicCall(byEmp[0], new Map([[emp.employee.agentId, { name: 'Front' }]]), { detail: true });
  assert.equal(pub.agentName, 'Front');
  assert.equal('providerRunId' in pub, false);
  assert.equal('dograhWorkflowId' in pub, false);
});
