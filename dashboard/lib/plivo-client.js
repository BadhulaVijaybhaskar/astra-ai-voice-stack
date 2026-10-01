/**
 * Astra Voice. Low-level Plivo REST API client (secondary telephony).
 *
 * Org-level credentials: PLIVO_AUTH_ID + PLIVO_AUTH_TOKEN.
 * Never log secrets. Never return Auth ID / Auth Token to callers of public
 * serializers. Live number purchase and live outbound dials are refused unless
 * explicit allow-flags are set (default off). Maya / production stays on VoBiz.
 *
 * No em dashes. Commas and periods only.
 */
'use strict';

const { httpsGet, httpsPost, httpsRequest } = require('./core');

const PLIVO_HOST = 'api.plivo.com';
const PLIVO_PREFIX = '/v1';

class PlivoClientError extends Error {
  constructor(message, status = 502, code = 'plivo_error', detail) {
    super(message);
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

function envAuth() {
  const authId = String(process.env.PLIVO_AUTH_ID || '').trim();
  const authToken = String(process.env.PLIVO_AUTH_TOKEN || '').trim();
  return { authId, authToken };
}

function credentialsConfigured(auth = envAuth()) {
  return !!(auth.authId && auth.authToken);
}

function livePurchaseAllowed() {
  return String(process.env.ASTRA_ALLOW_LIVE_NUMBER_PURCHASE || '').trim() === '1'
    && String(process.env.ASTRA_ALLOW_PLIVO_LIVE_PURCHASE || '').trim() === '1';
}

function liveDialAllowed() {
  return String(process.env.ASTRA_ALLOW_PLIVO_LIVE_DIAL || '').trim() === '1';
}

function basicAuthHeader(auth = envAuth()) {
  if (!credentialsConfigured(auth)) {
    throw new PlivoClientError(
      'Plivo credentials are not configured',
      503,
      'plivo_not_configured',
    );
  }
  const token = Buffer.from(`${auth.authId}:${auth.authToken}`, 'utf8').toString('base64');
  return {
    Authorization: `Basic ${token}`,
    Accept: 'application/json',
  };
}

function responseBody(up) {
  if (!up) return null;
  if (up.buffer != null) {
    return Buffer.isBuffer(up.buffer) ? up.buffer.toString('utf8') : String(up.buffer);
  }
  if (up.body != null) {
    return Buffer.isBuffer(up.body) ? up.body.toString('utf8') : String(up.body);
  }
  return null;
}

function parseJson(up) {
  const raw = responseBody(up);
  if (raw == null || raw === '') return null;
  try {
    return JSON.parse(raw);
  } catch (_) {
    return { raw: String(raw).slice(0, 400) };
  }
}

function upstreamMessage(data, fallback) {
  if (!data || typeof data !== 'object') return fallback;
  if (typeof data.error === 'string') return data.error;
  if (data.error && typeof data.error === 'object' && data.error.message) {
    return String(data.error.message);
  }
  return String(data.message || data.detail || fallback);
}

/**
 * Normalize a Plivo PhoneNumber / Number object into Astra marketplace shape.
 * Pricing fields are passed through only when present. Never invent fees.
 */
function normalizeInventoryItem(row) {
  if (!row || typeof row !== 'object') return null;
  const rawNumber = String(row.number || row.phone_number || row.e164 || '').trim();
  if (!rawNumber) return null;
  const digits = rawNumber.replace(/[^\d+]/g, '');
  const e164 = digits.startsWith('+') ? digits : ('+' + digits.replace(/^\+/, ''));

  const capabilities = [];
  if (row.voice_enabled === true || row.voice === true) {
    capabilities.push('inbound', 'outbound');
  }
  if (row.sms_enabled === true || row.sms === true) {
    if (!capabilities.includes('sms')) capabilities.push('sms');
  }
  if (row.mms_enabled === true || row.mms === true) {
    if (!capabilities.includes('mms')) capabilities.push('mms');
  }
  if (Array.isArray(row.capabilities)) {
    for (const c of row.capabilities) {
      const s = String(c || '').toLowerCase();
      if (s && !capabilities.includes(s)) capabilities.push(s);
    }
  }
  if (!capabilities.length) capabilities.push('inbound', 'outbound');

  const monthly = row.monthly_rental_rate != null ? Number(row.monthly_rental_rate)
    : (row.monthly_fee != null ? Number(row.monthly_fee) : null);
  const setup = row.setup_rate != null ? Number(row.setup_rate)
    : (row.setup_fee != null ? Number(row.setup_fee) : null);
  const voiceRate = row.voice_rate != null ? Number(row.voice_rate) : null;

  let numberType = null;
  const rawType = String(row.type || row.number_type || row.sub_type || '').toLowerCase();
  if (['local', 'mobile', 'tollfree', 'toll-free', 'national', 'fixed'].includes(rawType)) {
    numberType = rawType.replace('toll-free', 'tollfree').replace('fixed', 'local');
  } else if (row.region || row.city) {
    numberType = 'local';
  }

  return {
    e164,
    country: row.country || row.country_iso || null,
    region: row.region || row.city || null,
    city: row.city || null,
    area: row.region || row.city || null,
    numberType,
    capabilities,
    monthlyFee: Number.isFinite(monthly) ? monthly : null,
    setupFee: Number.isFinite(setup) ? setup : null,
    taxes: null,
    voiceRate: Number.isFinite(voiceRate) ? voiceRate : null,
    currency: row.currency || (row.monthly_rental_rate != null ? 'USD' : null),
    providerInventoryId: row.number ? String(row.number) : null,
    voiceEnabled: row.voice_enabled !== false,
    smsEnabled: row.sms_enabled === true,
    resourceUri: row.resource_uri || null,
    applicationId: row.application || row.app_id || null,
    alias: row.alias || row.friendly_name || null,
  };
}

function createPlivoClient(options = {}) {
  const auth = {
    authId: options.authId || envAuth().authId,
    authToken: options.authToken || envAuth().authToken,
  };
  const host = options.host || PLIVO_HOST;
  const prefix = options.prefix || PLIVO_PREFIX;
  const transport = options.transport || null;

  async function request(method, pathname, payload) {
    const headers = basicAuthHeader(auth);
    const verb = String(method || 'GET').toUpperCase();
    const path = pathname.startsWith('/v1') ? pathname : (prefix + pathname);
    if (transport && typeof transport.request === 'function') {
      return transport.request(verb, path, { headers, body: payload });
    }
    let up;
    if (verb === 'GET') {
      up = await httpsGet(host, path, headers);
    } else if (verb === 'POST') {
      const buf = Buffer.from(JSON.stringify(payload || {}));
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = buf.length;
      up = await httpsPost(host, path, headers, buf);
    } else {
      const buf = payload != null ? Buffer.from(JSON.stringify(payload)) : null;
      if (buf) {
        headers['Content-Type'] = 'application/json';
        headers['Content-Length'] = buf.length;
      }
      up = await httpsRequest(host, path, {
        method: verb,
        headers,
        bodyBuf: buf || undefined,
        timeoutMs: 30000,
      });
    }
    return { status: up.status, data: parseJson(up), headers: up.headers || {} };
  }

  function accountPath(suffix) {
    return `/Account/${encodeURIComponent(auth.authId)}${suffix || '/'}`;
  }

  return {
    id: 'plivo',
    get configured() { return credentialsConfigured(auth); },
    get livePurchaseAllowed() { return livePurchaseAllowed(); },
    get liveDialAllowed() { return liveDialAllowed(); },
    /** Never expose raw auth id in public payloads. Truncated fingerprint only. */
    authFingerprint() {
      if (!auth.authId) return null;
      const id = String(auth.authId);
      if (id.length <= 6) return '****';
      return id.slice(0, 2) + '****' + id.slice(-2);
    },

    async getAccount() {
      if (!credentialsConfigured(auth)) {
        throw new PlivoClientError('Plivo credentials are not configured', 503, 'plivo_not_configured');
      }
      const res = await request('GET', accountPath('/'));
      if (res.status < 200 || res.status >= 300) {
        throw new PlivoClientError(
          upstreamMessage(res.data, 'Plivo account lookup failed'),
          res.status === 401 || res.status === 403 ? 502 : (res.status >= 400 && res.status < 600 ? res.status : 502),
          res.status === 401 || res.status === 403 ? 'plivo_auth_failed' : 'plivo_account_failed',
          res.data,
        );
      }
      const data = res.data || {};
      return {
        ok: true,
        accountType: data.account_type || null,
        billingMode: data.billing_mode || null,
        cashCredits: data.cash_credits != null ? Number(data.cash_credits) : null,
        city: data.city || null,
        name: data.name || null,
        // Never return auth_id / auth_token.
      };
    },

    async getBalance() {
      const account = await this.getAccount();
      return {
        ok: true,
        cashCredits: account.cashCredits,
        currency: 'USD',
        available: account.cashCredits != null,
      };
    },

    async listOwnedNumbers(query = {}) {
      if (!credentialsConfigured(auth)) {
        throw new PlivoClientError('Plivo credentials are not configured', 503, 'plivo_not_configured');
      }
      const params = new URLSearchParams();
      if (query.type || query.numberType) {
        params.set('type', String(query.type || query.numberType));
      }
      if (query.services || query.capability) {
        params.set('services', String(query.services || query.capability));
      }
      params.set('limit', String(Math.min(20, Math.max(1, Number(query.limit) || 20))));
      params.set('offset', String(Math.max(0, Number(query.offset) || 0)));
      const qs = params.toString();
      const res = await request('GET', accountPath('/Number/') + (qs ? ('?' + qs) : ''));
      if (res.status < 200 || res.status >= 300) {
        throw new PlivoClientError(
          upstreamMessage(res.data, 'Could not list Plivo owned numbers'),
          res.status >= 400 && res.status < 600 ? res.status : 502,
          'plivo_list_failed',
          res.data,
        );
      }
      const objects = Array.isArray(res.data && res.data.objects) ? res.data.objects
        : (Array.isArray(res.data) ? res.data : []);
      return {
        ok: true,
        numbers: objects.map(normalizeInventoryItem).filter(Boolean),
        meta: res.data && res.data.meta ? res.data.meta : null,
        total: res.data && res.data.meta && res.data.meta.total_count != null
          ? res.data.meta.total_count
          : objects.length,
      };
    },

    /**
     * Search Plivo inventory. country_iso required for meaningful results.
     * Returns only what Plivo returns. Empty list means not available, not a fake catalog.
     */
    async searchAvailableNumbers(query = {}) {
      if (!credentialsConfigured(auth)) {
        throw new PlivoClientError('Plivo credentials are not configured', 503, 'plivo_not_configured');
      }
      const country = String(query.country || query.country_iso || 'IN').toUpperCase();
      const params = new URLSearchParams();
      params.set('country_iso', country);
      if (query.numberType || query.type) {
        params.set('type', String(query.numberType || query.type));
      }
      if (query.pattern || query.search || query.q || query.area || query.city) {
        params.set('pattern', String(query.pattern || query.search || query.q || query.area || query.city));
      }
      if (query.capability || query.services) {
        const cap = String(query.capability || query.services).toLowerCase();
        // Plivo services filter uses voice/sms/mms combinations.
        if (cap === 'inbound' || cap === 'outbound' || cap === 'voice') params.set('services', 'voice');
        else if (cap === 'sms') params.set('services', 'sms');
        else if (cap === 'mms') params.set('services', 'mms');
        else params.set('services', cap);
      }
      params.set('limit', String(Math.min(20, Math.max(1, Number(query.limit) || query.perPage || 20))));
      params.set('offset', String(Math.max(0, Number(query.offset) || 0)));
      const res = await request('GET', accountPath('/PhoneNumber/') + '?' + params.toString());
      if (res.status < 200 || res.status >= 300) {
        // Some accounts cannot search certain countries. Surface as not available
        // when Plivo returns 404 / empty, otherwise propagate.
        if (res.status === 404) {
          return {
            ok: true,
            source: 'plivo',
            country,
            numbers: [],
            available: false,
            reason: 'not_available',
          };
        }
        throw new PlivoClientError(
          upstreamMessage(res.data, 'Could not search Plivo inventory'),
          res.status >= 400 && res.status < 600 ? res.status : 502,
          'plivo_search_failed',
          res.data,
        );
      }
      const objects = Array.isArray(res.data && res.data.objects) ? res.data.objects : [];
      let numbers = objects.map((row) => {
        const n = normalizeInventoryItem({ ...row, country: row.country || country });
        return n;
      }).filter(Boolean);

      if (query.maxMonthlyFee != null) {
        const max = Number(query.maxMonthlyFee);
        numbers = numbers.filter((n) => n.monthlyFee == null || n.monthlyFee <= max);
      }
      if (query.numberType) {
        numbers = numbers.filter((n) => !n.numberType || n.numberType === query.numberType);
      }

      return {
        ok: true,
        source: 'plivo',
        country,
        numbers,
        available: numbers.length > 0,
        meta: res.data && res.data.meta ? res.data.meta : null,
        total: res.data && res.data.meta && res.data.meta.total_count != null
          ? res.data.meta.total_count
          : numbers.length,
      };
    },

    async getNumberPricing(e164OrQuery) {
      if (typeof e164OrQuery === 'string') {
        const listed = await this.searchAvailableNumbers({
          country: e164OrQuery.startsWith('+91') ? 'IN' : undefined,
          pattern: e164OrQuery.replace(/\D/g, '').slice(-10),
          limit: 20,
        });
        const match = (listed.numbers || []).find((n) => n.e164 === e164OrQuery
          || n.e164.replace(/\D/g, '') === String(e164OrQuery).replace(/\D/g, ''));
        if (!match) {
          throw new PlivoClientError('Number not found in Plivo inventory', 404, 'number_not_in_inventory');
        }
        return {
          ok: true,
          e164: match.e164,
          monthlyFee: match.monthlyFee,
          setupFee: match.setupFee,
          taxes: match.taxes,
          voiceRate: match.voiceRate,
          currency: match.currency,
          capabilities: match.capabilities,
          numberType: match.numberType,
          country: match.country,
          region: match.region,
        };
      }
      const country = String((e164OrQuery && e164OrQuery.country) || 'IN').toUpperCase();
      const params = new URLSearchParams();
      params.set('country_iso', country);
      const res = await request('GET', accountPath('/Pricing/') + '?' + params.toString());
      if (res.status < 200 || res.status >= 300) {
        throw new PlivoClientError(
          upstreamMessage(res.data, 'Could not read Plivo pricing'),
          res.status >= 400 && res.status < 600 ? res.status : 502,
          'plivo_pricing_failed',
          res.data,
        );
      }
      const data = res.data || {};
      const phoneNumbers = data.phone_numbers || data.PhoneNumbers || {};
      const voice = data.voice || data.Voice || {};
      return {
        ok: true,
        country,
        currency: data.country_iso || country,
        phoneNumbers,
        voice,
        // Country-level rates only. Per-number fees come from searchAvailableNumbers.
        rawKeys: Object.keys(data).filter((k) => k !== 'api_id'),
      };
    },

    async listApplications() {
      if (!credentialsConfigured(auth)) {
        throw new PlivoClientError('Plivo credentials are not configured', 503, 'plivo_not_configured');
      }
      const res = await request('GET', accountPath('/Application/'));
      if (res.status < 200 || res.status >= 300) {
        throw new PlivoClientError(
          upstreamMessage(res.data, 'Could not list Plivo applications'),
          res.status >= 400 && res.status < 600 ? res.status : 502,
          'plivo_application_failed',
          res.data,
        );
      }
      const objects = Array.isArray(res.data && res.data.objects) ? res.data.objects : [];
      return {
        ok: true,
        applications: objects.map((app) => ({
          appId: app.app_id || app.application_id || null,
          appName: app.app_name || app.name || null,
          answerUrl: app.answer_url || null,
          answerMethod: app.answer_method || null,
          hangupUrl: app.hangup_url || null,
          hangupMethod: app.hangup_method || null,
          fallbackAnswerUrl: app.fallback_answer_url || null,
        })),
      };
    },

    /**
     * Build Plivo XML for inbound answer / stream. Does not call the network.
     */
    buildAnswerXml(options = {}) {
      const parts = ['<?xml version="1.0" encoding="UTF-8"?>', '<Response>'];
      if (options.streamUrl) {
        const attrs = ['bidirectional="true"', 'keepCallAlive="true"'];
        if (options.contentType) {
          attrs.push(`contentType="${String(options.contentType)}"`);
        }
        parts.push(`  <Stream ${attrs.join(' ')}>${String(options.streamUrl)}</Stream>`);
      }
      if (options.speak) {
        parts.push(`  <Speak>${String(options.speak)}</Speak>`);
      }
      if (options.redirectUrl) {
        parts.push(`  <Redirect>${String(options.redirectUrl)}</Redirect>`);
      }
      parts.push('</Response>');
      return parts.join('\n');
    },

    /**
     * Outbound call initiation. Default is dry-run (returns payload, no POST).
     * Live POST only when options.execute===true AND ASTRA_ALLOW_PLIVO_LIVE_DIAL=1.
     */
    async initiateOutboundCall(opts = {}) {
      if (!credentialsConfigured(auth)) {
        throw new PlivoClientError('Plivo credentials are not configured', 503, 'plivo_not_configured');
      }
      const from = String(opts.from || '').trim();
      const to = String(opts.to || '').trim();
      const answerUrl = String(opts.answerUrl || opts.answer_url || '').trim();
      if (!from || !to || !answerUrl) {
        throw new PlivoClientError(
          'from, to, and answerUrl are required for Plivo outbound',
          422,
          'validation',
        );
      }
      const payload = {
        from,
        to,
        answer_url: answerUrl,
        answer_method: opts.answerMethod || 'POST',
      };
      if (opts.hangupUrl) payload.hangup_url = String(opts.hangupUrl);
      if (opts.hangupMethod) payload.hangup_method = String(opts.hangupMethod);
      if (opts.ringTimeout != null) payload.ring_timeout = Number(opts.ringTimeout);
      if (opts.callerName) payload.caller_name = String(opts.callerName);

      const endpoint = accountPath('/Call/');
      const execute = opts.execute === true && liveDialAllowed();
      if (!execute) {
        return {
          ok: true,
          dryRun: true,
          executed: false,
          endpoint: `https://${host}${endpoint}`,
          method: 'POST',
          payload,
          reason: liveDialAllowed()
            ? 'execute_flag_required'
            : 'plivo_live_dial_disabled',
        };
      }
      const res = await request('POST', endpoint, payload);
      if (res.status < 200 || res.status >= 300) {
        throw new PlivoClientError(
          upstreamMessage(res.data, 'Plivo outbound call failed'),
          res.status >= 400 && res.status < 600 ? res.status : 502,
          'plivo_dial_failed',
          res.data,
        );
      }
      return {
        ok: true,
        dryRun: false,
        executed: true,
        callUuid: (res.data && (res.data.request_uuid || res.data.call_uuid)) || null,
        data: res.data,
      };
    },

    /**
     * Documented audio streaming capability + optional mid-call Stream start hook.
     * Default dry-run. Live start requires execute + live dial allow flag.
     */
    audioStreamingCapability() {
      return {
        supported: true,
        transport: 'websocket',
        protocol: 'wss',
        xmlElement: 'Stream',
        apiPath: '/v1/Account/{auth_id}/Call/{call_uuid}/Stream/',
        contentTypes: [
          'audio/x-l16;rate=8000',
          'audio/x-l16;rate=16000',
        ],
        bidirectional: true,
        docs: 'Plivo Audio Streaming via <Stream> XML and Call Stream API',
      };
    },

    async startAudioStream(callUuid, opts = {}) {
      if (!credentialsConfigured(auth)) {
        throw new PlivoClientError('Plivo credentials are not configured', 503, 'plivo_not_configured');
      }
      const uuid = String(callUuid || '').trim();
      const serviceUrl = String(opts.serviceUrl || opts.wssUrl || '').trim();
      if (!uuid || !serviceUrl) {
        throw new PlivoClientError('callUuid and serviceUrl are required', 422, 'validation');
      }
      const payload = {
        service_url: serviceUrl,
        bidirectional: opts.bidirectional !== false,
        audio_track: opts.audioTrack || 'both',
        content_type: opts.contentType || 'audio/x-l16;rate=8000',
      };
      if (opts.statusCallbackUrl) payload.status_callback_url = String(opts.statusCallbackUrl);
      const endpoint = accountPath(`/Call/${encodeURIComponent(uuid)}/Stream/`);
      const execute = opts.execute === true && liveDialAllowed();
      if (!execute) {
        return {
          ok: true,
          dryRun: true,
          executed: false,
          endpoint: `https://${host}${endpoint}`,
          payload,
          capability: this.audioStreamingCapability(),
        };
      }
      const res = await request('POST', endpoint, payload);
      if (res.status < 200 || res.status >= 300) {
        throw new PlivoClientError(
          upstreamMessage(res.data, 'Plivo stream start failed'),
          res.status >= 400 && res.status < 600 ? res.status : 502,
          'plivo_stream_failed',
          res.data,
        );
      }
      return { ok: true, dryRun: false, executed: true, data: res.data };
    },

    async getRecordingMetadata(callUuid) {
      if (!credentialsConfigured(auth)) {
        throw new PlivoClientError('Plivo credentials are not configured', 503, 'plivo_not_configured');
      }
      const uuid = String(callUuid || '').trim();
      if (!uuid) {
        throw new PlivoClientError('callUuid is required', 422, 'validation');
      }
      const res = await request('GET', accountPath(`/Call/${encodeURIComponent(uuid)}/Record/`));
      if (res.status === 404) {
        return { ok: true, available: false, recordings: [] };
      }
      if (res.status < 200 || res.status >= 300) {
        throw new PlivoClientError(
          upstreamMessage(res.data, 'Could not read Plivo recording metadata'),
          res.status >= 400 && res.status < 600 ? res.status : 502,
          'plivo_recording_failed',
          res.data,
        );
      }
      const objects = Array.isArray(res.data && res.data.objects) ? res.data.objects
        : (Array.isArray(res.data && res.data.recordings) ? res.data.recordings : []);
      return {
        ok: true,
        available: objects.length > 0,
        recordings: objects.map((r) => ({
          recordingId: r.recording_id || r.id || null,
          callUuid: r.call_uuid || uuid,
          recordingUrl: r.recording_url || r.url || null,
          recordingDurationMs: r.recording_duration_ms != null
            ? Number(r.recording_duration_ms)
            : (r.recording_duration != null ? Number(r.recording_duration) * 1000 : null),
          recordingStartMs: r.recording_start_ms != null ? Number(r.recording_start_ms) : null,
          recordingEndMs: r.recording_end_ms != null ? Number(r.recording_end_ms) : null,
          // Never invent URLs. Pass through only.
        })),
      };
    },

    /**
     * Soft purchase gate. Always refuses unless both allow flags are set.
     * Default path for Astra: do not purchase on Plivo (secondary provider).
     */
    async purchaseNumber(e164) {
      if (!livePurchaseAllowed()) {
        throw new PlivoClientError(
          'Plivo number purchase is disabled. Secondary provider validation only.',
          403,
          'plivo_purchase_disabled',
        );
      }
      if (!credentialsConfigured(auth)) {
        throw new PlivoClientError('Plivo credentials are not configured', 503, 'plivo_not_configured');
      }
      const number = String(e164 || '').replace(/[^\d]/g, '');
      if (!number) {
        throw new PlivoClientError('e164 is required', 422, 'validation');
      }
      const res = await request('POST', accountPath(`/PhoneNumber/${encodeURIComponent(number)}/`), {});
      if (res.status < 200 || res.status >= 300) {
        throw new PlivoClientError(
          upstreamMessage(res.data, 'Plivo purchase failed'),
          res.status >= 400 && res.status < 600 ? res.status : 502,
          'plivo_purchase_failed',
          res.data,
        );
      }
      return { ok: true, data: res.data };
    },
  };
}

/**
 * In-memory mock used by unit tests. Never hits the network. Never charges.
 */
function createMockPlivoClient(seed = {}) {
  const inventory = Array.isArray(seed.inventory) ? seed.inventory.map((n) => ({ ...n })) : [];
  const owned = Array.isArray(seed.owned) ? seed.owned.map((n) => ({ ...n })) : [];
  const account = seed.account || {
    account_type: 'standard',
    billing_mode: 'prepaid',
    cash_credits: '12.50',
    name: 'Mock Plivo',
  };
  const applications = Array.isArray(seed.applications) ? seed.applications.slice() : [
    {
      app_id: 'app_mock_1',
      app_name: 'Astra Answer',
      answer_url: 'https://example.test/plivo/answer',
      answer_method: 'POST',
      hangup_url: 'https://example.test/plivo/hangup',
      hangup_method: 'POST',
    },
  ];
  const recordings = seed.recordings || {};

  const client = createPlivoClient({
    authId: 'MAOCKAUTHID',
    authToken: 'mock-plivo-token-value',
    transport: {
      async request(method, path, { body } = {}) {
        if (path.endsWith('/Account/MAOCKAUTHID/') || /\/Account\/MAOCKAUTHID\/?$/.test(path)) {
          return { status: 200, data: { ...account, auth_id: 'MAOCKAUTHID' } };
        }
        if (path.includes('/Number/')) {
          return {
            status: 200,
            data: {
              meta: { total_count: owned.length },
              objects: owned,
            },
          };
        }
        if (path.includes('/PhoneNumber/') && method === 'GET') {
          const url = new URL('https://api.plivo.com' + path);
          const country = (url.searchParams.get('country_iso') || 'IN').toUpperCase();
          let rows = inventory.filter((n) => {
            const c = String(n.country || n.country_iso || 'IN').toUpperCase();
            return c === country;
          });
          const pattern = url.searchParams.get('pattern');
          if (pattern) {
            const p = String(pattern).toLowerCase();
            rows = rows.filter((n) => String(n.number || '').includes(p)
              || String(n.city || '').toLowerCase().includes(p)
              || String(n.region || '').toLowerCase().includes(p));
          }
          return {
            status: 200,
            data: { meta: { total_count: rows.length }, objects: rows },
          };
        }
        if (path.includes('/PhoneNumber/') && method === 'POST') {
          return {
            status: 403,
            data: { error: 'mock refuses purchase' },
          };
        }
        if (path.includes('/Pricing/')) {
          return {
            status: 200,
            data: {
              country_iso: 'IN',
              phone_numbers: { local: { rate: '0.80' }, tollfree: { rate: '1.00' } },
              voice: { inbound: { rate: '0.003' }, outbound: { rate: '0.009' } },
            },
          };
        }
        if (path.includes('/Application/')) {
          return { status: 200, data: { objects: applications } };
        }
        if (path.includes('/Call/') && path.includes('/Record/')) {
          const m = path.match(/\/Call\/([^/]+)\/Record\//);
          const uuid = m ? decodeURIComponent(m[1]) : '';
          const list = recordings[uuid] || [];
          return { status: 200, data: { objects: list } };
        }
        if (path.includes('/Call/') && path.includes('/Stream/') && method === 'POST') {
          return { status: 200, data: { api_id: 'mock', stream_id: 'stream_mock' } };
        }
        if (path.includes('/Call/') && method === 'POST') {
          return {
            status: 200,
            data: { api_id: 'mock', request_uuid: 'req_mock_1', message: 'call queued' },
            body,
          };
        }
        return { status: 404, data: { error: 'not found in mock' } };
      },
    },
  });

  // Force configured true for mock fingerprint helpers.
  Object.defineProperty(client, 'configured', { get() { return true; } });
  client.id = 'plivo_mock';
  return client;
}

module.exports = {
  PlivoClientError,
  createPlivoClient,
  createMockPlivoClient,
  normalizeInventoryItem,
  credentialsConfigured,
  livePurchaseAllowed,
  liveDialAllowed,
  envAuth,
  PLIVO_HOST,
};
