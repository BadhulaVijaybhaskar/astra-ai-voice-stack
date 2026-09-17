/**
 * Astra AI. Activity Timeline for Employees and Leads (Phase 10).
 *
 * Events are derived only from real Lead / CallJob / Call rows. Never invent
 * analytics or placeholder activity. Honest empty = { events: [], count: 0 }.
 *
 * Customer language: lead connected, call started/ended, outcome set, job
 * queued/dialing/completed/failed. No Dograh / VoBiz / provider ids.
 *
 * No em dashes anywhere. Commas and periods only.
 */
'use strict';

function asIso(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function pushEvent(events, evt) {
  if (!evt || !evt.at || !evt.type) return;
  events.push({
    at: evt.at,
    type: evt.type,
    label: evt.label || evt.type,
    detail: evt.detail || null,
    leadId: evt.leadId || null,
    callId: evt.callId || null,
    callJobId: evt.callJobId || null,
    employeeId: evt.employeeId || null,
    outcomeKey: evt.outcomeKey || null,
    status: evt.status || null,
  });
}

function jobEvents(job, ctx = {}) {
  const out = [];
  const leadId = job.leadId || ctx.leadId || null;
  const employeeId = job.employeeId || ctx.employeeId || null;
  if (job.createdAt) {
    pushEvent(out, {
      at: asIso(job.createdAt),
      type: 'job_queued',
      label: 'Call job queued',
      detail: job.toE164 || null,
      leadId,
      callJobId: job.id,
      employeeId,
      status: 'queued',
    });
  }
  if (job.dialedAt) {
    pushEvent(out, {
      at: asIso(job.dialedAt),
      type: 'job_dialing',
      label: 'Call job dialing',
      detail: job.toE164 || null,
      leadId,
      callJobId: job.id,
      employeeId,
      status: 'dialing',
    });
  }
  if (job.status === 'completed' && job.completedAt) {
    pushEvent(out, {
      at: asIso(job.completedAt),
      type: 'job_completed',
      label: 'Call job completed',
      detail: job.resultCallId ? ('Conversation ' + job.resultCallId) : null,
      leadId,
      callId: job.resultCallId || null,
      callJobId: job.id,
      employeeId,
      status: 'completed',
    });
  }
  if (job.status === 'failed' && (job.completedAt || job.updatedAt)) {
    pushEvent(out, {
      at: asIso(job.completedAt || job.updatedAt),
      type: 'job_failed',
      label: 'Call job failed',
      detail: job.lastError || null,
      leadId,
      callId: job.resultCallId || null,
      callJobId: job.id,
      employeeId,
      status: 'failed',
    });
  }
  return out;
}

function callEvents(call, ctx = {}) {
  const out = [];
  const employeeId = ctx.employeeId || null;
  const leadId = ctx.leadId || null;
  if (call.startedAt || call.createdAt) {
    pushEvent(out, {
      at: asIso(call.startedAt || call.createdAt),
      type: 'call_started',
      label: 'Conversation started',
      detail: [call.direction, call.fromE164, call.toE164].filter(Boolean).join(' · ') || null,
      leadId,
      callId: call.id,
      employeeId,
      status: call.status || null,
    });
  }
  if (call.endedAt) {
    pushEvent(out, {
      at: asIso(call.endedAt),
      type: 'call_ended',
      label: 'Conversation ended',
      detail: call.durationSec != null ? (String(call.durationSec) + 's') : (call.status || null),
      leadId,
      callId: call.id,
      employeeId,
      status: call.status || null,
    });
  }
  if (call.outcome) {
    pushEvent(out, {
      at: asIso(call.endedAt || call.updatedAt || call.startedAt),
      type: 'outcome_set',
      label: 'Outcome set',
      detail: String(call.outcome),
      leadId,
      callId: call.id,
      employeeId,
      outcomeKey: String(call.outcome),
    });
  }
  return out;
}

function sortAndLimit(events, limit) {
  const lim = Math.max(1, Math.min(200, Number(limit) || 50));
  events.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
  return events.slice(0, lim);
}

/**
 * Timeline for one employee: connected leads, their jobs, and calls for the
 * linked agent. Only real rows. No invented events.
 */
function buildEmployeeTimeline(db, tenantId, employeeId, opts = {}) {
  const emp = (db.employees || []).find(
    (e) => e.id === String(employeeId || '') && e.tenantId === tenantId,
  );
  if (!emp) return { ok: false, status: 404, error: 'employee not found', code: 'not_found' };

  const events = [];
  const leads = (db.leads || []).filter(
    (l) => l.tenantId === tenantId && l.employeeId === emp.id,
  );
  for (const lead of leads) {
    if (lead.createdAt) {
      pushEvent(events, {
        at: asIso(lead.createdAt),
        type: 'lead_connected',
        label: 'Lead connected',
        detail: [lead.name, lead.phone].filter(Boolean).join(' · ') || null,
        leadId: lead.id,
        employeeId: emp.id,
        status: lead.status || null,
      });
    }
    if (lead.outcomeKey) {
      pushEvent(events, {
        at: asIso(lead.updatedAt || lead.createdAt),
        type: 'outcome_set',
        label: 'Lead outcome set',
        detail: String(lead.outcomeKey),
        leadId: lead.id,
        employeeId: emp.id,
        outcomeKey: String(lead.outcomeKey),
      });
    }
  }

  const leadIds = new Set(leads.map((l) => l.id));
  const jobs = (db.callJobs || []).filter((j) => {
    if (j.tenantId !== tenantId) return false;
    if (j.employeeId && j.employeeId === emp.id) return true;
    if (j.leadId && leadIds.has(j.leadId)) return true;
    if (emp.agentId && j.agentId === emp.agentId) return true;
    return false;
  });
  for (const job of jobs) {
    const lead = job.leadId ? leads.find((l) => l.id === job.leadId) : null;
    events.push(...jobEvents(job, { employeeId: emp.id, leadId: (lead && lead.id) || job.leadId || null }));
  }

  const callIds = new Set();
  for (const job of jobs) {
    if (job.resultCallId) callIds.add(job.resultCallId);
  }
  for (const lead of leads) {
    if (lead.lastCallId) callIds.add(lead.lastCallId);
  }
  const calls = (db.calls || []).filter((c) => {
    if (c.tenantId !== tenantId) return false;
    if (callIds.has(c.id)) return true;
    if (emp.agentId && c.agentId === emp.agentId) return true;
    return false;
  });
  for (const call of calls) {
    const linkedJob = jobs.find((j) => j.resultCallId === call.id);
    const leadId = (linkedJob && linkedJob.leadId) || null;
    events.push(...callEvents(call, { employeeId: emp.id, leadId }));
  }

  const limited = sortAndLimit(events, opts.limit);
  return {
    ok: true,
    timeline: {
      scope: 'employee',
      employeeId: emp.id,
      events: limited,
      count: limited.length,
      empty: limited.length === 0,
    },
  };
}

/**
 * Timeline for one lead: connection, jobs, linked call, outcome.
 */
function buildLeadTimeline(db, tenantId, leadId, opts = {}) {
  const lead = (db.leads || []).find(
    (l) => l.id === String(leadId || '') && l.tenantId === tenantId,
  );
  if (!lead) return { ok: false, status: 404, error: 'lead not found', code: 'not_found' };

  const events = [];
  if (lead.createdAt) {
    pushEvent(events, {
      at: asIso(lead.createdAt),
      type: 'lead_connected',
      label: lead.employeeId ? 'Lead connected' : 'Lead created',
      detail: [lead.name, lead.phone].filter(Boolean).join(' · ') || null,
      leadId: lead.id,
      employeeId: lead.employeeId || null,
      status: lead.status || null,
    });
  }
  if (lead.outcomeKey) {
    pushEvent(events, {
      at: asIso(lead.updatedAt || lead.createdAt),
      type: 'outcome_set',
      label: 'Lead outcome set',
      detail: String(lead.outcomeKey),
      leadId: lead.id,
      employeeId: lead.employeeId || null,
      outcomeKey: String(lead.outcomeKey),
    });
  }

  const jobs = (db.callJobs || []).filter(
    (j) => j.tenantId === tenantId && j.leadId === lead.id,
  );
  for (const job of jobs) {
    events.push(...jobEvents(job, { employeeId: lead.employeeId || job.employeeId || null, leadId: lead.id }));
  }

  const callIds = new Set();
  if (lead.lastCallId) callIds.add(lead.lastCallId);
  for (const job of jobs) {
    if (job.resultCallId) callIds.add(job.resultCallId);
  }
  const calls = (db.calls || []).filter(
    (c) => c.tenantId === tenantId && callIds.has(c.id),
  );
  for (const call of calls) {
    events.push(...callEvents(call, { employeeId: lead.employeeId || null, leadId: lead.id }));
  }

  const limited = sortAndLimit(events, opts.limit);
  return {
    ok: true,
    timeline: {
      scope: 'lead',
      leadId: lead.id,
      employeeId: lead.employeeId || null,
      events: limited,
      count: limited.length,
      empty: limited.length === 0,
    },
  };
}

module.exports = {
  buildEmployeeTimeline,
  buildLeadTimeline,
  jobEvents,
  callEvents,
};
