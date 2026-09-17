/**
 * Astra AI. Organization / workspace helpers and secret-safe provider health.
 *
 * Tenants are the persistence unit. Product copy uses "workspace" (and
 * occasionally "organization") for the same record. Provider secrets stay in
 * .env only. APIs and admin UI may report configured true/false and env key
 * NAMES, never values.
 *
 * No em dashes anywhere. Commas and periods only.
 */
'use strict';

const ROLE_LEVEL = Object.freeze({
  member: 1,
  owner: 2,
  admin: 3,
  super_admin: 4,
});

const SENSITIVE_ACTIONS = Object.freeze([
  'auth.signup',
  'tenant.updated',
  'tenant.privacy_mode.updated',
  'member.role.updated',
  'telephony.byon.created',
  'billing.payment_intent.created',
  'billing.payment.credited',
  'admin.wallet.adjusted',
  'admin.user.role',
  'admin.user.status',
  'admin.tenant.status',
  'admin.impersonation.started',
  'admin.impersonation.ended',
]);

function roleAtLeast(role, minimum) {
  return (ROLE_LEVEL[role] || 0) >= (ROLE_LEVEL[minimum] || 99);
}

/**
 * Normalize tenant public fields so UI can say workspace/organization without
 * inventing a second store.
 */
function publicWorkspace(tenant) {
  const t = tenant || {};
  const planId = (!t.plan || t.plan === 'studio') ? 'starter' : t.plan;
  return {
    id: t.id,
    name: t.name,
    slug: t.slug,
    workspaceName: t.name,
    organizationName: t.name,
    createdAt: t.createdAt,
    branding: t.branding,
    providers: t.providers,
    plan: planId,
    includedNumbers: t.includedNumbers != null ? t.includedNumbers : (planId === 'scale' ? 10 : planId === 'growth' ? 3 : 1),
    status: t.status || 'active',
    privacyMode: t.privacyMode || 'standard',
  };
}

function sanitizeTenantUpdate(body) {
  const b = body && typeof body === 'object' ? body : {};
  const name = String(b.name || b.workspaceName || b.organizationName || '').trim().slice(0, 80);
  const colorRaw = String(b.color || (b.branding && b.branding.color) || '').trim();
  const color = /^#[0-9a-fA-F]{6}$/.test(colorRaw) ? colorRaw : null;
  if (!name) {
    return { ok: false, status: 422, error: 'workspace name required', code: 'bad_name' };
  }
  return { ok: true, name, color };
}

/**
 * Build a provider health payload with configured booleans and env key names only.
 * Never includes secret values.
 */
function providerHealthSummary(described) {
  const layers = ['stt', 'tts', 'llm', 'telephony'];
  const out = {};
  for (const layer of layers) {
    out[layer] = (described[layer] || []).map((item) => ({
      id: item.id,
      label: item.label,
      configured: !!item.live,
      selected: !!item.selected,
      needs: Array.isArray(item.needs) ? item.needs.slice() : [],
      model: item.model || null,
    }));
  }
  return out;
}

/**
 * Deploy proof payload for authenticated GET /api/version.
 * Reads GIT_SHA (or GITHUB_SHA) from the environment. Never invents a SHA.
 */
function versionPayload(env = process.env, meta = {}) {
  const raw = String(env.GIT_SHA || env.GITHUB_SHA || '').trim();
  const built = String(env.BUILT_AT || '').trim();
  return {
    gitSha: raw || null,
    version: meta.version != null && String(meta.version).trim() ? String(meta.version).trim() : null,
    builtAt: built || null,
  };
}

/**
 * Public / customer readiness only. No provider ids, labels, or model names.
 * Optional uptime (seconds) and version when the server supplies them.
 */
function publicHealthPayload(meta = {}) {
  const out = { ok: true };
  if (meta.uptime != null && Number.isFinite(Number(meta.uptime))) {
    out.uptime = Math.max(0, Math.floor(Number(meta.uptime)));
  }
  if (meta.version != null && String(meta.version).trim()) {
    out.version = String(meta.version).trim();
  }
  return out;
}

/**
 * Customer-safe telephony status. Drops provider/orchestrator branding and
 * ops-console fields (dashboard, upstream workflow id). Keeps DIDs and connect state.
 */
function publicTelephonyStatus(status) {
  const s = status && typeof status === 'object' ? status : {};
  const out = {
    connected: !!s.connected,
    did: s.did || null,
    dids: Array.isArray(s.dids)
      ? s.dids.map((d) => {
        if (!d || typeof d !== 'object') return { number: String(d || '') };
        return {
          id: d.id,
          number: d.number,
          status: d.status,
          label: d.label || '',
          isDefaultCallerId: !!d.isDefaultCallerId,
          inboundWorkflowId: d.inboundWorkflowId,
          inboundWorkflowName: d.inboundWorkflowName || '',
        };
      })
      : [],
  };
  if (s.configuration && typeof s.configuration === 'object') {
    out.configuration = {
      id: s.configuration.id,
      name: s.configuration.name,
      isDefaultOutbound: !!s.configuration.isDefaultOutbound,
    };
  }
  return out;
}

/**
 * Super-admin detailed readiness from providers.describeProviders().
 * Includes provider ids and selected models. Call assertNoSecretValues before sending.
 */
function detailedHealthPayload(described) {
  const providerHealth = (layer) => Object.fromEntries((described[layer] || []).map((item) => [item.id, item.live]));
  const selected = (layer) => (described[layer] || []).find((item) => item.selected) || (described[layer] || [])[0] || {};
  const selectedStt = selected('stt');
  const selectedTts = selected('tts');
  const selectedLlm = selected('llm');
  const selectedTelephony = selected('telephony');
  return {
    ok: true,
    providers: {
      stt: providerHealth('stt'),
      tts: providerHealth('tts'),
      llm: providerHealth('llm'),
      telephony: providerHealth('telephony'),
    },
    models: { stt: selectedStt.model, llm: selectedLlm.model, tts: selectedTts.model },
    selected: {
      stt: { provider: selectedStt.id, model: selectedStt.model },
      tts: { provider: selectedTts.id, model: selectedTts.model },
      llm: { provider: selectedLlm.id, model: selectedLlm.model },
      telephony: { provider: selectedTelephony.id },
    },
  };
}

/**
 * Assert a JSON payload never contains raw secret-looking values for known env keys.
 * Used in tests and defensive admin serialization.
 */
function assertNoSecretValues(payload, env = process.env) {
  const text = JSON.stringify(payload);
  const keys = [
    'DOGRAH_API_KEY', 'DOGRAH_PASSWORD', 'VOBIZ_AUTH_TOKEN', 'RUMIK_API_KEY',
    'GROQ_API_KEY', 'DEEPGRAM_API_KEY', 'GEMINI_API_KEY', 'PAYU_SALT', 'PAYU_KEY',
    'CALLBACK_SECRET', 'ANTHROPIC_API_KEY',
  ];
  for (const key of keys) {
    const value = env[key];
    if (value && String(value).length >= 8 && text.includes(String(value))) {
      return { ok: false, key };
    }
  }
  return { ok: true };
}

function publicAuditEvent(event) {
  const e = event || {};
  return {
    id: e.id,
    tenantId: e.tenantId,
    actorUserId: e.actorUserId,
    subjectUserId: e.subjectUserId || null,
    action: e.action,
    targetType: e.targetType,
    targetId: e.targetId,
    metadata: e.metadata && typeof e.metadata === 'object' ? e.metadata : {},
    createdAt: e.createdAt,
  };
}

module.exports = {
  ROLE_LEVEL,
  SENSITIVE_ACTIONS,
  roleAtLeast,
  publicWorkspace,
  sanitizeTenantUpdate,
  providerHealthSummary,
  publicHealthPayload,
  detailedHealthPayload,
  publicTelephonyStatus,
  versionPayload,
  assertNoSecretValues,
  publicAuditEvent,
};
