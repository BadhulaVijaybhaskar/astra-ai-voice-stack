/**
 * Astra Voice. Scheduled outbound follow-up jobs (persisted in db.json).
 *
 * Prefer Astra CallJob / callbackJobs architecture. These jobs schedule
 * outbound follow-ups and reminders WITHOUT auto-placing paid PSTN calls.
 * Status survives process restart. Dial still requires explicit confirm.
 *
 * Statuses: pending | scheduled | running | completed | failed | cancelled
 * No em dashes anywhere. Commas and periods only.
 */
'use strict';

const crypto = require('crypto');

const JOB_STATUSES = Object.freeze([
  'pending', 'scheduled', 'running', 'completed', 'failed', 'cancelled',
]);
const JOB_STATUS_SET = new Set(JOB_STATUSES);
const ACTIVE_STATUSES = new Set(['pending', 'scheduled', 'running']);

function genId(prefix) {
  return prefix + crypto.randomBytes(8).toString('hex');
}

function nowIso() {
  return new Date().toISOString();
}

function ensureOutboundJobs(db) {
  if (!Array.isArray(db.outboundJobs)) db.outboundJobs = [];
}

function normalizeStatus(value, fallback = 'pending') {
  const s = String(value || '').trim().toLowerCase();
  return JOB_STATUS_SET.has(s) ? s : fallback;
}

function publicOutboundJob(row) {
  if (!row) return null;
  return {
    job_id: row.id,
    id: row.id,
    contact_id: row.contactId || null,
    employee_id: row.employeeId || null,
    phone: row.phone || null,
    trigger_event: row.triggerEvent || null,
    scheduled_at: row.scheduledAt || null,
    status: row.status || 'pending',
    context_snapshot: row.contextSnapshot && typeof row.contextSnapshot === 'object'
      ? { ...row.contextSnapshot }
      : null,
    retry_count: Number(row.retryCount) || 0,
    last_error: row.lastError || null,
    lead_id: row.leadId || null,
    appointment_id: row.appointmentId || null,
    idempotency_key: undefined, // never expose
    created_at: row.createdAt,
    updated_at: row.updatedAt,
    completed_at: row.completedAt || null,
  };
}

function findOutboundJob(db, tenantId, id) {
  ensureOutboundJobs(db);
  return (db.outboundJobs || []).find((j) => j.id === String(id || '') && j.tenantId === tenantId) || null;
}

function findByIdempotencyKey(db, tenantId, key) {
  if (!key) return null;
  ensureOutboundJobs(db);
  return (db.outboundJobs || []).find(
    (j) => j.tenantId === tenantId && j.idempotencyKey === String(key),
  ) || null;
}

/**
 * Find an active duplicate for the same contact + trigger event.
 * Used to prevent duplicate callback jobs unless force=true.
 */
function findActiveDuplicate(db, tenantId, contactId, triggerEvent) {
  if (!contactId || !triggerEvent) return null;
  ensureOutboundJobs(db);
  return (db.outboundJobs || []).find((j) => (
    j.tenantId === tenantId
    && j.contactId === String(contactId)
    && j.triggerEvent === String(triggerEvent)
    && ACTIVE_STATUSES.has(j.status)
  )) || null;
}

function listOutboundJobs(db, tenantId, opts = {}) {
  ensureOutboundJobs(db);
  let rows = (db.outboundJobs || []).filter((j) => j.tenantId === tenantId);
  if (opts.contactId) rows = rows.filter((j) => j.contactId === String(opts.contactId));
  if (opts.employeeId) rows = rows.filter((j) => j.employeeId === String(opts.employeeId));
  if (opts.status) rows = rows.filter((j) => j.status === String(opts.status));
  if (opts.triggerEvent) rows = rows.filter((j) => j.triggerEvent === String(opts.triggerEvent));
  rows.sort((a, b) => String(a.scheduledAt || a.createdAt || '').localeCompare(String(b.scheduledAt || b.createdAt || '')));
  const limit = Math.max(1, Math.min(200, Number(opts.limit) || 50));
  return rows.slice(0, limit).map(publicOutboundJob);
}

/**
 * Create a persisted outbound job. Does NOT dial.
 * Idempotent via idempotencyKey or contactId+triggerEvent duplicate guard.
 */
function createOutboundJob(db, tenantId, input, actorUserId) {
  ensureOutboundJobs(db);
  const b = input && typeof input === 'object' ? input : {};

  const idempotencyKey = b.idempotencyKey != null && String(b.idempotencyKey).trim()
    ? String(b.idempotencyKey).trim().slice(0, 120)
    : null;
  if (idempotencyKey) {
    const existing = findByIdempotencyKey(db, tenantId, idempotencyKey);
    if (existing) return { ok: true, job: existing, created: false, duplicate: true };
  }

  const contactId = b.contactId || b.contact_id || null;
  const triggerEvent = String(b.triggerEvent || b.trigger_event || '').trim().slice(0, 64);
  if (!triggerEvent) {
    return { ok: false, status: 422, error: 'trigger_event required', code: 'bad_trigger' };
  }

  if (!b.force && contactId) {
    const dup = findActiveDuplicate(db, tenantId, contactId, triggerEvent);
    if (dup) return { ok: true, job: dup, created: false, duplicate: true };
  }

  const phone = String(b.phone || '').trim();
  if (!phone && !contactId) {
    return { ok: false, status: 422, error: 'phone or contact_id required', code: 'bad_phone' };
  }

  let scheduledAt = null;
  if (b.scheduledAt || b.scheduled_at) {
    const ms = Date.parse(String(b.scheduledAt || b.scheduled_at));
    if (!Number.isFinite(ms)) {
      return { ok: false, status: 422, error: 'scheduled_at must be ISO8601', code: 'bad_when' };
    }
    scheduledAt = new Date(ms).toISOString();
  }

  const status = scheduledAt ? 'scheduled' : normalizeStatus(b.status, 'pending');
  const ts = nowIso();
  const row = {
    id: genId('ojob_'),
    tenantId,
    contactId: contactId ? String(contactId) : null,
    employeeId: (b.employeeId || b.employee_id) ? String(b.employeeId || b.employee_id) : null,
    phone: phone || null,
    triggerEvent,
    scheduledAt,
    status,
    contextSnapshot: b.contextSnapshot && typeof b.contextSnapshot === 'object'
      ? { ...b.contextSnapshot }
      : (b.context_snapshot && typeof b.context_snapshot === 'object' ? { ...b.context_snapshot } : null),
    retryCount: 0,
    lastError: null,
    leadId: (b.leadId || b.lead_id) ? String(b.leadId || b.lead_id) : null,
    appointmentId: (b.appointmentId || b.appointment_id) ? String(b.appointmentId || b.appointment_id) : null,
    autoDial: false, // never auto-place paid PSTN from this queue
    idempotencyKey,
    createdBy: actorUserId || null,
    createdAt: ts,
    updatedAt: ts,
    completedAt: null,
  };
  db.outboundJobs.push(row);
  return { ok: true, job: row, created: true, duplicate: false };
}

function updateOutboundJobStatus(db, tenantId, id, status, patch = {}) {
  const job = findOutboundJob(db, tenantId, id);
  if (!job) return { ok: false, status: 404, error: 'outbound job not found', code: 'not_found' };
  const next = normalizeStatus(status, '');
  if (!next) {
    return {
      ok: false,
      status: 422,
      error: 'invalid outbound job status',
      code: 'bad_status',
      allowed: JOB_STATUSES.slice(),
    };
  }
  job.status = next;
  if (patch.lastError !== undefined) {
    job.lastError = patch.lastError ? String(patch.lastError).slice(0, 300) : null;
  }
  if (patch.retryCount !== undefined) job.retryCount = Number(patch.retryCount) || 0;
  if (patch.incrementRetry) job.retryCount = (Number(job.retryCount) || 0) + 1;
  if (patch.contextSnapshot && typeof patch.contextSnapshot === 'object') {
    job.contextSnapshot = { ...patch.contextSnapshot };
  }
  if (patch.scheduledAt) {
    const ms = Date.parse(String(patch.scheduledAt));
    if (Number.isFinite(ms)) job.scheduledAt = new Date(ms).toISOString();
  }
  if (next === 'completed' || next === 'failed' || next === 'cancelled') {
    job.completedAt = nowIso();
  }
  job.updatedAt = nowIso();
  return { ok: true, job };
}

/**
 * Jobs due for processing (status scheduled/pending, scheduled_at <= now).
 * Does NOT dial. Caller must explicitly confirm before any PSTN place.
 */
function listDueOutboundJobs(db, nowMs = Date.now()) {
  ensureOutboundJobs(db);
  return (db.outboundJobs || []).filter((j) => {
    if (!ACTIVE_STATUSES.has(j.status)) return false;
    if (!j.scheduledAt) return j.status === 'pending';
    const ms = Date.parse(j.scheduledAt);
    return Number.isFinite(ms) && ms <= nowMs;
  });
}

/**
 * Reload-safe snapshot: jobs are in db.outboundJobs and survive restart.
 * Used by tests to prove persistence is not in-memory only.
 */
function serializeJobsForPersist(db) {
  ensureOutboundJobs(db);
  return JSON.parse(JSON.stringify(db.outboundJobs || []));
}

function restoreJobsFromPersist(db, rows) {
  ensureOutboundJobs(db);
  db.outboundJobs = Array.isArray(rows) ? JSON.parse(JSON.stringify(rows)) : [];
  return db.outboundJobs.length;
}

module.exports = {
  JOB_STATUSES,
  JOB_STATUS_SET,
  ACTIVE_STATUSES,
  ensureOutboundJobs,
  publicOutboundJob,
  findOutboundJob,
  findByIdempotencyKey,
  findActiveDuplicate,
  listOutboundJobs,
  createOutboundJob,
  updateOutboundJobStatus,
  listDueOutboundJobs,
  serializeJobsForPersist,
  restoreJobsFromPersist,
};
