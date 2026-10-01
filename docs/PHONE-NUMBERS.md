# Phone Numbers Workspace

Astra Voice Phone Numbers is a dedicated top-level product section. Customers buy, assign, and route numbers inside Astra. Provider portals (VoBiz / Dograh) stay invisible in normal UI (Advanced / Super Admin only).

## Tabs

| Tab | Purpose |
| --- | --- |
| My Numbers | Rich cards: number, Connected, label, assignee, capabilities, routing, today calls/minutes (`—` when unknown) |
| Buy Number | Marketplace search + confirmation drawer (Buy & Assign) |
| Assignments | Table: number / employee / direction / workflow / status + Change / Unassign / Test |
| Usage & Cost | Real Astra call aggregates only. Never invent metrics. |

Header **Get New Number** opens the Buy tab.

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

Initial adapter: `DograhVobizProvider` (VoBiz inventory + Dograh bind).

## Env

```
VOBIZ_AUTH_ID=
VOBIZ_AUTH_TOKEN=
# Required for a real paid purchase (never set in CI):
# ASTRA_ALLOW_LIVE_NUMBER_PURCHASE=1
```

Until VoBiz inventory credentials are configured, Buy shows setup guidance and My Numbers keeps platform test inventory. When search is live, the "purchase not available" copy is removed.
