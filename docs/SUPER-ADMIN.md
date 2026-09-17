# Super Admin diagnostics (Phase 21)

Super Admin is the only role that may see provider inventory, deploy identity detail, and cross-tenant operations. Customers never see Dograh, VoBiz, Deepgram, Rumik, Groq, or `providerRunId` values.

## Console

In the product shell, Super Admin sees **Diagnostics** (not a customer nav item). The console covers:

| Surface | Purpose |
| --- | --- |
| Provider health | Configured true/false + env key **names** only |
| Deploy / schema | gitSha (never invented), version, uptime, schemaVersion |
| Tenant overview | Counts, suspend / activate, drill-down |
| Test credits | Idempotent positive grants (`test_credit`) |
| Audit / support | Existing platform audit and tickets |

`GET /api/admin/diagnostics` returns the consolidated payload. `GET /api/admin/providers` is also Super Admin only (platform `admin` is denied).

## Health leak boundary

| Caller | `GET /api/health` |
| --- | --- |
| Anonymous / customer / admin | Sanitized `{ ok, uptime, version, gitSha, deployedAt }` — no `providers` |
| Super Admin | Detailed provider inventory (still secret-guarded) |

## Tenant suspend / activate

`POST /api/admin/tenants/status` with `{ tenantId, status }` accepts `active`, `suspended`, or `closed`. Sessions for inactive tenants are revoked. Soft capability is live on the tenant model and diagnostics overview.

## Test credits

`POST /api/admin/wallet/test-credits` grants positive paise with idempotency. Customers see wallet balance only, never the Super Admin grant path.

## Out of scope

- Live outbound dials to customer phones
- Phase 2 webhooks
- Invented analytics
- Showing diagnostics to non-Super-Admin roles

See [E2E-ACCEPTANCE.md](./E2E-ACCEPTANCE.md), [ORG-RBAC.md](./ORG-RBAC.md), [PLANS-BILLING.md](./PLANS-BILLING.md).
