/**
 * Astra AI. Customer-facing AI Employee product layer.
 *
 * An Employee is a composition of relationships (agent_id, workflow_id,
 * knowledge refs, voice config, phone_number_id). It is NOT a duplicated blob
 * of agent/workflow data. Provider ids stay server-side. Customers never see
 * Dograh, VoBiz, Deepgram, Groq, or Rumik terminology here.
 *
 * Lifecycle: DRAFT | READY | LIVE | PAUSED | ARCHIVED
 *
 * No em dashes anywhere. Commas and periods only.
 */
'use strict';

const crypto = require('crypto');
const workflows = require('./workflows');
const { applyPresetToAgent, normalizeAgentType } = require('./agent-types');

const STATUSES = Object.freeze(['DRAFT', 'READY', 'LIVE', 'PAUSED', 'ARCHIVED']);
const STATUS_SET = new Set(STATUSES);

const CHANNELS = Object.freeze(['inbound', 'instant_lead', 'campaign', 'outbound', 'both']);
const CHANNEL_SET = new Set(CHANNELS);

/**
 * Job templates for Create Employee. Each maps onto existing Astra Agent types
 * and Workflow templates (reuse, do not rewrite).
 */
const JOB_TEMPLATES = Object.freeze([
  Object.freeze({
    key: 'receptionist',
    name: 'Receptionist',
    role: 'Receptionist',
    description: 'Answer inbound calls, greet callers, capture intent, and route or take a message.',
    channel: 'inbound',
    workflowTemplateKey: 'receptionist',
    agentType: 'inbound_receptionist',
    presetId: 'preset_receptionist_v1',
    language: 'en-IN',
    outcomes: Object.freeze(['message_taken', 'routed', 'callback_scheduled']),
  }),
  Object.freeze({
    key: 'instant_lead_caller',
    name: 'Instant Lead Caller',
    role: 'Instant Lead Caller',
    description: 'Call new leads quickly with permission check, discovery, and next-step booking.',
    channel: 'instant_lead',
    workflowTemplateKey: 'outbound_sales',
    agentType: 'outbound_callback',
    presetId: 'preset_astranova_outbound_jerry_v1',
    language: 'en-IN',
    outcomes: Object.freeze(['qualified', 'callback_scheduled', 'not_interested', 'no_answer']),
  }),
  Object.freeze({
    key: 'lead_qualification',
    name: 'Lead Qualification',
    role: 'Lead Qualifier',
    description: 'Short discovery to qualify interest and book the right sales step.',
    channel: 'both',
    workflowTemplateKey: 'lead_qual',
    agentType: 'lead_qualifier',
    presetId: 'preset_lead_qualification_v1',
    language: 'en-IN',
    outcomes: Object.freeze(['qualified', 'disqualified', 'callback_scheduled']),
  }),
  Object.freeze({
    key: 'outbound_sales',
    name: 'Outbound Sales',
    role: 'Outbound Sales',
    description: 'Permission check, discovery, then book or reschedule.',
    channel: 'outbound',
    workflowTemplateKey: 'outbound_sales',
    agentType: 'outbound_callback',
    presetId: 'preset_astranova_outbound_jerry_v1',
    language: 'en-IN',
    outcomes: Object.freeze(['booked', 'rescheduled', 'not_interested', 'no_answer']),
  }),
  Object.freeze({
    key: 'support',
    name: 'Support',
    role: 'Customer Support',
    description: 'Capture issue details, troubleshoot lightly, and escalate securely.',
    channel: 'inbound',
    workflowTemplateKey: 'support',
    agentType: 'support',
    presetId: 'preset_customer_support_v1',
    language: 'en-IN',
    outcomes: Object.freeze(['resolved', 'escalated', 'ticket_created']),
  }),
  Object.freeze({
    key: 'appointment',
    name: 'Appointment',
    role: 'Appointment Desk',
    description: 'Schedule, move, or cancel appointments with timezone confirmation.',
    channel: 'inbound',
    workflowTemplateKey: 'appointment',
    agentType: 'inbound_receptionist',
    presetId: 'preset_appointment_v1',
    language: 'en-IN',
    outcomes: Object.freeze(['booked', 'rescheduled', 'cancelled']),
  }),
  Object.freeze({
    key: 'payment_reminder',
    name: 'Payment Reminder',
    role: 'Payment Reminder',
    description: 'Polite outbound reminder with confirmation and escalation paths.',
    channel: 'outbound',
    workflowTemplateKey: 'payment_reminder',
    agentType: 'outbound_callback',
    presetId: null,
    language: 'en-IN',
    outcomes: Object.freeze(['promised_to_pay', 'callback_scheduled', 'dispute', 'no_answer']),
  }),
  Object.freeze({
    key: 'survey',
    name: 'Survey',
    role: 'Survey Agent',
    description: 'Short post-call or outbound survey with structured capture.',
    channel: 'outbound',
    workflowTemplateKey: 'survey',
    agentType: 'custom',
    presetId: null,
    language: 'en-IN',
    outcomes: Object.freeze(['completed', 'partial', 'opted_out']),
  }),
  Object.freeze({
    key: 'custom',
    name: 'Custom',
    role: 'Custom Employee',
    description: 'Start from a blank brief and compose your own agent and workflow.',
    channel: 'both',
    workflowTemplateKey: 'blank',
    agentType: 'custom',
    presetId: null,
    language: 'en-IN',
    outcomes: Object.freeze([]),
  }),
]);

const TEMPLATE_BY_KEY = new Map(JOB_TEMPLATES.map((t) => [t.key, t]));

function genId(prefix) {
  return prefix + crypto.randomBytes(8).toString('hex');
}

function nowIso() {
  return new Date().toISOString();
}

function ensureEmployees(db) {
  if (!Array.isArray(db.employees)) db.employees = [];
}

function getJobTemplate(key) {
  return TEMPLATE_BY_KEY.get(String(key || '')) || null;
}

function listJobTemplates() {
  return JOB_TEMPLATES.map((t) => ({
    key: t.key,
    name: t.name,
    role: t.role,
    description: t.description,
    channel: t.channel,
    language: t.language,
    outcomes: t.outcomes.slice(),
  }));
}

function normalizeStatus(value) {
  const s = String(value || '').trim().toUpperCase();
  return STATUS_SET.has(s) ? s : null;
}

function normalizeChannel(value, fallback = 'both') {
  const c = String(value || '').trim().toLowerCase();
  return CHANNEL_SET.has(c) ? c : fallback;
}

function normalizeVoice(input, existing) {
  const b = input && typeof input === 'object' ? input : {};
  const base = existing && typeof existing === 'object' ? existing : {};
  const language = String(b.language != null ? b.language : base.language || 'en-IN').trim().slice(0, 32) || 'en-IN';
  const model = String(b.model != null ? b.model : base.model || 'mulberry').trim().slice(0, 40) || 'mulberry';
  const speaker = String(b.speaker != null ? b.speaker : base.speaker || 'speaker_1').trim().slice(0, 40) || 'speaker_1';
  let f0 = base.f0_up_key != null ? Number(base.f0_up_key) : 0;
  if (b.f0_up_key != null && Number.isFinite(Number(b.f0_up_key))) {
    f0 = Math.max(-12, Math.min(12, Number(b.f0_up_key) | 0));
  }
  return { language, model, speaker, f0_up_key: f0 };
}

function isQualifiedCall(call) {
  const outcome = String(call.outcome || '').toLowerCase();
  if (outcome.includes('qualif') || outcome === 'booked' || outcome === 'converted') return true;
  const data = call.extractedData && typeof call.extractedData === 'object' ? call.extractedData : {};
  if (data.qualified === true || data.converted === true || data.booked === true) return true;
  return false;
}

/**
 * Honest metrics from real Call / Lead rows. Never invents numbers.
 * Missing data yields zeros and null lastActiveAt.
 */
function computeMetrics(db, employee) {
  const tenantId = employee.tenantId;
  const agentId = employee.agentId || null;
  const empId = employee.id;
  const today = new Date().toISOString().slice(0, 10);
  let callsToday = 0;
  let leadsCount = 0;
  let qualified = 0;
  let lastActiveAt = employee.lastActiveAt || null;

  for (const c of db.calls || []) {
    if (c.tenantId !== tenantId) continue;
    const match = (agentId && c.agentId === agentId) || c.employeeId === empId;
    if (!match) continue;
    const started = String(c.startedAt || c.createdAt || '');
    if (started.startsWith(today)) callsToday += 1;
    if (isQualifiedCall(c)) qualified += 1;
    if (started && (!lastActiveAt || started > lastActiveAt)) lastActiveAt = started;
  }

  for (const l of db.leads || []) {
    if (l.tenantId !== tenantId) continue;
    const match = (agentId && l.agentId === agentId) || l.employeeId === empId;
    if (!match) continue;
    leadsCount += 1;
    const u = String(l.updatedAt || l.createdAt || '');
    if (u && (!lastActiveAt || u > lastActiveAt)) lastActiveAt = u;
  }

  return {
    callsToday,
    leads: leadsCount,
    qualified,
    lastActiveAt,
  };
}

function resolveAssignedNumber(db, employee) {
  if (!employee.phoneNumberId) return null;
  const n = (db.phoneNumbers || []).find(
    (row) => row.id === employee.phoneNumberId && row.tenantId === employee.tenantId,
  );
  if (!n) return null;
  return {
    id: n.id,
    e164: n.e164 || n.address || '',
    label: n.label || '',
  };
}

function resolveNames(db, employee) {
  let agentName = null;
  let workflowName = null;
  if (employee.agentId) {
    const a = (db.agents || []).find((x) => x.id === employee.agentId && x.tenantId === employee.tenantId);
    if (a) agentName = a.name || null;
  }
  if (employee.workflowId) {
    const w = (db.workflows || []).find((x) => x.id === employee.workflowId && x.tenantId === employee.tenantId);
    if (w) workflowName = w.name || null;
  }
  return { agentName, workflowName };
}

/**
 * Client-safe employee. Never includes provider / Dograh / tenant internals.
 */
function publicEmployee(row, db, opts = {}) {
  if (!row) return null;
  const metrics = opts.includeMetrics === false
    ? null
    : computeMetrics(db || { calls: [], leads: [] }, row);
  const names = resolveNames(db || {}, row);
  const number = resolveAssignedNumber(db || {}, row);
  const out = {
    id: row.id,
    name: row.name || '',
    role: row.role || '',
    templateKey: row.templateKey || 'custom',
    status: row.status || 'DRAFT',
    channel: row.channel || 'both',
    description: row.description || '',
    agentId: row.agentId || null,
    workflowId: row.workflowId || null,
    knowledgeIds: Array.isArray(row.knowledgeIds) ? row.knowledgeIds.slice() : [],
    phoneNumberId: row.phoneNumberId || null,
    voice: normalizeVoice(row.voice),
    outcomes: Array.isArray(row.outcomes) ? row.outcomes.slice() : [],
    language: (row.voice && row.voice.language) || 'en-IN',
    assignedNumber: number,
    agentName: names.agentName,
    workflowName: names.workflowName,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
  if (metrics) {
    out.callsToday = metrics.callsToday;
    out.leads = metrics.leads;
    out.qualified = metrics.qualified;
    out.lastActiveAt = metrics.lastActiveAt;
  } else {
    out.lastActiveAt = row.lastActiveAt || null;
  }
  return out;
}

function findEmployee(db, tenantId, id) {
  ensureEmployees(db);
  return (db.employees || []).find((e) => e.id === String(id || '') && e.tenantId === tenantId) || null;
}

function listEmployees(db, tenantId, opts = {}) {
  ensureEmployees(db);
  let rows = (db.employees || []).filter((e) => e.tenantId === tenantId);
  const filter = String(opts.filter || opts.status || opts.channel || 'all').toLowerCase();
  if (filter && filter !== 'all') {
    if (STATUS_SET.has(filter.toUpperCase())) {
      rows = rows.filter((e) => e.status === filter.toUpperCase());
    } else if (CHANNEL_SET.has(filter)) {
      rows = rows.filter((e) => e.channel === filter);
    }
  }
  rows.sort((a, b) => String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || '')));
  const limit = Math.max(1, Math.min(200, Number(opts.limit) || 100));
  return rows.slice(0, limit).map((row) => publicEmployee(row, db));
}

function validateRefs(db, tenantId, input) {
  const b = input && typeof input === 'object' ? input : {};
  let agentId = b.agentId !== undefined ? (b.agentId ? String(b.agentId) : null) : undefined;
  let workflowId = b.workflowId !== undefined ? (b.workflowId ? String(b.workflowId) : null) : undefined;
  let phoneNumberId = b.phoneNumberId !== undefined ? (b.phoneNumberId ? String(b.phoneNumberId) : null) : undefined;
  let knowledgeIds = b.knowledgeIds !== undefined
    ? (Array.isArray(b.knowledgeIds) ? b.knowledgeIds.map(String).slice(0, 40) : [])
    : undefined;

  if (agentId) {
    const agent = (db.agents || []).find((a) => a.id === agentId && a.tenantId === tenantId);
    if (!agent) return { ok: false, status: 404, error: 'agent not found', code: 'agent_not_found' };
  }
  if (workflowId) {
    const wf = (db.workflows || []).find((w) => w.id === workflowId && w.tenantId === tenantId);
    if (!wf) return { ok: false, status: 404, error: 'workflow not found', code: 'workflow_not_found' };
  }
  if (phoneNumberId) {
    const num = (db.phoneNumbers || []).find((n) => n.id === phoneNumberId && n.tenantId === tenantId);
    if (!num) return { ok: false, status: 404, error: 'phone number not found', code: 'number_not_found' };
  }
  if (knowledgeIds) {
    for (const kid of knowledgeIds) {
      const entry = (db.knowledgeEntries || []).find((k) => k.id === kid && k.tenantId === tenantId);
      if (!entry) return { ok: false, status: 404, error: 'knowledge entry not found', code: 'knowledge_not_found' };
    }
  }
  return { ok: true, agentId, workflowId, phoneNumberId, knowledgeIds };
}

/**
 * Derive READY when agent + workflow are linked. Does not auto-LIVE.
 * Never invents LIVE from empty metrics.
 */
function deriveStatusAfterCompose(employee) {
  if (employee.status === 'ARCHIVED' || employee.status === 'LIVE' || employee.status === 'PAUSED') {
    return employee.status;
  }
  if (employee.agentId && employee.workflowId) return 'READY';
  return 'DRAFT';
}

const ALLOWED_TRANSITIONS = Object.freeze({
  DRAFT: Object.freeze(['READY', 'ARCHIVED']),
  READY: Object.freeze(['LIVE', 'DRAFT', 'ARCHIVED']),
  LIVE: Object.freeze(['PAUSED', 'ARCHIVED', 'READY']),
  PAUSED: Object.freeze(['LIVE', 'ARCHIVED', 'READY']),
  ARCHIVED: Object.freeze(['DRAFT']),
});

function canTransition(from, to) {
  const allowed = ALLOWED_TRANSITIONS[from] || [];
  return allowed.includes(to);
}

/**
 * Compose Agent + Workflow from a job template and optional user brief,
 * then create the Employee relationship row.
 */
function createEmployee(db, tenantId, input, actorUserId, opts = {}) {
  ensureEmployees(db);
  if (!Array.isArray(db.agents)) db.agents = [];
  if (!Array.isArray(db.workflows)) db.workflows = [];

  const b = input && typeof input === 'object' ? input : {};
  const templateKey = String(b.templateKey || b.jobTemplate || 'custom').trim() || 'custom';
  const template = getJobTemplate(templateKey) || getJobTemplate('custom');
  const name = String(b.name || template.name || 'Untitled Employee').trim().slice(0, 80);
  if (!name) return { ok: false, status: 422, error: 'name required', code: 'bad_name' };

  const description = String(b.description || b.brief || '').trim().slice(0, 4000);
  const channel = normalizeChannel(b.channel || template.channel, template.channel);
  const role = String(b.role || template.role || template.name).trim().slice(0, 80);
  const voice = normalizeVoice(b.voice || { language: template.language });

  // Optional explicit links (reuse existing resources instead of composing).
  const refs = validateRefs(db, tenantId, b);
  if (!refs.ok) return refs;

  let agentId = refs.agentId !== undefined ? refs.agentId : null;
  let workflowId = refs.workflowId !== undefined ? refs.workflowId : null;
  const compose = b.compose !== false && !agentId && !workflowId;

  if (compose) {
    const preset = template.presetId
      ? (db.presets || []).find((p) => p.id === template.presetId && (p.isSystem || p.tenantId === tenantId))
      : null;

    const personaBits = [];
    if (description) personaBits.push(description);
    if (preset) personaBits.push(`${preset.name}. Collect: ${(preset.fields || []).join(', ')}.`);

    const agentBase = {
      id: genId('ag_'),
      tenantId,
      tts: {
        provider: 'rumik',
        model: voice.model === 'muga' ? 'muga' : 'mulberry',
        speaker: voice.speaker,
        f0_up_key: voice.f0_up_key,
      },
      telephony: { did: '' },
      createdAt: nowIso(),
    };
    const agent = applyPresetToAgent(agentBase, preset, {
      name,
      persona: personaBits.join(' ').slice(0, 1500) || undefined,
      greeting: b.greeting != null ? String(b.greeting).slice(0, 300) : undefined,
      agentType: normalizeAgentType(b.agentType || template.agentType, template.agentType),
      direction: channel === 'inbound' ? 'inbound'
        : (channel === 'outbound' || channel === 'instant_lead' || channel === 'campaign') ? 'outbound'
          : 'both',
    });
    if (!agent.name) agent.name = name;
    if (agent.persona == null) agent.persona = description.slice(0, 1500);
    if (agent.greeting == null) agent.greeting = '';
    db.agents.push(agent);
    agentId = agent.id;

    const wfResult = workflows.createWorkflow(db, tenantId, {
      templateKey: template.workflowTemplateKey,
      name: name + ' workflow',
      description: description || template.description,
      direction: channel === 'both' ? 'both'
        : (channel === 'inbound' ? 'inbound' : 'outbound'),
      agentId,
    }, actorUserId);
    if (!wfResult.ok) return wfResult;
    workflowId = wfResult.workflow.id;
  }

  const knowledgeIds = refs.knowledgeIds !== undefined ? refs.knowledgeIds : [];
  const phoneNumberId = refs.phoneNumberId !== undefined ? refs.phoneNumberId : null;

  const ts = nowIso();
  const row = {
    id: genId('emp_'),
    tenantId,
    name,
    role,
    templateKey: template.key,
    status: 'DRAFT',
    channel,
    description,
    agentId,
    workflowId,
    knowledgeIds,
    phoneNumberId,
    voice,
    outcomes: Array.isArray(b.outcomes) ? b.outcomes.map(String).slice(0, 24) : template.outcomes.slice(),
    lastActiveAt: null,
    createdBy: actorUserId || null,
    createdAt: ts,
    updatedAt: ts,
  };
  row.status = deriveStatusAfterCompose(row);
  if (b.status) {
    const forced = normalizeStatus(b.status);
    if (forced && forced !== 'LIVE') row.status = forced;
  }
  db.employees.push(row);
  return { ok: true, employee: row, created: true, composed: !!compose };
}

function updateEmployee(db, tenantId, id, patch) {
  const row = findEmployee(db, tenantId, id);
  if (!row) return { ok: false, status: 404, error: 'employee not found', code: 'not_found' };
  const b = patch && typeof patch === 'object' ? patch : {};

  if (b.name !== undefined) {
    const name = String(b.name || '').trim().slice(0, 80);
    if (!name) return { ok: false, status: 422, error: 'name required', code: 'bad_name' };
    row.name = name;
  }
  if (b.role !== undefined) row.role = String(b.role || '').trim().slice(0, 80);
  if (b.description !== undefined) row.description = String(b.description || '').trim().slice(0, 4000);
  if (b.channel !== undefined) row.channel = normalizeChannel(b.channel, row.channel);
  if (b.voice !== undefined) row.voice = normalizeVoice(b.voice, row.voice);
  if (b.outcomes !== undefined && Array.isArray(b.outcomes)) {
    row.outcomes = b.outcomes.map(String).slice(0, 24);
  }

  const refs = validateRefs(db, tenantId, b);
  if (!refs.ok) return refs;
  if (refs.agentId !== undefined) row.agentId = refs.agentId;
  if (refs.workflowId !== undefined) row.workflowId = refs.workflowId;
  if (refs.phoneNumberId !== undefined) row.phoneNumberId = refs.phoneNumberId;
  if (refs.knowledgeIds !== undefined) row.knowledgeIds = refs.knowledgeIds;

  if (b.status !== undefined) {
    const next = normalizeStatus(b.status);
    if (!next) return { ok: false, status: 422, error: 'bad status', code: 'bad_status' };
    if (next !== row.status && !canTransition(row.status, next)) {
      return {
        ok: false,
        status: 422,
        error: 'cannot transition from ' + row.status + ' to ' + next,
        code: 'bad_transition',
      };
    }
    if (next === 'READY' && !(row.agentId && row.workflowId)) {
      return { ok: false, status: 422, error: 'READY requires agent and workflow', code: 'not_ready' };
    }
    if (next === 'LIVE' && !(row.agentId && row.workflowId)) {
      return { ok: false, status: 422, error: 'LIVE requires agent and workflow', code: 'not_ready' };
    }
    row.status = next;
  } else if (row.status === 'DRAFT') {
    row.status = deriveStatusAfterCompose(row);
  }

  row.updatedAt = nowIso();
  return { ok: true, employee: row };
}

function setEmployeeStatus(db, tenantId, id, status) {
  return updateEmployee(db, tenantId, id, { status });
}

function pauseEmployee(db, tenantId, id) {
  const row = findEmployee(db, tenantId, id);
  if (!row) return { ok: false, status: 404, error: 'employee not found', code: 'not_found' };
  if (row.status !== 'LIVE') {
    return { ok: false, status: 422, error: 'only LIVE employees can be paused', code: 'bad_transition' };
  }
  return setEmployeeStatus(db, tenantId, id, 'PAUSED');
}

function resumeEmployee(db, tenantId, id) {
  const row = findEmployee(db, tenantId, id);
  if (!row) return { ok: false, status: 404, error: 'employee not found', code: 'not_found' };
  if (row.status !== 'PAUSED') {
    return { ok: false, status: 422, error: 'only PAUSED employees can be resumed', code: 'bad_transition' };
  }
  return setEmployeeStatus(db, tenantId, id, 'LIVE');
}

module.exports = {
  STATUSES,
  CHANNELS,
  JOB_TEMPLATES,
  ALLOWED_TRANSITIONS,
  ensureEmployees,
  getJobTemplate,
  listJobTemplates,
  normalizeStatus,
  normalizeChannel,
  normalizeVoice,
  computeMetrics,
  publicEmployee,
  findEmployee,
  listEmployees,
  createEmployee,
  updateEmployee,
  setEmployeeStatus,
  pauseEmployee,
  resumeEmployee,
  canTransition,
  deriveStatusAfterCompose,
  genId,
};
