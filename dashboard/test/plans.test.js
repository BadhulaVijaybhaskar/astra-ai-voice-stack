'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const plans = require('../lib/plans');

function addLedgerEntry(d, tenantId, amountPaise, type, reference, actorUserId, metadata = {}) {
  const key = String(reference || '');
  if (key && d.ledger.some((x) => x.tenantId === tenantId && x.idempotencyKey === key)) return null;
  let wallet = d.wallets.find((w) => w.tenantId === tenantId);
  const now = new Date().toISOString();
  if (!wallet) {
    wallet = { id: 'wal_1', tenantId, currency: 'INR', balancePaise: 0, createdAt: now, updatedAt: now };
    d.wallets.push(wallet);
  }
  if (!Number.isInteger(amountPaise) || wallet.balancePaise + amountPaise < 0) throw new Error('invalid wallet adjustment');
  wallet.balancePaise += amountPaise;
  wallet.updatedAt = now;
  const entry = {
    id: 'led_' + d.ledger.length, tenantId, type, amountPaise,
    balanceAfterPaise: wallet.balancePaise, idempotencyKey: key, actorUserId, metadata, createdAt: now,
  };
  d.ledger.push(entry);
  return entry;
}

test('plan catalog exposes starter growth scale with credits and numbers', () => {
  const list = plans.listPlans();
  assert.deepEqual(list.map((p) => p.id), ['starter', 'growth', 'scale']);
  assert.equal(plans.publicPlan('growth').includedNumbers, 3);
  assert.equal(plans.publicPlan('scale').includedCreditsPaise, 100000);
  assert.equal(plans.publicPlan('starter').includedEmployees, 2);
  assert.equal(plans.publicPlan('growth').includedMinutes, 1000);
});

test('plan grant is idempotent and upgrade blocks downgrade', () => {
  const db = {
    tenants: [{ id: 't1', plan: 'starter', includedNumbers: 1 }],
    wallets: [{ id: 'w1', tenantId: 't1', currency: 'INR', balancePaise: 0, createdAt: 't', updatedAt: 't' }],
    ledger: [],
  };
  const first = plans.grantPlanCredits(db, 't1', 'starter', 'u1', addLedgerEntry);
  const second = plans.grantPlanCredits(db, 't1', 'starter', 'u1', addLedgerEntry);
  assert.equal(first.granted, true);
  assert.equal(second.granted, false);
  assert.equal(db.wallets[0].balancePaise, plans.PLANS.starter.includedCreditsPaise);
  const up = plans.upgradePlan(db, 't1', 'growth', 'u1', addLedgerEntry);
  assert.equal(up.ok, true);
  assert.equal(up.granted, true);
  assert.equal(db.tenants[0].plan, 'growth');
  const down = plans.upgradePlan(db, 't1', 'starter', 'u1', addLedgerEntry);
  assert.equal(down.ok, false);
  assert.equal(down.code, 'downgrade_blocked');
});

test('usage debit soft-fails when empty and never goes negative', () => {
  const db = {
    wallets: [{ id: 'w1', tenantId: 't1', currency: 'INR', balancePaise: 5, createdAt: 't', updatedAt: 't' }],
    ledger: [],
  };
  const a = plans.debitUsage(db, 't1', { chars: 0, calls: 1 }, 'u1', addLedgerEntry);
  assert.equal(a.debited, 5);
  assert.equal(db.wallets[0].balancePaise, 0);
  const b = plans.debitUsage(db, 't1', { chars: 5000, calls: 2 }, 'u1', addLedgerEntry);
  assert.equal(b.debited, 0);
  assert.equal(b.insufficient, true);
  assert.equal(db.wallets[0].balancePaise, 0);
});
