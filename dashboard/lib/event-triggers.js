/**
 * Astra Voice. Event trigger engine for continuous customer context.
 *
 * Events may generate contact actions and persisted outbound jobs.
 * Never auto-places paid PSTN. Duplicate jobs for the same event are blocked
 * unless force=true.
 *
 * Events: call.completed, lead.created, lead.qualified,
 * appointment.requested|booked|rescheduled|cancelled,
 * followup.required, callback.requested
 *
 * No em dashes anywhere. Commas and periods only.
 */
'use strict';

const customerContext = require('./customer-context');
const outboundJobs = require('./outbound-jobs');

const TRIGGER_EVENTS = Object.freeze([
  'call.completed',
  'lead.created',
  'lead.qualified',
  'appointment.requested',
  'appointment.booked',
  'appointment.rescheduled',
  'appointment.cancelled',
  'followup.required',
  'callback.requested',
]);

const DEFAULT_CALLBACK_RULES = Object.freeze({
  onBookingConfirmation: true,
  remindBeforeMinutes: Object.freeze([60, 1440]),
  customOffsetsMinutes: Object.freeze([]),
  timezone: 'Asia/Kolkata',
});

function normalizeCallbackRules(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const remind = Array.isArray(src.remindBeforeMinutes)
    ? src.remindBeforeMinutes.map((n) => Number(n)).filter((n) => Number.isFinite(n) && n > 0).slice(0, 8)
    : DEFAULT_CALLBACK_RULES.remindBeforeMinutes.slice();
  const custom = Array.isArray(src.customOffsetsMinutes)
    ? src.customOffsetsMinutes.map((n) => Number(n)).filter((n) => Number.isFinite(n) && n > 0).slice(0, 8)
    : [];
  return {
    onBookingConfirmation: src.onBookingConfirmation !== false,
    remindBeforeMinutes: remind.length ? remind : DEFAULT_CALLBACK_RULES.remindBeforeMinutes.slice(),
    customOffsetsMinutes: custom,
    timezone: String(src.timezone || DEFAULT_CALLBACK_RULES.timezone).trim() || 'Asia/Kolkata',
  };
}

function getEmployeeCallbackRules(db, tenantId, employeeId) {
  if (!employeeId) return normalizeCallbackRules(null);
  const emp = (db.employees || []).find((e) => e.id === String(employeeId) && e.tenantId === tenantId);
  if (!emp) return normalizeCallbackRules(null);
  return normalizeCallbackRules(emp.callbackRules || emp.callback_rules);
}

function mapEventToJobPlans(eventName, payload, rules) {
  const plans = [];
  const p = payload && typeof payload === 'object' ? payload : {};
  const now = Date.now();

  switch (String(eventName || '')) {
    case 'appointment.booked': {
      if (rules.onBookingConfirmation) {
        plans.push({
          triggerEvent: 'appointment.booked.confirmation',
          scheduledAt: new Date(now).toISOString(),
          label: 'Booking confirmation follow-up',
          immediate: true,
        });
      }
      const startMs = p.appointmentStartAt ? Date.parse(String(p.appointmentStartAt)) : NaN;
      if (Number.isFinite(startMs)) {
        const offsets = [...rules.remindBeforeMinutes, ...rules.customOffsetsMinutes];
        for (const mins of offsets) {
          const at = startMs - (mins * 60 * 1000);
          if (at <= now) continue;
          plans.push({
            triggerEvent: 'appointment.booked.reminder.' + mins + 'm',
            scheduledAt: new Date(at).toISOString(),
            label: 'Appointment reminder (' + mins + 'm before)',
            immediate: false,
          });
        }
      }
      break;
    }
    case 'callback.requested': {
      const when = p.scheduledAt ? Date.parse(String(p.scheduledAt)) : NaN;
      plans.push({
        triggerEvent: 'callback.requested',
        scheduledAt: Number.isFinite(when) ? new Date(when).toISOString() : new Date(now).toISOString(),
        label: 'Customer callback',
        immediate: !Number.isFinite(when) || when <= now + 5000,
      });
      break;
    }
    case 'followup.required': {
      const when = p.scheduledAt ? Date.parse(String(p.scheduledAt)) : now;
      plans.push({
        triggerEvent: 'followup.required',
        scheduledAt: new Date(Number.isFinite(when) ? when : now).toISOString(),
        label: 'Follow-up required',
        immediate: false,
      });
      break;
    }
    case 'lead.qualified': {
      plans.push({
        triggerEvent: 'lead.qualified.followup',
        scheduledAt: new Date(now).toISOString(),
        label: 'Qualified lead follow-up',
        immediate: true,
      });
      break;
    }
    case 'appointment.requested':
    case 'appointment.rescheduled':
    case 'appointment.cancelled':
    case 'call.completed':
    case 'lead.created':
      // Soft actions only. Jobs only when payload asks for follow-up.
      if (p.createFollowUp) {
        plans.push({
          triggerEvent: String(eventName) + '.followup',
          scheduledAt: p.scheduledAt
            ? new Date(Date.parse(String(p.scheduledAt)) || now).toISOString()
            : new Date(now).toISOString(),
          label: 'Event follow-up · ' + eventName,
          immediate: false,
        });
      }
      break;
    default:
      break;
  }
  return plans;
}

/**
 * Handle a domain event: update contact actions + create outbound jobs.
 * Returns generated actions/jobs. Never dials.
 */
function handleEvent(db, tenantId, eventName, payload = {}, opts = {}) {
  const name = String(eventName || '').trim();
  if (!TRIGGER_EVENTS.includes(name) && !name.startsWith('appointment.') && !name.startsWith('callback.')) {
    return { ok: false, status: 422, error: 'unsupported event', code: 'bad_event', allowed: TRIGGER_EVENTS.slice() };
  }

  const p = payload && typeof payload === 'object' ? payload : {};
  let contact = null;
  if (p.contactId || p.contact_id) {
    contact = customerContext.findContact(db, tenantId, p.contactId || p.contact_id);
  }
  if (!contact && (p.phone || p.primaryPhone)) {
    const resolved = customerContext.resolveContact(db, tenantId, p.phone || p.primaryPhone, {
      name: p.name,
      email: p.email,
      company: p.company,
      assignedEmployee: p.employeeId || p.employee_id,
      preferredLanguage: p.preferredLanguage || p.preferred_language,
    });
    if (!resolved.ok) return resolved;
    contact = resolved.contact;
  }
  if (!contact) {
    return { ok: false, status: 422, error: 'contact_id or phone required', code: 'missing_contact' };
  }

  const employeeId = p.employeeId || p.employee_id || contact.assignedEmployee || null;
  const rules = opts.callbackRules
    ? normalizeCallbackRules(opts.callbackRules)
    : getEmployeeCallbackRules(db, tenantId, employeeId);

  const actions = [];
  const jobs = [];
  const plans = mapEventToJobPlans(name, {
    ...p,
    appointmentStartAt: p.appointmentStartAt
      || (p.appointment && (p.appointment.startAt || p.appointment.start))
      || null,
  }, rules);

  // Always record a contact action for the raw event.
  const baseAction = customerContext.addAction(contact, {
    type: name.replace(/\./g, '_'),
    label: name,
    triggerEvent: name,
    status: 'recorded',
    notes: p.notes || null,
    force: true,
  });
  if (baseAction.ok) actions.push(baseAction.action);

  for (const plan of plans) {
    const jobResult = outboundJobs.createOutboundJob(db, tenantId, {
      contactId: contact.id,
      employeeId,
      phone: contact.primaryPhone,
      triggerEvent: plan.triggerEvent,
      scheduledAt: plan.scheduledAt,
      leadId: contact.leadId || p.leadId || null,
      appointmentId: p.appointmentId || (p.appointment && p.appointment.id) || null,
      contextSnapshot: {
        contact_id: contact.id,
        event: name,
        label: plan.label,
        preferred_language: contact.preferredLanguage || null,
        last_summary: contact.lastConversationSummary || null,
        appointment_start: p.appointmentStartAt || null,
      },
      force: !!opts.force,
      idempotencyKey: opts.force
        ? null
        : [tenantId, contact.id, plan.triggerEvent, plan.scheduledAt || 'now'].join(':').slice(0, 120),
    }, opts.actorUserId || null);

    if (jobResult.ok) {
      jobs.push({
        job: jobResult.job,
        created: jobResult.created,
        duplicate: !!jobResult.duplicate,
      });
      if (jobResult.created) {
        const act = customerContext.addAction(contact, {
          type: plan.immediate ? 'outbound_confirmation' : 'follow_up',
          label: plan.label,
          triggerEvent: plan.triggerEvent,
          scheduledAt: plan.scheduledAt,
          status: 'scheduled',
          jobId: jobResult.job.id,
          force: true,
        });
        if (act.ok) actions.push(act.action);
        customerContext.pushTimelineEvent(contact, {
          type: plan.immediate ? 'outbound_confirmation' : 'follow_up_scheduled',
          label: plan.label,
          detail: plan.scheduledAt,
          jobId: jobResult.job.id,
          employeeId,
        });
      }
    }
  }

  if (name === 'lead.qualified') {
    contact.qualificationStatus = 'qualified';
    if (contact.leadStatus === 'new' || contact.leadStatus === 'contacted') {
      contact.leadStatus = 'qualified';
    }
  }
  if (name === 'lead.created' && contact.leadStatus === 'new') {
    // already new
  }
  contact.updatedAt = new Date().toISOString();

  return {
    ok: true,
    event: name,
    contact_id: contact.id,
    actions,
    jobs,
    dialed: false,
    auto_dial: false,
  };
}

module.exports = {
  TRIGGER_EVENTS,
  DEFAULT_CALLBACK_RULES,
  normalizeCallbackRules,
  getEmployeeCallbackRules,
  mapEventToJobPlans,
  handleEvent,
};
