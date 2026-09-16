/**
 * Astra AI. Tenant-scoped Knowledge Base (docs / FAQ) with simple retrieval stub.
 *
 * V1 stores title, content or source URL, and status in portable JSON.
 * No vector database. Retrieval is keyword overlap for agent context stubs.
 *
 * No em dashes anywhere. Commas and periods only.
 */
'use strict';

const crypto = require('crypto');

const STATUSES = new Set(['draft', 'published', 'archived']);

function genId(prefix) {
  return prefix + crypto.randomBytes(8).toString('hex');
}

function nowIso() {
  return new Date().toISOString();
}

function publicKnowledgeEntry(row) {
  const e = row || {};
  return {
    id: e.id,
    title: e.title,
    content: e.content || '',
    sourceUrl: e.sourceUrl || '',
    status: e.status || 'draft',
    tags: Array.isArray(e.tags) ? e.tags.slice() : [],
    createdAt: e.createdAt,
    updatedAt: e.updatedAt,
  };
}

function normalizeEntryInput(body, existing) {
  const b = body && typeof body === 'object' ? body : {};
  const title = String(b.title != null ? b.title : (existing && existing.title) || '').trim().slice(0, 160);
  const content = String(b.content != null ? b.content : (existing && existing.content) || '').trim().slice(0, 20000);
  const sourceUrl = String(b.sourceUrl != null ? b.sourceUrl : (existing && existing.sourceUrl) || '').trim().slice(0, 500);
  const statusRaw = String(b.status != null ? b.status : (existing && existing.status) || 'draft').trim().toLowerCase();
  const status = STATUSES.has(statusRaw) ? statusRaw : null;
  const tags = Array.isArray(b.tags)
    ? b.tags.map((t) => String(t).trim().slice(0, 40)).filter(Boolean).slice(0, 12)
    : (existing && existing.tags) || [];
  if (!title) return { ok: false, status: 422, error: 'title required', code: 'bad_title' };
  if (!content && !sourceUrl) {
    return { ok: false, status: 422, error: 'content or sourceUrl required', code: 'bad_body' };
  }
  if (!status) return { ok: false, status: 422, error: 'status must be draft, published, or archived', code: 'bad_status' };
  if (sourceUrl && !/^https?:\/\//i.test(sourceUrl)) {
    return { ok: false, status: 422, error: 'sourceUrl must be http(s)', code: 'bad_url' };
  }
  return { ok: true, title, content, sourceUrl, status, tags };
}

function listTenantEntries(db, tenantId) {
  return (db.knowledgeEntries || [])
    .filter((e) => e.tenantId === tenantId)
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
}

function findEntry(db, tenantId, id) {
  return (db.knowledgeEntries || []).find((e) => e.id === id && e.tenantId === tenantId) || null;
}

function createEntry(db, tenantId, input, actorUserId) {
  const parsed = normalizeEntryInput(input);
  if (!parsed.ok) return parsed;
  if (!Array.isArray(db.knowledgeEntries)) db.knowledgeEntries = [];
  const ts = nowIso();
  const row = {
    id: genId('kb_'),
    tenantId,
    title: parsed.title,
    content: parsed.content,
    sourceUrl: parsed.sourceUrl,
    status: parsed.status,
    tags: parsed.tags,
    createdBy: actorUserId || null,
    createdAt: ts,
    updatedAt: ts,
  };
  db.knowledgeEntries.push(row);
  return { ok: true, entry: row };
}

function updateEntry(db, tenantId, id, input) {
  const row = findEntry(db, tenantId, id);
  if (!row) return { ok: false, status: 404, error: 'knowledge entry not found', code: 'not_found' };
  const parsed = normalizeEntryInput(input, row);
  if (!parsed.ok) return parsed;
  row.title = parsed.title;
  row.content = parsed.content;
  row.sourceUrl = parsed.sourceUrl;
  row.status = parsed.status;
  row.tags = parsed.tags;
  row.updatedAt = nowIso();
  return { ok: true, entry: row };
}

function deleteEntry(db, tenantId, id) {
  if (!Array.isArray(db.knowledgeEntries)) db.knowledgeEntries = [];
  const idx = db.knowledgeEntries.findIndex((e) => e.id === id && e.tenantId === tenantId);
  if (idx < 0) return { ok: false, status: 404, error: 'knowledge entry not found', code: 'not_found' };
  const [removed] = db.knowledgeEntries.splice(idx, 1);
  return { ok: true, entry: removed };
}

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2);
}

/**
 * Simple keyword retrieval stub for agent context. Published entries only.
 */
function retrieveForQuery(db, tenantId, query, limit = 5) {
  const tokens = new Set(tokenize(query));
  if (!tokens.size) return [];
  const scored = listTenantEntries(db, tenantId)
    .filter((e) => e.status === 'published')
    .map((e) => {
      const hay = tokenize([e.title, e.content, ...(e.tags || [])].join(' '));
      let score = 0;
      for (const t of hay) if (tokens.has(t)) score += 1;
      return { entry: e, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, Math.min(20, Number(limit) || 5)));
  return scored.map((x) => ({
    ...publicKnowledgeEntry(x.entry),
    score: x.score,
    excerpt: String(x.entry.content || x.entry.sourceUrl || '').slice(0, 280),
  }));
}

module.exports = {
  STATUSES,
  publicKnowledgeEntry,
  normalizeEntryInput,
  listTenantEntries,
  findEntry,
  createEntry,
  updateEntry,
  deleteEntry,
  retrieveForQuery,
  tokenize,
};
