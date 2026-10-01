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

const DEFAULT_TZ = 'Asia/Kolkata';
const KOLKATA_OFFSET_MS = (5 * 60 + 30) * 60 * 1000; // IST is UTC+05:30 year-round

/**
 * Format a UTC ms instant as a wall-clock Date in Asia/Kolkata (no DST).
 * Returns { y, m, d, hh, mm, ss } in IST.
 */
function partsInKolkata(utcMs) {
  const shifted = new Date(utcMs + KOLKATA_OFFSET_MS);
  return {
    y: shifted.getUTCFullYear(),
    m: shifted.getUTCMonth(),
    d: shifted.getUTCDate(),
    hh: shifted.getUTCHours(),
    mm: shifted.getUTCMinutes(),
    ss: shifted.getUTCSeconds(),
  };
}

/** Build UTC ISO from Asia/Kolkata wall-clock components. */
function kolkataWallToUtcIso(y, m, d, hh, mm, ss = 0) {
  const utcMs = Date.UTC(y, m, d, hh, mm, ss) - KOLKATA_OFFSET_MS;
  return { when: new Date(utcMs).toISOString(), atMs: utcMs };
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
  return { mode: 'scheduled', when: new Date(ms).toISOString(), atMs: ms, timezone: DEFAULT_TZ };
}

/**
 * Parse natural-language callback timing into Asia/Kolkata → ISO8601.
 * Examples: "call me back in 30 minutes", "tomorrow morning",
 * "remind me 1 hour before the meeting", "in 2 hours", "tomorrow at 4pm".
 *
 * Returns { ok, mode, when, atMs, timezone, phrase, remindBeforeMeetingMinutes? }
 * or { ok:false, error, code }.
 */
function parseNaturalCallbackWhen(phrase, opts = {}) {
  const raw = String(phrase || '').trim();
  if (!raw) return { ok: false, error: 'callback phrase required', code: 'bad_when' };
  const lower = raw.toLowerCase();
  const nowMs = Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();
  const appointmentStartMs = opts.appointmentStartAt
    ? Date.parse(String(opts.appointmentStartAt))
    : NaN;

  // ISO passthrough.
  if (/^\d{4}-\d{2}-\d{2}T/.test(raw)) {
    const info = normalizeWhen(raw);
    if (info.error) return { ok: false, error: info.error, code: info.code };
    return { ok: true, phrase: raw, timezone: DEFAULT_TZ, ...info };
  }

  // "remind me before (the) meeting" / "remind before meeting"
  const remindBefore = lower.match(
    /remind(?:\s+me)?(?:\s+(\d+)\s*(minutes?|mins?|hours?|hrs?))?\s+before(?:\s+the)?\s+meeting/,
  );
  if (remindBefore || /remind(?:\s+me)?\s+before(?:\s+the)?\s+meeting/.test(lower)) {
    let minutes = 60;
    if (remindBefore && remindBefore[1]) {
      const n = Number(remindBefore[1]);
      const unit = String(remindBefore[2] || 'minutes');
      minutes = /hour|hr/.test(unit) ? n * 60 : n;
    }
    if (!Number.isFinite(appointmentStartMs)) {
      return {
        ok: false,
        error: 'appointment start required for remind-before-meeting',
        code: 'missing_appointment',
        remindBeforeMeetingMinutes: minutes,
      };
    }
    const atMs = appointmentStartMs - minutes * 60 * 1000;
    if (atMs <= nowMs) {
      return { ok: false, error: 'reminder time is already past', code: 'bad_when' };
    }
    return {
      ok: true,
      mode: 'scheduled',
      when: new Date(atMs).toISOString(),
      atMs,
      timezone: DEFAULT_TZ,
      phrase: raw,
      remindBeforeMeetingMinutes: minutes,
    };
  }

  // "in N minutes/hours/days"
  const inMatch = lower.match(/\bin\s+(\d+)\s*(minutes?|mins?|hours?|hrs?|days?)\b/);
  if (inMatch) {
    const n = Number(inMatch[1]);
    const unit = inMatch[2];
    let delta = 0;
    if (/day/.test(unit)) delta = n * 24 * 60 * 60 * 1000;
    else if (/hour|hr/.test(unit)) delta = n * 60 * 60 * 1000;
    else delta = n * 60 * 1000;
    const atMs = nowMs + delta;
    return {
      ok: true,
      mode: 'scheduled',
      when: new Date(atMs).toISOString(),
      atMs,
      timezone: DEFAULT_TZ,
      phrase: raw,
    };
  }

  // "tomorrow morning" → 09:00 IST tomorrow
  if (/tomorrow\s+morning/.test(lower)) {
    const p = partsInKolkata(nowMs);
    const next = kolkataWallToUtcIso(p.y, p.m, p.d + 1, 9, 0, 0);
    return { ok: true, mode: 'scheduled', timezone: DEFAULT_TZ, phrase: raw, ...next };
  }

  // "tomorrow afternoon" → 14:00 IST
  if (/tomorrow\s+afternoon/.test(lower)) {
    const p = partsInKolkata(nowMs);
    const next = kolkataWallToUtcIso(p.y, p.m, p.d + 1, 14, 0, 0);
    return { ok: true, mode: 'scheduled', timezone: DEFAULT_TZ, phrase: raw, ...next };
  }

  // "tomorrow evening" → 18:00 IST
  if (/tomorrow\s+evening/.test(lower)) {
    const p = partsInKolkata(nowMs);
    const next = kolkataWallToUtcIso(p.y, p.m, p.d + 1, 18, 0, 0);
    return { ok: true, mode: 'scheduled', timezone: DEFAULT_TZ, phrase: raw, ...next };
  }

  // "tomorrow at 4pm" / "tomorrow at 16:00"
  const tomorrowAt = lower.match(/tomorrow\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/);
  if (tomorrowAt) {
    let hh = Number(tomorrowAt[1]);
    const mm = tomorrowAt[2] != null ? Number(tomorrowAt[2]) : 0;
    const ap = tomorrowAt[3];
    if (ap === 'pm' && hh < 12) hh += 12;
    if (ap === 'am' && hh === 12) hh = 0;
    const p = partsInKolkata(nowMs);
    const next = kolkataWallToUtcIso(p.y, p.m, p.d + 1, hh, mm, 0);
    return { ok: true, mode: 'scheduled', timezone: DEFAULT_TZ, phrase: raw, ...next };
  }

  // Bare "tomorrow" → 10:00 IST
  if (/\btomorrow\b/.test(lower)) {
    const p = partsInKolkata(nowMs);
    const next = kolkataWallToUtcIso(p.y, p.m, p.d + 1, 10, 0, 0);
    return { ok: true, mode: 'scheduled', timezone: DEFAULT_TZ, phrase: raw, ...next };
  }

  // Fallback: try Date.parse on the phrase
  const parsed = Date.parse(raw);
  if (Number.isFinite(parsed)) {
    const info = normalizeWhen(new Date(parsed).toISOString());
    if (info.error) return { ok: false, error: info.error, code: info.code };
    return { ok: true, phrase: raw, timezone: DEFAULT_TZ, ...info };
  }

  return {
    ok: false,
    error: 'could not parse callback timing (try "in 30 minutes", "tomorrow morning", or ISO8601)',
    code: 'bad_when',
  };
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
  let whenInfo;
  if (b.phrase || b.utterance || (b.when && !/^\d{4}-\d{2}-\d{2}T/.test(String(b.when)) && !/^now$/i.test(String(b.when)))) {
    const phrase = b.phrase || b.utterance || b.when;
    const natural = parseNaturalCallbackWhen(phrase, {
      appointmentStartAt: b.appointmentStartAt || b.appointment_start_at,
      nowMs: b.nowMs,
    });
    if (!natural.ok) {
      return { ok: false, status: 422, error: natural.error, code: natural.code };
    }
    whenInfo = natural;
  } else {
    whenInfo = normalizeWhen(b.when);
    if (whenInfo.error) {
      return { ok: false, status: 422, error: whenInfo.error, code: whenInfo.code };
    }
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
  parseNaturalCallbackWhen,
  partsInKolkata,
  kolkataWallToUtcIso,
  DEFAULT_TZ,
  summarizeCallResult,
};
