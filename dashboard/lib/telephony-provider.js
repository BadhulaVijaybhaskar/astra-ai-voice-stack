/**
 * Astra AI. TelephonyProvider control-plane interface + DograhVobiz adapter.
 *
 * The dashboard talks to numbers as Astra resources. Dograh/VoBiz stay behind
 * this adapter. Purchase is intentionally unimplemented in the V1 test phase
 * (platform-owned inventory only). Call history sync pulls Dograh runs when
 * reachable, otherwise seeds demo calls for UI testing.
 *
 * No em dashes anywhere. Commas and periods only.
 */
'use strict';

const providers = require('./providers');
const phoneNumbers = require('./phone-numbers');
const calls = require('./calls');

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

  async listCalls() {
    throw new TelephonyProviderError('listCalls is not implemented', 501, 'not_implemented');
  }

  async getCall() {
    throw new TelephonyProviderError('getCall is not implemented', 501, 'not_implemented');
  }

  async getRecording() {
    throw new TelephonyProviderError('getRecording is not implemented', 501, 'not_implemented');
  }

  async syncCalls() {
    throw new TelephonyProviderError('syncCalls is not implemented', 501, 'not_implemented');
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
    const workflows = require('./workflows');
    let result;
    await this.core.mutate((db) => {
      result = phoneNumbers.assignNumber(db, {
        numberId,
        tenantId,
        agentId: opts.agentId,
        inboundEnabled: opts.inboundEnabled,
        outboundEnabled: opts.outboundEnabled,
        inboundWorkflowId: opts.inboundWorkflowId,
        outboundWorkflowId: opts.outboundWorkflowId,
        resolveProviderWorkflowId: workflows.resolveProviderWorkflowId,
      });
    });
    if (!result.ok) {
      throw new TelephonyProviderError(result.error, result.status, result.code);
    }
    const db = this.core.db();
    const agentsById = new Map(
      (db.agents || [])
        .filter((a) => a.tenantId === tenantId)
        .map((a) => [a.id, a]),
    );
    const workflowsById = new Map(
      (db.workflows || [])
        .filter((w) => w.tenantId === tenantId)
        .map((w) => [w.id, w]),
    );
    return phoneNumbers.publicPhoneNumber(result.number, agentsById, workflowsById);
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
        if (!dialOpts.workflowId && ctx.workflowId) dialOpts.workflowId = ctx.workflowId;
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

  /**
   * List tenant call records from the Astra store (already synced / seeded).
   */
  async listCalls(tenantId, filters = {}) {
    if (!this.core) throw new TelephonyProviderError('core store is required', 500, 'misconfigured');
    const db = this.db();
    const agentsById = new Map(
      (db.agents || []).filter((a) => a.tenantId === tenantId).map((a) => [a.id, a]),
    );
    return calls.listTenantCalls(db, tenantId, filters)
      .map((c) => calls.publicCall(c, agentsById, { detail: false }));
  }

  async getCall(callId, tenantId) {
    if (!this.core) throw new TelephonyProviderError('core store is required', 500, 'misconfigured');
    const found = calls.findCallForTenant(this.db(), callId, tenantId);
    if (!found.ok) {
      throw new TelephonyProviderError(found.error, found.status, found.code);
    }
    const agentsById = new Map(
      (this.db().agents || []).filter((a) => a.tenantId === tenantId).map((a) => [a.id, a]),
    );
    return calls.publicCall(found.call, agentsById, { detail: true });
  }

  /**
   * Resolve recording for a tenant call. Prefer stored upstream URL redirect,
   * else try Dograh getCallRecording. Never returns API keys.
   */
  async getRecording(callId, tenantId) {
    if (!this.core) throw new TelephonyProviderError('core store is required', 500, 'misconfigured');
    const found = calls.findCallForTenant(this.db(), callId, tenantId);
    if (!found.ok) {
      throw new TelephonyProviderError(found.error, found.status, found.code);
    }
    const access = calls.recordingAccess(found.call);
    if (!access.available) {
      throw new TelephonyProviderError('recording not available', 404, 'recording_not_found');
    }
    if (access.upstreamUrl && /^https:\/\//i.test(access.upstreamUrl)) {
      return { mode: 'redirect', url: access.upstreamUrl };
    }
    const runId = found.call.providerRunId
      || (found.call.providerMetadata && found.call.providerMetadata.providerRunId);
    if (this.tel && typeof this.tel.getCallRecording === 'function' && runId) {
      try {
        const rec = await this.tel.getCallRecording(runId);
        if (rec && rec.available) {
          if (rec.redirectUrl) return { mode: 'redirect', url: rec.redirectUrl };
          if (rec.buffer) {
            return { mode: 'proxy', buffer: rec.buffer, contentType: rec.contentType || 'audio/mpeg' };
          }
        }
      } catch (_) { /* fall through to 404 */ }
    }
    throw new TelephonyProviderError('recording not available', 404, 'recording_not_found');
  }

  /**
   * Pull recent Dograh runs into Astra calls (idempotent on providerRunId).
   * If Dograh is unreachable or returns an unknown shape, seed demo calls
   * and accept optional manual import payloads.
   */
  async syncCalls(tenantId, options = {}) {
    if (!this.core) throw new TelephonyProviderError('core store is required', 500, 'misconfigured');
    const limit = Math.max(1, Math.min(100, Number(options.limit) || 20));
    let fetched = 0;
    let created = 0;
    let updated = 0;
    let stubbed = true;
    let endpoint = null;
    let reason = null;
    const tried = [];

    const dbSnap = this.db();
    const tenantAgents = (dbSnap.agents || []).filter((a) => a.tenantId === tenantId);
    const assignedNumber = (dbSnap.phoneNumbers || []).find(
      (n) => n.tenantId === tenantId && n.status === 'assigned',
    );
    const context = {
      agentId: tenantAgents[0] && tenantAgents[0].id,
      phoneNumberId: assignedNumber && assignedNumber.id,
      fromE164: assignedNumber && assignedNumber.e164,
      toE164: assignedNumber && assignedNumber.e164,
      workflowId: assignedNumber
        && assignedNumber.providerMetadata
        && assignedNumber.providerMetadata.inboundWorkflowId,
    };

    if (this.tel && typeof this.tel.listCallRuns === 'function' && this.tel.live) {
      try {
        const listed = await this.tel.listCallRuns({
          limit,
          workflowId: context.workflowId ? Number(context.workflowId) : undefined,
        });
        stubbed = !!listed.stubbed;
        endpoint = listed.endpoint || null;
        reason = listed.reason || null;
        if (Array.isArray(listed.tried)) tried.push(...listed.tried);
        const runs = Array.isArray(listed.runs) ? listed.runs : [];
        fetched = runs.length;
        if (runs.length) {
          await this.core.mutate((db) => {
            for (const run of runs) {
              const input = calls.mapDograhRunToCallInput(run, context);
              if (!input) continue;
              const r = calls.upsertCallFromProvider(db, tenantId, input);
              if (r.created) created += 1;
              if (r.updated) updated += 1;
            }
          });
        }
      } catch (e) {
        stubbed = true;
        reason = String((e && e.message) || e);
      }
    } else {
      reason = 'dograh_not_live';
      stubbed = true;
    }

    let imported = null;
    if (Array.isArray(options.import) && options.import.length) {
      await this.core.mutate((db) => {
        imported = calls.importCalls(db, tenantId, options.import);
        if (imported.ok) {
          created += imported.created || 0;
          updated += imported.updated || 0;
        }
      });
      if (imported && !imported.ok) {
        throw new TelephonyProviderError(imported.error, imported.status, imported.code);
      }
    }

    // When Dograh unreachable or yielded nothing, seed demo calls for UI testing.
    let demo = null;
    const existingCount = calls.listTenantCalls(this.db(), tenantId, { limit: 1 }).length;
    if (stubbed || fetched === 0) {
      await this.core.mutate((db) => {
        demo = calls.seedDemoCalls(db, tenantId, {
          agentId: context.agentId,
          phoneNumberId: context.phoneNumberId,
        });
        created += demo.created || 0;
        updated += demo.updated || 0;
      });
    }

    return {
      ok: true,
      stubbed,
      endpoint,
      reason,
      tried: tried.length ? tried : calls.DOGRAH_SYNC_CANDIDATES.slice(),
      candidates: calls.DOGRAH_SYNC_CANDIDATES.slice(),
      fetched,
      created,
      updated,
      imported: imported ? { created: imported.created, updated: imported.updated } : null,
      demoSeeded: !!(demo && (demo.created || demo.updated || existingCount === 0 || stubbed)),
      total: calls.listTenantCalls(this.db(), tenantId, { limit: 200 }).length,
    };
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
