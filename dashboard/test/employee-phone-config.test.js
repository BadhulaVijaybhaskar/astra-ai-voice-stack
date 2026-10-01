/**
 * Per-AI-Employee phone number configuration.
 *
 * Maya (emp_33eae8ef454680f0) keeps +918065353938 when assigned.
 * Vaani (emp_f85510806c9de004) uses another number or stays unassigned.
 * Changing Vaani never mutates Maya's phone mapping.
 *
 * No paid PSTN dials. Test inbound/outbound are dry-run / preflight only.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const phoneConfig = require('../lib/employee-phone-config');
const phoneNumbers = require('../lib/phone-numbers');
const employees = require('../lib/employees');
const { seedPresets } = require('../lib/agent-types');

const MAYA_ID = phoneConfig.MAYA_PROTECTED_EMPLOYEE_ID;
const VAANI_ID = phoneConfig.VAANI_EMPLOYEE_ID;

function emptyDb() {
  return {
    schemaVersion: 15,
    tenants: [{ id: 't_a', name: 'A' }],
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

function seedMayaAndVaani(db) {
  seedPresets(db);
  phoneNumbers.seedPlatformInventory(db);
  db.agents.push({
    id: 'ag_maya',
    tenantId: 't_a',
    name: 'Maya',
    persona: 'You are Maya.',
    greeting: 'Thank you for calling.',
    telephony: { did: '' },
    dograhWorkflowId: 8,
    createdAt: new Date().toISOString(),
  });
  db.workflows.push({
    id: 'wf_maya',
    tenantId: 't_a',
    name: 'Maya Receptionist',
    providerWorkflowId: '8',
    status: 'published',
    agentId: 'ag_maya',
  });
  db.employees.push({
    id: MAYA_ID,
    tenantId: 't_a',
    name: 'Maya',
    role: 'Receptionist',
    templateKey: 'receptionist',
    status: 'LIVE',
    agentId: 'ag_maya',
    workflowId: 'wf_maya',
    phoneNumberId: null,
    knowledgeIds: [],
    outcomes: [],
    actions: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  db.agents.push({
    id: 'ag_vaani',
    tenantId: 't_a',
    name: 'Vaani',
    persona: 'You are Vaani.',
    greeting: 'Namaskaram.',
    telephony: { did: '' },
    createdAt: new Date().toISOString(),
  });
  db.workflows.push({
    id: 'wf_vaani',
    tenantId: 't_a',
    name: 'Vaani Telugu Desk',
    providerWorkflowId: '42',
    status: 'published',
    agentId: 'ag_vaani',
  });
  db.employees.push({
    id: VAANI_ID,
    tenantId: 't_a',
    name: 'Vaani',
    role: 'Receptionist',
    templateKey: 'custom',
    status: 'READY',
    agentId: 'ag_vaani',
    workflowId: 'wf_vaani',
    phoneNumberId: null,
    knowledgeIds: [],
    outcomes: [],
    actions: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
}

function snapshotMayaPhone(db) {
  const emp = db.employees.find((e) => e.id === MAYA_ID);
  const number = (db.phoneNumbers || []).find((n) => n.id === phoneNumbers.PLATFORM_SEED_ID);
  return JSON.stringify({
    phoneNumberId: emp && emp.phoneNumberId,
    phoneConfig: emp && emp.phoneConfig,
    numberAssignedEmployeeId: number && number.assignedEmployeeId,
    numberStatus: number && number.status,
    numberMeta: number && number.providerMetadata,
    numberAnswerUrl: number && number.answerUrl,
    numberHangup: number && number.hangupCallback,
    agentDid: (db.agents.find((a) => a.id === 'ag_maya') || {}).telephony,
  });
}

test('seedPlatformInventory includes main + alternate inventory', () => {
  const db = emptyDb();
  phoneNumbers.seedPlatformInventory(db);
  assert.equal(db.phoneNumbers.length, 2);
  assert.equal(db.phoneNumbers[0].e164, '+918065353938');
  assert.ok(db.phoneNumbers.some((n) => n.id === phoneNumbers.PLATFORM_ALT_SEED_ID));
});

test('ASSIGN: Maya gets main number with phoneConfig persisted', () => {
  const db = emptyDb();
  seedMayaAndVaani(db);
  const assigned = phoneConfig.assignToEmployee(db, {
    tenantId: 't_a',
    employeeId: MAYA_ID,
    numberId: phoneNumbers.PLATFORM_SEED_ID,
    inboundEnabled: true,
    outboundEnabled: true,
  });
  assert.equal(assigned.ok, true);
  const emp = db.employees.find((e) => e.id === MAYA_ID);
  assert.equal(emp.phoneNumberId, phoneNumbers.PLATFORM_SEED_ID);
  assert.equal(emp.phoneConfig.assigned_phone_number, '+918065353938');
  assert.equal(emp.phoneConfig.direction, 'both');
  assert.equal(emp.phoneConfig.inbound_enabled, true);
  assert.equal(emp.phoneConfig.outbound_enabled, true);
  assert.equal(emp.phoneConfig.caller_id, '+918065353938');
  assert.equal(emp.phoneConfig.workflow_id, 'wf_maya');
  assert.ok(emp.phoneConfig.answer_url);
  assert.ok(emp.phoneConfig.hangup_callback);
  assert.equal(emp.phoneConfig.dograh_phone_id, 3);
  assert.equal(emp.phoneConfig.telephony_config_id, 2);
  assert.equal(assigned.number.assignedEmployeeId, MAYA_ID);
  assert.equal(assigned.verify.paidCall, false);
});

test('UNASSIGN: clears employee phoneConfig and returns number to inventory', () => {
  const db = emptyDb();
  seedMayaAndVaani(db);
  phoneConfig.assignToEmployee(db, {
    tenantId: 't_a', employeeId: MAYA_ID, numberId: phoneNumbers.PLATFORM_SEED_ID,
  });
  const un = phoneConfig.unassignFromEmployee(db, { tenantId: 't_a', employeeId: MAYA_ID });
  assert.equal(un.ok, true);
  const emp = db.employees.find((e) => e.id === MAYA_ID);
  assert.equal(emp.phoneNumberId, null);
  assert.equal(emp.phoneConfig.assigned_phone_number, null);
  assert.equal(emp.phoneConfig.direction, 'none');
  const number = phoneNumbers.findNumber(db, phoneNumbers.PLATFORM_SEED_ID);
  assert.equal(number.status, 'available');
  assert.equal(number.assignedEmployeeId, null);
});

test('INBOUND MAPPING + WORKFLOW BINDING + ANSWER URL + HANGUP CALLBACK', async () => {
  const db = emptyDb();
  seedMayaAndVaani(db);
  const assigned = phoneConfig.assignToEmployee(db, {
    tenantId: 't_a',
    employeeId: MAYA_ID,
    numberId: phoneNumbers.PLATFORM_SEED_ID,
  });
  assert.equal(assigned.ok, true);
  assert.equal(assigned.number.inboundWorkflowId, 'wf_maya');
  assert.match(String(assigned.number.answerUrl), /telephony\/inbound/);
  assert.match(String(assigned.number.hangupCallback), /hangup/);

  const emp = db.employees.find((e) => e.id === MAYA_ID);
  const sync = await phoneConfig.syncTelephonyMapping(db, 't_a', emp, assigned.number, { liveSync: false });
  assert.equal(sync.ok, true);
  assert.equal(sync.mode, 'dry_run');
  assert.equal(sync.providerWorkflowId, 8);
  assert.equal(sync.astraWorkflowId, 'wf_maya');
  assert.equal(assigned.number.providerMetadata.inboundWorkflowId, 8);
  assert.equal(assigned.number.providerMetadata.answerUrl, assigned.number.answerUrl);

  const pub = phoneConfig.publicPhoneConfig(db, emp, { advanced: false });
  assert.equal(pub.businessNumber, '+918065353938');
  assert.equal(pub.workflowName, 'Maya Receptionist');
  assert.equal(pub.answerUrlConfigured, true);
  assert.equal(pub.hangupCallbackConfigured, true);
  const blob = JSON.stringify(pub).toLowerCase();
  assert.equal(blob.includes('dograh'), false);
  assert.equal(blob.includes('vobiz'), false);
});

test('OUTBOUND MAPPING: caller ID + telephony ids for dial context', () => {
  const db = emptyDb();
  seedMayaAndVaani(db);
  phoneConfig.assignToEmployee(db, {
    tenantId: 't_a', employeeId: MAYA_ID, numberId: phoneNumbers.PLATFORM_SEED_ID,
  });
  const dial = phoneNumbers.outboundDialContext(db, 't_a');
  assert.ok(dial);
  assert.equal(dial.e164, '+918065353938');
  assert.equal(dial.dograhTelephonyConfigId, 2);
  assert.equal(dial.dograhPhoneNumberId, 3);
  assert.equal(dial.workflowId, 8);

  const out = phoneConfig.testOutbound(db, 't_a', MAYA_ID);
  assert.equal(out.ok, true);
  assert.equal(out.result.paidCall, false);
  assert.equal(out.result.callerIdOk, true);
  assert.equal(out.result.telephonyIdsOk, true);
});

test('TEST inbound/outbound refuse paid dials', () => {
  const db = emptyDb();
  seedMayaAndVaani(db);
  phoneConfig.assignToEmployee(db, {
    tenantId: 't_a', employeeId: MAYA_ID, numberId: phoneNumbers.PLATFORM_SEED_ID,
  });
  const inbound = phoneConfig.testInbound(db, 't_a', MAYA_ID);
  assert.equal(inbound.ok, true);
  assert.equal(inbound.result.paidCall, false);
  assert.equal(inbound.result.mode, 'dry_run');

  const refused = phoneConfig.testOutbound(db, 't_a', MAYA_ID, { confirmPaid: true });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'paid_calls_refused');
  assert.equal(refused.result.paidCall, false);
});

test('EMPLOYEE ISOLATION: Vaani assign/change never touches Maya mapping', () => {
  const db = emptyDb();
  seedMayaAndVaani(db);
  phoneConfig.assignToEmployee(db, {
    tenantId: 't_a', employeeId: MAYA_ID, numberId: phoneNumbers.PLATFORM_SEED_ID,
  });
  const before = snapshotMayaPhone(db);

  // Vaani stays unassigned.
  const vaaniPub = phoneConfig.publicPhoneConfig(db, db.employees.find((e) => e.id === VAANI_ID));
  assert.equal(vaaniPub.connectionState, 'Unassigned');
  assert.equal(vaaniPub.businessNumber, null);

  // Assign alternate number to Vaani.
  const vaaniAssign = phoneConfig.assignToEmployee(db, {
    tenantId: 't_a',
    employeeId: VAANI_ID,
    numberId: phoneNumbers.PLATFORM_ALT_SEED_ID,
  });
  assert.equal(vaaniAssign.ok, true);
  assert.equal(vaaniAssign.number.e164, '+918065353939');
  assert.equal(vaaniAssign.number.assignedEmployeeId, VAANI_ID);
  assert.equal(db.employees.find((e) => e.id === VAANI_ID).phoneConfig.workflow_id, 'wf_vaani');

  assert.equal(snapshotMayaPhone(db), before, 'Maya phone mapping must be byte-identical');

  // Patch Vaani hours / escalation.
  phoneConfig.patchPhoneConfig(db, 't_a', VAANI_ID, {
    after_hours_action: 'escalate',
    escalation_target: 'Telugu human desk',
    working_hours: { timezone: 'Asia/Kolkata', mode: 'schedule', windows: [{ days: [1, 2, 3, 4, 5], start: '10:00', end: '18:00' }] },
  });
  assert.equal(snapshotMayaPhone(db), before);

  // Unassign Vaani.
  phoneConfig.unassignFromEmployee(db, { tenantId: 't_a', employeeId: VAANI_ID });
  assert.equal(snapshotMayaPhone(db), before);
  assert.equal(db.phoneNumbers.find((n) => n.id === phoneNumbers.PLATFORM_SEED_ID).assignedEmployeeId, MAYA_ID);
});

test('MAYA NUMBER locked to main line when assigned; VAANI UNASSIGNED or alt', () => {
  const db = emptyDb();
  seedMayaAndVaani(db);
  phoneConfig.assignToEmployee(db, {
    tenantId: 't_a', employeeId: MAYA_ID, numberId: phoneNumbers.PLATFORM_SEED_ID,
  });
  const maya = phoneConfig.publicPhoneConfig(db, db.employees.find((e) => e.id === MAYA_ID));
  assert.equal(maya.businessNumber, phoneConfig.MAYA_PROTECTED_E164);
  assert.ok(['Connected', 'Inbound + Outbound'].includes(maya.connectionState));

  const vaani = phoneConfig.publicPhoneConfig(db, db.employees.find((e) => e.id === VAANI_ID));
  assert.equal(vaani.connectionState, 'Unassigned');
});

test('RESTART PERSISTENCE: phoneConfig survives JSON reload simulation', () => {
  const db = emptyDb();
  seedMayaAndVaani(db);
  phoneConfig.assignToEmployee(db, {
    tenantId: 't_a', employeeId: MAYA_ID, numberId: phoneNumbers.PLATFORM_SEED_ID,
  });
  phoneConfig.patchPhoneConfig(db, 't_a', MAYA_ID, {
    after_hours_action: 'voicemail',
    escalation_target: 'Front desk',
  });

  const snap = phoneConfig.simulateReloadPersistence(db);
  // Wipe live state then reapply snapshot (simulates process restart + db.json load).
  db.employees = [];
  db.phoneNumbers = [];
  phoneConfig.applyReloadedState(db, snap);

  const emp = db.employees.find((e) => e.id === MAYA_ID);
  assert.ok(emp);
  assert.equal(emp.phoneNumberId, phoneNumbers.PLATFORM_SEED_ID);
  assert.equal(emp.phoneConfig.assigned_phone_number, '+918065353938');
  assert.equal(emp.phoneConfig.workflow_id, 'wf_maya');
  assert.equal(emp.phoneConfig.escalation_target, 'Front desk');
  assert.ok(emp.phoneConfig.answer_url);
  assert.ok(emp.phoneConfig.hangup_callback);

  const number = db.phoneNumbers.find((n) => n.id === phoneNumbers.PLATFORM_SEED_ID);
  assert.equal(number.assignedEmployeeId, MAYA_ID);
  assert.equal(number.status, 'assigned');
  assert.ok(number.answerUrl);
  assert.ok(number.hangupCallback);
});

test('connection states: Unassigned / Connected / Inbound only / Outbound only / Needs attention', () => {
  const db = emptyDb();
  seedMayaAndVaani(db);
  const emp = db.employees.find((e) => e.id === MAYA_ID);
  assert.equal(phoneConfig.publicPhoneConfig(db, emp).connectionState, 'Unassigned');

  phoneConfig.assignToEmployee(db, {
    tenantId: 't_a', employeeId: MAYA_ID, numberId: phoneNumbers.PLATFORM_SEED_ID,
  });
  emp.phoneConfig.telephonySyncOk = true;
  emp.phoneConfig.callbackVerifyOk = true;
  assert.equal(phoneConfig.publicPhoneConfig(db, emp).connectionState, 'Connected');

  phoneConfig.patchPhoneConfig(db, 't_a', MAYA_ID, { direction: 'inbound' });
  assert.equal(phoneConfig.publicPhoneConfig(db, emp).connectionState, 'Inbound only');

  phoneConfig.patchPhoneConfig(db, 't_a', MAYA_ID, { direction: 'outbound' });
  assert.equal(phoneConfig.publicPhoneConfig(db, emp).connectionState, 'Outbound only');

  phoneConfig.patchPhoneConfig(db, 't_a', MAYA_ID, {
    direction: 'both',
    answer_url: '',
  });
  // Missing answer_url → needs attention once assigned.
  const needs = phoneConfig.publicPhoneConfig(db, emp);
  assert.ok(needs.connectionState === 'Needs attention' || needs.callbackVerifyOk === false);
});

test('publicEmployee includes phoneConfig without provider brand leak', () => {
  const db = emptyDb();
  seedMayaAndVaani(db);
  phoneConfig.assignToEmployee(db, {
    tenantId: 't_a', employeeId: MAYA_ID, numberId: phoneNumbers.PLATFORM_SEED_ID,
  });
  const pub = employees.publicEmployee(db.employees.find((e) => e.id === MAYA_ID), db);
  assert.ok(pub.phoneConfig);
  assert.equal(pub.phoneConfig.businessNumber, '+918065353938');
  assert.equal(pub.phoneConfig.workflowName, 'Maya Receptionist');
  const blob = JSON.stringify(pub).toLowerCase();
  assert.equal(blob.includes('dograh'), false);
  assert.equal(blob.includes('vobiz'), false);
});

test('core migrateDb v15 seeds phoneConfig on employees', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'astra-phone-'));
  const dbFile = path.join(tmp, 'db.json');
  process.env.RAPIDX_DB_FILE = dbFile;
  delete require.cache[require.resolve('../lib/core')];
  const core = require('../lib/core');
  const migrated = core.migrateDb({
    schemaVersion: 14,
    employees: [{
      id: 'emp_x', tenantId: 't_a', name: 'X', phoneNumberId: null, workflowId: 'wf_1',
      outcomes: [], knowledgeIds: [], actions: [],
    }],
    phoneNumbers: [{
      id: 'pn_1', e164: '+911111111111', status: 'available',
    }],
  });
  assert.ok(migrated.schemaVersion >= 15);
  assert.ok(migrated.employees[0].phoneConfig);
  assert.equal(migrated.employees[0].phoneConfig.direction, 'none');
  assert.equal(migrated.phoneNumbers[0].answerUrl, null);
  assert.equal(migrated.phoneNumbers[0].hangupCallback, null);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  delete process.env.RAPIDX_DB_FILE;
});
