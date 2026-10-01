# Phone Numbers Workspace

Astra Voice Phone Numbers is a dedicated top-level product section. Customers buy, assign, and route numbers inside Astra. Provider portals (VoBiz / Dograh) stay invisible in normal UI (Advanced / Super Admin only).
## Tabs

| Tab | Purpose |
| --- | --- |
| My Numbers | Rich cards: number, Connected, label, assignee, capabilities, routing, today calls/minutes (`—` when unknown) |
| Buy Number | Marketplace search + confirmation drawer (Buy & Assign). Plivo India probe is display-only. |
| Assignments | Table: number / employee / direction / workflow / status + Change / Unassign / Test |
| Usage & Cost | Real Astra call aggregates only. Never invent metrics. |
| Providers / Advanced | Owner+: VoBiz + Plivo connection status (Connected / Needs setup / Error). No secrets. |

Header **Get New Number** opens the Buy tab.
Purchase is deferred (`POST /api/phone-numbers/purchase` returns **501** `purchase_deferred`).

On boot the dashboard seeds platform-owned numbers:

| Field | Main | Alternate |
| --- | --- | --- |
| id | `pn_platform_astranova_main` | `pn_platform_astranova_alt` |
| e164 | `+918065353938` | `+918065353939` |
| label | AstraNova Main Line | AstraNova Alternate Line |
| status | `available` until assigned | `available` until assigned |

Secrets and API keys are never returned. Public JSON exposes Astra `id`, `e164` / Business Number, label, capabilities, connection state, Employee assignment, inbound/outbound toggles, and workflow **product name** only.

## Per-employee phone configuration

Each AI Employee persists:

`assigned_phone_number`, `telephony_provider`, `direction`, `inbound_enabled`, `outbound_enabled`, `caller_id`, `dograh_phone_id`, `telephony_config_id`, `workflow_id`, `answer_url`, `hangup_callback`, `working_hours`, `after_hours_action`, `escalation_target`

Stored on `employee.phoneConfig` (schemaVersion **15**). Raw provider ids are Advanced-only.

### Connection states

`Unassigned` | `Connected` | `Inbound only` | `Outbound only` | `Inbound + Outbound` | `Needs attention`

### Assignment path

Astra UI → `employee_id` → select available number → bind phone to employee/workflow → update Dograh telephony mapping (dry-run when not live) → persist answer URL / hangup callback → verify callback shape → persist in Astra.

Do not hardcode Maya. Changing Vaani never mutates Maya's phone mapping.

```bash
# Employee phone config (customer shape)
curl -s -b cookies.txt http://localhost:8787/api/employees/emp_.../phone-config

# Advanced (provider ids)
curl -s -b cookies.txt 'http://localhost:8787/api/employees/emp_.../phone-config?advanced=1'

# Assign / change / unassign
curl -s -b cookies.txt -X POST http://localhost:8787/api/employees/emp_.../phone-config/assign \
  -H 'Content-Type: application/json' \
  -d '{"numberId":"pn_platform_astranova_main","inboundEnabled":true,"outboundEnabled":true}'

curl -s -b cookies.txt -X POST http://localhost:8787/api/employees/emp_.../phone-config/change \
  -H 'Content-Type: application/json' -d '{"numberId":"pn_platform_astranova_alt"}'

curl -s -b cookies.txt -X POST http://localhost:8787/api/employees/emp_.../phone-config/unassign \
  -H 'Content-Type: application/json' -d '{}'

# Dry-run preflight only. Never places paid PSTN calls.
curl -s -b cookies.txt -X POST http://localhost:8787/api/employees/emp_.../phone-config/test-inbound \
  -H 'Content-Type: application/json' -d '{}'

curl -s -b cookies.txt -X POST http://localhost:8787/api/employees/emp_.../phone-config/test-outbound \
  -H 'Content-Type: application/json' -d '{}'
```
Employee **Routing** is assign / change / unassign only. Change opens the central inventory selector. Purchasing is not embedded in employee pages.

## Safety

- Purchase requires `confirm: true` and price match on quoted monthly / setup fees.
- Live VoBiz debit requires `ASTRA_ALLOW_LIVE_NUMBER_PURCHASE=1`.
- UI and tests use `simulate: true` (or mock client) so development never charges.
- Release requires `confirm: true`. Maya platform number `+918065353938` cannot be released.
- Moving an assigned number between employees requires `confirmReassign: true` (no silent moves).
- **Connected** only after provider verified + Dograh mapping + callback URLs all pass. Status checks do not place PSTN calls.

## API
```bash
GET  /api/phone-numbers
GET  /api/phone-numbers/available
POST /api/phone-numbers/search
GET|POST /api/phone-numbers/pricing?e164=+91...
POST /api/phone-numbers/purchase   # confirm:true required
GET  /api/phone-numbers/usage
GET  /api/phone-numbers/:id
POST /api/phone-numbers/:id/assign
POST /api/phone-numbers/:id/unassign
POST /api/phone-numbers/:id/release   # confirm:true
POST /api/phone-numbers/:id/configure
POST /api/phone-numbers/:id/status    # verify without dialing
```

## TelephonyProvider

`listNumbers`, `searchAvailableNumbers`, `getPricing`, `purchaseNumber`, `releaseNumber`, `assignNumber`, `configureNumber`, `getUsage`, `getNumberStatus`.

Active adapter: `DograhVobizProvider` (VoBiz inventory + Dograh bind). Maya / production dial stays here.

Secondary adapter: `PlivoProvider` (org-level `PLIVO_AUTH_ID` / `PLIVO_AUTH_TOKEN`). Validates auth, account, balance, owned numbers, India search, pricing, inbound XML/app config, outbound initiation (dry-run), status callbacks, audio streaming hooks, and recording metadata. Never the default dial path. Purchase on Plivo is refused.

Advanced UI (`Phone Numbers` → Providers / Advanced, owner+): VoBiz Connected / Needs setup / Error and Plivo Connected / Needs setup / Error. Auth ID and Auth Token are never returned.

Buy Number for Plivo: Astra probes India inventory via Plivo search before showing a display-only Buy control. Empty or failed search means no Buy. No invented inventory or pricing. No purchase.

## Env

```
VOBIZ_AUTH_ID=
VOBIZ_AUTH_TOKEN=
# Required for a real paid purchase (never set in CI):
# ASTRA_ALLOW_LIVE_NUMBER_PURCHASE=1

# Secondary Plivo (optional). Never switch Maya to Plivo.
# PLIVO_AUTH_ID=
# PLIVO_AUTH_TOKEN=
```

Until VoBiz inventory credentials are configured, Buy shows setup guidance and My Numbers keeps platform test inventory. When search is live, the "purchase not available" copy is removed.
## Schema

Additive **schemaVersion 15**: `employee.phoneConfig`, phone number `answerUrl` / `hangupCallback`, alternate inventory seed. See [EMPLOYEES.md](./EMPLOYEES.md).

## Adapter

- `dashboard/lib/phone-numbers.js`: seed, list/search, assign/unassign/patch, inbound get/set, public serialization, connection states
- `dashboard/lib/employee-phone-config.js`: per-employee persist, assign/change/unassign, dry-run tests, isolation
- `dashboard/lib/telephony-provider.js`: `assignNumber` persists phoneConfig + dry-run telephony mapping

## UI

Employee Studio **Routing** (narrow scope for this PR):
- Shows **Assigned Phone Number** and **Status** (`Connected` / `Unassigned`)
- Buttons: **Assign** / **Change** / **Unassign**
- Change and Assign open a modal selector over **Phone Numbers workspace inventory** (`/api/phone-numbers/available`)
- Link out to Phone Numbers workspace for inventory management
- **No buy / purchase marketplace** inside employee pages (that belongs to the top-level Phone Numbers workspace)

Sidebar **Phone Numbers** remains the inventory workspace. Outbound dial still requires explicit confirm. Test inbound/outbound APIs are dry-run only and are not shown on the employee Routing tab.