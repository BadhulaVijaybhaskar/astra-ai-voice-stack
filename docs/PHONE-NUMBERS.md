# Phone Numbers (Sprint 1)

Astra-first phone number control plane. Customers manage numbers inside Astra only. Provider plumbing (Dograh / VoBiz) stays server-side behind `DograhVobizProvider`.

## Test inventory (no purchase)

Purchase is deferred for the testing phase (`POST /api/phone-numbers/purchase` returns **501** `purchase_deferred`).

On boot the dashboard seeds one platform-owned number into the JSON store:

| Field | Value |
| --- | --- |
| e164 | `+918065353938` |
| label | AstraNova Main Line |
| status | `available` until assigned |
| provider mapping | stored server-side only (`dograhTelephonyConfigId`, `dograhPhoneNumberId`, inbound workflow `8`) |

Secrets and API keys are never written to the repo or returned to the browser. Public API responses expose Astra `id`, `e164`, label, capabilities, status, agent assignment, and inbound/outbound toggles only.

## API (cookie auth, tenant scoped)

```bash
# Tenant's assigned numbers
curl -s -b cookies.txt http://localhost:8787/api/phone-numbers

# Platform inventory available to assign
curl -s -b cookies.txt http://localhost:8787/api/phone-numbers/available

# Assign to an agent
curl -s -b cookies.txt -X POST http://localhost:8787/api/phone-numbers/pn_platform_astranova_main/assign \
  -H 'Content-Type: application/json' \
  -d '{"agentId":"ag_...","inboundEnabled":true,"outboundEnabled":true}'

# Unassign (returns to platform inventory)
curl -s -b cookies.txt -X POST http://localhost:8787/api/phone-numbers/pn_platform_astranova_main/unassign \
  -H 'Content-Type: application/json' -d '{}'

# Toggle inbound / outbound
curl -s -b cookies.txt -X PATCH http://localhost:8787/api/phone-numbers/pn_platform_astranova_main \
  -H 'Content-Type: application/json' \
  -d '{"inboundEnabled":true,"outboundEnabled":false}'

# Purchase (not implemented in V1 test)
curl -s -b cookies.txt -X POST http://localhost:8787/api/phone-numbers/purchase \
  -H 'Content-Type: application/json' -d '{}'
# -> 501 {"code":"purchase_deferred",...}
```

On assign, Astra sets `status=assigned`, `assignedAgentId`, and updates `agent.telephony.did` to the number digits. Dograh ids remain in `providerMetadata` for dial.

## Adapter

- `dashboard/lib/telephony-provider.js`: `TelephonyProvider` contract + `DograhVobizProvider`
- Uses existing `DOGRAH_*` env and `providers.telephony` for live dial / optional inventory sync
- `dashboard/lib/phone-numbers.js`: JSON collection helpers, seed, assign/unassign/patch, public serialization

## UI

Sidebar **Phone Numbers** lists assigned numbers (with inbound/outbound toggles) and available inventory with an agent dropdown to assign. Outbound dial remains on the same page with explicit confirm. Copy stays Astra-branded.
