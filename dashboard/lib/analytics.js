/**
 * Astra AI. Honest Performance aggregates from Call / Lead / Outcome rows only.
 *
 * Portable JSON only. Never invents conversion rates or chart series when data
 * is empty. Empty totals stay zeros, conversionRatePct is null when there are
 * no calls so the UI can show an em dash.
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

function summarizeCalls(db, tenantId, agentsById, employeesById) {
  const calls = (db.calls || []).filter((c) => c.tenantId === tenantId);
  const byOutcome = {};
  const byDirection = {};
  const byAgent = {};
  const byEmployee = {};
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

    let employeeId = call.employeeId || null;
    if (!employeeId && call.agentId && employeesById) {
      for (const emp of employeesById.values()) {
        if (emp.agentId === call.agentId) {
          employeeId = emp.id;
          break;
        }
      }
    }
    if (employeeId && employeesById && employeesById.get(employeeId)) {
      bump(byEmployee, employeesById.get(employeeId).name || employeeId);
    } else if (employeeId) {
      bump(byEmployee, employeeId);
    } else {
      bump(byEmployee, 'unassigned');
    }

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

  // Honest empty: null rate when there are no calls (UI shows —). Never invent %.
  const conversionRate = calls.length
    ? Math.round((converted / calls.length) * 1000) / 10
    : null;
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
    byEmployee,
    byStatus,
  };
}

function summarizeLeads(db, tenantId) {
  const leads = (db.leads || []).filter((l) => l.tenantId === tenantId);
  const byStatus = {};
  const byOutcome = {};
  let withEmployee = 0;
  for (const lead of leads) {
    bump(byStatus, lead.status || 'new');
    bump(byOutcome, lead.outcomeKey || lead.outcome || 'none');
    if (lead.employeeId) withEmployee += 1;
  }
  return {
    totals: {
      leads: leads.length,
      connected: withEmployee,
    },
    byStatus,
    byOutcome,
  };
}

function summarizeOutcomes(db, tenantId) {
  const byKey = {};
  let successHits = 0;
  let defined = 0;
  for (const emp of (db.employees || []).filter((e) => e.tenantId === tenantId)) {
    const defs = Array.isArray(emp.outcomes) ? emp.outcomes : [];
    defined += defs.length;
    for (const def of defs) {
      if (def && def.key) bump(byKey, def.key);
    }
  }
  const calls = (db.calls || []).filter((c) => c.tenantId === tenantId && c.outcome);
  for (const call of calls) {
    bump(byKey, call.outcome);
    if (/booked|qualified|won|converted|resolved|completed|promised_to_pay/i.test(String(call.outcome))) {
      successHits += 1;
    }
  }
  const leadHits = (db.leads || []).filter((l) => l.tenantId === tenantId && (l.outcomeKey || l.outcome));
  for (const lead of leadHits) {
    bump(byKey, lead.outcomeKey || lead.outcome);
  }
  return {
    totals: {
      defined,
      observed: calls.length + leadHits.length,
      successHits,
    },
    byKey,
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
    (db.agents || []).filter((a) => a.tenantId === tenantId).map((a) => [a.id, a]),
  );
  const employeesById = new Map(
    (db.employees || []).filter((e) => e.tenantId === tenantId).map((e) => [e.id, e]),
  );
  return {
    calls: summarizeCalls(db, tenantId, agentsById, employeesById),
    leads: summarizeLeads(db, tenantId),
    outcomes: summarizeOutcomes(db, tenantId),
    campaigns: summarizeCampaigns(db, tenantId),
    generatedAt: new Date().toISOString(),
  };
}

module.exports = {
  summarizeCalls,
  summarizeLeads,
  summarizeOutcomes,
  summarizeCampaigns,
  buildDashboard,
};
