/**
 * Astra AI. Outbound campaigns with Excel/CSV upload, column mapping, and
 * guarded enqueue through the same CallJob + createOutboundCall path as
 * Instant Leads. No separate calling engine.
 *
 * Customer JSON never includes Dograh / VoBiz / provider ids.
 * No em dashes anywhere. Commas and periods only.
 */
'use strict';

const crypto = require('crypto');
const sheetParse = require('./sheet-parse');
const leadsLib = require('./leads');

const STATUSES = new Set(['draft', 'ready', 'scheduled', 'running', 'paused', 'done', 'cancelled']);
const LEAD_ROW_STATUSES = new Set([
  'pending', 'ready', 'invalid', 'duplicate', 'queued', 'scheduled',
  'calling', 'connected', 'completed', 'no_answer', 'failed',
  'retry_scheduled', 'cancelled', 'dialed', 'stub_queued',
]);
const DEFAULT_RATE_PER_MIN = 10;
const DEFAULT_CONCURRENCY = 2;
const DEFAULT_RETRY_MAX = 0;

const STANDARD_FIELDS = Object.freeze([
  Object.freeze({ key: 'phone_number', label: 'Phone number', required: true }),
  Object.freeze({ key: 'name', label: 'Name', required: false }),
  Object.freeze({ key: 'company', label: 'Company', required: false }),
  Object.freeze({ key: 'email', label: 'Email', required: false }),
  Object.freeze({ key: 'language', label: 'Language', required: false }),
  Object.freeze({ key: 'city', label: 'City', required: false }),
  Object.freeze({ key: 'lead_source', label: 'Lead source', required: false }),
  Object.freeze({ key: 'notes', label: 'Notes', required: false }),
]);

function genId(prefix) {
  return prefix + crypto.randomBytes(8).toString('hex');
}

function nowIso() {
  return new Date().toISOString();
}

function normalizePhone(value) {
  // Fail closed: return '' when unusable. Never invent a dialable number.
  const e164 = leadsLib.normalizePhoneIN(value);
  if (!e164 || !leadsLib.isValidE164(e164)) return '';
  // Reject all-zero / obviously fake national bodies (demo safety).
  const national = e164.replace(/^\+91/, '');
  if (/^0+$/.test(national) || /^(\d)\1+$/.test(national)) return '';
  return e164;
}

function guessMapping(headers) {
  const map = {};
  const used = new Set();
  const norms = (headers || []).map((h) => ({
    raw: h,
    n: String(h || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_'),
  }));
  const aliases = {
    phone_number: ['phone_number', 'phone', 'mobile', 'msisdn', 'number', 'contact_number', 'to', 'e164'],
    name: ['name', 'full_name', 'lead_name', 'contact_name', 'customer'],
    company: ['company', 'organization', 'org', 'account'],
    email: ['email', 'email_address', 'mail'],
    language: ['language', 'lang', 'locale'],
    city: ['city', 'town', 'location'],
    lead_source: ['lead_source', 'source', 'utm_source', 'channel'],
    notes: ['notes', 'note', 'comment', 'remarks'],
  };
  for (const field of STANDARD_FIELDS) {
    const list = aliases[field.key] || [field.key];
    const hit = norms.find((h) => list.includes(h.n) && !used.has(h.raw));
    if (hit) {
      map[field.key] = hit.raw;
      used.add(hit.raw);
    }
  }
  return map;
}

function countLeads(db, campaignId) {
  const leads = (db.campaignLeads || []).filter((l) => l.campaignId === campaignId);
  const counts = {
    total: leads.length,
    ready: 0,
    invalid: 0,
    duplicates: 0,
    queued: 0,
    dialed: 0,
    completed: 0,
    failed: 0,
    pending: 0,
  };
  for (const l of leads) {
    const s = l.status || 'pending';
    if (s === 'ready') counts.ready += 1;
    else if (s === 'invalid') counts.invalid += 1;
    else if (s === 'duplicate') counts.duplicates += 1;
    else if (s === 'pending') counts.pending += 1;
    else if (s === 'queued' || s === 'scheduled' || s === 'retry_scheduled') counts.queued += 1;
    else if (s === 'calling' || s === 'connected' || s === 'dialed' || s === 'stub_queued') counts.dialed += 1;
    else if (s === 'completed' || s === 'no_answer') counts.completed += 1;
    else if (s === 'failed' || s === 'cancelled') counts.failed += 1;
  }
  return counts;
}

function publicCampaign(row, leadCounts) {
  const c = row || {};
  const counts = leadCounts || {};
  return {
    id: c.id,
    name: c.name,
    status: c.status || 'draft',
    employeeId: c.employeeId || null,
    agentId: c.agentId || null,
    phoneNumberId: c.phoneNumberId || null,
    language: c.language || null,
    concurrency: c.concurrency || c.ratePerMinute || DEFAULT_CONCURRENCY,
    ratePerMinute: c.ratePerMinute || c.concurrency || DEFAULT_RATE_PER_MIN,
    retryMax: c.retryMax != null ? c.retryMax : DEFAULT_RETRY_MAX,
    scheduledAt: c.scheduledAt || null,
    mode: c.mode || 'now',
    leadCount: counts.total != null ? counts.total : (c.leadCount || 0),
    readyCount: counts.ready || 0,
    invalidCount: counts.invalid || 0,
    duplicateCount: counts.duplicates || 0,
    queuedCount: counts.queued || 0,
    dialedCount: counts.dialed || 0,
    completedCount: counts.completed || 0,
    failedCount: counts.failed || 0,
    upload: c.upload ? {
      filename: c.upload.filename || null,
      format: c.upload.format || null,
      headers: Array.isArray(c.upload.headers) ? c.upload.headers.slice() : [],
      rowCount: Array.isArray(c.upload.rows) ? c.upload.rows.length : 0,
      mapping: c.upload.mapping && typeof c.upload.mapping === 'object' ? { ...c.upload.mapping } : null,
      mappedAt: c.upload.mappedAt || null,
    } : null,
    validation: c.validation && typeof c.validation === 'object' ? { ...c.validation } : null,
    confirmRequired: true,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    startedAt: c.startedAt || null,
    completedAt: c.completedAt || null,
  };
}

function publicLead(row) {
  const l = row || {};
  return {
    id: l.id,
    campaignId: l.campaignId,
    leadId: l.leadId || null,
    phone: l.phone,
    name: l.name || '',
    meta: l.meta && typeof l.meta === 'object' ? { ...l.meta } : {},
    status: l.status || 'pending',
    lastError: l.lastError || null,
    lastCallJobId: l.lastCallJobId || null,
    lastCallId: l.lastCallId || null,
    outcomeKey: l.outcomeKey || null,
    dialedAt: l.dialedAt || null,
    createdAt: l.createdAt,
  };
}

function listCampaigns(db, tenantId) {
  return (db.campaigns || [])
    .filter((c) => c.tenantId === tenantId)
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
    .map((c) => publicCampaign(c, countLeads(db, c.id)));
}

function findCampaign(db, tenantId, id) {
  return (db.campaigns || []).find((c) => c.id === id && c.tenantId === tenantId) || null;
}

function createCampaign(db, tenantId, input, actorUserId) {
  const b = input && typeof input === 'object' ? input : {};
  const name = String(b.name || '').trim().slice(0, 120);
  if (!name) return { ok: false, status: 422, error: 'name required', code: 'bad_name' };

  let employeeId = b.employeeId ? String(b.employeeId) : null;
  let agentId = b.agentId ? String(b.agentId) : null;
  let phoneNumberId = b.phoneNumberId ? String(b.phoneNumberId) : null;
  if (employeeId) {
    const emp = (db.employees || []).find((e) => e.id === employeeId && e.tenantId === tenantId);
    if (!emp) return { ok: false, status: 404, error: 'employee not found', code: 'employee_not_found' };
    if (!agentId) agentId = emp.agentId || null;
    if (!phoneNumberId) phoneNumberId = emp.phoneNumberId || null;
  }
  if (agentId) {
    const agent = (db.agents || []).find((a) => a.id === agentId && a.tenantId === tenantId);
    if (!agent) return { ok: false, status: 404, error: 'agent not found', code: 'agent_not_found' };
  }
  if (phoneNumberId) {
    const num = (db.phoneNumbers || []).find((n) => n.id === phoneNumberId && n.tenantId === tenantId);
    if (!num) return { ok: false, status: 404, error: 'phone number not found', code: 'phone_number_not_found' };
  }

  const concurrency = Math.max(1, Math.min(20, Number(b.concurrency != null ? b.concurrency : b.ratePerMinute) || DEFAULT_CONCURRENCY));
  const retryMax = Math.max(0, Math.min(5, Number(b.retryMax) || DEFAULT_RETRY_MAX));
  const language = b.language ? String(b.language).trim().slice(0, 16) : null;
  const mode = String(b.mode || 'now').toLowerCase() === 'schedule' ? 'schedule' : 'now';
  let scheduledAt = null;
  if (mode === 'schedule') {
    const raw = String(b.scheduledAt || '').trim();
    if (!raw || Number.isNaN(Date.parse(raw))) {
      return { ok: false, status: 422, error: 'scheduledAt must be a valid ISO time', code: 'bad_schedule' };
    }
    scheduledAt = new Date(raw).toISOString();
  }

  if (!Array.isArray(db.campaigns)) db.campaigns = [];
  const ts = nowIso();
  const row = {
    id: genId('cmp_'),
    tenantId,
    name,
    status: mode === 'schedule' ? 'draft' : 'draft',
    employeeId,
    agentId,
    phoneNumberId,
    language,
    concurrency,
    ratePerMinute: concurrency,
    retryMax,
    mode,
    scheduledAt,
    upload: null,
    validation: null,
    createdBy: actorUserId || null,
    createdAt: ts,
    updatedAt: ts,
    startedAt: null,
    completedAt: null,
  };
  db.campaigns.push(row);
  return { ok: true, campaign: row };
}

function updateCampaignSettings(db, tenantId, campaignId, input) {
  const campaign = findCampaign(db, tenantId, campaignId);
  if (!campaign) return { ok: false, status: 404, error: 'campaign not found', code: 'not_found' };
  if (campaign.status === 'done' || campaign.status === 'cancelled') {
    return { ok: false, status: 409, error: 'campaign is closed', code: 'campaign_closed' };
  }
  const b = input && typeof input === 'object' ? input : {};
  if (b.name != null) {
    const name = String(b.name).trim().slice(0, 120);
    if (!name) return { ok: false, status: 422, error: 'name required', code: 'bad_name' };
    campaign.name = name;
  }
  if (b.employeeId !== undefined) {
    const set = setCampaignEmployee(db, tenantId, campaignId, b.employeeId || null);
    if (!set.ok) return set;
  }
  if (b.phoneNumberId !== undefined) {
    const pid = b.phoneNumberId ? String(b.phoneNumberId) : null;
    if (pid) {
      const num = (db.phoneNumbers || []).find((n) => n.id === pid && n.tenantId === tenantId);
      if (!num) return { ok: false, status: 404, error: 'phone number not found', code: 'phone_number_not_found' };
    }
    campaign.phoneNumberId = pid;
  }
  if (b.language !== undefined) {
    campaign.language = b.language ? String(b.language).trim().slice(0, 16) : null;
  }
  if (b.concurrency != null || b.ratePerMinute != null) {
    const concurrency = Math.max(1, Math.min(20, Number(b.concurrency != null ? b.concurrency : b.ratePerMinute) || DEFAULT_CONCURRENCY));
    campaign.concurrency = concurrency;
    campaign.ratePerMinute = concurrency;
  }
  if (b.retryMax != null) {
    campaign.retryMax = Math.max(0, Math.min(5, Number(b.retryMax) || 0));
  }
  if (b.mode != null) {
    campaign.mode = String(b.mode).toLowerCase() === 'schedule' ? 'schedule' : 'now';
  }
  if (b.scheduledAt !== undefined) {
    if (!b.scheduledAt) {
      campaign.scheduledAt = null;
    } else {
      const raw = String(b.scheduledAt).trim();
      if (Number.isNaN(Date.parse(raw))) {
        return { ok: false, status: 422, error: 'scheduledAt must be a valid ISO time', code: 'bad_schedule' };
      }
      campaign.scheduledAt = new Date(raw).toISOString();
    }
  }
  campaign.updatedAt = nowIso();
  return { ok: true, campaign };
}

function setCampaignEmployee(db, tenantId, campaignId, employeeId) {
  const campaign = findCampaign(db, tenantId, campaignId);
  if (!campaign) return { ok: false, status: 404, error: 'campaign not found', code: 'not_found' };
  if (employeeId) {
    const emp = (db.employees || []).find((e) => e.id === String(employeeId) && e.tenantId === tenantId);
    if (!emp) return { ok: false, status: 404, error: 'employee not found', code: 'employee_not_found' };
    campaign.employeeId = emp.id;
    campaign.agentId = emp.agentId || campaign.agentId || null;
    if (!campaign.phoneNumberId && emp.phoneNumberId) campaign.phoneNumberId = emp.phoneNumberId;
  } else {
    campaign.employeeId = null;
  }
  campaign.updatedAt = nowIso();
  return { ok: true, campaign };
}

function parseLeadLines(textOrList) {
  if (Array.isArray(textOrList)) {
    return textOrList.map((row) => ({
      phone: normalizePhone(row.phone || row.phone_number || row.number || ''),
      name: String(row.name || '').trim().slice(0, 120),
      meta: row.meta && typeof row.meta === 'object' ? row.meta : {},
    }));
  }
  return String(textOrList || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split(/[,\t]/).map((p) => p.trim());
      return {
        phone: normalizePhone(parts[0] || ''),
        name: (parts[1] || '').slice(0, 120),
        meta: parts[2] ? { note: parts.slice(2).join(', ').slice(0, 200) } : {},
      };
    });
}

function addLeads(db, tenantId, campaignId, textOrList) {
  const campaign = findCampaign(db, tenantId, campaignId);
  if (!campaign) return { ok: false, status: 404, error: 'campaign not found', code: 'not_found' };
  if (campaign.status === 'done' || campaign.status === 'cancelled') {
    return { ok: false, status: 409, error: 'cannot add leads to a completed campaign', code: 'campaign_done' };
  }
  if (!Array.isArray(db.campaignLeads)) db.campaignLeads = [];
  const parsed = parseLeadLines(textOrList);
  const added = [];
  const skipped = [];
  const ts = nowIso();
  for (const lead of parsed) {
    if (!leadsLib.isValidE164(lead.phone)) {
      skipped.push({ phone: lead.phone, reason: 'bad_phone' });
      continue;
    }
    const dup = db.campaignLeads.some((l) => l.campaignId === campaignId && l.phone === lead.phone);
    if (dup) {
      skipped.push({ phone: lead.phone, reason: 'duplicate' });
      continue;
    }
    const row = {
      id: genId('cld_'),
      tenantId,
      campaignId,
      leadId: null,
      phone: lead.phone,
      name: lead.name,
      meta: lead.meta,
      status: 'ready',
      lastError: null,
      lastCallJobId: null,
      lastCallId: null,
      outcomeKey: null,
      dialedAt: null,
      createdAt: ts,
    };
    db.campaignLeads.push(row);
    added.push(row);
  }
  campaign.updatedAt = ts;
  return { ok: true, added: added.length, skipped, leads: added.map(publicLead) };
}

function storeUpload(db, tenantId, campaignId, { filename, contentBase64, text } = {}) {
  const campaign = findCampaign(db, tenantId, campaignId);
  if (!campaign) return { ok: false, status: 404, error: 'campaign not found', code: 'not_found' };
  if (campaign.status === 'running') {
    return { ok: false, status: 409, error: 'cannot replace upload while campaign is running', code: 'campaign_running' };
  }
  const name = String(filename || 'leads.csv');
  let parsed;
  try {
    if (contentBase64) {
      const buf = Buffer.from(String(contentBase64), 'base64');
      parsed = sheetParse.parseUpload(buf, name);
    } else {
      parsed = sheetParse.parseUpload(String(text || ''), name.endsWith('.xlsx') ? name.replace(/\.xlsx$/i, '.csv') : name);
    }
  } catch (e) {
    return { ok: false, status: 422, error: String((e && e.message) || e).slice(0, 200), code: 'bad_upload' };
  }
  if (!parsed.headers.length) {
    return { ok: false, status: 422, error: 'upload has no header row', code: 'empty_upload' };
  }
  if (!parsed.rows.length) {
    return { ok: false, status: 422, error: 'upload has no data rows', code: 'empty_upload' };
  }
  if (parsed.rows.length > 5000) {
    return { ok: false, status: 422, error: 'upload exceeds 5000 rows', code: 'too_many_rows' };
  }
  campaign.upload = {
    filename: name.slice(0, 180),
    format: parsed.format || 'csv',
    headers: parsed.headers.slice(0, 80),
    rows: parsed.rows.slice(0, 5000),
    mapping: guessMapping(parsed.headers),
    mappedAt: null,
  };
  campaign.validation = null;
  campaign.updatedAt = nowIso();
  return {
    ok: true,
    campaign: publicCampaign(campaign, countLeads(db, campaign.id)),
    fields: STANDARD_FIELDS.map((f) => ({ ...f })),
    suggestedMapping: { ...campaign.upload.mapping },
  };
}

function applyColumnMap(db, tenantId, campaignId, mappingInput) {
  const campaign = findCampaign(db, tenantId, campaignId);
  if (!campaign) return { ok: false, status: 404, error: 'campaign not found', code: 'not_found' };
  if (!campaign.upload || !Array.isArray(campaign.upload.rows)) {
    return { ok: false, status: 422, error: 'upload a CSV or Excel file first', code: 'no_upload' };
  }
  const mapping = mappingInput && typeof mappingInput === 'object' ? mappingInput : (campaign.upload.mapping || {});
  const phoneCol = mapping.phone_number || mapping.phone;
  if (!phoneCol) {
    return { ok: false, status: 422, error: 'map phone_number to a column', code: 'phone_column_required' };
  }
  if (!campaign.upload.headers.includes(phoneCol)) {
    return { ok: false, status: 422, error: 'phone_number column not in upload headers', code: 'bad_mapping' };
  }

  if (!Array.isArray(db.campaignLeads)) db.campaignLeads = [];
  // Replace prior mapped rows for this campaign (keep dial history only if already dialed).
  db.campaignLeads = db.campaignLeads.filter((l) => !(
    l.campaignId === campaignId
    && l.tenantId === tenantId
    && ['pending', 'ready', 'invalid', 'duplicate'].includes(l.status || '')
  ));

  const seen = new Set();
  const ts = nowIso();
  let ready = 0;
  let invalid = 0;
  let duplicates = 0;
  const preview = [];

  for (const raw of campaign.upload.rows) {
    const phoneRaw = raw[phoneCol];
    const phone = normalizePhone(phoneRaw);
    const name = mapping.name && raw[mapping.name] != null ? String(raw[mapping.name]).trim().slice(0, 120) : '';
    const meta = {};
    for (const field of STANDARD_FIELDS) {
      if (field.key === 'phone_number' || field.key === 'name') continue;
      const col = mapping[field.key];
      if (col && raw[col] != null && String(raw[col]).trim()) {
        meta[field.key] = String(raw[col]).trim().slice(0, 240);
      }
    }
    // Preserve unmapped original columns under meta.original (capped).
    const original = {};
    for (const h of campaign.upload.headers) {
      const mappedKeys = Object.values(mapping);
      if (mappedKeys.includes(h)) continue;
      if (raw[h] != null && String(raw[h]).trim()) original[h] = String(raw[h]).trim().slice(0, 200);
    }
    if (Object.keys(original).length) meta.original = original;

    let status = 'ready';
    let lastError = null;
    if (!leadsLib.isValidE164(phone)) {
      status = 'invalid';
      lastError = 'malformed phone';
      invalid += 1;
    } else if (seen.has(phone) || db.campaignLeads.some((l) => l.campaignId === campaignId && l.phone === phone)) {
      status = 'duplicate';
      lastError = 'duplicate phone in campaign';
      duplicates += 1;
    } else {
      seen.add(phone);
      ready += 1;
    }

    const row = {
      id: genId('cld_'),
      tenantId,
      campaignId,
      leadId: null,
      phone: phone || String(phoneRaw || '').slice(0, 32),
      name,
      meta,
      status,
      lastError,
      lastCallJobId: null,
      lastCallId: null,
      outcomeKey: null,
      dialedAt: null,
      createdAt: ts,
    };
    db.campaignLeads.push(row);
    if (preview.length < 8) preview.push(publicLead(row));
  }

  campaign.upload.mapping = { ...mapping, phone_number: phoneCol };
  campaign.upload.mappedAt = ts;
  campaign.validation = {
    ready,
    invalid,
    duplicates,
    total: ready + invalid + duplicates,
    checkedAt: ts,
  };
  campaign.status = ready > 0 ? 'ready' : 'draft';
  campaign.updatedAt = ts;
  return {
    ok: true,
    campaign: publicCampaign(campaign, countLeads(db, campaign.id)),
    counts: { ready, invalid, duplicates, total: ready + invalid + duplicates },
    preview,
  };
}

function validateLaunch(db, tenantId, campaignId, opts = {}) {
  const campaign = findCampaign(db, tenantId, campaignId);
  if (!campaign) return { ok: false, status: 404, error: 'campaign not found', code: 'not_found' };

  const checks = [];
  const fail = (code, message) => {
    checks.push({ code, ok: false, message });
  };
  const pass = (code, message) => {
    checks.push({ code, ok: true, message });
  };

  if (!campaign.employeeId && !campaign.agentId) {
    fail('employee_required', 'Select an AI Employee');
  } else if (campaign.employeeId) {
    const emp = (db.employees || []).find((e) => e.id === campaign.employeeId && e.tenantId === tenantId);
    if (!emp) fail('employee_required', 'Employee not found in this workspace');
    else if (emp.status === 'ARCHIVED') fail('employee_archived', 'Employee is archived');
    else {
      pass('employee_selected', 'Employee selected');
      const agent = emp.agentId
        ? (db.agents || []).find((a) => a.id === emp.agentId && a.tenantId === tenantId)
        : null;
      const brief = (emp.instructions && (emp.instructions.brief || emp.instructions.greeting || emp.instructions.text))
        || (agent && (agent.greeting || agent.persona))
        || emp.greeting
        || emp.description
        || '';
      const hasWorkflow = !!emp.workflowId;
      if (!String(brief).trim() && !hasWorkflow) {
        fail('instructions_required', 'Add Instructions or a Workflow before launch');
      } else {
        pass('instructions_ready', 'Instructions / Workflow ready');
      }
    }
  } else {
    pass('employee_selected', 'Outbound agent selected');
    pass('instructions_ready', 'Agent path ready');
  }

  let phoneNumberId = campaign.phoneNumberId || null;
  if (!phoneNumberId && campaign.employeeId) {
    const emp = (db.employees || []).find((e) => e.id === campaign.employeeId && e.tenantId === tenantId);
    if (emp) phoneNumberId = emp.phoneNumberId || null;
  }
  if (!phoneNumberId) {
    const assigned = (db.phoneNumbers || []).find((n) =>
      n.tenantId === tenantId && n.status === 'assigned' && n.outboundEnabled !== false);
    if (assigned) phoneNumberId = assigned.id;
  }
  if (!phoneNumberId) fail('phone_required', 'Assign a Phone Number before launch');
  else {
    const num = (db.phoneNumbers || []).find((n) => n.id === phoneNumberId && n.tenantId === tenantId);
    if (!num || num.status !== 'assigned') fail('phone_required', 'Phone Number is not assigned');
    else pass('phone_assigned', 'Calling number assigned');
  }

  const counts = countLeads(db, campaignId);
  if (counts.ready <= 0) fail('no_valid_leads', 'Valid lead count must be greater than 0');
  else pass('valid_leads', counts.ready + ' READY lead(s)');

  if (opts.providerAvailable === false) fail('provider_unavailable', 'Telephony runtime is not available');
  else pass('provider_available', 'Telephony runtime ready');

  const activeDup = (db.campaigns || []).find((c) =>
    c.tenantId === tenantId
    && c.id !== campaignId
    && c.employeeId
    && campaign.employeeId
    && c.employeeId === campaign.employeeId
    && (c.status === 'running' || c.status === 'scheduled'));
  if (activeDup) fail('duplicate_active_campaign', 'Another active campaign uses this Employee');
  else pass('no_duplicate_active', 'No duplicate active campaign');

  pass('tenant_owned', 'Campaign belongs to this workspace');

  const ok = checks.every((c) => c.ok);
  campaign.validation = {
    ...(campaign.validation || {}),
    ready: counts.ready,
    invalid: counts.invalid,
    duplicates: counts.duplicates,
    total: counts.total,
    launchOk: ok,
    checks,
    checkedAt: nowIso(),
  };
  campaign.updatedAt = nowIso();
  if (ok && (campaign.status === 'draft' || campaign.status === 'ready')) {
    campaign.status = campaign.mode === 'schedule' && campaign.scheduledAt ? 'ready' : 'ready';
  }
  return {
    ok,
    status: ok ? 200 : 422,
    code: ok ? 'ready' : 'validation_failed',
    error: ok ? undefined : 'Campaign is not ready to launch',
    campaign: publicCampaign(campaign, counts),
    counts: {
      ready: counts.ready,
      invalid: counts.invalid,
      duplicates: counts.duplicates,
      total: counts.total,
    },
    checks,
  };
}

function setCampaignStatus(db, tenantId, campaignId, status) {
  if (!STATUSES.has(status)) {
    return { ok: false, status: 422, error: 'invalid campaign status', code: 'bad_status' };
  }
  const campaign = findCampaign(db, tenantId, campaignId);
  if (!campaign) return { ok: false, status: 404, error: 'campaign not found', code: 'not_found' };
  campaign.status = status;
  campaign.updatedAt = nowIso();
  if (status === 'running' && !campaign.startedAt) campaign.startedAt = campaign.updatedAt;
  if (status === 'done' || status === 'cancelled') campaign.completedAt = campaign.updatedAt;
  return { ok: true, campaign };
}

/**
 * Guarded enqueue. Requires confirm:true. Marks up to concurrency READY leads
 * as stub_queued for the shared placeOutboundCallJob dialer. Never mass-dials
 * without confirm.
 */
function enqueueCampaign(db, tenantId, campaignId, { confirm, dialFn, limit } = {}) {
  if (confirm !== true) {
    return { ok: false, status: 400, error: 'confirm:true required to enqueue dials', code: 'needs_confirm' };
  }
  const campaign = findCampaign(db, tenantId, campaignId);
  if (!campaign) return { ok: false, status: 404, error: 'campaign not found', code: 'not_found' };
  if (campaign.status === 'paused' || campaign.status === 'cancelled' || campaign.status === 'done') {
    return { ok: false, status: 409, error: 'campaign cannot enqueue in status ' + campaign.status, code: 'bad_status' };
  }
  if (campaign.mode === 'schedule' && campaign.scheduledAt) {
    const when = Date.parse(campaign.scheduledAt);
    if (Number.isFinite(when) && when > Date.now() && !dialFn) {
      campaign.status = 'scheduled';
      campaign.updatedAt = nowIso();
      // Mark ready leads as scheduled without dialing yet.
      const ready = (db.campaignLeads || []).filter((l) =>
        l.campaignId === campaignId && l.tenantId === tenantId && l.status === 'ready');
      for (const lead of ready) lead.status = 'scheduled';
      return {
        ok: true,
        enqueued: 0,
        scheduled: ready.length,
        ratePerMinute: campaign.concurrency || campaign.ratePerMinute || DEFAULT_CONCURRENCY,
        results: ready.map((l) => ({ id: l.id, status: 'scheduled' })),
        campaign: publicCampaign(campaign, countLeads(db, campaign.id)),
      };
    }
  }

  if (campaign.status === 'draft' || campaign.status === 'ready' || campaign.status === 'scheduled') {
    campaign.status = 'running';
    campaign.startedAt = campaign.startedAt || nowIso();
  }

  const rate = Math.max(1, Math.min(20, Number(limit) || campaign.concurrency || campaign.ratePerMinute || DEFAULT_CONCURRENCY));
  const pending = (db.campaignLeads || [])
    .filter((l) => l.campaignId === campaignId && l.tenantId === tenantId
      && (l.status === 'ready' || l.status === 'pending' || l.status === 'scheduled' || l.status === 'retry_scheduled'))
    .slice(0, rate);
  const results = [];
  for (const lead of pending) {
    if (typeof dialFn === 'function') {
      try {
        dialFn(lead.phone, campaign);
        lead.status = 'dialed';
        lead.dialedAt = nowIso();
        lead.lastError = null;
        results.push({ id: lead.id, status: 'dialed' });
      } catch (e) {
        lead.status = 'failed';
        lead.lastError = String(e.message || e).slice(0, 200);
        results.push({ id: lead.id, status: 'failed', error: lead.lastError });
      }
    } else {
      lead.status = 'stub_queued';
      lead.dialedAt = nowIso();
      results.push({ id: lead.id, status: 'stub_queued' });
    }
  }
  campaign.updatedAt = nowIso();
  const remaining = (db.campaignLeads || []).filter((l) =>
    l.campaignId === campaignId
    && (l.status === 'ready' || l.status === 'pending' || l.status === 'scheduled' || l.status === 'retry_scheduled')).length;
  if (!remaining && pending.length) {
    campaign.status = 'done';
    campaign.completedAt = campaign.updatedAt;
  }
  return {
    ok: true,
    enqueued: results.length,
    ratePerMinute: rate,
    results,
    campaign: publicCampaign(campaign, countLeads(db, campaign.id)),
  };
}

function listLeads(db, tenantId, campaignId) {
  const campaign = findCampaign(db, tenantId, campaignId);
  if (!campaign) return { ok: false, status: 404, error: 'campaign not found', code: 'not_found' };
  const leads = (db.campaignLeads || [])
    .filter((l) => l.campaignId === campaignId && l.tenantId === tenantId)
    .map(publicLead);
  return { ok: true, leads, campaign: publicCampaign(campaign, countLeads(db, campaignId)) };
}

function campaignAnalytics(db, tenantId, campaignId) {
  const campaign = findCampaign(db, tenantId, campaignId);
  if (!campaign) return { ok: false, status: 404, error: 'campaign not found', code: 'not_found' };
  const cLeads = (db.campaignLeads || []).filter((l) => l.campaignId === campaignId && l.tenantId === tenantId);
  const leadIds = new Set(cLeads.map((l) => l.leadId).filter(Boolean));
  const cLeadIds = new Set(cLeads.map((l) => l.id));
  const jobs = (db.callJobs || []).filter((j) =>
    j.tenantId === tenantId
    && (cLeadIds.has(j.campaignLeadId) || (j.leadId && leadIds.has(j.leadId)) || (j.source === 'campaign' && cLeadIds.has(j.campaignLeadId))));
  const callIds = new Set(jobs.map((j) => j.resultCallId).filter(Boolean).concat(cLeads.map((l) => l.lastCallId).filter(Boolean)));
  const calls = (db.calls || []).filter((c) => c.tenantId === tenantId && callIds.has(c.id));
  const byLeadStatus = {};
  const byJobStatus = {};
  const byOutcome = {};
  for (const l of cLeads) byLeadStatus[l.status || 'pending'] = (byLeadStatus[l.status || 'pending'] || 0) + 1;
  for (const j of jobs) byJobStatus[j.status || 'queued'] = (byJobStatus[j.status || 'queued'] || 0) + 1;
  for (const c of calls) byOutcome[c.outcome || 'unspecified'] = (byOutcome[c.outcome || 'unspecified'] || 0) + 1;
  return {
    ok: true,
    campaign: publicCampaign(campaign, countLeads(db, campaignId)),
    analytics: {
      leads: cLeads.length,
      callJobs: jobs.length,
      calls: calls.length,
      byLeadStatus,
      byJobStatus,
      byOutcome,
      // Honest empties only. Never invent conversion.
      connected: calls.filter((c) => /completed|connected|answered/i.test(String(c.status || ''))).length,
      generatedAt: nowIso(),
    },
  };
}

function exportCampaignRows(db, tenantId, campaignId) {
  const list = listLeads(db, tenantId, campaignId);
  if (!list.ok) return list;
  const jobsByLead = new Map();
  for (const j of (db.callJobs || []).filter((x) => x.tenantId === tenantId)) {
    if (j.campaignLeadId) jobsByLead.set(j.campaignLeadId, j);
  }
  const callsById = new Map((db.calls || []).filter((c) => c.tenantId === tenantId).map((c) => [c.id, c]));
  const headers = [
    'phone_number', 'name', 'company', 'email', 'language', 'city', 'lead_source', 'notes',
    'status', 'outcome', 'last_error', 'call_job_id', 'conversation_id', 'dialed_at',
  ];
  const extraHeaders = new Set();
  const rows = list.leads.map((l) => {
    const job = jobsByLead.get(l.id);
    const call = (l.lastCallId && callsById.get(l.lastCallId))
      || (job && job.resultCallId && callsById.get(job.resultCallId))
      || null;
    const meta = l.meta || {};
    const row = {
      phone_number: l.phone,
      name: l.name || '',
      company: meta.company || '',
      email: meta.email || '',
      language: meta.language || '',
      city: meta.city || '',
      lead_source: meta.lead_source || '',
      notes: meta.notes || '',
      status: l.status || '',
      outcome: l.outcomeKey || (call && call.outcome) || '',
      last_error: l.lastError || '',
      call_job_id: l.lastCallJobId || (job && job.id) || '',
      conversation_id: l.lastCallId || (call && call.id) || '',
      dialed_at: l.dialedAt || '',
    };
    if (meta.original && typeof meta.original === 'object') {
      for (const [k, v] of Object.entries(meta.original)) {
        const key = 'original_' + String(k).replace(/[^a-zA-Z0-9_]+/g, '_').slice(0, 40);
        row[key] = v;
        extraHeaders.add(key);
      }
    }
    return row;
  });
  const allHeaders = headers.concat([...extraHeaders]);
  return {
    ok: true,
    headers: allHeaders,
    rows,
    csv: sheetParse.toCsv(allHeaders, rows),
    campaign: list.campaign,
  };
}

function sampleLeadRows() {
  return [
    {
      phone_number: '+918065353938',
      name: 'Authorized Test DID',
      company: 'Astra Demo',
      email: 'demo@astra.local',
      language: 'en-IN',
      city: 'Hyderabad',
      lead_source: 'demo',
      notes: 'AUTHORIZED_TEST_DID_ONLY',
    },
    {
      phone_number: '0000000000',
      name: 'Invalid Zero',
      company: 'Demo Co',
      email: '',
      language: 'en-IN',
      city: 'Demo',
      lead_source: 'demo',
      notes: 'NON_DIALABLE',
    },
    {
      phone_number: '91',
      name: 'Short Bad',
      company: 'Demo Co',
      email: '',
      language: 'hi-IN',
      city: 'Demo',
      lead_source: 'demo',
      notes: 'NON_DIALABLE',
    },
    {
      phone_number: 'NOT_A_PHONE',
      name: 'Placeholder One',
      company: 'Demo Co',
      email: 'one@example.invalid',
      language: 'te-IN',
      city: 'Demo City',
      lead_source: 'demo',
      notes: 'NON_DIALABLE_PLACEHOLDER',
    },
    {
      phone_number: '+91000',
      name: 'Placeholder Two',
      company: 'Demo Co',
      email: 'two@example.invalid',
      language: 'ta-IN',
      city: 'Demo City',
      lead_source: 'demo',
      notes: 'NON_DIALABLE_PLACEHOLDER',
    },
  ];
}

function buildSampleCsv() {
  const rows = sampleLeadRows();
  const headers = Object.keys(rows[0]);
  return sheetParse.toCsv(headers, rows);
}

function buildSampleXlsx() {
  const rows = sampleLeadRows();
  const headers = Object.keys(rows[0]);
  return sheetParse.buildXlsx(headers, rows);
}

module.exports = {
  STATUSES,
  LEAD_ROW_STATUSES,
  STANDARD_FIELDS,
  DEFAULT_RATE_PER_MIN,
  DEFAULT_CONCURRENCY,
  publicCampaign,
  publicLead,
  listCampaigns,
  findCampaign,
  createCampaign,
  updateCampaignSettings,
  setCampaignEmployee,
  parseLeadLines,
  addLeads,
  storeUpload,
  applyColumnMap,
  validateLaunch,
  setCampaignStatus,
  enqueueCampaign,
  listLeads,
  countLeads,
  normalizePhone,
  guessMapping,
  campaignAnalytics,
  exportCampaignRows,
  sampleLeadRows,
  buildSampleCsv,
  buildSampleXlsx,
};
