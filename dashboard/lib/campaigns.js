/**
 * Astra AI. Outbound campaigns with lead lists and guarded enqueue stub.
 *
 * Campaigns link to an outbound agent/workflow, hold leads (phone, name, meta),
 * and move through draft / running / paused / done. Enqueue requires confirm:true
 * and applies a simple rate limit. Dial uses the existing initiate-call path
 * when a dialFn is supplied; otherwise jobs stay stub_queued.
 *
 * No em dashes anywhere. Commas and periods only.
 */
'use strict';

const crypto = require('crypto');

const STATUSES = new Set(['draft', 'running', 'paused', 'done']);
const DEFAULT_RATE_PER_MIN = 10;

function genId(prefix) {
  return prefix + crypto.randomBytes(8).toString('hex');
}

function nowIso() {
  return new Date().toISOString();
}

function normalizePhone(value) {
  const raw = String(value || '').trim();
  if (/^\+[1-9]\d{6,14}$/.test(raw)) return raw;
  const digits = raw.replace(/[^0-9]/g, '');
  if (digits.length === 10) return '+91' + digits;
  if (digits.length === 12 && digits.startsWith('91')) return '+' + digits;
  return raw.startsWith('+') ? raw : (digits ? '+' + digits : '');
}

function publicCampaign(row, leadCounts) {
  const c = row || {};
  return {
    id: c.id,
    name: c.name,
    status: c.status || 'draft',
    employeeId: c.employeeId || null,
    agentId: c.agentId || null,
    ratePerMinute: c.ratePerMinute || DEFAULT_RATE_PER_MIN,
    leadCount: leadCounts ? (leadCounts.total || 0) : (c.leadCount || 0),
    queuedCount: leadCounts ? (leadCounts.queued || 0) : (c.queuedCount || 0),
    dialedCount: leadCounts ? (leadCounts.dialed || 0) : (c.dialedCount || 0),
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
    phone: l.phone,
    name: l.name || '',
    meta: l.meta && typeof l.meta === 'object' ? l.meta : {},
    status: l.status || 'pending',
    lastError: l.lastError || null,
    dialedAt: l.dialedAt || null,
    createdAt: l.createdAt,
  };
}

function countLeads(db, campaignId) {
  const leads = (db.campaignLeads || []).filter((l) => l.campaignId === campaignId);
  return {
    total: leads.length,
    queued: leads.filter((l) => l.status === 'queued' || l.status === 'pending').length,
    dialed: leads.filter((l) => l.status === 'dialed' || l.status === 'stub_queued').length,
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
  if (employeeId) {
    const emp = (db.employees || []).find((e) => e.id === employeeId && e.tenantId === tenantId);
    if (!emp) return { ok: false, status: 404, error: 'employee not found', code: 'employee_not_found' };
    if (!agentId) agentId = emp.agentId || null;
  }
  if (agentId) {
    const agent = (db.agents || []).find((a) => a.id === agentId && a.tenantId === tenantId);
    if (!agent) return { ok: false, status: 404, error: 'agent not found', code: 'agent_not_found' };
  }

  const rate = Math.max(1, Math.min(60, Number(b.ratePerMinute) || DEFAULT_RATE_PER_MIN));
  if (!Array.isArray(db.campaigns)) db.campaigns = [];
  const ts = nowIso();
  const row = {
    id: genId('cmp_'),
    tenantId,
    name,
    status: 'draft',
    employeeId,
    agentId,
    ratePerMinute: rate,
    createdBy: actorUserId || null,
    createdAt: ts,
    updatedAt: ts,
    startedAt: null,
    completedAt: null,
  };
  db.campaigns.push(row);
  return { ok: true, campaign: row };
}

/**
 * Attach or clear an Employee on a campaign. Resolves agentId from the employee
 * when present so enqueue can dial through the same CallJob path as Instant Leads.
 */
function setCampaignEmployee(db, tenantId, campaignId, employeeId) {
  const campaign = findCampaign(db, tenantId, campaignId);
  if (!campaign) return { ok: false, status: 404, error: 'campaign not found', code: 'not_found' };
  if (employeeId) {
    const emp = (db.employees || []).find((e) => e.id === String(employeeId) && e.tenantId === tenantId);
    if (!emp) return { ok: false, status: 404, error: 'employee not found', code: 'employee_not_found' };
    campaign.employeeId = emp.id;
    campaign.agentId = emp.agentId || campaign.agentId || null;
  } else {
    campaign.employeeId = null;
  }
  campaign.updatedAt = nowIso();
  return { ok: true, campaign };
}

function parseLeadLines(textOrList) {
  if (Array.isArray(textOrList)) {
    return textOrList.map((row) => ({
      phone: normalizePhone(row.phone || row.number || ''),
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
  if (campaign.status === 'done') {
    return { ok: false, status: 409, error: 'cannot add leads to a completed campaign', code: 'campaign_done' };
  }
  if (!Array.isArray(db.campaignLeads)) db.campaignLeads = [];
  const parsed = parseLeadLines(textOrList);
  const added = [];
  const skipped = [];
  const ts = nowIso();
  for (const lead of parsed) {
    if (!/^\+[1-9]\d{6,14}$/.test(lead.phone)) {
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
      phone: lead.phone,
      name: lead.name,
      meta: lead.meta,
      status: 'pending',
      lastError: null,
      dialedAt: null,
      createdAt: ts,
    };
    db.campaignLeads.push(row);
    added.push(row);
  }
  campaign.updatedAt = ts;
  return { ok: true, added: added.length, skipped, leads: added.map(publicLead) };
}

function setCampaignStatus(db, tenantId, campaignId, status) {
  if (!STATUSES.has(status)) {
    return { ok: false, status: 422, error: 'status must be draft, running, paused, or done', code: 'bad_status' };
  }
  const campaign = findCampaign(db, tenantId, campaignId);
  if (!campaign) return { ok: false, status: 404, error: 'campaign not found', code: 'not_found' };
  campaign.status = status;
  campaign.updatedAt = nowIso();
  if (status === 'running' && !campaign.startedAt) campaign.startedAt = campaign.updatedAt;
  if (status === 'done') campaign.completedAt = campaign.updatedAt;
  return { ok: true, campaign };
}

/**
 * Guarded enqueue. Requires confirm:true. Marks up to ratePerMinute leads as
 * stub_queued (or dialed when dialFn succeeds). Never mass-dials without confirm.
 * dialFn, if provided, must be synchronous for the JSON store mutate lock.
 */
function enqueueCampaign(db, tenantId, campaignId, { confirm, dialFn } = {}) {
  if (confirm !== true) {
    return { ok: false, status: 400, error: 'confirm:true required to enqueue dials', code: 'needs_confirm' };
  }
  const campaign = findCampaign(db, tenantId, campaignId);
  if (!campaign) return { ok: false, status: 404, error: 'campaign not found', code: 'not_found' };
  if (campaign.status !== 'running' && campaign.status !== 'draft') {
    return { ok: false, status: 409, error: 'campaign must be draft or running to enqueue', code: 'bad_status' };
  }
  if (campaign.status === 'draft') {
    campaign.status = 'running';
    campaign.startedAt = campaign.startedAt || nowIso();
  }
  const rate = campaign.ratePerMinute || DEFAULT_RATE_PER_MIN;
  const pending = (db.campaignLeads || [])
    .filter((l) => l.campaignId === campaignId && l.tenantId === tenantId && l.status === 'pending')
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
  const remaining = (db.campaignLeads || []).filter((l) => l.campaignId === campaignId && l.status === 'pending').length;
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

module.exports = {
  STATUSES,
  DEFAULT_RATE_PER_MIN,
  publicCampaign,
  publicLead,
  listCampaigns,
  findCampaign,
  createCampaign,
  setCampaignEmployee,
  parseLeadLines,
  addLeads,
  setCampaignStatus,
  enqueueCampaign,
  listLeads,
  countLeads,
  normalizePhone,
};
