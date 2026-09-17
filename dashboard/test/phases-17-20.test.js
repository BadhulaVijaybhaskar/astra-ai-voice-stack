'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const core = require('../lib/core');
const phoneNumbers = require('../lib/phone-numbers');
const employees = require('../lib/employees');
const plans = require('../lib/plans');

function baseDb() {
  return {
    schemaVersion: 13,
    tenants: [{ id: 't_a', name: 'A', status: 'active', plan: 'starter' }],
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
  if (!Number.isInteger(amountPaise) || wallet.balancePaise + amountPaise < 0) throw new Error('invalid wallet adjustment');
  wallet.balancePaise += amountPaise;
  wallet.updatedAt = now;
  const entry = {
    id: 'led_' + d.ledger.length, tenantId, type, amountPaise,
    balanceAfterPaise: wallet.balancePaise, idempotencyKey: key, actorUserId, metadata, createdAt: now,
  };
  d.ledger.push(entry);
  return entry;
}

test('schema v13 migrates inbound config, actions, language, plan entitlements', () => {
  const migrated = core.migrateDb({
    schemaVersion: 12,
    tenants: [{ id: 't_a', name: 'A', plan: 'growth' }],
    phoneNumbers: [{
      id: 'pn_1', tenantId: 't_a', status: 'assigned', assignedAgentId: 'ag_1', e164: '+918011111111',
    }],
    agents: [{ id: 'ag_1', tenantId: 't_a', name: 'Desk' }],
    employees: [{
      id: 'emp_1', tenantId: 't_a', name: 'Ria', agentId: 'ag_1', phoneNumberId: 'pn_1',
      outcomes: [], knowledgeIds: [], status: 'LIVE',
      voice: { language: 'hindi', model: 'mulberry', speaker: 'speaker_1' },
    }],
  });
  assert.equal(migrated.schemaVersion, 13);
  assert.equal(migrated.phoneNumbers[0].inboundGreeting, null);
  assert.equal(migrated.phoneNumbers[0].inboundHours.timezone, 'Asia/Kolkata');
  assert.equal(migrated.phoneNumbers[0].inboundHours.mode, 'always');
  assert.deepEqual(migrated.employees[0].actions, []);
  assert.equal(migrated.employees[0].voice.language, 'hi-IN');
  assert.equal(migrated.tenants[0].includedNumbers, 3);
  assert.equal(migrated.tenants[0].includedEmployees, 10);
  assert.equal(migrated.tenants[0].includedMinutes, 1000);
});

test('Phase 17: inbound config on Phone Number syncs greeting to Employee agent', () => {
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

  const got = phoneNumbers.getInboundConfig(db, 't_a', phoneNumbers.PLATFORM_SEED_ID);
  assert.equal(got.ok, true);
  assert.equal(got.inbound.answer, true);
  assert.equal(got.inbound.employeeId, emp.employee.id);
  assert.equal(got.inbound.greeting, 'Hello from Desk');
  assert.equal(got.inbound.hours.mode, 'always');
  assert.equal(JSON.stringify(got.inbound).includes('dograh'), false);
  assert.equal(JSON.stringify(got.inbound).includes('SIP'), false);

  const set = phoneNumbers.setInboundConfig(db, 't_a', phoneNumbers.PLATFORM_SEED_ID, {
    answer: true,
    greeting: 'Namaste, AstraNova speaking.',
    hours: { timezone: 'Asia/Kolkata', mode: 'schedule', windows: [{ days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00' }] },
  });
  assert.equal(set.ok, true);
  assert.equal(set.inbound.greeting, 'Namaste, AstraNova speaking.');
  assert.equal(set.inbound.hours.mode, 'schedule');
  assert.equal(db.agents[0].greeting, 'Namaste, AstraNova speaking.');
  assert.equal(db.phoneNumbers.find((n) => n.id === phoneNumbers.PLATFORM_SEED_ID).inboundEnabled, true);

  const denied = phoneNumbers.getInboundConfig(db, 't_b', phoneNumbers.PLATFORM_SEED_ID);
  assert.equal(denied.ok, false);
  assert.equal(denied.code, 'forbidden');

  const pub = phoneNumbers.publicPhoneNumber(
    assigned.number,
    new Map([['ag_1', db.agents[0]]]),
    new Map(),
    new Map([[emp.employee.id, emp.employee]]),
  );
  assert.ok(pub.inbound);
  assert.equal(pub.inbound.answer, true);
  assert.equal(JSON.stringify(pub).includes('providerMetadata'), false);
});

test('Phase 18: India languages catalog and Employee language wire-up', () => {
  const langs = employees.listSupportedLanguages();
  assert.deepEqual(langs.map((l) => l.id), ['en-IN', 'hi-IN', 'te-IN', 'ta-IN']);
  assert.ok(langs.every((l) => l.label && !/deepgram|rumik|sarvam|eleven/i.test(l.label)));

  const db = baseDb();
  const emp = employees.createEmployee(db, 't_a', {
    name: 'Ria',
    templateKey: 'receptionist',
    compose: false,
    agentId: 'ag_1',
    voice: { language: 'en-IN' },
  }, 'u_1');
  assert.equal(emp.ok, true);
  assert.equal(emp.employee.voice.language, 'en-IN');

  const hi = employees.setEmployeeLanguage(db, 't_a', emp.employee.id, 'hi-IN');
  assert.equal(hi.ok, true);
  assert.equal(hi.language, 'hi-IN');
  const pub = employees.publicEmployee(emp.employee, db);
  assert.equal(pub.language, 'hi-IN');
  assert.equal(pub.voice.language, 'hi-IN');

  const te = employees.setEmployeeLanguage(db, 't_a', emp.employee.id, 'telugu');
  assert.equal(te.ok, true);
  assert.equal(te.language, 'te-IN');

  const bad = employees.setEmployeeLanguage(db, 't_a', emp.employee.id, 'fr-FR');
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'unsupported_language');
  assert.equal(bad.supported.length, 4);

  const cross = employees.setEmployeeLanguage(db, 't_b', emp.employee.id, 'hi-IN');
  assert.equal(cross.ok, false);
  assert.equal(cross.code, 'not_found');
});

test('Phase 19: Actions persist, Studio foundation, no live CRM execution', () => {
  const db = baseDb();
  const emp = employees.createEmployee(db, 't_a', {
    name: 'Ria',
    templateKey: 'receptionist',
    compose: false,
    agentId: 'ag_1',
    outcomes: [{ key: 'qualified', label: 'Qualified', success: true }],
  }, 'u_1');
  assert.equal(emp.ok, true);

  const types = employees.listActionTypes().map((t) => t.type);
  assert.ok(types.includes('book_callback'));
  assert.ok(types.includes('tag_outcome'));
  assert.ok(types.includes('transfer_to_human'));
  assert.ok(types.includes('crm_webhook'));

  const set = employees.setActions(db, 't_a', emp.employee.id, [
    { type: 'book_callback', label: 'Book callback' },
    { type: 'tag_outcome', label: 'Tag qualified', config: { outcomeKey: 'qualified' } },
    { type: 'transfer_to_human', label: 'Transfer', config: { target: 'front_desk' } },
    { type: 'crm_webhook', label: 'CRM', config: { webhookUrl: 'https://example.com/hook' } },
  ]);
  assert.equal(set.ok, true);
  assert.equal(set.actions.count, 4);
  assert.equal(set.actions.executionAvailable, false);
  assert.deepEqual(set.actions.executions, []);
  const crm = set.actions.definitions.find((d) => d.type === 'crm_webhook');
  assert.equal(crm.config.webhookUrl, 'https://example.com/hook');
  assert.equal(JSON.stringify(set.actions).includes('dograh'), false);

  const hook = employees.executeActionHook(db, 't_a', emp.employee.id, { key: 'tag_outcome' });
  assert.equal(hook.ok, true);
  assert.equal(hook.execution.status, 'queued_foundation');
  assert.equal(hook.execution.executionAvailable, false);
  assert.equal(hook.execution.outcomeApplied, 'qualified');
  assert.match(hook.execution.message, /foundation/i);

  const missing = employees.executeActionHook(db, 't_a', emp.employee.id, { key: 'nope' });
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 'action_not_found');

  const pub = employees.publicEmployee(emp.employee, db);
  assert.equal(pub.actions.length, 4);
});

test('Phase 20: plan entitlements + honest empty wallet + test credit grant', () => {
  const catalog = plans.listPlans();
  assert.equal(plans.publicPlan('starter').includedEmployees, 2);
  assert.equal(plans.publicPlan('growth').includedMinutes, 1000);
  assert.equal(plans.publicPlan('scale').includedNumbers, 10);
  assert.ok(catalog.every((p) => p.includedEmployees > 0 && p.includedMinutes > 0));

  const db = baseDb();
  const entEmpty = plans.publicEntitlements(db, db.tenants[0]);
  assert.equal(entEmpty.used.numbers, 0);
  assert.equal(entEmpty.used.employees, 0);
  assert.equal(entEmpty.used.minutes, 0);
  assert.equal(entEmpty.credits.balancePaise, 0);
  assert.equal(entEmpty.included.employees, 2);

  phoneNumbers.seedPlatformInventory(db);
  const emp = employees.createEmployee(db, 't_a', {
    name: 'Ria', templateKey: 'receptionist', compose: false, agentId: 'ag_1',
  }, 'u_1');
  phoneNumbers.assignNumber(db, {
    numberId: phoneNumbers.PLATFORM_SEED_ID,
    tenantId: 't_a',
    employeeId: emp.employee.id,
  });
  db.calls.push({
    tenantId: 't_a', agentId: 'ag_1', durationSec: 125, status: 'completed',
  });
  db.calls.push({
    tenantId: 't_b', agentId: 'ag_x', durationSec: 999, status: 'completed',
  });

  const ent = plans.publicEntitlements(db, db.tenants[0]);
  assert.equal(ent.used.numbers, 1);
  assert.equal(ent.used.employees, 1);
  assert.equal(ent.used.minutes, 2); // floor(125/60)
  assert.equal(JSON.stringify(ent).includes('t_b'), false);
  assert.equal(JSON.stringify(ent).includes('invoice'), false);

  const grant = plans.grantTestCredits(db, 't_a', 5000, 'admin_1', 'test:abc', 'qa credits', addLedgerEntry);
  assert.equal(grant.ok, true);
  assert.equal(grant.duplicate, false);
  assert.equal(db.wallets[0].balancePaise, 5000);
  const again = plans.grantTestCredits(db, 't_a', 5000, 'admin_1', 'test:abc', 'qa credits', addLedgerEntry);
  assert.equal(again.duplicate, true);
  assert.equal(db.wallets[0].balancePaise, 5000);

  const plan = plans.publicPlan('growth');
  assert.ok(plan.entitlements);
  assert.equal(plan.entitlements.employees, 10);
});
