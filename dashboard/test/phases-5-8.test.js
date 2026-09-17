'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const employees = require('../lib/employees');
const leads = require('../lib/leads');
const core = require('../lib/core');
const { seedPresets } = require('../lib/agent-types');

function emptyDb() {
  return {
    schemaVersion: 10,
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

test('schema v10 migrates string outcomes and lead.employeeId', () => {
  const migrated = core.migrateDb({
    schemaVersion: 9,
    employees: [{
      id: 'emp_1', tenantId: 't_a', name: 'Maya', knowledgeIds: null,
      outcomes: ['qualified', 'no_answer'],
    }],
    leads: [{ id: 'lead_1', tenantId: 't_a', name: 'Ada', phone: '+919811111111' }],
  });
  assert.equal(migrated.schemaVersion, 12);
  assert.equal(Array.isArray(migrated.employees[0].knowledgeIds), true);
  assert.equal(migrated.employees[0].outcomes[0].key, 'qualified');
  assert.equal(migrated.employees[0].outcomes[0].success, true);
  assert.equal(migrated.employees[0].outcomes[1].key, 'no_answer');
  assert.equal(migrated.leads[0].employeeId, null);
});

test('instructions update writes agent greeting/persona and employee brief', () => {
  const db = emptyDb();
  seedPresets(db);
  const created = employees.createEmployee(db, 't_a', {
    templateKey: 'receptionist',
    name: 'Front Desk',
    description: 'Old brief',
  }, 'u1');
  assert.equal(created.ok, true);

  const got = employees.getInstructions(db, 't_a', created.employee.id);
  assert.equal(got.ok, true);
  assert.equal(got.instructions.hasAgent, true);
  assert.ok(got.instructions.steps.length > 0);

  const updated = employees.updateInstructions(db, 't_a', created.employee.id, {
    brief: 'New brief for callers',
    greeting: 'Hello, thanks for calling.',
    instructions: 'Be warm. Capture name and reason.',
    steps: [{ id: got.instructions.steps[0].id, guidance: 'Updated step guidance' }],
  });
  assert.equal(updated.ok, true);
  assert.equal(updated.instructions.brief, 'New brief for callers');
  assert.equal(updated.instructions.greeting, 'Hello, thanks for calling.');
  assert.equal(updated.instructions.instructions, 'Be warm. Capture name and reason.');

  const agent = db.agents.find((a) => a.id === created.employee.agentId);
  assert.equal(agent.greeting, 'Hello, thanks for calling.');
  assert.equal(agent.persona, 'Be warm. Capture name and reason.');
  assert.equal(created.employee.description, 'New brief for callers');
  const node = db.workflows[0].graphJson.nodes.find((n) => n.id === got.instructions.steps[0].id);
  assert.equal(node.prompt, 'Updated step guidance');
});

test('training attach/detach and create-and-attach knowledge', () => {
  const db = emptyDb();
  seedPresets(db);
  const created = employees.createEmployee(db, 't_a', {
    templateKey: 'support',
    name: 'Support Emp',
  }, 'u1');
  const empty = employees.listTraining(db, 't_a', created.employee.id);
  assert.equal(empty.ok, true);
  assert.equal(empty.training.count, 0);

  const made = employees.createAndAttachKnowledge(db, 't_a', created.employee.id, {
    title: 'Refund policy',
    content: 'Refunds within 7 days with receipt.',
    status: 'published',
  }, 'u1');
  assert.equal(made.ok, true);
  assert.ok(made.entry.id.startsWith('kb_'));
  assert.equal(made.training.count, 1);
  assert.equal(created.employee.knowledgeIds.length, 1);

  const detached = employees.detachKnowledge(db, 't_a', created.employee.id, made.entry.id);
  assert.equal(detached.ok, true);
  assert.equal(detached.training.count, 0);

  const reattach = employees.attachKnowledge(db, 't_a', created.employee.id, made.entry.id);
  assert.equal(reattach.ok, true);
  assert.equal(reattach.training.count, 1);

  const cross = employees.attachKnowledge(db, 't_b', created.employee.id, made.entry.id);
  assert.equal(cross.ok, false);
});

test('outcomes schema is structured and publicEmployee never invents results', () => {
  const db = emptyDb();
  seedPresets(db);
  const created = employees.createEmployee(db, 't_a', {
    templateKey: 'lead_qualification',
    name: 'Qualifier',
  }, 'u1');
  const pub = employees.publicEmployee(created.employee, db);
  assert.ok(Array.isArray(pub.outcomes));
  assert.equal(typeof pub.outcomes[0], 'object');
  assert.ok(pub.outcomes[0].key);
  assert.ok(pub.outcomes[0].label);

  const set = employees.setOutcomes(db, 't_a', created.employee.id, [
    { key: 'qualified', label: 'Qualified', success: true },
    { key: 'not_interested', label: 'Not interested', success: false, description: 'Polite close' },
  ]);
  assert.equal(set.ok, true);
  assert.equal(set.outcomes.count, 2);
  assert.equal(set.outcomes.resultsAvailable, false);
  assert.deepEqual(set.outcomes.results, []);
  assert.equal(JSON.stringify(set.outcomes).toLowerCase().includes('dograh'), false);
});

test('lead formalization links employeeId and resolves agent/workflow', () => {
  const db = emptyDb();
  seedPresets(db);
  const emp = employees.createEmployee(db, 't_a', {
    templateKey: 'instant_lead_caller',
    name: 'Caller',
  }, 'u1');
  const created = leads.createLead(db, 't_a', {
    name: 'Priya',
    phone: '9876543210',
    employeeId: emp.employee.id,
  }, 'u1');
  assert.equal(created.ok, true);
  assert.ok(created.lead.id.startsWith('lead_'));
  assert.equal(created.lead.employeeId, emp.employee.id);
  assert.equal(created.lead.agentId, emp.employee.agentId);
  assert.equal(created.lead.workflowId, emp.employee.workflowId);
  assert.equal(created.lead.status, 'assigned');

  const listed = leads.listLeads(db, 't_a', { employeeId: emp.employee.id });
  assert.equal(listed.length, 1);
  assert.equal(listed[0].employeeId, emp.employee.id);
  assert.equal('tenantId' in listed[0], false);
  assert.equal('providerRunId' in listed[0], false);

  const patched = leads.updateLead(db, 't_a', created.lead.id, { status: 'qualified', outcomeKey: 'qualified' });
  assert.equal(patched.ok, true);
  assert.equal(patched.lead.status, 'qualified');
  assert.equal(patched.lead.outcomeKey, 'qualified');
});

test('lead formalization and employee helpers stay tenant-scoped without HTTP harness', () => {
  const db = emptyDb();
  seedPresets(db);
  const emp = employees.createEmployee(db, 't_a', {
    templateKey: 'receptionist',
    name: 'HTTP Emp',
  }, 'u_a');
  assert.equal(emp.ok, true);

  const instr = employees.updateInstructions(db, 't_a', emp.employee.id, {
    greeting: 'Hi there',
    instructions: 'Help politely',
    brief: 'Front desk',
  });
  assert.equal(instr.ok, true);

  const train = employees.createAndAttachKnowledge(db, 't_a', emp.employee.id, {
    title: 'Hours',
    content: 'Open 9 to 6',
    status: 'published',
  }, 'u_a');
  assert.equal(train.ok, true);

  const outs = employees.setOutcomes(db, 't_a', emp.employee.id, [
    { key: 'message_taken', label: 'Message taken', success: true },
  ]);
  assert.equal(outs.ok, true);

  const lead = leads.createLead(db, 't_a', {
    name: 'Caller',
    phone: '+919876543210',
    employeeId: emp.employee.id,
  }, 'u_a');
  assert.equal(lead.ok, true);
  const empLeads = leads.listLeads(db, 't_a', { employeeId: emp.employee.id });
  assert.equal(empLeads.length, 1);
  assert.equal(leads.listLeads(db, 't_b', { employeeId: emp.employee.id }).length, 0);
});
