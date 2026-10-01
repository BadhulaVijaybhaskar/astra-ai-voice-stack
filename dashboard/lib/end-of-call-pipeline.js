/**
 * Astra Voice. End-of-call pipeline for continuous customer context.
 *
 * Flow: transcript → summary → structured extraction → contact / lead /
 * appointment / next_action / outbound jobs update. Cumulative context merges
 * without erasing older useful facts. Never dumps full transcripts into jobs.
 *
 * No em dashes anywhere. Commas and periods only.
 */
'use strict';

const customerContext = require('./customer-context');
const eventTriggers = require('./event-triggers');
const leads = require('./leads');
const calcom = require('./calcom');

const SUMMARY_MAX = customerContext.MAX_SUMMARY_CHARS;

function clamp(s, n) {
  return String(s == null ? '' : s).trim().slice(0, n);
}

/**
 * Build a compact summary from transcript turns or an explicit summary string.
 * Does not invent facts. Prefer provided summary when present.
 */
function summarizeTranscript(transcript, explicitSummary) {
  if (explicitSummary) return clamp(explicitSummary, SUMMARY_MAX);
  if (!transcript) return null;
  if (typeof transcript === 'string') return clamp(transcript, SUMMARY_MAX);
  if (!Array.isArray(transcript)) return null;
  const bits = [];
  for (const turn of transcript.slice(-12)) {
    const role = turn.role || turn.speaker || 'party';
    const text = clamp(turn.text || turn.content || '', 160);
    if (!text) continue;
    bits.push(String(role) + ': ' + text);
    if (bits.join(' ').length > SUMMARY_MAX) break;
  }
  const joined = bits.join(' · ');
  return joined ? clamp(joined, SUMMARY_MAX) : null;
}

/**
 * Structured extraction from call payload / extractedData.
 * Business fields only. Language preference preserved separately.
 */
function extractStructured(payload) {
  const b = payload && typeof payload === 'object' ? payload : {};
  const data = (b.extractedData && typeof b.extractedData === 'object')
    ? b.extractedData
    : ((b.extracted && typeof b.extracted === 'object') ? b.extracted : b);

  const realBookingId = calcom.extractRealBookingId(b);
  const softBookSignal = data.booked === true
    || String(b.outcome || '').toLowerCase().includes('book')
    || !!(data.appointment && (data.appointment.status === 'booked' || data.appointment.startAt || data.appointment.start));

  const out = {
    name: clamp(data.name || data.caller_name || b.callerName || '', 120) || null,
    email: clamp(data.email || '', 180).toLowerCase() || null,
    company: clamp(data.company || '', 120) || null,
    interest: clamp(data.interest || data.need || data.intent || '', 240) || null,
    businessGoal: clamp(data.business_goal || data.businessGoal || data.goal || '', 240) || null,
    timeline: clamp(data.timeline || data.preferred_timeline || '', 120) || null,
    leadStatus: data.lead_status || data.leadStatus || null,
    qualificationStatus: data.qualification_status || data.qualificationStatus || null,
    preferredLanguage: clamp(
      data.preferred_language || data.preferredLanguage || b.language || b.detectedLanguage || '',
      16,
    ) || null,
    detectedLanguages: Array.isArray(data.detected_languages || data.detectedLanguages)
      ? (data.detected_languages || data.detectedLanguages)
      : (b.detectedLanguage ? [b.detectedLanguage] : []),
    outcome: clamp(data.outcome || b.outcome || '', 64) || null,
    nextAction: clamp(data.next_action || data.nextAction || '', 200) || null,
    nextActionAt: data.next_action_at || data.nextActionAt || null,
    appointment: data.appointment && typeof data.appointment === 'object' ? data.appointment : null,
    qualified: data.qualified === true
      || String(data.qualification_status || data.qualificationStatus || '').toLowerCase() === 'qualified'
      || String(b.outcome || '').toLowerCase().includes('qualif'),
    // Gate: appointment.booked / confirmation only when a real booking id exists.
    realBookingId,
    bookingCompleted: !!(realBookingId && softBookSignal),
    softBookSignal: !!softBookSignal,
    callbackRequested: data.callback_requested === true
      || !!(data.callback && (data.callback.when || data.callback.scheduledAt)),
    callbackWhen: (data.callback && (data.callback.when || data.callback.scheduledAt))
      || data.callback_when
      || null,
  };
  return out;
}

/**
 * Run the full end-of-call pipeline against db.json entities.
 * Does not place PSTN calls.
 */
function runEndOfCallPipeline(db, tenantId, input, opts = {}) {
  const b = input && typeof input === 'object' ? input : {};
  const phone = b.phone || b.fromE164 || b.toE164 || b.primaryPhone;
  if (!phone && !(b.contactId || b.contact_id)) {
    return { ok: false, status: 422, error: 'phone or contact_id required', code: 'missing_contact' };
  }

  let contact = null;
  if (b.contactId || b.contact_id) {
    contact = customerContext.findContact(db, tenantId, b.contactId || b.contact_id);
    if (!contact) return { ok: false, status: 404, error: 'contact not found', code: 'not_found' };
  } else {
    const resolved = customerContext.resolveContact(db, tenantId, phone, {
      name: b.name || b.callerName,
      email: b.email,
      company: b.company,
      assignedEmployee: b.employeeId || b.employee_id,
      preferredLanguage: b.preferredLanguage || b.language,
    });
    if (!resolved.ok) return resolved;
    contact = resolved.contact;
  }

  const extracted = extractStructured(b);
  const summary = summarizeTranscript(b.transcript, b.summary || b.lastConversationSummary);

  // Patch structured business fields (internal/normalized).
  const patch = {};
  if (extracted.name && !contact.name) patch.name = extracted.name;
  if (extracted.email) patch.email = extracted.email;
  if (extracted.company) patch.company = extracted.company;
  if (extracted.interest) patch.interest = extracted.interest;
  if (extracted.businessGoal) patch.businessGoal = extracted.businessGoal;
  if (extracted.timeline) patch.timeline = extracted.timeline;
  if (extracted.leadStatus) patch.leadStatus = extracted.leadStatus;
  if (extracted.qualificationStatus) patch.qualificationStatus = extracted.qualificationStatus;
  if (extracted.preferredLanguage) patch.preferredLanguage = extracted.preferredLanguage;
  if (extracted.detectedLanguages && extracted.detectedLanguages.length) {
    const merged = new Set([
      ...(contact.detectedLanguages || []),
      ...extracted.detectedLanguages.map((l) => String(l).trim()).filter(Boolean),
    ]);
    patch.detectedLanguages = [...merged].slice(0, 8);
  }
  if (extracted.nextAction) patch.nextAction = extracted.nextAction;
  if (extracted.nextActionAt) patch.nextActionAt = extracted.nextActionAt;
  if (b.employeeId || b.employee_id) {
    if (!contact.assignedEmployee) patch.assignedEmployee = b.employeeId || b.employee_id;
  }
  if (Object.keys(patch).length) {
    customerContext.patchContact(db, tenantId, contact.id, patch);
  }

  if (summary) {
    contact.lastConversationSummary = summary;
    contact.cumulativeContextSummary = customerContext.mergeCumulativeSummary(
      contact.cumulativeContextSummary,
      summary,
    );
  }

  const callId = b.callId || b.call_id || null;
  if (callId) {
    customerContext.recordCallRef(contact, {
      id: callId,
      direction: b.direction || null,
      status: b.status || 'completed',
      outcome: extracted.outcome || b.outcome || null,
      employeeId: b.employeeId || b.employee_id || contact.assignedEmployee,
      summary,
      at: b.endedAt || b.at || new Date().toISOString(),
    });
  }

  const appointments = [];
  const jobs = [];
  const events = [];

  if (extracted.appointment || extracted.bookingCompleted || extracted.softBookSignal) {
    const hasRealBooking = !!extracted.realBookingId;
    const apptInput = extracted.appointment || {
      title: b.appointmentTitle || 'Meeting',
      startAt: b.appointmentStartAt || b.start,
      endAt: b.appointmentEndAt || b.end,
      status: hasRealBooking ? 'booked' : 'requested',
      calBookingUid: extracted.realBookingId || b.calBookingUid,
      eventTypeId: b.eventTypeId,
      timezone: b.timezone || 'Asia/Kolkata',
    };
    // Without a real Cal.com booking id, never claim booked or schedule confirmation.
    if (!hasRealBooking) {
      apptInput.status = apptInput.status === 'cancelled' || apptInput.status === 'rescheduled'
        ? apptInput.status
        : 'requested';
      delete apptInput.calBookingUid;
    } else {
      apptInput.status = 'booked';
      apptInput.calBookingUid = extracted.realBookingId;
    }
    if (apptInput.startAt || apptInput.start) {
      const apptRes = customerContext.addAppointment(contact, apptInput);
      if (apptRes.ok) {
        appointments.push(apptRes.appointment);
        if (apptRes.created) {
          const eventName = hasRealBooking
            ? 'appointment.booked'
            : (apptRes.appointment.status === 'cancelled'
              ? 'appointment.cancelled'
              : apptRes.appointment.status === 'rescheduled'
                ? 'appointment.rescheduled'
                : 'appointment.requested');
          // Only appointment.booked creates confirmation follow-ups (autoDial false).
          const evt = eventTriggers.handleEvent(db, tenantId, eventName, {
            contactId: contact.id,
            employeeId: contact.assignedEmployee,
            appointment: apptRes.appointment,
            appointmentId: apptRes.appointment.id,
            appointmentStartAt: apptRes.appointment.startAt,
          }, { actorUserId: opts.actorUserId, force: false });
          if (evt.ok) {
            events.push(evt);
            for (const j of evt.jobs || []) jobs.push(j);
          }
        }
      }
    }
  }

  if (extracted.qualified) {
    contact.qualificationStatus = 'qualified';
    if (contact.leadStatus === 'new' || contact.leadStatus === 'contacted') {
      contact.leadStatus = 'qualified';
    }
    const evt = eventTriggers.handleEvent(db, tenantId, 'lead.qualified', {
      contactId: contact.id,
      employeeId: contact.assignedEmployee,
      createFollowUp: !!b.createQualifiedFollowUp,
    }, { actorUserId: opts.actorUserId });
    if (evt.ok) {
      events.push(evt);
      for (const j of evt.jobs || []) jobs.push(j);
    }
  }

  if (extracted.callbackRequested && extracted.callbackWhen) {
    const evt = eventTriggers.handleEvent(db, tenantId, 'callback.requested', {
      contactId: contact.id,
      employeeId: contact.assignedEmployee,
      scheduledAt: extracted.callbackWhen,
      phone: contact.primaryPhone,
    }, { actorUserId: opts.actorUserId });
    if (evt.ok) {
      events.push(evt);
      for (const j of evt.jobs || []) jobs.push(j);
    }
  }

  // Always emit call.completed for audit/action trail (jobs only if createFollowUp).
  const completedEvt = eventTriggers.handleEvent(db, tenantId, 'call.completed', {
    contactId: contact.id,
    employeeId: contact.assignedEmployee,
    phone: contact.primaryPhone,
    createFollowUp: !!b.createFollowUp,
    scheduledAt: b.followUpAt || null,
    notes: extracted.outcome || null,
  }, { actorUserId: opts.actorUserId, force: true });
  if (completedEvt.ok) {
    events.push(completedEvt);
    for (const j of completedEvt.jobs || []) jobs.push(j);
  }

  // Keep linked Lead in sync when present.
  if (contact.leadId) {
    const lead = leads.findLead(db, tenantId, contact.leadId);
    if (lead) {
      const leadPatch = {};
      if (extracted.outcome) leadPatch.outcomeKey = String(extracted.outcome).slice(0, 40);
      if (callId) leadPatch.lastCallId = callId;
      if (extracted.qualified) leadPatch.status = 'qualified';
      else if (b.direction === 'outbound' && lead.status === 'calling') leadPatch.status = 'called';
      if (Object.keys(leadPatch).length) leads.updateLead(db, tenantId, lead.id, leadPatch);
    }
  } else if (b.syncLead !== false && contact.primaryPhone) {
    // Soft-link existing lead by phone without creating duplicates when name missing.
    const match = (db.leads || []).find(
      (l) => l.tenantId === tenantId && l.phone === contact.primaryPhone,
    );
    if (match) {
      contact.leadId = match.id;
      if (!contact.assignedEmployee && match.employeeId) contact.assignedEmployee = match.employeeId;
    }
  }

  contact.updatedAt = new Date().toISOString();

  return {
    ok: true,
    contact: customerContext.publicContact(contact, { detail: true }),
    summary,
    extracted: {
      interest: contact.interest,
      business_goal: contact.businessGoal,
      timeline: contact.timeline,
      qualification_status: contact.qualificationStatus,
      preferred_language: contact.preferredLanguage,
      outcome: extracted.outcome,
    },
    appointments,
    jobs,
    events: events.map((e) => ({ event: e.event, jobs: (e.jobs || []).length, dialed: false })),
    dialed: false,
  };
}

module.exports = {
  summarizeTranscript,
  extractStructured,
  runEndOfCallPipeline,
};
