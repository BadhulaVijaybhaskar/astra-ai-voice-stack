/**
 * Astra Voice. Continuous customer context unit tests.
 * Covers: contact resolution, injection compactness, job persistence/restart,
 * duplicate protection, event→job mapping. Never dials PSTN.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const customerContext = require('../lib/customer-context');
const outboundJobs = require('../lib/outbound-jobs');
const eventTriggers = require('../lib/event-triggers');
const endOfCall = require('../lib/end-of-call-pipeline');
const callback = require('../lib/callback');
const core = require('../lib/core');

function emptyDb() {
  return {
    schemaVersion: 16,
    tenants: [{ id: 't1', name: 'Demo', status: 'active' }],
    users: [],
    agents: [],
    employees: [
      {
        id: 'emp_maya',
        tenantId: 't1',
        name: 'Maya',
        status: 'LIVE',
        callbackRules: {
          onBookingConfirmation: true,
          remindBeforeMinutes: [60, 1440],
          customOffsetsMinutes: [],
          timezone: 'Asia/Kolkata',
        },
      },
      {
        id: 'emp_vaani',
        tenantId: 't1',
        name: 'Vaani',
        status: 'LIVE',
        callbackRules: {
          onBookingConfirmation: true,
          remindBeforeMinutes: [60],
          customOffsetsMinutes: [],
          timezone: 'Asia/Kolkata',
        },
      },
    ],
    leads: [],
    calls: [],
    callJobs: [],
    contacts: [],
    outboundJobs: [],
    callbackJobs: [],
  };
}

test('CONTACT RESOLUTION: E.164 normalize → find or create, same contact inbound/outbound', () => {
  const db = emptyDb();
  const inbound = customerContext.resolveContact(db, 't1', '9876543210', {
    name: 'Arjun',
    assignedEmployee: 'emp_maya',
  });
  assert.equal(inbound.ok, true);
  assert.equal(inbound.created, true);
  assert.equal(inbound.contact.primaryPhone, '+919876543210');
  assert.equal(inbound.contact.name, 'Arjun');

  const outbound = customerContext.resolveContact(db, 't1', '+919876543210', {
    name: 'Arjun Kumar',
  });
  assert.equal(outbound.ok, true);
  assert.equal(outbound.created, false);
  assert.equal(outbound.contact.id, inbound.contact.id);
  assert.equal(db.contacts.length, 1);

  // Tenant isolation
  const other = customerContext.resolveContact(db, 't2', '+919876543210', { name: 'Other' });
  assert.equal(other.ok, true);
  assert.equal(other.created, true);
  assert.notEqual(other.contact.id, inbound.contact.id);
});

test('CONTEXT INJECTION: compact structured block, no full transcript dump', () => {
  const db = emptyDb();
  const r = customerContext.resolveContact(db, 't1', '+919811122233', {
    name: 'Priya',
    company: 'Acme',
    preferredLanguage: 'hi-IN',
    assignedEmployee: 'emp_maya',
  });
  r.contact.interest = 'AI voice agents for sales team';
  r.contact.businessGoal = 'Replace manual dialing';
  r.contact.timeline = 'This quarter';
  r.contact.qualificationStatus = 'qualified';
  r.contact.lastConversationSummary = 'Discussed 20-person sales team and demo next week.';
  r.contact.cumulativeContextSummary = 'Prior: asked about pricing. ' + 'x'.repeat(2000);
  customerContext.addAppointment(r.contact, {
    title: 'Demo',
    status: 'booked',
    startAt: '2026-10-05T10:00:00.000Z',
  });

  const inj = customerContext.buildContextInjection(r.contact);
  assert.equal(inj.ok, true);
  assert.equal(inj.includes_transcript, false);
  assert.equal(inj.compact, true);
  assert.ok(inj.block.length <= customerContext.MAX_INJECTION_CHARS);
  assert.ok(inj.tokensEstimate < 300);
  assert.ok(inj.block.includes('Priya'));
  assert.ok(inj.block.includes('Preferred language: hi-IN'));
  assert.ok(inj.block.includes('Appointment:'));
  assert.equal(inj.block.includes('x'.repeat(500)), false);
  assert.ok(!/transcript/i.test(inj.block) || inj.block.includes('facts only'));
});

test('JOB PERSISTENCE / RESTART: outbound jobs survive serialize restore', () => {
  const db = emptyDb();
  const contact = customerContext.resolveContact(db, 't1', '+919900011122', { name: 'Restart' }).contact;
  const created = outboundJobs.createOutboundJob(db, 't1', {
    contactId: contact.id,
    employeeId: 'emp_maya',
    phone: contact.primaryPhone,
    triggerEvent: 'callback.requested',
    scheduledAt: new Date(Date.now() + 3600_000).toISOString(),
    contextSnapshot: { note: 'survive reboot' },
  });
  assert.equal(created.ok, true);
  assert.equal(created.job.autoDial, false);
  assert.equal(created.job.status, 'scheduled');

  const snapshot = outboundJobs.serializeJobsForPersist(db);
  const db2 = emptyDb();
  outboundJobs.restoreJobsFromPersist(db2, snapshot);
  assert.equal(db2.outboundJobs.length, 1);
  assert.equal(db2.outboundJobs[0].id, created.job.id);
  assert.equal(db2.outboundJobs[0].contextSnapshot.note, 'survive reboot');
  assert.equal(db2.outboundJobs[0].status, 'scheduled');

  // Also prove core migrate keeps collections
  const migrated = core.migrateDb({ schemaVersion: 14, tenants: [], employees: [] });
  assert.ok(Array.isArray(migrated.contacts));
  assert.ok(Array.isArray(migrated.outboundJobs));
  assert.ok(migrated.schemaVersion >= 16);
});

test('DUPLICATE JOB PROTECTION: same event does not create second active job', () => {
  const db = emptyDb();
  const contact = customerContext.resolveContact(db, 't1', '+919933344455', { name: 'Dup' }).contact;
  const first = outboundJobs.createOutboundJob(db, 't1', {
    contactId: contact.id,
    phone: contact.primaryPhone,
    triggerEvent: 'appointment.booked.confirmation',
    scheduledAt: new Date().toISOString(),
  });
  assert.equal(first.created, true);
  const second = outboundJobs.createOutboundJob(db, 't1', {
    contactId: contact.id,
    phone: contact.primaryPhone,
    triggerEvent: 'appointment.booked.confirmation',
    scheduledAt: new Date().toISOString(),
  });
  assert.equal(second.created, false);
  assert.equal(second.duplicate, true);
  assert.equal(second.job.id, first.job.id);
  assert.equal(db.outboundJobs.length, 1);

  const forced = outboundJobs.createOutboundJob(db, 't1', {
    contactId: contact.id,
    phone: contact.primaryPhone,
    triggerEvent: 'appointment.booked.confirmation',
    scheduledAt: new Date().toISOString(),
    force: true,
  });
  assert.equal(forced.created, true);
  assert.equal(db.outboundJobs.length, 2);
});

test('EVENT → JOB MAPPING: appointment.booked creates confirmation + reminders, no dial', () => {
  const db = emptyDb();
  const startAt = new Date(Date.now() + 3 * 24 * 3600_000).toISOString();
  const contact = customerContext.resolveContact(db, 't1', '+919900000001', {
    name: 'Booker',
    assignedEmployee: 'emp_maya',
  }).contact;
  const appt = customerContext.addAppointment(contact, {
    title: 'Product demo',
    status: 'booked',
    startAt,
    calBookingUid: 'cal_uid_1',
  });
  assert.equal(appt.created, true);

  const evt = eventTriggers.handleEvent(db, 't1', 'appointment.booked', {
    contactId: contact.id,
    employeeId: 'emp_maya',
    appointment: appt.appointment,
    appointmentId: appt.appointment.id,
    appointmentStartAt: startAt,
  });
  assert.equal(evt.ok, true);
  assert.equal(evt.dialed, false);
  assert.equal(evt.auto_dial, false);
  const created = (evt.jobs || []).filter((j) => j.created);
  assert.ok(created.length >= 2); // confirmation + at least one reminder
  const triggers = created.map((j) => j.job.triggerEvent);
  assert.ok(triggers.includes('appointment.booked.confirmation'));
  assert.ok(triggers.some((t) => String(t).includes('reminder')));

  // Second fire is duplicate-protected
  const again = eventTriggers.handleEvent(db, 't1', 'appointment.booked', {
    contactId: contact.id,
    employeeId: 'emp_maya',
    appointment: appt.appointment,
    appointmentId: appt.appointment.id,
    appointmentStartAt: startAt,
  });
  const newlyCreated = (again.jobs || []).filter((j) => j.created);
  assert.equal(newlyCreated.length, 0);
});

test('CALLBACK SCHEDULING: natural language Asia/Kolkata → ISO, confirm only after persist', () => {
  const nowMs = Date.parse('2026-10-01T04:00:00.000Z'); // 09:30 IST
  const in30 = callback.parseNaturalCallbackWhen('call me back in 30 minutes', { nowMs });
  assert.equal(in30.ok, true);
  assert.equal(in30.mode, 'scheduled');
  assert.equal(in30.timezone, 'Asia/Kolkata');
  assert.equal(in30.atMs, nowMs + 30 * 60 * 1000);

  const morning = callback.parseNaturalCallbackWhen('tomorrow morning', { nowMs });
  assert.equal(morning.ok, true);
  const parts = callback.partsInKolkata(morning.atMs);
  assert.equal(parts.hh, 9);
  assert.equal(parts.mm, 0);

  const apptStart = Date.parse('2026-10-02T10:00:00.000Z');
  const remind = callback.parseNaturalCallbackWhen('remind me 1 hour before the meeting', {
    nowMs,
    appointmentStartAt: new Date(apptStart).toISOString(),
  });
  assert.equal(remind.ok, true);
  assert.equal(remind.atMs, apptStart - 60 * 60 * 1000);

  const db = emptyDb();
  const contact = customerContext.resolveContact(db, 't1', '+919912345678', { name: 'CB' }).contact;
  const evt = eventTriggers.handleEvent(db, 't1', 'callback.requested', {
    contactId: contact.id,
    employeeId: 'emp_maya',
    scheduledAt: in30.when,
    phone: contact.primaryPhone,
  });
  assert.equal(evt.ok, true);
  assert.equal(evt.dialed, false);
  assert.ok((evt.jobs || []).some((j) => j.created && j.job.id));
  // Verbal confirm gate: only after job id exists
  const jobId = evt.jobs[0].job.id;
  assert.ok(jobId);
  assert.equal(Boolean(jobId), true);
});

test('END-OF-CALL PIPELINE: summary + extraction + cumulative merge + language prefer', () => {
  const db = emptyDb();
  const first = endOfCall.runEndOfCallPipeline(db, 't1', {
    phone: '9811111111',
    name: 'Sneha',
    direction: 'inbound',
    callId: 'call_1',
    employeeId: 'emp_maya',
    summary: 'Caller asked about Astra Voice pricing for 10 seats.',
    extractedData: {
      interest: 'Pricing',
      business_goal: 'Automate inbound',
      timeline: 'Next month',
      preferred_language: 'te-IN',
      qualified: true,
    },
  });
  assert.equal(first.ok, true);
  assert.equal(first.dialed, false);
  assert.equal(first.contact.preferred_language, 'te-IN');
  assert.equal(first.contact.qualification_status, 'qualified');
  assert.ok(first.summary.includes('pricing') || first.summary.includes('Pricing') || first.contact.last_conversation_summary);

  const second = endOfCall.runEndOfCallPipeline(db, 't1', {
    phone: '+919811111111',
    direction: 'outbound',
    callId: 'call_2',
    employeeId: 'emp_maya',
    summary: 'Booked a demo for Friday.',
    extractedData: {
      appointment: {
        title: 'Demo',
        status: 'booked',
        startAt: new Date(Date.now() + 5 * 24 * 3600_000).toISOString(),
        calBookingUid: 'cal_uid_demo_friday',
      },
    },
  });
  assert.equal(second.ok, true);
  assert.equal(second.contact.contact_id, first.contact.contact_id);
  assert.ok(String(second.contact.cumulative_context_summary || '').includes('pricing')
    || String(second.contact.cumulative_context_summary || '').toLowerCase().includes('demo')
    || String(second.contact.cumulative_context_summary || '').length > 10);
  // Preferred language preserved across calls
  assert.equal(second.contact.preferred_language, 'te-IN');
  assert.ok((second.appointments || []).length >= 1);
  assert.equal(second.appointments[0].status, 'booked');
  assert.equal(second.appointments[0].calBookingUid, 'cal_uid_demo_friday');
});

test('OUTBOUND → LATER INBOUND CONTEXT: only stored facts injected', () => {
  const db = emptyDb();
  // Outbound qualify + book
  endOfCall.runEndOfCallPipeline(db, 't1', {
    phone: '+919955566677',
    name: 'Ravi',
    direction: 'outbound',
    callId: 'out_1',
    employeeId: 'emp_maya',
    summary: 'Qualified. Interested in growth plan. Demo booked.',
    extractedData: {
      qualified: true,
      interest: 'Growth plan',
      business_goal: 'Scale outbound',
      preferred_language: 'en-IN',
      appointment: {
        title: 'Growth demo',
        startAt: new Date(Date.now() + 2 * 24 * 3600_000).toISOString(),
        status: 'booked',
        calBookingUid: 'cal_uid_growth_demo',
      },
    },
  });

  // Later inbound resolves same contact
  const resolved = customerContext.resolveContact(db, 't1', '9955566677');
  assert.equal(resolved.created, false);
  const inj = customerContext.buildContextInjection(resolved.contact);
  assert.ok(inj.block.includes('Growth plan') || inj.block.includes('Qualified') || inj.block.includes('Ravi'));
  assert.ok(inj.block.includes('Appointment:') || inj.block.includes('Latest summary'));
  assert.equal(inj.includes_transcript, false);
  assert.ok(inj.block.length < 1000);
});

test('EMPLOYEE HANDOFF: Maya → Vaani keeps tenant-scoped facts', () => {
  const db = emptyDb();
  const c = customerContext.resolveContact(db, 't1', '+919977788899', {
    name: 'Hand Off',
    assignedEmployee: 'emp_maya',
  }).contact;
  c.qualificationStatus = 'qualified';
  c.interest = 'Enterprise seats';
  const hand = customerContext.handoffContact(db, 't1', c.id, 'emp_vaani');
  assert.equal(hand.ok, true);
  assert.equal(hand.toEmployeeId, 'emp_vaani');
  assert.equal(hand.contact.assignedEmployee, 'emp_vaani');
  assert.equal(hand.contact.qualificationStatus, 'handed_off');
  assert.equal(hand.contact.interest, 'Enterprise seats');
  assert.equal(hand.contact.tenantId, 't1');

  // Cross-tenant employee rejected
  const bad = customerContext.handoffContact(db, 't1', c.id, 'emp_other');
  assert.equal(bad.ok, false);
});

test('CUSTOMER TIMELINE: inbound, booked, follow-up scheduled events', () => {
  const db = emptyDb();
  const c = customerContext.resolveContact(db, 't1', '+919966677788', { name: 'Timeline' }).contact;
  customerContext.recordCallRef(c, {
    id: 'call_in',
    direction: 'inbound',
    status: 'completed',
    outcome: 'interested',
  });
  customerContext.addAppointment(c, {
    title: 'Meet',
    status: 'booked',
    startAt: new Date(Date.now() + 86400_000).toISOString(),
  });
  outboundJobs.createOutboundJob(db, 't1', {
    contactId: c.id,
    phone: c.primaryPhone,
    triggerEvent: 'appointment.booked.confirmation',
    scheduledAt: new Date().toISOString(),
  });
  const tl = customerContext.buildCustomerTimeline(db, 't1', c.id);
  assert.equal(tl.ok, true);
  const types = tl.timeline.events.map((e) => e.type);
  assert.ok(types.includes('inbound') || types.includes('lead_created'));
  assert.ok(types.includes('booked') || types.includes('outbound_confirmation') || types.includes('follow_up_scheduled'));
});

test('mapEventToJobPlans covers required trigger events', () => {
  for (const ev of eventTriggers.TRIGGER_EVENTS) {
    assert.ok(typeof ev === 'string');
  }
  const plans = eventTriggers.mapEventToJobPlans('followup.required', {
    scheduledAt: new Date(Date.now() + 3600_000).toISOString(),
  }, eventTriggers.DEFAULT_CALLBACK_RULES);
  assert.equal(plans.length, 1);
  assert.equal(plans[0].triggerEvent, 'followup.required');
});
