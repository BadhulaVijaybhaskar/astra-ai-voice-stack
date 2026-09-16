/**
 * Astra AI. First-class phone number resources (tenant-scoped JSON store).
 *
 * Numbers are Astra resources. Customers never see Dograh or VoBiz branding.
 * Provider mapping (dograhTelephonyConfigId, dograhPhoneNumberId, etc.) stays
 * server-side in providerMetadata. Purchase is out of scope for the V1 test
 * inventory phase.
 *
 * No em dashes anywhere. Commas and periods only.
 */
'use strict';

const crypto = require('crypto');

const PROVIDER_ID = 'dograh_vobiz';
const PLATFORM_SEED_ID = 'pn_platform_astranova_main';

const SEED_INVENTORY = Object.freeze({
  id: PLATFORM_SEED_ID,
  e164: '+918065353938',
  label: 'AstraNova Main Line',
  country: 'IN',
  numberType: 'local',
  capabilities: Object.freeze(['inbound', 'outbound']),
  dograhTelephonyConfigId: 2,
  dograhPhoneNumberId: 3,
  inboundWorkflowId: 8,
});

function genId(prefix) {
  return prefix + crypto.randomBytes(8).toString('hex');
}

function nowIso() {
  return new Date().toISOString();
}

function digitsOnly(e164) {
  return String(e164 || '').replace(/[^0-9]/g, '');
}

function normalizeE164(value) {
  const raw = String(value || '').trim();
  if (/^\+[1-9]\d{6,14}$/.test(raw)) return raw;
  const digits = raw.replace(/[^0-9]/g, '');
  if (digits.length === 12 && digits.startsWith('91')) return '+' + digits;
  if (digits.length === 10) return '+91' + digits;
  return raw.startsWith('+') ? raw : (digits ? '+' + digits : '');
}

/**
 * Idempotent seed of the platform-owned live test number.
 * Status stays available until a tenant assigns it.
 */
function seedPlatformInventory(db) {
  if (!Array.isArray(db.phoneNumbers)) db.phoneNumbers = [];
  if (!Array.isArray(db.providerResources)) db.providerResources = [];

  const existing = db.phoneNumbers.find((n) => n.id === SEED_INVENTORY.id
    || normalizeE164(n.e164) === SEED_INVENTORY.e164);
  const ts = nowIso();
  if (existing) {
    // Keep assignment state. Refresh label and provider mapping for the known live number.
    existing.label = existing.label || SEED_INVENTORY.label;
    existing.provider = PROVIDER_ID;
    existing.providerMetadata = {
      ...(existing.providerMetadata || {}),
      dograhTelephonyConfigId: SEED_INVENTORY.dograhTelephonyConfigId,
      dograhPhoneNumberId: SEED_INVENTORY.dograhPhoneNumberId,
      inboundWorkflowId: SEED_INVENTORY.inboundWorkflowId,
      label: SEED_INVENTORY.label,
    };
    existing.updatedAt = ts;
    upsertProviderResource(db, existing);
    return existing;
  }

  const row = {
    id: SEED_INVENTORY.id,
    tenantId: null,
    provider: PROVIDER_ID,
    providerNumberId: String(SEED_INVENTORY.dograhPhoneNumberId),
    e164: SEED_INVENTORY.e164,
    label: SEED_INVENTORY.label,
    country: SEED_INVENTORY.country,
    numberType: SEED_INVENTORY.numberType,
    capabilities: [...SEED_INVENTORY.capabilities],
    status: 'available',
    assignedAgentId: null,
    inboundEnabled: true,
    outboundEnabled: true,
    providerMetadata: {
      dograhTelephonyConfigId: SEED_INVENTORY.dograhTelephonyConfigId,
      dograhPhoneNumberId: SEED_INVENTORY.dograhPhoneNumberId,
      inboundWorkflowId: SEED_INVENTORY.inboundWorkflowId,
      label: SEED_INVENTORY.label,
    },
    createdAt: ts,
    updatedAt: ts,
  };
  db.phoneNumbers.push(row);
  upsertProviderResource(db, row);
  return row;
}

function upsertProviderResource(db, number) {
  if (!Array.isArray(db.providerResources)) db.providerResources = [];
  const meta = number.providerMetadata || {};
  const providerResourceId = String(meta.dograhPhoneNumberId || number.providerNumberId || '');
  if (!providerResourceId) return null;
  let row = db.providerResources.find((r) => r.astraResourceId === number.id && r.resourceType === 'phone_number');
  const ts = nowIso();
  if (!row) {
    row = {
      id: genId('pr_'),
      astraResourceId: number.id,
      resourceType: 'phone_number',
      provider: number.provider || PROVIDER_ID,
      providerResourceId,
      metadata: { ...meta },
      createdAt: ts,
      updatedAt: ts,
    };
    db.providerResources.push(row);
  } else {
    row.providerResourceId = providerResourceId;
    row.provider = number.provider || PROVIDER_ID;
    row.metadata = { ...meta };
    row.updatedAt = ts;
  }
  return row;
}

/** Client-safe shape. Never includes API keys or raw Dograh resource ids. */
function publicPhoneNumber(n, agentsById, workflowsById) {
  if (!n) return null;
  const agent = n.assignedAgentId && agentsById ? agentsById.get(n.assignedAgentId) : null;
  const inboundWf = n.inboundWorkflowId && workflowsById ? workflowsById.get(n.inboundWorkflowId) : null;
  const outboundWf = n.outboundWorkflowId && workflowsById ? workflowsById.get(n.outboundWorkflowId) : null;
  return {
    id: n.id,
    e164: n.e164,
    label: n.label || null,
    country: n.country || null,
    numberType: n.numberType || 'local',
    capabilities: Array.isArray(n.capabilities) ? [...n.capabilities] : [],
    status: n.status,
    assignedAgentId: n.assignedAgentId || null,
    assignedAgentName: agent ? agent.name : null,
    inboundEnabled: n.inboundEnabled !== false,
    outboundEnabled: n.outboundEnabled !== false,
    inboundWorkflowId: n.inboundWorkflowId || null,
    outboundWorkflowId: n.outboundWorkflowId || null,
    inboundWorkflowName: inboundWf ? inboundWf.name : null,
    outboundWorkflowName: outboundWf ? outboundWf.name : null,
    createdAt: n.createdAt,
    updatedAt: n.updatedAt,
  };
}

function listTenantNumbers(db, tenantId) {
  return (db.phoneNumbers || []).filter((n) => n.tenantId === tenantId && n.status !== 'released');
}

function listAvailableInventory(db) {
  return (db.phoneNumbers || []).filter((n) => n.status === 'available' && !n.tenantId);
}

function findNumber(db, id) {
  return (db.phoneNumbers || []).find((n) => n.id === String(id || ''));
}

/**
 * Resolve Astra workflow ids to Dograh provider ids for dial / inbound config.
 * Accepts optional workflows module helpers via opts to avoid a hard cycle.
 */
function applyWorkflowBindings(db, number, tenantId, {
  inboundWorkflowId,
  outboundWorkflowId,
  resolveProviderWorkflowId,
}) {
  const meta = { ...(number.providerMetadata || {}) };
  if (inboundWorkflowId !== undefined) {
    if (inboundWorkflowId) {
      const wfId = String(inboundWorkflowId);
      const wf = (db.workflows || []).find((w) => w.id === wfId && w.tenantId === tenantId);
      if (!wf) return { ok: false, status: 404, code: 'workflow_not_found', error: 'inbound workflow not found' };
      number.inboundWorkflowId = wf.id;
      meta.inboundAstraWorkflowId = wf.id;
      const dograhId = typeof resolveProviderWorkflowId === 'function'
        ? resolveProviderWorkflowId(db, tenantId, wf.id)
        : (wf.providerWorkflowId != null ? Number(wf.providerWorkflowId) : null);
      if (Number.isInteger(dograhId) && dograhId > 0) {
        meta.inboundWorkflowId = dograhId;
        meta.providerInboundWorkflowId = dograhId;
      }
    } else {
      number.inboundWorkflowId = null;
      delete meta.inboundAstraWorkflowId;
    }
  }
  if (outboundWorkflowId !== undefined) {
    if (outboundWorkflowId) {
      const wfId = String(outboundWorkflowId);
      const wf = (db.workflows || []).find((w) => w.id === wfId && w.tenantId === tenantId);
      if (!wf) return { ok: false, status: 404, code: 'workflow_not_found', error: 'outbound workflow not found' };
      number.outboundWorkflowId = wf.id;
      meta.outboundAstraWorkflowId = wf.id;
      const dograhId = typeof resolveProviderWorkflowId === 'function'
        ? resolveProviderWorkflowId(db, tenantId, wf.id)
        : (wf.providerWorkflowId != null ? Number(wf.providerWorkflowId) : null);
      if (Number.isInteger(dograhId) && dograhId > 0) {
        meta.outboundWorkflowId = dograhId;
        meta.providerOutboundWorkflowId = dograhId;
      }
    } else {
      number.outboundWorkflowId = null;
      delete meta.outboundAstraWorkflowId;
    }
  }
  number.providerMetadata = meta;
  return { ok: true };
}

/**
 * Assign a platform-available number to a tenant agent.
 * inboundWorkflowId / outboundWorkflowId are Astra workflow ids (wf_...).
 * Returns { ok, status, code, error, number } so routes can map to HTTP.
 */
function assignNumber(db, {
  numberId, tenantId, agentId, inboundEnabled, outboundEnabled,
  inboundWorkflowId, outboundWorkflowId, resolveProviderWorkflowId,
}) {
  const number = findNumber(db, numberId);
  if (!number || number.status === 'released') {
    return { ok: false, status: 404, code: 'not_found', error: 'phone number not found' };
  }
  if (number.status === 'assigned' && number.tenantId && number.tenantId !== tenantId) {
    return { ok: false, status: 403, code: 'forbidden', error: 'phone number belongs to another workspace' };
  }
  if (number.status === 'available' && number.tenantId && number.tenantId !== tenantId) {
    return { ok: false, status: 403, code: 'forbidden', error: 'phone number belongs to another workspace' };
  }
  if (number.status === 'assigned' && number.tenantId === tenantId && number.assignedAgentId === agentId) {
    // Idempotent re-assign of same agent. Allow toggle updates.
  } else if (number.status === 'assigned' && number.tenantId === tenantId && number.assignedAgentId !== agentId) {
    // Reassign within the same tenant is allowed.
  } else if (number.status !== 'available' && !(number.tenantId === tenantId)) {
    return { ok: false, status: 409, code: 'not_available', error: 'phone number is not available to assign' };
  }

  const agent = (db.agents || []).find((a) => a.id === String(agentId || '') && a.tenantId === tenantId);
  if (!agent) {
    return { ok: false, status: 404, code: 'agent_not_found', error: 'agent not found in this workspace' };
  }

  // One primary DID per agent for V1: clear prior assignment of this agent on other numbers.
  for (const other of db.phoneNumbers || []) {
    if (other.id === number.id) continue;
    if (other.tenantId === tenantId && other.assignedAgentId === agent.id && other.status === 'assigned') {
      other.assignedAgentId = null;
      other.status = 'available';
      other.tenantId = null;
      other.updatedAt = nowIso();
    }
  }

  const ts = nowIso();
  number.tenantId = tenantId;
  number.assignedAgentId = agent.id;
  number.status = 'assigned';
  if (inboundEnabled !== undefined) number.inboundEnabled = !!inboundEnabled;
  if (outboundEnabled !== undefined) number.outboundEnabled = !!outboundEnabled;
  if (number.inboundEnabled === undefined) number.inboundEnabled = true;
  if (number.outboundEnabled === undefined) number.outboundEnabled = true;

  if (inboundWorkflowId !== undefined || outboundWorkflowId !== undefined) {
    const bind = applyWorkflowBindings(db, number, tenantId, {
      inboundWorkflowId, outboundWorkflowId, resolveProviderWorkflowId,
    });
    if (!bind.ok) return bind;
  } else if (!number.inboundWorkflowId) {
    // Prefer seeded Astra receptionist mapping when present for this tenant.
    const seeded = (db.workflows || []).find((w) =>
      w.tenantId === tenantId
      && String(w.providerWorkflowId) === String(SEED_INVENTORY.inboundWorkflowId)
      && w.status === 'published');
    if (seeded) {
      applyWorkflowBindings(db, number, tenantId, {
        inboundWorkflowId: seeded.id,
        resolveProviderWorkflowId,
      });
    }
  }

  number.updatedAt = ts;

  agent.telephony = {
    ...(agent.telephony || {}),
    did: digitsOnly(number.e164) || normalizeE164(number.e164),
    phoneNumberId: number.id,
  };

  upsertProviderResource(db, number);
  return { ok: true, number };
}

function unassignNumber(db, { numberId, tenantId }) {
  const number = findNumber(db, numberId);
  if (!number || number.status === 'released') {
    return { ok: false, status: 404, code: 'not_found', error: 'phone number not found' };
  }
  if (number.tenantId !== tenantId) {
    return { ok: false, status: 403, code: 'forbidden', error: 'phone number belongs to another workspace' };
  }

  const agentId = number.assignedAgentId;
  if (agentId) {
    const agent = (db.agents || []).find((a) => a.id === agentId && a.tenantId === tenantId);
    if (agent && agent.telephony) {
      if (agent.telephony.phoneNumberId === number.id || digitsOnly(agent.telephony.did) === digitsOnly(number.e164)) {
        agent.telephony = { ...(agent.telephony || {}), did: '', phoneNumberId: null };
      }
    }
  }

  number.assignedAgentId = null;
  number.tenantId = null;
  number.status = 'available';
  number.updatedAt = nowIso();
  upsertProviderResource(db, number);
  return { ok: true, number };
}

function patchNumber(db, {
  numberId, tenantId, inboundEnabled, outboundEnabled,
  inboundWorkflowId, outboundWorkflowId, resolveProviderWorkflowId,
}) {
  const number = findNumber(db, numberId);
  if (!number || number.status === 'released') {
    return { ok: false, status: 404, code: 'not_found', error: 'phone number not found' };
  }
  if (number.tenantId !== tenantId) {
    return { ok: false, status: 403, code: 'forbidden', error: 'phone number belongs to another workspace' };
  }
  const hasWorkflowPatch = inboundWorkflowId !== undefined || outboundWorkflowId !== undefined;
  if (inboundEnabled === undefined && outboundEnabled === undefined && !hasWorkflowPatch) {
    return { ok: false, status: 422, code: 'no_changes', error: 'provide inboundEnabled, outboundEnabled, and/or workflow ids' };
  }
  if (inboundEnabled !== undefined) number.inboundEnabled = !!inboundEnabled;
  if (outboundEnabled !== undefined) number.outboundEnabled = !!outboundEnabled;
  if (hasWorkflowPatch) {
    const bind = applyWorkflowBindings(db, number, tenantId, {
      inboundWorkflowId, outboundWorkflowId, resolveProviderWorkflowId,
    });
    if (!bind.ok) return bind;
  }
  number.updatedAt = nowIso();
  return { ok: true, number };
}

function softReleaseNumber(db, { numberId, tenantId }) {
  const number = findNumber(db, numberId);
  if (!number) {
    return { ok: false, status: 404, code: 'not_found', error: 'phone number not found' };
  }
  if (number.tenantId && number.tenantId !== tenantId) {
    return { ok: false, status: 403, code: 'forbidden', error: 'phone number belongs to another workspace' };
  }
  if (number.assignedAgentId) {
    const un = unassignNumber(db, { numberId, tenantId: number.tenantId || tenantId });
    if (!un.ok && un.code !== 'forbidden') return un;
  }
  number.status = 'released';
  number.tenantId = null;
  number.assignedAgentId = null;
  number.updatedAt = nowIso();
  return { ok: true, number };
}

/**
 * Dial helper: pick the tenant's outbound-enabled assigned number metadata.
 * Resolves Astra outboundWorkflowId → Dograh workflow id when available.
 */
function outboundDialContext(db, tenantId) {
  const assigned = (db.phoneNumbers || []).find((n) =>
    n.tenantId === tenantId
    && n.status === 'assigned'
    && n.outboundEnabled !== false);
  if (!assigned) return null;
  const meta = assigned.providerMetadata || {};
  let workflowId = meta.outboundWorkflowId || meta.providerOutboundWorkflowId
    || meta.inboundWorkflowId || meta.providerInboundWorkflowId || null;
  if (assigned.outboundWorkflowId) {
    const wf = (db.workflows || []).find((w) => w.id === assigned.outboundWorkflowId && w.tenantId === tenantId);
    if (wf && wf.providerWorkflowId != null) {
      const n = Number(wf.providerWorkflowId);
      if (Number.isInteger(n) && n > 0) workflowId = n;
    }
  } else if (assigned.inboundWorkflowId) {
    const wf = (db.workflows || []).find((w) => w.id === assigned.inboundWorkflowId && w.tenantId === tenantId);
    if (wf && wf.providerWorkflowId != null) {
      const n = Number(wf.providerWorkflowId);
      if (Number.isInteger(n) && n > 0) workflowId = n;
    }
  }
  return {
    phoneNumberId: assigned.id,
    e164: assigned.e164,
    dograhTelephonyConfigId: meta.dograhTelephonyConfigId || null,
    dograhPhoneNumberId: meta.dograhPhoneNumberId || Number(assigned.providerNumberId) || null,
    workflowId: Number.isInteger(Number(workflowId)) && Number(workflowId) > 0 ? Number(workflowId) : null,
    inboundWorkflowId: assigned.inboundWorkflowId || null,
    outboundWorkflowId: assigned.outboundWorkflowId || null,
  };
}

module.exports = {
  PROVIDER_ID,
  PLATFORM_SEED_ID,
  SEED_INVENTORY,
  seedPlatformInventory,
  publicPhoneNumber,
  listTenantNumbers,
  listAvailableInventory,
  findNumber,
  assignNumber,
  unassignNumber,
  patchNumber,
  softReleaseNumber,
  outboundDialContext,
  applyWorkflowBindings,
  normalizeE164,
  digitsOnly,
  upsertProviderResource,
};
