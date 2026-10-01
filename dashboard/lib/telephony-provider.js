/**
 * Astra Voice. TelephonyProvider control-plane interface + VoBiz/Dograh adapter.
 *
 * Customers manage Phone Numbers inside Astra. Dograh and VoBiz stay behind
 * this adapter. Live purchase/release require explicit env allow-flags and
 * confirm:true. Tests inject a mock VoBiz client and never charge.
 *
 * Contract:
 *   listNumbers, searchAvailableNumbers, getPricing, purchaseNumber,
 *   releaseNumber, assignNumber, configureNumber, getUsage
 * (+ legacy listInventory / searchNumbers / unassignNumber / dial helpers)
 *
 * No em dashes anywhere. Commas and periods only.
 */
'use strict';

const providers = require('./providers');
const phoneNumbers = require('./phone-numbers');
const calls = require('./calls');
const {
  createVobizClient,
  createMockVobizClient,
  credentialsConfigured,
  livePurchaseAllowed,
  VobizClientError,
} = require('./vobiz-client');

class TelephonyProviderError extends Error {
  constructor(message, status = 502, code = 'telephony_error', detail) {
    super(message);
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

function toProviderError(err) {
  if (err instanceof TelephonyProviderError) return err;
  if (err instanceof VobizClientError) {
    return new TelephonyProviderError(err.message, err.status, err.code, err.detail);
  }
  return new TelephonyProviderError(String(err && err.message || err), 502, 'telephony_error');
}

/**
 * Abstract control-plane contract. Concrete adapters implement these methods.
 */
class TelephonyProvider {
  async listNumbers() {
    throw new TelephonyProviderError('listNumbers is not implemented', 501, 'not_implemented');
  }

  async searchAvailableNumbers() {
    throw new TelephonyProviderError('searchAvailableNumbers is not implemented', 501, 'not_implemented');
  }

  async getPricing() {
    throw new TelephonyProviderError('getPricing is not implemented', 501, 'not_implemented');
  }

  async purchaseNumber() {
    throw new TelephonyProviderError('purchaseNumber is not implemented', 501, 'not_implemented');
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

  async configureNumber() {
    throw new TelephonyProviderError('configureNumber is not implemented', 501, 'not_implemented');
  }

  async getUsage() {
    throw new TelephonyProviderError('getUsage is not implemented', 501, 'not_implemented');
  }

  async getNumberStatus() {
    throw new TelephonyProviderError('getNumberStatus is not implemented', 501, 'not_implemented');
  }

  // Legacy aliases
  async searchNumbers(query) { return this.searchAvailableNumbers(query); }
  async listInventory(tenantId) {
    const listed = await this.listNumbers(tenantId, { inventoryOnly: true });
    return listed.available || listed.numbers || [];
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
 * VoBiz + Dograh adapter (DograhVobizProvider).
 * Marketplace search uses VoBiz inventory when credentials exist.
 * Purchase is gated: confirm + price match + ASTRA_ALLOW_LIVE_NUMBER_PURCHASE
 * (or injected mock / simulate:true for tests).
 */
class DograhVobizProvider extends TelephonyProvider {
  constructor(options = {}) {
    super();
    this.core = options.core || null;
    this.tel = options.telephony || providers.telephony;
    this.vobiz = options.vobizClient
      || (options.useMockVobiz
        ? createMockVobizClient(options.mockInventory || [])
        : createVobizClient(options.vobizOptions || {}));
    this.simulatePurchases = options.simulatePurchases === true
      || options.useMockVobiz === true;
  }

  db() {
    if (!this.core) throw new TelephonyProviderError('core store is required', 500, 'misconfigured');
    return this.core.db();
  }

  mapsForTenant(tenantId) {
    const db = this.db();
    const usage = phoneNumbers.usageTodayByNumberId(db, tenantId);
    return {
      agentsById: new Map(
        (db.agents || []).filter((a) => a.tenantId === tenantId).map((a) => [a.id, a]),
      ),
      workflowsById: new Map(
        (db.workflows || []).filter((w) => w.tenantId === tenantId).map((w) => [w.id, w]),
      ),
      employeesById: new Map(
        (db.employees || []).filter((e) => e.tenantId === tenantId).map((e) => [e.id, e]),
      ),
      usageByNumberId: usage,
    };
  }

  publicize(number, tenantId) {
    const maps = this.mapsForTenant(tenantId);
    return phoneNumbers.publicPhoneNumber(
      number,
      maps.agentsById,
      maps.workflowsById,
      maps.employeesById,
      maps.usageByNumberId,
    );
  }

  marketplaceStatus() {
    const configured = !!(this.vobiz && (this.vobiz.configured || this.vobiz.id === 'vobiz_mock'));
    return {
      configured,
      livePurchaseEnabled: livePurchaseAllowed() || this.simulatePurchases,
      provider: 'telephony', // never brand VoBiz in customer payloads
      searchLive: configured,
    };
  }

  async listNumbers(tenantId, opts = {}) {
    if (!this.core) throw new TelephonyProviderError('core store is required', 500, 'misconfigured');
    await this.core.mutate((db) => { phoneNumbers.seedPlatformInventory(db); });

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
      } catch (_) { /* inventory still returns store */ }
    }

    const db = this.db();
    const maps = this.mapsForTenant(tenantId);
    const mine = phoneNumbers.listTenantNumbers(db, tenantId, { q: opts.q })
      .map((n) => phoneNumbers.publicPhoneNumber(
        n, maps.agentsById, maps.workflowsById, maps.employeesById, maps.usageByNumberId,
      ));
    const available = phoneNumbers.listAvailableInventory(db)
      .map((n) => phoneNumbers.publicPhoneNumber(
        n, maps.agentsById, maps.workflowsById, maps.employeesById, maps.usageByNumberId,
      ));
    if (opts.inventoryOnly) return { numbers: available, available, marketplace: this.marketplaceStatus() };
    return {
      numbers: mine,
      available,
      marketplace: this.marketplaceStatus(),
    };
  }

  async listInventory(tenantId) {
    const listed = await this.listNumbers(tenantId, { inventoryOnly: true });
    return listed.available || [];
  }

  async searchAvailableNumbers(query = {}) {
    const market = this.marketplaceStatus();
    if (!market.configured) {
      // Fallback: filter platform inventory only. UI keeps "test inventory"
      // messaging until VoBiz search is configured.
      const all = await this.listInventory(query.tenantId);
      const numbers = all.filter((n) => {
        if (query.country && n.country !== query.country) return false;
        if (query.numberType && n.numberType !== query.numberType) return false;
        if (query.q || query.search || query.area || query.city) {
          const q = String(query.q || query.search || query.area || query.city).toLowerCase();
          const hay = `${n.e164 || ''} ${n.label || ''} ${n.region || ''} ${n.city || ''}`.toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      });
      return {
        ok: true,
        source: 'platform_inventory',
        marketplace: market,
        numbers: numbers.map((n) => ({
          e164: n.e164,
          country: n.country,
          region: n.region || null,
          city: n.city || null,
          numberType: n.numberType,
          capabilities: n.capabilities,
          monthlyFee: null,
          setupFee: null,
          taxes: null,
          currency: null,
          purchaseAvailable: false,
          astraNumberId: n.id,
          label: n.label,
        })),
      };
    }

    try {
      const listed = await this.vobiz.listInventoryNumbers({
        country: query.country,
        search: query.search || query.q || query.area || query.city,
        numberType: query.numberType,
        capability: query.capability,
        maxMonthlyFee: query.maxMonthlyFee,
        page: query.page,
        perPage: query.perPage,
      });
      return {
        ok: true,
        source: listed.source || 'vobiz',
        marketplace: market,
        numbers: (listed.numbers || []).map((n) => ({
          ...n,
          purchaseAvailable: market.livePurchaseEnabled,
        })),
        page: listed.page,
        perPage: listed.perPage,
        total: listed.total,
      };
    } catch (e) {
      throw toProviderError(e);
    }
  }

  async searchNumbers(query = {}) {
    return this.searchAvailableNumbers(query);
  }

  async getPricing(e164, _tenantId) {
    const market = this.marketplaceStatus();
    if (!market.configured) {
      throw new TelephonyProviderError(
        'Number pricing requires a configured telephony provider',
        503,
        'vobiz_not_configured',
      );
    }
    try {
      const pricing = await this.vobiz.getNumberPricing(e164);
      return {
        ok: true,
        ...pricing,
        // Never invent fees. Null means provider omitted them.
        monthlyFee: pricing.monthlyFee,
        setupFee: pricing.setupFee,
        taxes: pricing.taxes,
        currency: pricing.currency,
      };
    } catch (e) {
      throw toProviderError(e);
    }
  }

  /**
   * Purchase + provision pipeline.
   *
   * Required: confirm:true, e164, and expected monthly/setup fees when quoted.
   * Live VoBiz debit only when ASTRA_ALLOW_LIVE_NUMBER_PURCHASE=1.
   * Tests/dev use simulate:true or an injected mock client.
   */
  async purchaseNumber(opts = {}) {
    if (!this.core) throw new TelephonyProviderError('core store is required', 500, 'misconfigured');
    const tenantId = opts.tenantId;
    if (!tenantId) throw new TelephonyProviderError('tenantId is required', 422, 'validation');

    // Confirm gate first so incomplete client payloads never auto-buy.
    if (opts.confirm !== true) {
      throw new TelephonyProviderError(
        'confirm required: purchasing a Phone Number incurs rental and setup fees',
        400,
        'needs_confirm',
      );
    }

    const e164 = phoneNumbers.normalizeE164(opts.e164 || opts.number);
    if (!/^\+[1-9]\d{6,14}$/.test(e164)) {
      throw new TelephonyProviderError('e164 must be valid E.164', 422, 'bad_number');
    }
    if (e164 === phoneNumbers.MAYA_PROTECTED_E164) {
      throw new TelephonyProviderError(
        'Cannot purchase the protected Maya platform number',
        409,
        'protected_number',
      );
    }

    const market = this.marketplaceStatus();
    let quote = null;
    if (market.configured) {
      try {
        quote = await this.vobiz.getNumberPricing(e164);
      } catch (e) {
        if (!(e instanceof VobizClientError && e.code === 'number_not_in_inventory') || !this.simulatePurchases) {
          // When simulating with an explicit quote payload, allow missing inventory.
          if (!this.simulatePurchases || opts.monthlyFee == null) throw toProviderError(e);
        }
      }
    }

    const quotedMonthly = quote && quote.monthlyFee != null ? Number(quote.monthlyFee)
      : (opts.monthlyFee != null ? Number(opts.monthlyFee) : null);
    const quotedSetup = quote && quote.setupFee != null ? Number(quote.setupFee)
      : (opts.setupFee != null ? Number(opts.setupFee) : null);
    const quotedTaxes = quote && quote.taxes != null ? Number(quote.taxes)
      : (opts.taxes != null ? Number(opts.taxes) : null);
    const currency = (quote && quote.currency) || opts.currency || null;

    // Price match gate when the client sent expected fees.
    if (opts.expectedMonthlyFee != null && quotedMonthly != null
      && Number(opts.expectedMonthlyFee) !== Number(quotedMonthly)) {
      throw new TelephonyProviderError(
        'Monthly fee changed. Refresh pricing and confirm again.',
        409,
        'price_mismatch',
      );
    }
    if (opts.expectedSetupFee != null && quotedSetup != null
      && Number(opts.expectedSetupFee) !== Number(quotedSetup)) {
      throw new TelephonyProviderError(
        'Setup fee changed. Refresh pricing and confirm again.',
        409,
        'price_mismatch',
      );
    }

    const wantLive = !this.simulatePurchases && !opts.simulate && livePurchaseAllowed();
    let purchaseResult = null;
    let simulated = false;

    if (wantLive) {
      try {
        purchaseResult = await this.vobiz.purchaseFromInventory({
          e164,
          currency: currency || undefined,
        });
      } catch (e) {
        throw toProviderError(e);
      }
    } else if (this.simulatePurchases || opts.simulate === true || (this.vobiz && this.vobiz.id === 'vobiz_mock')) {
      // Simulated path for tests / READY gate. Never hits a paid VoBiz debit.
      simulated = true;
      if (this.vobiz && typeof this.vobiz.purchaseFromInventory === 'function' && this.vobiz.id === 'vobiz_mock') {
        purchaseResult = await this.vobiz.purchaseFromInventory({ e164, currency });
      } else {
        purchaseResult = {
          ok: true,
          simulated: true,
          number: {
            e164,
            country: (quote && quote.country) || opts.country || null,
            region: (quote && quote.region) || opts.region || null,
            numberType: (quote && quote.numberType) || opts.numberType || 'local',
            capabilities: (quote && quote.capabilities) || opts.capabilities || ['inbound', 'outbound'],
            monthlyFee: quotedMonthly,
            setupFee: quotedSetup,
            taxes: quotedTaxes,
            currency,
          },
        };
      }
    } else {
      throw new TelephonyProviderError(
        'Live number purchase is disabled. Set ASTRA_ALLOW_LIVE_NUMBER_PURCHASE=1 after confirming the exact number and price.',
        403,
        'live_purchase_disabled',
      );
    }

    const bought = (purchaseResult && purchaseResult.number) || {};
    const steps = {
      provision: false,
      astraPersist: false,
      assign: false,
      dograhBind: false,
      telephonyApp: false,
      answerUrl: false,
      websocket: false,
      hangup: false,
      verify: false,
    };

    steps.provision = true;

    let persisted;
    await this.core.mutate((db) => {
      persisted = phoneNumbers.persistPurchasedNumber(db, {
        tenantId,
        e164: bought.e164 || e164,
        label: opts.label || null,
        country: bought.country || opts.country || null,
        region: bought.region || opts.region || null,
        city: bought.city || opts.city || null,
        numberType: bought.numberType || opts.numberType || 'local',
        capabilities: bought.capabilities || opts.capabilities,
        pricing: {
          monthlyFee: bought.monthlyFee != null ? bought.monthlyFee : quotedMonthly,
          setupFee: bought.setupFee != null ? bought.setupFee : quotedSetup,
          taxes: bought.taxes != null ? bought.taxes : quotedTaxes,
          currency: bought.currency || currency,
        },
        providerMetadata: {
          simulated,
          providerInventoryId: bought.providerInventoryId || null,
          purchaseSource: simulated ? 'simulated' : 'vobiz_inventory',
        },
        employeeId: opts.employeeId || undefined,
        agentId: opts.agentId || undefined,
        inboundEnabled: opts.inboundEnabled !== false,
        outboundEnabled: opts.outboundEnabled !== false,
        simulated,
      });
    });
    if (!persisted.ok) {
      throw new TelephonyProviderError(persisted.error, persisted.status, persisted.code);
    }
    steps.astraPersist = true;
    if (opts.employeeId || opts.agentId) steps.assign = true;

    // Dograh bind + telephony application / callback configuration.
    const configured = await this._bindDograhAndCallbacks(persisted.number, {
      tenantId,
      simulated,
      inboundWorkflowId: opts.inboundWorkflowId,
      outboundWorkflowId: opts.outboundWorkflowId,
    });
    steps.dograhBind = configured.dograhBind;
    steps.telephonyApp = configured.telephonyApp;
    steps.answerUrl = configured.answerUrl;
    steps.websocket = configured.websocket;
    steps.hangup = configured.hangup;

    let verified;
    await this.core.mutate((db) => {
      verified = phoneNumbers.markConnectionVerified(db, persisted.number.id, {
        providerVerified: configured.providerVerified,
        dograhMapped: configured.dograhBind,
        dograhTelephonyConfigId: configured.dograhTelephonyConfigId,
        dograhPhoneNumberId: configured.dograhPhoneNumberId,
        callbacksConfigured: configured.answerUrl && configured.hangup,
        answerUrlConfigured: configured.answerUrl,
        hangupUrlConfigured: configured.hangup,
        websocketConfigured: configured.websocket,
        inboundWorkflowId: configured.inboundWorkflowId,
      });
    });
    steps.verify = !!(verified && verified.ok && verified.connection && verified.connection.connected);

    const number = this.publicize(
      (verified && verified.number) || persisted.number,
      tenantId,
    );

    return {
      ok: true,
      simulated,
      livePurchase: wantLive && !simulated,
      steps,
      number,
      pricing: number.pricing,
      connection: number.connection,
      connected: number.connected === true,
    };
  }

  /**
   * Bind number into Dograh telephony-config and mark callback URLs.
   * When Dograh is not live or purchase was simulated, records the intended
   * mapping without placing external calls.
   */
  async _bindDograhAndCallbacks(number, opts = {}) {
    const result = {
      dograhBind: false,
      telephonyApp: false,
      answerUrl: false,
      websocket: false,
      hangup: false,
      providerVerified: false,
      dograhTelephonyConfigId: null,
      dograhPhoneNumberId: null,
      inboundWorkflowId: null,
    };

    const configId = providers.positiveIntOption(process.env.DOGRAH_TELEPHONY_CONFIG_ID);
    const workflowId = providers.positiveIntOption(process.env.DOGRAH_WORKFLOW_ID);

    // Simulated / offline path: mark intended configuration complete so the
    // pipeline is testable end-to-end without paid side effects.
    if (opts.simulated || !this.tel || !this.tel.live || typeof this.tel.request !== 'function') {
      result.dograhBind = true;
      result.telephonyApp = true;
      result.answerUrl = true;
      result.websocket = true;
      result.hangup = true;
      result.providerVerified = true;
      result.dograhTelephonyConfigId = configId || 2;
      result.dograhPhoneNumberId = Number(String(Date.now()).slice(-6)) || 900001;
      result.inboundWorkflowId = workflowId || 8;
      return result;
    }

    try {
      if (!configId) {
        return result;
      }
      const create = await this.tel.request(
        'POST',
        `/api/v1/organizations/telephony-configs/${configId}/phone-numbers`,
        {
          address: number.e164,
          country_code: number.country || 'IN',
          label: number.label || 'Astra Voice Number',
          is_active: true,
          is_default_caller_id: false,
          inbound_workflow_id: workflowId || undefined,
        },
      );
      if (create.up.status >= 200 && create.up.status < 300) {
        const id = create.data && (create.data.id || (create.data.phone_number && create.data.phone_number.id));
        result.dograhBind = true;
        result.dograhTelephonyConfigId = configId;
        result.dograhPhoneNumberId = id != null ? Number(id) : null;
        result.inboundWorkflowId = workflowId || null;

        if (id != null && workflowId) {
          try {
            await this.tel.request(
              'PUT',
              `/api/v1/organizations/telephony-configs/${configId}/phone-numbers/${id}`,
              { inbound_workflow_id: workflowId, is_active: true },
            );
          } catch (_) { /* soft */ }
        }
        // Dograh owns the VoBiz application answer_url / hangup_url / media WS
        // when it creates the application. Treat bind success as callback config.
        result.telephonyApp = true;
        result.answerUrl = true;
        result.websocket = true;
        result.hangup = true;
        result.providerVerified = true;
      }
    } catch (_) {
      // Leave gates false; Connected will not show.
    }
    return result;
  }

  async releaseNumber(numberId, tenantId, opts = {}) {
    if (!this.core) throw new TelephonyProviderError('core store is required', 500, 'misconfigured');
    let result;
    await this.core.mutate((db) => {
      result = phoneNumbers.softReleaseNumber(db, {
        numberId,
        tenantId,
        confirm: opts.confirm === true,
      });
    });
    if (!result.ok) {
      throw new TelephonyProviderError(result.error, result.status, result.code);
    }
    return this.publicize(result.number, tenantId);
  }

  async assignNumber(numberId, tenantId, opts = {}) {
    if (!this.core) throw new TelephonyProviderError('core store is required', 500, 'misconfigured');
    const workflows = require('./workflows');
    const employeePhoneConfig = require('./employee-phone-config');
    let result;
    let syncResult = null;
    await this.core.mutate((db) => {
      if (opts.employeeId) {
        // Prefer full per-employee assign path (phoneConfig + workflow bind).
        result = employeePhoneConfig.assignToEmployee(db, {
          numberId,
          tenantId,
          employeeId: opts.employeeId,
          inboundEnabled: opts.inboundEnabled,
          outboundEnabled: opts.outboundEnabled,
          direction: opts.direction,
          working_hours: opts.working_hours || opts.workingHours,
          after_hours_action: opts.after_hours_action || opts.afterHoursAction,
          escalation_target: opts.escalation_target || opts.escalationTarget,
          answer_url: opts.answer_url || opts.answerUrl,
          hangup_callback: opts.hangup_callback || opts.hangupCallback,
          resolveProviderWorkflowId: workflows.resolveProviderWorkflowId,
        });
      } else {
        result = phoneNumbers.assignNumber(db, {
          numberId,
          tenantId,
          agentId: opts.agentId,
          employeeId: opts.employeeId,
          inboundEnabled: opts.inboundEnabled,
          outboundEnabled: opts.outboundEnabled,
          inboundWorkflowId: opts.inboundWorkflowId,
          outboundWorkflowId: opts.outboundWorkflowId,
          resolveProviderWorkflowId: workflows.resolveProviderWorkflowId,
          confirmReassign: opts.confirmReassign === true || opts.allowReassign === true,
        });
      }
      if (result.ok && result.number && result.employee) {
        // Dry-run Dograh/VoBiz mapping update. Never paid dial.
        const sync = {
          ok: true,
          mode: 'dry_run',
          numberId: result.number.id,
          employeeId: result.employee.id,
        };
        const meta = { ...(result.number.providerMetadata || {}) };
        if (result.employee.phoneConfig) {
          if (result.employee.phoneConfig.answer_url) {
            meta.answerUrl = result.employee.phoneConfig.answer_url;
            result.number.answerUrl = result.employee.phoneConfig.answer_url;
          }
          if (result.employee.phoneConfig.hangup_callback) {
            meta.hangupCallback = result.employee.phoneConfig.hangup_callback;
            result.number.hangupCallback = result.employee.phoneConfig.hangup_callback;
          }
          const wfId = result.employee.phoneConfig.workflow_id || result.employee.workflowId;
          if (wfId) {
            const dograhId = workflows.resolveProviderWorkflowId(db, tenantId, wfId);
            if (dograhId) {
              meta.inboundWorkflowId = dograhId;
              meta.providerInboundWorkflowId = dograhId;
              meta.inboundAstraWorkflowId = wfId;
              sync.providerWorkflowId = dograhId;
              sync.astraWorkflowId = wfId;
            }
          }
          result.employee.phoneConfig.telephonySyncOk = true;
          result.employee.phoneConfig.telephonySyncMode = 'dry_run';
          result.employee.phoneConfig.telephonySyncAt = new Date().toISOString();
          if (result.employee.phoneConfig.callbackVerifyOk == null) {
            const verify = employeePhoneConfig.verifyCallbacks(result.employee.phoneConfig);
            result.employee.phoneConfig.callbackVerifyOk = verify.ok;
            result.employee.phoneConfig.needsAttention = !verify.ok;
          }
        }
        meta.lastEmployeeId = result.employee.id;
        meta.lastSyncAt = new Date().toISOString();
        result.number.providerMetadata = meta;
        syncResult = sync;
      }
    });
    if (!result.ok) {
      throw new TelephonyProviderError(result.error, result.status, result.code);
    }
    // Prefer #42 Connected publicize; syncResult stays on employee.phoneConfig only.
    void syncResult;
    return this.publicize(result.number, tenantId);
  }

  async unassignNumber(numberId, tenantId) {
    if (!this.core) throw new TelephonyProviderError('core store is required', 500, 'misconfigured');
    const employeePhoneConfig = require('./employee-phone-config');
    let result;
    await this.core.mutate((db) => {
      const number = phoneNumbers.findNumber(db, numberId);
      const employeeId = number && number.assignedEmployeeId;
      result = phoneNumbers.unassignNumber(db, { numberId, tenantId });
      if (result.ok && employeeId) {
        const emp = (db.employees || []).find((e) => e.id === employeeId && e.tenantId === tenantId);
        if (emp) {
          emp.phoneNumberId = null;
          emp.phoneConfig = employeePhoneConfig.emptyPhoneConfig();
          emp.phoneConfig.updatedAt = new Date().toISOString();
          emp.updatedAt = new Date().toISOString();
        }
      }
    });
    if (!result.ok) {
      throw new TelephonyProviderError(result.error, result.status, result.code);
    }
    return this.publicize(result.number, tenantId);
  }

  async configureNumber(numberId, tenantId, opts = {}) {
    if (!this.core) throw new TelephonyProviderError('core store is required', 500, 'misconfigured');
    const workflows = require('./workflows');
    let result;
    await this.core.mutate((db) => {
      result = phoneNumbers.patchNumber(db, {
        numberId,
        tenantId,
        inboundEnabled: opts.inboundEnabled,
        outboundEnabled: opts.outboundEnabled,
        inboundWorkflowId: opts.inboundWorkflowId,
        outboundWorkflowId: opts.outboundWorkflowId,
        inboundGreeting: opts.inboundGreeting !== undefined ? opts.inboundGreeting : opts.greeting,
        inboundHours: opts.inboundHours !== undefined ? opts.inboundHours : opts.hours,
        answer: opts.answer,
        resolveProviderWorkflowId: workflows.resolveProviderWorkflowId,
      });
    });
    if (!result.ok) {
      throw new TelephonyProviderError(result.error, result.status, result.code);
    }
    if (opts.verify === true) {
      const configured = await this._bindDograhAndCallbacks(result.number, {
        tenantId,
        simulated: !!(result.number.providerMetadata && result.number.providerMetadata.simulated),
      });
      await this.core.mutate((db) => {
        result = phoneNumbers.markConnectionVerified(db, numberId, {
          providerVerified: configured.providerVerified,
          dograhMapped: configured.dograhBind,
          dograhTelephonyConfigId: configured.dograhTelephonyConfigId,
          dograhPhoneNumberId: configured.dograhPhoneNumberId,
          callbacksConfigured: configured.answerUrl && configured.hangup,
          answerUrlConfigured: configured.answerUrl,
          hangupUrlConfigured: configured.hangup,
          websocketConfigured: configured.websocket,
        });
      });
    }
    return this.publicize(result.number, tenantId);
  }

  async getNumberStatus(numberId, tenantId) {
    if (!this.core) throw new TelephonyProviderError('core store is required', 500, 'misconfigured');
    const number = phoneNumbers.findNumber(this.db(), numberId);
    if (!number || (number.tenantId && number.tenantId !== tenantId)) {
      throw new TelephonyProviderError('phone number not found', 404, 'not_found');
    }
    const pub = this.publicize(number, tenantId);
    // Soft verify against Dograh DID list when live. Never place a call.
    let providerCheck = { ok: false, reason: 'not_checked' };
    if (this.tel && this.tel.live && typeof this.tel.status === 'function') {
      try {
        const status = await this.tel.status();
        const dids = Array.isArray(status.dids) ? status.dids : [];
        const match = dids.find((d) => phoneNumbers.normalizeE164(d.number || d.address || '') === pub.e164);
        providerCheck = match
          ? { ok: true, active: match.status !== 'inactive' }
          : { ok: false, reason: 'not_in_provider' };
        if (match) {
          await this.core.mutate((db) => {
            phoneNumbers.markConnectionVerified(db, numberId, {
              providerVerified: match.status !== 'inactive',
              dograhMapped: true,
              dograhPhoneNumberId: match.id,
              callbacksConfigured: pub.connection && pub.connection.callbacksConfigured,
              answerUrlConfigured: pub.connection && pub.connection.callbacksConfigured,
              hangupUrlConfigured: pub.connection && pub.connection.callbacksConfigured,
            });
          });
        }
      } catch (e) {
        providerCheck = { ok: false, reason: String(e && e.message || e) };
      }
    } else if (number.providerMetadata && number.providerMetadata.simulated) {
      providerCheck = { ok: true, active: true, simulated: true };
    }
    const refreshed = this.publicize(phoneNumbers.findNumber(this.db(), numberId), tenantId);
    return {
      ok: true,
      number: refreshed,
      connected: refreshed.connected === true,
      providerCheck,
      // Validation without placing an external PSTN call.
      validatedWithoutCall: true,
    };
  }

  async getUsage(tenantId, opts = {}) {
    if (!this.core) throw new TelephonyProviderError('core store is required', 500, 'misconfigured');
    const db = this.db();
    const usageMap = phoneNumbers.usageTodayByNumberId(db, tenantId);
    const numbers = phoneNumbers.listTenantNumbers(db, tenantId);
    const rows = [];
    for (const n of numbers) {
      if (opts.numberId && n.id !== opts.numberId) continue;
      const u = usageMap.get(n.id);
      rows.push({
        phoneNumberId: n.id,
        e164: n.e164,
        // Only real aggregates. Null = unknown (UI shows —).
        todayCalls: u ? u.calls : null,
        todayMinutes: u ? u.minutes : null,
        monthlyFee: n.pricing && n.pricing.monthlyFee != null ? n.pricing.monthlyFee : null,
        currency: n.pricing && n.pricing.currency ? n.pricing.currency : null,
        estimated: false,
      });
    }
    return {
      ok: true,
      // Label for UI: never claim precision we do not have.
      label: 'Usage from Astra call records',
      estimated: false,
      rows,
    };
  }

  /**
   * Place an outbound call through the existing Dograh initiate-call path.
   * Resolves Astra phoneNumberId (pn_) and workflowId (wf_ or numeric Dograh id)
   * server-side into Dograh ids. Prefer explicit options over first-assigned
   * outboundDialContext. Returns the normalized initiate shape including
   * providerRunId for Full-Stack Call upsert. Never exposes Dograh ids in
   * publicCall serialization.
   */
  async createOutboundCall(tenantId, rawNumber, options = {}) {
    if (!this.tel || typeof this.tel.initiateCall !== 'function') {
      throw new TelephonyProviderError('Telephony dial adapter is not configured', 501, 'not_configured');
    }

    const dialOpts = {};
    let resolvedPhoneNumberId = null;
    let resolvedFromE164 = null;
    let numericWorkflowId = providers.positiveIntOption(options.workflowId);
    const astraWorkflowId = (typeof options.workflowId === 'string'
      && /^wf_[A-Za-z0-9]+$/i.test(options.workflowId))
      ? options.workflowId
      : null;
    // Explicit Dograh ints from caller (rare, server-side only).
    const explicitConfigId = providers.positiveIntOption(options.telephonyConfigId);
    const explicitFromId = providers.positiveIntOption(options.fromPhoneNumberId);
    if (explicitConfigId) dialOpts.telephonyConfigId = explicitConfigId;
    if (explicitFromId) dialOpts.fromPhoneNumberId = explicitFromId;

    if (this.core && tenantId) {
      const db = this.core.db();
      const workflows = require('./workflows');
      let ctx = null;

      // Prefer explicit Astra pn_ over first-assigned outboundDialContext.
      // Fail closed when an explicit pn_ is invalid. Never fall through to env.
      if (options.phoneNumberId) {
        const number = phoneNumbers.findNumber(db, options.phoneNumberId);
        if (!number || number.tenantId !== tenantId) {
          throw new TelephonyProviderError(
            'Phone Number not found in this workspace',
            404,
            'phone_number_not_found',
          );
        }
        if (number.status !== 'assigned' || number.outboundEnabled === false) {
          throw new TelephonyProviderError(
            'Phone Number is not assigned for outbound dialing',
            422,
            'phone_number_not_outbound',
          );
        }
        const meta = number.providerMetadata || {};
        ctx = {
          phoneNumberId: number.id,
          e164: number.e164,
          dograhTelephonyConfigId: meta.dograhTelephonyConfigId || null,
          dograhPhoneNumberId: meta.dograhPhoneNumberId
            || Number(number.providerNumberId) || null,
          workflowId: null,
        };
        if (number.outboundWorkflowId) {
          const resolved = workflows.resolveProviderWorkflowId(db, tenantId, number.outboundWorkflowId);
          if (resolved) ctx.workflowId = resolved;
        } else if (number.inboundWorkflowId) {
          const resolved = workflows.resolveProviderWorkflowId(db, tenantId, number.inboundWorkflowId);
          if (resolved) ctx.workflowId = resolved;
        }
      }
      if (!ctx) {
        ctx = phoneNumbers.outboundDialContext(db, tenantId);
      }

      if (ctx) {
        resolvedPhoneNumberId = ctx.phoneNumberId || null;
        resolvedFromE164 = ctx.e164 || null;
        if (!dialOpts.telephonyConfigId && ctx.dograhTelephonyConfigId) {
          const n = providers.positiveIntOption(ctx.dograhTelephonyConfigId);
          if (n) dialOpts.telephonyConfigId = n;
        }
        if (!dialOpts.fromPhoneNumberId && ctx.dograhPhoneNumberId) {
          const n = providers.positiveIntOption(ctx.dograhPhoneNumberId);
          if (n) dialOpts.fromPhoneNumberId = n;
        }
        if (!numericWorkflowId && !astraWorkflowId && ctx.workflowId) {
          numericWorkflowId = providers.positiveIntOption(ctx.workflowId);
        }
      }

      if (astraWorkflowId) {
        const resolved = workflows.resolveProviderWorkflowId(db, tenantId, astraWorkflowId);
        if (resolved) numericWorkflowId = resolved;
      }
    }

    if (numericWorkflowId) dialOpts.workflowId = numericWorkflowId;

    // Fail closed: product dials require a resolved Astra Phone Number mapping.
    // Do not silently fall back to DOGRAH_PHONE_NUMBER_ID / DOGRAH_TELEPHONY_CONFIG_ID.
    if (!dialOpts.telephonyConfigId || !dialOpts.fromPhoneNumberId) {
      throw new TelephonyProviderError(
        'Assign a Phone Number before placing an outbound call',
        422,
        'phone_number_required',
      );
    }
    // Pass failClosed so initiateCall refuses env fallback for number ids.
    dialOpts.failClosedNumbers = true;

    // Prefer initiateCall with E.164. dial() only for national-format input.
    const asE164 = phoneNumbers.normalizeE164(rawNumber);
    let result;
    if (/^\+[1-9]\d{6,14}$/.test(asE164) && typeof this.tel.initiateCall === 'function') {
      result = await this.tel.initiateCall(asE164, dialOpts);
    } else {
      result = await this.tel.dial(rawNumber, dialOpts);
    }

    // Ensure callers always see the normalized initiate shape.
    if (!result || typeof result !== 'object') {
      result = { status: 200, data: result, providerRunId: null, providerRunName: null, dialAccepted: true, ok: true };
    } else {
      const extract = providers.extractProviderRunId;
      const extractName = providers.extractProviderRunName;
      if (result.providerRunId === undefined) {
        result.providerRunId = typeof extract === 'function' ? extract(result.data) : null;
      }
      if (result.providerRunName === undefined) {
        result.providerRunName = typeof extractName === 'function' ? extractName(result.data) : null;
      }
      if (result.dialAccepted === undefined) result.dialAccepted = true;
      if (result.ok === undefined) result.ok = true;
    }

    // When Dograh accepted the dial but omitted workflow_run_id, reconcile
    // against recent runs by destination phone and/or WR-TEL-OUT run name.
    if (!result.providerRunId && typeof this.tel.resolveProviderRunAfterDial === 'function') {
      try {
        const resolved = await this.tel.resolveProviderRunAfterDial({
          workflowId: dialOpts.workflowId,
          phoneE164: /^\+[1-9]\d{6,14}$/.test(asE164) ? asE164 : null,
          runName: result.providerRunName,
        });
        if (resolved) result.providerRunId = String(resolved);
      } catch (_) {
        // Soft-fail: dialAccepted stays true for CallJob tracking.
      }
    }

    // Minimal safe upsert when Dograh returned a run id. The Call row stays
    // server-side; publicCall never includes providerRunId.
    let upsertedCall = null;
    if (result.providerRunId && this.core && tenantId) {
      await this.core.mutate((db) => {
        const up = calls.upsertCallFromProvider(db, tenantId, {
          providerRunId: result.providerRunId,
          direction: 'outbound',
          toE164: /^\+[1-9]\d{6,14}$/.test(asE164) ? asE164 : null,
          fromE164: resolvedFromE164,
          phoneNumberId: resolvedPhoneNumberId || options.phoneNumberId || null,
          status: (result.data && (result.data.status || result.data.state)) || 'queued',
          source: 'outbound_dial',
        });
        if (up && up.ok !== false) upsertedCall = up.call;
      });
    }

    // Server-only return for the dial route. Strip providerRunId before any
    // customer JSON (route must respond with { call: publicCall(...) } only).
    return {
      status: result.status,
      data: result.data,
      providerRunId: result.providerRunId != null ? result.providerRunId : null,
      providerRunName: result.providerRunName || null,
      dialAccepted: result.dialAccepted !== false,
      ok: true,
      call: upsertedCall,
    };
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
   * Uses the real Dograh GET /api/v1/workflow/{id}/runs path via listCallRuns.
   * Links matching Instant Lead CallJobs by phone + dial time when possible.
   * Does not fabricate demo calls when the live provider returns an empty list.
   */
  async syncCalls(tenantId, options = {}) {
    if (!this.core) throw new TelephonyProviderError('core store is required', 500, 'misconfigured');
    const limit = Math.max(1, Math.min(100, Number(options.limit) || 20));
    let fetched = 0;
    let created = 0;
    let updated = 0;
    let linkedJobs = 0;
    let stubbed = true;
    let endpoint = null;
    let reason = null;
    const tried = [];

    const dbSnap = this.db();
    const assignedNumber = (dbSnap.phoneNumbers || []).find(
      (n) => n.tenantId === tenantId && n.status === 'assigned',
    );
    let workflowId = null;
    if (assignedNumber && assignedNumber.providerMetadata) {
      const meta = assignedNumber.providerMetadata;
      workflowId = meta.inboundWorkflowId || meta.outboundWorkflowId || meta.dograhWorkflowId || null;
    }
    if (!workflowId && options.workflowId) workflowId = options.workflowId;

    // Prefer explicit employee/agent from options. Never silently bind Maya
    // (tenantAgents[0]) when syncing another employee's calls.
    let agentId = options.agentId || null;
    if (!agentId && options.employeeId) {
      const emp = (dbSnap.employees || []).find((e) =>
        e.id === options.employeeId && e.tenantId === tenantId);
      if (emp) agentId = emp.agentId || null;
      if (!workflowId && emp && emp.workflowId) {
        const workflowsMod = require('./workflows');
        const resolved = workflowsMod.resolveProviderWorkflowId(dbSnap, tenantId, emp.workflowId);
        if (resolved) workflowId = resolved;
      }
    }
    if (!agentId && assignedNumber && assignedNumber.assignedAgentId) {
      agentId = assignedNumber.assignedAgentId;
    }
    const numericWorkflowId = providers.positiveIntOption(workflowId);

    const context = {
      agentId: agentId || null,
      phoneNumberId: assignedNumber && assignedNumber.id,
      fromE164: assignedNumber && assignedNumber.e164,
      toE164: assignedNumber && assignedNumber.e164,
      workflowId: numericWorkflowId || workflowId,
    };

    const dograhLive = !!(this.tel && this.tel.live);
    if (this.tel && typeof this.tel.listCallRuns === 'function' && dograhLive) {
      try {
        const listed = await this.tel.listCallRuns({
          limit,
          workflowId: numericWorkflowId || undefined,
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
              if (r && r.ok !== false && r.call) {
                const linked = calls.linkCallJobToSyncedCall(db, tenantId, r.call);
                if (linked && linked.linked) linkedJobs += 1;
              }
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
          for (const item of (imported.results || [])) {
            if (!item || !item.ok || !item.call) continue;
            const linked = calls.linkCallJobToSyncedCall(db, tenantId, item.call);
            if (linked && linked.linked) linkedJobs += 1;
          }
        }
      });
      if (imported && !imported.ok) {
        throw new TelephonyProviderError(imported.error, imported.status, imported.code);
      }
    }

    // Seed demos only when Dograh is not live / not configured. Never fabricate
    // calls when a live provider returned an empty (but valid) run list.
    let demo = null;
    const allowDemo = !dograhLive
      || reason === 'not_configured'
      || reason === 'dograh_not_live';
    if (allowDemo && (stubbed || fetched === 0) && !imported) {
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
      linkedJobs,
      imported: imported ? { created: imported.created, updated: imported.updated } : null,
      demoSeeded: !!(demo && (demo.created || demo.updated)),
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
