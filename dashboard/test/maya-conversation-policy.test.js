/**
 * Maya conversation policy + hangup classification (PSTN QA P0-2 / P0-4).
 * No PSTN. No Dograh WF8 writes.
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const maya = require('../lib/maya-conversation-policy');

test('Hindi booking phrase is booking intent and not end-call eligible', () => {
  const text = 'Okay, demo schedule kar sakte ho?';
  assert.equal(maya.detectBookingIntent(text), true);
  assert.equal(maya.detectExplicitHangupIntent(text), false);
  assert.equal(maya.isEndCallEligible(text), false);
});

test('goodbye is end-call eligible', () => {
  assert.equal(maya.isEndCallEligible('Thanks, goodbye'), true);
  assert.equal(maya.detectExplicitHangupIntent('Please hang up'), true);
});

test('classifyHangupCause flags booking_intent_misfire', () => {
  const cause = maya.classifyHangupCause({
    lastUserText: 'Okay, demo schedule kar sakte ho?',
    endedByAgent: true,
    endNode: 'endCall',
  });
  assert.equal(cause.code, 'booking_intent_misfire');
  assert.equal(cause.severity, 'p0');
  assert.equal(cause.booking_intent_on_last_turn, true);
  assert.equal(cause.end_call_eligible, false);
});

test('nextDialogueAction enters booking and stops selling', () => {
  const a = maya.nextDialogueAction('qualify', 'Okay, demo schedule kar sakte ho?');
  assert.equal(a.phase, 'booking');
  assert.equal(a.action, 'enter_booking');
  assert.equal(a.stage, 'ask_email');

  const b = maya.nextDialogueAction('booking', 'my email is vijay@company.com');
  assert.equal(b.phase, 'booking');
  assert.equal(b.action, 'continue_booking');
});

test('qualification policy asks 2 to 4 questions then summarize before demo push', () => {
  const instr = maya.mayaInstructionsPayload();
  assert.equal(instr.conversation_policy.qualify_min, 2);
  assert.equal(instr.conversation_policy.qualify_max, 4);
  assert.ok(instr.conversation_policy.qualification_questions.length >= 2);
  assert.equal(instr.conversation_policy.stop_selling_on_booking_intent, true);
  assert.match(instr.instructions, /2 to 4|2-4/i);
  assert.match(instr.instructions, /stop selling/i);
});

test('booking stages are email → availability → slot → confirmation → Cal.com', () => {
  assert.deepEqual(
    maya.BOOKING_STAGES.map((s) => s.id),
    ['ask_email', 'availability', 'offer_slot', 'confirmation', 'calcom'],
  );
});

test('workflow graph end-call edges forbid booking language', () => {
  const g = maya.buildMayaWorkflowGraph();
  const endEdges = g.edges.filter((e) => e.target === '4');
  assert.ok(endEdges.length >= 2);
  for (const edge of endEdges) {
    assert.match(edge.data.condition, /NEVER choose End Call for booking/i);
  }
  assert.equal(g.meta.dograh_workflow_id, '8');
  assert.equal(g.meta.protected, true);
  assert.equal(g.meta.employee_id, maya.MAYA_EMPLOYEE_ID);
});

test('isMayaEmployee matches protected id', () => {
  assert.equal(maya.isMayaEmployee({ id: maya.MAYA_EMPLOYEE_ID, name: 'X' }), true);
  assert.equal(maya.isMayaEmployee({ id: 'emp_other', name: 'Maya' }), true);
  assert.equal(maya.isMayaEmployee({ id: 'emp_other', name: 'Vaani' }), false);
});
