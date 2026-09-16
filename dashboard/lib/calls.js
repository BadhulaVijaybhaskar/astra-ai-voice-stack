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

/** Documented Dograh candidate endpoints used by sync (may 404 until confirmed). */
const DOGRAH_SYNC_CANDIDATES = Object.freeze([
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
  if (filters.direction) {
    const dir = normalizeDirection(filters.direction);
    rows = rows.filter((c) => c.direction === dir);
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
 * Field names vary across Dograh versions, so we accept several aliases.
 */
function mapDograhRunToCallInput(run, context = {}) {
  if (!run || typeof run !== 'object') return null;
  const providerRunId = String(
    run.id || run.run_id || run.runId || run.call_id || run.callId || '',
  ).trim();
  if (!providerRunId) return null;

  const directionRaw = String(run.direction || run.call_direction || '').toLowerCase();
  const direction = directionRaw.includes('out') ? 'outbound' : 'inbound';

  const fromE164 = run.from_number || run.fromE164 || run.from || run.caller_number
    || (direction === 'outbound' ? context.fromE164 : null) || null;
  const toE164 = run.to_number || run.toE164 || run.to || run.callee_number
    || (direction === 'inbound' ? context.toE164 : null) || null;

  const startedAt = run.started_at || run.startedAt || run.created_at || run.createdAt || null;
  const endedAt = run.ended_at || run.endedAt || run.completed_at || run.completedAt || null;
  let durationSec = asInt(run.duration_sec || run.durationSec || run.duration);
  if (durationSec == null && startedAt && endedAt) {
    const a = Date.parse(startedAt);
    const b = Date.parse(endedAt);
    if (Number.isFinite(a) && Number.isFinite(b) && b >= a) durationSec = Math.round((b - a) / 1000);
  }

  const transcript = run.transcript || run.messages || run.conversation || [];
  const extracted = run.extracted_data || run.extractedData || run.outputs || run.result || {};
  const latencySrc = run.latency || run.metrics || {};

  return {
    providerRunId,
    providerCallId: run.call_id || run.callId || providerRunId,
    direction,
    fromE164: fromE164 ? String(fromE164) : null,
    toE164: toE164 ? String(toE164) : null,
    status: run.status || run.state || 'completed',
    startedAt,
    endedAt,
    durationSec,
    outcome: run.outcome || run.result_status || null,
    summary: run.summary || run.synopsis || null,
    extractedData: typeof extracted === 'object' && !Array.isArray(extracted) ? extracted : {},
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
    recordingAvailable: !!(run.recording_url || run.recordingUrl || run.has_recording),
    providerRecordingUrl: run.recording_url || run.recordingUrl || null,
    dograhWorkflowId: run.workflow_id || run.workflowId || context.workflowId || null,
    workflowVersion: run.workflow_version || run.workflowVersion || null,
    agentId: context.agentId || null,
    phoneNumberId: context.phoneNumberId || null,
    rawStatus: run.status || null,
    source: 'dograh_sync',
  };
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
  recordingAccess,
  normalizeDirection,
  normalizeStatus,
};
