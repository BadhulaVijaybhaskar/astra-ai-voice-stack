/**
 * Astra AI. TelephonyProvider control-plane interface + DograhVobiz adapter.
 *
 * The dashboard talks to numbers as Astra resources. Dograh/VoBiz stay behind
 * this adapter. Purchase is intentionally unimplemented in the V1 test phase
 * (platform-owned inventory only).
 *
 * No em dashes anywhere. Commas and periods only.
 */
'use strict';

const providers = require('./providers');
const phoneNumbers = require('./phone-numbers');

class TelephonyProviderError extends Error {
  constructor(message, status = 502, code = 'telephony_error', detail) {
    super(message);
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

/**
 * Abstract control-plane contract. Concrete adapters implement these methods.
 * Stubs for getCall / getRecording / handleWebhook are fine until call history
 * lands in a later sprint.
 */
class TelephonyProvider {
  async searchNumbers() {
    throw new TelephonyProviderError('searchNumbers is not implemented', 501, 'not_implemented');
  }

  async listInventory() {
    throw new TelephonyProviderError('listInventory is not implemented', 501, 'not_implemented');
  }

  async purchaseNumber() {
    throw new TelephonyProviderError('Number purchase is not available in the testing phase', 501, 'purchase_deferred');
  }

  async releaseNumber() {
    throw new TelephonyProviderError('releaseNumber is not implemented', 501, 'not_implemented');
  }

  async assignNumber() {
    throw new TelephonyProviderError('assignNumber is not implemented', 501, 'not_implemented');
  }

  async unassignNumber() {
    throw new TelephonyProviderError('unassignNumber is not implemented', 501, 'not_implemented');
  }

  async createOutboundCall() {
    throw new TelephonyProviderError('createOutboundCall is not implemented', 501, 'not_implemented');
  }

  async getCall() {
    throw new TelephonyProviderError('getCall is not implemented', 501, 'not_implemented');
  }

  async getRecording() {
    throw new TelephonyProviderError('getRecording is not implemented', 501, 'not_implemented');
  }

  async handleWebhook() {
    throw new TelephonyProviderError('handleWebhook is not implemented', 501, 'not_implemented');
  }
}

/**
 * Dograh + VoBiz adapter. Uses existing DOGRAH_* env and providers.telephony
 * for live dial / status when configured. Inventory is the seeded JSON store
 * (plus optional Dograh sync when credentials are live).
 */
class DograhVobizProvider extends TelephonyProvider {
  constructor(options = {}) {
    super();
    this.core = options.core || null;
    this.tel = options.telephony || providers.telephony;
  }

  db() {
    if (!this.core) throw new TelephonyProviderError('core store is required', 500, 'misconfigured');
    return this.core.db();
  }

  async listInventory(tenantId) {
    if (!this.core) throw new TelephonyProviderError('core store is required', 500, 'misconfigured');
    // Ensure seed exists under the write lock (idempotent).
    await this.core.mutate((db) => { phoneNumbers.seedPlatformInventory(db); });

    // Optional sync: when Dograh is live, refresh labels from upstream without
    // exposing provider ids to callers of this method's public shape.
    if (this.tel && this.tel.live) {
      try {
        const status = await this.tel.status();
        const dids = Array.isArray(status.dids) ? status.dids : [];
        await this.core.mutate((db) => {
          for (const did of dids) {
            const e164 = phoneNumbers.normalizeE164(did.number || did.address || '');
            if (!e164) continue;
            const match = (db.phoneNumbers || []).find((n) => phoneNumbers.normalizeE164(n.e164) === e164);
            if (match && did.label && !match.label) {
              match.label = String(did.label).slice(0, 80);
              match.updatedAt = new Date().toISOString();
            }
          }
        });
      } catch (_) {
        // Inventory still returns the seeded store when Dograh is unreachable.
      }
    }

    const db = this.db();
    const available = phoneNumbers.listAvailableInventory(db);
    const agentsById = new Map((db.agents || []).filter((a) => a.tenantId === tenantId).map((a) => [a.id, a]));
    return available.map((n) => phoneNumbers.publicPhoneNumber(n, agentsById));
  }

  async searchNumbers(query = {}) {
    // Test phase: search is inventory filtered by country / type if provided.
    const all = await this.listInventory(query.tenantId);
    return all.filter((n) => {
      if (query.country && n.country !== query.country) return false;
      if (query.numberType && n.numberType !== query.numberType) return false;
      if (query.q) {
        const q = String(query.q).toLowerCase();
        const hay = `${n.e164 || ''} ${n.label || ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }

  async purchaseNumber() {
    throw new TelephonyProviderError(
      'Number purchase is deferred. Use available platform inventory during testing.',
      501,
      'purchase_deferred',
    );
  }

  async releaseNumber(numberId, tenantId) {
    if (!this.core) throw new TelephonyProviderError('core store is required', 500, 'misconfigured');
    let result;
    await this.core.mutate((db) => {
      result = phoneNumbers.softReleaseNumber(db, { numberId, tenantId });
    });
    if (!result.ok) {
      throw new TelephonyProviderError(result.error, result.status, result.code);
    }
    return phoneNumbers.publicPhoneNumber(result.number);
  }

  async assignNumber(numberId, tenantId, opts = {}) {
    if (!this.core) throw new TelephonyProviderError('core store is required', 500, 'misconfigured');
    let result;
    await this.core.mutate((db) => {
      result = phoneNumbers.assignNumber(db, {
        numberId,
        tenantId,
        agentId: opts.agentId,
        inboundEnabled: opts.inboundEnabled,
        outboundEnabled: opts.outboundEnabled,
      });
    });
    if (!result.ok) {
      throw new TelephonyProviderError(result.error, result.status, result.code);
    }
    const agentsById = new Map(
      (this.core.db().agents || [])
        .filter((a) => a.tenantId === tenantId)
        .map((a) => [a.id, a]),
    );
    return phoneNumbers.publicPhoneNumber(result.number, agentsById);
  }

  async unassignNumber(numberId, tenantId) {
    if (!this.core) throw new TelephonyProviderError('core store is required', 500, 'misconfigured');
    let result;
    await this.core.mutate((db) => {
      result = phoneNumbers.unassignNumber(db, { numberId, tenantId });
    });
    if (!result.ok) {
      throw new TelephonyProviderError(result.error, result.status, result.code);
    }
    return phoneNumbers.publicPhoneNumber(result.number);
  }

  /**
   * Place an outbound call through the existing Dograh initiate-call path.
   * Prefers the tenant's assigned number Dograh ids when present.
   */
  async createOutboundCall(tenantId, rawNumber, options = {}) {
    if (!this.tel || typeof this.tel.initiateCall !== 'function') {
      throw new TelephonyProviderError('Telephony dial adapter is not configured', 501, 'not_configured');
    }
    const dialOpts = { ...options };
    if (this.core && tenantId) {
      const ctx = phoneNumbers.outboundDialContext(this.core.db(), tenantId);
      if (ctx) {
        if (ctx.dograhTelephonyConfigId) dialOpts.telephonyConfigId = ctx.dograhTelephonyConfigId;
        if (ctx.dograhPhoneNumberId) dialOpts.fromPhoneNumberId = ctx.dograhPhoneNumberId;
      }
    }

    // Prefer initiateCall with E.164 when the input looks like E.164; else dial().
    const asE164 = phoneNumbers.normalizeE164(rawNumber);
    if (/^\+[1-9]\d{6,14}$/.test(asE164) && typeof this.tel.initiateCall === 'function') {
      // providers.telephony.initiateCall currently reads env for config/from ids.
      // Pass through dial() for national format compatibility when Indian mobile.
      const digits = phoneNumbers.digitsOnly(asE164);
      if (digits.length === 12 && digits.startsWith('91')) {
        return this.tel.dial(digits.slice(2), dialOpts);
      }
      return this.tel.initiateCall(asE164, dialOpts);
    }
    return this.tel.dial(rawNumber, dialOpts);
  }

  async getCall() {
    throw new TelephonyProviderError('Call detail is not available yet', 501, 'not_implemented');
  }

  async getRecording() {
    throw new TelephonyProviderError('Recordings are not available yet', 501, 'not_implemented');
  }

  async handleWebhook() {
    throw new TelephonyProviderError('Telephony webhooks are not wired yet', 501, 'not_implemented');
  }
}

function createDefaultTelephonyProvider(core) {
  return new DograhVobizProvider({ core, telephony: providers.telephony });
}

module.exports = {
  TelephonyProvider,
  DograhVobizProvider,
  TelephonyProviderError,
  createDefaultTelephonyProvider,
};
