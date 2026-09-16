# Campaigns and Analytics (Sprint 5)

## Campaigns

Tenant-scoped outbound campaigns in `campaigns` + `campaignLeads`.

Statuses: `draft`, `running`, `paused`, `done`.

### Routes

- `GET /api/campaigns`
- `POST /api/campaigns` `{ name, agentId?, ratePerMinute? }`
- `POST /api/campaigns/leads` `{ campaignId, text|leads }` paste CSV lines `phone, name` or JSON array
- `GET /api/campaigns/leads?campaignId=`
- `POST /api/campaigns/status` `{ campaignId, status }`
- `POST /api/campaigns/enqueue` `{ campaignId, confirm:true }`

Enqueue without `confirm:true` returns **400** `needs_confirm`. Each enqueue
batch is capped by `ratePerMinute` (default 10). V1 uses stub queueing unless a
sync dial function is wired server-side.

## Analytics

- `GET /api/analytics` returns call aggregates by outcome, direction, agent,
  conversion-ish metrics from `extractedData` / outcome keywords, plus campaign
  counters.
