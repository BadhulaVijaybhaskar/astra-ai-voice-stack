# Campaigns and Performance (Phases 14–15 + Sprint 5)

## Campaigns (share CallJob)

Tenant-scoped outbound campaigns in `campaigns` + `campaignLeads`. Enqueue uses the **same CallJob + dial path** as Instant Leads (`placeOutboundCallJob` → `createOutboundCall`). No parallel dial stack.

Statuses: `draft`, `running`, `paused`, `done`.

Campaigns attach an **Employee** (`employeeId`). Agent id is resolved from the employee for dial. Dial still requires `confirm:true`. Tests mock dial / stub queue.

### Routes

- `GET /api/campaigns`
- `POST /api/campaigns` `{ name, employeeId?, agentId?, ratePerMinute? }`
- `POST /api/campaigns/employee` `{ campaignId, employeeId|null }` attach or clear Employee
- `POST /api/campaigns/leads` `{ campaignId, text|leads }` paste CSV lines `phone, name` or JSON array
- `GET /api/campaigns/leads?campaignId=`
- `POST /api/campaigns/status` `{ campaignId, status }`
- `POST /api/campaigns/enqueue` `{ campaignId, confirm:true }` → CallJobs with `source: campaign`

Enqueue without `confirm:true` returns **400** `needs_confirm`. Each batch is capped by `ratePerMinute` (default 10).

See [INSTANT-LEADS.md](./INSTANT-LEADS.md) for the shared CallJob contract. Public JSON never includes `providerRunId`.

## Performance (honest)

- `GET /api/performance` (alias of `GET /api/analytics`)
- Aggregates from real Call / Lead / Outcome / Campaign rows only
- Empty totals are zeros; `conversionRatePct` is `null` when there are no calls so the UI can show **—**
- Never invent conversion rates or chart series

UI nav label: **Performance**.

## Schema

Additive **schemaVersion 12**: `campaigns.employeeId`. Cross-link [PHONE-NUMBERS.md](./PHONE-NUMBERS.md).
