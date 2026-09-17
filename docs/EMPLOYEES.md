# AI Employees (Phases 1 to 20)

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
| `actions` | Structured action defs (Phase 19). See [ACTIONS.md](./ACTIONS.md). |

Lifecycle: create composes Agent + Workflow from a job template → usually `READY`. Go live / pause / resume / archive via status APIs. Metrics (`callsToday`, `leads`, `qualified`, `lastActiveAt`) come from real Call/Lead rows or honest zeros. Never fake analytics.

## Job templates

Receptionist, Instant Lead Caller, Lead Qualification, Outbound Sales, Support, Appointment, Payment Reminder, Survey, Custom.

Each maps onto existing workflow templates and agent presets (reuse).

## API

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/api/employees` | List. `?filter=` channel or status. |
| `GET` | `/api/employees/templates` | Job templates. |
| `GET` | `/api/employees/languages` | Supported Languages (Phase 18). See [LANGUAGES.md](./LANGUAGES.md). |
| `GET` | `/api/employees/action-types` | Action type catalog (Phase 19). |
| `GET` | `/api/employees/:id` | Detail + linked agent/workflow/knowledge. |
| `POST` | `/api/employees` | Create. Composes agent+workflow by default. |
| `PATCH` | `/api/employees/:id` | Update fields / links / status / language. |
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
| `GET` / `PUT` | `/api/employees/:id/actions` | Action definitions (Phase 19). See [ACTIONS.md](./ACTIONS.md). |
| `POST` | `/api/employees/:id/actions/execute` | Execution hook foundation only. |
| `PUT` | `/api/employees/:id/language` | Set Language (Phase 18). |
| `GET` | `/api/employees/:id/leads` | Connected leads. See [LEADS.md](./LEADS.md). |

Assign Number uses Phone Numbers APIs with `employeeId`. Inbound answer/greeting/hours: see [INBOUND.md](./INBOUND.md).

Public JSON never includes Dograh / VoBiz / Deepgram / Groq / Rumik terms.

## UI

- **My Employees**: cards, filters, Open / Test / Pause / Resume, + New Employee.
- **Create Employee**: templates + brief → compose.
- **Employee Studio**: header actions + tabs (Overview, Instructions, Workflow, Training, Assign Number, Leads, Timeline, Actions, Outcomes, Voice, Settings).
  - Instructions / Workflow / Training / Assign Number / Outcomes / Leads / Timeline / Actions / Voice Language are real editors.
  - Assign Number includes Inbound ownership when a Phone Number is linked.
- Customer nav: see [NAV-IA.md](./NAV-IA.md).

North star: Create → Teach → Test → Assign Number → Connect Leads → Go Live → Conversations → outcomes.

## Schema

Additive migration to **schemaVersion 13**: Phone Number inbound greeting/hours, Employee `actions`, voice language normalize, plan `includedEmployees` / `includedMinutes`. See [INBOUND.md](./INBOUND.md), [LANGUAGES.md](./LANGUAGES.md), [ACTIONS.md](./ACTIONS.md), [PLANS-BILLING.md](./PLANS-BILLING.md).

## Out of scope

Phase 2 webhooks, fake analytics, unauthorized live dials, collapsing Agent/Workflow modules, full live CRM execution. Super Admin diagnostics landed in Phase 21 ([SUPER-ADMIN.md](./SUPER-ADMIN.md)). E2E acceptance harness in Phase 22 ([E2E-ACCEPTANCE.md](./E2E-ACCEPTANCE.md)); live phone proof remains an external blocker.
