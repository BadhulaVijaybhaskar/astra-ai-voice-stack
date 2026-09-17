# Instant Leads (P0)

Smallest vertical slice: **Lead → CallJob → real outbound dial → Astra Call row**.

Customers never see Dograh, VoBiz, or provider ids. Seed number metadata stays server-side.

## What it does

1. Create a tenant-scoped lead (name + phone, optional employee/agent and workflow ids).
2. `POST /api/leads/:id/call` with `{ confirm: true }` creates a `CallJob`, dials via the canonical `telephonyProvider.createOutboundCall` path (same as `/api/telephony/dial`), and links the resulting Call when Dograh returns a real `providerRunId`.
3. Campaign enqueue advances `stub_queued` leads through the same helper (no parallel dial stub).

Composition stays relational: Lead and CallJob store `agentId`, `workflowId` (`wf_`), and `phoneNumberId` (`pn_`). Provider Dograh ints are resolved only inside `createOutboundCall`.

## API

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/api/leads` | Auth. Tenant-scoped list. |
| `POST` | `/api/leads` | `{ name, phone, agentId?, workflowId?, phoneNumberId?, idempotencyKey?, meta? }`. IN 10-digit phones normalize to `+91...`. |
| `GET` | `/api/leads/:id` | Lead + recent jobs. |
| `POST` | `/api/leads/:id/call` | Requires `confirm:true`. Places a real outbound call. Optional `idempotencyKey`. |

### CallJob statuses

`queued` → `dialing` → `completed` (dial accepted and tracked) or `failed` (upstream/error surfaced honestly).

Idempotency: tenant-scoped `idempotencyKey` on CallJob, and an active (`queued`|`dialing`) job for the same lead is reused so retries do not double-dial.

Public job/lead JSON never includes `providerRunId` or Dograh ids. Those stay on the server row only. Fake `providerRunId` values are never invented. If the dial is accepted without a run id, the job fails with `call_not_tracked`.

## UI

Dashboard nav: **Instant Leads** (OPERATE). Form: name, phone, employee/agent select, Save lead. Each lead has **Call now** (confirm modal) and **Open Calls**.

## How to test on VPS

1. Deploy/restart the dashboard with Dograh env set (`DOGRAH_*`).
2. Ensure the seed number is assigned to the tenant (Phone Numbers) so outbound metadata resolves.
3. Log in, open **Instant Leads**, create a lead with a real test mobile.
4. Click **Call now** → Confirm. Job should leave `queued` and become `completed` (or `failed` with a real error).
5. Open **Calls**. A new outbound row should appear when dial was accepted with a provider run id.
6. Optional: Campaigns → Enqueue batch with confirm. Leads should dial through the same helper.

## Schema

Additive migration to **schemaVersion 8**: collections `leads`, `callJobs`. Schema **v10** formalizes `employeeId` and statuses. See [LEADS.md](./LEADS.md).

## Out of scope

SPA rebuild, Teach UX polish beyond Employee Studio, billing, number purchase, Outpero copy, collapsing Agent/Workflow, Phase 2 webhooks, fake analytics, broad nav redesign.
