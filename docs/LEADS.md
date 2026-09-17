# Leads — Phase 8

Formal **Lead** entity for Instant Leads and Employee Connect Leads.

## Model

| Field | Notes |
| --- | --- |
| `id` | `lead_...` |
| `tenantId` | Isolation boundary (never in public JSON) |
| `name`, `phone` | Required. IN 10-digit phones normalize to `+91...`. |
| `status` | `new` \| `assigned` \| `calling` \| `called` \| `failed` \| `qualified` \| `closed` |
| `employeeId` | Optional `emp_...` |
| `agentId` | Optional `ag_...` (filled from employee when linked) |
| `workflowId` | Optional `wf_...` |
| `phoneNumberId` | Optional `pn_...` |
| `lastCallJobId` / `lastCallId` | Links to CallJob / Call |
| `outcomeKey` | Optional key matching Employee outcome defs |
| `meta` | Optional customer metadata |

Composition: **Lead → Employee/Agent → CallJob → Call**. Provider run ids stay server-only.

## API

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/api/leads` | Tenant list. Filters: `status`, `employeeId`, `agentId`. |
| `POST` | `/api/leads` | Create. Prefer `employeeId` (resolves agent/workflow/number). |
| `GET` | `/api/leads/:id` | Lead + recent jobs. |
| `PATCH` | `/api/leads/:id` | Update fields / link employee / status / outcomeKey. |
| `POST` | `/api/leads/:id/call` | Requires `confirm:true`. Reuses canonical `createOutboundCall`. |
| `GET` | `/api/employees/:id/leads` | Leads connected to one employee. |

No unauthorized dials from Studio Connect Leads. Dial remains Instant Leads confirm only.

## UI

- **Instant Leads**: create with Employee select (`employeeId`).
- Employee Studio → **Leads** tab: connect lead to this employee, list with honest empty "—".

## Schema

Additive migration to **schemaVersion 10**: normalize `lead.employeeId`, structured employee outcomes.

## See also

- [INSTANT-LEADS.md](./INSTANT-LEADS.md)
- [EMPLOYEES.md](./EMPLOYEES.md)
- [OUTCOMES.md](./OUTCOMES.md)
- [TIMELINE.md](./TIMELINE.md)
- [CONVERSATIONS.md](./CONVERSATIONS.md)
