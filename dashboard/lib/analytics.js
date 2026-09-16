/**
 * Astra AI. Analytics aggregates from calls (and optional campaign leads).
 *
 * Portable JSON only. Returns counts by outcome, direction, agent, plus simple
 * conversion-ish metrics from extractedData when present.
 *
 * No em dashes anywhere. Commas and periods only.
 */
'use strict';

function isObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function bump(map, key) {
  const k = key == null || key === '' ? 'unknown' : String(key);
  map[k] = (map[k] || 0) + 1;
}

function summarizeCalls(db, tenantId, agentsById) {
  const calls = (db.calls || []).filter((c) => c.tenantId === tenantId);
  const byOutcome = {};
  const byDirection = {};
  const byAgent = {};
  const byStatus = {};
  let withExtracted = 0;
  let converted = 0;
  let totalDuration = 0;
  let durationSamples = 0;

  for (const call of calls) {
    bump(byOutcome, call.outcome || 'unspecified');
    bump(byDirection, call.direction || 'unknown');
    bump(byStatus, call.status || 'unknown');
    const agent = agentsById && agentsById.get(call.agentId);
    const agentLabel = agent ? agent.name : (call.agentId || 'unassigned');
    bump(byAgent, agentLabel);
    if (Number.isFinite(call.durationSec)) {
      totalDuration += call.durationSec;
      durationSamples += 1;
    }
    if (isObject(call.extractedData) && Object.keys(call.extractedData).length) {
      withExtracted += 1;
      const ed = call.extractedData;
      const positive = ed.converted === true
        || ed.booked === true
        || ed.qualified === true
        || /booked|qualified|won|converted/i.test(String(ed.outcome || ed.result || ''));
      if (positive || /booked|qualified|won|converted/i.test(String(call.outcome || ''))) converted += 1;
    } else if (/booked|qualified|won|converted/i.test(String(call.outcome || ''))) {
      converted += 1;
    }
  }

  const conversionRate = calls.length ? Math.round((converted / calls.length) * 1000) / 10 : 0;
  const avgDurationSec = durationSamples ? Math.round(totalDuration / durationSamples) : 0;

  return {
    totals: {
      calls: calls.length,
      withExtractedData: withExtracted,
      converted,
      conversionRatePct: conversionRate,
      avgDurationSec,
    },
    byOutcome,
    byDirection,
    byAgent,
    byStatus,
  };
}

function summarizeCampaigns(db, tenantId) {
  const campaigns = (db.campaigns || []).filter((c) => c.tenantId === tenantId);
  const leads = (db.campaignLeads || []).filter((l) => l.tenantId === tenantId);
  const byStatus = {};
  for (const c of campaigns) bump(byStatus, c.status || 'draft');
  const leadByStatus = {};
  for (const l of leads) bump(leadByStatus, l.status || 'pending');
  return {
    campaigns: campaigns.length,
    leads: leads.length,
    byStatus,
    leadByStatus,
  };
}

function buildDashboard(db, tenantId) {
  const agentsById = new Map(
    (db.agents || []).filter((a) => a.tenantId === tenantId).map((a) => [a.id, a])
  );
  return {
    calls: summarizeCalls(db, tenantId, agentsById),
    campaigns: summarizeCampaigns(db, tenantId),
    generatedAt: new Date().toISOString(),
  };
}

module.exports = {
  summarizeCalls,
  summarizeCampaigns,
  buildDashboard,
};
