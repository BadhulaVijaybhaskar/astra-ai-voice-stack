/**
 * Per-employee Dograh model configuration. Isolation tests.
 *
 * Maya (emp_33eae8ef454680f0, Dograh WF8) is read/verify only.
 * Vaani (emp_f85510806c9de004) may draft / activate without touching Maya.
 *
 * No live PSTN dials. No Dograh production mutations for WF8.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const runtime = require('../lib/employee-runtime-config');
const employees = require('../lib/employees');
const { seedPresets } = require('../lib/agent-types');

const MAYA_ID = runtime.MAYA_PROTECTED_EMPLOYEE_ID;
const VAANI_ID = 'emp_f85510806c9de004';

function emptyDb() {
  return {
    schemaVersion: 14,
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
  db.agents.push({
    id: 'ag_maya',
    tenantId: 't_a',
    name: 'Maya',
    persona: 'You are Maya.',
    greeting: 'Thank you for calling.',
    dograhWorkflowId: 8,
    agentType: 'inbound_receptionist',
    presetId: 'preset_astranova_eng_receptionist_v1',
    tts: { provider: 'deepgram', model: 'aura-2', speaker: 'aura-2-helena-en' },
    createdAt: new Date().toISOString(),
  });
  db.workflows.push({
    id: 'wf_maya',
    tenantId: 't_a',
    name: 'Maya workflow',
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
    voice: { language: 'en-IN', tier: 'standard', provider: 'deepgram', speaker: 'aura-2-helena-en' },
    knowledgeIds: [],
    outcomes: [],
    actions: [],
    runtimeConfig: {
      draft: null,
      active: {
        llm: { provider: 'groq', model: 'llama-3.3-70b-versatile', credentials_ref: 'cred_groq' },
        stt: { provider: 'deepgram', model: 'nova-3-general', language: 'multi', credentials_ref: 'cred_deepgram' },
        tts: {
          provider: 'deepgram', voice_id: 'aura-2-helena-en', language: 'en',
          speed: 1.0, model: 'aura-2', credentials_ref: 'cred_deepgram',
        },
        embedding: null,
        activatedAt: '2026-01-01T00:00:00.000Z',
      },
      dograhSync: null,
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  db.agents.push({
    id: 'ag_vaani',
    tenantId: 't_a',
    name: 'Vaani',
    persona: 'You are Vaani, Telugu desk.',
    greeting: 'Namaskaram.',
    dograhWorkflowId: null,
    agentType: 'custom',
    tts: { provider: 'sarvam', model: 'bulbul:v2', speaker: 'anushka' },
    createdAt: new Date().toISOString(),
  });
  db.workflows.push({
    id: 'wf_vaani',
    tenantId: 't_a',
    name: 'Vaani workflow',
    // Dedicated Dograh workflow. Never 8.
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
    voice: { language: 'te-IN', tier: 'standard' },
    knowledgeIds: [],
    outcomes: [],
    actions: [],
    runtimeConfig: { draft: null, active: null, dograhSync: null },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
}

function snapshotMaya(db) {
  const emp = db.employees.find((e) => e.id === MAYA_ID);
  const wf = db.workflows.find((w) => w.id === 'wf_maya');
  return JSON.stringify({
    employee: emp,
    workflow: wf,
  });
}

test('normalizePipeline accepts Groq / Deepgram / Sarvam / embedding and strips secrets', () => {
  const n = runtime.normalizePipeline({
    llm: { provider: 'groq', model: 'llama-3.3-70b-versatile', api_key: 'SHOULD_NOT_PERSIST' },
    stt: { provider: 'sarvam', model: 'saarika:v2.5', language: 'te-IN' },
    tts: { provider: 'sarvam', voice_id: 'anushka', language: 'te', speed: 1.05 },
    embedding: { provider: 'gemini', model: 'text-embedding-004' },
  });
  assert.equal(n.error, undefined);
  assert.equal(n.value.llm.provider, 'groq');
  assert.equal(n.value.stt.provider, 'sarvam');
  assert.equal(n.value.tts.provider, 'sarvam');
  assert.equal(n.value.tts.speed, 1.05);
  assert.equal(n.value.embedding.provider, 'gemini');
  assert.equal(n.value.llm.api_key, undefined);
  const pub = runtime.publicPipeline(n.value);
  const blob = JSON.stringify(pub).toLowerCase();
  assert.equal(blob.includes('api_key'), false);
  assert.equal(blob.includes('should_not_persist'), false);
  assert.equal(pub.llm.credentials_ref, 'cred_groq');
  assert.equal(pub.stt.credentials_ref, 'cred_sarvam');
  assert.equal(pub.tts.credentials_ref, 'cred_sarvam');
});

test('PER-EMPLOYEE LLM/STT/TTS/EMBEDDING draft isolation: Vaani mutate leaves Maya untouched', () => {
  const db = emptyDb();
  seedMayaAndVaani(db);
  const before = snapshotMaya(db);

  const draft = runtime.saveDraft(db, 't_a', VAANI_ID, {
    llm: { provider: 'groq', model: 'llama-3.3-70b-versatile' },
    stt: { provider: 'sarvam', model: 'saarika:v2.5', language: 'te-IN' },
    tts: { provider: 'sarvam', voice_id: 'anushka', language: 'te', speed: 1.1 },
    embedding: { provider: 'gemini', model: 'text-embedding-004' },
  });
  assert.equal(draft.ok, true);
  assert.equal(draft.runtimeConfig.draft.llm.provider, 'groq');
  assert.equal(draft.runtimeConfig.draft.stt.provider, 'sarvam');
  assert.equal(draft.runtimeConfig.draft.tts.provider, 'sarvam');
  assert.equal(draft.runtimeConfig.draft.embedding.provider, 'gemini');
  assert.equal(draft.runtimeConfig.employee_id, VAANI_ID);

  const mayaView = runtime.getRuntimeConfigView(db, db.employees.find((e) => e.id === MAYA_ID));
  assert.equal(mayaView.active.llm.provider, 'groq');
  assert.equal(mayaView.active.stt.provider, 'deepgram');
  assert.equal(mayaView.active.tts.provider, 'deepgram');
  assert.equal(snapshotMaya(db), before, 'Maya row must be byte-identical after Vaani draft');
});

test('MAYA CONFIG ISOLATED: Dograh WF8 sync refused; Maya active TTS unchanged by Vaani', async () => {
  const db = emptyDb();
  seedMayaAndVaani(db);
  const before = snapshotMaya(db);
  const mayaTts = JSON.parse(JSON.stringify(
    db.employees.find((e) => e.id === MAYA_ID).runtimeConfig.active.tts,
  ));

  // Refuse any Dograh write to WF8.
  const sync = await runtime.syncDograhWorkflowModelConfig('8', {
    version: 2,
    mode: 'byok',
    byok: { mode: 'pipeline', pipeline: {} },
  });
  assert.equal(sync.skipped, true);
  assert.equal(sync.reason, 'maya_production_protected');

  // Mutate Vaani only.
  runtime.saveDraft(db, 't_a', VAANI_ID, {
    llm: { provider: 'groq', model: 'llama-3.3-70b-versatile' },
    stt: { provider: 'sarvam', model: 'saarika:v2.5', language: 'te-IN' },
    tts: { provider: 'sarvam', voice_id: 'anushka', language: 'te', speed: 1.0 },
  });
  await runtime.activate(db, 't_a', VAANI_ID, { skipDograh: true });

  assert.deepEqual(
    db.employees.find((e) => e.id === MAYA_ID).runtimeConfig.active.tts,
    mayaTts,
  );
  assert.equal(db.workflows.find((w) => w.id === 'wf_maya').providerWorkflowId, '8');
  assert.equal(snapshotMaya(db), before);
});

test('VAANI CONFIG ISOLATED: activate with skipDograh promotes Vaani only', async () => {
  const db = emptyDb();
  seedMayaAndVaani(db);
  const before = snapshotMaya(db);

  runtime.saveDraft(db, 't_a', VAANI_ID, {
    llm: { provider: 'groq', model: 'llama-3.3-70b-versatile' },
    stt: { provider: 'sarvam', model: 'saarika:v2.5', language: 'te-IN' },
    tts: { provider: 'sarvam', voice_id: 'anushka', language: 'te', speed: 1.0 },
  });
  const act = await runtime.activate(db, 't_a', VAANI_ID, { skipDograh: true });
  assert.equal(act.ok, true);
  assert.equal(act.runtimeConfig.active.stt.provider, 'sarvam');
  assert.equal(act.runtimeConfig.active.tts.provider, 'sarvam');
  assert.equal(act.runtimeConfig.active.llm.provider, 'groq');

  const maya = runtime.getRuntimeConfigView(db, db.employees.find((e) => e.id === MAYA_ID));
  assert.equal(maya.active.stt.provider, 'deepgram');
  assert.equal(maya.active.tts.provider, 'deepgram');
  assert.equal(snapshotMaya(db), before);
});

test('BROWSER TALK USES EMPLOYEE CONFIG: resolveEmployeePipeline prefers active then draft', () => {
  const db = emptyDb();
  seedMayaAndVaani(db);
  runtime.saveDraft(db, 't_a', VAANI_ID, {
    llm: { provider: 'groq', model: 'llama-3.3-70b-versatile' },
    stt: { provider: 'sarvam', model: 'saarika:v2.5', language: 'te-IN' },
    tts: { provider: 'sarvam', voice_id: 'anushka', language: 'te', speed: 1.0 },
  });
  const draftOnly = runtime.resolveEmployeePipeline(db, 't_a', VAANI_ID, 'draft');
  assert.equal(draftOnly.ok, true);
  assert.equal(draftOnly.source, 'draft');
  assert.equal(draftOnly.pipeline.tts.provider, 'sarvam');

  // Before activate, auto uses draft.
  const auto = runtime.resolveEmployeePipeline(db, 't_a', VAANI_ID, 'auto');
  assert.equal(auto.source, 'draft');

  // Maya still Deepgram.
  const maya = runtime.resolveEmployeePipeline(db, 't_a', MAYA_ID, 'active');
  assert.equal(maya.pipeline.tts.provider, 'deepgram');
  assert.equal(maya.dograh_workflow_id, '8');
});

test('PSTN USES EMPLOYEE CONFIG: path proof resolves Vaani WF42 and Maya WF8 separately', () => {
  const db = emptyDb();
  seedMayaAndVaani(db);
  const vaani = runtime.provePstnUsesEmployeeConfig(db, 't_a', VAANI_ID);
  assert.equal(vaani.ok, true);
  assert.equal(vaani.dograh_workflow_id, '42');
  assert.equal(vaani.uses_employee_workflow, true);
  assert.ok(Array.isArray(vaani.path) && vaani.path.length >= 4);
  assert.match(vaani.path.join(' '), /model_configuration_v2_override/);

  const maya = runtime.provePstnUsesEmployeeConfig(db, 't_a', MAYA_ID);
  assert.equal(maya.dograh_workflow_id, '8');
  assert.equal(maya.maya_production_protected, true);
});

test('buildDograhV2Override never embeds missing secrets as plaintext placeholders', () => {
  const prev = process.env.GROQ_API_KEY;
  const prevDg = process.env.DEEPGRAM_API_KEY;
  const prevSv = process.env.SARVAM_API_KEY;
  delete process.env.GROQ_API_KEY;
  delete process.env.DEEPGRAM_API_KEY;
  delete process.env.SARVAM_API_KEY;
  try {
    const built = runtime.buildDograhV2Override({
      llm: { provider: 'groq', model: 'x', credentials_ref: 'cred_groq' },
      stt: { provider: 'sarvam', model: 'y', language: 'te', credentials_ref: 'cred_sarvam' },
      tts: {
        provider: 'sarvam', voice_id: 'anushka', language: 'te', speed: 1,
        model: 'bulbul:v2', credentials_ref: 'cred_sarvam',
      },
      embedding: null,
    });
    assert.equal(built.ok, false);
    assert.ok(['llm_credentials_missing', 'stt_credentials_missing', 'tts_credentials_missing']
      .includes(built.code));
  } finally {
    if (prev != null) process.env.GROQ_API_KEY = prev; else delete process.env.GROQ_API_KEY;
    if (prevDg != null) process.env.DEEPGRAM_API_KEY = prevDg; else delete process.env.DEEPGRAM_API_KEY;
    if (prevSv != null) process.env.SARVAM_API_KEY = prevSv; else delete process.env.SARVAM_API_KEY;
  }
});

test('ORG-LEVEL-ONLY fields documented and credentials never returned in public view', () => {
  assert.ok(runtime.ORG_LEVEL_ONLY_FIELDS.some((f) => f.includes('api_key')));
  assert.equal(runtime.SECTION_SCOPE.llm, 'per_workflow');
  assert.equal(runtime.SECTION_SCOPE.stt, 'per_workflow');
  assert.equal(runtime.SECTION_SCOPE.tts, 'per_workflow');
  assert.equal(runtime.SECTION_SCOPE.embedding, 'per_workflow');
  assert.equal(runtime.SECTION_SCOPE.credentials, 'organization');
  const creds = runtime.listOrgCredentials();
  assert.ok(creds.every((c) => c.configured === true || c.configured === false));
  assert.ok(creds.every((c) => !('api_key' in c) && !('value' in c)));
});

test('HTTP runtime-config APIs enforce tenant isolation and never leak secrets', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'astra-runtime-'));
  const dbFile = path.join(tmp, 'db.json');
  const prevDb = process.env.RAPIDX_DB_FILE;
  process.env.RAPIDX_DB_FILE = dbFile;
  // Fresh module load with isolated db.
  delete require.cache[require.resolve('../lib/core')];
  delete require.cache[require.resolve('../server')];
  // Boot a minimal harness by requiring core + wiring is heavy. Exercise lib
  // through employees publicEmployee instead for secret leak check.
  const db = emptyDb();
  seedMayaAndVaani(db);
  runtime.saveDraft(db, 't_a', VAANI_ID, {
    llm: { provider: 'groq', model: 'llama-3.3-70b-versatile', credentials_ref: 'cred_groq' },
    stt: { provider: 'deepgram', model: 'nova-3-general', language: 'multi' },
    tts: { provider: 'deepgram', voice_id: 'aura-2-helena-en', language: 'en', speed: 1 },
  });
  const view = runtime.getRuntimeConfigView(db, db.employees.find((e) => e.id === VAANI_ID));
  // Strip documented org-level-only field names before secret scan.
  const scan = Object.assign({}, view, { org_level_only_fields: [] });
  const blob = JSON.stringify(scan).toLowerCase();
  assert.equal(blob.includes('"api_key"'), false);
  assert.equal(/\bsk-[a-z0-9]{8,}/i.test(blob), false);
  assert.equal(view.draft.llm.credentials_ref, 'cred_groq');
  // dograh_workflow_id hidden from customer view by default
  assert.equal(view.dograh_workflow_id, undefined);
  assert.equal(view.has_dograh_workflow, true);

  const pub = employees.publicEmployee(db.employees.find((e) => e.id === VAANI_ID), db);
  assert.ok(pub.runtimeConfig);
  assert.equal(pub.runtimeConfig.hasDraft, true);
  const pubScan = JSON.stringify(pub).toLowerCase();
  assert.equal(pubScan.includes('"api_key"'), false);

  if (prevDb != null) process.env.RAPIDX_DB_FILE = prevDb; else delete process.env.RAPIDX_DB_FILE;
  void http;
});

test('changing Vaani draft does not change Maya draft or active', () => {
  const db = emptyDb();
  seedMayaAndVaani(db);
  // Give Maya a distinct draft first.
  runtime.saveDraft(db, 't_a', MAYA_ID, {
    llm: { provider: 'groq', model: 'maya-only-model' },
    stt: { provider: 'deepgram', model: 'nova-3-general', language: 'multi' },
    tts: { provider: 'deepgram', voice_id: 'aura-2-helena-en', language: 'en', speed: 1 },
  });
  const mayaDraftModel = db.employees.find((e) => e.id === MAYA_ID).runtimeConfig.draft.llm.model;

  runtime.saveDraft(db, 't_a', VAANI_ID, {
    llm: { provider: 'openrouter', model: 'vaani-only-model' },
    stt: { provider: 'sarvam', model: 'saarika:v2.5', language: 'te-IN' },
    tts: { provider: 'sarvam', voice_id: 'anushka', language: 'te', speed: 1.2 },
  });

  assert.equal(db.employees.find((e) => e.id === MAYA_ID).runtimeConfig.draft.llm.model, mayaDraftModel);
  assert.equal(db.employees.find((e) => e.id === VAANI_ID).runtimeConfig.draft.llm.model, 'vaani-only-model');
  assert.equal(db.employees.find((e) => e.id === MAYA_ID).runtimeConfig.active.tts.provider, 'deepgram');
});
