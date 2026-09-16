/**
 * Astra AI. WorkflowRuntimeProvider interface + DograhWorkflowProvider.
 *
 * Dograh is execution-only. Publish attempts known Dograh APIs best-effort.
 * Soft failures never block Astra publish when an import mapping exists.
 * Gaps are recorded on syncStatus / syncError for Super Admin.
 *
 * Known Dograh capabilities (best effort):
 * - GET /api/v1/workflows/{id}          import / get
 * - GET /api/v1/workflows               listRemote
 * - POST /api/v1/workflows              create (uncertain)
 * - PUT/PATCH /api/v1/workflows/{id}    update (uncertain)
 * - POST .../publish or PUT with body   publish (uncertain)
 *
 * If create/update/publish endpoints fail or are unknown, Astra stays
 * published with the provided or existing providerWorkflowId mapping.
 *
 * No em dashes anywhere. Commas and periods only.
 */
'use strict';

const providers = require('./providers');
const workflows = require('./workflows');

class WorkflowProviderError extends Error {
  constructor(message, status = 502, code = 'workflow_provider_error', detail) {
    super(message);
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

/**
 * Abstract control-plane contract for workflow runtime adapters.
 */
class WorkflowRuntimeProvider {
  async createWorkflow() {
    throw new WorkflowProviderError('createWorkflow is not implemented', 501, 'not_implemented');
  }

  async updateWorkflow() {
    throw new WorkflowProviderError('updateWorkflow is not implemented', 501, 'not_implemented');
  }

  async publishWorkflow() {
    throw new WorkflowProviderError('publishWorkflow is not implemented', 501, 'not_implemented');
  }

  async deleteWorkflow() {
    throw new WorkflowProviderError('deleteWorkflow is not implemented', 501, 'not_implemented');
  }

  async getWorkflow() {
    throw new WorkflowProviderError('getWorkflow is not implemented', 501, 'not_implemented');
  }

  async listRemote() {
    throw new WorkflowProviderError('listRemote is not implemented', 501, 'not_implemented');
  }
}

class DograhWorkflowProvider extends WorkflowRuntimeProvider {
  constructor(options = {}) {
    super();
    this.core = options.core || null;
    this.tel = options.telephony || providers.telephony;
  }

  db() {
    if (!this.core) throw new WorkflowProviderError('core store is required', 500, 'misconfigured');
    return this.core.db();
  }

  dograhLive() {
    return !!(this.tel && this.tel.live && typeof this.tel.request === 'function');
  }

  async tryRequest(method, pathname, payload) {
    if (!this.dograhLive()) {
      return { ok: false, stubbed: true, reason: 'not_configured' };
    }
    try {
      const result = await this.tel.request(method, pathname, payload);
      const status = result.up && result.up.status;
      if (status >= 200 && status < 300) {
        return { ok: true, status, data: result.data || {}, pathname };
      }
      return {
        ok: false,
        status,
        data: result.data || {},
        pathname,
        reason: 'upstream_' + status,
      };
    } catch (e) {
      return { ok: false, stubbed: true, reason: e.message || 'request_failed' };
    }
  }

  extractRemoteId(data) {
    if (!data || typeof data !== 'object') return null;
    const candidates = [
      data.id, data.workflow_id, data.workflowId,
      data.workflow && data.workflow.id,
      data.data && data.data.id,
    ];
    for (const c of candidates) {
      if (c != null && String(c).trim()) return String(c).trim();
    }
    return null;
  }

  async getWorkflow(providerWorkflowId) {
    const id = String(providerWorkflowId || '').trim();
    if (!id) return { workflow: null, stubbed: true, reason: 'missing_id' };
    const paths = [
      `/api/v1/workflows/${encodeURIComponent(id)}`,
      `/api/v1/workflow/${encodeURIComponent(id)}`,
    ];
    for (const pathname of paths) {
      const result = await this.tryRequest('GET', pathname);
      if (result.ok) {
        return {
          workflow: result.data.workflow || result.data,
          endpoint: pathname,
          stubbed: false,
        };
      }
    }
    return {
      workflow: null,
      stubbed: true,
      reason: 'not_found_or_unreachable',
      tried: paths,
    };
  }

  async listRemote(options = {}) {
    const limit = Math.max(1, Math.min(100, Number(options.limit) || 50));
    const paths = [
      `/api/v1/workflows?limit=${limit}`,
      '/api/v1/workflows',
    ];
    for (const pathname of paths) {
      const result = await this.tryRequest('GET', pathname);
      if (result.ok) {
        const data = result.data || {};
        const list = Array.isArray(data.workflows) ? data.workflows
          : Array.isArray(data.items) ? data.items
            : Array.isArray(data) ? data
              : [];
        return { workflows: list, endpoint: pathname, stubbed: false };
      }
    }
    return {
      workflows: [],
      stubbed: true,
      reason: this.dograhLive() ? 'endpoints_unreachable_or_unknown_shape' : 'not_configured',
      tried: paths,
    };
  }

  async createWorkflow(graphPayload) {
    const body = {
      name: graphPayload && graphPayload.name,
      definition: graphPayload && graphPayload.definition,
      graph: graphPayload && graphPayload.graph,
    };
    const paths = [
      { method: 'POST', path: '/api/v1/workflows', body },
      { method: 'POST', path: '/api/v1/workflow', body },
    ];
    for (const c of paths) {
      const result = await this.tryRequest(c.method, c.path, c.body);
      if (result.ok) {
        return {
          ok: true,
          providerWorkflowId: this.extractRemoteId(result.data),
          endpoint: c.path,
          data: result.data,
        };
      }
    }
    return {
      ok: false,
      stubbed: true,
      reason: 'create_unavailable',
      note: 'Dograh create workflow API is not confirmed. Astra keeps the draft mapping locally.',
    };
  }

  async updateWorkflow(providerWorkflowId, graphPayload) {
    const id = String(providerWorkflowId || '').trim();
    if (!id) return { ok: false, reason: 'missing_id' };
    const body = {
      name: graphPayload && graphPayload.name,
      definition: graphPayload && graphPayload.definition,
      graph: graphPayload && graphPayload.graph,
    };
    const paths = [
      { method: 'PUT', path: `/api/v1/workflows/${encodeURIComponent(id)}`, body },
      { method: 'PATCH', path: `/api/v1/workflows/${encodeURIComponent(id)}`, body },
      { method: 'POST', path: `/api/v1/workflows/${encodeURIComponent(id)}`, body },
    ];
    for (const c of paths) {
      const result = await this.tryRequest(c.method, c.path, c.body);
      if (result.ok) {
        return {
          ok: true,
          providerWorkflowId: this.extractRemoteId(result.data) || id,
          endpoint: c.path,
          data: result.data,
        };
      }
    }
    return {
      ok: false,
      stubbed: true,
      reason: 'update_unavailable',
      note: 'Dograh update workflow API is not confirmed. Astra publish can keep an existing mapping.',
      providerWorkflowId: id,
    };
  }

  async publishRemote(providerWorkflowId, graphPayload) {
    const id = String(providerWorkflowId || '').trim();
    const body = {
      name: graphPayload && graphPayload.name,
      definition: graphPayload && graphPayload.definition,
      graph: graphPayload && graphPayload.graph,
      status: 'published',
    };
    const paths = [];
    if (id) {
      paths.push(
        { method: 'POST', path: `/api/v1/workflows/${encodeURIComponent(id)}/publish`, body },
        { method: 'PUT', path: `/api/v1/workflows/${encodeURIComponent(id)}/publish`, body },
        { method: 'POST', path: `/api/v1/workflows/${encodeURIComponent(id)}`, body },
      );
    }
    paths.push({ method: 'POST', path: '/api/v1/workflows/publish', body });
    for (const c of paths) {
      const result = await this.tryRequest(c.method, c.path, c.body);
      if (result.ok) {
        return {
          ok: true,
          providerWorkflowId: this.extractRemoteId(result.data) || id || null,
          endpoint: c.path,
          data: result.data,
        };
      }
    }
    return {
      ok: false,
      stubbed: true,
      reason: 'publish_unavailable',
      note: 'Dograh publish API is not confirmed for arbitrary graphs.',
      providerWorkflowId: id || null,
    };
  }

  async deleteWorkflow(providerWorkflowId) {
    const id = String(providerWorkflowId || '').trim();
    if (!id) return { ok: false, reason: 'missing_id' };
    const paths = [
      { method: 'POST', path: `/api/v1/workflows/${encodeURIComponent(id)}/delete`, body: {} },
      // Some stacks use DELETE; tel.request only supports GET/POST today.
    ];
    for (const c of paths) {
      const result = await this.tryRequest(c.method, c.path, c.body);
      if (result.ok) return { ok: true, endpoint: c.path };
    }
    return {
      ok: false,
      stubbed: true,
      reason: 'delete_unavailable',
      note: 'Dograh delete is not confirmed. Astra archive is local only.',
    };
  }

  /**
   * Publish Astra workflow → Dograh sync best effort.
   * Never throws for soft sync failure when a mapping can be retained.
   */
  async publishWorkflow(tenantId, workflowId, options = {}) {
    if (!this.core) throw new WorkflowProviderError('core store is required', 500, 'misconfigured');
    const dbSnap = this.db();
    const existing = workflows.findWorkflow(dbSnap, tenantId, workflowId);
    if (!existing) {
      throw new WorkflowProviderError('workflow not found', 404, 'not_found');
    }

    const importId = options.providerWorkflowId != null
      ? String(options.providerWorkflowId).trim()
      : (existing.providerWorkflowId != null ? String(existing.providerWorkflowId) : '');

    const dograhGraph = workflows.toDograhLikeGraph(existing.graphJson);
    const payload = {
      name: existing.name,
      definition: dograhGraph,
      graph: dograhGraph,
    };

    let sync = {
      syncStatus: 'synced',
      syncError: null,
      providerWorkflowId: importId || null,
      remote: null,
    };

    if (!this.dograhLive()) {
      if (importId) {
        sync.syncStatus = 'mapped_offline';
        sync.syncError = 'Dograh is not configured. Astra published with the provided provider mapping.';
      } else {
        sync.syncStatus = 'pending_remote';
        sync.syncError = 'Dograh is not configured. Astra published locally without a remote workflow id.';
      }
    } else {
      let remoteResult = null;
      if (importId) {
        remoteResult = await this.updateWorkflow(importId, payload);
        if (!remoteResult.ok) {
          remoteResult = await this.publishRemote(importId, payload);
        }
      } else {
        remoteResult = await this.createWorkflow(payload);
        if (remoteResult.ok && remoteResult.providerWorkflowId) {
          const pub = await this.publishRemote(remoteResult.providerWorkflowId, payload);
          if (pub.ok) remoteResult = pub;
        } else if (!remoteResult.ok) {
          remoteResult = await this.publishRemote('', payload);
        }
      }

      if (remoteResult && remoteResult.ok && remoteResult.providerWorkflowId) {
        sync.providerWorkflowId = String(remoteResult.providerWorkflowId);
        sync.syncStatus = 'synced';
        sync.syncError = null;
        sync.remote = remoteResult;
      } else if (importId) {
        // Soft-fail: keep Astra published with the import mapping.
        sync.providerWorkflowId = importId;
        sync.syncStatus = 'sync_failed';
        sync.syncError = (remoteResult && (remoteResult.note || remoteResult.reason))
          || 'Dograh sync failed. Astra remains published with the existing mapping.';
        sync.remote = remoteResult;
      } else {
        sync.providerWorkflowId = null;
        sync.syncStatus = 'sync_failed';
        sync.syncError = (remoteResult && (remoteResult.note || remoteResult.reason))
          || 'Dograh create/publish APIs are unavailable. Astra published without a remote id.';
        sync.remote = remoteResult;
      }
    }

    let published;
    await this.core.mutate((db) => {
      const row = workflows.findWorkflow(db, tenantId, workflowId);
      if (!row) throw new WorkflowProviderError('workflow not found', 404, 'not_found');
      published = workflows.markPublished(db, row, {
        providerWorkflowId: sync.providerWorkflowId,
        syncStatus: sync.syncStatus,
        syncError: sync.syncError,
      });
    });

    return {
      workflow: published,
      syncStatus: sync.syncStatus,
      syncError: sync.syncError,
      providerWorkflowId: sync.providerWorkflowId,
      remote: sync.remote,
    };
  }
}

function createDefaultWorkflowProvider(options) {
  return new DograhWorkflowProvider(options);
}

module.exports = {
  WorkflowRuntimeProvider,
  DograhWorkflowProvider,
  WorkflowProviderError,
  createDefaultWorkflowProvider,
};
