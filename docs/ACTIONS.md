# Actions (Phase 19)

Customer **Actions** on an Employee. Definitions persist; execution is foundation only.

## Types

| Type | Purpose |
| --- | --- |
| `book_callback` | Offer / record a callback |
| `tag_outcome` | Apply an Outcome key (reuses Outcomes) |
| `transfer_to_human` | Human handoff stub |
| `crm_webhook` | Store a webhook URL for later (never called live) |

No Phase 2 webhooks. No invented CRM integrations. Live CRM calls are out of scope.

## Model

Stored on the Employee as `actions: ActionDef[]`:

| Field | Notes |
| --- | --- |
| `key` | Stable slug |
| `type` | One of the types above |
| `label` / `description` | Customer-facing |
| `enabled` | Toggle |
| `config` | Type-specific (`outcomeKey`, `webhookUrl`, `target`, …) |

## API

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/api/employees/action-types` | Catalog. |
| `GET` | `/api/employees/:id/actions` | Definitions + `executionAvailable: false`. |
| `PUT` / `PATCH` / `POST` | `/api/employees/:id/actions` | Body `{ definitions }` or `{ actions }`. |
| `POST` | `/api/employees/:id/actions/execute` | Foundation hook. Returns `queued_foundation`. Never dials or calls CRM. |

## UI

Employee Studio → **Actions** tab. Add / remove / enable / Save. Honest empty state uses "—".

## See also

- [OUTCOMES.md](./OUTCOMES.md)
- [EMPLOYEES.md](./EMPLOYEES.md)
