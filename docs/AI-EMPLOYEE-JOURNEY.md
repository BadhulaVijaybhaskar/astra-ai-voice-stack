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

This route is **Guided Setup / Demo Journey** only. It is not primary product navigation.
Primary console IA is Overview · AI Employees · Calls · Conversations · Leads · Automations · Integrations · Analytics · Settings.
Maya Overview deep-links here via Configure Maya / Run Live Demo / Guided Setup.

When the flag is off, the TOOLS nav item is hidden and `/api/ai-employee-journey` returns `404 feature_disabled`.

## Investor paths (primary CTAs)

| CTA | Behavior |
| --- | --- |
| **Configure Maya** | Live mode. Starts at Step 1 and walks the 7-step setup with real workspace data. |
| **Run Live Demo** | Live mode. Skips config forms and jumps to Live conversation (realtime Talk) → structured result → next action. Never writes DEMO PREVIEW fixtures into live records. |

Chrome label is always **AstraConnect Workspace**. Live shows a **LIVE** badge; Demo Preview shows **DEMO PREVIEW**.

## Modes

| Mode | Behavior |
| --- | --- |
| **Live** | Reads/writes existing Employee, Knowledge, Voice draft prefs, Phone, Cal.com, Talk, Outcome, Actions. Never invents Connected/transcript/metrics. |
| **DEMO PREVIEW** | Labeled illustrative sample only. Never writes live call records. No fake investor KPIs (128 / 46% / 38). No production hardcodes of fictional people or fake DIDs. |

## Steps

1. **Employee** — Configure Maya / Run Live Demo CTAs + real readiness
2. **Knowledge** — editable system prompt, real knowledge, qualification rules
3. **Voice & Language** — `GET /api/voice/catalog`, Astra Auto draft (provider brands not primary investor UI)
4. **Routing** — real DID when assigned (`+918065353938` preferred), Asia/Kolkata hours, Cal.com Connected when keyed
5. **Call** — realtime Talk; Live starts Ready (not fake Connected); tool chips
6. **Outcome** — real extracted fields / provenance / Groq summary when present
7. **Next** — real actions / metrics / summary when available

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
- Product chrome: **AstraConnect Workspace** / **Astra Voice** (never "Astra AI" in customer journey copy).
