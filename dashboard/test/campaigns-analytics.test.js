'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const campaigns = require('../lib/campaigns');
const analytics = require('../lib/analytics');

test('campaign leads parse and enqueue requires confirm with rate limit', () => {
  const db = { campaigns: [], campaignLeads: [], agents: [{ id: 'ag_1', tenantId: 't_a', name: 'Out' }] };
  const created = campaigns.createCampaign(db, 't_a', { name: 'March', agentId: 'ag_1', ratePerMinute: 2 });
  assert.equal(created.ok, true);
  const added = campaigns.addLeads(db, 't_a', created.campaign.id, '+919811111111, Ada\n+919822222222, Bob\n+919833333333, Cara');
  assert.equal(added.added, 3);
  const denied = campaigns.enqueueCampaign(db, 't_a', created.campaign.id, { confirm: false });
  assert.equal(denied.code, 'needs_confirm');
  const batch = campaigns.enqueueCampaign(db, 't_a', created.campaign.id, { confirm: true });
  assert.equal(batch.ok, true);
  assert.equal(batch.enqueued, 2);
  assert.equal(batch.campaign.status, 'running');
  const again = campaigns.enqueueCampaign(db, 't_a', created.campaign.id, { confirm: true });
  assert.equal(again.enqueued, 1);
  assert.equal(again.campaign.status, 'done');
});

test('analytics aggregates outcomes directions and conversion metrics', () => {
  const db = {
    agents: [{ id: 'ag_1', tenantId: 't_a', name: 'Desk' }],
    employees: [],
    calls: [
      { tenantId: 't_a', agentId: 'ag_1', direction: 'inbound', outcome: 'booked', status: 'completed', durationSec: 40, extractedData: { booked: true } },
      { tenantId: 't_a', agentId: 'ag_1', direction: 'outbound', outcome: 'no_answer', status: 'completed', durationSec: 20, extractedData: {} },
      { tenantId: 't_b', agentId: 'ag_x', direction: 'inbound', outcome: 'booked', status: 'completed', durationSec: 99, extractedData: { booked: true } },
    ],
    leads: [],
    campaigns: [{ id: 'c1', tenantId: 't_a', status: 'running' }],
    campaignLeads: [{ id: 'l1', tenantId: 't_a', campaignId: 'c1', status: 'pending' }],
  };
  const dash = analytics.buildDashboard(db, 't_a');
  assert.equal(dash.calls.totals.calls, 2);
  assert.equal(dash.calls.totals.converted, 1);
  assert.equal(dash.calls.byDirection.inbound, 1);
  assert.equal(dash.calls.byAgent.Desk, 2);
  assert.equal(dash.campaigns.leads, 1);
  assert.equal(JSON.stringify(dash).includes('t_b'), false);
});

test('campaign create accepts employeeId and public shape hides provider ids', () => {
  const db = {
    campaigns: [],
    campaignLeads: [],
    agents: [{ id: 'ag_1', tenantId: 't_a', name: 'Out' }],
    employees: [{ id: 'emp_1', tenantId: 't_a', name: 'Ria', agentId: 'ag_1', status: 'LIVE' }],
  };
  const created = campaigns.createCampaign(db, 't_a', { name: 'Emp batch', employeeId: 'emp_1' });
  assert.equal(created.ok, true);
  assert.equal(created.campaign.employeeId, 'emp_1');
  assert.equal(created.campaign.agentId, 'ag_1');
  const pub = campaigns.publicCampaign(created.campaign, campaigns.countLeads(db, created.campaign.id));
  assert.equal(pub.employeeId, 'emp_1');
  assert.equal(JSON.stringify(pub).includes('dograh'), false);
});
