# E2E acceptance (Phase 22)

Automated journey harness for the north-star path. **No unauthorized live dials.**

## North-star journey (mocked dial)

Covered by `dashboard/test/phases-21-22.test.js`:

1. Create AI Employee  
2. Instructions  
3. Training attach  
4. Outcomes  
5. Assign Phone Number  
6. Connect Lead  
7. CallJob with `confirm:true` **mocked** dial (no live telephony)  
8. Conversation list / public call JSON  
9. Timeline  
10. Performance honest empties (`conversionRatePct: null` when no calls)

Public JSON must never include `providerRunId`, Dograh, or VoBiz ids.

## A-gate regressions

| Gate | Expectation |
| --- | --- |
| Anon `/api/health` | No provider inventory / brand leak |
| `/api/admin/providers` | Super Admin only (admin/owner/member denied) |
| `/api/admin/diagnostics` | Super Admin only |
| Customer lead/call/job JSON | No `providerRunId` |

## LIVE PHONE PROOF: AWAITING EXTERNAL ACCEPTANCE

Automated tests **must not** place real outbound calls to customer phones. Live phone proof remains an external acceptance step (human QA with an authorized test DID and explicit confirm). Until that sign-off, treat live telephony as **PARTIAL — EXTERNAL BLOCKER**.

## How to run

```sh
cd dashboard && npm test
```

Phase 21–22 cases live in `test/phases-21-22.test.js` alongside the existing phase suites.

## Related docs

- [SUPER-ADMIN.md](./SUPER-ADMIN.md)  
- [EMPLOYEES.md](./EMPLOYEES.md)  
- [INSTANT-LEADS.md](./INSTANT-LEADS.md)  
- [CONVERSATIONS.md](./CONVERSATIONS.md)  
- [TIMELINE.md](./TIMELINE.md)  
- [CAMPAIGNS-ANALYTICS.md](./CAMPAIGNS-ANALYTICS.md)
