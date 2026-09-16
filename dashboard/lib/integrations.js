/**
 * Astra AI. Integrations registry: outbound webhooks + CRM placeholders.
 *
 * Webhook endpoints store name, URL, events, and a SHA-256 hash of the shared
 * secret (raw secret returned once on create). CRM connectors (HubSpot,
 * Salesforce) are V1 placeholders marked coming_soon. Optional lead.created
 * outbound stub posts a minimal JSON payload when a webhook listens.
 *
 * No em dashes anywhere. Commas and periods only.
 */
'use strict';

const crypto = require('crypto');
const https = require('https');
const http = require('http');

const WEBHOOK_EVENTS = Object.freeze([
  'lead.created',
  'call.completed',
  'campaign.started',
  'campaign.completed',
]);

const CRM_CONNECTORS = Object.freeze([
  Object.freeze({ id: 'hubspot', label: 'HubSpot', status: 'coming_soon' }),
  Object.freeze({ id: 'salesforce', label: 'Salesforce', status: 'coming_soon' }),
]);

function genId(prefix) {
  return prefix + crypto.randomBytes(8).toString('hex');
}

function nowIso() {
  return new Date().toISOString();
}

function hashSecret(secret) {
  return crypto.createHash('sha256').update(String(secret)).digest('hex');
}

function publicWebhook(row) {
  const w = row || {};
  return {
    id: w.id,
    name: w.name,
    url: w.url,
    events: Array.isArray(w.events) ? w.events.slice() : [],
    secretConfigured: !!(w.secretHash),
    status: w.status || 'active',
    createdAt: w.createdAt,
    updatedAt: w.updatedAt,
    lastDeliveryAt: w.lastDeliveryAt || null,
    lastDeliveryStatus: w.lastDeliveryStatus || null,
  };
}

function normalizeWebhookInput(body, existing) {
  const b = body && typeof body === 'object' ? body : {};
  const name = String(b.name != null ? b.name : (existing && existing.name) || '').trim().slice(0, 80);
  const url = String(b.url != null ? b.url : (existing && existing.url) || '').trim().slice(0, 500);
  const eventsRaw = Array.isArray(b.events) ? b.events : (existing && existing.events) || [];
  const events = [...new Set(eventsRaw.map((e) => String(e).trim()).filter((e) => WEBHOOK_EVENTS.includes(e)))];
  const statusRaw = String(b.status != null ? b.status : (existing && existing.status) || 'active').toLowerCase();
  const status = ['active', 'paused'].includes(statusRaw) ? statusRaw : null;
  if (!name) return { ok: false, status: 422, error: 'name required', code: 'bad_name' };
  if (!url || !/^https:\/\//i.test(url)) {
    return { ok: false, status: 422, error: 'url must be https', code: 'bad_url' };
  }
  if (!events.length) {
    return { ok: false, status: 422, error: 'at least one supported event required', code: 'bad_events' };
  }
  if (!status) return { ok: false, status: 422, error: 'status must be active or paused', code: 'bad_status' };
  const secret = b.secret != null ? String(b.secret).trim() : '';
  if (!existing && (!secret || secret.length < 12)) {
    return { ok: false, status: 422, error: 'secret must be at least 12 characters', code: 'bad_secret' };
  }
  return { ok: true, name, url, events, status, secret: secret || null };
}

function listWebhooks(db, tenantId) {
  return (db.integrationWebhooks || [])
    .filter((w) => w.tenantId === tenantId)
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
}

function findWebhook(db, tenantId, id) {
  return (db.integrationWebhooks || []).find((w) => w.id === id && w.tenantId === tenantId) || null;
}

function createWebhook(db, tenantId, input, actorUserId) {
  const parsed = normalizeWebhookInput(input);
  if (!parsed.ok) return parsed;
  if (!Array.isArray(db.integrationWebhooks)) db.integrationWebhooks = [];
  const ts = nowIso();
  const row = {
    id: genId('wh_'),
    tenantId,
    name: parsed.name,
    url: parsed.url,
    events: parsed.events,
    secretHash: hashSecret(parsed.secret),
    status: parsed.status,
    createdBy: actorUserId || null,
    createdAt: ts,
    updatedAt: ts,
    lastDeliveryAt: null,
    lastDeliveryStatus: null,
  };
  db.integrationWebhooks.push(row);
  return { ok: true, webhook: row, secretOnce: parsed.secret };
}

function updateWebhook(db, tenantId, id, input) {
  const row = findWebhook(db, tenantId, id);
  if (!row) return { ok: false, status: 404, error: 'webhook not found', code: 'not_found' };
  const parsed = normalizeWebhookInput(input, row);
  if (!parsed.ok) return parsed;
  row.name = parsed.name;
  row.url = parsed.url;
  row.events = parsed.events;
  row.status = parsed.status;
  if (parsed.secret) row.secretHash = hashSecret(parsed.secret);
  row.updatedAt = nowIso();
  return { ok: true, webhook: row, secretOnce: parsed.secret || undefined };
}

function deleteWebhook(db, tenantId, id) {
  if (!Array.isArray(db.integrationWebhooks)) db.integrationWebhooks = [];
  const idx = db.integrationWebhooks.findIndex((w) => w.id === id && w.tenantId === tenantId);
  if (idx < 0) return { ok: false, status: 404, error: 'webhook not found', code: 'not_found' };
  const [removed] = db.integrationWebhooks.splice(idx, 1);
  return { ok: true, webhook: removed };
}

function listCrmConnectors() {
  return CRM_CONNECTORS.map((c) => ({ ...c }));
}

function postJson(urlString, body, headers = {}) {
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(urlString); }
    catch (e) { return reject(e); }
    const lib = parsed.protocol === 'http:' ? http : https;
    const payload = Buffer.from(JSON.stringify(body), 'utf8');
    const req = lib.request({
      method: 'POST',
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'http:' ? 80 : 443),
      path: parsed.pathname + parsed.search,
      headers: Object.assign({
        'Content-Type': 'application/json',
        'Content-Length': payload.length,
        'User-Agent': 'AstraAI-Integrations/1.0',
      }, headers),
      timeout: 8000,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8').slice(0, 500) }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.write(payload);
    req.end();
  });
}

/**
 * Fire-and-forget stub for lead.created (and other) events to matching webhooks.
 * Does not throw into the request path when delivery fails.
 */
async function dispatchEvent(db, tenantId, eventName, payload, deliver = postJson) {
  const targets = listWebhooks(db, tenantId).filter((w) => w.status === 'active' && (w.events || []).includes(eventName));
  const results = [];
  for (const wh of targets) {
    try {
      const res = await deliver(wh.url, {
        event: eventName,
        tenantId,
        occurredAt: nowIso(),
        data: payload,
      }, { 'X-Astra-Event': eventName });
      wh.lastDeliveryAt = nowIso();
      wh.lastDeliveryStatus = String(res.status || 0);
      results.push({ id: wh.id, ok: true, status: res.status });
    } catch (e) {
      wh.lastDeliveryAt = nowIso();
      wh.lastDeliveryStatus = 'error';
      results.push({ id: wh.id, ok: false, error: String(e.message || e).slice(0, 120) });
    }
  }
  return results;
}

module.exports = {
  WEBHOOK_EVENTS,
  CRM_CONNECTORS,
  hashSecret,
  publicWebhook,
  normalizeWebhookInput,
  listWebhooks,
  findWebhook,
  createWebhook,
  updateWebhook,
  deleteWebhook,
  listCrmConnectors,
  dispatchEvent,
  postJson,
};
