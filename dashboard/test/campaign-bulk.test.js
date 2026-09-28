'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const campaigns = require('../lib/campaigns');
const sheetParse = require('../lib/sheet-parse');
const phoneNumbers = require('../lib/phone-numbers');
const callJobs = require('../lib/call-jobs');

test('sheet parse round-trips csv and xlsx sample', () => {
  const csv = campaigns.buildSampleCsv();
  const fromCsv = sheetParse.parseUpload(csv, 'sample.csv');
  assert.equal(fromCsv.rows.length, 6);
  assert.ok(fromCsv.headers.includes('phone_number'));

  const xlsx = campaigns.buildSampleXlsx();
  const fromX = sheetParse.parseUpload(xlsx, 'sample.xlsx');
  assert.equal(fromX.rows.length, 6);
  assert.equal(fromX.rows[0].phone_number, 'REPLACE_WITH_AUTHORIZED_TEST');
  assert.equal(fromX.rows[1].phone_number, '9000000001');
});

test('upload map validate shows READY INVALID DUPLICATES and never dials malformed', () => {
  const db = {
    campaigns: [],
    campaignLeads: [],
    employees: [{
      id: 'emp_1',
      tenantId: 't_a',
      name: 'Ria',
      agentId: 'ag_1',
      workflowId: 'wf_1',
      phoneNumberId: null,
      status: 'LIVE',
      description: 'Demo brief',
    }],
    agents: [{ id: 'ag_1', tenantId: 't_a', name: 'Ria', persona: 'Helpful', greeting: 'Hi' }],
    workflows: [{ id: 'wf_1', tenantId: 't_a', status: 'published' }],
    phoneNumbers: [],
    leads: [],
    callJobs: [],
    calls: [],
  };
  phoneNumbers.seedPlatformInventory(db);
  phoneNumbers.assignNumber(db, {
    numberId: phoneNumbers.PLATFORM_SEED_ID,
    tenantId: 't_a',
    agentId: 'ag_1',
    employeeId: 'emp_1',
    outboundEnabled: true,
  });
  db.employees[0].phoneNumberId = phoneNumbers.PLATFORM_SEED_ID;

  const created = campaigns.createCampaign(db, 't_a', {
    name: 'Bulk demo',
    employeeId: 'emp_1',
    concurrency: 2,
  }, 'u1');
  assert.equal(created.ok, true);

  const uploaded = campaigns.storeUpload(db, 't_a', created.campaign.id, {
    filename: 'demo.csv',
    text: campaigns.buildSampleCsv(),
  });
  assert.equal(uploaded.ok, true);
  assert.equal(uploaded.campaign.upload.rowCount, 6);
  assert.equal(uploaded.suggestedMapping.phone_number, 'phone_number');

  const mapped = campaigns.applyColumnMap(db, 't_a', created.campaign.id, uploaded.suggestedMapping);
  assert.equal(mapped.ok, true);
  // Sample ships with zero READY rows until REPLACE_WITH_AUTHORIZED_TEST is filled.
  assert.equal(mapped.counts.ready, 0);
  assert.equal(mapped.counts.invalid, 6);

  // Inject one authorized READY row and re-map via addLeads path for dial safety check.
  campaigns.addLeads(db, 't_a', created.campaign.id, '+918065353938, Authorized');
  const validation = campaigns.validateLaunch(db, 't_a', created.campaign.id, { providerAvailable: true });
  assert.equal(validation.ok, true);
  assert.equal(validation.counts.ready > 0, true);

  const batch = campaigns.enqueueCampaign(db, 't_a', created.campaign.id, { confirm: true, limit: 10 });
  assert.equal(batch.ok, true);
  assert.equal(batch.enqueued, validation.counts.ready);
  const blocked = (db.campaignLeads || []).filter((l) =>
    String(l.phone || '').includes('900000000') || /REPLACE_WITH/i.test(String(l.phone || '')));
  blocked.forEach((l) => {
    assert.ok(['invalid', 'duplicate'].includes(l.status) || l.dialedAt == null);
  });
  const stillInvalid = (db.campaignLeads || []).filter((l) => l.status === 'invalid');
  assert.ok(stillInvalid.length >= 5);
  stillInvalid.forEach((l) => {
    assert.equal(l.dialedAt, null);
  });
});

test('duplicate active campaign blocked by validateLaunch', () => {
  const db = {
    campaigns: [],
    campaignLeads: [],
    employees: [{
      id: 'emp_1', tenantId: 't_a', name: 'Ria', agentId: 'ag_1', workflowId: 'wf_1',
      phoneNumberId: 'pn_1', status: 'LIVE', description: 'x',
    }],
    agents: [{ id: 'ag_1', tenantId: 't_a', name: 'Ria', persona: 'Hi' }],
    phoneNumbers: [{
      id: 'pn_1', tenantId: 't_a', status: 'assigned', outboundEnabled: true, e164: '+918065353938',
    }],
    leads: [],
  };
  const a = campaigns.createCampaign(db, 't_a', { name: 'A', employeeId: 'emp_1' }, 'u1');
  const b = campaigns.createCampaign(db, 't_a', { name: 'B', employeeId: 'emp_1' }, 'u1');
  a.campaign.status = 'running';
  campaigns.addLeads(db, 't_a', b.campaign.id, '+918065353938, Test');
  const v = campaigns.validateLaunch(db, 't_a', b.campaign.id, { providerAvailable: true });
  assert.equal(v.ok, false);
  assert.ok(v.checks.some((c) => c.code === 'duplicate_active_campaign' && !c.ok));
});

test('export preserves outcomes and original columns without provider ids', () => {
  const db = {
    campaigns: [],
    campaignLeads: [],
    agents: [{ id: 'ag_1', tenantId: 't_a', name: 'Out' }],
    employees: [],
    calls: [],
    callJobs: [],
    leads: [],
  };
  const created = campaigns.createCampaign(db, 't_a', { name: 'Export', agentId: 'ag_1' }, 'u1');
  campaigns.addLeads(db, 't_a', created.campaign.id, [
    { phone: '+918065353938', name: 'Ada', meta: { company: 'Astra', original: { Region: 'South' } } },
  ]);
  const lead = db.campaignLeads[0];
  lead.status = 'completed';
  lead.outcomeKey = 'qualified';
  lead.lastCallId = 'call_1';
  db.calls.push({
    id: 'call_1', tenantId: 't_a', outcome: 'qualified', status: 'completed',
  });
  const exp = campaigns.exportCampaignRows(db, 't_a', created.campaign.id);
  assert.equal(exp.ok, true);
  assert.ok(exp.headers.includes('outcome'));
  assert.ok(exp.headers.includes('original_Region'));
  assert.equal(exp.rows[0].outcome, 'qualified');
  assert.equal(/dograh|vobiz|providerRunId/i.test(exp.csv), false);
});

test('call job status set includes campaign lifecycle states', () => {
  assert.ok(callJobs.JOB_STATUSES.has('queued'));
  assert.ok(callJobs.JOB_STATUSES.has('scheduled'));
  assert.ok(callJobs.JOB_STATUSES.has('calling'));
  assert.ok(callJobs.JOB_STATUSES.has('connected'));
  assert.ok(callJobs.JOB_STATUSES.has('no_answer'));
  assert.ok(callJobs.JOB_STATUSES.has('retry_scheduled'));
  assert.ok(callJobs.JOB_STATUSES.has('cancelled'));
  const db = { callJobs: [] };
  const created = callJobs.createCallJob(db, 't_a', { toE164: '+918065353938', source: 'campaign' }, 'u1');
  const up = callJobs.updateCallJobStatus(db, 't_a', created.job.id, 'dialing');
  assert.equal(up.ok, true);
  assert.equal(up.job.status, 'calling');
});

test('sample files exist under demo-assets', () => {
  const csvPath = path.join(__dirname, '../demo-assets/campaign-demo-leads.csv');
  const xlsxPath = path.join(__dirname, '../demo-assets/campaign-demo-leads.xlsx');
  assert.equal(fs.existsSync(csvPath), true);
  assert.equal(fs.existsSync(xlsxPath), true);
  const text = fs.readFileSync(csvPath, 'utf8');
  assert.ok(text.includes('REPLACE_WITH_AUTHORIZED_TEST'));
  assert.ok(text.includes('9000000001'));
  assert.ok(text.includes('NON_DIALABLE_900000000x'));
  // No random real-looking mobiles outside the safe 900000000x fixture series.
  assert.equal(/,[6-8]\d{9},/.test(text), false);
});
