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
 * India-first Language catalog for Employee voice (Phase 18).
 * Honest list only: languages the stack can route today. Customer copy uses
 * "Language", never STT/TTS vendor names.
 */
const SUPPORTED_LANGUAGES = Object.freeze([
  Object.freeze({ id: 'en-IN', label: 'English (India)', nativeLabel: 'English' }),
  Object.freeze({ id: 'hi-IN', label: 'Hindi', nativeLabel: 'हिन्दी' }),
  Object.freeze({ id: 'te-IN', label: 'Telugu', nativeLabel: 'తెలుగు' }),
  Object.freeze({ id: 'ta-IN', label: 'Tamil', nativeLabel: 'தமிழ்' }),
]);
const LANGUAGE_BY_ID = new Map(SUPPORTED_LANGUAGES.map((l) => [l.id, l]));
const DEFAULT_LANGUAGE = 'en-IN';

/**
 * Customer Action types (Phase 19). Definitions persist; live CRM execution
 * is foundation-only (no Phase 2 webhooks, no invented integrations).
 */
const ACTION_TYPES = Object.freeze([
  Object.freeze({
    type: 'book_callback',
    label: 'Book callback',
    description: 'Offer a callback time and record a callback outcome.',
  }),
  Object.freeze({
    type: 'tag_outcome',
    label: 'Tag outcome',
    description: 'Apply an outcome tag after the conversation.',
  }),
  Object.freeze({
    type: 'transfer_to_human',
    label: 'Transfer to human',
    description: 'Stub handoff to a human teammate (routing foundation only).',
  }),
  Object.freeze({
    type: 'crm_webhook',
    label: 'CRM webhook URL',
    description: 'Store a webhook URL for a later CRM delivery. Not called live in this release.',
  }),
]);
const ACTION_TYPE_SET = new Set(ACTION_TYPES.map((a) => a.type));

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

function listSupportedLanguages() {
  return SUPPORTED_LANGUAGES.map((l) => ({ ...l }));
}

function normalizeLanguage(value, fallback = DEFAULT_LANGUAGE) {
  const raw = String(value != null ? value : fallback || DEFAULT_LANGUAGE).trim();
  if (LANGUAGE_BY_ID.has(raw)) return raw;
  // Accept short codes and map to India locales when unambiguous.
  const lower = raw.toLowerCase();
  if (lower === 'en' || lower === 'english' || lower === 'en-in') return 'en-IN';
  if (lower === 'hi' || lower === 'hindi' || lower === 'hi-in') return 'hi-IN';
  if (lower === 'te' || lower === 'telugu' || lower === 'te-in') return 'te-IN';
  if (lower === 'ta' || lower === 'tamil' || lower === 'ta-in') return 'ta-IN';
  return LANGUAGE_BY_ID.has(fallback) ? fallback : DEFAULT_LANGUAGE;
}

function normalizeVoice(input, existing) {
  const b = input && typeof input === 'object' ? input : {};
  const base = existing && typeof existing === 'object' ? existing : {};
  const language = normalizeLanguage(
    b.language != null ? b.language : base.language,
    DEFAULT_LANGUAGE,
  );
  const model = String(b.model != null ? b.model : base.model || 'mulberry').trim().slice(0, 40) || 'mulberry';
  const speaker = String(b.speaker != null ? b.speaker : base.speaker || 'speaker_1').trim().slice(0, 40) || 'speaker_1';
  let f0 = base.f0_up_key != null ? Number(base.f0_up_key) : 0;
  if (b.f0_up_key != null && Number.isFinite(Number(b.f0_up_key))) {
    f0 = Math.max(-12, Math.min(12, Number(b.f0_up_key) | 0));
  }
  return { language, model, speaker, f0_up_key: f0 };
}

/**
 * Structured outcome definition. Customers define what success looks like after
 * a conversation. Call/lead pipelines may write matching outcome keys later.
 */
function normalizeOutcomeDef(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const key = String(raw.key || raw.id || raw.label || '')
      .trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
    if (!key) return null;
    const label = String(raw.label || raw.name || key).trim().slice(0, 80) || key;
    const description = String(raw.description || '').trim().slice(0, 400);
    let success = raw.success === true;
    if (raw.success === undefined) {
      success = ['qualified', 'booked', 'converted', 'resolved', 'completed', 'promised_to_pay'].includes(key);
    }
    return { key, label, description, success: !!success };
  }
  const s = String(raw || '').trim();
  if (!s) return null;
  const key = s.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
  if (!key) return null;
  const label = s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).slice(0, 80);
  const success = ['qualified', 'booked', 'converted', 'resolved', 'completed', 'promised_to_pay'].includes(key);
  return { key, label, description: '', success };
}

function normalizeOutcomesList(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const def = normalizeOutcomeDef(item);
    if (!def || seen.has(def.key)) continue;
    seen.add(def.key);
    out.push(def);
    if (out.length >= 24) break;
  }
  return out;
}

/**
 * Structured Action definition (Phase 19). Overlaps with Outcomes for
 * tag_outcome; CRM webhook URL is stored only (never invoked here).
 */
function normalizeActionDef(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  let type = String(raw.type || raw.actionType || '').trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_');
  if (!ACTION_TYPE_SET.has(type)) {
    // Infer from key/label when type omitted.
    const hint = String(raw.key || raw.label || '').toLowerCase();
    if (hint.includes('callback')) type = 'book_callback';
    else if (hint.includes('transfer') || hint.includes('human')) type = 'transfer_to_human';
    else if (hint.includes('webhook') || hint.includes('crm')) type = 'crm_webhook';
    else if (hint.includes('outcome') || hint.includes('tag')) type = 'tag_outcome';
    else return null;
  }
  const key = String(raw.key || raw.id || type)
    .trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
  if (!key) return null;
  const catalog = ACTION_TYPES.find((a) => a.type === type);
  const label = String(raw.label || raw.name || (catalog && catalog.label) || key).trim().slice(0, 80) || key;
  const description = String(raw.description || (catalog && catalog.description) || '').trim().slice(0, 400);
  const enabled = raw.enabled !== false;
  const config = {};
  const src = raw.config && typeof raw.config === 'object' ? raw.config : raw;
  if (type === 'tag_outcome') {
    const outcomeKey = String(src.outcomeKey || src.outcome || '').trim().toLowerCase()
      .replace(/[^a-z0-9_]+/g, '_').slice(0, 40);
    if (outcomeKey) config.outcomeKey = outcomeKey;
  }
  if (type === 'crm_webhook') {
    // Store URL only. Never call it in this phase (no Phase 2 webhooks).
    const url = String(src.webhookUrl || src.url || '').trim().slice(0, 500);
    if (url && /^https?:\/\//i.test(url)) config.webhookUrl = url;
  }
  if (type === 'transfer_to_human') {
    const target = String(src.target || src.team || '').trim().slice(0, 80);
    if (target) config.target = target;
  }
  if (type === 'book_callback') {
    const note = String(src.note || '').trim().slice(0, 200);
    if (note) config.note = note;
  }
  return { key, type, label, description, enabled: !!enabled, config };
}

function normalizeActionsList(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const def = normalizeActionDef(item);
    if (!def || seen.has(def.key)) continue;
    seen.add(def.key);
    out.push(def);
    if (out.length >= 24) break;
  }
  return out;
}

function listActionTypes() {
  return ACTION_TYPES.map((a) => ({ ...a }));
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
    outcomes: normalizeOutcomesList(row.outcomes),
    actions: normalizeActionsList(row.actions),
    language: normalizeLanguage((row.voice && row.voice.language) || DEFAULT_LANGUAGE),
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
    outcomes: normalizeOutcomesList(
      Array.isArray(b.outcomes) ? b.outcomes : template.outcomes.slice(),
    ),
    actions: normalizeActionsList(Array.isArray(b.actions) ? b.actions : []),
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
  if (b.language !== undefined) {
    row.voice = normalizeVoice({ ...(row.voice || {}), language: b.language }, row.voice);
  }
  if (b.outcomes !== undefined) {
    if (!Array.isArray(b.outcomes)) {
      return { ok: false, status: 422, error: 'outcomes must be an array', code: 'bad_outcomes' };
    }
    row.outcomes = normalizeOutcomesList(b.outcomes);
  }
  if (b.actions !== undefined) {
    if (!Array.isArray(b.actions)) {
      return { ok: false, status: 422, error: 'actions must be an array', code: 'bad_actions' };
    }
    row.actions = normalizeActionsList(b.actions);
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

/**
 * Customer Instructions (Teach). Reads greeting + instructions from the linked
 * agent persona fields, plus the employee brief. No prompt-engineering jargon.
 */
function getInstructions(db, tenantId, id) {
  const row = findEmployee(db, tenantId, id);
  if (!row) return { ok: false, status: 404, error: 'employee not found', code: 'not_found' };
  const agent = row.agentId
    ? (db.agents || []).find((a) => a.id === row.agentId && a.tenantId === tenantId)
    : null;
  const workflow = row.workflowId
    ? (db.workflows || []).find((w) => w.id === row.workflowId && w.tenantId === tenantId)
    : null;
  const steps = [];
  if (workflow && workflow.graphJson && Array.isArray(workflow.graphJson.nodes)) {
    for (const n of workflow.graphJson.nodes) {
      if (!n || n.type === 'start' || n.type === 'end') continue;
      steps.push({
        id: n.id || null,
        name: n.name || n.id || 'Step',
        type: n.type || 'node',
        guidance: n.prompt || '',
      });
    }
  }
  return {
    ok: true,
    instructions: {
      employeeId: row.id,
      agentId: row.agentId || null,
      workflowId: row.workflowId || null,
      brief: row.description || '',
      greeting: agent ? (agent.greeting || '') : '',
      instructions: agent ? (agent.persona || '') : '',
      steps,
      hasAgent: !!agent,
      hasWorkflow: !!workflow,
    },
  };
}

/**
 * Persist Instructions edits onto the linked agent (greeting/persona) and
 * employee brief. Optionally updates workflow step guidance by node id.
 */
function updateInstructions(db, tenantId, id, patch) {
  const row = findEmployee(db, tenantId, id);
  if (!row) return { ok: false, status: 404, error: 'employee not found', code: 'not_found' };
  const b = patch && typeof patch === 'object' ? patch : {};

  if (b.brief !== undefined) {
    row.description = String(b.brief || '').trim().slice(0, 4000);
  }

  if (b.greeting !== undefined || b.instructions !== undefined) {
    if (!row.agentId) {
      return { ok: false, status: 422, error: 'employee has no linked agent', code: 'no_agent' };
    }
    const agent = (db.agents || []).find((a) => a.id === row.agentId && a.tenantId === tenantId);
    if (!agent) {
      return { ok: false, status: 404, error: 'agent not found', code: 'agent_not_found' };
    }
    if (b.greeting !== undefined) agent.greeting = String(b.greeting || '').slice(0, 300);
    if (b.instructions !== undefined) agent.persona = String(b.instructions || '').slice(0, 1500);
  }

  if (b.steps !== undefined) {
    if (!Array.isArray(b.steps)) {
      return { ok: false, status: 422, error: 'steps must be an array', code: 'bad_steps' };
    }
    if (!row.workflowId) {
      return { ok: false, status: 422, error: 'employee has no linked workflow', code: 'no_workflow' };
    }
    const workflow = (db.workflows || []).find((w) => w.id === row.workflowId && w.tenantId === tenantId);
    if (!workflow) {
      return { ok: false, status: 404, error: 'workflow not found', code: 'workflow_not_found' };
    }
    if (!workflow.graphJson || !Array.isArray(workflow.graphJson.nodes)) {
      return { ok: false, status: 422, error: 'workflow has no editable steps', code: 'no_steps' };
    }
    const byId = new Map(b.steps.map((s) => [String(s.id || ''), s]));
    for (const node of workflow.graphJson.nodes) {
      const patchStep = byId.get(String(node.id || ''));
      if (!patchStep) continue;
      if (patchStep.guidance !== undefined) {
        node.prompt = String(patchStep.guidance || '').slice(0, 2000);
      }
      if (patchStep.name !== undefined) {
        node.name = String(patchStep.name || node.name || '').slice(0, 80);
      }
    }
    workflow.updatedAt = nowIso();
  }

  row.updatedAt = nowIso();
  return getInstructions(db, tenantId, id);
}

/**
 * Training: resolve attached knowledge entries for an employee.
 */
function listTraining(db, tenantId, id) {
  const row = findEmployee(db, tenantId, id);
  if (!row) return { ok: false, status: 404, error: 'employee not found', code: 'not_found' };
  const ids = Array.isArray(row.knowledgeIds) ? row.knowledgeIds : [];
  const entries = [];
  for (const kid of ids) {
    const entry = (db.knowledgeEntries || []).find((k) => k.id === kid && k.tenantId === tenantId);
    if (entry) {
      entries.push({
        id: entry.id,
        title: entry.title || '',
        content: entry.content || '',
        sourceUrl: entry.sourceUrl || '',
        status: entry.status || 'draft',
        tags: Array.isArray(entry.tags) ? entry.tags.slice() : [],
        updatedAt: entry.updatedAt || null,
      });
    }
  }
  return {
    ok: true,
    training: {
      employeeId: row.id,
      knowledgeIds: ids.slice(),
      entries,
      count: entries.length,
    },
  };
}

function attachKnowledge(db, tenantId, id, knowledgeId) {
  const row = findEmployee(db, tenantId, id);
  if (!row) return { ok: false, status: 404, error: 'employee not found', code: 'not_found' };
  const kid = String(knowledgeId || '').trim();
  if (!kid) return { ok: false, status: 422, error: 'knowledgeId required', code: 'bad_knowledge' };
  const entry = (db.knowledgeEntries || []).find((k) => k.id === kid && k.tenantId === tenantId);
  if (!entry) return { ok: false, status: 404, error: 'knowledge entry not found', code: 'knowledge_not_found' };
  if (!Array.isArray(row.knowledgeIds)) row.knowledgeIds = [];
  if (!row.knowledgeIds.includes(kid)) {
    if (row.knowledgeIds.length >= 40) {
      return { ok: false, status: 422, error: 'knowledge limit reached', code: 'knowledge_limit' };
    }
    row.knowledgeIds.push(kid);
  }
  row.updatedAt = nowIso();
  return listTraining(db, tenantId, id);
}

function detachKnowledge(db, tenantId, id, knowledgeId) {
  const row = findEmployee(db, tenantId, id);
  if (!row) return { ok: false, status: 404, error: 'employee not found', code: 'not_found' };
  const kid = String(knowledgeId || '').trim();
  if (!Array.isArray(row.knowledgeIds)) row.knowledgeIds = [];
  row.knowledgeIds = row.knowledgeIds.filter((x) => x !== kid);
  row.updatedAt = nowIso();
  return listTraining(db, tenantId, id);
}

/**
 * Create a knowledge entry and attach it to the employee in one step.
 */
function createAndAttachKnowledge(db, tenantId, id, input, actorUserId) {
  const row = findEmployee(db, tenantId, id);
  if (!row) return { ok: false, status: 404, error: 'employee not found', code: 'not_found' };
  const knowledge = require('./knowledge');
  const created = knowledge.createEntry(db, tenantId, input, actorUserId);
  if (!created.ok) return created;
  const attached = attachKnowledge(db, tenantId, id, created.entry.id);
  if (!attached.ok) return attached;
  return { ok: true, entry: created.entry, training: attached.training };
}

function getOutcomes(db, tenantId, id) {
  const row = findEmployee(db, tenantId, id);
  if (!row) return { ok: false, status: 404, error: 'employee not found', code: 'not_found' };
  const defs = normalizeOutcomesList(row.outcomes);
  return {
    ok: true,
    outcomes: {
      employeeId: row.id,
      definitions: defs,
      count: defs.length,
      // Foundation only. Live conversation results are not invented here.
      resultsAvailable: false,
      results: [],
    },
  };
}

function setOutcomes(db, tenantId, id, list) {
  const row = findEmployee(db, tenantId, id);
  if (!row) return { ok: false, status: 404, error: 'employee not found', code: 'not_found' };
  if (!Array.isArray(list)) {
    return { ok: false, status: 422, error: 'outcomes must be an array', code: 'bad_outcomes' };
  }
  row.outcomes = normalizeOutcomesList(list);
  row.updatedAt = nowIso();
  return getOutcomes(db, tenantId, id);
}

function getActions(db, tenantId, id) {
  const row = findEmployee(db, tenantId, id);
  if (!row) return { ok: false, status: 404, error: 'employee not found', code: 'not_found' };
  const defs = normalizeActionsList(row.actions);
  return {
    ok: true,
    actions: {
      employeeId: row.id,
      definitions: defs,
      count: defs.length,
      types: listActionTypes(),
      // Foundation only. Live CRM / webhook execution is not enabled here.
      executionAvailable: false,
      executions: [],
    },
  };
}

function setActions(db, tenantId, id, list) {
  const row = findEmployee(db, tenantId, id);
  if (!row) return { ok: false, status: 404, error: 'employee not found', code: 'not_found' };
  if (!Array.isArray(list)) {
    return { ok: false, status: 422, error: 'actions must be an array', code: 'bad_actions' };
  }
  row.actions = normalizeActionsList(list);
  row.updatedAt = nowIso();
  return getActions(db, tenantId, id);
}

/**
 * Execution hook foundation (Phase 19). Validates the Action exists for the
 * Employee and records intent only. Never calls CRM webhooks or places dials.
 */
function executeActionHook(db, tenantId, id, body) {
  const row = findEmployee(db, tenantId, id);
  if (!row) return { ok: false, status: 404, error: 'employee not found', code: 'not_found' };
  const b = body && typeof body === 'object' ? body : {};
  const key = String(b.key || b.actionKey || '').trim().toLowerCase();
  const defs = normalizeActionsList(row.actions);
  const def = defs.find((d) => d.key === key || d.type === key);
  if (!def) {
    return { ok: false, status: 404, error: 'action not found', code: 'action_not_found' };
  }
  if (!def.enabled) {
    return { ok: false, status: 409, error: 'action is disabled', code: 'action_disabled' };
  }
  // Reuse outcomes when tagging.
  let outcomeApplied = null;
  if (def.type === 'tag_outcome') {
    const outcomeKey = String(
      (b.config && b.config.outcomeKey) || def.config.outcomeKey || b.outcomeKey || '',
    ).trim().toLowerCase();
    const outcomes = normalizeOutcomesList(row.outcomes);
    const match = outcomes.find((o) => o.key === outcomeKey);
    if (match) outcomeApplied = match.key;
  }
  return {
    ok: true,
    execution: {
      employeeId: row.id,
      actionKey: def.key,
      actionType: def.type,
      status: 'queued_foundation',
      executionAvailable: false,
      outcomeApplied,
      message: 'Action recorded as foundation only. Live CRM calls and Phase 2 webhooks are not enabled.',
    },
  };
}

function setEmployeeLanguage(db, tenantId, id, language) {
  const row = findEmployee(db, tenantId, id);
  if (!row) return { ok: false, status: 404, error: 'employee not found', code: 'not_found' };
  const next = String(language || '').trim();
  let resolved = null;
  if (LANGUAGE_BY_ID.has(next)) resolved = next;
  else {
    const lower = next.toLowerCase();
    const aliases = {
      en: 'en-IN', english: 'en-IN', 'en-in': 'en-IN',
      hi: 'hi-IN', hindi: 'hi-IN', 'hi-in': 'hi-IN',
      te: 'te-IN', telugu: 'te-IN', 'te-in': 'te-IN',
      ta: 'ta-IN', tamil: 'ta-IN', 'ta-in': 'ta-IN',
    };
    resolved = aliases[lower] || null;
  }
  if (!resolved) {
    return {
      ok: false,
      status: 422,
      error: 'unsupported language',
      code: 'unsupported_language',
      supported: listSupportedLanguages(),
    };
  }
  row.voice = normalizeVoice({ ...(row.voice || {}), language: resolved }, row.voice);
  row.updatedAt = nowIso();
  return {
    ok: true,
    employee: row,
    language: row.voice.language,
    languages: listSupportedLanguages(),
  };
}

/**
 * Customer Workflow view for an Employee (Phase 9).
 * Language: Workflow / Steps / Instructions. Never graph/node/SIP jargon.
 */
function stepsFromWorkflow(workflow) {
  const steps = [];
  if (!workflow || !workflow.graphJson || !Array.isArray(workflow.graphJson.nodes)) return steps;
  for (const n of workflow.graphJson.nodes) {
    if (!n || n.type === 'start' || n.type === 'end') continue;
    if (n.type === 'global') continue;
    steps.push({
      id: n.id || null,
      name: n.name || n.id || 'Step',
      type: 'step',
      guidance: n.prompt || '',
    });
  }
  return steps;
}

function globalGuidanceFromWorkflow(workflow) {
  if (!workflow || !workflow.graphJson || !Array.isArray(workflow.graphJson.nodes)) return '';
  const g = workflow.graphJson.nodes.find((n) => n && n.type === 'global');
  return g ? (g.prompt || '') : '';
}

function getWorkflow(db, tenantId, id) {
  const row = findEmployee(db, tenantId, id);
  if (!row) return { ok: false, status: 404, error: 'employee not found', code: 'not_found' };
  const workflow = row.workflowId
    ? (db.workflows || []).find((w) => w.id === row.workflowId && w.tenantId === tenantId)
    : null;
  if (!workflow) {
    return {
      ok: true,
      workflow: {
        employeeId: row.id,
        workflowId: null,
        name: '',
        description: '',
        status: null,
        direction: null,
        steps: [],
        globalGuidance: '',
        hasWorkflow: false,
      },
    };
  }
  return {
    ok: true,
    workflow: {
      employeeId: row.id,
      workflowId: workflow.id,
      name: workflow.name || '',
      description: workflow.description || '',
      status: workflow.status || 'draft',
      direction: workflow.direction || null,
      steps: stepsFromWorkflow(workflow),
      globalGuidance: globalGuidanceFromWorkflow(workflow),
      hasWorkflow: true,
    },
  };
}

/**
 * Persist customer Workflow edits onto the linked Astra workflow.
 * Accepts name, description, steps[{id?, name, guidance}], globalGuidance.
 * Rebuilds a linear graph via workflows.buildLinearGraph (reuse).
 */
function updateWorkflow(db, tenantId, id, patch) {
  const row = findEmployee(db, tenantId, id);
  if (!row) return { ok: false, status: 404, error: 'employee not found', code: 'not_found' };
  if (!row.workflowId) {
    return { ok: false, status: 422, error: 'employee has no linked workflow', code: 'no_workflow' };
  }
  const workflow = (db.workflows || []).find((w) => w.id === row.workflowId && w.tenantId === tenantId);
  if (!workflow) {
    return { ok: false, status: 404, error: 'workflow not found', code: 'workflow_not_found' };
  }
  if (workflow.status === 'archived') {
    return { ok: false, status: 409, error: 'archived workflows cannot be edited', code: 'archived' };
  }

  const b = patch && typeof patch === 'object' ? patch : {};
  const name = b.name !== undefined ? String(b.name || '').trim().slice(0, 120) : undefined;
  const description = b.description !== undefined
    ? String(b.description || '').slice(0, 500)
    : undefined;

  let graphJson;
  if (b.steps !== undefined) {
    if (!Array.isArray(b.steps)) {
      return { ok: false, status: 422, error: 'steps must be an array', code: 'bad_steps' };
    }
    if (b.steps.length > 20) {
      return { ok: false, status: 422, error: 'too many steps', code: 'steps_limit' };
    }
    const stages = b.steps.map((s, i) => {
      const stepName = String((s && s.name) || ('Step ' + (i + 1))).trim().slice(0, 80) || ('Step ' + (i + 1));
      const guidance = String((s && (s.guidance != null ? s.guidance : s.prompt)) || '').slice(0, 2000);
      return { name: stepName, prompt: guidance };
    });
    const globalPrompt = b.globalGuidance !== undefined
      ? String(b.globalGuidance || '').slice(0, 2000)
      : globalGuidanceFromWorkflow(workflow);
    graphJson = workflows.buildLinearGraph(stages, globalPrompt);
  } else if (b.globalGuidance !== undefined) {
    // Preserve existing stage nodes. Update global guidance only.
    const existingSteps = stepsFromWorkflow(workflow).map((s) => ({
      name: s.name,
      prompt: s.guidance,
    }));
    graphJson = workflows.buildLinearGraph(
      existingSteps,
      String(b.globalGuidance || '').slice(0, 2000),
    );
  }

  const result = workflows.updateWorkflow(db, tenantId, workflow.id, {
    name,
    description,
    graphJson,
  });
  if (!result.ok) return result;
  row.updatedAt = nowIso();
  return getWorkflow(db, tenantId, id);
}

module.exports = {
  STATUSES,
  CHANNELS,
  JOB_TEMPLATES,
  SUPPORTED_LANGUAGES,
  DEFAULT_LANGUAGE,
  ACTION_TYPES,
  ALLOWED_TRANSITIONS,
  ensureEmployees,
  getJobTemplate,
  listJobTemplates,
  listSupportedLanguages,
  listActionTypes,
  normalizeStatus,
  normalizeChannel,
  normalizeLanguage,
  normalizeVoice,
  normalizeOutcomeDef,
  normalizeOutcomesList,
  normalizeActionDef,
  normalizeActionsList,
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
  getInstructions,
  updateInstructions,
  listTraining,
  attachKnowledge,
  detachKnowledge,
  createAndAttachKnowledge,
  getOutcomes,
  setOutcomes,
  getActions,
  setActions,
  executeActionHook,
  setEmployeeLanguage,
  getWorkflow,
  updateWorkflow,
  stepsFromWorkflow,
  genId,
};
