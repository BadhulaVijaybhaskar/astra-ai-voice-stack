/**
 * Astra Voice. Per-AI-Employee Dograh model configuration.
 *
 * Astra is the source of truth for employee runtime config (LLM / STT / TTS /
 * Embedding). Credentials are org-level refs only. Never store or return API
 * keys in frontend payloads.
 *
 * Dograh granularity audit (verified against dograh-hq/dograh):
 *   - Organization defaults:
 *       GET/PUT /api/v1/organizations/model-configurations/v2
 *   - Per-workflow (preferred, most granular):
 *       workflow_configurations.model_configuration_v2_override
 *       via PUT /api/v1/workflow/{id} then POST .../publish
 *   - Legacy selective agent/workflow overlays:
 *       workflow_configurations.model_overrides
 *
 * Preferred mapping:
 *   Employee → Astra workflow (wf_*) → Dograh providerWorkflowId
 *   → model_configuration_v2_override on THAT workflow only.
 *
 * Maya production (Dograh WF8 / emp_33eae8ef454680f0) is protected: Astra may
 * store a draft, but activate never writes Dograh WF8 model config.
 *
 * ORG-LEVEL-ONLY (not editable as if they were per-employee):
 *   - Provider API key secrets (use credentials_ref → org env)
 *   - Shared Dograh org defaults when an employee has no provider workflow
 *
 * No em dashes anywhere. Commas and periods only.
 */
'use strict';

const providers = require('./providers');
const workflows = require('./workflows');
const dograhDiscovery = require('./dograh-voice-discovery');

const MAYA_PROTECTED_EMPLOYEE_ID = 'emp_33eae8ef454680f0';
const MAYA_PROTECTED_WORKFLOW_ID = '8';

/**
 * Org credential catalog. Employee configs store credentials_ref only.
 * Secrets resolve server-side from process.env at Dograh sync time.
 */
const ORG_CREDENTIALS = Object.freeze({
  cred_deepgram: Object.freeze({
    id: 'cred_deepgram',
    provider: 'deepgram',
    env: 'DEEPGRAM_API_KEY',
    label: 'Deepgram',
    layers: Object.freeze(['stt', 'tts']),
  }),
  cred_groq: Object.freeze({
    id: 'cred_groq',
    provider: 'groq',
    env: 'GROQ_API_KEY',
    label: 'Groq',
    layers: Object.freeze(['llm']),
  }),
  cred_openrouter: Object.freeze({
    id: 'cred_openrouter',
    provider: 'openrouter',
    env: 'OPENROUTER_API_KEY',
    label: 'OpenRouter',
    layers: Object.freeze(['llm']),
  }),
  cred_sarvam: Object.freeze({
    id: 'cred_sarvam',
    provider: 'sarvam',
    env: 'SARVAM_API_KEY',
    label: 'Sarvam',
    layers: Object.freeze(['stt', 'tts', 'llm']),
  }),
  cred_rumik: Object.freeze({
    id: 'cred_rumik',
    provider: 'rumik',
    env: 'RUMIK_API_KEY',
    label: 'Rumik',
    layers: Object.freeze(['tts']),
  }),
  cred_gemini: Object.freeze({
    id: 'cred_gemini',
    provider: 'gemini',
    env: 'GEMINI_API_KEY',
    label: 'Gemini',
    layers: Object.freeze(['llm', 'embedding']),
  }),
});

const PROVIDER_DEFAULT_CREDENTIAL = Object.freeze({
  deepgram: 'cred_deepgram',
  groq: 'cred_groq',
  openrouter: 'cred_openrouter',
  sarvam: 'cred_sarvam',
  rumik: 'cred_rumik',
  gemini: 'cred_gemini',
  google: 'cred_gemini',
});

const LLM_PROVIDERS = new Set(['groq', 'openrouter', 'gemini', 'sarvam']);
const STT_PROVIDERS = new Set(['deepgram', 'sarvam']);
const TTS_PROVIDERS = new Set(['deepgram', 'sarvam', 'rumik']);
const EMBEDDING_PROVIDERS = new Set(['gemini', 'dograh', 'openai']);

const SECTION_SCOPE = Object.freeze({
  llm: 'per_workflow',
  stt: 'per_workflow',
  tts: 'per_workflow',
  embedding: 'per_workflow',
  // Secrets themselves are organization-scoped. Employees only pick a ref.
  credentials: 'organization',
});

const ORG_LEVEL_ONLY_FIELDS = Object.freeze([
  'llm.api_key',
  'stt.api_key',
  'tts.api_key',
  'embedding.api_key',
  'organization.model_configurations.v2 (fallback when employee has no Dograh workflow)',
]);

function nowIso() {
  return new Date().toISOString();
}

function listOrgCredentials() {
  return Object.values(ORG_CREDENTIALS).map((c) => ({
    id: c.id,
    provider: c.provider,
    label: c.label,
    layers: c.layers.slice(),
    configured: !!(process.env[c.env] && String(process.env[c.env]).trim()),
    // Never expose env var values. Env name is Super Admin only.
  }));
}

function resolveCredentialSecret(credentialsRef) {
  const ref = String(credentialsRef || '').trim();
  const entry = ORG_CREDENTIALS[ref];
  if (!entry) return { ok: false, reason: 'unknown_credentials_ref', ref };
  const value = process.env[entry.env] && String(process.env[entry.env]).trim();
  if (!value) return { ok: false, reason: 'credentials_not_configured', ref, env: entry.env };
  return { ok: true, ref, provider: entry.provider, api_key: value, env: entry.env };
}

function defaultCredentialRef(provider) {
  return PROVIDER_DEFAULT_CREDENTIAL[String(provider || '').toLowerCase()] || null;
}

function clampSpeed(raw, fallback = 1.0) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0.5, Math.min(2.0, Math.round(n * 100) / 100));
}

function normalizeLlm(input, existing) {
  const b = input && typeof input === 'object' ? input : {};
  const base = existing && typeof existing === 'object' ? existing : {};
  const provider = String(b.provider != null ? b.provider : base.provider || 'groq')
    .trim().toLowerCase().slice(0, 40) || 'groq';
  if (!LLM_PROVIDERS.has(provider)) {
    return { error: 'unsupported llm provider: ' + provider, code: 'bad_llm_provider' };
  }
  const model = String(b.model != null ? b.model : base.model || 'llama-3.3-70b-versatile')
    .trim().slice(0, 80) || 'llama-3.3-70b-versatile';
  const providerChanged = b.provider != null
    && String(b.provider).trim().toLowerCase() !== String(base.provider || '').trim().toLowerCase();
  let credentials_ref;
  if (b.credentials_ref != null) {
    credentials_ref = String(b.credentials_ref).trim().slice(0, 60);
  } else if (!providerChanged && base.credentials_ref) {
    credentials_ref = String(base.credentials_ref).trim().slice(0, 60);
  } else {
    credentials_ref = defaultCredentialRef(provider);
  }
  if (credentials_ref && !ORG_CREDENTIALS[credentials_ref]) {
    return { error: 'unknown credentials_ref', code: 'bad_credentials_ref' };
  }
  return { value: { provider, model, credentials_ref } };
}

function normalizeStt(input, existing) {
  const b = input && typeof input === 'object' ? input : {};
  const base = existing && typeof existing === 'object' ? existing : {};
  const provider = String(b.provider != null ? b.provider : base.provider || 'deepgram')
    .trim().toLowerCase().slice(0, 40) || 'deepgram';
  if (!STT_PROVIDERS.has(provider)) {
    return { error: 'unsupported stt provider: ' + provider, code: 'bad_stt_provider' };
  }
  const modelDefault = provider === 'sarvam' ? 'saarika:v2.5' : 'nova-3-general';
  const model = String(b.model != null ? b.model : base.model || modelDefault)
    .trim().slice(0, 80) || modelDefault;
  const language = String(b.language != null ? b.language : base.language || 'multi')
    .trim().slice(0, 40) || 'multi';
  const providerChanged = b.provider != null
    && String(b.provider).trim().toLowerCase() !== String(base.provider || '').trim().toLowerCase();
  let credentials_ref;
  if (b.credentials_ref != null) {
    credentials_ref = String(b.credentials_ref).trim().slice(0, 60);
  } else if (!providerChanged && base.credentials_ref) {
    credentials_ref = String(base.credentials_ref).trim().slice(0, 60);
  } else {
    credentials_ref = defaultCredentialRef(provider);
  }
  if (credentials_ref && !ORG_CREDENTIALS[credentials_ref]) {
    return { error: 'unknown credentials_ref', code: 'bad_credentials_ref' };
  }
  return { value: { provider, model, language, credentials_ref } };
}

function normalizeTts(input, existing) {
  const b = input && typeof input === 'object' ? input : {};
  const base = existing && typeof existing === 'object' ? existing : {};
  const provider = String(b.provider != null ? b.provider : base.provider || 'deepgram')
    .trim().toLowerCase().slice(0, 40) || 'deepgram';
  if (!TTS_PROVIDERS.has(provider)) {
    return { error: 'unsupported tts provider: ' + provider, code: 'bad_tts_provider' };
  }
  const voice_id = String(
    b.voice_id != null ? b.voice_id
      : (b.voice != null ? b.voice : (base.voice_id || base.voice || '')),
  ).trim().slice(0, 80);
  const language = String(b.language != null ? b.language : base.language || 'en')
    .trim().slice(0, 40) || 'en';
  const speed = clampSpeed(b.speed != null ? b.speed : base.speed, 1.0);
  const modelDefault = provider === 'rumik' ? 'mulberry'
    : (provider === 'sarvam' ? 'bulbul:v2' : 'aura-2');
  const model = String(b.model != null ? b.model : base.model || modelDefault)
    .trim().slice(0, 80) || modelDefault;
  const providerChanged = b.provider != null
    && String(b.provider).trim().toLowerCase() !== String(base.provider || '').trim().toLowerCase();
  let credentials_ref;
  if (b.credentials_ref != null) {
    credentials_ref = String(b.credentials_ref).trim().slice(0, 60);
  } else if (!providerChanged && base.credentials_ref) {
    credentials_ref = String(base.credentials_ref).trim().slice(0, 60);
  } else {
    credentials_ref = defaultCredentialRef(provider);
  }
  if (credentials_ref && !ORG_CREDENTIALS[credentials_ref]) {
    return { error: 'unknown credentials_ref', code: 'bad_credentials_ref' };
  }
  return {
    value: {
      provider,
      voice_id: voice_id || (provider === 'rumik' ? 'ira'
        : (provider === 'sarvam' ? 'anushka' : 'aura-2-helena-en')),
      language,
      speed,
      model,
      credentials_ref,
    },
  };
}

function normalizeEmbedding(input, existing) {
  const b = input && typeof input === 'object' ? input : {};
  const base = existing && typeof existing === 'object' ? existing : {};
  if (b.provider === null || b.enabled === false) {
    return { value: null };
  }
  const providerRaw = b.provider != null ? b.provider : base.provider;
  if (providerRaw == null || providerRaw === '') {
    return { value: base.provider ? {
      provider: base.provider,
      model: base.model || 'text-embedding-004',
      credentials_ref: base.credentials_ref || defaultCredentialRef(base.provider),
    } : null };
  }
  const provider = String(providerRaw).trim().toLowerCase().slice(0, 40);
  if (!EMBEDDING_PROVIDERS.has(provider)) {
    return { error: 'unsupported embedding provider: ' + provider, code: 'bad_embedding_provider' };
  }
  const model = String(b.model != null ? b.model : base.model || 'text-embedding-004')
    .trim().slice(0, 80) || 'text-embedding-004';
  const credentials_ref = String(
    b.credentials_ref != null ? b.credentials_ref
      : (base.credentials_ref || defaultCredentialRef(provider) || ''),
  ).trim().slice(0, 60) || defaultCredentialRef(provider);
  if (credentials_ref && !ORG_CREDENTIALS[credentials_ref]) {
    return { error: 'unknown credentials_ref', code: 'bad_credentials_ref' };
  }
  return { value: { provider, model, credentials_ref } };
}

function defaultPipelineConfig() {
  return {
    llm: {
      provider: 'groq',
      model: String(process.env.GROQ_MODEL || 'llama-3.3-70b-versatile').slice(0, 80),
      credentials_ref: 'cred_groq',
    },
    stt: {
      provider: 'deepgram',
      model: 'nova-3-general',
      language: 'multi',
      credentials_ref: 'cred_deepgram',
    },
    tts: {
      provider: 'deepgram',
      voice_id: 'aura-2-helena-en',
      language: 'en',
      speed: 1.0,
      model: 'aura-2',
      credentials_ref: 'cred_deepgram',
    },
    embedding: null,
  };
}

function normalizePipeline(input, existing) {
  const b = input && typeof input === 'object' ? input : {};
  const base = existing && typeof existing === 'object' ? existing : defaultPipelineConfig();
  const llm = normalizeLlm(b.llm, base.llm);
  if (llm.error) return llm;
  const stt = normalizeStt(b.stt, base.stt);
  if (stt.error) return stt;
  const tts = normalizeTts(b.tts, base.tts);
  if (tts.error) return tts;
  const embedding = normalizeEmbedding(b.embedding, base.embedding);
  if (embedding.error) return embedding;
  return {
    value: {
      llm: llm.value,
      stt: stt.value,
      tts: tts.value,
      embedding: embedding.value,
    },
  };
}

function publicPipeline(pipeline) {
  if (!pipeline || typeof pipeline !== 'object') return null;
  const out = {
    llm: pipeline.llm ? {
      provider: pipeline.llm.provider,
      model: pipeline.llm.model,
      credentials_ref: pipeline.llm.credentials_ref || null,
      scope: SECTION_SCOPE.llm,
    } : null,
    stt: pipeline.stt ? {
      provider: pipeline.stt.provider,
      model: pipeline.stt.model,
      language: pipeline.stt.language,
      credentials_ref: pipeline.stt.credentials_ref || null,
      scope: SECTION_SCOPE.stt,
    } : null,
    tts: pipeline.tts ? {
      provider: pipeline.tts.provider,
      voice_id: pipeline.tts.voice_id,
      language: pipeline.tts.language,
      speed: pipeline.tts.speed,
      model: pipeline.tts.model || null,
      credentials_ref: pipeline.tts.credentials_ref || null,
      scope: SECTION_SCOPE.tts,
    } : null,
    embedding: pipeline.embedding ? {
      provider: pipeline.embedding.provider,
      model: pipeline.embedding.model,
      credentials_ref: pipeline.embedding.credentials_ref || null,
      scope: SECTION_SCOPE.embedding,
      advanced: true,
    } : null,
  };
  // Hard guarantee: never leak secrets.
  const blob = JSON.stringify(out).toLowerCase();
  if (blob.includes('api_key') || blob.includes('sk-') || blob.includes('token')) {
    throw new Error('runtime config public payload leaked a secret field');
  }
  return out;
}

function ensureRuntimeConfig(employee) {
  if (!employee.runtimeConfig || typeof employee.runtimeConfig !== 'object') {
    employee.runtimeConfig = {
      draft: null,
      active: null,
      dograhSync: null,
    };
  }
  if (!employee.runtimeConfig.draft && !employee.runtimeConfig.active) {
    // Seed a draft from defaults so the UI has something to edit.
    const defaults = defaultPipelineConfig();
    employee.runtimeConfig.draft = {
      ...defaults,
      updatedAt: nowIso(),
    };
  }
  return employee.runtimeConfig;
}

function isMayaProtected(employee, dograhWorkflowId) {
  if (!employee) return false;
  if (String(employee.id) === MAYA_PROTECTED_EMPLOYEE_ID) return true;
  if (/^maya$/i.test(String(employee.name || '').trim())) return true;
  if (String(dograhWorkflowId || '') === MAYA_PROTECTED_WORKFLOW_ID) return true;
  return false;
}

function resolveDograhWorkflowId(db, employee) {
  if (!employee || !employee.workflowId) return null;
  const id = workflows.resolveProviderWorkflowId(db, employee.tenantId, employee.workflowId);
  return id != null ? String(id) : null;
}

function getRuntimeConfigView(db, employee, opts = {}) {
  if (!employee) return null;
  const rc = ensureRuntimeConfig(employee);
  const dograhWorkflowId = resolveDograhWorkflowId(db, employee);
  const mayaProtected = isMayaProtected(employee, dograhWorkflowId);
  const draft = rc.draft ? publicPipeline(rc.draft) : null;
  const active = rc.active ? publicPipeline(rc.active) : null;
  const draftUpdatedAt = rc.draft && rc.draft.updatedAt ? rc.draft.updatedAt : null;
  const activatedAt = rc.active && rc.active.activatedAt ? rc.active.activatedAt : null;
  const dirty = !!(draft && active && JSON.stringify(draft) !== JSON.stringify(active))
    || !!(draft && !active);
  return {
    employee_id: employee.id,
    employee_name: employee.name || '',
    dograh_workflow_id: opts.includeProviderIds ? dograhWorkflowId : undefined,
    has_dograh_workflow: !!dograhWorkflowId,
    maya_production_protected: mayaProtected,
    scope: { ...SECTION_SCOPE },
    org_level_only_fields: ORG_LEVEL_ONLY_FIELDS.slice(),
    org_credentials: listOrgCredentials(),
    draft,
    active,
    dirty,
    draft_updated_at: draftUpdatedAt,
    activated_at: activatedAt,
    dograh_sync: rc.dograhSync ? {
      ok: !!rc.dograhSync.ok,
      skipped: !!rc.dograhSync.skipped,
      reason: rc.dograhSync.reason || null,
      endpoint: opts.includeProviderIds ? (rc.dograhSync.endpoint || null) : undefined,
      at: rc.dograhSync.at || null,
      error: rc.dograhSync.error || null,
      verified: !!rc.dograhSync.verified,
    } : null,
    providers: {
      llm: [...LLM_PROVIDERS],
      stt: [...STT_PROVIDERS],
      tts: [...TTS_PROVIDERS],
      embedding: [...EMBEDDING_PROVIDERS],
    },
  };
}

function saveDraft(db, tenantId, employeeId, patch) {
  const employee = (db.employees || []).find(
    (e) => e.id === String(employeeId || '') && e.tenantId === tenantId,
  );
  if (!employee) return { ok: false, status: 404, error: 'employee not found', code: 'not_found' };

  const rc = ensureRuntimeConfig(employee);
  const existing = rc.draft || rc.active || defaultPipelineConfig();
  const normalized = normalizePipeline(patch, existing);
  if (normalized.error) {
    return { ok: false, status: 422, error: normalized.error, code: normalized.code || 'validation' };
  }

  rc.draft = {
    ...normalized.value,
    updatedAt: nowIso(),
  };
  // Mirror TTS selection onto employee.voice for catalog consistency (draft).
  if (normalized.value.tts) {
    const voice = employee.voice && typeof employee.voice === 'object' ? employee.voice : {};
    employee.voice = {
      ...voice,
      language: normalized.value.tts.language || voice.language || 'en-IN',
      model: normalized.value.tts.model || voice.model,
      speaker: normalized.value.tts.voice_id || voice.speaker,
      speed: normalized.value.tts.speed,
      provider: normalized.value.tts.provider,
    };
  }
  employee.updatedAt = nowIso();
  return {
    ok: true,
    employee,
    runtimeConfig: getRuntimeConfigView(db, employee, { includeProviderIds: false }),
  };
}

/**
 * Build Dograh BYOK pipeline payload from Astra pipeline + org credential refs.
 * Never called for Maya WF8.
 */
function buildDograhV2Override(pipeline) {
  const llmSecret = resolveCredentialSecret(pipeline.llm.credentials_ref);
  const sttSecret = resolveCredentialSecret(pipeline.stt.credentials_ref);
  const ttsSecret = resolveCredentialSecret(pipeline.tts.credentials_ref);
  if (!llmSecret.ok) {
    return { ok: false, status: 422, error: 'LLM credentials not configured', code: 'llm_credentials_missing', detail: llmSecret };
  }
  if (!sttSecret.ok) {
    return { ok: false, status: 422, error: 'STT credentials not configured', code: 'stt_credentials_missing', detail: sttSecret };
  }
  if (!ttsSecret.ok) {
    return { ok: false, status: 422, error: 'TTS credentials not configured', code: 'tts_credentials_missing', detail: ttsSecret };
  }

  const ttsBlock = {
    provider: pipeline.tts.provider,
    api_key: ttsSecret.api_key,
    model: pipeline.tts.model,
    voice: pipeline.tts.voice_id,
    language: pipeline.tts.language,
    speed: pipeline.tts.speed,
  };
  // Rumik overlay expects voice + model. Deepgram Aura uses voice. Sarvam uses speaker alias.
  if (pipeline.tts.provider === 'sarvam') {
    ttsBlock.speaker = pipeline.tts.voice_id;
  }

  const pipelineBlock = {
    llm: {
      provider: pipeline.llm.provider === 'gemini' ? 'google' : pipeline.llm.provider,
      api_key: llmSecret.api_key,
      model: pipeline.llm.model,
    },
    stt: {
      provider: pipeline.stt.provider,
      api_key: sttSecret.api_key,
      model: pipeline.stt.model,
      language: pipeline.stt.language,
    },
    tts: ttsBlock,
  };

  if (pipeline.embedding && pipeline.embedding.provider) {
    const embSecret = resolveCredentialSecret(pipeline.embedding.credentials_ref);
    if (!embSecret.ok) {
      return {
        ok: false,
        status: 422,
        error: 'Embedding credentials not configured',
        code: 'embedding_credentials_missing',
        detail: embSecret,
      };
    }
    pipelineBlock.embeddings = {
      provider: pipeline.embedding.provider === 'gemini' ? 'google' : pipeline.embedding.provider,
      api_key: embSecret.api_key,
      model: pipeline.embedding.model,
    };
  }

  return {
    ok: true,
    override: {
      version: 2,
      mode: 'byok',
      byok: {
        mode: 'pipeline',
        pipeline: pipelineBlock,
      },
    },
  };
}

function stripSecretsDeep(value, depth = 0) {
  return dograhDiscovery.stripSecrets(value, depth);
}

/**
 * Push model_configuration_v2_override to a single Dograh workflow, then publish.
 * Isolation invariant: caller must pass THAT employee's workflow id only.
 */
async function syncDograhWorkflowModelConfig(dograhWorkflowId, override, options = {}) {
  const id = String(dograhWorkflowId || '').trim();
  if (!id) {
    return { ok: false, skipped: true, reason: 'no_dograh_workflow', verified: false };
  }
  if (id === MAYA_PROTECTED_WORKFLOW_ID) {
    return {
      ok: false,
      skipped: true,
      reason: 'maya_production_protected',
      verified: false,
      error: 'Refusing to mutate Maya production Dograh workflow 8',
    };
  }
  if (!providers.telephony || !providers.telephony.live || typeof providers.telephony.request !== 'function') {
    return { ok: false, skipped: true, reason: 'dograh_not_configured', verified: false };
  }

  const body = {
    workflow_configurations: {
      model_configuration_v2_override: override,
    },
  };
  const putPaths = [
    `/api/v1/workflow/${encodeURIComponent(id)}`,
    `/api/v1/workflows/${encodeURIComponent(id)}`,
  ];
  let putResult = null;
  let putEndpoint = null;
  for (const pathname of putPaths) {
    try {
      const result = await providers.telephony.request('PUT', pathname, body);
      const status = result.up && result.up.status;
      if (status >= 200 && status < 300) {
        putResult = result;
        putEndpoint = pathname;
        break;
      }
      putResult = result;
      putEndpoint = pathname;
    } catch (e) {
      putResult = { error: String(e && e.message || e) };
      putEndpoint = pathname;
    }
  }
  const putStatus = putResult && putResult.up && putResult.up.status;
  if (!(putStatus >= 200 && putStatus < 300)) {
    return {
      ok: false,
      skipped: false,
      reason: 'dograh_put_failed',
      endpoint: putEndpoint,
      status: putStatus || 0,
      error: (putResult && putResult.data && (putResult.data.detail || putResult.data.error))
        || (putResult && putResult.error)
        || 'Dograh workflow model config update failed',
      verified: false,
    };
  }

  // Publish draft so runtime picks up the override.
  let publishOk = false;
  let publishEndpoint = null;
  const publishPaths = [
    `/api/v1/workflow/${encodeURIComponent(id)}/publish`,
    `/api/v1/workflows/${encodeURIComponent(id)}/publish`,
  ];
  for (const pathname of publishPaths) {
    try {
      const result = await providers.telephony.request('POST', pathname, {});
      const status = result.up && result.up.status;
      if (status >= 200 && status < 300) {
        publishOk = true;
        publishEndpoint = pathname;
        break;
      }
    } catch (_) { /* try next */ }
  }

  // Readback verification (secrets stripped).
  let verified = false;
  let effective = null;
  const fetchPaths = [
    `/api/v1/workflow/fetch/${encodeURIComponent(id)}`,
    `/api/v1/workflow/${encodeURIComponent(id)}`,
    `/api/v1/workflows/${encodeURIComponent(id)}`,
  ];
  for (const pathname of fetchPaths) {
    try {
      const result = await providers.telephony.request('GET', pathname);
      const status = result.up && result.up.status;
      if (status >= 200 && status < 300 && result.data) {
        const configs = result.data.workflow_configurations
          || (result.data.workflow && result.data.workflow.workflow_configurations)
          || null;
        const v2 = configs && configs.model_configuration_v2_override
          ? stripSecretsDeep(configs.model_configuration_v2_override)
          : null;
        if (v2) {
          verified = true;
          effective = v2;
        }
        break;
      }
    } catch (_) { /* try next */ }
  }

  return {
    ok: true,
    skipped: false,
    reason: null,
    endpoint: putEndpoint,
    publishEndpoint,
    published: publishOk,
    verified,
    effective,
    at: nowIso(),
  };
}

/**
 * Read effective model config for an employee's Dograh workflow (secrets stripped).
 */
async function fetchEffectiveFromDograh(dograhWorkflowId) {
  const id = String(dograhWorkflowId || '').trim();
  if (!id) {
    // Fall back to org effective configuration.
    const org = await dograhDiscovery.fetchDograhEffectiveConfig();
    return {
      source: org.source === 'live' ? 'organization' : 'unavailable',
      scope: 'organization',
      effective: org.effective,
      error: org.error || null,
    };
  }
  if (!providers.telephony || !providers.telephony.live || typeof providers.telephony.request !== 'function') {
    return { source: 'unavailable', scope: 'workflow', effective: null, error: 'dograh_not_configured' };
  }
  const fetchPaths = [
    `/api/v1/workflow/fetch/${encodeURIComponent(id)}`,
    `/api/v1/workflow/${encodeURIComponent(id)}`,
    `/api/v1/workflows/${encodeURIComponent(id)}`,
  ];
  for (const pathname of fetchPaths) {
    try {
      const result = await providers.telephony.request('GET', pathname);
      const status = result.up && result.up.status;
      if (status >= 200 && status < 300 && result.data) {
        const configs = result.data.workflow_configurations
          || (result.data.workflow && result.data.workflow.workflow_configurations)
          || null;
        const v2 = configs && configs.model_configuration_v2_override
          ? stripSecretsDeep(configs.model_configuration_v2_override)
          : null;
        if (v2) {
          return {
            source: 'workflow_override',
            scope: 'per_workflow',
            dograh_workflow_id: id,
            effective: v2,
            endpoint: pathname,
          };
        }
        // No override: org defaults apply for this workflow.
        const org = await dograhDiscovery.fetchDograhEffectiveConfig();
        return {
          source: org.source === 'live' ? 'organization_fallback' : 'unavailable',
          scope: 'organization',
          dograh_workflow_id: id,
          effective: org.effective,
          note: 'No per-workflow model_configuration_v2_override on this workflow. Org defaults apply.',
        };
      }
    } catch (_) { /* next */ }
  }
  return { source: 'unavailable', scope: 'workflow', effective: null, error: 'fetch_failed' };
}

async function activate(db, tenantId, employeeId, options = {}) {
  const employee = (db.employees || []).find(
    (e) => e.id === String(employeeId || '') && e.tenantId === tenantId,
  );
  if (!employee) return { ok: false, status: 404, error: 'employee not found', code: 'not_found' };

  const rc = ensureRuntimeConfig(employee);
  const source = options.from === 'active' && rc.active
    ? rc.active
    : (rc.draft || rc.active);
  if (!source) {
    return { ok: false, status: 422, error: 'no draft or active config to activate', code: 'empty_config' };
  }

  const normalized = normalizePipeline(source, source);
  if (normalized.error) {
    return { ok: false, status: 422, error: normalized.error, code: normalized.code || 'validation' };
  }

  const dograhWorkflowId = resolveDograhWorkflowId(db, employee);
  const mayaProtected = isMayaProtected(employee, dograhWorkflowId);

  // Always promote Astra-side active first (source of truth).
  rc.active = {
    ...normalized.value,
    activatedAt: nowIso(),
  };
  // Keep draft aligned after activate.
  rc.draft = {
    ...normalized.value,
    updatedAt: nowIso(),
  };

  // Mirror active TTS onto employee.voice.
  if (normalized.value.tts) {
    const voice = employee.voice && typeof employee.voice === 'object' ? employee.voice : {};
    employee.voice = {
      ...voice,
      language: normalized.value.tts.language || voice.language || 'en-IN',
      model: normalized.value.tts.model || voice.model,
      speaker: normalized.value.tts.voice_id || voice.speaker,
      speed: normalized.value.tts.speed,
      provider: normalized.value.tts.provider,
    };
  }
  employee.updatedAt = nowIso();

  let dograhSync;
  if (mayaProtected) {
    dograhSync = {
      ok: false,
      skipped: true,
      reason: 'maya_production_protected',
      at: nowIso(),
      verified: false,
      error: 'Maya production Dograh workflow is protected. Astra active saved locally only.',
    };
  } else if (!dograhWorkflowId) {
    dograhSync = {
      ok: false,
      skipped: true,
      reason: 'no_dograh_workflow',
      at: nowIso(),
      verified: false,
      error: 'Employee has no Dograh workflow binding. Per-workflow model config cannot sync yet. Org defaults still apply at runtime.',
    };
  } else if (options.skipDograh) {
    dograhSync = {
      ok: true,
      skipped: true,
      reason: 'skip_dograh',
      at: nowIso(),
      verified: false,
    };
  } else {
    const built = buildDograhV2Override(normalized.value);
    if (!built.ok) {
      dograhSync = {
        ok: false,
        skipped: false,
        reason: built.code,
        at: nowIso(),
        verified: false,
        error: built.error,
      };
      rc.dograhSync = dograhSync;
      return {
        ok: false,
        status: built.status,
        error: built.error,
        code: built.code,
        runtimeConfig: getRuntimeConfigView(db, employee),
        dograhSync,
      };
    }
    dograhSync = await syncDograhWorkflowModelConfig(dograhWorkflowId, built.override);
    dograhSync.at = dograhSync.at || nowIso();
  }

  rc.dograhSync = dograhSync;

  return {
    ok: true,
    employee,
    runtimeConfig: getRuntimeConfigView(db, employee, { includeProviderIds: !!options.includeProviderIds }),
    dograhSync,
    effective: dograhSync && dograhSync.effective
      ? dograhSync.effective
      : publicPipeline(rc.active),
  };
}

/**
 * Resolve the pipeline that Browser Talk / PSTN / preview should use.
 * prefer: 'draft' | 'active' | 'auto' (active else draft else defaults)
 */
function resolveEmployeePipeline(db, tenantId, employeeId, prefer = 'auto') {
  const employee = (db.employees || []).find(
    (e) => e.id === String(employeeId || '') && e.tenantId === tenantId,
  );
  if (!employee) return { ok: false, status: 404, error: 'employee not found', code: 'not_found' };
  const rc = ensureRuntimeConfig(employee);
  let pipeline = null;
  let source = null;
  if (prefer === 'draft' && rc.draft) {
    pipeline = rc.draft;
    source = 'draft';
  } else if (prefer === 'active' && rc.active) {
    pipeline = rc.active;
    source = 'active';
  } else if (rc.active) {
    pipeline = rc.active;
    source = 'active';
  } else if (rc.draft) {
    pipeline = rc.draft;
    source = 'draft';
  } else {
    pipeline = defaultPipelineConfig();
    source = 'defaults';
  }
  return {
    ok: true,
    employee,
    source,
    pipeline: publicPipeline(pipeline),
    raw: pipeline,
    dograh_workflow_id: resolveDograhWorkflowId(db, employee),
    maya_production_protected: isMayaProtected(employee, resolveDograhWorkflowId(db, employee)),
  };
}

/**
 * PSTN / dial path proof helper: confirm outbound dial would resolve this
 * employee's Dograh workflow (and therefore its model override), without dialing.
 */
function provePstnUsesEmployeeConfig(db, tenantId, employeeId) {
  const resolved = resolveEmployeePipeline(db, tenantId, employeeId, 'active');
  if (!resolved.ok) return resolved;
  const dograhWorkflowId = resolved.dograh_workflow_id;
  return {
    ok: true,
    employee_id: employeeId,
    astra_workflow_id: resolved.employee.workflowId || null,
    dograh_workflow_id: dograhWorkflowId,
    pipeline_source: resolved.source,
    pipeline: resolved.pipeline,
    path: [
      'POST /api/telephony/dial | Instant Leads / campaigns',
      'telephonyProvider.createOutboundCall(tenantId, number, { workflowId: employee.workflowId })',
      'workflows.resolveProviderWorkflowId → Dograh workflow id',
      'telVobiz.initiateCall(E.164, { workflowId })',
      'Dograh loads workflow_configurations.model_configuration_v2_override for that workflow',
    ],
    uses_employee_workflow: !!dograhWorkflowId,
    maya_production_protected: resolved.maya_production_protected,
    note: dograhWorkflowId
      ? 'PSTN dials use this employee Dograh workflow. Model config is the workflow override (or org fallback if none).'
      : 'Employee has no Dograh workflow binding. PSTN would fall through to number mapping or env default.',
  };
}

module.exports = {
  MAYA_PROTECTED_EMPLOYEE_ID,
  MAYA_PROTECTED_WORKFLOW_ID,
  ORG_CREDENTIALS,
  ORG_LEVEL_ONLY_FIELDS,
  SECTION_SCOPE,
  LLM_PROVIDERS,
  STT_PROVIDERS,
  TTS_PROVIDERS,
  EMBEDDING_PROVIDERS,
  listOrgCredentials,
  resolveCredentialSecret,
  defaultPipelineConfig,
  normalizePipeline,
  publicPipeline,
  ensureRuntimeConfig,
  isMayaProtected,
  resolveDograhWorkflowId,
  getRuntimeConfigView,
  saveDraft,
  buildDograhV2Override,
  syncDograhWorkflowModelConfig,
  fetchEffectiveFromDograh,
  activate,
  resolveEmployeePipeline,
  provePstnUsesEmployeeConfig,
  stripSecretsDeep,
};
