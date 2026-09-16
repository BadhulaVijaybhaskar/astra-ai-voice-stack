/**
 * First-class agent types and the system preset library for Astra AI testing.
 * Billing, plans, and number marketplace are intentionally out of scope here.
 *
 * Dograh workflow binding notes:
 * - Workflow id 8 ("Astanova v2 ENG") is the live inbound English receptionist mapping.
 * - Outbound Jerry callback workflow id is still TBD in Dograh. Presets store
 *   dograhWorkflowKey: 'outbound_callback' until a numeric id is known.
 */
'use strict';

const AGENT_TYPES = Object.freeze([
  Object.freeze({
    id: 'inbound_receptionist',
    label: 'Inbound Receptionist',
    description: 'Answers inbound phone calls, greets callers, and routes or books.',
    direction: 'inbound',
    recommendedPresetIds: Object.freeze([
      'preset_astranova_eng_receptionist_v1',
      'preset_receptionist_v1',
      'preset_dental_receptionist_v1',
      'preset_restaurant_v1',
      'preset_appointment_v1',
    ]),
  }),
  Object.freeze({
    id: 'outbound_callback',
    label: 'Outbound Callback',
    description: 'Places follow-up calls when someone asks to be called anytime.',
    direction: 'outbound',
    recommendedPresetIds: Object.freeze([
      'preset_astranova_outbound_jerry_v1',
    ]),
  }),
  Object.freeze({
    id: 'lead_qualifier',
    label: 'Lead Qualifier',
    description: 'Qualifies sales leads and books the right next step.',
    direction: 'both',
    recommendedPresetIds: Object.freeze([
      'preset_lead_qualification_v1',
      'preset_real_estate_v1',
    ]),
  }),
  Object.freeze({
    id: 'support',
    label: 'Customer Support',
    description: 'Handles support issues, captures details, and escalates safely.',
    direction: 'inbound',
    recommendedPresetIds: Object.freeze([
      'preset_customer_support_v1',
      'preset_personal_injury_v1',
    ]),
  }),
  Object.freeze({
    id: 'custom',
    label: 'Custom',
    description: 'Start blank and write your own persona, greeting, and flow.',
    direction: 'both',
    recommendedPresetIds: Object.freeze([]),
  }),
]);

const AGENT_TYPE_IDS = new Set(AGENT_TYPES.map((t) => t.id));

const PRESET_LIBRARY = Object.freeze([
  Object.freeze({
    id: 'preset_astranova_eng_receptionist_v1',
    slug: 'astranova-english-receptionist',
    version: 1,
    name: 'AstraNova English Receptionist',
    category: 'reception',
    agentType: 'inbound_receptionist',
    direction: 'inbound',
    dograhWorkflowId: 8,
    dograhWorkflowKey: null,
    isSystem: true,
    description: 'Live inbound English receptionist aligned with AstraNova Receptionist workflow.',
    greeting: 'Thank you for calling AstraNova. I am the AI receptionist. How may I help you today?',
    fields: ['caller_name', 'callback_number', 'reason', 'department', 'urgency', 'message', 'preferred_follow_up'],
    guardrails: ['Disclose AI identity', 'Escalate emergencies', 'Do not reveal private staff or customer information', 'Confirm callback details before ending'],
  }),
  Object.freeze({
    id: 'preset_astranova_outbound_jerry_v1',
    slug: 'astranova-outbound-callback-jerry',
    version: 1,
    name: 'AstraNova Outbound Callback (Jerry)',
    category: 'outbound',
    agentType: 'outbound_callback',
    direction: 'outbound',
    dograhWorkflowId: null,
    dograhWorkflowKey: 'outbound_callback',
    isSystem: true,
    description: 'Outbound permission check, discovery questions, then reschedule.',
    greeting: 'Hi, this is Jerry calling from AstraNova. Is now still a good time to talk for a minute?',
    fields: ['permission_to_continue', 'caller_name', 'callback_number', 'reason_for_callback', 'discovery_notes', 'preferred_reschedule'],
    guardrails: ['Get permission before continuing', 'Respect opt-out immediately', 'Never invent availability', 'Confirm any reschedule details aloud'],
  }),
  Object.freeze({
    id: 'preset_personal_injury_v1',
    slug: 'personal-injury-intake',
    version: 1,
    name: 'Personal Injury Intake',
    category: 'legal',
    agentType: 'support',
    direction: 'inbound',
    dograhWorkflowId: null,
    dograhWorkflowKey: null,
    isSystem: true,
    description: 'Consent-aware intake that captures incident details without giving legal advice.',
    greeting: 'Thank you for calling. I am an AI intake assistant and this call may be recorded. Are you in immediate danger or need emergency medical help?',
    fields: ['caller_name', 'callback_number', 'adverse_parties', 'incident_date', 'incident_location', 'incident_type', 'injuries', 'treatment', 'insurance', 'represented', 'deadline_risk', 'preferred_appointment'],
    guardrails: ['No legal advice', 'No case valuation', 'Escalate emergencies and deadline risk', 'Attorney decides case acceptance'],
  }),
  Object.freeze({
    id: 'preset_dental_receptionist_v1',
    slug: 'dental-receptionist',
    version: 1,
    name: 'Dental Receptionist',
    category: 'healthcare',
    agentType: 'inbound_receptionist',
    direction: 'inbound',
    dograhWorkflowId: null,
    dograhWorkflowKey: null,
    isSystem: true,
    description: 'Books dental appointments and escalates medical emergencies.',
    greeting: 'Thank you for calling. I am the practice AI receptionist and this call may be recorded. How can I help today?',
    fields: ['caller_name', 'callback_number', 'new_or_existing_patient', 'reason', 'pain_level', 'emergency_signs', 'insurance', 'preferred_appointment'],
    guardrails: ['No diagnosis', 'Escalate breathing, bleeding, trauma, or severe swelling', 'Confirm booking details'],
  }),
  Object.freeze({
    id: 'preset_real_estate_v1',
    slug: 'real-estate-lead',
    version: 1,
    name: 'Real Estate Lead Qualifier',
    category: 'real_estate',
    agentType: 'lead_qualifier',
    direction: 'both',
    dograhWorkflowId: null,
    dograhWorkflowKey: null,
    isSystem: true,
    description: 'Qualifies buy, sell, and rent intent, then books a viewing or callback.',
    greeting: 'Thanks for calling. I am the AI property assistant. Are you looking to buy, sell, rent, or schedule a viewing?',
    fields: ['caller_name', 'callback_number', 'intent', 'location', 'budget', 'timeline', 'financing', 'property_type', 'preferred_appointment'],
    guardrails: ['Do not promise availability or returns', 'Escalate fair housing questions', 'Confirm consent before follow-up'],
  }),
  Object.freeze({
    id: 'preset_restaurant_v1',
    slug: 'restaurant-reservations',
    version: 1,
    name: 'Restaurant Reservations',
    category: 'hospitality',
    agentType: 'inbound_receptionist',
    direction: 'inbound',
    dograhWorkflowId: null,
    dograhWorkflowKey: null,
    isSystem: true,
    description: 'Takes reservations and answers basic restaurant questions.',
    greeting: 'Thank you for calling. I can help with a reservation, opening hours, directions, or a general question.',
    fields: ['caller_name', 'callback_number', 'party_size', 'date', 'time', 'dietary_needs', 'occasion', 'special_requests'],
    guardrails: ['Never confirm unavailable inventory', 'Escalate allergy questions to staff', 'Read back reservation details'],
  }),
  Object.freeze({
    id: 'preset_appointment_v1',
    slug: 'appointment-booking',
    version: 1,
    name: 'Appointment Booking',
    category: 'scheduling',
    agentType: 'inbound_receptionist',
    direction: 'inbound',
    dograhWorkflowId: null,
    dograhWorkflowKey: null,
    isSystem: true,
    description: 'Schedules, moves, or cancels appointments with timezone confirmation.',
    greeting: 'Thanks for calling. I can help you schedule, move, or cancel an appointment.',
    fields: ['caller_name', 'callback_number', 'appointment_type', 'preferred_date', 'preferred_time', 'timezone', 'notes'],
    guardrails: ['Confirm timezone', 'Never invent calendar availability', 'Read back the final appointment'],
  }),
  Object.freeze({
    id: 'preset_customer_support_v1',
    slug: 'customer-support',
    version: 1,
    name: 'Customer Support',
    category: 'support',
    agentType: 'support',
    direction: 'inbound',
    dograhWorkflowId: null,
    dograhWorkflowKey: null,
    isSystem: true,
    description: 'Captures issue details and routes securely without collecting secrets.',
    greeting: 'Thanks for contacting support. I am an AI assistant. Tell me what happened and I will help or route you to the right person.',
    fields: ['caller_name', 'callback_number', 'account_reference', 'issue_category', 'issue_summary', 'steps_tried', 'preferred_resolution'],
    guardrails: ['Never request passwords or full payment credentials', 'Escalate security incidents', 'Do not promise refunds'],
  }),
  Object.freeze({
    id: 'preset_lead_qualification_v1',
    slug: 'lead-qualification',
    version: 1,
    name: 'Lead Qualification',
    category: 'sales',
    agentType: 'lead_qualifier',
    direction: 'both',
    dograhWorkflowId: null,
    dograhWorkflowKey: null,
    isSystem: true,
    description: 'Runs a short BANT-style discovery and books the next sales step.',
    greeting: 'Thanks for your interest. I am an AI assistant. I will ask a few quick questions and help you book the right next step.',
    fields: ['caller_name', 'company', 'callback_number', 'email', 'need', 'budget', 'authority', 'timeline', 'preferred_appointment'],
    guardrails: ['Disclose AI identity', 'Do not make unsupported product claims', 'Respect opt-out requests immediately'],
  }),
  Object.freeze({
    id: 'preset_receptionist_v1',
    slug: 'general-receptionist',
    version: 1,
    name: 'AI Receptionist',
    category: 'reception',
    agentType: 'inbound_receptionist',
    direction: 'inbound',
    dograhWorkflowId: null,
    dograhWorkflowKey: null,
    isSystem: true,
    description: 'General inbound receptionist for routing, messages, and follow-ups.',
    greeting: 'Thank you for calling. I am the AI receptionist. How may I direct your call today?',
    fields: ['caller_name', 'callback_number', 'reason', 'department', 'urgency', 'message', 'preferred_follow_up'],
    guardrails: ['Disclose AI identity', 'Escalate emergencies', 'Do not reveal private staff or customer information'],
  }),
]);

function getAgentType(id) {
  return AGENT_TYPES.find((t) => t.id === id) || null;
}

function normalizeAgentType(id, fallback = 'custom') {
  const value = String(id || '').trim();
  return AGENT_TYPE_IDS.has(value) ? value : fallback;
}

function publicPreset(preset) {
  if (!preset) return null;
  const out = {
    id: preset.id,
    slug: preset.slug,
    version: preset.version,
    name: preset.name,
    category: preset.category,
    agentType: preset.agentType || 'custom',
    direction: preset.direction || 'both',
    description: preset.description || '',
    greeting: preset.greeting,
    fields: preset.fields || [],
    guardrails: preset.guardrails || [],
    isSystem: !!preset.isSystem,
    tenantId: preset.tenantId || null,
    createdAt: preset.createdAt || null,
  };
  // Dograh workflow ids stay server-side. Opaque keys may appear for outbound
  // presets that do not yet have a numeric provider id.
  if (preset.dograhWorkflowKey) out.workflowKey = preset.dograhWorkflowKey;
  if (preset.recommendedPrivacyMode) out.recommendedPrivacyMode = preset.recommendedPrivacyMode;
  return out;
}

function seedPresets(db) {
  const now = new Date().toISOString();
  for (const preset of PRESET_LIBRARY) {
    const existing = db.presets.find((p) => p.id === preset.id);
    if (!existing) {
      db.presets.push({ ...preset, createdAt: now });
      continue;
    }
    if (!existing.isSystem && existing.tenantId) continue;
    const createdAt = existing.createdAt || now;
    Object.assign(existing, { ...preset, createdAt });
  }
  return db.presets;
}

function personaFromPreset(preset) {
  if (!preset) return '';
  return `${preset.name}. Collect: ${(preset.fields || []).join(', ')}. Guardrails: ${(preset.guardrails || []).join('; ')}.`;
}

/**
 * Copy type + Dograh workflow binding from a preset onto an agent record.
 * Explicit request fields win over preset defaults for name/persona/greeting.
 */
function applyPresetToAgent(agent, preset, overrides = {}) {
  const next = agent || {};
  if (preset) {
    next.presetId = preset.id;
    next.agentType = normalizeAgentType(overrides.agentType || preset.agentType, 'custom');
    next.direction = overrides.direction || preset.direction || 'both';
    if (Object.prototype.hasOwnProperty.call(overrides, 'dograhWorkflowId')) {
      next.dograhWorkflowId = overrides.dograhWorkflowId;
    } else if (preset.dograhWorkflowId != null) {
      next.dograhWorkflowId = preset.dograhWorkflowId;
    } else {
      next.dograhWorkflowId = null;
    }
    if (Object.prototype.hasOwnProperty.call(overrides, 'dograhWorkflowKey')) {
      next.dograhWorkflowKey = overrides.dograhWorkflowKey;
    } else {
      next.dograhWorkflowKey = preset.dograhWorkflowKey || null;
    }
    if (overrides.name == null) next.name = String(preset.name || 'Untitled Agent').slice(0, 60);
    if (overrides.persona == null) next.persona = personaFromPreset(preset).slice(0, 1500);
    if (overrides.greeting == null) next.greeting = String(preset.greeting || '').slice(0, 300);
  } else {
    next.presetId = null;
    next.agentType = normalizeAgentType(overrides.agentType, 'custom');
    next.direction = overrides.direction || (getAgentType(next.agentType) || {}).direction || 'both';
    next.dograhWorkflowId = Object.prototype.hasOwnProperty.call(overrides, 'dograhWorkflowId')
      ? overrides.dograhWorkflowId
      : null;
    next.dograhWorkflowKey = Object.prototype.hasOwnProperty.call(overrides, 'dograhWorkflowKey')
      ? overrides.dograhWorkflowKey
      : null;
  }

  if (overrides.name != null) next.name = String(overrides.name).slice(0, 60);
  if (overrides.persona != null) next.persona = String(overrides.persona).slice(0, 1500);
  if (overrides.greeting != null) next.greeting = String(overrides.greeting).slice(0, 300);
  return next;
}

module.exports = {
  AGENT_TYPES,
  AGENT_TYPE_IDS,
  PRESET_LIBRARY,
  getAgentType,
  normalizeAgentType,
  publicPreset,
  seedPresets,
  personaFromPreset,
  applyPresetToAgent,
};
