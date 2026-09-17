# Timeline — Phase 10

Per-Employee and per-Lead **activity Timeline** built only from real Lead, CallJob, and Call rows.

## Events (honest)

| Type | Source |
| --- | --- |
| `lead_connected` | Lead created / connected to employee |
| `job_queued` / `job_dialing` / `job_completed` / `job_failed` | CallJob timestamps + status |
| `call_started` / `call_ended` | Call `startedAt` / `endedAt` |
| `outcome_set` | Call `outcome` or Lead `outcomeKey` |

Empty timeline returns `{ events: [], count: 0, empty: true }`. Never invent activity or fake analytics.

## API

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/api/employees/:id/timeline` | Employee-scoped. `?limit=` |
| `GET` | `/api/leads/:id/timeline` | Lead-scoped. `?limit=` |

Public JSON never includes `providerRunId`, Dograh, or VoBiz fields.

## UI

Employee Studio → **Timeline** tab. Honest empty state: `No activity yet. —`

## See also

- [EMPLOYEES.md](./EMPLOYEES.md)
- [LEADS.md](./LEADS.md)
- [CALLS.md](./CALLS.md) / Conversations
- [INSTANT-LEADS.md](./INSTANT-LEADS.md)
