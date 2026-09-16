# Workflows (Astra control plane)

Astra Workflows are first-class tenant resources. Customers design and publish graphs inside Astra only. Dograh is execution runtime. Customers never manage Dograh workflow ids, VoBiz labels, or "Open Dograh" links in the product UI. Super Admin may see provider mappings and sync status.

## Data model (`workflows` collection, schema v7)

| Field | Notes |
| --- | --- |
| id | `wf_…` |
| tenantId | tenant scoped |
| name, description | customer facing |
| type / templateKey | receptionist, outbound_sales, support, appointment, lead_qual, payment_reminder, survey, blank |
| direction | `inbound` \| `outbound` \| `both` |
| status | `draft` \| `published` \| `archived` |
| version | integer |
| graphJson | Astra-normalized multi-step graph (`nodes[]` with `id`, `type`, `name`, `prompt`, `next`) |
| agentId | optional primary agent |
| provider | server-side `dograh` |
| providerWorkflowId | server-side mapping; public JSON only for `super_admin` |
| syncStatus / syncError | soft sync outcome for Super Admin |
| createdBy, createdAt, updatedAt, publishedAt | audit timestamps |

`provider_resources` rows with `resourceType: 'workflow'` mirror the mapping.

### Seed / import

On boot and signup, each tenant gets a published **AstraNova Receptionist** workflow (inbound) mapped to provider workflow id `8`. Customers see the Astra name only.

Owners can also `POST /api/workflows/import` with `{ providerWorkflowId }` to wrap an existing remote workflow.

## WorkflowRuntimeProvider

Interface in `dashboard/lib/workflow-provider.js`:

- `createWorkflow`, `updateWorkflow`, `publishWorkflow`, `deleteWorkflow`, `getWorkflow`, `listRemote`

`DograhWorkflowProvider` uses `DOGRAH_*` APIs best effort:

| Capability | Behavior |
| --- | --- |
| GET workflow / list | tries `/api/v1/workflows` and `/api/v1/workflows/{id}` |
| create / update / publish | tries common POST/PUT/PATCH candidates |
| Soft fail | Astra still publishes. If an import/mapping id exists, it is retained. `syncStatus` / `syncError` record the gap for Super Admin. |
| UI | Never blocked by Dograh sync failure |

### Known limits

- Dograh create/update/publish contracts are not fully confirmed. When remote calls fail, Astra remains source of truth with optional mapping.
- Delete is local archive only unless a remote delete candidate succeeds.
- Graph passthrough converts Astra linear stages into a Dograh-like `{ nodes, edges }` shape for sync attempts. This does not rebuild Dograh's runtime or canvas.

## API (cookie auth, tenant scoped)

```bash
# Templates
curl -s -b cookies.txt http://localhost:8787/api/workflow-templates

# List / get
curl -s -b cookies.txt http://localhost:8787/api/workflows
curl -s -b cookies.txt http://localhost:8787/api/workflows/wf_...

# Create from template
curl -s -b cookies.txt -X POST http://localhost:8787/api/workflows \
  -H 'Content-Type: application/json' \
  -d '{"templateKey":"outbound_sales","name":"Outbound sales"}'

# Save draft
curl -s -b cookies.txt -X PATCH http://localhost:8787/api/workflows/wf_... \
  -H 'Content-Type: application/json' \
  -d '{"name":"Outbound sales","graphJson":{"version":1,"nodes":[]}}'

# Publish (soft Dograh sync)
curl -s -b cookies.txt -X POST http://localhost:8787/api/workflows/wf_.../publish \
  -H 'Content-Type: application/json' -d '{}'

# Import existing Dograh id (owner+)
curl -s -b cookies.txt -X POST http://localhost:8787/api/workflows/import \
  -H 'Content-Type: application/json' \
  -d '{"providerWorkflowId":"8","name":"AstraNova Receptionist"}'
```

Public serialization omits `providerWorkflowId` / `provider` for normal users. `super_admin` responses include them plus `syncError`.

## Phone number assign

`POST /api/phone-numbers/:id/assign` and `PATCH /api/phone-numbers/:id` accept:

- `inboundWorkflowId` / `outboundWorkflowId` as **Astra** workflow ids (`wf_…`)

Server resolves to Dograh ids into `providerMetadata` for dial/inbound config. Outbound dial prefers the assigned number's mapped workflow id.

## UI

- Sidebar **Workflows** under **BUILD**
- List with status badges, direction, agent, assigned number
- Create opens template picker cards first
- Builder is a multi-step node editor (start → stages → end + global). Save Draft, Test (Talk to it), Publish
- Customer Telephony / Presets / Talk copy uses Astra workflow names only. Provider mapping is Super Admin only.

## Files

- `dashboard/lib/workflows.js`
- `dashboard/lib/workflow-provider.js`
- `dashboard/server.js` (routes)
- `dashboard/public/assets/app.js` / `app.css`
- `dashboard/test/workflows.test.js`
