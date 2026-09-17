/**
 * Astra AI. CallJob queue for instant leads and campaign dials.
 *
 * Status: queued | dialing | completed | failed.
 * Links leadId, agentId, workflowId, phoneNumberId, providerRunId, resultCallId.
 * Public shapes never expose Dograh / VoBiz / provider ids (providerRunId stays
 * server-side only).
 *
 * Idempotency: tenant-scoped idempotencyKey returns the same job. An active
 * (queued|dialing) job for a lead is reused so retries do not double-dial.
 *
 * No em dashes anywhere. Commas and periods only.
 */
'use strict';

const crypto = require('crypto');

const JOB_STATUSES = new Set(['queued', 'dialing', 'completed', 'failed']);
const ACTIVE_STATUSES = new Set(['queued', 'dialing']);

function genId(prefix) {
  return prefix + crypto.randomBytes(8).toString('hex');
}

function nowIso() {
  return new Date().toISOString();
}

function ensureCallJobs(db) {
  if (!Array.isArray(db.callJobs)) db.callJobs = [];
}

/**
 * Client-safe job. Omits providerRunId and any Dograh fields.
 */
function publicCallJob(row) {
  if (!row) return null;
  return {
    id: row.id,
    leadId: row.leadId || null,
    campaignLeadId: row.campaignLeadId || null,
    agentId: row.agentId || null,
    workflowId: row.workflowId || null,
    phoneNumberId: row.phoneNumberId || null,
    toE164: row.toE164 || null,
    status: row.status || 'queued',
    resultCallId: row.resultCallId || null,
    lastError: row.lastError || null,
    source: row.source || 'instant',
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    dialedAt: row.dialedAt || null,
    completedAt: row.completedAt || null,
  };
}

function findCallJob(db, tenantId, id) {
  ensureCallJobs(db);
  return (db.callJobs || []).find((j) => j.id === String(id || '') && j.tenantId === tenantId) || null;
}

function findByIdempotencyKey(db, tenantId, key) {
  if (!key) return null;
  ensureCallJobs(db);
  return (db.callJobs || []).find(
    (j) => j.tenantId === tenantId && j.idempotencyKey === String(key),
  ) || null;
}

function findActiveCallJobForLead(db, tenantId, leadId) {
  if (!leadId) return null;
  ensureCallJobs(db);
  return (db.callJobs || []).find(
    (j) => j.tenantId === tenantId
      && j.leadId === String(leadId)
      && ACTIVE_STATUSES.has(j.status),
  ) || null;
}

function listCallJobs(db, tenantId, opts = {}) {
  ensureCallJobs(db);
  let rows = (db.callJobs || []).filter((j) => j.tenantId === tenantId);
  if (opts.leadId) rows = rows.filter((j) => j.leadId === String(opts.leadId));
  if (opts.status) rows = rows.filter((j) => j.status === String(opts.status));
  rows.sort((a, b) => String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || '')));
  const limit = Math.max(1, Math.min(200, Number(opts.limit) || 50));
  return rows.slice(0, limit).map(publicCallJob);
}

/**
 * Create a CallJob in queued status.
 * Returns { ok, job, created }. created:false on idempotency / active-lead reuse.
 */
function createCallJob(db, tenantId, input, actorUserId) {
  ensureCallJobs(db);
  const b = input && typeof input === 'object' ? input : {};
  const toE164 = String(b.toE164 || b.phone || '').trim();
  if (!/^\+[1-9]\d{6,14}$/.test(toE164)) {
    return { ok: false, status: 422, error: 'toE164 must be E.164', code: 'bad_phone' };
  }

  const idempotencyKey = b.idempotencyKey != null && String(b.idempotencyKey).trim()
    ? String(b.idempotencyKey).trim().slice(0, 120)
    : null;

  if (idempotencyKey) {
    const existing = findByIdempotencyKey(db, tenantId, idempotencyKey);
    if (existing) return { ok: true, job: existing, created: false };
  }

  if (b.leadId && b.reuseActiveLeadJob !== false) {
    const active = findActiveCallJobForLead(db, tenantId, b.leadId);
    if (active) return { ok: true, job: active, created: false };
  }

  const ts = nowIso();
  const row = {
    id: genId('cjob_'),
    tenantId,
    leadId: b.leadId ? String(b.leadId) : null,
    campaignLeadId: b.campaignLeadId ? String(b.campaignLeadId) : null,
    agentId: b.agentId ? String(b.agentId) : null,
    workflowId: b.workflowId ? String(b.workflowId) : null,
    phoneNumberId: b.phoneNumberId ? String(b.phoneNumberId) : null,
    toE164,
    status: 'queued',
    providerRunId: null,
    resultCallId: null,
    lastError: null,
    source: b.source ? String(b.source).slice(0, 40) : 'instant',
    idempotencyKey,
    createdBy: actorUserId || null,
    createdAt: ts,
    updatedAt: ts,
    dialedAt: null,
    completedAt: null,
  };
  db.callJobs.push(row);
  return { ok: true, job: row, created: true };
}

/**
 * Update job status and optional linkage fields.
 * Allowed statuses: queued | dialing | completed | failed.
 */
function updateCallJobStatus(db, tenantId, id, status, patch = {}) {
  if (!JOB_STATUSES.has(String(status))) {
    return { ok: false, status: 422, error: 'status must be queued, dialing, completed, or failed', code: 'bad_status' };
  }
  const job = findCallJob(db, tenantId, id);
  if (!job) return { ok: false, status: 404, error: 'call job not found', code: 'not_found' };
  const ts = nowIso();
  job.status = String(status);
  job.updatedAt = ts;
  if (status === 'dialing' && !job.dialedAt) job.dialedAt = ts;
  if (status === 'completed' || status === 'failed') job.completedAt = ts;
  if (patch.providerRunId !== undefined) {
    job.providerRunId = patch.providerRunId ? String(patch.providerRunId) : null;
  }
  if (patch.resultCallId !== undefined) {
    job.resultCallId = patch.resultCallId ? String(patch.resultCallId) : null;
  }
  if (patch.lastError !== undefined) {
    job.lastError = patch.lastError ? String(patch.lastError).slice(0, 240) : null;
  }
  if (patch.agentId !== undefined) job.agentId = patch.agentId || null;
  if (patch.workflowId !== undefined) job.workflowId = patch.workflowId || null;
  if (patch.phoneNumberId !== undefined) job.phoneNumberId = patch.phoneNumberId || null;
  return { ok: true, job };
}

module.exports = {
  JOB_STATUSES,
  ACTIVE_STATUSES,
  publicCallJob,
  findCallJob,
  findByIdempotencyKey,
  findActiveCallJobForLead,
  listCallJobs,
  createCallJob,
  updateCallJobStatus,
  ensureCallJobs,
};
