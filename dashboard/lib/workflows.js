/**
 * Astra AI. First-class workflow control-plane resources.
 *
 * Canonical graph lives in Astra (workflows collection). Dograh is execution
 * only. Customers never manage Dograh workflow ids in the UI. Super Admin may
 * see provider mappings and sync status.
 *
 * No em dashes anywhere. Commas and periods only.
 */
'use strict';

const crypto = require('crypto');

const PROVIDER_ID = 'dograh';
const STATUSES = new Set(['draft', 'published', 'archived']);
const DIRECTIONS = new Set(['inbound', 'outbound', 'both']);

const SEED_RECEPTIONIST = Object.freeze({
  name: 'AstraNova Receptionist',
  description: 'Inbound English receptionist for AstraNova live testing.',
  templateKey: 'receptionist',
  direction: 'inbound',
  providerWorkflowId: '8',
});

function genId(prefix) {
  return prefix + crypto.randomBytes(8).toString('hex');
}

function nowIso() {
  return new Date().toISOString();
}

function node(id, type, name, prompt, next) {
  return {
    id,
    type,
    name,
    prompt,
    next: next || null,
  };
}

/** Build a linear multi-step graph (start → stages → end) plus a global node. */
function buildLinearGraph(stages, globalPrompt) {
  const nodes = [];
  const startId = 'start';
  const endId = 'end';
  const globalId = 'global';
  const stageIds = stages.map((_, i) => 'stage_' + (i + 1));

  nodes.push(node(
    startId,
    'start',
    'Start call',
    stages[0] ? ('Open the call, then move into: ' + stages[0].name + '.') : 'Greet the caller and begin.',
    stageIds[0] || endId,
  ));

  stages.forEach((stage, i) => {
    nodes.push(node(
      stageIds[i],
      'agent',
      stage.name,
      stage.prompt,
      stageIds[i + 1] || endId,
    ));
  });

  nodes.push(node(
    endId,
    'end',
    'End call',
    'Close warmly in one short sentence and stop talking.',
    null,
  ));

  nodes.push(node(
    globalId,
    'global',
    'Global rules',
    globalPrompt || 'Speak in one or two short sentences. Disclose AI identity. Escalate emergencies. Never invent facts.',
    null,
  ));

  return { version: 1, nodes };
}

const WORKFLOW_TEMPLATES = Object.freeze([
  Object.freeze({
    key: 'receptionist',
    name: 'Receptionist',
    description: 'Answer inbound calls, greet callers, capture intent, and route or take a message.',
    direction: 'inbound',
    graph: () => buildLinearGraph([
      {
        name: 'Greet and identify',
        prompt: 'Greet the caller, disclose you are an AI receptionist, and ask how you can help.',
      },
      {
        name: 'Capture intent',
        prompt: 'Learn why they called. Capture name, callback number, department or reason, and urgency.',
      },
      {
        name: 'Route or message',
        prompt: 'Route to the right team when possible, otherwise take a clear message and confirm follow-up.',
      },
    ], 'You are an inbound AI receptionist. Warm, brief, and precise. Escalate emergencies. Do not reveal private staff details.'),
  }),
  Object.freeze({
    key: 'outbound_sales',
    name: 'Outbound sales',
    description: 'Permission check, discovery, then book or reschedule. Matches the outbound callback pattern.',
    direction: 'outbound',
    graph: () => buildLinearGraph([
      {
        name: 'Permission',
        prompt: 'Confirm it is still a good time to talk. If not, offer to reschedule and stop politely.',
      },
      {
        name: 'Discovery',
        prompt: 'Ask short discovery questions about need, timeline, and decision maker. Capture notes.',
      },
      {
        name: 'Reschedule or book',
        prompt: 'Book the next step or reschedule. Confirm details aloud. Respect opt-out immediately.',
      },
    ], 'You are an outbound AI sales assistant. Get permission before continuing. Never invent availability. Speak briefly.'),
  }),
  Object.freeze({
    key: 'support',
    name: 'Support',
    description: 'Capture issue details, troubleshoot lightly, and escalate securely.',
    direction: 'inbound',
    graph: () => buildLinearGraph([
      { name: 'Intake', prompt: 'Acknowledge the issue and capture account reference plus a short summary.' },
      { name: 'Diagnose', prompt: 'Ask what they already tried. Offer one or two safe next steps.' },
      { name: 'Resolve or escalate', prompt: 'Confirm resolution or escalate. Never request passwords or full payment credentials.' },
    ], 'You are an AI support agent. Never collect secrets. Escalate security incidents.'),
  }),
  Object.freeze({
    key: 'appointment',
    name: 'Appointment',
    description: 'Schedule, move, or cancel appointments with timezone confirmation.',
    direction: 'inbound',
    graph: () => buildLinearGraph([
      { name: 'Intent', prompt: 'Ask whether they want to schedule, move, or cancel.' },
      { name: 'Details', prompt: 'Capture appointment type, preferred date, time, and timezone.' },
      { name: 'Confirm', prompt: 'Read back the final appointment. Never invent calendar availability.' },
    ], 'You are an AI scheduling assistant. Confirm timezone. Never invent slots.'),
  }),
  Object.freeze({
    key: 'lead_qual',
    name: 'Lead qualification',
    description: 'Short BANT-style discovery and book the right next sales step.',
    direction: 'both',
    graph: () => buildLinearGraph([
      { name: 'Qualify need', prompt: 'Learn the need and company context in a few short questions.' },
      { name: 'Budget and timing', prompt: 'Capture budget range, authority, and timeline without being pushy.' },
      { name: 'Next step', prompt: 'Book a follow-up or handoff. Confirm contact details.' },
    ], 'You are an AI lead qualifier. Disclose AI identity. Respect opt-out immediately.'),
  }),
  Object.freeze({
    key: 'payment_reminder',
    name: 'Payment reminder',
    description: 'Polite outbound reminder with confirmation and escalation paths.',
    direction: 'outbound',
    graph: () => buildLinearGraph([
      { name: 'Permission', prompt: 'Confirm it is a good time. State you are calling about a payment reminder.' },
      { name: 'Reminder', prompt: 'Share the amount due and due date if known. Offer payment options without collecting full card numbers.' },
      { name: 'Close', prompt: 'Confirm next action or schedule a callback. Stay respectful.' },
    ], 'You are an AI collections assistant. Be respectful. Never demand full payment credentials on the call.'),
  }),
  Object.freeze({
    key: 'survey',
    name: 'Survey',
    description: 'Short post-call or outbound survey with structured capture.',
    direction: 'outbound',
    graph: () => buildLinearGraph([
      { name: 'Consent', prompt: 'Ask if they have one minute for a short survey.' },
      { name: 'Questions', prompt: 'Ask three short rating or yes/no questions. Capture answers.' },
      { name: 'Thanks', prompt: 'Thank them and end the call warmly.' },
    ], 'You are an AI survey agent. Keep it short. Stop immediately on opt-out.'),
  }),
  Object.freeze({
    key: 'blank',
    name: 'Blank',
    description: 'Empty multi-step canvas. Add your own stages.',
    direction: 'both',
    graph: () => buildLinearGraph([
      { name: 'Main conversation', prompt: 'Help the caller with their request in one or two short sentences per turn.' },
    ], 'You are an AI voice agent. Speak briefly. Disclose AI identity when asked.'),
  }),
]);

function getTemplate(key) {
  return WORKFLOW_TEMPLATES.find((t) => t.key === String(key || '')) || null;
}

function listTemplates() {
  return WORKFLOW_TEMPLATES.map((t) => ({
    key: t.key,
    name: t.name,
    description: t.description,
    direction: t.direction,
  }));
}

function ensureCollections(db) {
  if (!Array.isArray(db.workflows)) db.workflows = [];
  if (!Array.isArray(db.providerResources)) db.providerResources = [];
}

function upsertProviderResource(db, workflow) {
  ensureCollections(db);
  const providerResourceId = workflow.providerWorkflowId != null
    ? String(workflow.providerWorkflowId)
    : '';
  let row = db.providerResources.find((r) =>
    r.astraResourceId === workflow.id && r.resourceType === 'workflow');
  const ts = nowIso();
  const meta = {
    providerWorkflowId: providerResourceId || null,
    syncStatus: workflow.syncStatus || null,
    syncError: workflow.syncError || null,
    name: workflow.name,
    direction: workflow.direction,
    version: workflow.version,
  };
  if (!row) {
    if (!providerResourceId) return null;
    row = {
      id: genId('pr_'),
      astraResourceId: workflow.id,
      resourceType: 'workflow',
      provider: workflow.provider || PROVIDER_ID,
      providerResourceId,
      metadata: meta,
      createdAt: ts,
      updatedAt: ts,
    };
    db.providerResources.push(row);
  } else {
    if (providerResourceId) row.providerResourceId = providerResourceId;
    row.provider = workflow.provider || PROVIDER_ID;
    row.metadata = meta;
    row.updatedAt = ts;
  }
  return row;
}

function assignedNumberForWorkflow(db, workflow) {
  if (!workflow) return null;
  const numbers = (db.phoneNumbers || []).filter((n) =>
    n.tenantId === workflow.tenantId
    && n.status === 'assigned'
    && (n.inboundWorkflowId === workflow.id || n.outboundWorkflowId === workflow.id));
  return numbers[0] || null;
}

/**
 * Public JSON. providerWorkflowId and sync details only for super_admin.
 */
function publicWorkflow(row, opts = {}) {
  if (!row) return null;
  const includeProvider = !!opts.includeProvider;
  const agentsById = opts.agentsById || null;
  const number = opts.assignedNumber || null;
  const agent = row.agentId && agentsById ? agentsById.get(row.agentId) : null;
  const out = {
    id: row.id,
    name: row.name,
    description: row.description || '',
    type: row.type || row.templateKey || 'blank',
    templateKey: row.templateKey || row.type || 'blank',
    direction: row.direction || 'both',
    status: row.status || 'draft',
    version: Number(row.version) || 1,
    graphJson: row.graphJson && typeof row.graphJson === 'object' ? row.graphJson : { version: 1, nodes: [] },
    agentId: row.agentId || null,
    agentName: agent ? agent.name : null,
    assignedNumberId: number ? number.id : null,
    assignedNumberE164: number ? number.e164 : null,
    syncStatus: row.syncStatus || null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    publishedAt: row.publishedAt || null,
  };
  if (includeProvider) {
    out.provider = row.provider || PROVIDER_ID;
    out.providerWorkflowId = row.providerWorkflowId != null ? String(row.providerWorkflowId) : null;
    out.syncError = row.syncError || null;
  }
  return out;
}

function listWorkflows(db, tenantId) {
  ensureCollections(db);
  return (db.workflows || [])
    .filter((w) => w.tenantId === tenantId && w.status !== 'purged')
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
}

function findWorkflow(db, tenantId, id) {
  ensureCollections(db);
  return (db.workflows || []).find((w) => w.id === String(id || '') && w.tenantId === tenantId) || null;
}

function findWorkflowByProviderId(db, tenantId, providerWorkflowId) {
  ensureCollections(db);
  const pid = String(providerWorkflowId || '').trim();
  if (!pid) return null;
  return (db.workflows || []).find((w) =>
    w.tenantId === tenantId
    && w.providerWorkflowId != null
    && String(w.providerWorkflowId) === pid) || null;
}

function resolveProviderWorkflowId(db, tenantId, astraWorkflowId) {
  if (!astraWorkflowId) return null;
  const wf = findWorkflow(db, tenantId, astraWorkflowId);
  if (!wf || wf.providerWorkflowId == null || wf.providerWorkflowId === '') return null;
  const n = Number(wf.providerWorkflowId);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function createWorkflow(db, tenantId, input, actorUserId) {
  ensureCollections(db);
  const b = input && typeof input === 'object' ? input : {};
  const templateKey = String(b.templateKey || b.type || 'blank').trim() || 'blank';
  const template = getTemplate(templateKey) || getTemplate('blank');
  const name = String(b.name || (template && template.name) || 'Untitled workflow').trim().slice(0, 120);
  if (!name) return { ok: false, status: 422, error: 'name is required', code: 'bad_name' };

  let agentId = b.agentId ? String(b.agentId) : null;
  if (agentId) {
    const agent = (db.agents || []).find((a) => a.id === agentId && a.tenantId === tenantId);
    if (!agent) return { ok: false, status: 404, error: 'agent not found', code: 'agent_not_found' };
  }

  const direction = DIRECTIONS.has(b.direction) ? b.direction
    : (template && template.direction) || 'both';
  const graphJson = b.graphJson && typeof b.graphJson === 'object'
    ? b.graphJson
    : (template ? template.graph() : buildLinearGraph([], ''));

  const ts = nowIso();
  const row = {
    id: genId('wf_'),
    tenantId,
    name,
    description: String(b.description || (template && template.description) || '').slice(0, 500),
    type: templateKey,
    templateKey,
    direction,
    status: 'draft',
    version: 1,
    graphJson,
    agentId,
    provider: PROVIDER_ID,
    providerWorkflowId: null,
    syncStatus: null,
    syncError: null,
    createdBy: actorUserId || null,
    createdAt: ts,
    updatedAt: ts,
    publishedAt: null,
  };
  db.workflows.push(row);
  return { ok: true, workflow: row };
}

function updateWorkflow(db, tenantId, id, patch) {
  const row = findWorkflow(db, tenantId, id);
  if (!row) return { ok: false, status: 404, error: 'workflow not found', code: 'not_found' };
  if (row.status === 'archived') {
    return { ok: false, status: 409, error: 'archived workflows cannot be edited', code: 'archived' };
  }
  const b = patch && typeof patch === 'object' ? patch : {};
  if (b.name != null) {
    const name = String(b.name).trim().slice(0, 120);
    if (!name) return { ok: false, status: 422, error: 'name is required', code: 'bad_name' };
    row.name = name;
  }
  if (b.description != null) row.description = String(b.description).slice(0, 500);
  if (b.direction != null) {
    if (!DIRECTIONS.has(b.direction)) {
      return { ok: false, status: 422, error: 'direction must be inbound, outbound, or both', code: 'bad_direction' };
    }
    row.direction = b.direction;
  }
  if (Object.prototype.hasOwnProperty.call(b, 'agentId')) {
    if (b.agentId) {
      const agent = (db.agents || []).find((a) => a.id === String(b.agentId) && a.tenantId === tenantId);
      if (!agent) return { ok: false, status: 404, error: 'agent not found', code: 'agent_not_found' };
      row.agentId = agent.id;
    } else {
      row.agentId = null;
    }
  }
  if (b.graphJson != null) {
    if (typeof b.graphJson !== 'object' || Array.isArray(b.graphJson)) {
      return { ok: false, status: 422, error: 'graphJson must be an object', code: 'bad_graph' };
    }
    row.graphJson = b.graphJson;
    if (row.status === 'published') {
      // Saving a published graph keeps status published but bumps local version.
      row.version = (Number(row.version) || 1) + 1;
      row.syncStatus = row.syncStatus === 'synced' ? 'pending' : (row.syncStatus || 'pending');
    }
  }
  row.updatedAt = nowIso();
  return { ok: true, workflow: row };
}

function markPublished(db, workflow, mapping) {
  const ts = nowIso();
  workflow.status = 'published';
  workflow.publishedAt = workflow.publishedAt || ts;
  workflow.updatedAt = ts;
  workflow.version = (Number(workflow.version) || 1);
  if (mapping && mapping.providerWorkflowId != null) {
    workflow.providerWorkflowId = String(mapping.providerWorkflowId);
  }
  workflow.syncStatus = mapping && mapping.syncStatus ? mapping.syncStatus : 'synced';
  workflow.syncError = mapping && mapping.syncError ? String(mapping.syncError).slice(0, 500) : null;
  upsertProviderResource(db, workflow);
  return workflow;
}

function archiveWorkflow(db, tenantId, id) {
  const row = findWorkflow(db, tenantId, id);
  if (!row) return { ok: false, status: 404, error: 'workflow not found', code: 'not_found' };
  row.status = 'archived';
  row.updatedAt = nowIso();
  return { ok: true, workflow: row };
}

/**
 * Import an existing Dograh workflow id as a published Astra wrapper.
 * Idempotent per tenant + providerWorkflowId.
 */
function importFromProvider(db, tenantId, input, actorUserId) {
  ensureCollections(db);
  const b = input && typeof input === 'object' ? input : {};
  const providerWorkflowId = String(b.providerWorkflowId || '').trim();
  if (!providerWorkflowId) {
    return { ok: false, status: 422, error: 'providerWorkflowId is required', code: 'validation' };
  }

  const existing = findWorkflowByProviderId(db, tenantId, providerWorkflowId);
  if (existing) {
    return { ok: true, workflow: existing, created: false };
  }

  const templateKey = String(b.templateKey || 'receptionist').trim() || 'receptionist';
  const template = getTemplate(templateKey) || getTemplate('receptionist');
  const name = String(b.name || SEED_RECEPTIONIST.name).trim().slice(0, 120);
  const direction = DIRECTIONS.has(b.direction) ? b.direction
    : (template && template.direction) || 'inbound';
  const graphJson = b.graphJson && typeof b.graphJson === 'object'
    ? b.graphJson
    : (template ? template.graph() : buildLinearGraph([], ''));

  const ts = nowIso();
  const row = {
    id: genId('wf_'),
    tenantId,
    name,
    description: String(b.description || SEED_RECEPTIONIST.description).slice(0, 500),
    type: templateKey,
    templateKey,
    direction,
    status: 'published',
    version: 1,
    graphJson,
    agentId: b.agentId ? String(b.agentId) : null,
    provider: PROVIDER_ID,
    providerWorkflowId,
    syncStatus: b.syncStatus || 'imported',
    syncError: b.syncError || null,
    createdBy: actorUserId || null,
    createdAt: ts,
    updatedAt: ts,
    publishedAt: ts,
  };
  db.workflows.push(row);
  upsertProviderResource(db, row);
  return { ok: true, workflow: row, created: true };
}

/**
 * Seed the live Dograh workflow 8 as published "AstraNova Receptionist"
 * for each tenant (idempotent).
 */
function seedTenantReceptionist(db, tenantId, actorUserId) {
  ensureCollections(db);
  const existing = findWorkflowByProviderId(db, tenantId, SEED_RECEPTIONIST.providerWorkflowId);
  if (existing) {
    // Keep Astra customer-facing name stable.
    if (existing.name !== SEED_RECEPTIONIST.name) existing.name = SEED_RECEPTIONIST.name;
    if (existing.status !== 'published') {
      existing.status = 'published';
      existing.publishedAt = existing.publishedAt || nowIso();
    }
    existing.providerWorkflowId = SEED_RECEPTIONIST.providerWorkflowId;
    existing.direction = 'inbound';
    existing.templateKey = 'receptionist';
    existing.type = 'receptionist';
    existing.syncStatus = existing.syncStatus || 'imported';
    existing.updatedAt = nowIso();
    upsertProviderResource(db, existing);
    return existing;
  }
  const result = importFromProvider(db, tenantId, {
    providerWorkflowId: SEED_RECEPTIONIST.providerWorkflowId,
    name: SEED_RECEPTIONIST.name,
    description: SEED_RECEPTIONIST.description,
    templateKey: SEED_RECEPTIONIST.templateKey,
    direction: SEED_RECEPTIONIST.direction,
    syncStatus: 'imported',
  }, actorUserId);
  return result.workflow;
}

function seedAllTenants(db) {
  ensureCollections(db);
  const out = [];
  for (const tenant of db.tenants || []) {
    out.push(seedTenantReceptionist(db, tenant.id, null));
  }
  return out;
}

function toDograhLikeGraph(graphJson) {
  const g = graphJson && typeof graphJson === 'object' ? graphJson : { nodes: [] };
  const nodes = Array.isArray(g.nodes) ? g.nodes : [];
  // Passthrough when already Dograh-shaped (type + data.prompt).
  if (nodes.some((n) => n && n.data && typeof n.data === 'object')) {
    return { nodes, edges: Array.isArray(g.edges) ? g.edges : [] };
  }
  // Convert Astra linear nodes into a Dograh-like node list.
  const mapped = nodes.map((n, i) => {
    const typeMap = {
      start: 'startCall',
      end: 'endCall',
      global: 'globalNode',
      agent: 'agentNode',
    };
    return {
      id: String(n.id || i + 1),
      type: typeMap[n.type] || 'agentNode',
      position: { x: 120, y: 80 + i * 160 },
      data: {
        name: n.name || n.type || 'Node',
        prompt: n.prompt || '',
        allow_interrupt: n.type !== 'end',
        add_global_prompt: n.type !== 'global',
        is_start: n.type === 'start',
      },
    };
  });
  const edges = [];
  for (const n of nodes) {
    if (n && n.next) {
      edges.push({
        id: 'e_' + n.id + '_' + n.next,
        source: String(n.id),
        target: String(n.next),
      });
    }
  }
  return { nodes: mapped, edges };
}

module.exports = {
  PROVIDER_ID,
  STATUSES,
  DIRECTIONS,
  SEED_RECEPTIONIST,
  WORKFLOW_TEMPLATES,
  getTemplate,
  listTemplates,
  ensureCollections,
  upsertProviderResource,
  assignedNumberForWorkflow,
  publicWorkflow,
  listWorkflows,
  findWorkflow,
  findWorkflowByProviderId,
  resolveProviderWorkflowId,
  createWorkflow,
  updateWorkflow,
  markPublished,
  archiveWorkflow,
  importFromProvider,
  seedTenantReceptionist,
  seedAllTenants,
  toDograhLikeGraph,
  buildLinearGraph,
  genId,
  nowIso,
};
