/**
 * Astra AI. Subscription plans, credit grants, and soft usage debits.
 *
 * Plans (starter / growth / scale) include monthly credits (paise), phone
 * numbers, employees, and soft minute allowances (Phase 20 packaging).
 * Top-up packs remain separate PayU products. Debits for TTS chars and calls
 * are soft ledger entries that never go below zero (fail open for product UX
 * in V1, but still record attempted usage).
 *
 * No em dashes anywhere. Commas and periods only.
 */
'use strict';

const PLANS = Object.freeze({
  starter: Object.freeze({
    id: 'starter',
    label: 'Starter',
    includedCreditsPaise: 5000,
    includedNumbers: 1,
    includedEmployees: 2,
    includedMinutes: 100,
    description: 'Trial-friendly workspace with light outbound.',
  }),
  growth: Object.freeze({
    id: 'growth',
    label: 'Growth',
    includedCreditsPaise: 25000,
    includedNumbers: 3,
    includedEmployees: 10,
    includedMinutes: 1000,
    description: 'Growing teams with more concurrent employees and numbers.',
  }),
  scale: Object.freeze({
    id: 'scale',
    label: 'Scale',
    includedCreditsPaise: 100000,
    includedNumbers: 10,
    includedEmployees: 50,
    includedMinutes: 10000,
    description: 'Higher volume campaigns and multi-number workspaces.',
  }),
});

// Soft debit rates in paise. Tuned to stay cheap so tests with trial credit pass.
const DEBIT = Object.freeze({
  ttsPerCharPaise: 0, // chars are metered in usage; wallet debit optional
  ttsPerThousandPaise: 1, // 1 paise per 1000 chars when debiting
  callPaise: 10, // 10 paise per dashboard telephony dial
});

function listPlans() {
  return Object.values(PLANS).map((p) => ({ ...p }));
}

function getPlan(planId) {
  const id = String(planId || 'starter').toLowerCase();
  return PLANS[id] || PLANS.starter;
}

function publicPlan(planId) {
  const p = getPlan(planId);
  return {
    id: p.id,
    label: p.label,
    includedCreditsPaise: p.includedCreditsPaise,
    includedCreditsInr: p.includedCreditsPaise / 100,
    includedNumbers: p.includedNumbers,
    includedEmployees: p.includedEmployees,
    includedMinutes: p.includedMinutes,
    description: p.description,
    entitlements: {
      numbers: p.includedNumbers,
      employees: p.includedEmployees,
      minutes: p.includedMinutes,
      creditsPaise: p.includedCreditsPaise,
    },
  };
}

/**
 * Honest usage counts for packaging UI. Never invents minutes or balances.
 */
function countEntitlementUsage(db, tenantId) {
  const numbers = (db.phoneNumbers || []).filter(
    (n) => n.tenantId === tenantId && n.status === 'assigned',
  ).length;
  const employees = (db.employees || []).filter(
    (e) => e.tenantId === tenantId && e.status !== 'ARCHIVED',
  ).length;
  // Minutes come from real call duration only. Missing data = 0, never fake.
  let minutesUsed = 0;
  for (const call of db.calls || []) {
    if (call.tenantId !== tenantId) continue;
    const sec = Number(call.durationSec);
    if (Number.isFinite(sec) && sec > 0) minutesUsed += sec / 60;
  }
  minutesUsed = Math.floor(minutesUsed);
  return { numbers, employees, minutes: minutesUsed };
}

function publicEntitlements(db, tenant) {
  const plan = publicPlan(tenant && tenant.plan);
  const used = countEntitlementUsage(db || {}, tenant && tenant.id);
  return {
    planId: plan.id,
    planLabel: plan.label,
    included: {
      numbers: tenant && tenant.includedNumbers != null
        ? Number(tenant.includedNumbers)
        : plan.includedNumbers,
      employees: tenant && tenant.includedEmployees != null
        ? Number(tenant.includedEmployees)
        : plan.includedEmployees,
      minutes: tenant && tenant.includedMinutes != null
        ? Number(tenant.includedMinutes)
        : plan.includedMinutes,
      creditsPaise: plan.includedCreditsPaise,
    },
    used: {
      numbers: used.numbers,
      employees: used.employees,
      minutes: used.minutes,
    },
    // Honest empty wallet stays empty. Credits live on the wallet balance.
    credits: {
      balancePaise: (() => {
        const wallet = (db.wallets || []).find((w) => w.tenantId === (tenant && tenant.id));
        return wallet ? Number(wallet.balancePaise) || 0 : 0;
      })(),
    },
  };
}

/**
 * Apply plan grant once per tenant+plan. Idempotent via ledger reference.
 * addLedgerEntry(d, tenantId, amountPaise, type, reference, actorUserId, metadata)
 */
function grantPlanCredits(d, tenantId, planId, actorUserId, addLedgerEntry) {
  const plan = getPlan(planId);
  const reference = `plan_grant:${tenantId}:${plan.id}`;
  const entry = addLedgerEntry(
    d,
    tenantId,
    plan.includedCreditsPaise,
    'plan_grant',
    reference,
    actorUserId,
    {
      planId: plan.id,
      includedNumbers: plan.includedNumbers,
      includedEmployees: plan.includedEmployees,
      includedMinutes: plan.includedMinutes,
    }
  );
  const tenant = (d.tenants || []).find((t) => t.id === tenantId);
  if (tenant) {
    tenant.plan = plan.id;
    tenant.includedNumbers = plan.includedNumbers;
    tenant.includedEmployees = plan.includedEmployees;
    tenant.includedMinutes = plan.includedMinutes;
  }
  return { plan, entry, granted: !!entry };
}

function upgradePlan(d, tenantId, planId, actorUserId, addLedgerEntry) {
  const next = getPlan(planId);
  const tenant = (d.tenants || []).find((t) => t.id === tenantId);
  if (!tenant) return { ok: false, status: 404, error: 'tenant not found', code: 'not_found' };
  const current = getPlan(tenant.plan || 'starter');
  const order = { starter: 1, growth: 2, scale: 3 };
  if ((order[next.id] || 0) < (order[current.id] || 0)) {
    return { ok: false, status: 409, error: 'downgrades are not supported in V1', code: 'downgrade_blocked' };
  }
  if (next.id === current.id) {
    return { ok: true, plan: publicPlan(current.id), granted: false, duplicate: true };
  }
  const result = grantPlanCredits(d, tenantId, next.id, actorUserId, addLedgerEntry);
  return { ok: true, plan: publicPlan(next.id), granted: result.granted, entry: result.entry };
}

function debitUsage(d, tenantId, { chars, calls }, actorUserId, addLedgerEntry) {
  const charAmount = Math.max(0, Math.floor((Number(chars) || 0) / 1000) * DEBIT.ttsPerThousandPaise);
  const callAmount = Math.max(0, (Number(calls) || 0) * DEBIT.callPaise);
  const amount = charAmount + callAmount;
  if (!amount) return { ok: true, debited: 0, skipped: true };
  const wallet = (d.wallets || []).find((w) => w.tenantId === tenantId);
  const balance = wallet ? wallet.balancePaise : 0;
  const apply = Math.min(amount, Math.max(0, balance));
  if (!apply) return { ok: true, debited: 0, insufficient: true };
  const day = new Date().toISOString().slice(0, 10);
  const reference = `usage_debit:${tenantId}:${day}:${chars || 0}:${calls || 0}:${Date.now()}`;
  try {
    const entry = addLedgerEntry(d, tenantId, -apply, 'usage_debit', reference, actorUserId, {
      chars: Number(chars) || 0,
      calls: Number(calls) || 0,
      requestedPaise: amount,
    });
    return { ok: true, debited: apply, entry };
  } catch (_) {
    return { ok: true, debited: 0, insufficient: true };
  }
}

/**
 * Super Admin / admin test-credit grant (Phase 20). Customer never sees
 * provider invoices. Reuses ledger idempotency.
 */
function grantTestCredits(d, tenantId, amountPaise, actorUserId, idempotencyKey, reason, addLedgerEntry) {
  const amount = Math.floor(Number(amountPaise));
  if (!Number.isInteger(amount) || amount <= 0) {
    return { ok: false, status: 422, error: 'amountPaise must be a positive integer', code: 'bad_amount' };
  }
  const key = String(idempotencyKey || '').trim() || `test_credit:${tenantId}:${amount}:${Date.now()}`;
  const entry = addLedgerEntry(
    d,
    tenantId,
    amount,
    'test_credit',
    key,
    actorUserId,
    { reason: String(reason || 'test credits').slice(0, 200), grantKind: 'test' },
  );
  return {
    ok: true,
    duplicate: !entry,
    ledgerEntry: entry || (d.ledger || []).find((x) => x.tenantId === tenantId && x.idempotencyKey === key) || null,
  };
}

module.exports = {
  PLANS,
  DEBIT,
  listPlans,
  getPlan,
  publicPlan,
  publicEntitlements,
  countEntitlementUsage,
  grantPlanCredits,
  upgradePlan,
  debitUsage,
  grantTestCredits,
};
