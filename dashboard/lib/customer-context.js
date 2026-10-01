/**
 * Astra Voice. Continuous Customer Context.
 *
 * Persists and reuses customer context across inbound and outbound calls.
 * Contact resolution by E.164, compact LLM injection (never full transcripts),
 * appointments / actions / cumulative summaries, tenant isolation, employee handoff.
 *
 * Storage: data/db.json contacts collection. No Supabase.
 * No em dashes anywhere. Commas and periods only.
 */
'use strict';

const crypto = require('crypto');
const leads = require('./leads');

const LEAD_STATUSES = Object.freeze([
  'new', 'contacted', 'qualified', 'unqualified', 'nurturing', 'converted', 'lost',
]);
const QUALIFICATION_STATUSES = Object.freeze([
  'unknown', 'in_progress', 'qualified', 'disqualified', 'handed_off',
]);
const APPOINTMENT_STATUSES = Object.freeze([
  'requested', 'booked', 'rescheduled', 'cancelled', 'completed', 'no_show',
]);
const TIMELINE_TYPES = Object.freeze([
  'inbound', 'outbound', 'booked', 'follow_up_scheduled', 'outbound_confirmation',
  'callback_requested', 'lead_created', 'lead_qualified', 'appointment_requested',
  'appointment_rescheduled', 'appointment_cancelled', 'context_updated', 'handoff',
]);

const MAX_SUMMARY_CHARS = 480;
const MAX_CUMULATIVE_CHARS = 1200;
const MAX_INJECTION_CHARS = 900;
const MAX_CALL_REFS = 40;
const MAX_APPOINTMENTS = 24;
const MAX_ACTIONS = 40;
const MAX_TIMELINE = 80;

function genId(prefix) {
  return prefix + crypto.randomBytes(8).toString('hex');
}

function nowIso() {
  return new Date().toISOString();
}

function ensureContacts(db) {
  if (!Array.isArray(db.contacts)) db.contacts = [];
}

function normalizePhone(value) {
  return leads.normalizePhoneIN(value);
}

function isValidE164(phone) {
  return leads.isValidE164(phone);
}

function clampStr(value, max) {
  return String(value == null ? '' : value).trim().slice(0, max);
}

function normalizeLeadStatus(value, fallback = 'new') {
  const s = String(value || '').trim().toLowerCase();
  return LEAD_STATUSES.includes(s) ? s : fallback;
}

function normalizeQualification(value, fallback = 'unknown') {
  const s = String(value || '').trim().toLowerCase();
  return QUALIFICATION_STATUSES.includes(s) ? s : fallback;
}

function normalizeAppointmentStatus(value, fallback = 'requested') {
  const s = String(value || '').trim().toLowerCase();
  return APPOINTMENT_STATUSES.includes(s) ? s : fallback;
}

function emptyContact(tenantId, phone, extras = {}) {
  const ts = nowIso();
  return {
    id: genId('ct_'),
    tenantId,
    name: clampStr(extras.name, 120),
    primaryPhone: phone,
    alternatePhone: clampStr(extras.alternatePhone || extras.alternate_phone, 20) || null,
    email: clampStr(extras.email, 180).toLowerCase() || null,
    company: clampStr(extras.company, 120) || null,
    preferredLanguage: clampStr(extras.preferredLanguage || extras.preferred_language, 16) || null,
    detectedLanguages: Array.isArray(extras.detectedLanguages || extras.detected_languages)
      ? (extras.detectedLanguages || extras.detected_languages).map((l) => clampStr(l, 16)).filter(Boolean).slice(0, 8)
      : [],
    leadStatus: normalizeLeadStatus(extras.leadStatus || extras.lead_status, 'new'),
    qualificationStatus: normalizeQualification(
      extras.qualificationStatus || extras.qualification_status,
      'unknown',
    ),
    interest: clampStr(extras.interest, 240) || null,
    businessGoal: clampStr(extras.businessGoal || extras.business_goal, 240) || null,
    timeline: clampStr(extras.timeline, 120) || null,
    lastConversationSummary: null,
    cumulativeContextSummary: null,
    appointments: [],
    calls: [],
    actions: [],
    timelineEvents: [],
    nextAction: null,
    nextActionAt: null,
    assignedEmployee: extras.assignedEmployee || extras.assigned_employee || extras.employeeId || null,
    leadId: extras.leadId || null,
    createdAt: ts,
    updatedAt: ts,
  };
}

/**
 * Client-safe contact. Uses contact_id alias for product contract.
 * Never exposes tenantId or provider ids.
 */
function publicContact(row, opts = {}) {
  if (!row) return null;
  const detail = opts.detail === true;
  const out = {
    contact_id: row.id,
    id: row.id,
    name: row.name || '',
    primary_phone: row.primaryPhone || null,
    alternate_phone: row.alternatePhone || null,
    email: row.email || null,
    company: row.company || null,
    preferred_language: row.preferredLanguage || null,
    detected_languages: Array.isArray(row.detectedLanguages) ? row.detectedLanguages.slice() : [],
    lead_status: row.leadStatus || 'new',
    qualification_status: row.qualificationStatus || 'unknown',
    interest: row.interest || null,
    business_goal: row.businessGoal || null,
    timeline: row.timeline || null,
    last_conversation_summary: row.lastConversationSummary || null,
    cumulative_context_summary: row.cumulativeContextSummary || null,
    next_action: row.nextAction || null,
    next_action_at: row.nextActionAt || null,
    assigned_employee: row.assignedEmployee || null,
    lead_id: row.leadId || null,
    appointments_count: Array.isArray(row.appointments) ? row.appointments.length : 0,
    calls_count: Array.isArray(row.calls) ? row.calls.length : 0,
    actions_count: Array.isArray(row.actions) ? row.actions.length : 0,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
  if (detail) {
    out.appointments = (row.appointments || []).slice();
    out.calls = (row.calls || []).slice();
    out.actions = (row.actions || []).slice();
    out.timeline_events = (row.timelineEvents || []).slice(0, MAX_TIMELINE);
  }
  return out;
}

function findContact(db, tenantId, id) {
  ensureContacts(db);
  return (db.contacts || []).find((c) => c.id === String(id || '') && c.tenantId === tenantId) || null;
}

function findContactByPhone(db, tenantId, phoneE164) {
  ensureContacts(db);
  const phone = normalizePhone(phoneE164);
  if (!phone) return null;
  return (db.contacts || []).find((c) => {
    if (c.tenantId !== tenantId) return false;
    if (c.primaryPhone === phone) return true;
    if (c.alternatePhone === phone) return true;
    return false;
  }) || null;
}

function listContacts(db, tenantId, opts = {}) {
  ensureContacts(db);
  let rows = (db.contacts || []).filter((c) => c.tenantId === tenantId);
  if (opts.assignedEmployee) {
    rows = rows.filter((c) => c.assignedEmployee === String(opts.assignedEmployee));
  }
  if (opts.leadStatus) {
    rows = rows.filter((c) => c.leadStatus === String(opts.leadStatus));
  }
  if (opts.q) {
    const q = String(opts.q).trim().toLowerCase();
    rows = rows.filter((c) => {
      const blob = [c.name, c.primaryPhone, c.email, c.company].join(' ').toLowerCase();
      return blob.includes(q);
    });
  }
  rows.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  const limit = Math.max(1, Math.min(200, Number(opts.limit) || 50));
  return rows.slice(0, limit).map((r) => publicContact(r));
}

/**
 * Resolve inbound/outbound caller to a Contact. Creates when missing.
 * Same path for inbound and outbound.
 */
function resolveContact(db, tenantId, phoneRaw, extras = {}) {
  ensureContacts(db);
  const phone = normalizePhone(phoneRaw);
  if (!isValidE164(phone)) {
    return { ok: false, status: 422, error: 'phone must be valid E.164 (IN 10-digit ok)', code: 'bad_phone' };
  }

  const existing = findContactByPhone(db, tenantId, phone);
  if (existing) {
    let touched = false;
    if (extras.name && !existing.name) {
      existing.name = clampStr(extras.name, 120);
      touched = true;
    }
    if (extras.email && !existing.email) {
      existing.email = clampStr(extras.email, 180).toLowerCase();
      touched = true;
    }
    if (extras.company && !existing.company) {
      existing.company = clampStr(extras.company, 120);
      touched = true;
    }
    if (extras.assignedEmployee || extras.assigned_employee || extras.employeeId) {
      const emp = extras.assignedEmployee || extras.assigned_employee || extras.employeeId;
      if (emp && !existing.assignedEmployee) {
        existing.assignedEmployee = String(emp);
        touched = true;
      }
    }
    if (extras.preferredLanguage || extras.preferred_language) {
      const lang = clampStr(extras.preferredLanguage || extras.preferred_language, 16);
      if (lang && !existing.preferredLanguage) {
        existing.preferredLanguage = lang;
        touched = true;
      }
    }
    if (touched) existing.updatedAt = nowIso();
    return { ok: true, contact: existing, created: false, phone };
  }

  if (extras.create === false) {
    return { ok: false, status: 404, error: 'contact not found', code: 'not_found', phone };
  }

  const row = emptyContact(tenantId, phone, extras);
  db.contacts.push(row);
  pushTimelineEvent(row, {
    type: 'lead_created',
    label: 'Contact created',
    detail: phone,
  });
  return { ok: true, contact: row, created: true, phone };
}

function pushTimelineEvent(contact, evt) {
  if (!contact) return;
  if (!Array.isArray(contact.timelineEvents)) contact.timelineEvents = [];
  const type = String(evt.type || '').trim();
  if (!type) return;
  contact.timelineEvents.unshift({
    at: evt.at || nowIso(),
    type,
    label: clampStr(evt.label || type, 80),
    detail: evt.detail != null ? clampStr(evt.detail, 240) : null,
    callId: evt.callId || null,
    appointmentId: evt.appointmentId || null,
    jobId: evt.jobId || null,
    employeeId: evt.employeeId || null,
  });
  if (contact.timelineEvents.length > MAX_TIMELINE) {
    contact.timelineEvents = contact.timelineEvents.slice(0, MAX_TIMELINE);
  }
}

function patchContact(db, tenantId, id, patch) {
  const row = findContact(db, tenantId, id);
  if (!row) return { ok: false, status: 404, error: 'contact not found', code: 'not_found' };
  const b = patch && typeof patch === 'object' ? patch : {};

  if (b.name !== undefined) row.name = clampStr(b.name, 120);
  if (b.alternatePhone !== undefined || b.alternate_phone !== undefined) {
    const alt = normalizePhone(b.alternatePhone || b.alternate_phone);
    row.alternatePhone = alt || null;
  }
  if (b.email !== undefined) {
    const email = clampStr(b.email, 180).toLowerCase();
    row.email = email || null;
  }
  if (b.company !== undefined) row.company = clampStr(b.company, 120) || null;
  if (b.preferredLanguage !== undefined || b.preferred_language !== undefined) {
    row.preferredLanguage = clampStr(b.preferredLanguage || b.preferred_language, 16) || null;
  }
  if (b.detectedLanguages !== undefined || b.detected_languages !== undefined) {
    const langs = b.detectedLanguages || b.detected_languages;
    row.detectedLanguages = Array.isArray(langs)
      ? langs.map((l) => clampStr(l, 16)).filter(Boolean).slice(0, 8)
      : [];
  }
  if (b.leadStatus !== undefined || b.lead_status !== undefined) {
    row.leadStatus = normalizeLeadStatus(b.leadStatus || b.lead_status, row.leadStatus);
  }
  if (b.qualificationStatus !== undefined || b.qualification_status !== undefined) {
    row.qualificationStatus = normalizeQualification(
      b.qualificationStatus || b.qualification_status,
      row.qualificationStatus,
    );
  }
  if (b.interest !== undefined) row.interest = clampStr(b.interest, 240) || null;
  if (b.businessGoal !== undefined || b.business_goal !== undefined) {
    row.businessGoal = clampStr(b.businessGoal || b.business_goal, 240) || null;
  }
  if (b.timeline !== undefined) row.timeline = clampStr(b.timeline, 120) || null;
  if (b.nextAction !== undefined || b.next_action !== undefined) {
    row.nextAction = clampStr(b.nextAction || b.next_action, 200) || null;
  }
  if (b.nextActionAt !== undefined || b.next_action_at !== undefined) {
    const raw = b.nextActionAt || b.next_action_at;
    if (!raw) row.nextActionAt = null;
    else {
      const ms = Date.parse(String(raw));
      row.nextActionAt = Number.isFinite(ms) ? new Date(ms).toISOString() : null;
    }
  }
  if (b.assignedEmployee !== undefined || b.assigned_employee !== undefined) {
    const emp = b.assignedEmployee !== undefined ? b.assignedEmployee : b.assigned_employee;
    row.assignedEmployee = emp ? String(emp) : null;
  }
  if (b.leadId !== undefined || b.lead_id !== undefined) {
    row.leadId = (b.leadId || b.lead_id) ? String(b.leadId || b.lead_id) : null;
  }

  row.updatedAt = nowIso();
  return { ok: true, contact: row };
}

/**
 * Merge structured facts into cumulative summary without erasing older useful info.
 */
function mergeCumulativeSummary(existing, incoming, maxChars = MAX_CUMULATIVE_CHARS) {
  const older = clampStr(existing, maxChars);
  const newer = clampStr(incoming, MAX_SUMMARY_CHARS);
  if (!newer) return older || null;
  if (!older) return newer;
  if (older.includes(newer)) return older;
  const merged = older + ' | ' + newer;
  if (merged.length <= maxChars) return merged;
  // Keep newest first when trimming so recent facts survive.
  const reverse = newer + ' | ' + older;
  return reverse.slice(0, maxChars);
}

/**
 * Compact context block for Maya / employee LLM. Low token budget.
 * NEVER dumps full transcripts.
 */
function buildContextInjection(contact, opts = {}) {
  if (!contact) {
    return { ok: false, status: 404, error: 'contact required', code: 'missing_contact', block: '', tokensEstimate: 0 };
  }

  const lines = [];
  lines.push('CUSTOMER CONTEXT (compact, verified facts only)');
  if (contact.name) lines.push('Name: ' + contact.name);
  if (contact.company) lines.push('Company: ' + contact.company);
  if (contact.primaryPhone) lines.push('Phone: ' + contact.primaryPhone);
  if (contact.email) lines.push('Email: ' + contact.email);
  if (contact.preferredLanguage) lines.push('Preferred language: ' + contact.preferredLanguage);
  if (contact.leadStatus) lines.push('Lead status: ' + contact.leadStatus);
  if (contact.qualificationStatus && contact.qualificationStatus !== 'unknown') {
    lines.push('Qualification: ' + contact.qualificationStatus);
  }
  if (contact.interest) lines.push('Interest: ' + contact.interest);
  if (contact.businessGoal) lines.push('Business goal: ' + contact.businessGoal);
  if (contact.timeline) lines.push('Timeline: ' + contact.timeline);
  if (contact.assignedEmployee) lines.push('Assigned employee: ' + contact.assignedEmployee);

  const summary = contact.lastConversationSummary || contact.cumulativeContextSummary;
  if (summary) lines.push('Latest summary: ' + clampStr(summary, 280));

  const appts = Array.isArray(contact.appointments) ? contact.appointments : [];
  const relevantAppt = opts.appointmentId
    ? appts.find((a) => a.id === opts.appointmentId)
    : appts.find((a) => a.status === 'booked' || a.status === 'requested') || appts[0];
  if (relevantAppt) {
    lines.push(
      'Appointment: '
      + [relevantAppt.status, relevantAppt.startAt, relevantAppt.title].filter(Boolean).join(' · '),
    );
  }

  const actions = Array.isArray(contact.actions) ? contact.actions : [];
  const next = contact.nextAction
    || (actions.find((a) => a.status === 'pending' || a.status === 'scheduled') || null);
  if (typeof next === 'string' && next) {
    lines.push('Next action: ' + next + (contact.nextActionAt ? (' @ ' + contact.nextActionAt) : ''));
  } else if (next && typeof next === 'object') {
    lines.push(
      'Next action: '
      + [next.type || next.label, next.scheduledAt || next.at].filter(Boolean).join(' @ '),
    );
  }

  if (opts.handoffFrom) {
    lines.push('Handoff from: ' + String(opts.handoffFrom) + ' (tenant-scoped facts only)');
  }

  let block = lines.join('\n');
  const maxChars = Number(opts.maxChars) || (opts.firstResponse ? 420 : MAX_INJECTION_CHARS);
  if (block.length > maxChars) {
    block = block.slice(0, maxChars - 1) + '...';
  }
  // Rough token estimate: ~4 chars per token.
  const tokensEstimate = Math.ceil(block.length / 4);
  return {
    ok: true,
    block,
    tokensEstimate,
    preferred_language: contact.preferredLanguage || null,
    contact_id: contact.id,
    compact: true,
    first_response_compact: !!opts.firstResponse || maxChars < MAX_INJECTION_CHARS,
    includes_transcript: false,
  };
}

function recordCallRef(contact, callRef) {
  if (!contact) return;
  if (!Array.isArray(contact.calls)) contact.calls = [];
  const id = callRef && (callRef.id || callRef.callId);
  if (!id) return;
  const existing = contact.calls.find((c) => c.id === id);
  const row = {
    id: String(id),
    direction: callRef.direction || null,
    status: callRef.status || null,
    outcome: callRef.outcome || null,
    employeeId: callRef.employeeId || null,
    summary: callRef.summary ? clampStr(callRef.summary, MAX_SUMMARY_CHARS) : null,
    at: callRef.at || callRef.endedAt || callRef.startedAt || nowIso(),
  };
  if (existing) Object.assign(existing, row);
  else contact.calls.unshift(row);
  if (contact.calls.length > MAX_CALL_REFS) contact.calls = contact.calls.slice(0, MAX_CALL_REFS);
  pushTimelineEvent(contact, {
    type: row.direction === 'inbound' ? 'inbound' : 'outbound',
    label: (row.direction === 'inbound' ? 'Inbound call' : 'Outbound call'),
    detail: [row.outcome, row.status].filter(Boolean).join(' · ') || null,
    callId: row.id,
    employeeId: row.employeeId,
    at: row.at,
  });
}

function addAppointment(contact, input) {
  if (!contact) return { ok: false, error: 'contact required', code: 'missing_contact' };
  if (!Array.isArray(contact.appointments)) contact.appointments = [];
  const b = input && typeof input === 'object' ? input : {};
  const startAt = b.startAt || b.start || null;
  const startMs = startAt ? Date.parse(String(startAt)) : NaN;
  if (!Number.isFinite(startMs)) {
    return { ok: false, status: 422, error: 'appointment startAt required (ISO)', code: 'bad_appointment' };
  }
  // Duplicate protection: same cal uid or same start+title.
  const calUid = b.calBookingUid || b.cal_booking_uid || null;
  if (calUid) {
    const dup = contact.appointments.find((a) => a.calBookingUid === String(calUid));
    if (dup) return { ok: true, appointment: dup, created: false, duplicate: true };
  }
  const title = clampStr(b.title || b.service || 'Meeting', 120) || 'Meeting';
  const startIso = new Date(startMs).toISOString();
  const softDup = contact.appointments.find(
    (a) => a.startAt === startIso && a.title === title && a.status !== 'cancelled',
  );
  if (softDup) return { ok: true, appointment: softDup, created: false, duplicate: true };

  const endAt = b.endAt || b.end || null;
  const endMs = endAt ? Date.parse(String(endAt)) : NaN;
  const appt = {
    id: genId('appt_'),
    title,
    status: normalizeAppointmentStatus(b.status, 'booked'),
    startAt: startIso,
    endAt: Number.isFinite(endMs) ? new Date(endMs).toISOString() : null,
    timezone: clampStr(b.timezone || 'Asia/Kolkata', 64) || 'Asia/Kolkata',
    calBookingUid: calUid ? String(calUid) : null,
    eventTypeId: b.eventTypeId != null ? Number(b.eventTypeId) : null,
    notes: clampStr(b.notes, 400) || null,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  contact.appointments.unshift(appt);
  if (contact.appointments.length > MAX_APPOINTMENTS) {
    contact.appointments = contact.appointments.slice(0, MAX_APPOINTMENTS);
  }
  const timelineType = appt.status === 'requested'
    ? 'appointment_requested'
    : appt.status === 'cancelled'
      ? 'appointment_cancelled'
      : appt.status === 'rescheduled'
        ? 'appointment_rescheduled'
        : 'booked';
  pushTimelineEvent(contact, {
    type: timelineType,
    label: appt.status === 'booked' ? 'Appointment booked' : ('Appointment ' + appt.status),
    detail: [appt.title, appt.startAt].filter(Boolean).join(' · '),
    appointmentId: appt.id,
  });
  contact.updatedAt = nowIso();
  return { ok: true, appointment: appt, created: true, duplicate: false };
}

function addAction(contact, input) {
  if (!contact) return { ok: false, error: 'contact required', code: 'missing_contact' };
  if (!Array.isArray(contact.actions)) contact.actions = [];
  const b = input && typeof input === 'object' ? input : {};
  const type = clampStr(b.type || b.key || 'follow_up', 40) || 'follow_up';
  const triggerEvent = clampStr(b.triggerEvent || b.trigger_event || '', 64) || null;
  const scheduledAt = b.scheduledAt || b.scheduled_at || null;
  const scheduledMs = scheduledAt ? Date.parse(String(scheduledAt)) : NaN;

  // Duplicate protection for same event + type unless explicit.
  if (!b.force && triggerEvent) {
    const dup = contact.actions.find((a) => (
      a.triggerEvent === triggerEvent
      && a.type === type
      && (a.status === 'pending' || a.status === 'scheduled')
    ));
    if (dup) return { ok: true, action: dup, created: false, duplicate: true };
  }

  const action = {
    id: genId('act_'),
    type,
    label: clampStr(b.label || type, 80) || type,
    status: clampStr(b.status || 'pending', 24) || 'pending',
    triggerEvent,
    scheduledAt: Number.isFinite(scheduledMs) ? new Date(scheduledMs).toISOString() : null,
    jobId: b.jobId || null,
    notes: clampStr(b.notes, 240) || null,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  contact.actions.unshift(action);
  if (contact.actions.length > MAX_ACTIONS) contact.actions = contact.actions.slice(0, MAX_ACTIONS);

  if (type.includes('callback') || type.includes('follow')) {
    pushTimelineEvent(contact, {
      type: type.includes('confirm') ? 'outbound_confirmation' : 'follow_up_scheduled',
      label: action.label,
      detail: action.scheduledAt || action.triggerEvent,
      jobId: action.jobId,
    });
  }

  if (!contact.nextAction) {
    contact.nextAction = action.label;
    contact.nextActionAt = action.scheduledAt;
  }
  contact.updatedAt = nowIso();
  return { ok: true, action, created: true, duplicate: false };
}

/**
 * Employee handoff: context stays customer/tenant-scoped. Reassign employee only.
 * Vaani can receive Maya-qualified context; facts do not change tenant.
 */
function handoffContact(db, tenantId, contactId, toEmployeeId, opts = {}) {
  const row = findContact(db, tenantId, contactId);
  if (!row) return { ok: false, status: 404, error: 'contact not found', code: 'not_found' };
  if (!toEmployeeId) {
    return { ok: false, status: 422, error: 'toEmployeeId required', code: 'bad_employee' };
  }
  const emp = (db.employees || []).find(
    (e) => e.id === String(toEmployeeId) && e.tenantId === tenantId && e.status !== 'ARCHIVED',
  );
  if (!emp) return { ok: false, status: 404, error: 'employee not found', code: 'employee_not_found' };

  const from = row.assignedEmployee || opts.fromEmployeeId || null;
  row.assignedEmployee = emp.id;
  if (row.qualificationStatus === 'qualified' || opts.markHandedOff) {
    row.qualificationStatus = 'handed_off';
  }
  pushTimelineEvent(row, {
    type: 'handoff',
    label: 'Employee handoff',
    detail: [from, emp.id, emp.name].filter(Boolean).join(' → '),
    employeeId: emp.id,
  });
  row.updatedAt = nowIso();
  return { ok: true, contact: row, fromEmployeeId: from, toEmployeeId: emp.id };
}

/**
 * Build customer timeline from contact timelineEvents (+ optional live jobs).
 */
function buildCustomerTimeline(db, tenantId, contactId, opts = {}) {
  const row = findContact(db, tenantId, contactId);
  if (!row) return { ok: false, status: 404, error: 'contact not found', code: 'not_found' };

  const events = (row.timelineEvents || []).map((e) => ({
    at: e.at,
    type: e.type,
    label: e.label,
    detail: e.detail,
    callId: e.callId || null,
    appointmentId: e.appointmentId || null,
    jobId: e.jobId || null,
    employeeId: e.employeeId || null,
    contactId: row.id,
  }));

  // Merge pending outbound jobs for this contact (live status).
  const jobs = (db.outboundJobs || []).filter(
    (j) => j.tenantId === tenantId && j.contactId === row.id,
  );
  for (const job of jobs) {
    events.push({
      at: job.scheduledAt || job.createdAt,
      type: job.triggerEvent && String(job.triggerEvent).includes('confirm')
        ? 'outbound_confirmation'
        : 'follow_up_scheduled',
      label: 'Outbound job · ' + (job.status || 'pending'),
      detail: [job.triggerEvent, job.scheduledAt].filter(Boolean).join(' · '),
      jobId: job.id,
      employeeId: job.employeeId || null,
      contactId: row.id,
    });
  }

  events.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
  const limit = Math.max(1, Math.min(200, Number(opts.limit) || 50));
  const limited = events.slice(0, limit);
  return {
    ok: true,
    timeline: {
      scope: 'contact',
      contact_id: row.id,
      events: limited,
      count: limited.length,
      empty: limited.length === 0,
    },
  };
}

module.exports = {
  LEAD_STATUSES,
  QUALIFICATION_STATUSES,
  APPOINTMENT_STATUSES,
  TIMELINE_TYPES,
  MAX_INJECTION_CHARS,
  MAX_SUMMARY_CHARS,
  MAX_CUMULATIVE_CHARS,
  ensureContacts,
  normalizePhone,
  isValidE164,
  publicContact,
  findContact,
  findContactByPhone,
  listContacts,
  resolveContact,
  patchContact,
  mergeCumulativeSummary,
  buildContextInjection,
  recordCallRef,
  addAppointment,
  addAction,
  handoffContact,
  buildCustomerTimeline,
  pushTimelineEvent,
  emptyContact,
};
