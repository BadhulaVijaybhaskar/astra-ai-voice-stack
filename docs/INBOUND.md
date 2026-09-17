# Inbound config (Phase 17)

Customers own **Inbound** routing on an assigned Phone Number → Employee.

## Model

Stored on the Phone Number (tenant scoped):

| Field | Notes |
| --- | --- |
| `inboundEnabled` / answer | Whether the number answers inbound calls |
| `inboundGreeting` | Greeting text (synced to linked Employee agent) |
| `inboundHours` | `{ timezone, mode: always\|schedule, windows[] }` |

Reuses existing Phone Number ↔ Employee assign and workflow binding. No provider portal.

## API

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/api/phone-numbers/:id/inbound` | Customer Inbound config. |
| `PUT` / `PATCH` | `/api/phone-numbers/:id/inbound` | Body `{ answer, greeting, hours }`. |
| `PATCH` | `/api/phone-numbers/:id` | Also accepts greeting / hours / answer. |

Public JSON never includes Dograh / VoBiz / SIP / trunk jargon.

## UI

Employee Studio → **Assign Number** tab shows Inbound answer, greeting, and hours after a Phone Number is assigned. Phone Numbers list links **Inbound** back to that tab.

## See also

- [PHONE-NUMBERS.md](./PHONE-NUMBERS.md)
- [EMPLOYEES.md](./EMPLOYEES.md)
