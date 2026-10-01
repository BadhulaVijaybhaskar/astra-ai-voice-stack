/**
 * Astra Voice. Cal.com booking helpers.
 *
 * Pre-flight attendee email checks, nested upstream error extraction, and
 * booking uid gating so Astra never marks an appointment booked without a
 * real Cal.com booking id.
 *
 * No em dashes anywhere. Commas and periods only.
 */
'use strict';

/** RFC 2606 / special-use and other domains that cannot receive mail. */
const NON_MAILABLE_DOMAINS = new Set([
  'example.com',
  'example.org',
  'example.net',
  'example.edu',
  'test',
  'localhost',
  'invalid',
  'local',
  'email.example',
  'mail.example',
  'example',
  'test.com', // often used as a placeholder without MX in demos
]);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function emailDomain(email) {
  const normalized = normalizeEmail(email);
  const at = normalized.lastIndexOf('@');
  if (at < 0) return '';
  return normalized.slice(at + 1);
}

/**
 * True when the address looks like a real mailbox Cal.com can confirm.
 * Rejects reserved / non-mailable domains (e.g. @example.com) that Cal.com
 * rejects with email_domain_cannot_receive_mail.
 */
function isMailableAttendeeEmail(email) {
  const normalized = normalizeEmail(email);
  if (!EMAIL_RE.test(normalized)) return false;
  const domain = emailDomain(normalized);
  if (!domain || domain.startsWith('.') || domain.endsWith('.') || domain.includes('..')) {
    return false;
  }
  if (NON_MAILABLE_DOMAINS.has(domain)) return false;
  // Block any *.example.com / *.example.org style reserved labels.
  if (/(^|\.)example\.(com|org|net|edu)$/.test(domain)) return false;
  if (/(^|\.)(test|invalid|localhost|local)$/.test(domain)) return false;
  return true;
}

function flattenMessage(value, out, depth) {
  if (depth > 6 || value == null) return;
  if (typeof value === 'string') {
    const s = value.trim();
    if (s && s !== '[object Object]') out.push(s);
    return;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    out.push(String(value));
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) flattenMessage(item, out, depth + 1);
    return;
  }
  if (typeof value === 'object') {
    if (value.message != null) flattenMessage(value.message, out, depth + 1);
    if (value.error != null && value.error !== value) flattenMessage(value.error, out, depth + 1);
    if (value.details != null) flattenMessage(value.details, out, depth + 1);
    if (value.detail != null) flattenMessage(value.detail, out, depth + 1);
    if (value.code != null && typeof value.code === 'string') flattenMessage(value.code, out, depth + 1);
    if (value.title != null) flattenMessage(value.title, out, depth + 1);
  }
}

function firstStringCode(value, depth) {
  if (depth > 6 || value == null) return null;
  if (typeof value === 'string') {
    const s = value.trim();
    if (!s) return null;
    // Prefer snake_case style codes over free-form sentences / PascalCase exceptions.
    if (/^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/i.test(s)) return s;
    return null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const c = firstStringCode(item, depth + 1);
      if (c) return c;
    }
    return null;
  }
  if (typeof value === 'object') {
    // Prefer nested details/message codes (e.g. email_domain_cannot_receive_mail)
    // over generic framework codes like BadRequestException.
    for (const key of ['details', 'detail', 'message', 'error', 'data', 'code']) {
      const c = firstStringCode(value[key], depth + 1);
      if (c) return c;
    }
  }
  return null;
}

/**
 * Extract a human-readable message and structured code from Cal.com error bodies.
 * Cal.com v2 often nests: { error: { code, message, details } }.
 */
function formatCalcomError(body, statusCode) {
  const raw = body && typeof body === 'object' ? body : {};
  const parts = [];
  flattenMessage(raw.message, parts, 0);
  flattenMessage(raw.error, parts, 0);
  flattenMessage(raw.details, parts, 0);
  // Deduplicate while preserving order.
  const seen = new Set();
  const unique = [];
  for (const p of parts) {
    const key = p.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(p);
  }
  const code = firstStringCode(raw, 0)
    || firstStringCode(raw.error, 0)
    || (statusCode === 400 ? 'calendar_bad_request' : 'calendar_upstream');
  const message = unique.length
    ? unique.join(' · ')
    : (statusCode ? ('Cal.com request failed (' + statusCode + ')') : 'Cal.com request failed');
  return {
    message: message.slice(0, 500),
    code: String(code).slice(0, 80),
    detail: {
      statusCode: statusCode || null,
      nested: raw.error && typeof raw.error === 'object' ? raw.error : undefined,
      errors: unique.slice(0, 8),
    },
  };
}

/**
 * Prefer Cal.com booking uid. Fall back to id only when uid is absent.
 */
function extractBookingUid(bookingResponse) {
  const data = bookingResponse && bookingResponse.data && typeof bookingResponse.data === 'object'
    ? bookingResponse.data
    : (bookingResponse && typeof bookingResponse === 'object' ? bookingResponse : null);
  if (!data) return null;
  const uid = data.uid != null ? String(data.uid).trim() : '';
  if (uid) return uid;
  const id = data.id != null ? String(data.id).trim() : '';
  return id || null;
}

/**
 * Resolve a real Cal.com / calendar booking id from call extraction payloads.
 */
function extractRealBookingId(payload) {
  const b = payload && typeof payload === 'object' ? payload : {};
  const data = (b.extractedData && typeof b.extractedData === 'object')
    ? b.extractedData
    : ((b.extracted && typeof b.extracted === 'object') ? b.extracted : b);
  const appt = (data.appointment && typeof data.appointment === 'object')
    ? data.appointment
    : ((b.appointment && typeof b.appointment === 'object') ? b.appointment : null);

  const candidates = [
    b.bookingId,
    b.booking_id,
    b.calBookingUid,
    b.cal_booking_uid,
    data.bookingId,
    data.booking_id,
    data.calBookingUid,
    data.cal_booking_uid,
    appt && appt.bookingId,
    appt && appt.booking_id,
    appt && appt.calBookingUid,
    appt && appt.cal_booking_uid,
    appt && appt.uid,
  ];
  for (const c of candidates) {
    const s = c == null ? '' : String(c).trim();
    if (s) return s;
  }
  return null;
}

module.exports = {
  NON_MAILABLE_DOMAINS,
  EMAIL_RE,
  normalizeEmail,
  emailDomain,
  isMailableAttendeeEmail,
  formatCalcomError,
  extractBookingUid,
  extractRealBookingId,
};
