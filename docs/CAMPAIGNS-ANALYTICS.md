# Campaigns and Performance (Phases 14–15 + Excel/CSV bulk)

## Campaigns (share CallJob)

Tenant-scoped outbound campaigns in `campaigns` + `campaignLeads`. Enqueue uses the **same CallJob + dial path** as Instant Leads (`placeOutboundCallJob` → `createOutboundCall`). No parallel dial stack.

### Customer journey

1. **Campaigns** → Create (name, AI Employee, concurrency, language, Start now / Schedule)  
2. Upload **.xlsx** or **.csv**  
3. Map columns (`phone_number` required; optional name, company, email, language, city, lead_source, notes + original extras)  
4. Validate → READY / INVALID / DUPLICATES  
5. Start / Schedule (`confirm:true`) → CallJobs → Conversations → Lead timeline → Campaign analytics → Export  

Statuses: `draft`, `ready`, `scheduled`, `running`, `paused`, `done`, `cancelled`.

Campaign lead row statuses include: `ready`, `invalid`, `duplicate`, `queued`, `scheduled`, `calling`, `connected`, `completed`, `no_answer`, `failed`, `retry_scheduled`, `cancelled` (plus legacy `pending` / `dialed` / `stub_queued`).

CallJob statuses (shared): `queued`, `scheduled`, `calling` (alias of legacy `dialing`), `connected`, `completed`, `no_answer`, `failed`, `retry_scheduled`, `cancelled`.

### Routes

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/api/campaigns` | List |
| `POST` | `/api/campaigns` | `{ name, employeeId?, concurrency?, language?, mode?, scheduledAt?, phoneNumberId? }` |
| `GET` | `/api/campaigns/:id` | Detail |
| `POST` | `/api/campaigns/:id/settings` | Patch settings |
| `POST` | `/api/campaigns/:id/upload` | `{ filename, contentBase64 }` or `{ text }` |
| `POST` | `/api/campaigns/:id/map` | `{ mapping: { phone_number, name, ... } }` |
| `GET/POST` | `/api/campaigns/:id/validate` | Launch checks + READY/INVALID/DUPLICATES |
| `POST` | `/api/campaigns/:id/start` | Alias of enqueue. Requires `confirm:true` |
| `POST` | `/api/campaigns/enqueue` | Legacy body `{ campaignId, confirm:true }` |
| `GET` | `/api/campaigns/:id/leads` | Results rows |
| `GET` | `/api/campaigns/:id/analytics` | Real CallJob / Call aggregates only |
| `GET` | `/api/campaigns/:id/export?format=csv\|xlsx\|json` | Outcomes + preserved original columns |
| `GET` | `/api/campaigns/sample.csv` | Safe demo asset |
| `GET` | `/api/campaigns/sample.xlsx` | Safe demo asset |
| `POST` | `/api/campaigns/employee` | Attach Employee |
| `POST` | `/api/campaigns/status` | Pause / resume / done |
| `POST` | `/api/campaigns/leads` | Legacy paste `phone, name` lines |

Enqueue without `confirm:true` returns **400** `needs_confirm`. Each batch is capped by `concurrency` (default 2, max 20). Malformed phones are never dialed. Formal `Lead` rows are created for timeline with idempotency `cmp:{campaignId}:{phone}`.

Public JSON never includes `providerRunId` or Dograh / VoBiz ids.

### Safe demo sample

`dashboard/demo-assets/campaign-demo-leads.csv` / `.xlsx` (also mirrored under `public/samples/` for API download):

- 5 non-dialable `900000000x` fixture rows (blocked by campaign phone normalize)
- 1 `REPLACE_WITH_AUTHORIZED_TEST` placeholder (INVALID until replaced with an authorized test DID)

Never ships random real mobiles. API: `GET /api/campaigns/sample.csv` / `sample.xlsx`.


## Performance (honest)

- `GET /api/performance` (alias of `GET /api/analytics`)
- Aggregates from real Call / Lead / Outcome / Campaign rows only
- Empty totals are zeros; `conversionRatePct` is `null` when there are no calls so the UI can show **—**
- Never invent conversion rates or chart series

UI nav: Instant Leads + Campaigns under **LEADS**. Performance stays in JOURNEY.

## Schema

Additive on existing `campaigns` / `campaignLeads` / `callJobs`. Cross-link [INSTANT-LEADS.md](./INSTANT-LEADS.md), [PHONE-NUMBERS.md](./PHONE-NUMBERS.md), [DEMO-READINESS.md](./DEMO-READINESS.md).
