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
    assignedEmployeeId: null,
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

/**
 * Customer Inbound config on an assigned Phone Number (Phase 17).
 * Language: answer / greeting / hours. Never SIP, trunk, or provider jargon.
 */
function defaultInboundHours() {
  return {
    timezone: 'Asia/Kolkata',
    mode: 'always',
    windows: [],
  };
}

function normalizeInboundHours(raw, existing) {
  const base = existing && typeof existing === 'object' ? existing : defaultInboundHours();
  if (raw === undefined) return {
    timezone: String(base.timezone || 'Asia/Kolkata').slice(0, 64),
    mode: base.mode === 'schedule' ? 'schedule' : 'always',
    windows: Array.isArray(base.windows) ? base.windows.slice(0, 14) : [],
  };
  if (raw === null) return defaultInboundHours();
  const b = raw && typeof raw === 'object' ? raw : {};
  const mode = b.mode === 'schedule' ? 'schedule' : 'always';
  const timezone = String(b.timezone != null ? b.timezone : base.timezone || 'Asia/Kolkata').trim().slice(0, 64)
    || 'Asia/Kolkata';
  const windows = [];
  const src = Array.isArray(b.windows) ? b.windows : (mode === 'schedule' && Array.isArray(base.windows) ? base.windows : []);
  for (const w of src.slice(0, 14)) {
    if (!w || typeof w !== 'object') continue;
    const days = Array.isArray(w.days)
      ? w.days.map((d) => Number(d)).filter((d) => d >= 0 && d <= 6).slice(0, 7)
      : [];
    const start = String(w.start || '09:00').trim().slice(0, 8);
    const end = String(w.end || '18:00').trim().slice(0, 8);
    if (!/^\d{1,2}:\d{2}$/.test(start) || !/^\d{1,2}:\d{2}$/.test(end)) continue;
    windows.push({ days, start, end });
  }
  return { timezone, mode, windows };
}

function normalizeInboundConfig(number, agent) {
  const answer = number && number.inboundEnabled !== false;
  let greeting = '';
  if (number && number.inboundGreeting != null) {
    greeting = String(number.inboundGreeting).slice(0, 300);
  } else if (agent && agent.greeting != null) {
    greeting = String(agent.greeting).slice(0, 300);
  }
  const hours = normalizeInboundHours(number && number.inboundHours, null);
  return {
    answer: !!answer,
    greeting,
    hours,
    employeeId: number && number.assignedEmployeeId ? number.assignedEmployeeId : null,
  };
}

function publicInboundConfig(number, agent) {
  return normalizeInboundConfig(number, agent);
}

/** Client-safe shape. Never includes API keys or raw Dograh resource ids. */
function publicPhoneNumber(n, agentsById, workflowsById, employeesById) {
  if (!n) return null;
  const agent = n.assignedAgentId && agentsById ? agentsById.get(n.assignedAgentId) : null;
  const employee = n.assignedEmployeeId && employeesById
    ? employeesById.get(n.assignedEmployeeId)
    : null;
  const inboundWf = n.inboundWorkflowId && workflowsById ? workflowsById.get(n.inboundWorkflowId) : null;
  const outboundWf = n.outboundWorkflowId && workflowsById ? workflowsById.get(n.outboundWorkflowId) : null;
  const inbound = publicInboundConfig(n, agent);
  return {
    id: n.id,
    e164: n.e164,
    label: n.label || null,
    country: n.country || null,
    numberType: n.numberType || 'local',
    capabilities: Array.isArray(n.capabilities) ? [...n.capabilities] : [],
    status: n.status,
    assignedEmployeeId: n.assignedEmployeeId || null,
    assignedEmployeeName: employee ? employee.name : null,
    assignedAgentId: n.assignedAgentId || null,
    assignedAgentName: agent ? agent.name : null,
    inboundEnabled: n.inboundEnabled !== false,
    outboundEnabled: n.outboundEnabled !== false,
    inboundWorkflowId: n.inboundWorkflowId || null,
    outboundWorkflowId: n.outboundWorkflowId || null,
    inboundWorkflowName: inboundWf ? inboundWf.name : null,
    outboundWorkflowName: outboundWf ? outboundWf.name : null,
    inbound,
    createdAt: n.createdAt,
    updatedAt: n.updatedAt,
  };
}

function matchesNumberQuery(n, q, agentsById, employeesById) {
  if (!q) return true;
  const needle = String(q).trim().toLowerCase();
  if (!needle) return true;
  const agent = n.assignedAgentId && agentsById ? agentsById.get(n.assignedAgentId) : null;
  const employee = n.assignedEmployeeId && employeesById
    ? employeesById.get(n.assignedEmployeeId)
    : null;
  const hay = [
    n.id, n.e164, n.label, n.status,
    n.assignedEmployeeId, employee && employee.name,
    n.assignedAgentId, agent && agent.name,
  ].filter(Boolean).join(' ').toLowerCase();
  return hay.includes(needle);
}

function listTenantNumbers(db, tenantId, opts = {}) {
  let rows = (db.phoneNumbers || []).filter((n) => n.tenantId === tenantId && n.status !== 'released');
  const q = opts.q != null ? String(opts.q) : '';
  if (q.trim()) {
    const agentsById = new Map(
      (db.agents || []).filter((a) => a.tenantId === tenantId).map((a) => [a.id, a]),
    );
    const employeesById = new Map(
      (db.employees || []).filter((e) => e.tenantId === tenantId).map((e) => [e.id, e]),
    );
    rows = rows.filter((n) => matchesNumberQuery(n, q, agentsById, employeesById));
  }
  rows.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  return rows;
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
 * Assign a platform-available number to a tenant Employee (preferred) or agent.
 * employeeId resolves the linked agentId. Syncs employee.phoneNumberId and
 * number.assignedEmployeeId. inboundWorkflowId / outboundWorkflowId are Astra
 * workflow ids (wf_...). Returns { ok, status, code, error, number }.
 */
function assignNumber(db, {
  numberId, tenantId, agentId, employeeId, inboundEnabled, outboundEnabled,
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

  let resolvedEmployeeId = employeeId ? String(employeeId) : null;
  let resolvedAgentId = agentId ? String(agentId) : null;
  let employee = null;

  if (resolvedEmployeeId) {
    employee = (db.employees || []).find(
      (e) => e.id === resolvedEmployeeId && e.tenantId === tenantId,
    );
    if (!employee) {
      return { ok: false, status: 404, code: 'employee_not_found', error: 'employee not found in this workspace' };
    }
    if (!resolvedAgentId) resolvedAgentId = employee.agentId || null;
    if (!resolvedAgentId) {
      return {
        ok: false,
        status: 422,
        code: 'employee_no_agent',
        error: 'employee has no linked agent to receive the phone number',
      };
    }
  }

  if (number.status === 'assigned' && number.tenantId === tenantId
    && number.assignedAgentId === resolvedAgentId
    && (!resolvedEmployeeId || number.assignedEmployeeId === resolvedEmployeeId)) {
    // Idempotent re-assign of same employee/agent. Allow toggle updates.
  } else if (number.status === 'assigned' && number.tenantId === tenantId) {
    // Reassign within the same tenant is allowed.
  } else if (number.status !== 'available' && !(number.tenantId === tenantId)) {
    return { ok: false, status: 409, code: 'not_available', error: 'phone number is not available to assign' };
  }

  if (!resolvedAgentId) {
    return { ok: false, status: 422, code: 'validation', error: 'employeeId or agentId is required' };
  }

  const agent = (db.agents || []).find((a) => a.id === resolvedAgentId && a.tenantId === tenantId);
  if (!agent) {
    return { ok: false, status: 404, code: 'agent_not_found', error: 'agent not found in this workspace' };
  }

  // Prefer linking the employee that owns this agent when only agentId was passed.
  if (!employee && !resolvedEmployeeId) {
    employee = (db.employees || []).find(
      (e) => e.tenantId === tenantId
        && e.agentId === agent.id
        && e.status !== 'ARCHIVED',
    ) || null;
    if (employee) resolvedEmployeeId = employee.id;
  }

  // One primary Phone Number per agent for V1: clear prior assignment of this agent on other numbers.
  for (const other of db.phoneNumbers || []) {
    if (other.id === number.id) continue;
    if (other.tenantId === tenantId && other.assignedAgentId === agent.id && other.status === 'assigned') {
      clearEmployeeNumberLinks(db, tenantId, other);
      other.assignedAgentId = null;
      other.assignedEmployeeId = null;
      other.status = 'available';
      other.tenantId = null;
      other.updatedAt = nowIso();
    }
  }

  const ts = nowIso();
  number.tenantId = tenantId;
  number.assignedAgentId = agent.id;
  number.assignedEmployeeId = resolvedEmployeeId || null;
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

  // Sync Employee.phoneNumberId. One number per employee; clear others pointing here.
  for (const emp of db.employees || []) {
    if (emp.tenantId !== tenantId) continue;
    if (resolvedEmployeeId && emp.id === resolvedEmployeeId) {
      emp.phoneNumberId = number.id;
      emp.updatedAt = ts;
    } else if (emp.phoneNumberId === number.id) {
      emp.phoneNumberId = null;
      emp.updatedAt = ts;
    }
  }

  upsertProviderResource(db, number);
  return { ok: true, number };
}

function clearEmployeeNumberLinks(db, tenantId, number) {
  const numberId = number && number.id;
  if (!numberId) return;
  for (const emp of db.employees || []) {
    if (emp.tenantId !== tenantId) continue;
    if (emp.phoneNumberId === numberId
      || (number.assignedEmployeeId && emp.id === number.assignedEmployeeId && emp.phoneNumberId === numberId)) {
      emp.phoneNumberId = null;
      emp.updatedAt = nowIso();
    }
  }
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

  clearEmployeeNumberLinks(db, tenantId, number);

  number.assignedAgentId = null;
  number.assignedEmployeeId = null;
  number.tenantId = null;
  number.status = 'available';
  number.updatedAt = nowIso();
  upsertProviderResource(db, number);
  return { ok: true, number };
}

function patchNumber(db, {
  numberId, tenantId, inboundEnabled, outboundEnabled,
  inboundWorkflowId, outboundWorkflowId, resolveProviderWorkflowId,
  inboundGreeting, inboundHours, answer,
}) {
  const number = findNumber(db, numberId);
  if (!number || number.status === 'released') {
    return { ok: false, status: 404, code: 'not_found', error: 'phone number not found' };
  }
  if (number.tenantId !== tenantId) {
    return { ok: false, status: 403, code: 'forbidden', error: 'phone number belongs to another workspace' };
  }
  const hasWorkflowPatch = inboundWorkflowId !== undefined || outboundWorkflowId !== undefined;
  const hasInboundConfig = inboundGreeting !== undefined || inboundHours !== undefined
    || answer !== undefined;
  if (inboundEnabled === undefined && outboundEnabled === undefined && !hasWorkflowPatch && !hasInboundConfig) {
    return {
      ok: false,
      status: 422,
      code: 'no_changes',
      error: 'provide inboundEnabled, outboundEnabled, inbound fields, and/or workflow ids',
    };
  }
  if (answer !== undefined) number.inboundEnabled = !!answer;
  if (inboundEnabled !== undefined) number.inboundEnabled = !!inboundEnabled;
  if (outboundEnabled !== undefined) number.outboundEnabled = !!outboundEnabled;
  if (inboundGreeting !== undefined) {
    number.inboundGreeting = String(inboundGreeting || '').slice(0, 300);
  }
  if (inboundHours !== undefined) {
    number.inboundHours = normalizeInboundHours(inboundHours, number.inboundHours);
  }
  if (hasWorkflowPatch) {
    const bind = applyWorkflowBindings(db, number, tenantId, {
      inboundWorkflowId, outboundWorkflowId, resolveProviderWorkflowId,
    });
    if (!bind.ok) return bind;
  }
  number.updatedAt = nowIso();
  return { ok: true, number };
}

/**
 * Get customer Inbound config for an assigned Phone Number.
 * Reuses Employee + agent greeting when number greeting is unset.
 */
function getInboundConfig(db, tenantId, numberId) {
  const number = findNumber(db, numberId);
  if (!number || number.status === 'released') {
    return { ok: false, status: 404, code: 'not_found', error: 'phone number not found' };
  }
  if (number.tenantId !== tenantId) {
    return { ok: false, status: 403, code: 'forbidden', error: 'phone number belongs to another workspace' };
  }
  const agent = number.assignedAgentId
    ? (db.agents || []).find((a) => a.id === number.assignedAgentId && a.tenantId === tenantId)
    : null;
  const employee = number.assignedEmployeeId
    ? (db.employees || []).find((e) => e.id === number.assignedEmployeeId && e.tenantId === tenantId)
    : null;
  return {
    ok: true,
    inbound: {
      ...publicInboundConfig(number, agent),
      employeeId: number.assignedEmployeeId || null,
      employeeName: employee ? employee.name : null,
      phoneNumberId: number.id,
      e164: number.e164,
    },
  };
}

/**
 * Persist Inbound ownership on the Phone Number and optionally sync greeting
 * onto the linked Employee's agent. No provider portal calls.
 */
function setInboundConfig(db, tenantId, numberId, body) {
  const number = findNumber(db, numberId);
  if (!number || number.status === 'released') {
    return { ok: false, status: 404, code: 'not_found', error: 'phone number not found' };
  }
  if (number.tenantId !== tenantId) {
    return { ok: false, status: 403, code: 'forbidden', error: 'phone number belongs to another workspace' };
  }
  const b = body && typeof body === 'object' ? body : {};
  if (b.answer === undefined && b.inboundEnabled === undefined
    && b.greeting === undefined && b.inboundGreeting === undefined
    && b.hours === undefined && b.inboundHours === undefined) {
    return {
      ok: false,
      status: 422,
      code: 'no_changes',
      error: 'provide answer, greeting, and/or hours',
    };
  }
  if (b.answer !== undefined) number.inboundEnabled = !!b.answer;
  if (b.inboundEnabled !== undefined) number.inboundEnabled = !!b.inboundEnabled;
  if (b.greeting !== undefined || b.inboundGreeting !== undefined) {
    const greeting = b.greeting !== undefined ? b.greeting : b.inboundGreeting;
    number.inboundGreeting = String(greeting || '').slice(0, 300);
    // Sync onto linked agent so Instructions / inbound answer stay aligned.
    if (number.assignedAgentId) {
      const agent = (db.agents || []).find((a) => a.id === number.assignedAgentId && a.tenantId === tenantId);
      if (agent) agent.greeting = number.inboundGreeting;
    }
  }
  if (b.hours !== undefined || b.inboundHours !== undefined) {
    number.inboundHours = normalizeInboundHours(
      b.hours !== undefined ? b.hours : b.inboundHours,
      number.inboundHours,
    );
  }
  number.updatedAt = nowIso();
  return getInboundConfig(db, tenantId, numberId);
}

function softReleaseNumber(db, { numberId, tenantId }) {
  const number = findNumber(db, numberId);
  if (!number) {
    return { ok: false, status: 404, code: 'not_found', error: 'phone number not found' };
  }
  if (number.tenantId && number.tenantId !== tenantId) {
    return { ok: false, status: 403, code: 'forbidden', error: 'phone number belongs to another workspace' };
  }
  if (number.assignedAgentId || number.assignedEmployeeId) {
    const un = unassignNumber(db, { numberId, tenantId: number.tenantId || tenantId });
    if (!un.ok && un.code !== 'forbidden') return un;
  }
  number.status = 'released';
  number.tenantId = null;
  number.assignedAgentId = null;
  number.assignedEmployeeId = null;
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
  publicInboundConfig,
  normalizeInboundConfig,
  normalizeInboundHours,
  defaultInboundHours,
  getInboundConfig,
  setInboundConfig,
  listTenantNumbers,
  listAvailableInventory,
  findNumber,
  assignNumber,
  unassignNumber,
  patchNumber,
  softReleaseNumber,
  outboundDialContext,
  applyWorkflowBindings,
  matchesNumberQuery,
  clearEmployeeNumberLinks,
  normalizeE164,
  digitsOnly,
  upsertProviderResource,
};
