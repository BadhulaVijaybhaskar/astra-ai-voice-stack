# Conversations — Phase 12

Customer-facing name for Astra call history. Reuses the Calls control plane. Provider terms stay off the customer UI.

## API

Existing Calls routes remain. Conversations is an alias:

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/api/conversations` | Same as `/api/calls`. Response key `conversations`. |
| `GET` | `/api/conversations/:id` | Detail with transcript / recording / outcome when present. |
| `POST` | `/api/conversations/sync` | Same sync behavior as `/api/calls/sync`. |
| `GET` | `/api/conversations/:id/recording` | Recording proxy. |

Filters: `direction`, `agentId`, `employeeId`, `status`, `outcome`, `limit`. Tenant isolation unchanged. Empty list returns honest `count: 0` / `empty: true`.

Public JSON never includes provider run ids.

## UI

Sidebar **Conversations** (route `#/calls`). List + detail with filters. Missing transcript / recording / outcome shows `—`.

## See also

- [CALLS.md](./CALLS.md)
- [EMPLOYEES.md](./EMPLOYEES.md)
- [TIMELINE.md](./TIMELINE.md)
- [INSTANT-LEADS.md](./INSTANT-LEADS.md)
