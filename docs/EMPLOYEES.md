# AI Employees (Phases 1 to 16)

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
| `outcomes` | Structured outcome defs (`key`, `label`, `description`, `success`) |

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
| `GET` / `PUT` | `/api/employees/:id/instructions` | Teach: brief, greeting, instructions, step guidance. See [INSTRUCTIONS.md](./INSTRUCTIONS.md). |
| `GET` / `PUT` | `/api/employees/:id/workflow` | Advanced Workflow: Steps + guidance (Phase 9). Customer language only. |
| `GET` | `/api/employees/:id/timeline` | Activity Timeline from real Lead/CallJob/Call events (Phase 10). See [TIMELINE.md](./TIMELINE.md). |
| `GET` | `/api/employees/:id/training` | Attached knowledge. |
| `POST` | `/api/employees/:id/knowledge` | Attach existing `kb_` or create+attach. |
| `DELETE` | `/api/employees/:id/knowledge/:kbId` | Detach. |
| `GET` / `PUT` | `/api/employees/:id/outcomes` | Outcome definitions. See [OUTCOMES.md](./OUTCOMES.md). |
| `GET` | `/api/employees/:id/leads` | Connected leads. See [LEADS.md](./LEADS.md). |

Assign Number uses Phone Numbers APIs with `employeeId`. See [PHONE-NUMBERS.md](./PHONE-NUMBERS.md).

Public JSON never includes Dograh / VoBiz / Deepgram / Groq / Rumik terms.

## UI

- **My Employees**: cards, filters, Open / Test / Pause / Resume, + New Employee.
- **Create Employee**: templates + brief → compose.
- **Employee Studio**: header actions + tabs (Overview, Instructions, Workflow, Training, Assign Number, Leads, Timeline, Actions, Outcomes, Voice, Settings).
  - Instructions / Workflow / Training / Assign Number / Outcomes / Leads / Timeline are real editors.
  - Actions remains an honest stub (no Phase 2 webhooks).
- Customer nav: see [NAV-IA.md](./NAV-IA.md).

North star: Create → Teach → Test → Assign Number → Connect Leads → Go Live → Conversations → outcomes.

## Schema

Additive migration to **schemaVersion 12**: `phoneNumbers.assignedEmployeeId`, `campaigns.employeeId`. See [INSTANT-LEADS.md](./INSTANT-LEADS.md), [CAMPAIGNS-ANALYTICS.md](./CAMPAIGNS-ANALYTICS.md).

## Out of scope

Phase 2 webhooks, fake analytics, unauthorized live dials, collapsing Agent/Workflow modules, billing.
