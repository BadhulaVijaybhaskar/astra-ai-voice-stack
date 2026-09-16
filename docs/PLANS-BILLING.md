# Plans, credits, and payments (Sprint 6)

## Plans

| Plan | Included credits | Included numbers |
| --- | --- | --- |
| Starter | ₹50 (5,000 paise) | 1 |
| Growth | ₹250 (25,000 paise) | 3 |
| Scale | ₹1,000 (100,000 paise) | 10 |

Signup also keeps the existing ₹10 `trial_grant`. Plan grants use idempotent
`plan_grant:<tenantId>:<planId>` ledger references.

Legacy `studio` plan values migrate to `starter`.

### Routes

- `GET /api/plans` catalog
- `POST /api/plans/upgrade` `{ planId }` owner required (no V1 downgrades)
- `GET /api/wallet` returns wallet, ledger, plan, top-up packs, recent usage, PayU env flags

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

## Usage debits

Soft ledger debits on TTS chars (1 paise / 1k chars) and telephony dials
(10 paise / call). Never drive the wallet negative. Usage counters in `usage`
remain the primary meter.
