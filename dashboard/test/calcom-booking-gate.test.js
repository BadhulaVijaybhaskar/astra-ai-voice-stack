/**
 * Cal.com booking gate helpers: mailable email, nested errors, booking uid.
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const calcom = require('../lib/calcom');
const endOfCall = require('../lib/end-of-call-pipeline');
const customerContext = require('../lib/customer-context');
const eventTriggers = require('../lib/event-triggers');
const outboundJobs = require('../lib/outbound-jobs');

function emptyDb() {
  return {
    contacts: [],
    outboundJobs: [],
    employees: [
      {
        id: 'emp_maya',
        tenantId: 't1',
        name: 'Maya',
        callbackRules: {
          onBookingConfirmation: true,
          remindBeforeMinutes: [60],
          customOffsetsMinutes: [],
          timezone: 'Asia/Kolkata',
        },
      },
    ],
    leads: [],
  };
}

test('isMailableAttendeeEmail rejects reserved / non-mailable domains', () => {
  assert.equal(calcom.isMailableAttendeeEmail('demo@example.com'), false);
  assert.equal(calcom.isMailableAttendeeEmail('user@example.org'), false);
  assert.equal(calcom.isMailableAttendeeEmail('a@test'), false);
  assert.equal(calcom.isMailableAttendeeEmail('a@localhost'), false);
  assert.equal(calcom.isMailableAttendeeEmail('not-an-email'), false);
  assert.equal(calcom.isMailableAttendeeEmail('ok@gmail.com'), true);
  assert.equal(calcom.isMailableAttendeeEmail('founder@astra.ai'), true);
});

test('formatCalcomError surfaces nested email_domain_cannot_receive_mail', () => {
  const formatted = calcom.formatCalcomError({
    status: 'error',
    error: {
      code: 'BadRequestException',
      message: 'Bad Request',
      details: {
        message: 'email_domain_cannot_receive_mail',
        error: 'Bad Request',
        statusCode: 400,
      },
    },
  }, 400);
  assert.match(formatted.message, /email_domain_cannot_receive_mail/);
  assert.equal(formatted.code, 'email_domain_cannot_receive_mail');
  assert.ok(Array.isArray(formatted.detail.errors));
});

test('extractBookingUid requires real uid/id', () => {
  assert.equal(calcom.extractBookingUid({ data: { uid: 'abc123' } }), 'abc123');
  assert.equal(calcom.extractBookingUid({ data: { id: 99 } }), '99');
  assert.equal(calcom.extractBookingUid({ data: {} }), null);
  assert.equal(calcom.extractBookingUid(null), null);
});

test('END-OF-CALL: without bookingId does not fire appointment.booked confirmation', () => {
  const db = emptyDb();
  const result = endOfCall.runEndOfCallPipeline(db, 't1', {
    phone: '+919812345678',
    name: 'False Book',
    direction: 'inbound',
    callId: 'call_false_book',
    employeeId: 'emp_maya',
    summary: 'Agent said booked but Cal.com failed.',
    outcome: 'booked',
    extractedData: {
      appointment: {
        title: 'Demo',
        status: 'booked',
        startAt: new Date(Date.now() + 2 * 24 * 3600_000).toISOString(),
      },
    },
  });
  assert.equal(result.ok, true);
  assert.ok((result.appointments || []).length >= 1);
  assert.equal(result.appointments[0].status, 'requested');
  assert.equal(result.appointments[0].calBookingUid, null);
  const eventNames = (result.events || []).map((e) => e.event);
  assert.ok(!eventNames.includes('appointment.booked'));
  assert.ok(eventNames.includes('appointment.requested') || eventNames.includes('call.completed'));
  const confirmJobs = (db.outboundJobs || []).filter(
    (j) => String(j.triggerEvent || '').includes('appointment.booked.confirmation'),
  );
  assert.equal(confirmJobs.length, 0);
});

test('END-OF-CALL: with real bookingId fires appointment.booked + confirmation (autoDial false)', () => {
  const db = emptyDb();
  const startAt = new Date(Date.now() + 3 * 24 * 3600_000).toISOString();
  const result = endOfCall.runEndOfCallPipeline(db, 't1', {
    phone: '+919876543210',
    name: 'Real Book',
    direction: 'inbound',
    callId: 'call_real_book',
    employeeId: 'emp_maya',
    summary: 'Booked on Cal.com.',
    extractedData: {
      appointment: {
        title: 'Astra Voice Demo',
        status: 'booked',
        startAt,
        calBookingUid: 'cal_uid_live_1',
      },
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.appointments[0].status, 'booked');
  assert.equal(result.appointments[0].calBookingUid, 'cal_uid_live_1');
  const eventNames = (result.events || []).map((e) => e.event);
  assert.ok(eventNames.includes('appointment.booked'));
  const confirmJobs = (db.outboundJobs || []).filter(
    (j) => String(j.triggerEvent || '') === 'appointment.booked.confirmation',
  );
  assert.ok(confirmJobs.length >= 1);
  assert.equal(confirmJobs[0].autoDial, false);
});

test('extractStructured bookingCompleted requires real booking id', () => {
  const soft = endOfCall.extractStructured({
    outcome: 'booked',
    extractedData: { appointment: { status: 'booked', startAt: '2026-10-02T10:00:00.000Z' } },
  });
  assert.equal(soft.bookingCompleted, false);
  assert.equal(soft.softBookSignal, true);
  assert.equal(soft.realBookingId, null);

  const hard = endOfCall.extractStructured({
    outcome: 'booked',
    calBookingUid: 'uid_9',
    extractedData: { appointment: { status: 'booked', startAt: '2026-10-02T10:00:00.000Z' } },
  });
  assert.equal(hard.bookingCompleted, true);
  assert.equal(hard.realBookingId, 'uid_9');
});

test('appointment.booked event still creates confirmation without dial', () => {
  const db = emptyDb();
  const contact = customerContext.resolveContact(db, 't1', '+919900011122', {
    name: 'Gate',
    assignedEmployee: 'emp_maya',
  }).contact;
  const appt = customerContext.addAppointment(contact, {
    title: 'Meet',
    status: 'booked',
    startAt: new Date(Date.now() + 86400_000).toISOString(),
    calBookingUid: 'uid_gate',
  }).appointment;
  const evt = eventTriggers.handleEvent(db, 't1', 'appointment.booked', {
    contactId: contact.id,
    employeeId: 'emp_maya',
    appointment: appt,
    appointmentId: appt.id,
    appointmentStartAt: appt.startAt,
  });
  assert.equal(evt.ok, true);
  assert.equal(evt.dialed, false);
  assert.ok((evt.jobs || []).some((j) => j.job && j.job.autoDial === false));
  assert.ok((evt.jobs || []).some((j) => j.job.triggerEvent === 'appointment.booked.confirmation'));
  const pub = outboundJobs.publicOutboundJob(evt.jobs[0].job);
  assert.equal(pub.trigger_event, 'appointment.booked.confirmation');
  assert.equal(evt.jobs[0].job.autoDial, false);
});
