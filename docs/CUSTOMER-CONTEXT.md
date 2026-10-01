# Continuous Customer Context

Persists and reuses customer context across inbound and outbound Astra Voice calls.
Storage remains `data/db.json` (`contacts`, `outboundJobs`). No Supabase migration.

## Entity

Contact fields (public aliases use snake_case): `contact_id`, `tenant_id` (server-only),
`name`, `primary_phone`, `alternate_phone`, `email`, `company`, `preferred_language`,
`detected_languages`, `lead_status`, `qualification_status`, `interest`, `business_goal`,
`timeline`, `last_conversation_summary`, `cumulative_context_summary`,
`appointments[]`, `calls[]`, `actions[]`, `next_action`, `next_action_at`,
`assigned_employee`.

## Contact resolution

Every inbound (and outbound) path: normalize E.164 → find Contact → load context or create.
`POST /api/contacts/resolve` with `{ phone, create?: true }`.

## Context injection

`GET /api/contacts/:id/context` returns a compact block (structured fields + latest summary +
relevant appointment/action). Never includes full transcripts. Token budget ~900 chars.

## Journeys

- **Inbound → booking → outbound**: end-of-call / Cal.com book → appointment on contact →
  confirmation + reminder outbound jobs (1h / 1d / custom). Jobs do **not** auto-dial PSTN.
- **Outbound → booking → inbound**: later inbound resolves the same phone and injects stored facts only.

## Event trigger engine

`POST /api/contacts/events` with `event` in:
`call.completed`, `lead.created`, `lead.qualified`,
`appointment.requested|booked|rescheduled|cancelled`,
`followup.required`, `callback.requested`.

## Scheduled outbound jobs

Persisted in `outboundJobs`: `job_id`, `contact_id`, `employee_id`, `phone`,
`trigger_event`, `scheduled_at`, `status` (`pending|scheduled|running|completed|failed|cancelled`),
`context_snapshot`, `retry_count`. Survive restart. `autoDial` is always false.

## Callback request

`POST /api/contacts/callback-request` parses phrases like "call me back in 30 minutes",
"tomorrow morning", "remind before meeting" in `Asia/Kolkata` → ISO. Verbal confirm is
allowed only after the job is persisted.

## Calendar triggers

Cal.com HVAC book path writes the appointment onto the Contact and schedules jobs using
per-employee `callbackRules` (`onBookingConfirmation`, `remindBeforeMinutes`,
`customOffsetsMinutes`).

## End-of-call pipeline

`POST /api/contacts/end-of-call`: transcript → summary → structured extraction →
contact / lead / appointment / next_action / jobs. Cumulative summary merges without
erasing older useful facts. Preferred language is preserved for the next call.

## Employee handoff

`POST /api/contacts/:id/handoff` with `{ toEmployeeId }`. Context is tenant-scoped.
Vaani can receive Maya-qualified facts. Cross-tenant employees are rejected.

## UI

Leads → select lead → **Customer context** panel (facts + compact injection + timeline).
Conversations detail → **Customer timeline** when a contact exists for the caller phone.

## Safety

- No duplicate callback jobs for the same event unless `force: true`.
- No paid PSTN from continuous-context jobs.
- Never claim appointment / callback until persisted.

## Schema

Additive migration to **schemaVersion 16**: `contacts`, `outboundJobs`, employee `callbackRules`.

## See also

- [LEADS.md](./LEADS.md)
- [TIMELINE.md](./TIMELINE.md)
- [CONVERSATIONS.md](./CONVERSATIONS.md)
- [ACTIONS.md](./ACTIONS.md)
