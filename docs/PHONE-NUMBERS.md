# Phone Numbers (Phases 13 + Sprint 1)

Astra-first Phone Number control plane. Customers manage numbers inside Astra only. Provider plumbing (Dograh / VoBiz) stays server-side behind `DograhVobizProvider`. Customer UI language is **Phone Number** only. Never SIP, DID portal, or provider console terms.

## Test inventory (no purchase)

Purchase is deferred (`POST /api/phone-numbers/purchase` returns **501** `purchase_deferred`).

On boot the dashboard seeds one platform-owned number:

| Field | Value |
| --- | --- |
| id | `pn_platform_astranova_main` |
| e164 | `+918065353938` |
| label | AstraNova Main Line |
| status | `available` until assigned |

Secrets and API keys are never returned. Public JSON exposes Astra `id`, `e164`, label, capabilities, status, Employee assignment, inbound/outbound toggles only.

## Assign to Employee (Phase 13)

`POST /api/phone-numbers/:id/assign` accepts `{ employeeId }` (preferred) or legacy `{ agentId }`.

- Resolves the Employee's linked `agentId` for telephony DID wiring
- Sets `number.assignedEmployeeId` and `employee.phoneNumberId` to the same `pn_` id
- Unassign clears both sides and returns the number to inventory

Studio **Assign Number** tab and the Phone Numbers page both use real `pn_` ids end to end.

## API (cookie auth, tenant scoped)

```bash
# Tenant's assigned Phone Numbers (optional ?q= search)
curl -s -b cookies.txt 'http://localhost:8787/api/phone-numbers?q=Astra'

# Platform inventory available to assign
curl -s -b cookies.txt http://localhost:8787/api/phone-numbers/available

# Assign to an Employee
curl -s -b cookies.txt -X POST http://localhost:8787/api/phone-numbers/pn_platform_astranova_main/assign \
  -H 'Content-Type: application/json' \
  -d '{"employeeId":"emp_...","inboundEnabled":true,"outboundEnabled":true}'

# Unassign
curl -s -b cookies.txt -X POST http://localhost:8787/api/phone-numbers/pn_platform_astranova_main/unassign \
  -H 'Content-Type: application/json' -d '{}'
```

## Schema

Additive **schemaVersion 12**: `phoneNumbers.assignedEmployeeId` (backfill from Employee.phoneNumberId / agent link). See [EMPLOYEES.md](./EMPLOYEES.md), [CAMPAIGNS-ANALYTICS.md](./CAMPAIGNS-ANALYTICS.md).

## Adapter

- `dashboard/lib/phone-numbers.js`: seed, list/search, assign/unassign/patch, public serialization
- `dashboard/lib/telephony-provider.js`: `assignNumber` passes `employeeId`

## UI

Sidebar **Phone Numbers**: search, assigned list, available inventory with Employee dropdown. Employee Studio **Assign Number** tab. Outbound dial still requires explicit confirm.
