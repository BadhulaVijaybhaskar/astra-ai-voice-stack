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
 * India-first Language catalog for Employee voice (Phase 18 + curated Astra list).
 * Honest list only. Customer copy uses "Language", never STT/TTS vendor names.
 * Product UI shows ASTRA_SUPPORTED_LANGUAGES only. Provider extras are Advanced.
 */
const voiceLangCatalog = require('./tts-voice-catalog');

const SUPPORTED_LANGUAGES = Object.freeze(
  voiceLangCatalog.listAstraSupportedLanguages().map((l) => Object.freeze({
    id: l.id,
    label: l.label,
    nativeLabel: l.nativeLabel,
    status: l.statusLabel,
    statusKey: l.status,
  })),
);
const LANGUAGE_BY_ID = new Map(SUPPORTED_LANGUAGES.map((l) => [l.id, l]));
const DEFAULT_LANGUAGE = 'en-IN';

/**
 * Voice tier catalog (celebrity / brand readiness placeholders).
 * Only Standard is selectable for live dials today. Regional Premium,
 * Licensed Brand, and Private Enterprise are architecture + UX stubs.
 * Never name real celebrities or claim product partnerships.
 */
const VOICE_TIERS = Object.freeze([
  Object.freeze({
    id: 'standard',
    label: 'Standard',
    available: true,
    description: 'Platform voice profiles for everyday Employees. Ready for Instant Leads and campaigns.',
  }),
  Object.freeze({
    id: 'regional_premium',
    label: 'Regional Premium',
    available: false,
    description: 'Curated regional voice packs. Placeholder only. Not live for dials in this release.',
  }),
  Object.freeze({
    id: 'licensed_brand',
    label: 'Licensed Brand',
    available: false,
    description: 'Brand-licensed voice after rights clearance. Placeholder only. Requires a brand agreement.',
  }),
  Object.freeze({
    id: 'private_enterprise',
    label: 'Private Enterprise',
    available: false,
    description: 'Private enterprise voice profile with consent, dataset, rights, audit, and revoke. Placeholder only.',
  }),
]);
const VOICE_TIER_BY_ID = new Map(VOICE_TIERS.map((t) => [t.id, t]));
const DEFAULT_VOICE_TIER = 'standard';

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
  const aliases = {
    en: 'en-IN', english: 'en-IN', 'en-in': 'en-IN',
    hi: 'hi-IN', hindi: 'hi-IN', 'hi-in': 'hi-IN',
    te: 'te-IN', telugu: 'te-IN', 'te-in': 'te-IN',
    ta: 'ta-IN', tamil: 'ta-IN', 'ta-in': 'ta-IN',
    kn: 'kn-IN', kannada: 'kn-IN', 'kn-in': 'kn-IN',
    ml: 'ml-IN', malayalam: 'ml-IN', 'ml-in': 'ml-IN',
    mr: 'mr-IN', marathi: 'mr-IN', 'mr-in': 'mr-IN',
    bn: 'bn-IN', bengali: 'bn-IN', 'bn-in': 'bn-IN',
    gu: 'gu-IN', gujarati: 'gu-IN', 'gu-in': 'gu-IN',
    pa: 'pa-IN', punjabi: 'pa-IN', 'pa-in': 'pa-IN',
  };
  if (aliases[lower]) return aliases[lower];
  return LANGUAGE_BY_ID.has(fallback) ? fallback : DEFAULT_LANGUAGE;
}

function normalizeVoiceTier(raw, fallback = DEFAULT_VOICE_TIER) {
  const id = String(raw || '').trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_');
  if (VOICE_TIER_BY_ID.has(id)) return id;
  return VOICE_TIER_BY_ID.has(fallback) ? fallback : DEFAULT_VOICE_TIER;
}

function listVoiceTiers() {
  return VOICE_TIERS.map((t) => ({
    id: t.id,
    label: t.label,
    available: !!t.available,
    description: t.description,
  }));
}

/** Clamp per-language TTS speed for languageVoiceConfig rows. */
function clampVoiceSpeed(raw, fallback = 1) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return Number.isFinite(Number(fallback)) ? Number(fallback) : 1;
  return Math.max(0.7, Math.min(1.2, Math.round(n * 100) / 100));
}

/**
 * Per-language starting voice map (call-start only).
 * Preview TTS test text is NEVER stored here.
 * Public shape: { 'hi-IN': { voice_id, speed }, ... }
 * Internal may keep provider / provider_voice_id / model (hidden in publicVoice).
 */
function normalizeLanguageVoiceConfig(input, existing) {
  const src = input && typeof input === 'object' && !Array.isArray(input) ? input : null;
  const base = existing && typeof existing === 'object' && !Array.isArray(existing) ? existing : {};
  if (!src && !Object.keys(base).length) return {};
  const out = {};
  const keys = new Set([...Object.keys(base), ...(src ? Object.keys(src) : [])]);
  for (const key of keys) {
    const lang = normalizeLanguage(key, '');
    if (!lang || !LANGUAGE_BY_ID.has(lang)) continue;
    // Allow explicit null delete when patching a single language.
    if (src && Object.prototype.hasOwnProperty.call(src, key) && src[key] == null) {
      continue;
    }
    const rowIn = src && src[key] != null ? src[key] : base[key];
    if (rowIn == null) continue;
    if (typeof rowIn === 'string') {
      const voice_id = String(rowIn).trim().slice(0, 64);
      if (!voice_id) continue;
      out[lang] = { voice_id, speed: 1 };
      continue;
    }
    if (typeof rowIn !== 'object') continue;
    const voice_id = String(
      rowIn.voice_id || rowIn.voiceId || rowIn.speaker || '',
    ).trim().slice(0, 64);
    if (!voice_id) continue;
    const row = {
      voice_id,
      speed: clampVoiceSpeed(rowIn.speed, (base[lang] && base[lang].speed) || 1),
    };
    // Internal resolution hints (never exposed by publicLanguageVoiceConfig).
    const provider = String(rowIn.provider || (base[lang] && base[lang].provider) || '')
      .trim().toLowerCase().slice(0, 40);
    const providerVoiceId = String(
      rowIn.provider_voice_id || rowIn.providerVoiceId
        || (base[lang] && base[lang].provider_voice_id) || voice_id,
    ).trim().slice(0, 64);
    const model = String(rowIn.model || (base[lang] && base[lang].model) || '')
      .trim().slice(0, 64);
    if (provider) row.provider = provider;
    if (providerVoiceId) row.provider_voice_id = providerVoiceId;
    if (model) row.model = model;
    out[lang] = row;
  }
  return out;
}

function publicLanguageVoiceConfig(cfg) {
  const normalized = normalizeLanguageVoiceConfig(cfg);
  const out = {};
  for (const [lang, row] of Object.entries(normalized)) {
    // Hide provider / model / provider_voice_id from normal UI payload.
    out[lang] = {
      voice_id: row.voice_id,
      speed: row.speed,
    };
  }
  return out;
}

function publicVoice(voice) {
  const v = normalizeVoice(voice);
  const tier = VOICE_TIER_BY_ID.get(v.tier) || VOICE_TIER_BY_ID.get(DEFAULT_VOICE_TIER);
  return {
    language: v.language,
    tier: v.tier,
    tierLabel: tier ? tier.label : 'Standard',
    tierAvailable: !!(tier && tier.available),
    // Customer UI never sees raw TTS model / speaker provider ids on primary profile.
    profileLabel: v.tier === 'standard' ? 'Standard voice profile' : (tier ? tier.label : 'Voice profile'),
    // Per-language starting voices (voice_id + speed only). No preview text.
    languageVoiceConfig: publicLanguageVoiceConfig(v.languageVoiceConfig),
  };
}

function normalizeVoice(input, existing) {
  const b = input && typeof input === 'object' ? input : {};
  const base = existing && typeof existing === 'object' ? existing : {};
  const language = normalizeLanguage(
    b.language != null ? b.language : base.language,
    DEFAULT_LANGUAGE,
  );
  const tier = normalizeVoiceTier(
    b.tier != null ? b.tier : base.tier,
    DEFAULT_VOICE_TIER,
  );
  const model = String(b.model != null ? b.model : base.model || 'mulberry').trim().slice(0, 40) || 'mulberry';
  const speaker = String(b.speaker != null ? b.speaker : base.speaker || 'speaker_1').trim().slice(0, 40) || 'speaker_1';
  let f0 = base.f0_up_key != null ? Number(base.f0_up_key) : 0;
  if (b.f0_up_key != null && Number.isFinite(Number(b.f0_up_key))) {
    f0 = Math.max(-12, Math.min(12, Number(b.f0_up_key) | 0));
  }
  const languageVoiceConfig = normalizeLanguageVoiceConfig(
    b.languageVoiceConfig != null ? b.languageVoiceConfig
      : (b.language_voice_config != null ? b.language_voice_config : undefined),
    base.languageVoiceConfig,
  );
  return { language, tier, model, speaker, f0_up_key: f0, languageVoiceConfig };
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
  // Hostinger / legacy rows sometimes store bare action strings.
  if (typeof raw === 'string') {
    const s = String(raw || '').trim();
    if (!s) return null;
    const human = s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).slice(0, 80);
    raw = { key: s, label: human, type: '' };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  let type = String(raw.type || raw.actionType || '').trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_');
  if (!ACTION_TYPE_SET.has(type)) {
    // Infer from key/label when type omitted.
    const hint = String(raw.key || raw.label || raw.name || '').toLowerCase();
    if (hint.includes('callback') || hint.includes('follow') || hint.includes('schedule') || hint.includes('book')) {
      type = 'book_callback';
    } else if (hint.includes('transfer') || hint.includes('human')) {
      type = 'transfer_to_human';
    } else if (hint.includes('webhook') || hint.includes('crm')) {
      type = 'crm_webhook';
    } else if (hint.includes('outcome') || hint.includes('tag') || hint.includes('qualif')) {
      type = 'tag_outcome';
    } else {
      // Preserve unknown legacy strings as book_callback-shaped actions so Next Action
      // still surfaces real workspace intent instead of going empty.
      type = 'book_callback';
    }
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

function publicAssignedNumber(n) {
  if (!n) return null;
  return {
    id: n.id,
    e164: n.e164 || n.address || '',
    label: n.label || '',
    connectionState: n.status === 'assigned' ? 'Connected' : 'Unassigned',
    inboundEnabled: n.inboundEnabled !== false,
    outboundEnabled: n.outboundEnabled !== false,
  };
}

/**
 * Resolve the Phone Number bound to an Employee.
 * Prefer employee.phoneNumberId, then reverse links (assignedEmployeeId /
 * assignedAgentId). Heal one-way link drift so the UI never shows
 * "unassigned" when inventory already points at this employee.
 */
function resolveAssignedNumber(db, employee) {
  if (!employee) return null;
  const numbers = db.phoneNumbers || [];
  let n = null;

  if (employee.phoneNumberId) {
    n = numbers.find((row) => row.id === employee.phoneNumberId) || null;
    // Accept match even when tenantId drifted, as long as the id is exact.
    if (n && n.tenantId && employee.tenantId && n.tenantId !== employee.tenantId) {
      n = null;
    }
  }

  if (!n) {
    n = numbers.find((row) =>
      row.assignedEmployeeId
      && row.assignedEmployeeId === employee.id
      && (!row.tenantId || row.tenantId === employee.tenantId)
    ) || null;
  }

  if (!n && employee.agentId) {
    n = numbers.find((row) =>
      row.status === 'assigned'
      && row.assignedAgentId === employee.agentId
      && (!row.tenantId || row.tenantId === employee.tenantId)
    ) || null;
  }

  // Heal reverse / forward link drift for future reads (in-memory only;
  // persist happens on next mutate that touches numbers).
  if (n) {
    if (!employee.phoneNumberId) employee.phoneNumberId = n.id;
    if (!n.assignedEmployeeId) n.assignedEmployeeId = employee.id;
  }

  return publicAssignedNumber(n);
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
  let phoneConfigSummary = null;
  try {
    const employeePhoneConfig = require('./employee-phone-config');
    phoneConfigSummary = employeePhoneConfig.publicPhoneConfig(db || {}, row, { advanced: false });
  } catch (_) {
    phoneConfigSummary = null;
  }
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
    voice: publicVoice(row.voice),
    outcomes: normalizeOutcomesList(row.outcomes),
    actions: normalizeActionsList(row.actions),
    language: normalizeLanguage((row.voice && row.voice.language) || DEFAULT_LANGUAGE),
    voiceTier: normalizeVoiceTier((row.voice && row.voice.tier) || DEFAULT_VOICE_TIER),
    assignedNumber: number,
    phoneConfig: phoneConfigSummary,
    callbackRules: row.callbackRules && typeof row.callbackRules === 'object'
      ? {
        onBookingConfirmation: row.callbackRules.onBookingConfirmation !== false,
        remindBeforeMinutes: Array.isArray(row.callbackRules.remindBeforeMinutes)
          ? row.callbackRules.remindBeforeMinutes.slice(0, 8)
          : [60, 1440],
        customOffsetsMinutes: Array.isArray(row.callbackRules.customOffsetsMinutes)
          ? row.callbackRules.customOffsetsMinutes.slice(0, 8)
          : [],
        timezone: String(row.callbackRules.timezone || 'Asia/Kolkata'),
      }
      : {
        onBookingConfirmation: true,
        remindBeforeMinutes: [60, 1440],
        customOffsetsMinutes: [],
        timezone: 'Asia/Kolkata',
      },
    agentName: names.agentName,
    workflowName: names.workflowName,
    runtimeConfig: row.runtimeConfig ? {
      hasDraft: !!(row.runtimeConfig.draft),
      hasActive: !!(row.runtimeConfig.active),
      activatedAt: row.runtimeConfig.active && row.runtimeConfig.active.activatedAt
        ? row.runtimeConfig.active.activatedAt : null,
      draftUpdatedAt: row.runtimeConfig.draft && row.runtimeConfig.draft.updatedAt
        ? row.runtimeConfig.draft.updatedAt : null,
      dograhSyncOk: !!(row.runtimeConfig.dograhSync && row.runtimeConfig.dograhSync.ok),
      dograhSyncSkipped: !!(row.runtimeConfig.dograhSync && row.runtimeConfig.dograhSync.skipped),
    } : null,
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

    // Maya flagship is the only preset allowed to bind Dograh workflow 8.
    // Blank / custom / other templates must never inherit Maya persona or WF8.
    const isMayaFlagship = !!(preset && preset.id === 'preset_astranova_eng_receptionist_v1');
    const personaBits = [];
    if (description) personaBits.push(description);
    if (preset && !isMayaFlagship) {
      personaBits.push(`${preset.name}. Collect: ${(preset.fields || []).join(', ')}.`);
    } else if (preset && isMayaFlagship && description) {
      // Keep user brief; preset greeting/persona applied only via applyPresetToAgent.
    }

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

    const agentOverrides = {
      name,
      persona: personaBits.join(' ').slice(0, 1500) || (preset ? undefined : ''),
      greeting: b.greeting != null
        ? String(b.greeting).slice(0, 300)
        : (preset ? undefined : ''),
      agentType: normalizeAgentType(b.agentType || template.agentType, template.agentType || 'custom'),
      direction: channel === 'inbound' ? 'inbound'
        : (channel === 'outbound' || channel === 'instant_lead' || channel === 'campaign') ? 'outbound'
          : 'both',
    };
    // Force isolation: never copy Maya WF8 onto non-flagship employees.
    if (!isMayaFlagship) {
      agentOverrides.dograhWorkflowId = null;
      agentOverrides.dograhWorkflowKey = Object.prototype.hasOwnProperty.call(b, 'dograhWorkflowKey')
        ? b.dograhWorkflowKey
        : (preset && preset.dograhWorkflowKey) || null;
    }

    const agent = applyPresetToAgent(agentBase, preset, agentOverrides);
    if (!agent.name) agent.name = name;
    if (agent.persona == null) agent.persona = description.slice(0, 1500);
    if (agent.greeting == null) agent.greeting = '';
    // Hard guard: blank/custom employees never receive Maya display name or WF8.
    if (!isMayaFlagship) {
      agent.dograhWorkflowId = null;
      if (/^maya$/i.test(String(agent.name || '').trim()) && !/^maya$/i.test(name.trim())) {
        agent.name = name;
      }
    }
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
    // New workflows start with providerWorkflowId null. Never auto-bind WF8.
    if (!isMayaFlagship && wfResult.workflow && wfResult.workflow.providerWorkflowId === '8') {
      wfResult.workflow.providerWorkflowId = null;
    }
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
    callbackRules: {
      onBookingConfirmation: true,
      remindBeforeMinutes: [60, 1440],
      customOffsetsMinutes: [],
      timezone: 'Asia/Kolkata',
    },
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
  if (b.callbackRules !== undefined || b.callback_rules !== undefined) {
    const src = b.callbackRules || b.callback_rules || {};
    if (!src || typeof src !== 'object') {
      return { ok: false, status: 422, error: 'callbackRules must be an object', code: 'bad_callback_rules' };
    }
    const remind = Array.isArray(src.remindBeforeMinutes)
      ? src.remindBeforeMinutes.map((n) => Number(n)).filter((n) => Number.isFinite(n) && n > 0).slice(0, 8)
      : (row.callbackRules && row.callbackRules.remindBeforeMinutes) || [60, 1440];
    const custom = Array.isArray(src.customOffsetsMinutes)
      ? src.customOffsetsMinutes.map((n) => Number(n)).filter((n) => Number.isFinite(n) && n > 0).slice(0, 8)
      : (row.callbackRules && row.callbackRules.customOffsetsMinutes) || [];
    row.callbackRules = {
      onBookingConfirmation: src.onBookingConfirmation !== false,
      remindBeforeMinutes: remind,
      customOffsetsMinutes: custom,
      timezone: String(src.timezone || (row.callbackRules && row.callbackRules.timezone) || 'Asia/Kolkata').slice(0, 64),
    };
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
    const mapped = normalizeLanguage(next, '');
    if (mapped && LANGUAGE_BY_ID.has(mapped) && next) {
      // Only accept alias when normalizeLanguage actually recognized it.
      const lower = next.toLowerCase();
      const known = new Set([
        'en', 'english', 'en-in', 'en-IN',
        'hi', 'hindi', 'hi-in', 'hi-IN',
        'te', 'telugu', 'te-in', 'te-IN',
        'ta', 'tamil', 'ta-in', 'ta-IN',
        'kn', 'kannada', 'kn-in', 'kn-IN',
        'ml', 'malayalam', 'ml-in', 'ml-IN',
        'mr', 'marathi', 'mr-in', 'mr-IN',
        'bn', 'bengali', 'bn-in', 'bn-IN',
        'gu', 'gujarati', 'gu-in', 'gu-IN',
        'pa', 'punjabi', 'pa-in', 'pa-IN',
      ]);
      if (known.has(lower) || known.has(next)) resolved = mapped;
    }
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
 * Save per-language starting voices (voice_id + speed).
 * Preview / TTS test text is rejected and never persisted.
 * Does not mutate Maya production auto / Dograh WF8 / active runtime.
 *
 * Options:
 *   merge: true → patch into existing languageVoiceConfig (per-row save)
 *   seed_from_persona: true → if empty, seed draft from validated persona routes
 */
function setEmployeeLanguageVoiceConfig(db, tenantId, id, input) {
  const row = findEmployee(db, tenantId, id);
  if (!row) return { ok: false, status: 404, error: 'employee not found', code: 'not_found' };
  const body = input && typeof input === 'object' ? input : {};
  const personaRouter = require('./voice-persona-router');
  const voiceCatalog = require('./tts-voice-catalog');

  // Optional draft seed for Maya / persona employees without overwriting production.
  if (body.seed_from_persona === true || body.seedFromPersona === true) {
    const personaId = personaRouter.resolvePersonaId(row);
    const existing = (row.voice && row.voice.languageVoiceConfig) || {};
    const seeded = personaRouter.seedLanguageVoiceConfigFromPersona(personaId, existing);
    if (seeded.ok && seeded.seeded) {
      row.voice = normalizeVoice({
        ...(row.voice || {}),
        languageVoiceConfig: seeded.languageVoiceConfig,
      }, row.voice);
      row.updatedAt = nowIso();
      return {
        ok: true,
        employee: row,
        language: row.voice.language,
        languageVoiceConfig: publicLanguageVoiceConfig(row.voice.languageVoiceConfig),
        seeded: true,
        production_protected: !!seeded.production_protected,
        preview_text_saved: false,
        note: seeded.note,
      };
    }
    if (seeded.ok && !seeded.seeded) {
      return {
        ok: true,
        employee: row,
        language: row.voice.language,
        languageVoiceConfig: publicLanguageVoiceConfig(existing),
        seeded: false,
        preview_text_saved: false,
        reason: seeded.reason || 'already_configured',
      };
    }
  }

  // Accept languageVoiceConfig map, or { configs: [...] } / { rows: [...] }.
  let rawMap = body.languageVoiceConfig || body.language_voice_config || null;
  if (!rawMap && Array.isArray(body.configs || body.rows)) {
    rawMap = {};
    for (const item of (body.configs || body.rows)) {
      if (!item || typeof item !== 'object') continue;
      const lang = normalizeLanguage(item.language || item.id || item.lang, '');
      if (!lang) continue;
      rawMap[lang] = {
        voice_id: item.voice_id || item.voiceId || item.speaker || item.voice,
        speed: item.speed,
      };
    }
  }
  // Single-row patch: { language, voice_id, speed }
  if (!rawMap && (body.voice_id || body.voiceId || body.speaker) && body.language) {
    rawMap = {
      [body.language]: {
        voice_id: body.voice_id || body.voiceId || body.speaker,
        speed: body.speed,
      },
    };
  }
  if (!rawMap || typeof rawMap !== 'object') {
    return {
      ok: false,
      status: 422,
      error: 'languageVoiceConfig required',
      code: 'missing_language_voice_config',
    };
  }

  // Strip preview text; attach internal provider/model resolution hints.
  const cleaned = {};
  for (const [k, v] of Object.entries(rawMap)) {
    if (v == null) continue;
    if (typeof v === 'string') {
      cleaned[k] = { voice_id: v, speed: 1 };
    } else {
      cleaned[k] = {
        voice_id: v.voice_id || v.voiceId || v.speaker || v.voice,
        speed: v.speed,
      };
    }
    const lang = normalizeLanguage(k, '');
    const voiceId = cleaned[k].voice_id;
    if (!voiceId) continue;
    // Resolve internal provider/model from catalog or persona route.
    let provider = '';
    let model = '';
    for (const pid of ['sarvam', 'rumik', 'deepgram']) {
      const hit = voiceCatalog.findVoice(pid, voiceId);
      if (hit) {
        provider = pid;
        model = hit.model || '';
        break;
      }
    }
    if (!provider) {
      const personaId = personaRouter.resolvePersonaId(row);
      const persona = personaId ? personaRouter.getPersona(personaId) : null;
      const route = persona && persona.language_routes && persona.language_routes[lang];
      if (route) {
        provider = route.provider;
        model = route.model || '';
      }
    }
    if (provider) {
      cleaned[k].provider = provider;
      cleaned[k].provider_voice_id = voiceId;
      cleaned[k].model = model;
    }
  }

  const merge = body.merge === true || body.patch === true
    || (
      !body.languageVoiceConfig && !body.language_voice_config
      && !body.configs && !body.rows
      && !!(body.voice_id || body.voiceId || body.speaker)
    );
  const existingCfg = (row.voice && row.voice.languageVoiceConfig) || {};
  const nextCfg = merge
    ? normalizeLanguageVoiceConfig(cleaned, existingCfg)
    : normalizeLanguageVoiceConfig(cleaned, {});
  if (!Object.keys(nextCfg).length) {
    return {
      ok: false,
      status: 422,
      error: 'languageVoiceConfig has no valid language rows',
      code: 'empty_language_voice_config',
    };
  }
  const primaryLanguage = body.primary_language != null
    ? normalizeLanguage(body.primary_language, '')
    : (body.language != null ? normalizeLanguage(body.language, '') : null);
  const voicePatch = {
    ...(row.voice || {}),
    languageVoiceConfig: nextCfg,
  };
  if (primaryLanguage && LANGUAGE_BY_ID.has(primaryLanguage)) {
    voicePatch.language = primaryLanguage;
    if (nextCfg[primaryLanguage] && nextCfg[primaryLanguage].voice_id) {
      voicePatch.speaker = nextCfg[primaryLanguage].voice_id;
    }
  }
  row.voice = normalizeVoice(voicePatch, row.voice);
  row.updatedAt = nowIso();
  return {
    ok: true,
    employee: row,
    language: row.voice.language,
    languageVoiceConfig: publicLanguageVoiceConfig(row.voice.languageVoiceConfig),
    merged: !!merge,
    preview_text_saved: false,
    maya_production_untouched: true,
  };
}

/**
 * Set Employee voice tier. Non-Standard tiers are catalog stubs only and
 * fail closed (cannot be selected for live dials in this release).
 */
function setEmployeeVoiceTier(db, tenantId, id, tier) {
  const row = findEmployee(db, tenantId, id);
  if (!row) return { ok: false, status: 404, error: 'employee not found', code: 'not_found' };
  const next = String(tier || '').trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_');
  const meta = VOICE_TIER_BY_ID.get(next);
  if (!meta) {
    return {
      ok: false,
      status: 422,
      error: 'unsupported voice tier',
      code: 'unsupported_voice_tier',
      tiers: listVoiceTiers(),
    };
  }
  if (!meta.available) {
    return {
      ok: false,
      status: 422,
      error: meta.label + ' is a placeholder. Only Standard is live in this release.',
      code: 'voice_tier_unavailable',
      tiers: listVoiceTiers(),
    };
  }
  row.voice = normalizeVoice({ ...(row.voice || {}), tier: meta.id }, row.voice);
  row.updatedAt = nowIso();
  return {
    ok: true,
    employee: row,
    voiceTier: row.voice.tier,
    tiers: listVoiceTiers(),
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
  VOICE_TIERS,
  DEFAULT_VOICE_TIER,
  ACTION_TYPES,
  ALLOWED_TRANSITIONS,
  ensureEmployees,
  getJobTemplate,
  listJobTemplates,
  listSupportedLanguages,
  listVoiceTiers,
  listActionTypes,
  normalizeStatus,
  normalizeChannel,
  normalizeLanguage,
  normalizeVoiceTier,
  normalizeVoice,
  publicVoice,
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
  setEmployeeLanguageVoiceConfig,
  normalizeLanguageVoiceConfig,
  publicLanguageVoiceConfig,
  clampVoiceSpeed,
  setEmployeeVoiceTier,
  getWorkflow,
  updateWorkflow,
  stepsFromWorkflow,
  genId,
};
