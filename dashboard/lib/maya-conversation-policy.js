/**
 * Astra Voice. Maya conversation policy (PSTN QA P0-2 / P0-4).
 *
 * Policy goals:
 *   1. Understand need first.
 *   2. Ask 2 to 4 qualification questions.
 *   3. Summarize what you heard.
 *   4. Only then suggest booking a demo.
 *   5. Once the caller wants a demo / booking, STOP selling and enter booking.
 *
 * Booking flow (never hang up mid-flow):
 *   ask email → availability → offer slot → confirmation → Cal.com
 *
 * End-call edges must NEVER fire on booking / schedule / demo intent
 * (including Hinglish: "Okay, demo schedule kar sakte ho?").
 *
 * Maya production Dograh WF8 is protected. This module is the canonical
 * Astra-side policy + workflow graph payload for Hostinger sync. It does
 * not auto-write WF8.
 *
 * No em dashes anywhere. Commas and periods only.
 */
'use strict';

const asrGuard = require('./asr-sanity-guard');

const MAYA_EMPLOYEE_ID = 'emp_33eae8ef454680f0';
const MAYA_DID = '+918065353938';
const MAYA_DOGRAH_WORKFLOW_ID = '8';
const MAYA_TTS = Object.freeze({
  provider: 'sarvam',
  model: 'bulbul:v3',
  voice_id: 'priya',
});

const BOOKING_STAGES = Object.freeze([
  Object.freeze({
    id: 'ask_email',
    label: 'Ask email',
    prompt: 'Ask for a working email they can receive calendar invites on. Do not invent an email. Do not end the call.',
  }),
  Object.freeze({
    id: 'availability',
    label: 'Availability',
    prompt: 'Ask when they are free in the next few days. Capture timezone as Asia/Kolkata unless they say otherwise. Do not end the call.',
  }),
  Object.freeze({
    id: 'offer_slot',
    label: 'Offer slot',
    prompt: 'Offer one concrete slot based on availability tools or a clear next step. Never invent a booked appointment. Do not end the call.',
  }),
  Object.freeze({
    id: 'confirmation',
    label: 'Confirmation',
    prompt: 'Read back email, time, and timezone. Ask them to confirm. Do not end the call until they confirm or clearly decline.',
  }),
  Object.freeze({
    id: 'calcom',
    label: 'Cal.com',
    prompt: 'Only after confirmation, create the Cal.com booking with a real mailbox. Never claim booked without a booking id. Then thank them briefly.',
  }),
]);

const QUALIFICATION_QUESTIONS = Object.freeze([
  'What are you hoping Astra Voice helps with for your team?',
  'About how many outbound or inbound calls do you handle in a week?',
  'Who else needs to be involved in choosing a voice agent?',
  'Is there a timeline you are working toward?',
]);

const GLOBAL_PROMPT = `# WHO YOU ARE

You are Maya, the AI voice employee for Astra Voice on a live phone call.
You speak naturally in the caller's language when they use Hindi, Hinglish,
Telugu, or TE-EN mix.

# RESPONSE LENGTH (ADAPTIVE — NOT A SHORTNESS QUOTA)

Match answer length to the question. Latency is about starting speech quickly,
not cutting useful answers short.
- Simple confirm / yes-no → concise
- How / why / product explanation → detailed and complete
- Qualification → consultative, one clear question at a time after a brief ack
- Booking → concise and action-oriented, then collect details
Once you start answering, continue until the answer is complete. Never rush the
caller. Never truncate a useful explanation to hit a latency number.

# FIRST AUDIO / STREAMING

Lead with a safe natural opening phrase so speech can start immediately, then
continue the rest of the answer. Example: "Yes. Astra Voice can qualify inbound
leads..." then finish the explanation. Do not wait for tools before speaking.

# CONVERSATION POLICY (MANDATORY)

1. Understand the need first. Do not pitch a demo on the first turn unless they
   already asked to book.
2. Ask 2 to 4 short qualification questions, one at a time. Use these themes:
   need, volume, decision maker, timeline.
3. Summarize what you heard in one sentence.
4. Only then suggest booking a short demo.
5. Once they want a demo or say they can schedule, STOP selling. Enter booking
   immediately. Do not keep pushing product benefits.

# BOOKING FLOW (NEVER SKIP, NEVER HANG UP)

When booking intent is clear (including "Okay, demo schedule kar sakte ho?"):
  Speak a short acknowledgement IMMEDIATELY (for example "Haan, bilkul. Demo
  book karte hain."), THEN ask email → availability → offer slot → confirmation
  → Cal.com. Tools may continue in the background. Never stay silent while
  tools run.

Never invent calendar availability. Never claim an appointment is booked
without a real Cal.com booking id. Never hang up because booking started.

# END CALL RULES (CRITICAL)

Only end the call when the caller clearly says goodbye, hang up, not interested
with no follow-up, or asks you to stop calling.

NEVER end the call when they ask to book, schedule, demo, share email, check
availability, or confirm a slot. Booking language is NOT goodbye.

# ASR / UNCLEAR AUDIO

If the transcript is nonsense or clearly wrong, ask one short clarification.
Do not invent a business answer from garbage text. Do not end the call.
`;

/**
 * Hot-path global prompt for first audio / TTFT.
 * Defers the long qualification bank and verbose booking step list to stage
 * nodes so Groq is not stuffed before the first spoken syllable.
 * Preserves identity, streaming lead-in, end-call safety, booking ack rule.
 */
const GLOBAL_PROMPT_HOT = `# WHO YOU ARE

You are Maya, the AI voice employee for Astra Voice on a live phone call.
Speak naturally in the caller's language (Hindi, Hinglish, Telugu, TE-EN, English).

# FIRST AUDIO / STREAMING

Lead with a safe natural opening phrase, then continue. Do not wait for tools.
Match answer length to the question. Once you start, finish a complete answer.

# CONVERSATION POLICY (MANDATORY)

Understand the need first. Do not pitch a demo on turn one unless they asked.
Ask qualification questions one at a time only after you start speaking.
Once they want a demo or schedule, STOP selling and enter booking with a short
spoken ack first. Never invent a Cal.com booking. Never hang up on booking talk.

# END CALL / ASR

End only on clear goodbye or stop. Booking language is NOT goodbye.
If ASR is nonsense, ask one short clarification. Do not invent answers.
`;

const START_PROMPT = `# THIS STAGE

Greet briefly as Maya from Astra Voice and ask how you can help.
Do not pitch a demo yet. Do not ask for email yet unless they already want to book.
Do not run a separate language or intent classifier before this greeting speech.
`;

const MAIN_PROMPT = `# THIS STAGE

Follow the conversation policy. Qualify with 2 to 4 questions (need, volume,
decision maker, timeline), summarize in one sentence, then offer a demo.
Ask one question at a time after a brief spoken ack. If they already want to
book, move to booking without more selling.

# DEFERRED FROM HOT PATH

Full qualification themes live here (not in a pre-speech classifier LLM):
- need: What are you hoping Astra Voice helps with for your team?
- volume: About how many outbound or inbound calls do you handle in a week?
- decision maker: Who else needs to be involved in choosing a voice agent?
- timeline: Is there a timeline you are working toward?
Do not preload all four into the first spoken turn.
`;

const BOOKING_PROMPT = `# THIS STAGE

You are in booking. Stop selling. First speak a short acknowledgement, then run:
ask email → availability → offer slot → confirmation → Cal.com. Tools stay in
the background after the ack. Stay here until booking is confirmed, declined, or
they clearly want to stop. Never jump to End Call from this stage on booking
language. Never stay silent waiting on Cal.com.
`;

/** Hostinger / Dograh: hops that must NOT run before first audible speech. */
const PRE_SPEECH_POLICY = Object.freeze({
  defer_edge_router_llm_before_first_audio: true,
  defer_end_call_eligibility_llm: true,
  defer_language_classifier_llm: true,
  defer_qualification_bank: true,
  defer_summarizer_llm: true,
  defer_calcom_tools: true,
  use_local_booking_and_hangup_policy: true,
  required_before_first_audio: ['global_hot', 'active_stage_compact'],
  note: 'Dograh natural-language edge routers and extra Groq hops (lang/qual/summarizer) inflate speech_end→first_audio. Prefer local ASR/booking/hangup policy for routing until after first spoken.',
});

const END_PROMPT = `# THIS STAGE

Close warmly in six to ten words and stop talking.
Example: "Thanks for calling Astra Voice, take care."
`;

const END_CALL_CONDITION = 'Choose End Call ONLY when the caller clearly wants to hang up, says goodbye, says they are done with no booking interest, or asks you to stop. NEVER choose End Call for booking, demo, schedule, email, availability, slot, confirmation, Cal.com, or Hinglish booking phrases like "demo schedule kar sakte ho".';

const TO_BOOKING_CONDITION = 'Choose Booking as soon as the caller wants a demo, wants to schedule, asks to book, or says they can do a demo (English or Hinglish). Also choose Booking after you have summarized and they accept a demo offer.';

/**
 * Detect whether a user utterance should enter booking (not end call).
 */
function detectBookingIntent(text) {
  return asrGuard.isBookingOrScheduleIntent(text);
}

/**
 * Explicit goodbye / hangup intent. Booking phrases return false.
 */
function detectExplicitHangupIntent(text) {
  const s = String(text || '').trim();
  if (!s) return false;
  if (detectBookingIntent(s)) return false;
  if (/\b(good\s*bye|goodbye|bye\s*bye|hang\s*up|end\s*the\s*call|stop\s*calling|not\s*interested)\b/i.test(s)) {
    return true;
  }
  if (/\b(bas\s*karo|mat\s*call|band\s*karo|alvida)\b/i.test(s)) return true;
  return false;
}

/**
 * Whether workflow routing may select the End Call node.
 */
function isEndCallEligible(text, opts = {}) {
  if (opts.forceHangup) return true;
  if (detectBookingIntent(text)) return false;
  if (opts.inBookingFlow && !detectExplicitHangupIntent(text)) return false;
  return detectExplicitHangupIntent(text);
}

/**
 * Classify hangup / call-end cause for evidence tracing.
 */
function classifyHangupCause(input = {}) {
  const lastUser = String(input.lastUserText || input.transcript || '').trim();
  const providerCause = input.providerHangupCause
    ? String(input.providerHangupCause)
    : null;
  const node = String(input.endNode || input.workflowNode || '').toLowerCase();
  const bookingIntent = detectBookingIntent(lastUser);
  const explicitHangup = detectExplicitHangupIntent(lastUser);

  let code = 'unknown';
  let severity = 'info';
  let detail = '';

  if (bookingIntent && (node.includes('end') || input.endedByAgent)) {
    code = 'booking_intent_misfire';
    severity = 'p0';
    detail = 'Call ended while last user turn expressed booking/demo intent. End Call edge must not fire.';
  } else if (explicitHangup) {
    code = 'caller_explicit_hangup';
    severity = 'info';
    detail = 'Caller clearly asked to end.';
  } else if (providerCause) {
    code = 'provider_hangup';
    severity = 'info';
    detail = 'Telephony provider hangup cause: ' + providerCause;
  } else if (input.endedByAgent) {
    code = 'agent_end_call_node';
    severity = 'warn';
    detail = 'Agent/workflow reached End Call without explicit caller goodbye.';
  } else if (input.endedByCaller) {
    code = 'caller_disconnected';
    severity = 'info';
    detail = 'Remote party disconnected.';
  }

  return {
    code,
    severity,
    detail,
    booking_intent_on_last_turn: bookingIntent,
    explicit_hangup_on_last_turn: explicitHangup,
    provider_hangup_cause: providerCause,
    end_node: node || null,
    last_user_text: lastUser.slice(0, 300),
    end_call_eligible: isEndCallEligible(lastUser, {
      inBookingFlow: !!input.inBookingFlow,
    }),
  };
}

/**
 * Build Dograh-compatible workflow graph JSON for Maya (Astra-owned copy).
 * Hostinger ops can import / diff against WF8. This never auto-publishes WF8.
 */
function buildMayaWorkflowGraph() {
  return {
    nodes: [
      {
        id: '0',
        type: 'globalNode',
        data: {
          name: 'Global Node',
          // Hot prompt on WF8 import: defer qualification bank to Qualify stage.
          prompt: GLOBAL_PROMPT_HOT,
          allow_interrupt: true,
        },
      },
      {
        id: '1',
        type: 'startCall',
        data: {
          name: 'start call',
          prompt: START_PROMPT,
          allow_interrupt: true,
          add_global_prompt: true,
          delayed_start: false,
          is_start: true,
          wait_for_user_response: false,
        },
      },
      {
        id: '2',
        type: 'agentNode',
        data: {
          name: 'Qualify',
          prompt: MAIN_PROMPT,
          allow_interrupt: true,
          add_global_prompt: true,
        },
      },
      {
        id: '3',
        type: 'agentNode',
        data: {
          name: 'Booking',
          prompt: BOOKING_PROMPT + '\n\n# BOOKING STEPS\n'
            + BOOKING_STAGES.map((s, i) => (i + 1) + '. ' + s.label + ': ' + s.prompt).join('\n'),
          allow_interrupt: true,
          add_global_prompt: true,
        },
      },
      {
        id: '4',
        type: 'endCall',
        data: {
          name: 'End Call',
          prompt: END_PROMPT,
          allow_interrupt: false,
          add_global_prompt: false,
          is_end: true,
        },
      },
    ],
    edges: [
      {
        id: '1-2',
        source: '1',
        target: '2',
        type: 'custom',
        animated: true,
        data: {
          label: 'Start qualifying',
          condition: 'Choose this after the greeting reply unless the caller already asked to book a demo.',
          // Prefer local policy over an extra Groq router hop before speech.
          prefer_local_policy: true,
        },
      },
      {
        id: '1-3',
        source: '1',
        target: '3',
        type: 'custom',
        animated: true,
        data: {
          label: 'Direct to booking',
          condition: TO_BOOKING_CONDITION,
          prefer_local_policy: true,
        },
      },
      {
        id: '2-3',
        source: '2',
        target: '3',
        type: 'custom',
        animated: true,
        data: {
          label: 'Enter booking',
          condition: TO_BOOKING_CONDITION,
          prefer_local_policy: true,
        },
      },
      {
        id: '1-4',
        source: '1',
        target: '4',
        type: 'custom',
        animated: true,
        data: {
          label: 'End call',
          condition: END_CALL_CONDITION,
          prefer_local_policy: true,
        },
      },
      {
        id: '2-4',
        source: '2',
        target: '4',
        type: 'custom',
        animated: true,
        data: {
          label: 'End call',
          condition: END_CALL_CONDITION,
          prefer_local_policy: true,
        },
      },
      {
        id: '3-4',
        source: '3',
        target: '4',
        type: 'custom',
        animated: true,
        data: {
          label: 'End after booking',
          condition: END_CALL_CONDITION
            + ' From Booking, also allow End Call after Cal.com success was confirmed aloud, or after the caller clearly declines booking.',
          prefer_local_policy: true,
        },
      },
    ],
    meta: {
      employee_id: MAYA_EMPLOYEE_ID,
      did: MAYA_DID,
      dograh_workflow_id: MAYA_DOGRAH_WORKFLOW_ID,
      tts: MAYA_TTS,
      protected: true,
      pre_speech_policy: PRE_SPEECH_POLICY,
      note: 'Astra-owned Maya policy graph. Diff / import to Dograh WF8 on Hostinger manually. Activate never auto-writes WF8. Global uses HOT prompt; Qualify holds deferred qual bank.',
    },
  };
}

/**
 * Customer Instructions payload for Maya Teach tab.
 */
function mayaInstructionsPayload() {
  return {
    brief: 'Maya qualifies inbound interest with 2 to 4 questions, summarizes, then books demos without hanging up mid-booking.',
    greeting: 'Hi, this is Maya from Astra Voice. How can I help you today?',
    instructions: [
      'Follow conversation policy: understand need, 2-4 qualification questions, summarize, then suggest booking.',
      'Once they want a demo, stop selling and run booking: email → availability → offer slot → confirmation → Cal.com.',
      'Never end the call on booking or schedule language, including Hinglish demo requests.',
      'Never invent a booked appointment without a Cal.com booking id.',
      'If ASR is garbage, ask one short clarification instead of answering nonsense.',
    ].join(' '),
    style: 'Warm, concise, never pushy after booking intent. Confirm understanding before booking.',
    conversation_policy: {
      qualify_min: 2,
      qualify_max: 4,
      qualification_questions: QUALIFICATION_QUESTIONS.slice(),
      booking_stages: BOOKING_STAGES.map((s) => s.id),
      stop_selling_on_booking_intent: true,
      end_call_blocks_booking_intent: true,
    },
  };
}

/**
 * Apply Maya policy onto an employee instructions update (Astra-side only).
 */
function applyMayaPolicyToInstructions(existing) {
  const base = existing && typeof existing === 'object' ? existing : {};
  const policy = mayaInstructionsPayload();
  return {
    brief: base.brief || policy.brief,
    greeting: base.greeting || policy.greeting,
    instructions: policy.instructions,
    style: policy.style,
    conversationStyle: policy.style,
    conversation_policy: policy.conversation_policy,
  };
}

function isMayaEmployee(employee) {
  if (!employee) return false;
  if (String(employee.id || '') === MAYA_EMPLOYEE_ID) return true;
  return /^maya$/i.test(String(employee.name || '').trim());
}

/**
 * Next dialogue action given current phase + latest user text.
 * Used by tests and Browser Talk policy checks (not a new product surface).
 */
function nextDialogueAction(phase, userText) {
  const text = String(userText || '').trim();
  const current = String(phase || 'qualify').toLowerCase();

  if (detectExplicitHangupIntent(text)) {
    return { phase: 'end', action: 'end_call', reason: 'explicit_hangup' };
  }
  if (detectBookingIntent(text) || current === 'booking') {
    if (current !== 'booking') {
      return {
        phase: 'booking',
        action: 'enter_booking',
        stage: 'ack_then_ask_email',
        reason: 'booking_intent',
        speak_ack_first: true,
      };
    }
    return { phase: 'booking', action: 'continue_booking', reason: 'in_booking_flow' };
  }
  if (current === 'qualify' || current === 'start') {
    return { phase: 'qualify', action: 'ask_qualification', reason: 'need_discovery' };
  }
  if (current === 'summarize') {
    return { phase: 'offer_demo', action: 'suggest_booking', reason: 'after_summary' };
  }
  return { phase: current || 'qualify', action: 'continue', reason: 'default' };
}

/**
 * Immediate spoken acknowledgement for booking intent (tool path).
 * Speech starts before Cal.com / availability tools.
 */
function bookingAckSpeech(userText) {
  const s = String(userText || '');
  if (/[\u0C00-\u0C7F]/.test(s)) {
    return { language: 'te', text: 'సరే. డెమో బుక్ చేసుకుందాం.' };
  }
  if (/[\u0900-\u097F]/.test(s) || /kar\s*sakte|bilkul|haan|demo\s*schedule|book\s*kar/i.test(s)) {
    return { language: 'hi', text: 'Haan, bilkul. Demo book karte hain.' };
  }
  return { language: 'en', text: 'Yes. Let us book a short demo.' };
}

module.exports = {
  MAYA_EMPLOYEE_ID,
  MAYA_DID,
  MAYA_DOGRAH_WORKFLOW_ID,
  MAYA_TTS,
  BOOKING_STAGES,
  QUALIFICATION_QUESTIONS,
  GLOBAL_PROMPT,
  GLOBAL_PROMPT_HOT,
  PRE_SPEECH_POLICY,
  END_CALL_CONDITION,
  TO_BOOKING_CONDITION,
  detectBookingIntent,
  detectExplicitHangupIntent,
  isEndCallEligible,
  classifyHangupCause,
  buildMayaWorkflowGraph,
  mayaInstructionsPayload,
  applyMayaPolicyToInstructions,
  isMayaEmployee,
  nextDialogueAction,
  bookingAckSpeech,
};
