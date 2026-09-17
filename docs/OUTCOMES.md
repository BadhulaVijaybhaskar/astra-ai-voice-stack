# Outcomes — Phase 7

Structured **Outcome** definitions describe what success looks like after a conversation with an Employee.

## Model

Each definition:

| Field | Notes |
| --- | --- |
| `key` | Stable slug (`qualified`, `booked`, …) |
| `label` | Customer-facing name |
| `description` | Optional |
| `success` | Whether this counts as a success / qualified signal |

Stored on the Employee as `outcomes: OutcomeDef[]`. Schema v10 migrates legacy string labels into this shape.

## Foundation only

This phase does **not** invent live conversation results. `GET .../outcomes` returns `resultsAvailable: false` and `results: []` until a later pipeline writes `call.outcome` / `lead.outcomeKey` against these keys.

## API

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/api/employees/:id/outcomes` | Definitions + empty results foundation. |
| `PUT` / `PATCH` / `POST` | `/api/employees/:id/outcomes` | Body `{ definitions: [...] }` or `{ outcomes: [...] }`. |

## UI

Employee Studio → **Outcomes** tab. Add / remove / mark success / Save. Honest empty state uses "—".

## See also

- [EMPLOYEES.md](./EMPLOYEES.md)
- [INSTRUCTIONS.md](./INSTRUCTIONS.md)
- [LEADS.md](./LEADS.md)
- [CALLS.md](./CALLS.md)
