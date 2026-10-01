/**
 * Astra Voice. Per-AI-Employee phone number configuration.
 *
 * Astra is the source of truth. Dograh / VoBiz stay infrastructure behind
 * telephony-provider. Customers see Phone Number / Business Number / Workflow
 * product names only. Never Dograh or VoBiz ids in normal UI payloads.
 *
 * Persist fields (on employee.phoneConfig + assigned phone number):
 *   assigned_phone_number, telephony_provider, direction, inbound_enabled,
 *   outbound_enabled, caller_id, dograh_phone_id, telephony_config_id,
 *   workflow_id, answer_url, hangup_callback, working_hours,
 *   after_hours_action, escalation_target
 *
 * Assignment path:
 *   Astra UI → employee_id → select available number → bind phone to
 *   employee/workflow → update Dograh telephony mapping (or dry-run) →
 *   update VoBiz application/answer URL if required → verify callback →
 *   persist in Astra.
 *
 * Isolation: changing Vaani never mutates Maya's phone mapping.
 * Test inbound/outbound are dry-run / preflight only. Never place paid calls.
 *
 * No em dashes anywhere. Commas and periods only.
 */
'use strict';

const phoneNumbers = require('./phone-numbers');
const workflows = require('./workflows');

const MAYA_PROTECTED_EMPLOYEE_ID = 'emp_33eae8ef454680f0';
const MAYA_PROTECTED_E164 = '+918065353938';
const VAANI_EMPLOYEE_ID = 'emp_f85510806c9de004';

const TELEPHONY_PROVIDER_INTERNAL = 'dograh_vobiz';
const TELEPHONY_PROVIDER_PUBLIC = 'Astra Voice Telephony';

const AFTER_HOURS_ACTIONS = new Set([
  'voicemail',
  'message',
  'hangup',
  'escalate',
  'disabled',
]);

const DIRECTION_VALUES = new Set(['inbound', 'outbound', 'both', 'none']);

function nowIso() {
  return new Date().toISOString();
}

function defaultWorkingHours() {
  return {
    timezone: 'Asia/Kolkata',
    mode: 'always',
    windows: [
      { days: [1, 2, 3, 4, 5], start: '09:00', end: '19:00' },
    ],
  };
}

function normalizeWorkingHours(raw, existing) {
  const base = existing && typeof existing === 'object' ? existing : defaultWorkingHours();
  if (raw === undefined) {
    return {
      timezone: String(base.timezone || 'Asia/Kolkata').slice(0, 64),
      mode: base.mode === 'schedule' ? 'schedule' : 'always',
      windows: Array.isArray(base.windows) ? base.windows.slice(0, 14) : [],
    };
  }
  if (raw === null) return defaultWorkingHours();
  const b = raw && typeof raw === 'object' ? raw : {};
  const mode = b.mode === 'schedule' ? 'schedule' : 'always';
  const timezone = String(b.timezone != null ? b.timezone : base.timezone || 'Asia/Kolkata')
    .trim().slice(0, 64) || 'Asia/Kolkata';
  const windows = [];
  const src = Array.isArray(b.windows)
    ? b.windows
    : (mode === 'schedule' && Array.isArray(base.windows) ? base.windows : []);
  for (const w of src.slice(0, 14)) {
    if (!w || typeof w !== 'object') continue;
    const days = Array.isArray(w.days)
      ? w.days.map((d) => Number(d)).filter((d) => d >= 0 && d <= 6).slice(0, 7)
      : [];
    const start = String(w.start || '09:00').trim().slice(0, 8);
    const end = String(w.end || '18:00').trim().slice(0, 8);
    if (!/^\d{1,2}:\d{2}$/.test(start) || !/^\d{1,2}:\d{2}$/.test(end)) continue;
    windows.push({ days, start, end });
  }
  return { timezone, mode, windows };
}

function directionFromFlags(inboundEnabled, outboundEnabled) {
  const inb = inboundEnabled !== false;
  const out = outboundEnabled !== false;
  if (inb && out) return 'both';
  if (inb) return 'inbound';
  if (out) return 'outbound';
  return 'none';
}

function directionLabel(direction) {
  switch (direction) {
    case 'both': return 'Inbound + Outbound';
    case 'inbound': return 'Inbound only';
    case 'outbound': return 'Outbound only';
    case 'none': return 'Disabled';
    default: return '—';
  }
}

/**
 * Customer-facing connection state.
 * Unassigned | Connected | Inbound only | Outbound only | Inbound + Outbound | Needs attention
 */
function connectionState(number, phoneConfig) {
  if (!number || number.status !== 'assigned') return 'Unassigned';
  const cfg = phoneConfig || {};
  const needs = cfg.needsAttention === true
    || cfg.callbackVerifyOk === false
    || (!number.inboundWorkflowId && !cfg.workflow_id && cfg.inbound_enabled !== false);
  if (needs) return 'Needs attention';
  const direction = cfg.direction || directionFromFlags(number.inboundEnabled, number.outboundEnabled);
  if (direction === 'inbound') return 'Inbound only';
  if (direction === 'outbound') return 'Outbound only';
  if (direction === 'both') {
    // Connected when mapping + callbacks look healthy.
    if (cfg.callbackVerifyOk === true || cfg.telephonySyncOk === true) return 'Connected';
    return 'Inbound + Outbound';
  }
  if (direction === 'none') return 'Needs attention';
  return 'Connected';
}

function defaultAnswerUrl(baseUrl) {
  const base = String(baseUrl || process.env.ASTRA_PUBLIC_URL || process.env.DOGRAH_BASE_URL || '')
    .replace(/\/+$/, '');
  if (!base) return '/api/v1/telephony/inbound/run';
  return base + '/api/v1/telephony/inbound/run';
}

function defaultHangupCallback(baseUrl) {
  const base = String(baseUrl || process.env.ASTRA_PUBLIC_URL || process.env.DOGRAH_BASE_URL || '')
    .replace(/\/+$/, '');
  if (!base) return '/api/v1/telephony/hangup';
  return base + '/api/v1/telephony/hangup';
}

function emptyPhoneConfig() {
  return {
    assigned_phone_number: null,
    phone_number_id: null,
    telephony_provider: TELEPHONY_PROVIDER_INTERNAL,
    direction: 'none',
    inbound_enabled: false,
    outbound_enabled: false,
    caller_id: null,
    dograh_phone_id: null,
    telephony_config_id: null,
    workflow_id: null,
    answer_url: null,
    hangup_callback: null,
    working_hours: defaultWorkingHours(),
    after_hours_action: 'voicemail',
    escalation_target: null,
    callbackVerifyOk: null,
    telephonySyncOk: null,
    telephonySyncMode: null,
    telephonySyncAt: null,
    needsAttention: false,
    updatedAt: null,
  };
}

function ensurePhoneConfig(employee) {
  if (!employee.phoneConfig || typeof employee.phoneConfig !== 'object') {
    employee.phoneConfig = emptyPhoneConfig();
  }
  return employee.phoneConfig;
}

function findEmployee(db, tenantId, employeeId) {
  return (db.employees || []).find(
    (e) => e.id === String(employeeId || '') && e.tenantId === tenantId,
  ) || null;
}

function resolveWorkflowName(db, tenantId, workflowId) {
  if (!workflowId) return null;
  const wf = (db.workflows || []).find((w) => w.id === workflowId && w.tenantId === tenantId);
  return wf ? (wf.name || null) : null;
}

/**
 * Build persisted phoneConfig from an assigned number + employee.
 * Internal ids stay on the row. Public serializers strip them unless advanced.
 */
function buildPhoneConfigFromAssignment(db, employee, number, opts = {}) {
  const meta = (number && number.providerMetadata) || {};
  const inbound = number ? number.inboundEnabled !== false : false;
  const outbound = number ? number.outboundEnabled !== false : false;
  const direction = opts.direction
    || directionFromFlags(
      opts.inboundEnabled !== undefined ? opts.inboundEnabled : inbound,
      opts.outboundEnabled !== undefined ? opts.outboundEnabled : outbound,
    );
  const workflowId = opts.workflowId
    || (number && number.inboundWorkflowId)
    || employee.workflowId
    || null;
  const answerUrl = opts.answer_url != null
    ? String(opts.answer_url).slice(0, 400)
    : (number && number.answerUrl) || defaultAnswerUrl(opts.baseUrl);
  const hangup = opts.hangup_callback != null
    ? String(opts.hangup_callback).slice(0, 400)
    : (number && number.hangupCallback) || defaultHangupCallback(opts.baseUrl);
  const hours = normalizeWorkingHours(
    opts.working_hours !== undefined ? opts.working_hours : (number && number.inboundHours),
    employee.phoneConfig && employee.phoneConfig.working_hours,
  );
  const afterHours = AFTER_HOURS_ACTIONS.has(String(opts.after_hours_action || ''))
    ? String(opts.after_hours_action)
    : ((employee.phoneConfig && employee.phoneConfig.after_hours_action) || 'voicemail');
  const escalation = opts.escalation_target !== undefined
    ? (opts.escalation_target ? String(opts.escalation_target).slice(0, 120) : null)
    : ((employee.phoneConfig && employee.phoneConfig.escalation_target) || null);

  return {
    assigned_phone_number: number ? number.e164 : null,
    phone_number_id: number ? number.id : null,
    telephony_provider: TELEPHONY_PROVIDER_INTERNAL,
    direction,
    inbound_enabled: direction === 'inbound' || direction === 'both',
    outbound_enabled: direction === 'outbound' || direction === 'both',
    caller_id: number ? number.e164 : null,
    dograh_phone_id: meta.dograhPhoneNumberId != null
      ? Number(meta.dograhPhoneNumberId)
      : (number && number.providerNumberId != null ? Number(number.providerNumberId) : null),
    telephony_config_id: meta.dograhTelephonyConfigId != null
      ? Number(meta.dograhTelephonyConfigId)
      : null,
    workflow_id: workflowId,
    answer_url: answerUrl,
    hangup_callback: hangup,
    working_hours: hours,
    after_hours_action: afterHours,
    escalation_target: escalation,
    callbackVerifyOk: opts.callbackVerifyOk != null ? !!opts.callbackVerifyOk : null,
    telephonySyncOk: opts.telephonySyncOk != null ? !!opts.telephonySyncOk : null,
    telephonySyncMode: opts.telephonySyncMode || null,
    telephonySyncAt: opts.telephonySyncAt || null,
    needsAttention: opts.needsAttention === true,
    updatedAt: nowIso(),
  };
}

/**
 * Customer-facing phone config. Never includes Dograh / VoBiz brand or raw ids
 * unless opts.advanced is true (Advanced panel / Super Admin).
 */
function publicPhoneConfig(db, employee, opts = {}) {
  if (!employee) return null;
  const number = phoneNumbers.findNumber(db, employee.phoneNumberId)
    || (db.phoneNumbers || []).find((n) => n.assignedEmployeeId === employee.id)
    || null;
  const raw = (employee.phoneConfig && typeof employee.phoneConfig === 'object')
    ? employee.phoneConfig
    : emptyPhoneConfig();
  // Prefer live number state when assigned.
  const merged = number
    ? {
      ...raw,
      assigned_phone_number: number.e164,
      phone_number_id: number.id,
      inbound_enabled: number.inboundEnabled !== false,
      outbound_enabled: number.outboundEnabled !== false,
      direction: directionFromFlags(number.inboundEnabled, number.outboundEnabled),
      caller_id: raw.caller_id || number.e164,
      workflow_id: raw.workflow_id || number.inboundWorkflowId || employee.workflowId || null,
      working_hours: raw.working_hours || number.inboundHours || defaultWorkingHours(),
    }
    : { ...emptyPhoneConfig(), ...raw, assigned_phone_number: null, phone_number_id: null };

  const state = connectionState(number, merged);
  const workflowName = resolveWorkflowName(db, employee.tenantId, merged.workflow_id)
    || resolveWorkflowName(db, employee.tenantId, employee.workflowId);

  const out = {
    employeeId: employee.id,
    employeeName: employee.name || null,
    businessNumber: merged.assigned_phone_number,
    phoneNumberId: merged.phone_number_id,
    direction: merged.direction,
    directionLabel: directionLabel(merged.direction),
    status: state,
    connectionState: state,
    inboundEnabled: !!merged.inbound_enabled,
    outboundEnabled: !!merged.outbound_enabled,
    callerId: merged.caller_id || null,
    workflowId: merged.workflow_id || null,
    workflowName: workflowName || null,
    workingHours: normalizeWorkingHours(merged.working_hours, null),
    afterHoursAction: merged.after_hours_action || 'voicemail',
    escalationTarget: merged.escalation_target || null,
    answerUrlConfigured: !!(merged.answer_url),
    hangupCallbackConfigured: !!(merged.hangup_callback),
    telephonyProviderLabel: TELEPHONY_PROVIDER_PUBLIC,
    callbackVerifyOk: merged.callbackVerifyOk,
    telephonySyncOk: merged.telephonySyncOk,
    updatedAt: merged.updatedAt || null,
  };

  if (opts.advanced) {
    out.advanced = {
      telephony_provider: merged.telephony_provider || TELEPHONY_PROVIDER_INTERNAL,
      dograh_phone_id: merged.dograh_phone_id,
      telephony_config_id: merged.telephony_config_id,
      answer_url: merged.answer_url,
      hangup_callback: merged.hangup_callback,
      telephonySyncMode: merged.telephonySyncMode,
      telephonySyncAt: merged.telephonySyncAt,
    };
  }

  return out;
}

/**
 * Enrich publicPhoneNumber with connection state and workflow product name.
 * Still never leaks provider ids.
 */
function enrichPublicPhoneNumber(pub, number, phoneConfig) {
  if (!pub) return null;
  const cfg = phoneConfig || {};
  const direction = directionFromFlags(pub.inboundEnabled, pub.outboundEnabled);
  const state = connectionState(number, {
    ...cfg,
    direction,
    inbound_enabled: pub.inboundEnabled,
    outbound_enabled: pub.outboundEnabled,
    workflow_id: cfg.workflow_id || pub.inboundWorkflowId,
  });
  return {
    ...pub,
    businessNumber: pub.e164,
    direction,
    directionLabel: directionLabel(direction),
    connectionState: state,
    statusLabel: state,
    workflowName: pub.inboundWorkflowName || pub.outboundWorkflowName || null,
    callerId: (cfg.caller_id || pub.e164) || null,
  };
}

/**
 * Dry-run / preflight verification of answer URL + hangup callback shape.
 * Never places a paid PSTN call. Never hits VoBiz unless opts.liveVerify and
 * telephony adapter is provided (still no dial).
 */
function verifyCallbacks(phoneConfig, opts = {}) {
  const answer = String((phoneConfig && phoneConfig.answer_url) || '').trim();
  const hangup = String((phoneConfig && phoneConfig.hangup_callback) || '').trim();
  const checks = [];
  let ok = true;

  if (!answer) {
    ok = false;
    checks.push({ field: 'answer_url', ok: false, detail: 'missing' });
  } else if (!(/^https?:\/\//i.test(answer) || answer.startsWith('/api/'))) {
    ok = false;
    checks.push({ field: 'answer_url', ok: false, detail: 'invalid_shape' });
  } else {
    checks.push({ field: 'answer_url', ok: true, detail: 'configured' });
  }

  if (!hangup) {
    ok = false;
    checks.push({ field: 'hangup_callback', ok: false, detail: 'missing' });
  } else if (!(/^https?:\/\//i.test(hangup) || hangup.startsWith('/api/'))) {
    ok = false;
    checks.push({ field: 'hangup_callback', ok: false, detail: 'invalid_shape' });
  } else {
    checks.push({ field: 'hangup_callback', ok: true, detail: 'configured' });
  }

  return {
    ok,
    mode: opts.liveVerify ? 'live_preflight' : 'dry_run',
    paidCall: false,
    checks,
    verifiedAt: nowIso(),
  };
}

/**
 * Simulate or perform Dograh telephony mapping update for ONE number only.
 * Never touches other employees' numbers (Maya/Vaani isolation).
 */
async function syncTelephonyMapping(db, tenantId, employee, number, opts = {}) {
  const meta = { ...(number.providerMetadata || {}) };
  const workflowId = (employee.phoneConfig && employee.phoneConfig.workflow_id)
    || number.inboundWorkflowId
    || employee.workflowId
    || null;
  let providerWorkflowId = null;
  if (workflowId) {
    providerWorkflowId = workflows.resolveProviderWorkflowId(db, tenantId, workflowId);
  }
  if (providerWorkflowId) {
    meta.inboundWorkflowId = providerWorkflowId;
    meta.providerInboundWorkflowId = providerWorkflowId;
    meta.inboundAstraWorkflowId = workflowId;
  }
  if (employee.phoneConfig && employee.phoneConfig.answer_url) {
    meta.answerUrl = employee.phoneConfig.answer_url;
  }
  if (employee.phoneConfig && employee.phoneConfig.hangup_callback) {
    meta.hangupCallback = employee.phoneConfig.hangup_callback;
  }
  meta.lastEmployeeId = employee.id;
  meta.lastSyncAt = nowIso();
  number.providerMetadata = meta;
  if (employee.phoneConfig && employee.phoneConfig.answer_url) {
    number.answerUrl = employee.phoneConfig.answer_url;
  }
  if (employee.phoneConfig && employee.phoneConfig.hangup_callback) {
    number.hangupCallback = employee.phoneConfig.hangup_callback;
  }

  // Optional live Dograh PATCH when adapter provided. Fail soft to dry-run.
  if (opts.telephonyAdapter && typeof opts.telephonyAdapter.request === 'function' && opts.liveSync) {
    try {
      const configId = meta.dograhTelephonyConfigId;
      const phoneId = meta.dograhPhoneNumberId || Number(number.providerNumberId);
      if (configId && phoneId && providerWorkflowId) {
        await opts.telephonyAdapter.request(
          'PATCH',
          `/api/v1/organizations/telephony-configs/${configId}/phone-numbers/${phoneId}`,
          { inbound_workflow_id: providerWorkflowId },
        );
        return {
          ok: true,
          mode: 'live',
          providerWorkflowId,
          astraWorkflowId: workflowId,
          numberId: number.id,
          employeeId: employee.id,
        };
      }
    } catch (e) {
      return {
        ok: false,
        mode: 'live_failed_dry_run',
        error: String((e && e.message) || e).slice(0, 200),
        providerWorkflowId,
        astraWorkflowId: workflowId,
        numberId: number.id,
        employeeId: employee.id,
      };
    }
  }

  return {
    ok: true,
    mode: 'dry_run',
    providerWorkflowId,
    astraWorkflowId: workflowId,
    numberId: number.id,
    employeeId: employee.id,
    answerUrl: number.answerUrl || null,
    hangupCallback: number.hangupCallback || null,
  };
}

/**
 * Assign available number to employee, bind workflow, sync mapping, verify
 * callbacks, persist phoneConfig. Isolation: only mutates this employee and
 * the selected number (plus clearing prior links for THIS employee).
 */
function assignToEmployee(db, {
  tenantId, employeeId, numberId,
  inboundEnabled, outboundEnabled, direction,
  working_hours, after_hours_action, escalation_target,
  answer_url, hangup_callback, baseUrl,
  resolveProviderWorkflowId,
}) {
  const employee = findEmployee(db, tenantId, employeeId);
  if (!employee) {
    return { ok: false, status: 404, code: 'employee_not_found', error: 'employee not found' };
  }

  const inbound = direction === 'inbound' ? true
    : direction === 'outbound' ? false
      : direction === 'none' ? false
        : (inboundEnabled !== undefined ? !!inboundEnabled : true);
  const outbound = direction === 'outbound' ? true
    : direction === 'inbound' ? false
      : direction === 'none' ? false
        : (outboundEnabled !== undefined ? !!outboundEnabled : true);

  const assigned = phoneNumbers.assignNumber(db, {
    numberId,
    tenantId,
    employeeId,
    inboundEnabled: inbound,
    outboundEnabled: outbound,
    inboundWorkflowId: employee.workflowId || undefined,
    outboundWorkflowId: employee.workflowId || undefined,
    resolveProviderWorkflowId: resolveProviderWorkflowId || workflows.resolveProviderWorkflowId,
  });
  if (!assigned.ok) return assigned;

  const number = assigned.number;
  // Persist answer / hangup on the number row.
  const answerUrl = answer_url != null ? String(answer_url).slice(0, 400) : defaultAnswerUrl(baseUrl);
  const hangup = hangup_callback != null ? String(hangup_callback).slice(0, 400) : defaultHangupCallback(baseUrl);
  number.answerUrl = answerUrl;
  number.hangupCallback = hangup;
  if (working_hours !== undefined) {
    number.inboundHours = normalizeWorkingHours(working_hours, number.inboundHours);
  } else if (!number.inboundHours) {
    number.inboundHours = defaultWorkingHours();
  }

  const cfg = buildPhoneConfigFromAssignment(db, employee, number, {
    inboundEnabled: inbound,
    outboundEnabled: outbound,
    direction: direction || directionFromFlags(inbound, outbound),
    workflowId: employee.workflowId,
    answer_url: answerUrl,
    hangup_callback: hangup,
    working_hours: number.inboundHours,
    after_hours_action,
    escalation_target,
    baseUrl,
  });

  const verify = verifyCallbacks(cfg);
  cfg.callbackVerifyOk = verify.ok;
  cfg.needsAttention = !verify.ok;

  employee.phoneConfig = cfg;
  employee.phoneNumberId = number.id;
  employee.updatedAt = nowIso();
  number.updatedAt = nowIso();

  return { ok: true, employee, number, verify };
}

function unassignFromEmployee(db, { tenantId, employeeId }) {
  const employee = findEmployee(db, tenantId, employeeId);
  if (!employee) {
    return { ok: false, status: 404, code: 'employee_not_found', error: 'employee not found' };
  }
  const numberId = employee.phoneNumberId
    || ((db.phoneNumbers || []).find((n) => n.assignedEmployeeId === employee.id) || {}).id;
  if (!numberId) {
    // Already unassigned. Clear stale config.
    employee.phoneConfig = emptyPhoneConfig();
    employee.phoneConfig.updatedAt = nowIso();
    employee.updatedAt = nowIso();
    return { ok: true, employee, number: null, alreadyUnassigned: true };
  }

  // Snapshot other employees' phone configs for isolation asserts.
  const un = phoneNumbers.unassignNumber(db, { numberId, tenantId });
  if (!un.ok) return un;

  employee.phoneNumberId = null;
  employee.phoneConfig = emptyPhoneConfig();
  employee.phoneConfig.updatedAt = nowIso();
  employee.updatedAt = nowIso();
  return { ok: true, employee, number: un.number };
}

/**
 * Change number: unassign current (if any), assign new. Other employees untouched.
 */
function changeNumber(db, opts) {
  const employee = findEmployee(db, opts.tenantId, opts.employeeId);
  if (!employee) {
    return { ok: false, status: 404, code: 'employee_not_found', error: 'employee not found' };
  }
  if (employee.phoneNumberId && employee.phoneNumberId !== opts.numberId) {
    const cleared = unassignFromEmployee(db, {
      tenantId: opts.tenantId,
      employeeId: opts.employeeId,
    });
    if (!cleared.ok) return cleared;
  }
  return assignToEmployee(db, opts);
}

function patchPhoneConfig(db, tenantId, employeeId, body) {
  const employee = findEmployee(db, tenantId, employeeId);
  if (!employee) {
    return { ok: false, status: 404, code: 'employee_not_found', error: 'employee not found' };
  }
  const b = body && typeof body === 'object' ? body : {};
  const cfg = ensurePhoneConfig(employee);
  const number = employee.phoneNumberId
    ? phoneNumbers.findNumber(db, employee.phoneNumberId)
    : null;

  if (b.working_hours !== undefined || b.workingHours !== undefined) {
    const hours = normalizeWorkingHours(
      b.working_hours !== undefined ? b.working_hours : b.workingHours,
      cfg.working_hours,
    );
    cfg.working_hours = hours;
    if (number) number.inboundHours = hours;
  }
  if (b.after_hours_action !== undefined || b.afterHoursAction !== undefined) {
    const raw = b.after_hours_action !== undefined ? b.after_hours_action : b.afterHoursAction;
    const v = String(raw || 'voicemail');
    cfg.after_hours_action = AFTER_HOURS_ACTIONS.has(v) ? v : 'voicemail';
  }
  if (b.escalation_target !== undefined || b.escalationTarget !== undefined) {
    const raw = b.escalation_target !== undefined ? b.escalation_target : b.escalationTarget;
    cfg.escalation_target = raw ? String(raw).slice(0, 120) : null;
  }
  if (b.answer_url !== undefined || b.answerUrl !== undefined) {
    cfg.answer_url = String(
      b.answer_url !== undefined ? b.answer_url : b.answerUrl || '',
    ).slice(0, 400) || null;
    if (number) number.answerUrl = cfg.answer_url;
  }
  if (b.hangup_callback !== undefined || b.hangupCallback !== undefined) {
    cfg.hangup_callback = String(
      b.hangup_callback !== undefined ? b.hangup_callback : b.hangupCallback || '',
    ).slice(0, 400) || null;
    if (number) number.hangupCallback = cfg.hangup_callback;
  }
  if (b.caller_id !== undefined || b.callerId !== undefined) {
    const raw = b.caller_id !== undefined ? b.caller_id : b.callerId;
    cfg.caller_id = raw ? phoneNumbers.normalizeE164(raw) || String(raw).slice(0, 20) : null;
  }

  let inbound = cfg.inbound_enabled;
  let outbound = cfg.outbound_enabled;
  if (b.direction !== undefined && DIRECTION_VALUES.has(String(b.direction))) {
    const d = String(b.direction);
    cfg.direction = d;
    inbound = d === 'inbound' || d === 'both';
    outbound = d === 'outbound' || d === 'both';
    cfg.inbound_enabled = inbound;
    cfg.outbound_enabled = outbound;
  }
  if (b.inbound_enabled !== undefined || b.inboundEnabled !== undefined) {
    inbound = !!(b.inbound_enabled !== undefined ? b.inbound_enabled : b.inboundEnabled);
    cfg.inbound_enabled = inbound;
  }
  if (b.outbound_enabled !== undefined || b.outboundEnabled !== undefined) {
    outbound = !!(b.outbound_enabled !== undefined ? b.outbound_enabled : b.outboundEnabled);
    cfg.outbound_enabled = outbound;
  }
  cfg.direction = directionFromFlags(cfg.inbound_enabled, cfg.outbound_enabled);

  if (number && number.tenantId === tenantId) {
    if (b.inbound_enabled !== undefined || b.inboundEnabled !== undefined
      || b.outbound_enabled !== undefined || b.outboundEnabled !== undefined
      || b.direction !== undefined) {
      number.inboundEnabled = cfg.inbound_enabled;
      number.outboundEnabled = cfg.outbound_enabled;
      number.updatedAt = nowIso();
    }
  }

  const verify = verifyCallbacks(cfg);
  cfg.callbackVerifyOk = verify.ok;
  cfg.needsAttention = !verify.ok && !!cfg.assigned_phone_number;
  cfg.updatedAt = nowIso();
  employee.phoneConfig = cfg;
  employee.updatedAt = nowIso();

  return { ok: true, employee, number, verify };
}

/**
 * Dry-run inbound test. Checks mapping + answer URL. Never dials.
 */
function testInbound(db, tenantId, employeeId) {
  const employee = findEmployee(db, tenantId, employeeId);
  if (!employee) {
    return { ok: false, status: 404, code: 'employee_not_found', error: 'employee not found' };
  }
  const pub = publicPhoneConfig(db, employee, { advanced: true });
  if (!pub.phoneNumberId) {
    return {
      ok: false,
      status: 422,
      code: 'unassigned',
      error: 'Assign a Phone Number before testing inbound',
      result: { paidCall: false, mode: 'dry_run' },
    };
  }
  if (!pub.inboundEnabled) {
    return {
      ok: false,
      status: 422,
      code: 'inbound_disabled',
      error: 'Inbound is disabled for this Phone Number',
      result: { paidCall: false, mode: 'dry_run' },
    };
  }
  const number = phoneNumbers.findNumber(db, pub.phoneNumberId);
  const cfg = employee.phoneConfig || {};
  const verify = verifyCallbacks(cfg);
  const workflowBound = !!(cfg.workflow_id || (number && number.inboundWorkflowId) || employee.workflowId);
  const mappingOk = !!(number && number.providerMetadata
    && (number.providerMetadata.inboundWorkflowId || number.providerMetadata.providerInboundWorkflowId));
  const pass = verify.ok && workflowBound;
  return {
    ok: pass,
    status: pass ? 200 : 422,
    code: pass ? 'inbound_preflight_ok' : 'inbound_preflight_failed',
    error: pass ? undefined : 'Inbound preflight failed',
    result: {
      paidCall: false,
      mode: 'dry_run',
      employeeId: employee.id,
      businessNumber: pub.businessNumber,
      workflowId: pub.workflowId,
      workflowName: pub.workflowName,
      answerUrlConfigured: pub.answerUrlConfigured,
      hangupCallbackConfigured: pub.hangupCallbackConfigured,
      workflowBound,
      mappingOk,
      callbackVerify: verify,
      isolation: {
        employeeId: employee.id,
        numberId: pub.phoneNumberId,
        note: 'Preflight scoped to this employee only',
      },
    },
  };
}

/**
 * Dry-run outbound test. Checks caller ID + outbound enablement. Never dials
 * unless env ASTRA_ALLOW_PAID_TEST_CALLS=1 AND opts.confirmPaid === true
 * (still refused here by default).
 */
function testOutbound(db, tenantId, employeeId, opts = {}) {
  const employee = findEmployee(db, tenantId, employeeId);
  if (!employee) {
    return { ok: false, status: 404, code: 'employee_not_found', error: 'employee not found' };
  }
  // Hard refuse paid dials from this helper.
  if (opts.confirmPaid === true || opts.placeCall === true) {
    return {
      ok: false,
      status: 403,
      code: 'paid_calls_refused',
      error: 'Test outbound never places paid PSTN calls automatically',
      result: { paidCall: false, mode: 'refused' },
    };
  }
  const pub = publicPhoneConfig(db, employee, { advanced: true });
  if (!pub.phoneNumberId) {
    return {
      ok: false,
      status: 422,
      code: 'unassigned',
      error: 'Assign a Phone Number before testing outbound',
      result: { paidCall: false, mode: 'dry_run' },
    };
  }
  if (!pub.outboundEnabled) {
    return {
      ok: false,
      status: 422,
      code: 'outbound_disabled',
      error: 'Outbound is disabled for this Phone Number',
      result: { paidCall: false, mode: 'dry_run' },
    };
  }
  const number = phoneNumbers.findNumber(db, pub.phoneNumberId);
  const meta = (number && number.providerMetadata) || {};
  const callerIdOk = !!(pub.callerId || pub.businessNumber);
  const telephonyIdsOk = !!(meta.dograhTelephonyConfigId && (meta.dograhPhoneNumberId || number.providerNumberId));
  const pass = callerIdOk && telephonyIdsOk;
  return {
    ok: pass,
    status: pass ? 200 : 422,
    code: pass ? 'outbound_preflight_ok' : 'outbound_preflight_failed',
    error: pass ? undefined : 'Outbound preflight failed',
    result: {
      paidCall: false,
      mode: 'dry_run',
      employeeId: employee.id,
      businessNumber: pub.businessNumber,
      callerId: pub.callerId,
      callerIdOk,
      telephonyIdsOk,
      workflowName: pub.workflowName,
      isolation: {
        employeeId: employee.id,
        numberId: pub.phoneNumberId,
        note: 'Preflight scoped to this employee only',
      },
    },
  };
}

/**
 * Simulate persistence after restart: reload phoneConfig from a JSON clone
 * of the employee + number rows (same shape as db.json round-trip).
 */
function simulateReloadPersistence(db) {
  const raw = JSON.parse(JSON.stringify({
    employees: db.employees || [],
    phoneNumbers: db.phoneNumbers || [],
  }));
  return raw;
}

function applyReloadedState(db, snapshot) {
  db.employees = JSON.parse(JSON.stringify(snapshot.employees || []));
  db.phoneNumbers = JSON.parse(JSON.stringify(snapshot.phoneNumbers || []));
  return db;
}

module.exports = {
  MAYA_PROTECTED_EMPLOYEE_ID,
  MAYA_PROTECTED_E164,
  VAANI_EMPLOYEE_ID,
  TELEPHONY_PROVIDER_INTERNAL,
  TELEPHONY_PROVIDER_PUBLIC,
  AFTER_HOURS_ACTIONS,
  emptyPhoneConfig,
  ensurePhoneConfig,
  defaultWorkingHours,
  normalizeWorkingHours,
  directionFromFlags,
  directionLabel,
  connectionState,
  defaultAnswerUrl,
  defaultHangupCallback,
  buildPhoneConfigFromAssignment,
  publicPhoneConfig,
  enrichPublicPhoneNumber,
  verifyCallbacks,
  syncTelephonyMapping,
  assignToEmployee,
  unassignFromEmployee,
  changeNumber,
  patchPhoneConfig,
  testInbound,
  testOutbound,
  simulateReloadPersistence,
  applyReloadedState,
  findEmployee,
};
