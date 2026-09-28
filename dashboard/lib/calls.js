/**
 * Astra AI. First-class call history resources (tenant-scoped JSON store).
 *
 * Calls are Astra resources. Customers never see Dograh or VoBiz branding.
 * Provider run ids and recording secrets stay server-side. Recording access
 * is always mediated through GET /api/calls/:id/recording.
 *
 * No em dashes anywhere. Commas and periods only.
 */
'use strict';

const crypto = require('crypto');

const PROVIDER_ID = 'dograh_vobiz';

/** Documented Dograh candidate endpoints used by sync (canonical first). */
const DOGRAH_SYNC_CANDIDATES = Object.freeze([
  'GET /api/v1/workflow/{workflowId}/runs?page={page}&limit={limit}',
  'GET /api/v1/workflow/{workflowId}/runs/{runId}',
  'GET /api/v1/workflows/{workflowId}/runs?limit={limit}',
  'GET /api/v1/workflow-runs?limit={limit}',
  'GET /api/v1/telephony/calls?limit={limit}',
  'GET /api/v1/workflow-runs/{runId}',
  'GET /api/v1/workflow-runs/{runId}/recording',
]);

function genId(prefix) {
  return prefix + crypto.randomBytes(8).toString('hex');
}

function nowIso() {
  return new Date().toISOString();
}

function ensureCalls(db) {
  if (!Array.isArray(db.calls)) db.calls = [];
  if (!Array.isArray(db.providerResources)) db.providerResources = [];
}

function normalizeDirection(value) {
  const d = String(value || '').toLowerCase();
  return d === 'outbound' ? 'outbound' : 'inbound';
}

function normalizeStatus(value) {
  const s = String(value || '').toLowerCase().replace(/\s+/g, '_');
  const allowed = new Set([
    'queued', 'ringing', 'in_progress', 'completed', 'failed', 'busy', 'no_answer', 'canceled', 'unknown',
  ]);
  return allowed.has(s) ? s : 'unknown';
}

function asIso(value) {
  if (!value) return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    const ms = value > 1e12 ? value : value * 1000;
    return new Date(ms).toISOString();
  }
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function asInt(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : null;
}

function upsertProviderResource(db, call) {
  ensureCalls(db);
  const meta = call.providerMetadata || {};
  const providerResourceId = String(meta.providerRunId || call.providerRunId || '');
  if (!providerResourceId) return null;
  let row = (db.providerResources || []).find(
    (r) => r.astraResourceId === call.id && r.resourceType === 'call',
  );
  const ts = nowIso();
  if (!row) {
    row = {
      id: genId('pr_'),
      astraResourceId: call.id,
      resourceType: 'call',
      provider: call.provider || PROVIDER_ID,
      providerResourceId,
      metadata: { ...meta },
      createdAt: ts,
      updatedAt: ts,
    };
    db.providerResources.push(row);
  } else {
    row.providerResourceId = providerResourceId;
    row.provider = call.provider || PROVIDER_ID;
    row.metadata = { ...meta };
    row.updatedAt = ts;
  }
  return row;
}

/**
 * Client-safe list/detail shape. Never includes Dograh API keys or raw
 * provider recording URLs with secrets. recordingUrl is an Astra path when
 * a recording exists.
 */
function publicCall(call, agentsById, opts = {}) {
  if (!call) return null;
  const detail = opts.detail === true;
  const agent = call.agentId && agentsById ? agentsById.get(call.agentId) : null;
  const hasRecording = !!(call.recordingAvailable || call.providerMetadata?.recordingUrl || call.recordingUrl);
  const base = {
    id: call.id,
    agentId: call.agentId || null,
    agentName: agent ? agent.name : null,
    phoneNumberId: call.phoneNumberId || null,
    direction: call.direction || 'inbound',
    fromE164: call.fromE164 || null,
    toE164: call.toE164 || null,
    status: call.status || 'unknown',
    startedAt: call.startedAt || null,
    endedAt: call.endedAt || null,
    durationSec: call.durationSec == null ? null : call.durationSec,
    outcome: call.outcome || null,
    summary: call.summary || null,
    recordingAvailable: hasRecording,
    recordingUrl: hasRecording ? `/api/calls/${encodeURIComponent(call.id)}/recording` : null,
    createdAt: call.createdAt,
    updatedAt: call.updatedAt,
  };
  if (!detail) return base;
  return {
    ...base,
    extractedData: call.extractedData && typeof call.extractedData === 'object'
      ? { ...call.extractedData } : {},
    transcript: Array.isArray(call.transcript)
      ? call.transcript.map((t) => ({ ...t }))
      : (typeof call.transcript === 'string' ? call.transcript : []),
    latency: call.latency && typeof call.latency === 'object'
      ? {
        totalMs: call.latency.totalMs ?? null,
        sttMs: call.latency.sttMs ?? null,
        llmMs: call.latency.llmMs ?? null,
        ttsMs: call.latency.ttsMs ?? null,
      }
      : { totalMs: null, sttMs: null, llmMs: null, ttsMs: null },
    workflowVersion: call.workflowVersion || null,
  };
}

function listTenantCalls(db, tenantId, filters = {}) {
  ensureCalls(db);
  let rows = (db.calls || []).filter((c) => c.tenantId === tenantId);
  if (filters.agentId) {
    rows = rows.filter((c) => c.agentId === String(filters.agentId));
  }
  if (filters.employeeId) {
    const emp = (db.employees || []).find(
      (e) => e.id === String(filters.employeeId) && e.tenantId === tenantId,
    );
    if (emp && emp.agentId) {
      rows = rows.filter((c) => c.agentId === emp.agentId);
    } else {
      rows = [];
    }
  }
  if (filters.direction) {
    const dir = normalizeDirection(filters.direction);
    rows = rows.filter((c) => c.direction === dir);
  }
  if (filters.status) {
    rows = rows.filter((c) => String(c.status || '') === String(filters.status));
  }
  if (filters.outcome) {
    const needle = String(filters.outcome).toLowerCase();
    rows = rows.filter((c) => String(c.outcome || '').toLowerCase() === needle);
  }
  rows.sort((a, b) => String(b.startedAt || b.createdAt || '').localeCompare(String(a.startedAt || a.createdAt || '')));
  const limit = Math.max(1, Math.min(200, asInt(filters.limit) || 50));
  return rows.slice(0, limit);
}

function findCall(db, id) {
  ensureCalls(db);
  return (db.calls || []).find((c) => c.id === String(id || ''));
}

function findCallForTenant(db, id, tenantId) {
  const call = findCall(db, id);
  if (!call) return { ok: false, status: 404, code: 'not_found', error: 'call not found' };
  if (call.tenantId !== tenantId) {
    return { ok: false, status: 403, code: 'forbidden', error: 'call belongs to another workspace' };
  }
  return { ok: true, call };
}

/**
 * Upsert a call by providerRunId within a tenant (idempotent sync).
 * Returns { call, created, updated }.
 */
function upsertCallFromProvider(db, tenantId, input = {}) {
  ensureCalls(db);
  const providerRunId = String(input.providerRunId || input.providerCallId || '').trim();
  if (!providerRunId) {
    return { ok: false, status: 422, code: 'validation', error: 'providerRunId is required' };
  }

  let existing = (db.calls || []).find(
    (c) => c.tenantId === tenantId
      && String((c.providerMetadata && c.providerMetadata.providerRunId) || c.providerRunId || '') === providerRunId,
  );

  const ts = nowIso();
  const latency = input.latency && typeof input.latency === 'object' ? {
    totalMs: asInt(input.latency.totalMs),
    sttMs: asInt(input.latency.sttMs),
    llmMs: asInt(input.latency.llmMs),
    ttsMs: asInt(input.latency.ttsMs),
  } : { totalMs: null, sttMs: null, llmMs: null, ttsMs: null };

  const providerMetadata = {
    providerRunId,
    providerCallId: input.providerCallId != null ? String(input.providerCallId) : providerRunId,
    providerRunName: input.providerRunName ? String(input.providerRunName) : null,
    recordingUrl: input.providerRecordingUrl || null,
    rawStatus: input.rawStatus || null,
  };

  if (!existing) {
    existing = {
      id: genId('call_'),
      tenantId,
      agentId: input.agentId || null,
      phoneNumberId: input.phoneNumberId || null,
      direction: normalizeDirection(input.direction),
      fromE164: input.fromE164 || null,
      toE164: input.toE164 || null,
      status: normalizeStatus(input.status),
      startedAt: asIso(input.startedAt) || ts,
      endedAt: asIso(input.endedAt),
      durationSec: asInt(input.durationSec),
      outcome: input.outcome || null,
      summary: input.summary || null,
      extractedData: input.extractedData && typeof input.extractedData === 'object'
        ? { ...input.extractedData } : {},
      transcript: Array.isArray(input.transcript)
        ? input.transcript.map((t) => ({ ...t }))
        : (typeof input.transcript === 'string' ? input.transcript : []),
      recordingAvailable: !!input.recordingAvailable || !!input.providerRecordingUrl,
      recordingUrl: null,
      latency,
      provider: PROVIDER_ID,
      providerRunId,
      providerMetadata,
      workflowVersion: input.workflowVersion || null,
      dograhWorkflowId: input.dograhWorkflowId != null ? String(input.dograhWorkflowId) : null,
      source: input.source || 'sync',
      createdAt: ts,
      updatedAt: ts,
    };
    db.calls.push(existing);
    upsertProviderResource(db, existing);
    return { ok: true, call: existing, created: true, updated: false };
  }

  existing.agentId = input.agentId !== undefined ? (input.agentId || null) : existing.agentId;
  existing.phoneNumberId = input.phoneNumberId !== undefined ? (input.phoneNumberId || null) : existing.phoneNumberId;
  if (input.direction) existing.direction = normalizeDirection(input.direction);
  if (input.fromE164 !== undefined) existing.fromE164 = input.fromE164 || null;
  if (input.toE164 !== undefined) existing.toE164 = input.toE164 || null;
  if (input.status) existing.status = normalizeStatus(input.status);
  if (input.startedAt) existing.startedAt = asIso(input.startedAt) || existing.startedAt;
  if (input.endedAt !== undefined) existing.endedAt = asIso(input.endedAt);
  if (input.durationSec !== undefined) existing.durationSec = asInt(input.durationSec);
  if (input.outcome !== undefined) existing.outcome = input.outcome || null;
  if (input.summary !== undefined) existing.summary = input.summary || null;
  if (input.extractedData && typeof input.extractedData === 'object') {
    existing.extractedData = { ...input.extractedData };
  }
  if (input.transcript !== undefined) {
    existing.transcript = Array.isArray(input.transcript)
      ? input.transcript.map((t) => ({ ...t }))
      : (typeof input.transcript === 'string' ? input.transcript : existing.transcript);
  }
  if (input.recordingAvailable || input.providerRecordingUrl) {
    existing.recordingAvailable = true;
  }
  if (input.latency && typeof input.latency === 'object') existing.latency = latency;
  if (input.workflowVersion !== undefined) existing.workflowVersion = input.workflowVersion || null;
  if (input.dograhWorkflowId !== undefined) {
    existing.dograhWorkflowId = input.dograhWorkflowId != null ? String(input.dograhWorkflowId) : null;
  }
  existing.provider = PROVIDER_ID;
  existing.providerRunId = providerRunId;
  existing.providerMetadata = { ...(existing.providerMetadata || {}), ...providerMetadata };
  existing.updatedAt = ts;
  upsertProviderResource(db, existing);
  return { ok: true, call: existing, created: false, updated: true };
}

/**
 * Manual import path for operators when Dograh sync is stubbed.
 * Each item needs providerRunId (or id) plus optional call fields.
 */
function importCalls(db, tenantId, items) {
  ensureCalls(db);
  if (!Array.isArray(items) || !items.length) {
    return { ok: false, status: 422, code: 'validation', error: 'import must be a non-empty array' };
  }
  const results = [];
  for (const item of items) {
    const providerRunId = String(
      (item && (item.providerRunId || item.providerCallId || item.id)) || '',
    ).trim();
    if (!providerRunId) {
      results.push({ ok: false, error: 'providerRunId required' });
      continue;
    }
    const r = upsertCallFromProvider(db, tenantId, {
      ...item,
      providerRunId,
      source: 'manual_import',
    });
    results.push(r);
  }
  return {
    ok: true,
    created: results.filter((r) => r.created).length,
    updated: results.filter((r) => r.updated).length,
    results,
  };
}

/**
 * Seed 1-2 demo calls for UI testing when Dograh is unreachable.
 * Idempotent on fixed demo providerRunIds per tenant.
 */
function seedDemoCalls(db, tenantId, opts = {}) {
  ensureCalls(db);
  const agents = (db.agents || []).filter((a) => a.tenantId === tenantId);
  const agentId = opts.agentId || (agents[0] && agents[0].id) || null;
  const numbers = (db.phoneNumbers || []).filter((n) => n.tenantId === tenantId && n.status === 'assigned');
  const phoneNumberId = opts.phoneNumberId || (numbers[0] && numbers[0].id) || null;
  const did = (numbers[0] && numbers[0].e164) || '+918065353938';

  const demos = [
    {
      providerRunId: `demo_inbound_${tenantId}`,
      direction: 'inbound',
      fromE164: '+919876543210',
      toE164: did,
      status: 'completed',
      startedAt: new Date(Date.now() - 3600_000).toISOString(),
      endedAt: new Date(Date.now() - 3540_000).toISOString(),
      durationSec: 60,
      outcome: 'appointment_booked',
      summary: 'Caller asked for a site visit. Agent confirmed tomorrow 11am.',
      extractedData: {
        intent: 'book_visit',
        preferred_slot: 'tomorrow 11:00',
        caller_name: 'Demo Caller',
      },
      transcript: [
        { role: 'user', text: 'Hi, I need someone to check my AC tomorrow morning.' },
        { role: 'agent', text: 'Of course. I can book a visit for tomorrow at 11am. Does that work?' },
        { role: 'user', text: 'Yes, that works. Thank you.' },
        { role: 'agent', text: 'You are booked for tomorrow at 11am. Is there anything else?' },
      ],
      latency: { totalMs: 820, sttMs: 180, llmMs: 420, ttsMs: 220 },
      recordingAvailable: false,
      dograhWorkflowId: '8',
      workflowVersion: 'demo',
    },
    {
      providerRunId: `demo_outbound_${tenantId}`,
      direction: 'outbound',
      fromE164: did,
      toE164: '+919811122233',
      status: 'completed',
      startedAt: new Date(Date.now() - 7200_000).toISOString(),
      endedAt: new Date(Date.now() - 7120_000).toISOString(),
      durationSec: 80,
      outcome: 'callback_rescheduled',
      summary: 'Outbound permission check. Customer asked to reschedule to Friday.',
      extractedData: {
        permission: true,
        reschedule_to: 'Friday afternoon',
      },
      transcript: [
        { role: 'agent', text: 'Hello, this is Astra calling about your earlier inquiry. Is now a good time?' },
        { role: 'user', text: 'Can you call me Friday afternoon instead?' },
        { role: 'agent', text: 'Absolutely. I will note Friday afternoon for the callback.' },
      ],
      latency: { totalMs: 940, sttMs: 200, llmMs: 480, ttsMs: 260 },
      recordingAvailable: false,
      dograhWorkflowId: null,
      workflowVersion: 'demo',
    },
  ];

  let created = 0;
  let updated = 0;
  for (const demo of demos) {
    const r = upsertCallFromProvider(db, tenantId, {
      ...demo,
      agentId,
      phoneNumberId,
      source: 'demo_seed',
    });
    if (r.created) created += 1;
    if (r.updated) updated += 1;
  }
  return { created, updated, count: demos.length };
}

/**
 * Map a flexible Dograh run / call log object into upsert input.
 * Field names vary across Dograh versions, so we accept several aliases,
 * including the production shape with initial_context / usage_info /
 * gathered_context and realtime log transcript events.
 */
function mapDograhRunToCallInput(run, context = {}) {
  if (!run || typeof run !== 'object') return null;
  const providerRunId = String(
    run.id || run.run_id || run.runId || run.call_id || run.callId || '',
  ).trim();
  if (!providerRunId) return null;

  const initial = (run.initial_context && typeof run.initial_context === 'object')
    ? run.initial_context
    : {};
  const gathered = (run.gathered_context && typeof run.gathered_context === 'object')
    ? run.gathered_context
    : {};
  const usage = (run.usage_info && typeof run.usage_info === 'object')
    ? run.usage_info
    : {};

  const directionRaw = String(
    run.direction || run.call_direction || run.call_type || initial.call_type || '',
  ).toLowerCase();
  const direction = directionRaw.includes('out') ? 'outbound' : (
    directionRaw.includes('in') ? 'inbound' : (context.direction || 'outbound')
  );

  const fromE164 = run.from_number || run.fromE164 || run.from || run.caller_number
    || initial.caller_number || initial.from_number
    || (direction === 'outbound' ? context.fromE164 : null) || null;
  const toE164 = run.to_number || run.toE164 || run.to || run.callee_number
    || initial.phone_number || initial.to_number || initial.callee_number
    || (direction === 'inbound' ? context.toE164 : null) || null;

  const startedAt = run.started_at || run.startedAt || run.created_at || run.createdAt || null;
  const endedAt = run.ended_at || run.endedAt || run.completed_at || run.completedAt
    || (run.is_completed ? (run.updated_at || run.updatedAt) : null) || null;
  let durationSec = asInt(
    run.duration_sec || run.durationSec || run.duration
    || usage.call_duration_seconds || usage.duration_seconds
    || gathered.call_duration_seconds,
  );
  if (durationSec == null && startedAt && endedAt) {
    const a = Date.parse(startedAt);
    const b = Date.parse(endedAt);
    if (Number.isFinite(a) && Number.isFinite(b) && b >= a) durationSec = Math.round((b - a) / 1000);
  }

  let transcript = run.transcript || run.messages || run.conversation || null;
  if (!transcript && Array.isArray(run.logs)) {
    const turns = [];
    for (const entry of run.logs) {
      if (!entry || typeof entry !== 'object') continue;
      const role = entry.role || entry.speaker || entry.type;
      const text = entry.text || entry.content || entry.message || entry.transcript;
      if (!text) continue;
      const normalizedRole = /user|human|caller/i.test(String(role || ''))
        ? 'user'
        : (/bot|agent|assistant/i.test(String(role || '')) ? 'bot' : (role || 'unknown'));
      turns.push({
        role: normalizedRole,
        text: String(text),
        at: entry.at || entry.timestamp || entry.created_at || null,
      });
    }
    if (turns.length) transcript = turns;
  }

  const extracted = run.extracted_data || run.extractedData || run.outputs || run.result
    || gathered.extracted_data || gathered || {};
  const latencySrc = run.latency || run.metrics || {};

  const recordingUrl = run.recording_url || run.recordingUrl
    || (run.recording && (run.recording.url || run.recording.mixed || run.recording.public_url))
    || null;
  const outcome = run.outcome || run.result_status || run.disposition
    || gathered.disposition || gathered.outcome || null;
  const summary = run.summary || run.synopsis || gathered.summary || null;
  const providerCallId = run.call_id || run.callId || gathered.call_id
    || gathered.vobiz_call_id || providerRunId;

  return {
    providerRunId,
    providerCallId,
    providerRunName: run.name || run.run_name || run.runName || null,
    direction,
    fromE164: fromE164 ? String(fromE164) : null,
    toE164: toE164 ? String(toE164) : null,
    status: run.status || run.state || (run.is_completed ? 'completed' : 'completed'),
    startedAt,
    endedAt,
    durationSec,
    outcome,
    summary,
    extractedData: typeof extracted === 'object' && !Array.isArray(extracted) ? { ...extracted } : {},
    transcript: Array.isArray(transcript) ? transcript.map((t) => ({
      role: t.role || t.speaker || 'unknown',
      text: t.text || t.content || t.message || '',
      at: t.at || t.timestamp || null,
    })) : (typeof transcript === 'string' ? transcript : []),
    latency: {
      totalMs: asInt(latencySrc.total_ms || latencySrc.totalMs),
      sttMs: asInt(latencySrc.stt_ms || latencySrc.sttMs),
      llmMs: asInt(latencySrc.llm_ms || latencySrc.llmMs),
      ttsMs: asInt(latencySrc.tts_ms || latencySrc.ttsMs),
    },
    recordingAvailable: !!(recordingUrl || run.has_recording || (run.recording && Object.keys(run.recording).length)),
    providerRecordingUrl: recordingUrl,
    dograhWorkflowId: run.workflow_id || run.workflowId || context.workflowId || null,
    workflowVersion: run.workflow_version || run.workflowVersion || null,
    agentId: context.agentId || null,
    phoneNumberId: context.phoneNumberId || null,
    rawStatus: run.status || run.state || null,
    source: 'dograh_sync',
  };
}

function phoneDigitsKey(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (!digits) return '';
  return digits.length > 10 ? digits.slice(-10) : digits;
}

/**
 * Link an imported/synced Call back to a matching Instant Lead CallJob (and
 * lead) when destination phone and dial time align. Prefers failed
 * call_not_tracked jobs and active calling jobs without a resultCallId.
 * Returns { linked, job, lead } or { linked: false }.
 */
function linkCallJobToSyncedCall(db, tenantId, call, opts = {}) {
  if (!db || !tenantId || !call) return { linked: false };
  if (!Array.isArray(db.callJobs)) db.callJobs = [];
  if (!Array.isArray(db.leads)) db.leads = [];

  const wantPhone = phoneDigitsKey(call.toE164 || call.fromE164);
  if (!wantPhone) return { linked: false };

  const callStartMs = Date.parse(call.startedAt || call.createdAt || '') || Date.now();
  const windowMs = Math.max(30_000, Number(opts.windowMs) || 15 * 60_000);

  const candidates = (db.callJobs || []).filter((job) => {
    if (!job || job.tenantId !== tenantId) return false;
    if (job.resultCallId && job.resultCallId === call.id) return true;
    if (job.providerRunId && String(job.providerRunId) === String(call.providerRunId)) return true;
    if (phoneDigitsKey(job.toE164) !== wantPhone) return false;
    if (job.resultCallId && job.status === 'completed') return false;
    const dialMs = Date.parse(job.dialedAt || job.createdAt || '') || 0;
    if (!dialMs) return job.status === 'calling' || job.status === 'dialing' || job.status === 'failed';
    return Math.abs(callStartMs - dialMs) <= windowMs;
  });

  if (!candidates.length) return { linked: false };

  candidates.sort((a, b) => {
    const score = (job) => {
      let s = 0;
      if (job.providerRunId && String(job.providerRunId) === String(call.providerRunId)) s += 100;
      if (job.resultCallId === call.id) s += 90;
      if (job.status === 'failed' && /could not be tracked|call_not_tracked/i.test(String(job.lastError || ''))) s += 40;
      if (job.status === 'calling' || job.status === 'dialing') s += 30;
      if (job.status === 'failed') s += 10;
      if (job.leadId) s += 5;
      return s;
    };
    const diff = score(b) - score(a);
    if (diff) return diff;
    return String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''));
  });

  const job = candidates[0];
  const ts = nowIso();
  job.providerRunId = String(call.providerRunId || job.providerRunId || '');
  job.resultCallId = call.id;
  job.lastError = null;
  job.status = 'completed';
  job.completedAt = job.completedAt || ts;
  job.updatedAt = ts;
  if (call.providerRunName && !job.providerRunName) {
    job.providerRunName = String(call.providerRunName);
  }

  let lead = null;
  if (job.leadId) {
    lead = (db.leads || []).find((l) => l.id === job.leadId && l.tenantId === tenantId) || null;
    if (lead) {
      lead.status = lead.status === 'failed' || lead.status === 'calling' || lead.status === 'assigned'
        ? 'called'
        : lead.status;
      lead.lastCallJobId = job.id;
      lead.lastCallId = call.id;
      lead.lastError = null;
      lead.updatedAt = ts;
    }
  }

  // Attach agent/phone from the job onto the call when missing.
  if (!call.agentId && job.agentId) call.agentId = job.agentId;
  if (!call.phoneNumberId && job.phoneNumberId) call.phoneNumberId = job.phoneNumberId;
  call.updatedAt = ts;

  return { linked: true, job, lead };
}

function recordingAccess(call) {
  if (!call) return { available: false };
  const meta = call.providerMetadata || {};
  const upstream = meta.recordingUrl || null;
  const available = !!(call.recordingAvailable || upstream);
  return {
    available,
    astraPath: available ? `/api/calls/${encodeURIComponent(call.id)}/recording` : null,
    upstreamUrl: upstream,
  };
}

module.exports = {
  PROVIDER_ID,
  DOGRAH_SYNC_CANDIDATES,
  publicCall,
  listTenantCalls,
  findCall,
  findCallForTenant,
  upsertCallFromProvider,
  importCalls,
  seedDemoCalls,
  mapDograhRunToCallInput,
  linkCallJobToSyncedCall,
  recordingAccess,
  normalizeDirection,
  normalizeStatus,
};
