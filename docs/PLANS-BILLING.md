# Plans, credits, and payments (Sprint 6 + Phase 20)

## Plans

| Plan | Included credits | Numbers | Employees | Minutes |
| --- | --- | --- | --- | --- |
| Starter | ₹50 (5,000 paise) | 1 | 2 | 100 |
| Growth | ₹250 (25,000 paise) | 3 | 10 | 1,000 |
| Scale | ₹1,000 (100,000 paise) | 10 | 50 | 10,000 |

Signup also keeps the existing ₹10 `trial_grant`. Plan grants use idempotent
`plan_grant:<tenantId>:<planId>` ledger references.

Legacy `studio` plan values migrate to `starter`. Schema v13 adds
`includedEmployees` and `includedMinutes` on tenants.

### Routes

- `GET /api/plans` catalog (includes entitlements)
- `POST /api/plans/upgrade` `{ planId }` owner required (no V1 downgrades)
- `GET /api/wallet` returns wallet, ledger, plan, **entitlements**, top-up packs, recent usage, PayU env flags. `providerInvoices` is always `null` for customers.
- `GET /api/billing/entitlements` packaging usage vs included allowances (honest counts only)

Entitlement `used` counts come from real Phone Numbers, Employees, and call
`durationSec` minutes. Empty wallets and zero usage stay empty. Never invent balances.

## Top-up packs (PayU)

Packs `starter` / `growth` / `scale` remain PayU products (₹200 / ₹500 / ₹1,000).

Set in `.env`:

```
PAYU_KEY=...
PAYU_SALT=...
PAYU_ENV=test
RAPIDX_PUBLIC_URL=https://your-public-https-origin
```

`PAYU_ENV=test` (default when not `production`) uses `test.payu.in`. Browser
returns never credit the wallet. Only verified PayU callbacks do.

## Super Admin test credits

- `POST /api/admin/wallet/adjust` existing signed adjustment
- `POST /api/admin/wallet/test-credits` `{ tenantId, amountPaise, idempotencyKey, reason }` grants positive test credits (`test_credit` ledger type)

Customers never see provider invoices on Billing.

## Usage debits

Soft ledger debits on TTS chars (1 paise / 1k chars) and telephony dials
(10 paise / call). Never drive the wallet negative. Usage counters in `usage`
remain the primary meter.
