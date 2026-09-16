'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const knowledge = require('../lib/knowledge');
const integrations = require('../lib/integrations');

test('knowledge CRUD is tenant scoped and retrieval scores published entries', () => {
  const db = { knowledgeEntries: [] };
  const a = knowledge.createEntry(db, 't_a', { title: 'Office hours', content: 'We are open Monday to Friday 9 to 6', status: 'published' });
  const b = knowledge.createEntry(db, 't_b', { title: 'Office hours', content: 'Other tenant secrets', status: 'published' });
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal(knowledge.listTenantEntries(db, 't_a').length, 1);
  const hits = knowledge.retrieveForQuery(db, 't_a', 'office hours friday');
  assert.ok(hits.length >= 1);
  assert.equal(hits[0].title, 'Office hours');
  assert.equal(JSON.stringify(hits).includes('Other tenant'), false);
  const updated = knowledge.updateEntry(db, 't_a', a.entry.id, { title: 'Hours', content: 'Closed Sunday', status: 'draft' });
  assert.equal(updated.ok, true);
  assert.equal(knowledge.retrieveForQuery(db, 't_a', 'sunday').length, 0);
  const del = knowledge.deleteEntry(db, 't_b', a.entry.id);
  assert.equal(del.ok, false);
  assert.equal(knowledge.deleteEntry(db, 't_a', a.entry.id).ok, true);
});

test('webhook registry hashes secrets and never returns the raw secret later', () => {
  const db = { integrationWebhooks: [] };
  const created = integrations.createWebhook(db, 't_a', {
    name: 'Lead sink',
    url: 'https://hooks.example.com/astra',
    secret: 'super-secret-12',
    events: ['lead.created'],
  });
  assert.equal(created.ok, true);
  assert.equal(created.secretOnce, 'super-secret-12');
  const pub = integrations.publicWebhook(created.webhook);
  assert.equal(pub.secretConfigured, true);
  assert.equal(pub.secret, undefined);
  assert.equal(pub.secretHash, undefined);
  assert.equal(created.webhook.secretHash, crypto.createHash('sha256').update('super-secret-12').digest('hex'));
  assert.deepEqual(integrations.listCrmConnectors().map((c) => c.status), ['coming_soon', 'coming_soon']);
  const bad = integrations.createWebhook(db, 't_a', {
    name: 'Bad', url: 'http://insecure.example', secret: 'super-secret-12', events: ['lead.created'],
  });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'bad_url');
});

test('dispatchEvent posts only to matching active webhooks', async () => {
  const db = { integrationWebhooks: [] };
  integrations.createWebhook(db, 't_a', {
    name: 'A', url: 'https://a.example/hook', secret: 'super-secret-12', events: ['lead.created'],
  });
  integrations.createWebhook(db, 't_a', {
    name: 'B', url: 'https://b.example/hook', secret: 'super-secret-12', events: ['call.completed'], status: 'active',
  });
  const delivered = [];
  const results = await integrations.dispatchEvent(db, 't_a', 'lead.created', { phone: '+9198' }, async (url, body) => {
    delivered.push({ url, body });
    return { status: 204, body: '' };
  });
  assert.equal(results.length, 1);
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].url, 'https://a.example/hook');
  assert.equal(delivered[0].body.event, 'lead.created');
});
