'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const leads = require('../lib/leads');
const callJobs = require('../lib/call-jobs');

test('normalizePhoneIN accepts 10-digit IN, 91-prefixed, and E.164', () => {
  assert.equal(leads.normalizePhoneIN('9876543210'), '+919876543210');
  assert.equal(leads.normalizePhoneIN('919876543210'), '+919876543210');
  assert.equal(leads.normalizePhoneIN('+919876543210'), '+919876543210');
  assert.equal(leads.normalizePhoneIN(' 98-765-43210 '), '+919876543210');
  assert.equal(leads.normalizePhoneIN('bad'), '');
  assert.equal(leads.isValidE164('+919876543210'), true);
  assert.equal(leads.isValidE164('9876543210'), false);
});

test('createLead idempotency key returns same lead without duplicate', () => {
  const db = { leads: [], agents: [{ id: 'ag_1', tenantId: 't_a', name: 'Rep' }] };
  const first = leads.createLead(db, 't_a', {
    name: 'Ada',
    phone: '9876543210',
    agentId: 'ag_1',
    idempotencyKey: 'batch-1-ada',
  }, 'u1');
  assert.equal(first.ok, true);
  assert.equal(first.created, true);
  assert.equal(first.lead.phone, '+919876543210');
  assert.equal(db.leads.length, 1);

  const second = leads.createLead(db, 't_a', {
    name: 'Ada Again',
    phone: '9999999999',
    idempotencyKey: 'batch-1-ada',
  }, 'u1');
  assert.equal(second.ok, true);
  assert.equal(second.created, false);
  assert.equal(second.lead.id, first.lead.id);
  assert.equal(db.leads.length, 1);
});

test('publicLead never exposes provider ids or Dograh fields', () => {
  const row = {
    id: 'lead_1',
    tenantId: 't_a',
    name: 'Bob',
    phone: '+919811111111',
    status: 'new',
    agentId: 'ag_1',
    workflowId: 'wf_1',
    phoneNumberId: 'pn_1',
    lastCallJobId: 'cjob_1',
    lastCallId: 'call_1',
    lastError: null,
    meta: { note: 'vip' },
    idempotencyKey: 'secret-key',
    providerRunId: 'should-not-leak',
    dograhWorkflowId: 8,
    dograhPhoneNumberId: 3,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const pub = leads.publicLead(row);
  assert.equal(pub.id, 'lead_1');
  assert.equal(pub.phone, '+919811111111');
  assert.equal(pub.meta.note, 'vip');
  assert.equal('providerRunId' in pub, false);
  assert.equal('dograhWorkflowId' in pub, false);
  assert.equal('dograhPhoneNumberId' in pub, false);
  assert.equal('idempotencyKey' in pub, false);
  assert.equal('tenantId' in pub, false);
});

test('call job status transitions and public serialization hide providerRunId', () => {
  const db = { callJobs: [] };
  const created = callJobs.createCallJob(db, 't_a', {
    toE164: '+919876543210',
    leadId: 'lead_1',
    agentId: 'ag_1',
    source: 'instant',
  }, 'u1');
  assert.equal(created.ok, true);
  assert.equal(created.created, true);
  assert.equal(created.job.status, 'queued');

  const dialing = callJobs.updateCallJobStatus(db, 't_a', created.job.id, 'dialing');
  assert.equal(dialing.ok, true);
  assert.equal(dialing.job.status, 'dialing');
  assert.ok(dialing.job.dialedAt);

  const done = callJobs.updateCallJobStatus(db, 't_a', created.job.id, 'completed', {
    providerRunId: 'dograh_run_99',
    resultCallId: 'call_abc',
  });
  assert.equal(done.ok, true);
  assert.equal(done.job.status, 'completed');
  assert.equal(done.job.providerRunId, 'dograh_run_99');
  assert.equal(done.job.resultCallId, 'call_abc');

  const pub = callJobs.publicCallJob(done.job);
  assert.equal(pub.resultCallId, 'call_abc');
  assert.equal(pub.status, 'completed');
  assert.equal('providerRunId' in pub, false);
  assert.equal('tenantId' in pub, false);

  const bad = callJobs.updateCallJobStatus(db, 't_a', created.job.id, 'stub_queued');
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'bad_status');

  const failed = callJobs.updateCallJobStatus(db, 't_a', created.job.id, 'failed', {
    lastError: 'upstream timeout',
  });
  assert.equal(failed.ok, true);
  assert.equal(failed.job.status, 'failed');
  assert.equal(callJobs.publicCallJob(failed.job).lastError, 'upstream timeout');
});

test('CallJob idempotencyKey and active lead job prevent duplicates', () => {
  const db = { callJobs: [] };
  const first = callJobs.createCallJob(db, 't_a', {
    toE164: '+919876543210',
    leadId: 'lead_1',
    idempotencyKey: 'dial-ada-1',
    source: 'instant',
  }, 'u1');
  assert.equal(first.created, true);

  const byKey = callJobs.createCallJob(db, 't_a', {
    toE164: '+919811122233',
    leadId: 'lead_2',
    idempotencyKey: 'dial-ada-1',
  }, 'u1');
  assert.equal(byKey.created, false);
  assert.equal(byKey.job.id, first.job.id);
  assert.equal(db.callJobs.length, 1);

  callJobs.updateCallJobStatus(db, 't_a', first.job.id, 'dialing');
  const activeReuse = callJobs.createCallJob(db, 't_a', {
    toE164: '+919876543210',
    leadId: 'lead_1',
  }, 'u1');
  assert.equal(activeReuse.created, false);
  assert.equal(activeReuse.job.id, first.job.id);
  assert.equal(db.callJobs.length, 1);

  callJobs.updateCallJobStatus(db, 't_a', first.job.id, 'completed', {
    providerRunId: 'run_real',
    resultCallId: 'call_1',
  });
  const afterDone = callJobs.createCallJob(db, 't_a', {
    toE164: '+919876543210',
    leadId: 'lead_1',
  }, 'u1');
  assert.equal(afterDone.created, true);
  assert.notEqual(afterDone.job.id, first.job.id);
  assert.equal(db.callJobs.length, 2);
});

test('createLead rejects bad phone and missing agent', () => {
  const db = { leads: [], agents: [] };
  const badPhone = leads.createLead(db, 't_a', { name: 'X', phone: '123' }, 'u1');
  assert.equal(badPhone.ok, false);
  assert.equal(badPhone.code, 'bad_phone');
  const missingAgent = leads.createLead(db, 't_a', {
    name: 'X',
    phone: '+919876543210',
    agentId: 'ag_missing',
  }, 'u1');
  assert.equal(missingAgent.ok, false);
  assert.equal(missingAgent.code, 'agent_not_found');
});

test('lead stores agent/workflow/phoneNumber as ids only', () => {
  const db = {
    leads: [],
    agents: [{ id: 'ag_1', tenantId: 't_a', name: 'Rep' }],
    workflows: [{ id: 'wf_abc', tenantId: 't_a', name: 'Outbound' }],
    phoneNumbers: [{ id: 'pn_xyz', tenantId: 't_a', e164: '+918065353938' }],
  };
  const created = leads.createLead(db, 't_a', {
    name: 'Cara',
    phone: '9876543210',
    agentId: 'ag_1',
    workflowId: 'wf_abc',
    phoneNumberId: 'pn_xyz',
  }, 'u1');
  assert.equal(created.ok, true);
  assert.equal(created.lead.agentId, 'ag_1');
  assert.equal(created.lead.workflowId, 'wf_abc');
  assert.equal(created.lead.phoneNumberId, 'pn_xyz');
  const pub = leads.publicLead(created.lead);
  assert.equal(pub.agentId, 'ag_1');
  assert.equal(pub.workflowId, 'wf_abc');
  assert.equal(pub.phoneNumberId, 'pn_xyz');
  assert.equal(JSON.stringify(pub).includes('dograh'), false);
});
