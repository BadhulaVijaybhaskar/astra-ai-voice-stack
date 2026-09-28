# Celebrity / brand voices (design placeholders)

UX and architecture placeholders only. **No real celebrity voice cloning.** Do not name individuals or claim product partnerships.

## Voice tiers (Employee Studio → Voice)

| Tier | Live for dials? | Notes |
| --- | --- | --- |
| **Standard** | Yes | Platform voice profiles. Default for Instant Leads and campaigns. |
| **Regional Premium** | No | Catalog stub for curated regional packs. |
| **Licensed Brand** | No | Catalog stub after brand rights clearance. |
| **Private Enterprise** | No | Catalog stub for private enterprise profiles. |

Selecting a non-Standard tier fails closed (`voice_tier_unavailable`). Public Employee JSON exposes `tier`, `tierLabel`, and `profileLabel` only. Raw TTS model/speaker ids stay server-side.

## Private Enterprise lifecycle (design only)

Intended future control plane. Not implemented as live telephony:

1. **Consent** — recorded talent / brand consent artifact  
2. **Dataset** — approved training / reference set (server-side only)  
3. **Private profile** — tenant-scoped voice profile id  
4. **Rights** — license window, territory, use cases  
5. **Audit** — who activated, when, which Employee  
6. **Revoke** — immediate disable + audit trail  

Until this pipeline ships, the UI shows Coming soon copy and refuses selection.

## API

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/api/employees/voice-tiers` | Catalog with `available` flags. |
| `PUT` | `/api/employees/:id/voice-tier` | `{ tier }`. Only `standard` succeeds today. |

## Out of scope

Sarvam migration, inventing celebrity partners, live cloning, or claiming licensed brand readiness for the celebrity demo.
