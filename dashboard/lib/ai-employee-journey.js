/**
 * Astra Voice. Guided AI Employee Setup / Demo Journey (additive).
 *
 * Feature flag: ENABLE_AI_EMPLOYEE_JOURNEY=1
 * LIVE mode reads existing Employee / Knowledge / Voice / Phone / Cal.com /
 * Call / Outcome / Actions entities. DEMO PREVIEW mode returns labeled
 * illustrative payloads only and never writes into live call records.
 *
 * No em dashes anywhere. Commas and periods only.
 */
'use strict';

const employees = require('./employees');
const phoneNumbers = require('./phone-numbers');
const calls = require('./calls');

const JOURNEY_STEPS = Object.freeze([
  Object.freeze({ id: 'employee', label: 'Employee', index: 1 }),
  Object.freeze({ id: 'knowledge', label: 'Knowledge', index: 2 }),
  Object.freeze({ id: 'language', label: 'Language', index: 3 }),
  Object.freeze({ id: 'routing', label: 'Routing', index: 4 }),
  Object.freeze({ id: 'call', label: 'Call', index: 5 }),
  Object.freeze({ id: 'outcome', label: 'Outcome', index: 6 }),
  Object.freeze({ id: 'next', label: 'Next', index: 7 }),
]);

const STEP_IDS = new Set(JOURNEY_STEPS.map((s) => s.id));
const MODES = new Set(['live', 'demo']);

const LANGUAGE_CATALOG = Object.freeze([
  Object.freeze({ id: 'EN', code: 'en-IN', label: 'English', status: 'Available' }),
  Object.freeze({ id: 'HI', code: 'hi-IN', label: 'Hindi', status: 'Available' }),
  Object.freeze({ id: 'TE', code: 'te-IN', label: 'Telugu', status: 'Ready for paid validation' }),
  Object.freeze({ id: 'TA', code: 'ta-IN', label: 'Tamil', status: 'Ready for paid validation' }),
  Object.freeze({ id: 'KN', code: 'kn-IN', label: 'Kannada', status: 'Tested' }),
  Object.freeze({ id: 'ML', code: 'ml-IN', label: 'Malayalam', status: 'Tested' }),
  Object.freeze({ id: 'MR', code: 'mr-IN', label: 'Marathi', status: 'Unavailable' }),
  Object.freeze({ id: 'BN', code: 'bn-IN', label: 'Bengali', status: 'Unavailable' }),
  Object.freeze({ id: 'GU', code: 'gu-IN', label: 'Gujarati', status: 'Unavailable' }),
  Object.freeze({ id: 'PA', code: 'pa-IN', label: 'Punjabi', status: 'Unavailable' }),
]);

function featureEnabled(env = process.env) {
  const raw = String(env.ENABLE_AI_EMPLOYEE_JOURNEY || '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

function nowIso() {
  return new Date().toISOString();
}

function defaultDraft() {
  return {
    step: 'employee',
    mode: 'live',
    employeeId: null,
    languageDraft: null,
    voiceDraft: null,
    qualificationRules: null,
    routingRules: null,
    workingHours: null,
    updatedAt: null,
  };
}

function normalizeStep(raw) {
  const id = String(raw || '').trim().toLowerCase();
  return STEP_IDS.has(id) ? id : 'employee';
}

function normalizeMode(raw) {
  const id = String(raw || '').trim().toLowerCase();
  return MODES.has(id) ? id : 'live';
}

function getTenantDraft(tenant) {
  const base = defaultDraft();
  const src = tenant && tenant.aiEmployeeJourney && typeof tenant.aiEmployeeJourney === 'object'
    ? tenant.aiEmployeeJourney
    : {};
  return {
    step: normalizeStep(src.step || base.step),
    mode: normalizeMode(src.mode || base.mode),
    employeeId: src.employeeId ? String(src.employeeId) : null,
    languageDraft: src.languageDraft || null,
    voiceDraft: src.voiceDraft && typeof src.voiceDraft === 'object' ? { ...src.voiceDraft } : null,
    qualificationRules: Array.isArray(src.qualificationRules) ? src.qualificationRules.slice(0, 12) : null,
    routingRules: Array.isArray(src.routingRules) ? src.routingRules.slice(0, 12) : null,
    workingHours: src.workingHours && typeof src.workingHours === 'object' ? { ...src.workingHours } : null,
    updatedAt: src.updatedAt || null,
  };
}

function setTenantDraft(tenant, body) {
  const b = body && typeof body === 'object' ? body : {};
  const cur = getTenantDraft(tenant);
  const next = {
    step: b.step !== undefined ? normalizeStep(b.step) : cur.step,
    mode: b.mode !== undefined ? normalizeMode(b.mode) : cur.mode,
    employeeId: b.employeeId !== undefined
      ? (b.employeeId ? String(b.employeeId) : null)
      : cur.employeeId,
    languageDraft: b.languageDraft !== undefined ? b.languageDraft : cur.languageDraft,
    voiceDraft: b.voiceDraft !== undefined
      ? (b.voiceDraft && typeof b.voiceDraft === 'object' ? { ...b.voiceDraft, apply_live: false } : null)
      : cur.voiceDraft,
    qualificationRules: b.qualificationRules !== undefined
      ? (Array.isArray(b.qualificationRules) ? b.qualificationRules.slice(0, 12) : null)
      : cur.qualificationRules,
    routingRules: b.routingRules !== undefined
      ? (Array.isArray(b.routingRules) ? b.routingRules.slice(0, 12) : null)
      : cur.routingRules,
    workingHours: b.workingHours !== undefined
      ? (b.workingHours && typeof b.workingHours === 'object' ? { ...b.workingHours } : null)
      : cur.workingHours,
    updatedAt: nowIso(),
  };
  tenant.aiEmployeeJourney = next;
  return next;
}

/**
 * Prefer explicit env id, then draft employeeId, then name match Maya / Lead Qual.
 */
function resolveEmployee(db, tenantId, draft) {
  const envId = String(process.env.AI_EMPLOYEE_JOURNEY_EMPLOYEE_ID || '').trim();
  if (envId) {
    const byEnv = employees.findEmployee(db, tenantId, envId);
    if (byEnv) return byEnv;
  }
  if (draft && draft.employeeId) {
    const byDraft = employees.findEmployee(db, tenantId, draft.employeeId);
    if (byDraft) return byDraft;
  }
  const rows = (db.employees || []).filter((e) => e.tenantId === tenantId
    && String(e.status || '').toUpperCase() !== 'ARCHIVED');
  const maya = rows.find((e) => /^maya$/i.test(String(e.name || '').trim()));
  if (maya) return maya;
  const lead = rows.find((e) => /lead\s*qual/i.test(String(e.role || ''))
    || e.templateKey === 'lead_qualification');
  if (lead) return lead;
  return rows[0] || null;
}

function readinessBits(db, employee) {
  let instructionsReady = false;
  if (employee && employee.agentId) {
    const agent = (db.agents || []).find((a) => a.id === employee.agentId && a.tenantId === employee.tenantId);
    instructionsReady = !!(agent && (agent.persona || agent.greeting));
  }
  const knowledgeAdded = Array.isArray(employee && employee.knowledgeIds) && employee.knowledgeIds.length > 0;
  const outcomeFieldsSet = Array.isArray(employee && employee.outcomes) && employee.outcomes.length > 0;
  return { instructionsReady, knowledgeAdded, outcomeFieldsSet };
}

function teamLabel(employee) {
  const channel = String((employee && employee.channel) || '').toLowerCase();
  if (channel === 'instant_lead' || channel === 'outbound' || channel === 'campaign') return 'Sales team';
  if (channel === 'inbound') return 'Front desk';
  return 'Workspace team';
}

function buildEmployeeStep(db, employee, mode) {
  if (mode === 'demo') {
    return {
      demoPreview: true,
      label: 'DEMO PREVIEW',
      name: 'Maya',
      role: 'Lead qualification',
      team: 'Sales team',
      status: 'Ready',
      job: 'Qualify new enquiries and identify the next step.',
      readiness: {
        instructionsReady: true,
        knowledgeAdded: true,
        outcomeFieldsSet: true,
      },
    };
  }
  if (!employee) {
    return {
      demoPreview: false,
      empty: true,
      message: 'No AI Employee found yet. Create one under My Employees, then reopen this journey.',
    };
  }
  const pub = employees.publicEmployee(employee, db);
  const ready = readinessBits(db, employee);
  const statusMap = {
    DRAFT: 'Draft',
    READY: 'Ready',
    LIVE: 'Live',
    PAUSED: 'Paused',
    ARCHIVED: 'Archived',
  };
  return {
    demoPreview: false,
    id: pub.id,
    name: pub.name,
    role: pub.role || pub.templateKey || 'Employee',
    team: teamLabel(employee),
    status: statusMap[pub.status] || pub.status,
    statusRaw: pub.status,
    job: pub.description || 'No job description set yet.',
    channel: pub.channel,
    language: pub.language,
    readiness: ready,
    agentId: pub.agentId,
    workflowId: pub.workflowId,
    phoneNumberId: pub.phoneNumberId,
    assignedNumber: pub.assignedNumber,
  };
}

function buildKnowledgeStep(db, tenantId, employee, mode, draft) {
  if (mode === 'demo') {
    return {
      demoPreview: true,
      label: 'DEMO PREVIEW',
      systemPrompt: 'You are Maya, a friendly sales assistant for Astra Voice. Understand the caller\'s team size, current tools and timeline. Be concise, never pushy, and always offer a demo when the lead qualifies.',
      knowledge: [
        { id: 'demo_kb_1', title: 'Sample pricing notes', meta: 'Demo preview', kind: 'text', demoPreview: true },
        { id: 'demo_kb_2', title: 'Sample product FAQ', meta: 'Demo preview', kind: 'text', demoPreview: true },
        { id: 'demo_kb_3', title: 'Sample website notes', meta: 'Demo preview', kind: 'text', demoPreview: true },
      ],
      qualificationRules: [
        { id: 'team_size', label: 'Team size is 5 or more', enabled: true, demoPreview: true },
        { id: 'budget', label: 'Budget confirmed this quarter', enabled: true, demoPreview: true },
        { id: 'decision_maker', label: 'Decision maker on the call', enabled: false, demoPreview: true },
      ],
    };
  }

  let systemPrompt = '';
  let greeting = '';
  if (employee) {
    const instr = employees.getInstructions(db, tenantId, employee.id);
    if (instr && instr.ok !== false) {
      systemPrompt = (instr.instructions && instr.instructions.instructions) || '';
      greeting = (instr.instructions && instr.instructions.greeting) || '';
      if (!systemPrompt && typeof instr.instructions === 'string') systemPrompt = instr.instructions;
    }
  }

  const training = employee
    ? employees.listTraining(db, tenantId, employee.id)
    : { ok: true, training: { entries: [] } };
  const knowledgeList = (training && training.ok !== false && training.training)
    ? (training.training.entries || [])
    : [];
  const knowledgeRows = knowledgeList.map((entry) => {
    const kind = entry.sourceUrl ? 'url' : (entry.content ? 'text' : 'file');
    const meta = entry.sourceUrl
      ? entry.sourceUrl.replace(/^https?:\/\//i, '').slice(0, 48)
      : (entry.content ? (String(entry.content).length + ' chars') : (entry.status || 'attached'));
    return {
      id: entry.id,
      title: entry.title || 'Knowledge',
      meta,
      kind,
      status: entry.status || null,
      demoPreview: false,
    };
  });

  let qualificationRules = Array.isArray(draft.qualificationRules) ? draft.qualificationRules : null;
  if (!qualificationRules) {
    const outcomes = employees.normalizeOutcomesList
      ? employees.normalizeOutcomesList(employee && employee.outcomes)
      : (employee && Array.isArray(employee.outcomes) ? employee.outcomes : []);
    qualificationRules = (outcomes || []).slice(0, 8).map((o) => ({
      id: o.key,
      label: o.label || o.key,
      enabled: o.success !== false,
      demoPreview: false,
      source: 'outcome',
    }));
  }

  return {
    demoPreview: false,
    systemPrompt,
    greeting,
    knowledge: knowledgeRows,
    qualificationRules,
    canAddKnowledge: true,
  };
}

function buildLanguageStep(employee, mode, draft, voiceCatalogSummary) {
  if (mode === 'demo') {
    return {
      demoPreview: true,
      label: 'DEMO PREVIEW',
      voice: {
        title: 'Warm · Natural · Indian English',
        subtitle: 'Illustrative voice profile for Maya (Demo preview only).',
        options: [
          { id: 'maya', name: 'Maya', description: 'Lead qualification', selected: true, demoPreview: true },
          { id: 'dev', name: 'Dev', description: 'Customer support', selected: false, demoPreview: true },
          { id: 'sara', name: 'Sara', description: 'Appointments', selected: false, demoPreview: true },
        ],
        previewText: 'Hi, this is Maya from Astra Voice. Is now a good time?',
      },
      languages: LANGUAGE_CATALOG.map((l) => ({
        ...l,
        selected: l.id === 'TE',
        demoPreview: true,
        statusNote: l.status === 'Available' ? null : l.status,
      })),
      note: 'Telugu selected for this Demo preview · outcome fields stay in English.',
      // Provider brands stay out of the primary investor surface.
      providers: [],
      advancedProviders: ['Dograh Managed', 'Deepgram Aura', 'Sarvam', 'Rumik'],
      productionSafe: true,
    };
  }

  const voice = employee && employee.voice ? employee.voice : {};
  const selectedLang = draft.languageDraft
    || (voice.language || employees.DEFAULT_LANGUAGE || 'en-IN');
  const languages = LANGUAGE_CATALOG.map((l) => {
    const supported = ['en-IN', 'hi-IN', 'te-IN', 'ta-IN'].includes(l.code);
    let status = l.status;
    if (supported && (l.id === 'EN' || l.id === 'HI')) status = 'Available';
    else if (supported) status = 'Ready for paid validation';
    return {
      ...l,
      status,
      selected: l.code === selectedLang || l.id === selectedLang,
      demoPreview: false,
      live: status === 'Available',
    };
  });

  return {
    demoPreview: false,
    voice: {
      title: voice.speaker || voice.model || 'Standard voice',
      subtitle: 'Draft preview only. Saving does not flip Maya production voice.',
      draft: draft.voiceDraft || null,
      current: {
        language: voice.language || null,
        speaker: voice.speaker || null,
        model: voice.model || null,
        tier: voice.tier || 'standard',
      },
      previewText: 'Hi, this is Maya from Astra Voice. Is now a good time?',
      options: [
        {
          id: 'maya',
          name: employee && employee.name ? employee.name : 'Maya',
          description: 'Current employee voice draft',
          selected: true,
          demoPreview: false,
        },
      ],
    },
    languages,
    catalog: voiceCatalogSummary || null,
    providers: [],
    advancedProviders: ['Dograh Managed', 'Deepgram Aura', 'Sarvam', 'Rumik'],
    productionSafe: true,
    applyLive: false,
  };
}

function buildRoutingRules(db, tenantId, employee, draft) {
  if (Array.isArray(draft.routingRules) && draft.routingRules.length) {
    return draft.routingRules;
  }
  const actions = employees.normalizeActionsList
    ? employees.normalizeActionsList(employee && employee.actions)
    : (employee && Array.isArray(employee.actions) ? employee.actions : []);
  const rules = [];
  for (const a of (actions || []).filter((x) => x.enabled !== false).slice(0, 6)) {
    rules.push({
      id: a.key,
      when: a.label || a.type,
      then: a.type === 'transfer_to_human'
        ? ('Transfer → ' + ((a.config && a.config.target) || 'teammate'))
        : (a.type === 'book_callback' ? 'Book callback' : a.type),
      demoPreview: false,
    });
  }
  if (!rules.length && employee && employee.workflowId) {
    const wf = (db.workflows || []).find((w) => w.id === employee.workflowId && w.tenantId === tenantId);
    if (wf) {
      rules.push({
        id: 'workflow_default',
        when: 'Inbound / outbound',
        then: 'Workflow · ' + (wf.name || employee.workflowId),
        demoPreview: false,
      });
    }
  }
  return rules;
}

function buildRoutingStep(db, tenantId, employee, mode, draft, calendar) {
  if (mode === 'demo') {
    return {
      demoPreview: true,
      label: 'DEMO PREVIEW',
      businessNumber: {
        e164: '+918065353938',
        direction: 'Inbound & outbound',
        note: 'Illustrative DID · Demo preview only',
        demoPreview: true,
      },
      routing: [
        { when: 'Qualified', then: 'Sales teammate', demoPreview: true },
        { when: 'Support questions', then: 'Help desk', demoPreview: true },
        { when: 'After hours', then: 'Voicemail + WhatsApp follow-up', demoPreview: true },
      ],
      workingHours: {
        timezone: 'Asia/Kolkata',
        label: '09:00 – 19:00 IST',
        days: [1, 2, 3, 4, 5],
        demoPreview: true,
      },
      calendar: {
        primary: {
          label: 'Astra Voice Demo calendar',
          status: 'Connected',
          note: 'Illustrative setup · no external account is connected',
          demoPreview: true,
        },
        secondary: { label: 'Second calendar', status: 'Connect', demoPreview: true },
      },
    };
  }

  let number = null;
  if (employee && employee.phoneNumberId) {
    number = (db.phoneNumbers || []).find((n) => n.id === employee.phoneNumberId && n.tenantId === tenantId);
  }
  if (!number) {
    number = (db.phoneNumbers || []).find((n) => n.tenantId === tenantId
      && phoneNumbers.normalizeE164(n.e164) === '+918065353938');
  }
  if (!number) {
    number = (db.phoneNumbers || []).find((n) => n.tenantId === tenantId) || null;
  }

  const inbound = number ? phoneNumbers.publicInboundConfig(number, null) : null;
  const hours = (draft.workingHours)
    || (inbound && inbound.hours)
    || { timezone: 'Asia/Kolkata', mode: 'schedule', windows: [{ days: [1, 2, 3, 4, 5], start: '09:00', end: '19:00' }] };

  const days = [];
  if (hours.mode === 'always') {
    days.push(0, 1, 2, 3, 4, 5, 6);
  } else if (Array.isArray(hours.windows)) {
    for (const w of hours.windows) {
      for (const d of (w.days || [])) if (!days.includes(d)) days.push(d);
    }
  }
  const window0 = Array.isArray(hours.windows) && hours.windows[0] ? hours.windows[0] : null;

  return {
    demoPreview: false,
    businessNumber: number ? {
      id: number.id,
      e164: number.e164,
      direction: [
        number.inboundEnabled !== false ? 'inbound' : null,
        number.outboundEnabled !== false ? 'outbound' : null,
      ].filter(Boolean).join(' & ') || 'assigned',
      label: number.label || null,
      employeeId: number.assignedEmployeeId || (employee && employee.id) || null,
    } : {
      e164: null,
      direction: null,
      unassigned: true,
      preferredDid: '+918065353938',
      note: 'No phone number assigned yet. Assign +918065353938 (or another DID) to Maya under Phone Numbers.',
    },
    routing: buildRoutingRules(db, tenantId, employee, draft),
    workingHours: {
      timezone: hours.timezone || 'Asia/Kolkata',
      mode: hours.mode || 'schedule',
      days: days.length ? days.sort() : [1, 2, 3, 4, 5],
      start: window0 ? window0.start : '09:00',
      end: window0 ? window0.end : '19:00',
      label: (window0 ? (window0.start + ' – ' + window0.end) : '09:00 – 19:00')
        + ' ' + ((hours.timezone || 'Asia/Kolkata') === 'Asia/Kolkata' ? 'IST' : (hours.timezone || '')),
    },
    calendar,
    workflowName: employee && employee.workflowId
      ? (((db.workflows || []).find((w) => w.id === employee.workflowId) || {}).name || null)
      : null,
  };
}

function buildCalendarStatus(env = process.env) {
  const configured = Boolean(String(env.CALCOM_API_KEY || '').trim());
  const eventId = String(env.CALCOM_EVENT_TYPE_ID || '7294717').trim() || '7294717';
  const label = String(env.CALCOM_EVENT_LABEL || 'Astra Voice Demo').trim() || 'Astra Voice Demo';
  if (!configured) {
    return {
      configured: false,
      primary: {
        label,
        eventTypeId: eventId,
        status: 'Not connected',
        note: 'Add CALCOM_API_KEY to connect Cal.com.',
        demoPreview: false,
      },
      secondary: {
        label: 'Second calendar',
        status: 'Connect',
        demoPreview: false,
      },
      actions: ['connect', 'change_provider', 'test_connection'],
    };
  }
  return {
    configured: true,
    primary: {
      label,
      eventTypeId: eventId,
      status: 'Connected',
      note: null,
      demoPreview: false,
    },
    secondary: {
      label: 'Second calendar',
      status: 'Connect',
      demoPreview: false,
    },
    actions: ['change_provider', 'test_connection', 'connect_second'],
  };
}

function buildCallStep(db, tenantId, employee, mode) {
  if (mode === 'demo') {
    return {
      demoPreview: true,
      label: 'DEMO PREVIEW',
      participant: { name: 'Demo Caller', context: 'New enquiry · Product demo' },
      language: 'Telugu · DEMO PREVIEW',
      status: 'Connected',
      timer: '02:18',
      transcript: [
        { speaker: 'Maya', role: 'agent', language: 'TELUGU', text: 'హలో, మీ enquiry గురించి మాట్లాడుతున్నాను.', demoPreview: true },
        { speaker: 'Caller', role: 'caller', text: 'మా sales team కోసం product demo కావాలి.', highlights: ['sales team', 'product demo'], demoPreview: true },
        { speaker: 'Maya', role: 'agent', language: 'TELUGU', text: 'మీరు ఏ solution గురించి చూస్తున్నారు?', demoPreview: true },
        { speaker: 'Caller', role: 'caller', text: 'ఈ వారం సరిపోతుంది.', highlights: ['ఈ వారం'], demoPreview: true },
        { speaker: 'Maya', role: 'agent', language: 'TELUGU', text: 'ఎప్పుడు schedule చేయాలని అనుకుంటున్నారు?', demoPreview: true },
      ],
      toolChips: ['Listening', 'Speaking', 'Book meeting'],
      note: 'Illustrative conversation · DEMO PREVIEW only. Never written to live call records.',
      realtimeAvailable: false,
    };
  }

  const agentId = employee && employee.agentId ? employee.agentId : null;
  const recent = (db.calls || [])
    .filter((c) => c.tenantId === tenantId
      && (!employee || !employee.id || c.employeeId === employee.id || c.agentId === agentId))
    .sort((a, b) => String(b.updatedAt || b.endedAt || b.createdAt || '')
      .localeCompare(String(a.updatedAt || a.endedAt || a.createdAt || '')))[0] || null;

  let transcript = [];
  if (recent && recent.transcript) {
    if (Array.isArray(recent.transcript)) {
      transcript = recent.transcript.map((t) => ({
        speaker: t.speaker || t.role || 'Speaker',
        role: t.role || 'caller',
        text: t.text || t.content || '',
        demoPreview: false,
      })).filter((t) => t.text);
    } else if (typeof recent.transcript === 'string' && recent.transcript.trim()) {
      transcript = [{ speaker: 'Transcript', role: 'transcript', text: recent.transcript, demoPreview: false }];
    }
  }

  return {
    demoPreview: false,
    agentId,
    employeeId: employee ? employee.id : null,
    employeeName: employee ? employee.name : 'Maya',
    realtimeAvailable: Boolean(String(process.env.DOGRAH_EMBED_TOKEN || '').trim()
      && String(process.env.DOGRAH_BASE_URL || '').trim()),
    statuses: ['Connecting', 'Connected', 'Listening', 'Speaking', 'Tool call', 'Ended', 'Failed'],
    toolChips: ['Listening', 'Speaking', 'Tool call', 'Book meeting'],
    status: 'Ready',
    recentCall: recent ? calls.publicCall(recent) : null,
    transcript,
    note: transcript.length
      ? 'Showing the latest real conversation transcript.'
      : 'No live session transcript yet. Use Run Live Demo or Start live call to open realtime Talk.',
  };
}

function extractProvenance(extracted) {
  if (!extracted || typeof extracted !== 'object') return [];
  const fields = [];
  for (const [key, value] of Object.entries(extracted)) {
    if (value == null || value === '') continue;
    if (key === 'provenance' && typeof value === 'object') continue;
    const prov = extracted.provenance && extracted.provenance[key]
      ? String(extracted.provenance[key])
      : (value && typeof value === 'object' && value.from ? String(value.from) : null);
    const display = value && typeof value === 'object' && value.value != null ? value.value : value;
    fields.push({
      key,
      label: key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
      value: typeof display === 'string' || typeof display === 'number' || typeof display === 'boolean'
        ? display
        : JSON.stringify(display).slice(0, 120),
      provenance: prov,
    });
  }
  return fields.slice(0, 12);
}

function buildOutcomeStep(db, tenantId, employee, mode) {
  if (mode === 'demo') {
    return {
      demoPreview: true,
      label: 'DEMO PREVIEW',
      breadcrumb: ['CONVERSATION', 'UNDERSTANDING', 'OUTCOME', 'NEXT ACTION'],
      active: 'OUTCOME',
      fields: [
        { key: 'interest', label: 'INTEREST', value: 'Product demo', provenance: 'from "product demo"', demoPreview: true },
        { key: 'team', label: 'TEAM', value: 'Sales', provenance: 'from "sales team"', demoPreview: true },
        { key: 'timing', label: 'TIMING', value: 'This week', provenance: 'from "this week"', demoPreview: true },
        { key: 'status', label: 'STATUS', value: 'Qualified', success: true, demoPreview: true },
      ],
      note: 'Normalized English fields from the multilingual call (DEMO PREVIEW only).',
    };
  }

  const defs = employee && Array.isArray(employee.outcomes) ? employee.outcomes : [];
  const recent = (db.calls || [])
    .filter((c) => c.tenantId === tenantId
      && (!employee || !c.employeeId || c.employeeId === employee.id))
    .sort((a, b) => String(b.updatedAt || b.endedAt || b.createdAt || '')
      .localeCompare(String(a.updatedAt || a.endedAt || a.createdAt || '')))[0] || null;

  const fields = [];
  if (recent) {
    const extracted = extractProvenance(recent.extractedData);
    for (const f of extracted) fields.push({ ...f, demoPreview: false });
    if (recent.outcome) {
      fields.push({
        key: 'status',
        label: 'STATUS',
        value: recent.outcome,
        success: /qualif|booked|converted|resolved/i.test(String(recent.outcome)),
        demoPreview: false,
      });
    }
  }

  return {
    demoPreview: false,
    breadcrumb: ['CONVERSATION', 'UNDERSTANDING', 'OUTCOME', 'NEXT ACTION'],
    active: 'OUTCOME',
    schema: defs.map((d) => ({ key: d.key, label: d.label, success: !!d.success })),
    fields,
    summary: recent && recent.summary ? recent.summary : null,
    callId: recent ? recent.id : null,
    note: fields.length
      ? 'Structured fields from the latest real call outcome.'
      : 'No structured outcome yet. Complete a live call to populate fields. Schema definitions are shown when configured.',
  };
}

function buildNextStep(db, tenantId, employee, mode) {
  if (mode === 'demo') {
    return {
      demoPreview: true,
      label: 'DEMO PREVIEW',
      nextAction: {
        title: 'Schedule sales follow-up',
        owner: 'Sales teammate',
        detail: 'Demo this week',
        demoPreview: true,
      },
      // Never invent investor KPIs (no 128 / 46% / 38).
      metrics: [],
      outcomeSummary: {
        text: 'Regional-language call captured as structured English context - ready for Chat follow-up or CRM.',
        demoPreview: true,
      },
      disclaimer: 'DEMO PREVIEW only · metrics omitted · never written to live records.',
    };
  }

  const pub = employee ? employees.publicEmployee(employee, db) : null;
  const actions = employee && Array.isArray(employee.actions)
    ? employee.actions.filter((a) => a.enabled !== false)
    : [];
  const primary = actions[0] || null;

  const recent = (db.calls || [])
    .filter((c) => c.tenantId === tenantId
      && (!employee || !c.employeeId || c.employeeId === employee.id))
    .sort((a, b) => String(b.updatedAt || b.endedAt || b.createdAt || '')
      .localeCompare(String(a.updatedAt || a.endedAt || a.createdAt || '')))[0] || null;

  const metrics = [];
  if (pub) {
    if (pub.callsToday != null) metrics.push({ key: 'calls_today', label: 'Calls today', value: String(pub.callsToday), demoPreview: false });
    if (pub.leads != null) metrics.push({ key: 'leads', label: 'Leads', value: String(pub.leads), demoPreview: false });
    if (pub.qualified != null) metrics.push({ key: 'qualified', label: 'Qualified', value: String(pub.qualified), demoPreview: false });
  }

  return {
    demoPreview: false,
    nextAction: primary ? {
      title: primary.label || primary.type,
      owner: (primary.config && primary.config.target) || null,
      detail: primary.description || primary.type,
      key: primary.key,
      demoPreview: false,
    } : (recent && recent.outcome ? {
      title: 'Review · ' + recent.outcome,
      owner: null,
      detail: recent.summary || 'From latest conversation',
      demoPreview: false,
    } : {
      title: 'No recommended action yet',
      owner: null,
      detail: 'Configure Actions on the Employee, or complete a live call.',
      demoPreview: false,
    }),
    metrics,
    outcomeSummary: {
      text: recent && recent.summary ? recent.summary : null,
      source: recent && recent.summary ? 'call_summary' : null,
      demoPreview: false,
    },
    disclaimer: null,
  };
}

function buildJourneyPayload(db, tenant, opts = {}) {
  const draft = getTenantDraft(tenant);
  const mode = opts.mode ? normalizeMode(opts.mode) : draft.mode;
  const employee = resolveEmployee(db, tenant.id, draft);
  const calendar = buildCalendarStatus(opts.env || process.env);
  const voiceCatalogSummary = opts.voiceCatalogSummary || null;

  return {
    enabled: true,
    product: 'Astra Voice',
    workspaceLabel: 'AstraConnect Workspace',
    paths: {
      configure: { id: 'configure', label: 'Configure Maya', startStep: 'employee' },
      demonstrate: { id: 'demonstrate', label: 'Run Live Demo', startStep: 'call' },
    },
    mode,
    steps: JOURNEY_STEPS.map((s) => ({ ...s })),
    currentStep: normalizeStep(opts.step || draft.step),
    draft: {
      step: draft.step,
      mode: draft.mode,
      employeeId: draft.employeeId || (employee && employee.id) || null,
      updatedAt: draft.updatedAt,
    },
    employeeId: employee ? employee.id : null,
    employee: buildEmployeeStep(db, employee, mode),
    knowledge: buildKnowledgeStep(db, tenant.id, employee, mode, draft),
    language: buildLanguageStep(employee, mode, draft, voiceCatalogSummary),
    routing: buildRoutingStep(db, tenant.id, employee, mode, draft, calendar),
    call: buildCallStep(db, tenant.id, employee, mode),
    outcome: buildOutcomeStep(db, tenant.id, employee, mode),
    next: buildNextStep(db, tenant.id, employee, mode),
  };
}

module.exports = {
  JOURNEY_STEPS,
  LANGUAGE_CATALOG,
  featureEnabled,
  getTenantDraft,
  setTenantDraft,
  resolveEmployee,
  buildCalendarStatus,
  buildJourneyPayload,
  normalizeStep,
  normalizeMode,
};
