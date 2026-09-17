/**
 * Astra AI. Instant leads (tenant-scoped). CRUD + E.164 normalize for IN.
 *
 * Public shapes never expose Dograh / VoBiz / provider ids. Idempotency keys
 * are tenant-scoped so retries do not create duplicate leads.
 *
 * No em dashes anywhere. Commas and periods only.
 */
'use strict';

const crypto = require('crypto');

const LEAD_STATUSES = new Set(['new', 'calling', 'called', 'failed']);

function genId(prefix) {
  return prefix + crypto.randomBytes(8).toString('hex');
}

function nowIso() {
  return new Date().toISOString();
}

function ensureLeads(db) {
  if (!Array.isArray(db.leads)) db.leads = [];
}

/**
 * Normalize Indian mobile numbers to E.164 (+91...). Accepts +E.164, 10-digit
 * national, or 12-digit 91XXXXXXXXXX. Returns '' when unusable.
 */
function normalizePhoneIN(value) {
  const raw = String(value || '').trim();
  if (/^\+[1-9]\d{6,14}$/.test(raw)) {
    if (raw.startsWith('+91') && raw.length === 13) return raw;
    return raw;
  }
  const digits = raw.replace(/[^0-9]/g, '');
  if (digits.length === 10) return '+91' + digits;
  if (digits.length === 12 && digits.startsWith('91')) return '+' + digits;
  if (digits.length >= 7 && digits.length <= 15 && raw.startsWith('+')) return '+' + digits;
  return '';
}

function isValidE164(phone) {
  return /^\+[1-9]\d{6,14}$/.test(String(phone || ''));
}

/**
 * Client-safe lead. Never includes provider ids or Dograh fields.
 */
function publicLead(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name || '',
    phone: row.phone,
    status: row.status || 'new',
    agentId: row.agentId || null,
    workflowId: row.workflowId || null,
    phoneNumberId: row.phoneNumberId || null,
    lastCallJobId: row.lastCallJobId || null,
    lastCallId: row.lastCallId || null,
    lastError: row.lastError || null,
    meta: row.meta && typeof row.meta === 'object' ? { ...row.meta } : {},
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function findLead(db, tenantId, id) {
  ensureLeads(db);
  return (db.leads || []).find((l) => l.id === String(id || '') && l.tenantId === tenantId) || null;
}

function listLeads(db, tenantId, opts = {}) {
  ensureLeads(db);
  let rows = (db.leads || []).filter((l) => l.tenantId === tenantId);
  if (opts.status) rows = rows.filter((l) => l.status === String(opts.status));
  rows.sort((a, b) => String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || '')));
  const limit = Math.max(1, Math.min(200, Number(opts.limit) || 50));
  return rows.slice(0, limit).map(publicLead);
}

function findByIdempotencyKey(db, tenantId, key) {
  if (!key) return null;
  ensureLeads(db);
  return (db.leads || []).find(
    (l) => l.tenantId === tenantId && l.idempotencyKey === String(key),
  ) || null;
}

/**
 * Create a lead. Supports idempotencyKey (tenant-scoped). On key hit, returns
 * the existing lead with created:false.
 */
function createLead(db, tenantId, input, actorUserId) {
  ensureLeads(db);
  const b = input && typeof input === 'object' ? input : {};
  const idempotencyKey = b.idempotencyKey != null && String(b.idempotencyKey).trim()
    ? String(b.idempotencyKey).trim().slice(0, 120)
    : null;

  if (idempotencyKey) {
    const existing = findByIdempotencyKey(db, tenantId, idempotencyKey);
    if (existing) return { ok: true, lead: existing, created: false };
  }

  const phone = normalizePhoneIN(b.phone || b.number || '');
  if (!isValidE164(phone)) {
    return { ok: false, status: 422, error: 'phone must be a valid E.164 number (IN 10-digit ok)', code: 'bad_phone' };
  }
  const name = String(b.name || '').trim().slice(0, 120);
  if (!name) {
    return { ok: false, status: 422, error: 'name required', code: 'bad_name' };
  }

  let agentId = b.agentId ? String(b.agentId) : null;
  if (agentId) {
    const agent = (db.agents || []).find((a) => a.id === agentId && a.tenantId === tenantId);
    if (!agent) return { ok: false, status: 404, error: 'agent not found', code: 'agent_not_found' };
  }

  let workflowId = b.workflowId ? String(b.workflowId) : null;
  if (workflowId) {
    const wf = (db.workflows || []).find((w) => w.id === workflowId && w.tenantId === tenantId);
    if (!wf) return { ok: false, status: 404, error: 'workflow not found', code: 'workflow_not_found' };
  }

  let phoneNumberId = b.phoneNumberId ? String(b.phoneNumberId) : null;
  if (phoneNumberId) {
    const num = (db.phoneNumbers || []).find((n) => n.id === phoneNumberId && n.tenantId === tenantId);
    if (!num) return { ok: false, status: 404, error: 'phone number not found', code: 'number_not_found' };
  }

  const ts = nowIso();
  const row = {
    id: genId('lead_'),
    tenantId,
    name,
    phone,
    status: 'new',
    agentId,
    workflowId,
    phoneNumberId,
    lastCallJobId: null,
    lastCallId: null,
    lastError: null,
    meta: b.meta && typeof b.meta === 'object' ? { ...b.meta } : {},
    idempotencyKey,
    createdBy: actorUserId || null,
    createdAt: ts,
    updatedAt: ts,
  };
  db.leads.push(row);
  return { ok: true, lead: row, created: true };
}

function updateLead(db, tenantId, id, patch) {
  const lead = findLead(db, tenantId, id);
  if (!lead) return { ok: false, status: 404, error: 'lead not found', code: 'not_found' };
  const b = patch && typeof patch === 'object' ? patch : {};
  if (b.name !== undefined) {
    const name = String(b.name || '').trim().slice(0, 120);
    if (!name) return { ok: false, status: 422, error: 'name required', code: 'bad_name' };
    lead.name = name;
  }
  if (b.phone !== undefined) {
    const phone = normalizePhoneIN(b.phone);
    if (!isValidE164(phone)) {
      return { ok: false, status: 422, error: 'phone must be a valid E.164 number', code: 'bad_phone' };
    }
    lead.phone = phone;
  }
  if (b.status !== undefined) {
    if (!LEAD_STATUSES.has(String(b.status))) {
      return { ok: false, status: 422, error: 'bad lead status', code: 'bad_status' };
    }
    lead.status = String(b.status);
  }
  if (b.agentId !== undefined) {
    if (b.agentId) {
      const agent = (db.agents || []).find((a) => a.id === String(b.agentId) && a.tenantId === tenantId);
      if (!agent) return { ok: false, status: 404, error: 'agent not found', code: 'agent_not_found' };
      lead.agentId = agent.id;
    } else {
      lead.agentId = null;
    }
  }
  if (b.workflowId !== undefined) lead.workflowId = b.workflowId ? String(b.workflowId) : null;
  if (b.phoneNumberId !== undefined) lead.phoneNumberId = b.phoneNumberId ? String(b.phoneNumberId) : null;
  if (b.lastCallJobId !== undefined) lead.lastCallJobId = b.lastCallJobId || null;
  if (b.lastCallId !== undefined) lead.lastCallId = b.lastCallId || null;
  if (b.lastError !== undefined) lead.lastError = b.lastError ? String(b.lastError).slice(0, 240) : null;
  if (b.meta && typeof b.meta === 'object') lead.meta = { ...b.meta };
  lead.updatedAt = nowIso();
  return { ok: true, lead };
}

module.exports = {
  LEAD_STATUSES,
  normalizePhoneIN,
  isValidE164,
  publicLead,
  findLead,
  listLeads,
  findByIdempotencyKey,
  createLead,
  updateLead,
  ensureLeads,
};
