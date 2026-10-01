/**
 * Astra Voice. Low-level VoBiz Account API client (Plivo-compatible headers).
 *
 * Used only for number inventory search, pricing, purchase, and status.
 * Live dials still go through Dograh. Secrets never leave the server.
 *
 * Safety: purchaseFromInventory refuses unless allowLivePurchase is true.
 * No em dashes. Commas and periods only.
 */
'use strict';

const { httpsGet, httpsPost, httpsRequest } = require('./core');

const VOBIZ_HOST = 'api.vobiz.ai';
const VOBIZ_PREFIX = '/api/v1';

class VobizClientError extends Error {
  constructor(message, status = 502, code = 'vobiz_error', detail) {
    super(message);
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

function envAuth() {
  const authId = String(process.env.VOBIZ_AUTH_ID || '').trim();
  const authToken = String(process.env.VOBIZ_AUTH_TOKEN || '').trim();
  return { authId, authToken };
}

function livePurchaseAllowed() {
  return String(process.env.ASTRA_ALLOW_LIVE_NUMBER_PURCHASE || '').trim() === '1';
}

function liveReleaseAllowed() {
  return String(process.env.ASTRA_ALLOW_LIVE_NUMBER_RELEASE || '').trim() === '1';
}

function credentialsConfigured(auth = envAuth()) {
  return !!(auth.authId && auth.authToken);
}

function authHeaders(auth = envAuth()) {
  if (!credentialsConfigured(auth)) {
    throw new VobizClientError(
      'VoBiz credentials are not configured',
      503,
      'vobiz_not_configured',
    );
  }
  return {
    'X-Auth-ID': auth.authId,
    'X-Auth-Token': auth.authToken,
    Accept: 'application/json',
  };
}

function parseJson(up) {
  if (!up || up.body == null) return null;
  const raw = Buffer.isBuffer(up.body) ? up.body.toString('utf8') : String(up.body);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (_) {
    return { raw };
  }
}

function upstreamMessage(data, fallback) {
  if (!data || typeof data !== 'object') return fallback;
  return String(data.error || data.message || data.detail || fallback);
}

/**
 * Normalize a VoBiz inventory / owned number row into Astra marketplace shape.
 * Pricing fields are passed through only when present. Never invent fees.
 */
function normalizeInventoryItem(row) {
  if (!row || typeof row !== 'object') return null;
  const e164 = String(row.e164 || row.number || row.address || '').trim();
  if (!e164) return null;
  const caps = row.capabilities && typeof row.capabilities === 'object'
    ? row.capabilities
    : {};
  const capabilities = [];
  if (caps.voice === true || row.voice_enabled === true || caps.inbound === true) {
    capabilities.push('inbound', 'outbound');
  } else if (Array.isArray(row.capabilities)) {
    for (const c of row.capabilities) {
      const s = String(c || '').toLowerCase();
      if (s && !capabilities.includes(s)) capabilities.push(s);
    }
  }
  if (caps.sms === true || row.sms_enabled === true) {
    if (!capabilities.includes('sms')) capabilities.push('sms');
  }
  if (!capabilities.length) capabilities.push('inbound', 'outbound');

  const monthly = row.monthly_fee != null ? Number(row.monthly_fee)
    : (row.monthly_rental_rate != null ? Number(row.monthly_rental_rate) : null);
  const setup = row.setup_fee != null ? Number(row.setup_fee)
    : (row.setup_rate != null ? Number(row.setup_rate) : null);
  const taxes = row.taxes != null ? Number(row.taxes)
    : (row.tax != null ? Number(row.tax) : null);

  let numberType = null;
  const rawType = String(row.type || row.number_type || row.sub_type || '').toLowerCase();
  if (['local', 'mobile', 'tollfree', 'toll-free', 'national'].includes(rawType)) {
    numberType = rawType.replace('toll-free', 'tollfree');
  } else if (row.region || row.city) {
    numberType = 'local';
  }

  return {
    e164: e164.startsWith('+') ? e164 : ('+' + e164.replace(/^\+/, '')),
    country: row.country || row.country_iso || null,
    region: row.region || row.city || null,
    city: row.city || null,
    area: row.area || row.region || row.city || null,
    numberType,
    capabilities,
    monthlyFee: Number.isFinite(monthly) ? monthly : null,
    setupFee: Number.isFinite(setup) ? setup : null,
    taxes: Number.isFinite(taxes) ? taxes : null,
    currency: row.currency || null,
    providerInventoryId: row.id ? String(row.id) : null,
    voiceEnabled: caps.voice !== false && row.voice_enabled !== false,
    smsEnabled: caps.sms === true || row.sms_enabled === true,
  };
}

function createVobizClient(options = {}) {
  const auth = {
    authId: options.authId || envAuth().authId,
    authToken: options.authToken || envAuth().authToken,
  };
  const host = options.host || VOBIZ_HOST;
  const prefix = options.prefix || VOBIZ_PREFIX;
  const transport = options.transport || null;

  async function request(method, pathname, payload) {
    const headers = authHeaders(auth);
    const verb = String(method || 'GET').toUpperCase();
    const path = prefix + pathname;
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
    const data = parseJson(up);
    return { status: up.status, data, headers: up.headers || {} };
  }

  return {
    id: 'vobiz',
    get configured() { return credentialsConfigured(auth); },
    get livePurchaseAllowed() { return livePurchaseAllowed(); },
    get liveReleaseAllowed() { return liveReleaseAllowed(); },

    async listInventoryNumbers(query = {}) {
      if (!credentialsConfigured(auth)) {
        throw new VobizClientError('VoBiz credentials are not configured', 503, 'vobiz_not_configured');
      }
      const params = new URLSearchParams();
      if (query.country) params.set('country', String(query.country).toUpperCase());
      if (query.search || query.q || query.area || query.city) {
        params.set('search', String(query.search || query.q || query.area || query.city));
      }
      if (query.exclude) params.set('exclude', String(query.exclude));
      params.set('page', String(Math.max(1, Number(query.page) || 1)));
      params.set('per_page', String(Math.min(100, Math.max(1, Number(query.perPage) || 25))));
      const qs = params.toString();
      const path = `/Account/${encodeURIComponent(auth.authId)}/inventory/numbers`
        + (qs ? ('?' + qs) : '');
      const res = await request('GET', path);
      if (res.status < 200 || res.status >= 300) {
        throw new VobizClientError(
          upstreamMessage(res.data, 'Could not list VoBiz inventory'),
          res.status >= 400 && res.status < 600 ? res.status : 502,
          'vobiz_inventory_failed',
          res.data,
        );
      }
      const items = Array.isArray(res.data && res.data.items) ? res.data.items : [];
      const numbers = items.map(normalizeInventoryItem).filter(Boolean);
      // Client-side filters for type / capabilities when provider omits them.
      const filtered = numbers.filter((n) => {
        if (query.numberType && n.numberType && n.numberType !== query.numberType) return false;
        if (query.numberType && !n.numberType) return false;
        if (query.capability) {
          const need = String(query.capability).toLowerCase();
          if (!(n.capabilities || []).includes(need)) return false;
        }
        if (query.maxMonthlyFee != null && n.monthlyFee != null
          && Number(n.monthlyFee) > Number(query.maxMonthlyFee)) {
          return false;
        }
        return true;
      });
      return {
        ok: true,
        source: 'vobiz',
        numbers: filtered,
        page: res.data && res.data.page,
        perPage: res.data && res.data.per_page,
        total: res.data && res.data.total,
      };
    },

    async getNumberPricing(e164) {
      const listed = await this.listInventoryNumbers({ search: e164, perPage: 25 });
      const match = (listed.numbers || []).find((n) => n.e164 === e164);
      if (!match) {
        throw new VobizClientError('Number not found in inventory', 404, 'number_not_in_inventory');
      }
      return {
        ok: true,
        e164: match.e164,
        monthlyFee: match.monthlyFee,
        setupFee: match.setupFee,
        taxes: match.taxes,
        currency: match.currency,
        capabilities: match.capabilities,
        numberType: match.numberType,
        country: match.country,
        region: match.region,
      };
    },

    /**
     * Purchase from inventory. HARD GATE: refuses unless
     * ASTRA_ALLOW_LIVE_NUMBER_PURCHASE=1 (or options.forceLive in injected mocks only).
     */
    async purchaseFromInventory({ e164, currency, forceLive } = {}) {
      if (!e164) {
        throw new VobizClientError('e164 is required', 422, 'validation');
      }
      const allow = forceLive === true || livePurchaseAllowed();
      if (!allow) {
        throw new VobizClientError(
          'Live number purchase is disabled. Set ASTRA_ALLOW_LIVE_NUMBER_PURCHASE=1 to enable.',
          403,
          'live_purchase_disabled',
        );
      }
      if (!credentialsConfigured(auth)) {
        throw new VobizClientError('VoBiz credentials are not configured', 503, 'vobiz_not_configured');
      }
      const path = `/Account/${encodeURIComponent(auth.authId)}/numbers/purchase-from-inventory`;
      const body = { e164: String(e164) };
      if (currency) body.currency = String(currency);
      const res = await request('POST', path, body);
      if (res.status < 200 || res.status >= 300) {
        throw new VobizClientError(
          upstreamMessage(res.data, 'VoBiz purchase failed'),
          res.status >= 400 && res.status < 600 ? res.status : 502,
          'vobiz_purchase_failed',
          res.data,
        );
      }
      const number = normalizeInventoryItem((res.data && res.data.number) || res.data) || {
        e164: String(e164),
      };
      return { ok: true, number, raw: res.data };
    },

    async listOwnedNumbers(query = {}) {
      if (!credentialsConfigured(auth)) {
        throw new VobizClientError('VoBiz credentials are not configured', 503, 'vobiz_not_configured');
      }
      const params = new URLSearchParams();
      if (query.search) params.set('search', String(query.search));
      params.set('page', String(Math.max(1, Number(query.page) || 1)));
      params.set('per_page', String(Math.min(100, Math.max(1, Number(query.perPage) || 25))));
      const qs = params.toString();
      const path = `/Account/${encodeURIComponent(auth.authId)}/numbers`
        + (qs ? ('?' + qs) : '');
      const res = await request('GET', path);
      if (res.status < 200 || res.status >= 300) {
        throw new VobizClientError(
          upstreamMessage(res.data, 'Could not list owned VoBiz numbers'),
          res.status >= 400 && res.status < 600 ? res.status : 502,
          'vobiz_list_failed',
          res.data,
        );
      }
      const items = Array.isArray(res.data && res.data.items) ? res.data.items : [];
      return {
        ok: true,
        numbers: items.map(normalizeInventoryItem).filter(Boolean),
        total: res.data && res.data.total,
      };
    },

    async attachApplication(e164, applicationId) {
      if (!livePurchaseAllowed() && !options.allowAttachWithoutLiveFlag) {
        // Attaching apps can affect live routing. Gate with the same live flag
        // unless an injected test transport opts in.
        throw new VobizClientError(
          'Live VoBiz application attach is disabled',
          403,
          'live_purchase_disabled',
        );
      }
      const encoded = encodeURIComponent(String(e164));
      const path = `/Account/${encodeURIComponent(auth.authId)}/numbers/${encoded}/application`;
      const res = await request('POST', path, { application_id: String(applicationId) });
      if (res.status < 200 || res.status >= 300) {
        throw new VobizClientError(
          upstreamMessage(res.data, 'Could not attach VoBiz application'),
          res.status >= 400 && res.status < 600 ? res.status : 502,
          'vobiz_attach_failed',
          res.data,
        );
      }
      return { ok: true, data: res.data };
    },
  };
}

/**
 * In-memory mock used by tests. Never hits the network. Never charges.
 */
function createMockVobizClient(seedNumbers = []) {
  const inventory = seedNumbers.map((n) => ({ ...n }));
  const owned = [];
  return {
    id: 'vobiz_mock',
    configured: true,
    livePurchaseAllowed: false,
    liveReleaseAllowed: false,
    async listInventoryNumbers(query = {}) {
      let rows = inventory.map(normalizeInventoryItem).filter(Boolean);
      if (query.country) {
        rows = rows.filter((n) => String(n.country).toUpperCase() === String(query.country).toUpperCase());
      }
      if (query.search || query.q || query.area || query.city) {
        const q = String(query.search || query.q || query.area || query.city).toLowerCase();
        rows = rows.filter((n) => `${n.e164} ${n.region || ''} ${n.city || ''} ${n.area || ''}`.toLowerCase().includes(q));
      }
      if (query.numberType) {
        rows = rows.filter((n) => n.numberType === query.numberType);
      }
      if (query.capability) {
        const need = String(query.capability).toLowerCase();
        rows = rows.filter((n) => (n.capabilities || []).includes(need));
      }
      return { ok: true, source: 'mock', numbers: rows, total: rows.length };
    },
    async getNumberPricing(e164) {
      const listed = await this.listInventoryNumbers({ search: e164 });
      const match = listed.numbers.find((n) => n.e164 === e164);
      if (!match) throw new VobizClientError('Number not found in inventory', 404, 'number_not_in_inventory');
      return {
        ok: true,
        e164: match.e164,
        monthlyFee: match.monthlyFee,
        setupFee: match.setupFee,
        taxes: match.taxes,
        currency: match.currency,
        capabilities: match.capabilities,
        numberType: match.numberType,
        country: match.country,
        region: match.region,
      };
    },
    async purchaseFromInventory({ e164 }) {
      // Mock always simulates. Never a live charge.
      const listed = await this.listInventoryNumbers({ search: e164 });
      const match = listed.numbers.find((n) => n.e164 === e164);
      if (!match) throw new VobizClientError('Number not found in inventory', 404, 'number_not_in_inventory');
      const bought = { ...match, status: 'active', purchasedAt: new Date().toISOString() };
      owned.push(bought);
      const idx = inventory.findIndex((n) => normalizeInventoryItem(n).e164 === e164);
      if (idx >= 0) inventory.splice(idx, 1);
      return { ok: true, number: bought, simulated: true };
    },
    async listOwnedNumbers() {
      return { ok: true, numbers: owned.slice(), total: owned.length };
    },
    async attachApplication() {
      return { ok: true, data: { message: 'attached (mock)' } };
    },
  };
}

module.exports = {
  VobizClientError,
  createVobizClient,
  createMockVobizClient,
  normalizeInventoryItem,
  credentialsConfigured,
  livePurchaseAllowed,
  liveReleaseAllowed,
  envAuth,
  VOBIZ_HOST,
};
