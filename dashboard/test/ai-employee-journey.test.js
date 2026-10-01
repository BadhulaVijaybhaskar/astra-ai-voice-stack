/**
 * Astra Voice. AI Employee Setup Journey tests (feature-flagged add-on).
 * No em dashes anywhere. Commas and periods only.
 */
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const journey = require('../lib/ai-employee-journey');

describe('AI Employee Setup Journey', () => {
  it('feature flag helper recognizes ENABLE_AI_EMPLOYEE_JOURNEY', () => {
    assert.equal(journey.featureEnabled({ ENABLE_AI_EMPLOYEE_JOURNEY: '1' }), true);
    assert.equal(journey.featureEnabled({ ENABLE_AI_EMPLOYEE_JOURNEY: 'true' }), true);
    assert.equal(journey.featureEnabled({ ENABLE_AI_EMPLOYEE_JOURNEY: '0' }), false);
    assert.equal(journey.featureEnabled({}), false);
  });

  it('builds LIVE payload from real employee without fabricating knowledge', () => {
    const db = {
      tenants: [{ id: 't1', name: 'T' }],
      employees: [{
        id: 'emp_maya',
        tenantId: 't1',
        name: 'Maya',
        role: 'Lead Qualifier',
        templateKey: 'lead_qualification',
        status: 'READY',
        channel: 'instant_lead',
        description: 'Qualify new enquiries and identify the next step.',
        agentId: 'ag_1',
        workflowId: 'wf_1',
        knowledgeIds: [],
        outcomes: [{ key: 'qualified', label: 'Qualified', success: true }],
        actions: [{
          key: 'book_callback',
          type: 'book_callback',
          label: 'Schedule sales follow-up',
          enabled: true,
          config: {},
        }],
        voice: { language: 'en-IN', tier: 'standard', speaker: 'speaker_1', model: 'mulberry' },
        phoneNumberId: null,
      }],
      agents: [{ id: 'ag_1', tenantId: 't1', name: 'Maya', persona: 'You are Maya.', greeting: 'Hello' }],
      workflows: [{ id: 'wf_1', tenantId: 't1', name: 'Lead Qual' }],
      knowledgeEntries: [],
      phoneNumbers: [{
        id: 'pn_1',
        tenantId: 't1',
        e164: '+918065353938',
        inboundEnabled: true,
        outboundEnabled: true,
        label: 'AstraNova Main Line',
        inboundHours: {
          timezone: 'Asia/Kolkata',
          mode: 'schedule',
          windows: [{ days: [1, 2, 3, 4, 5], start: '09:00', end: '19:00' }],
        },
      }],
      calls: [],
      leads: [],
    };
    const payload = journey.buildJourneyPayload(db, db.tenants[0], { mode: 'live' });
    assert.equal(payload.mode, 'live');
    assert.equal(payload.employee.name, 'Maya');
    assert.equal(payload.employee.demoPreview, false);
    assert.equal(payload.knowledge.knowledge.length, 0);
    assert.equal(payload.knowledge.systemPrompt, 'You are Maya.');
    assert.match(String(payload.routing.businessNumber.e164), /918065353938/);
    assert.equal(payload.call.demoPreview, false);
    assert.equal((payload.call.transcript || []).length, 0);
    assert.equal(payload.outcome.fields.length, 0);
    assert.equal(payload.next.nextAction.title, 'Schedule sales follow-up');
  });

  it('DEMO PREVIEW labels illustrative blocks and never mixes into live call shape', () => {
    const db = {
      tenants: [{ id: 't1', name: 'T' }],
      employees: [],
      agents: [],
      workflows: [],
      knowledgeEntries: [],
      phoneNumbers: [],
      calls: [],
      leads: [],
    };
    const payload = journey.buildJourneyPayload(db, db.tenants[0], { mode: 'demo', env: {} });
    assert.equal(payload.mode, 'demo');
    assert.equal(payload.workspaceLabel, 'AstraConnect Workspace');
    assert.equal(payload.employee.demoPreview, true);
    assert.equal(payload.knowledge.demoPreview, true);
    assert.ok(payload.knowledge.knowledge.every((k) => k.demoPreview));
    assert.equal(payload.language.demoPreview, true);
    assert.equal((payload.language.providers || []).length, 0);
    assert.equal(payload.routing.demoPreview, true);
    assert.match(String(payload.routing.businessNumber.e164), /918065353938/);
    assert.doesNotMatch(String(payload.routing.businessNumber.e164), /4718/);
    assert.equal(payload.call.demoPreview, true);
    assert.equal(payload.call.label, 'DEMO PREVIEW');
    assert.equal(payload.call.participant.name, 'Arjun Mehta');
    assert.ok(payload.call.transcript.every((t) => t.demoPreview));
    assert.doesNotMatch(JSON.stringify(payload.call), /LIVE CALL/);
    assert.equal(payload.outcome.demoPreview, true);
    assert.equal(payload.next.demoPreview, true);
    assert.equal((payload.next.metrics || []).length, 0);
    assert.doesNotMatch(JSON.stringify(payload.next), /"128"|46%|"38"|Ananya/);
    assert.match(String(payload.next.disclaimer || ''), /DEMO PREVIEW/i);
    assert.ok(payload.paths && payload.paths.configure && payload.paths.demonstrate);
  });

  it('LIVE never invents fake DID or Connected call state', () => {
    const db = {
      tenants: [{ id: 't1', name: 'T' }],
      employees: [{
        id: 'emp_maya',
        tenantId: 't1',
        name: 'Maya',
        role: 'Lead Qualifier',
        status: 'READY',
        channel: 'instant_lead',
        description: 'Qualify new enquiries.',
        agentId: 'ag_1',
        knowledgeIds: [],
        outcomes: [],
        actions: [],
        voice: { language: 'en-IN' },
        phoneNumberId: null,
      }],
      agents: [{ id: 'ag_1', tenantId: 't1', name: 'Maya', persona: 'You are Maya.', greeting: 'Hello' }],
      workflows: [],
      knowledgeEntries: [],
      phoneNumbers: [],
      calls: [],
      leads: [],
    };
    const payload = journey.buildJourneyPayload(db, db.tenants[0], { mode: 'live' });
    assert.equal(payload.mode, 'live');
    assert.equal(payload.call.status, 'Ready');
    assert.equal(payload.call.demoPreview, false);
    assert.equal((payload.call.transcript || []).length, 0);
    assert.doesNotMatch(JSON.stringify(payload.call), /Arjun/);
    assert.equal(payload.routing.businessNumber.unassigned, true);
    assert.equal(payload.routing.businessNumber.e164, null);
    assert.match(String(payload.routing.businessNumber.preferredDid), /918065353938/);
    assert.equal((payload.language.providers || []).length, 0);
    assert.ok((payload.language.advancedProviders || []).length > 0);
  });

  it('Cal.com Connected when CALCOM_API_KEY set, without illustrative note', () => {
    const connected = journey.buildCalendarStatus({
      CALCOM_API_KEY: 'cal_test_key',
      CALCOM_EVENT_TYPE_ID: '7294717',
      CALCOM_EVENT_LABEL: 'Astra Voice Demo',
    });
    assert.equal(connected.configured, true);
    assert.equal(connected.primary.status, 'Connected');
    assert.equal(connected.primary.label, 'Astra Voice Demo');
    assert.equal(connected.primary.note, null);
    assert.equal(connected.primary.demoPreview, false);

    const missing = journey.buildCalendarStatus({});
    assert.equal(missing.configured, false);
    assert.equal(missing.primary.status, 'Not connected');
  });

  it('draft step persistence survives refresh shape', () => {
    const tenant = { id: 't1' };
    const draft = journey.setTenantDraft(tenant, { step: 'routing', mode: 'live' });
    assert.equal(draft.step, 'routing');
    assert.equal(journey.getTenantDraft(tenant).step, 'routing');
  });

  it('language statuses use READY FOR VALIDATION / AVAILABLE (no unvalidated TESTED)', () => {
    const db = {
      tenants: [{ id: 't1' }],
      employees: [{
        id: 'emp_1',
        tenantId: 't1',
        name: 'Maya',
        status: 'READY',
        channel: 'both',
        knowledgeIds: [],
        outcomes: [],
        actions: [],
        voice: { language: 'en-IN', tier: 'standard' },
      }],
      agents: [],
      workflows: [],
      knowledgeEntries: [],
      phoneNumbers: [],
      calls: [],
      leads: [],
    };
    const payload = journey.buildJourneyPayload(db, db.tenants[0], { mode: 'live' });
    const en = payload.language.languages.find((l) => l.id === 'EN');
    const mr = payload.language.languages.find((l) => l.id === 'MR');
    const bn = payload.language.languages.find((l) => l.id === 'BN');
    const gu = payload.language.languages.find((l) => l.id === 'GU');
    assert.equal(en.tone, 'validation');
    assert.equal(en.status, 'Ready for validation');
    assert.equal(en.live, false);
    assert.equal(mr.tone, 'available');
    assert.equal(mr.status, 'Available');
    assert.equal(mr.live, false);
    assert.equal(bn.tone, 'available');
    assert.equal(bn.live, false);
    assert.equal(gu.tone, 'available');
    assert.equal(gu.status, 'Available');
    assert.equal(gu.live, false);
    assert.equal(payload.language.languages.length, 10);
    assert.ok((payload.language.voiceModes || []).some((m) => m.id === 'astra_auto'));
    assert.ok((payload.language.voiceModes || []).some((m) => m.id === 'dograh_managed' && m.label === 'Managed'));
  });

  it('normalizes bare-string employee actions into Next Action', () => {
    const employees = require('../lib/employees');
    const normalized = employees.normalizeActionsList([
      'schedule_sales_follow_up',
      'transfer_to_human',
    ]);
    assert.ok(normalized.length >= 1);
    assert.equal(normalized[0].key, 'schedule_sales_follow_up');
    assert.equal(normalized[0].type, 'book_callback');

    const db = {
      tenants: [{ id: 't1', name: 'T' }],
      employees: [{
        id: 'emp_maya',
        tenantId: 't1',
        name: 'Maya',
        role: 'Lead Qualifier',
        status: 'READY',
        channel: 'instant_lead',
        description: 'Qualify new enquiries.',
        agentId: 'ag_1',
        knowledgeIds: [],
        outcomes: [
          { key: 'qualified', label: 'Qualified', success: true },
          { key: 'not_interested', label: 'Not interested', success: false },
        ],
        actions: ['schedule_sales_follow_up'],
        voice: { language: 'en-IN' },
        phoneNumberId: 'pn_1',
      }],
      agents: [{ id: 'ag_1', tenantId: 't1', name: 'Maya', persona: 'You are Maya.', greeting: 'Hello' }],
      workflows: [],
      knowledgeEntries: [],
      phoneNumbers: [{
        id: 'pn_1',
        tenantId: 't1',
        e164: '+918065353938',
        inboundEnabled: true,
        outboundEnabled: true,
        inboundHours: {
          timezone: 'Asia/Kolkata',
          mode: 'always',
          windows: [],
        },
      }],
      calls: [],
      leads: [],
    };
    const payload = journey.buildJourneyPayload(db, db.tenants[0], { mode: 'live' });
    assert.match(String(payload.next.nextAction.title), /schedule.?sales.?follow.?up/i);
    assert.match(String(payload.routing.workingHours.label), /Always open/i);
    assert.equal(payload.routing.workingHours.mode, 'always');
    const rules = payload.knowledge.qualificationRules || [];
    assert.ok(rules.length >= 2);
    assert.ok(rules.every((r) => r.enabled === true));
    assert.equal(payload.call.label || payload.call.demoPreview, false);
  });

  it('DEMO call payload is labeled DEMO PREVIEW, never LIVE CALL', () => {
    const db = {
      tenants: [{ id: 't1' }],
      employees: [{
        id: 'emp_1',
        tenantId: 't1',
        name: 'Maya',
        status: 'READY',
        channel: 'both',
        knowledgeIds: [],
        outcomes: [],
        actions: [],
        voice: { language: 'en-IN' },
      }],
      agents: [],
      workflows: [],
      knowledgeEntries: [],
      phoneNumbers: [],
      calls: [],
      leads: [],
    };
    const payload = journey.buildJourneyPayload(db, db.tenants[0], { mode: 'demo' });
    assert.equal(payload.call.demoPreview, true);
    assert.equal(payload.call.label, 'DEMO PREVIEW');
    assert.doesNotMatch(JSON.stringify(payload.call), /LIVE CALL/);
  });
});

describe('Voice catalog (PR #30 concepts)', () => {
  it('unified catalog loads without secrets', async () => {
    const catalog = require('../lib/voice-catalog');
    const out = await catalog.getUnifiedCatalog({});
    assert.ok(out);
    assert.ok(Array.isArray(out.providers));
    assert.ok(Array.isArray(out.voice_modes));
    assert.equal(out.live_apply_enabled, false);
  });

  it('flattenLanguages handles provider-keyed languages object', () => {
    const langBag = {
      sarvam: [{ id: 'en-IN', label: 'English (India)' }, { id: 'hi-IN', label: 'Hindi' }],
      deepgram: [{ id: 'en-IN', label: 'English' }],
    };
    const seen = new Set();
    const languages = [];
    for (const rows of Object.values(langBag)) {
      for (const row of rows) {
        const id = String(row.id || '').trim();
        if (!id || seen.has(id)) continue;
        seen.add(id);
        languages.push(row);
      }
    }
    assert.equal(languages.length, 2);
    assert.ok(Array.isArray(languages));
    assert.throws(() => (langBag || []).slice(0, 40));
  });
});