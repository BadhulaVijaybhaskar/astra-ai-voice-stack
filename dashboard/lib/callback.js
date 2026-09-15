/**
 * Astra AI. Outbound "call me anytime" callback webhook helpers.
 *
 * Secured by CALLBACK_SECRET (X-Callback-Secret header). Places an immediate
 * Dograh initiate-call, or stores a future job in the JSON db for the in-process
 * poller. Never accepts provider API keys from the client body.
 * No em dashes anywhere. Commas and periods only.
 */
'use strict';

const crypto = require('crypto');

// E.164: + then country code (non-zero) then up to 14 more digits (max 15 total).
const E164_RE = /^\+[1-9]\d{6,14}$/;

const FORBIDDEN_BODY_KEYS = new Set([
  'api_key', 'apikey', 'apiKey', 'dograh_api_key', 'DOGRAH_API_KEY',
  'authorization', 'Authorization', 'secret', 'token', 'access_token',
]);

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest();
}

/** Timing-safe compare of shared secrets. Different lengths still hash-compare. */
function secretsEqual(provided, expected) {
  if (provided == null || expected == null) return false;
  const left = sha256(provided);
  const right = sha256(expected);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function isE164(phone) {
  return E164_RE.test(String(phone || '').trim());
}

function normalizeWhen(when) {
  if (when == null || when === '' || when === 'now') return { mode: 'now' };
  const raw = String(when).trim();
  if (/^now$/i.test(raw)) return { mode: 'now' };
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) {
    return { error: 'when must be "now" or an ISO8601 datetime', code: 'bad_when' };
  }
  if (ms <= Date.now() + 2000) return { mode: 'now' };
  return { mode: 'scheduled', when: new Date(ms).toISOString(), atMs: ms };
}

/**
 * Validate and normalize a callback webhook body.
 * Returns { ok:true, phone, whenInfo, name, note, source } or { ok:false, status, error, code }.
 */
function parseCallbackRequest(body) {
  const b = body && typeof body === 'object' ? body : {};
  for (const key of Object.keys(b)) {
    if (FORBIDDEN_BODY_KEYS.has(key)) {
      return { ok: false, status: 400, error: 'provider secrets are not accepted in the request body', code: 'unsafe_body' };
    }
  }
  const phone = String(b.phone || '').trim();
  if (!phone) {
    return { ok: false, status: 422, error: 'phone is required (E.164, e.g. +9198XXXXXXXX)', code: 'missing_phone' };
  }
  if (!isE164(phone)) {
    return { ok: false, status: 422, error: 'phone must be E.164 (+ and 7 to 15 digits)', code: 'bad_phone' };
  }
  const whenInfo = normalizeWhen(b.when);
  if (whenInfo.error) {
    return { ok: false, status: 422, error: whenInfo.error, code: whenInfo.code };
  }
  const name = b.name != null ? String(b.name).trim().slice(0, 120) : '';
  const note = b.note != null ? String(b.note).trim().slice(0, 500) : '';
  const source = b.source != null ? String(b.source).trim().slice(0, 80) : '';
  return { ok: true, phone, whenInfo, name, note, source };
}

/**
 * Summarize a Dograh initiate-call response without dumping secrets.
 */
function summarizeCallResult(data) {
  const row = data && typeof data === 'object' ? data : {};
  const callId = row.call_id || row.callId || row.id || row.run_id || row.runId || null;
  return {
    call_id: callId != null ? String(callId) : null,
    status: row.status != null ? String(row.status) : undefined,
    message: typeof row.message === 'string' ? row.message.slice(0, 200) : undefined,
  };
}

/**
 * Auth gate for the webhook. CALLBACK_SECRET must be set and match the header.
 */
function authorizeCallback(headerValue, envSecret) {
  const expected = String(envSecret || '').trim();
  if (!expected) {
    return { ok: false, status: 401, error: 'callback webhook is not configured', code: 'unauthorized' };
  }
  if (!secretsEqual(String(headerValue || ''), expected)) {
    return { ok: false, status: 401, error: 'invalid callback secret', code: 'unauthorized' };
  }
  return { ok: true };
}

module.exports = {
  E164_RE,
  isE164,
  secretsEqual,
  authorizeCallback,
  parseCallbackRequest,
  normalizeWhen,
  summarizeCallResult,
};
