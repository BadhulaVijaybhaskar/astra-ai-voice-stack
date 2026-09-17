# AI Employees (Phases 1 to 4)

Customer-facing **Employee** product layer. An employee is a composition of relationships, not a duplicated agent/workflow blob.

## Model

| Field | Notes |
| --- | --- |
| `id` | `emp_...` |
| `agentId` | Astra `ag_...` |
| `workflowId` | Astra `wf_...` |
| `knowledgeIds` | Astra `kb_...` refs |
| `phoneNumberId` | Astra `pn_...` |
| `voice` | language / speaker / model (no provider brand names in UI copy) |
| `status` | `DRAFT` \| `READY` \| `LIVE` \| `PAUSED` \| `ARCHIVED` |
| `channel` | `inbound` \| `instant_lead` \| `campaign` \| `outbound` \| `both` |

Lifecycle: create composes Agent + Workflow from a job template → usually `READY`. Go live / pause / resume / archive via status APIs. Metrics (`callsToday`, `leads`, `qualified`, `lastActiveAt`) come from real Call/Lead rows or honest zeros. Never fake analytics.

## Job templates

Receptionist, Instant Lead Caller, Lead Qualification, Outbound Sales, Support, Appointment, Payment Reminder, Survey, Custom.

Each maps onto existing workflow templates and agent presets (reuse).

## API

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/api/employees` | List. `?filter=` channel or status. |
| `GET` | `/api/employees/templates` | Job templates. |
| `GET` | `/api/employees/:id` | Detail + linked agent/workflow/knowledge. |
| `POST` | `/api/employees` | Create. Composes agent+workflow by default. |
| `PATCH` | `/api/employees/:id` | Update fields / links / status. |
| `POST` | `/api/employees/:id/status` | Lifecycle transition. |
| `POST` | `/api/employees/:id/pause` | LIVE → PAUSED. |
| `POST` | `/api/employees/:id/resume` | PAUSED → LIVE. |

Public JSON never includes Dograh / VoBiz / Deepgram / Groq / Rumik terms.

## UI

- **My Employees**: cards, filters, Open / Test / Pause / Resume, + New Employee.
- **Create Employee**: templates + brief → compose.
- **Employee Studio**: header actions + tabs (Overview, Instructions, Workflow, Training, Actions, Outcomes, Voice, Settings). Tabs wire to existing modules or honest empty stubs.

## Schema

Additive migration to **schemaVersion 9**: collection `employees`.

## Out of scope

Phase 2 webhooks, fake analytics, unauthorized live dials, collapsing Agent/Workflow modules.
