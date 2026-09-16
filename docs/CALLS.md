# Calls (Sprint 2)

Astra-first call history control plane. Customers review inbound and outbound calls inside Astra only. Dograh / VoBiz stay behind `DograhVobizProvider`. Plans and credits remain out of scope.

## Data model (`calls` collection, schema v5)

Tenant-scoped rows with:

| Field | Notes |
| --- | --- |
| id, tenantId, agentId, phoneNumberId | Astra ids |
| direction | `inbound` or `outbound` |
| fromE164, toE164 | E.164 parties |
| status, startedAt, endedAt, durationSec | lifecycle |
| outcome, summary, extractedData, transcript | conversation artifacts |
| recordingUrl | never raw provider secrets; public API returns `/api/calls/:id/recording` when available |
| latency | `{ totalMs, sttMs, llmMs, ttsMs }` |
| provider | server-only `dograh_vobiz` |
| providerRunId / providerMetadata | server-only; also mirrored in `provider_resources` |
| workflowVersion, dograhWorkflowId | optional, server-side |
| createdAt, updatedAt | |

Public list/detail responses never include API keys, provider run ids, or Dograh branding fields.

## Sync behavior

`POST /api/calls/sync` (cookie auth, tenant scoped):

1. When Dograh is live, try candidate endpoints (best effort, flexible JSON shapes):
   - `GET /api/v1/workflows/{workflowId}/runs?limit=N`
   - `GET /api/v1/workflow-runs?limit=N`
   - `GET /api/v1/telephony/calls?limit=N`
   - Detail / recording candidates: `GET /api/v1/workflow-runs/{runId}`, `.../recording`, `GET /api/v1/telephony/calls/{id}`, `.../recording`
2. Map each run into an Astra call and **upsert by `providerRunId`** (idempotent).
3. If Dograh is unreachable, not configured, or returns an unknown shape, sync is **stubbed**: seed **two demo calls** for UI testing, and accept a **manual import** body:

```bash
curl -s -b cookies.txt -X POST http://localhost:8787/api/calls/sync \
  -H 'Content-Type: application/json' \
  -d '{"import":[{"providerRunId":"manual_1","direction":"inbound","fromE164":"+9198...","toE164":"+9180...","summary":"Imported"}]}'
```

The sync response includes `stubbed`, `endpoint` (when a candidate worked), `tried` / `candidates`, `fetched`, `created`, `updated`, and `total`.

Opening the Calls UI and pressing **Sync calls** uses the same path.

## API (cookie auth, tenant scoped)

```bash
# List (optional agentId, direction, limit)
curl -s -b cookies.txt 'http://localhost:8787/api/calls?limit=50&direction=inbound'

# Detail (transcript, extract, latency, recording access info)
curl -s -b cookies.txt http://localhost:8787/api/calls/call_...

# Sync / demo seed / manual import
curl -s -b cookies.txt -X POST http://localhost:8787/api/calls/sync \
  -H 'Content-Type: application/json' -d '{}'

# Recording proxy or redirect (404 when none)
curl -s -b cookies.txt -o /dev/null -w '%{http_code}\n' \
  http://localhost:8787/api/calls/call_.../recording
```

## Adapter

- `dashboard/lib/calls.js`: store helpers, public serialization, Dograh run mapping, demo seed, import
- `dashboard/lib/telephony-provider.js`: `listCalls`, `getCall`, `getRecording`, `syncCalls` on `DograhVobizProvider`
- `dashboard/lib/providers.js`: `listCallRuns`, `getCallRun`, `getCallRecording` best-effort Dograh fetches

## UI

Sidebar **Calls**: table (time, parties, agent, direction, duration, outcome), detail panel (summary, extracted fields, transcript, latency, recording player when present), Sync button, empty state with contrast tokens. Overview quick actions include a Calls link.

## Deferred

- Confirmed Dograh call-log API contract (current candidates may 404 until Dograh documents stable run list/detail paths)
- Live recording playback when upstream returns media
- Webhook ingestion of call completion events
- Plans, credits, and billing against call minutes
