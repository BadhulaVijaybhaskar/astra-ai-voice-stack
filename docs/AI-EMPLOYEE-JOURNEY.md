# AI Employee Setup Journey

Guided 7-step **Astra Voice** add-on for configuring and demoing an AI Employee (Maya investor-demo path).

## Enable

```sh
ENABLE_AI_EMPLOYEE_JOURNEY=1
# Optional pin:
# AI_EMPLOYEE_JOURNEY_EMPLOYEE_ID=emp_...
# CALCOM_EVENT_TYPE_ID=7294717
# CALCOM_EVENT_LABEL=Astra Voice Demo
```

Route (authenticated console): `#/ai-employee-setup`

When the flag is off, the nav item is hidden and `/api/ai-employee-journey` returns `404 feature_disabled`.

## Modes

| Mode | Behavior |
| --- | --- |
| **Live** | Reads/writes existing Employee, Knowledge, Voice draft prefs, Phone, Cal.com, Talk, Outcome, Actions. |
| **Demo preview** | Illustrative sample data only. Every block is labeled **Demo preview**. Never writes live call records. |

## Steps

1. **Employee** — real name, role, team, status, job, readiness bits
2. **Knowledge** — editable system prompt (employee instructions), real knowledge entries, qualification rules
3. **Voice & Language** — `GET /api/voice/catalog`, providers Dograh Managed / Deepgram Aura / Sarvam / Rumik, Preview + Save draft only (no production TTS flip)
4. **Routing** — `+918065353938`, working hours Asia/Kolkata, Cal.com Connected when `CALCOM_API_KEY` set (event 7294717 / Astra Voice Demo)
5. **Call** — realtime Talk when configured; no fake transcript in Live
6. **Outcome** — real extracted fields / provenance only when present
7. **Next** — real actions / metrics / Groq summary when available

## APIs

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/api/ai-employee-journey` | Aggregated journey payload |
| `PUT` | `/api/ai-employee-journey` | Persist draft step/mode + optional LIVE writes |
| `GET` | `/api/ai-employee-journey/calendar/test` | Cal.com connectivity check |
| `GET` | `/api/voice/catalog` | Unified voice catalog (draft) |
| `PUT` | `/api/voice/draft-prefs` | Draft prefs only (`apply_live` always false) |

`GET /api/me` includes `features.aiEmployeeJourney` when the flag is on.

## Safety

- Existing Astra Voice UI, routes, Talk, Settings, providers, n8n, Cal.com, Dograh, and `db.json` collections are preserved.
- Additive tenant field only: `tenant.aiEmployeeJourney`.
- Product name in UI: **Astra Voice** (never "Astra AI" in customer journey copy).
