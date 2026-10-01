# TTS Voice Catalog (Astra Voice)

Draft-only voice catalog for **Astra Voice**. Dograh is the runtime engine underneath. Customer framing stays Astra Voice. Does not change live production TTS or Maya workflow voices.

## Endpoints

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/api/voice/catalog` | Authenticated. Unified Dograh + Deepgram + Sarvam + Rumik catalog. Optional `?provider=`, `?mode=`. |
| `GET` | `/api/voice/draft-prefs` | Authenticated. Tenant draft prefs (unified shape). |
| `PUT` / `POST` | `/api/voice/draft-prefs` | Owner/admin. Saves draft prefs. `apply_live` always false. `set_active` queues a request only (`applied=false`). |
| `GET` | `/api/tts/voices` | Legacy flat catalog (Sarvam + Deepgram Aura + Rumik). Prefer `/api/voice/catalog`. |
| `GET` / `PUT` | `/api/tts/draft-prefs` | Alias of the voice draft-prefs routes. |
| `POST` | `/api/tts` | Existing synthesize for Preview. Keys never returned. |

## Unified catalog shape

```json
{
  "providers": [
    {
      "provider": "dograh",
      "mode": "managed",
      "voices": [{
        "id": "default",
        "name": "Dograh Default",
        "language": "multi",
        "locale": "multi",
        "gender": "",
        "style": "managed",
        "speed_supported": true
      }]
    }
  ],
  "voice_modes": [
    { "id": "astra_auto", "label": "Astra Auto" },
    { "id": "dograh_managed", "label": "Dograh Managed" },
    { "id": "byok", "label": "BYOK" }
  ],
  "provider_options": [
    { "id": "auto", "label": "Auto" },
    { "id": "dograh", "label": "Dograh" },
    { "id": "deepgram", "label": "Deepgram" },
    { "id": "sarvam", "label": "Sarvam" },
    { "id": "rumik", "label": "Rumik" }
  ],
  "live_apply_enabled": false,
  "set_active_enabled": false
}
```

Sarvam rows also keep prior normalized fields (`voice_id`, `display_name`, `model`, `status`) alongside the unified keys.

## Discovery sources

| Source | How | Used for |
| --- | --- | --- |
| Dograh `GET /api/v1/organizations/model-configurations/v2/defaults` | Live when `DOGRAH_BASE_URL` + `DOGRAH_API_KEY` are set. Adapter: `dashboard/lib/dograh-voice-discovery.js`. | Managed voices / speeds / languages + BYOK TTS JSON schemas (Deepgram, Sarvam, Rumik, etc.) + Speech-to-Speech realtime provider schemas. |
| Local Dograh defaults mirror | Fallback when Dograh env is unset or upstream fails. | Managed block only. |
| `dashboard/lib/tts-voice-catalog.js` | Curated static config (no HTML scrape). | Deepgram Aura, Sarvam Bulbul, Rumik voices when Dograh schema is sparse or offline. |

Never scrapes HTML. Never returns provider API keys. Secrets are stripped from Dograh payloads before serialization.

## UI controls

Settings and Employee Voice panels surface:

- Voice Mode: Astra Auto / Dograh Managed / BYOK
- Provider: Auto / Dograh / Deepgram / Sarvam / Rumik
- Language, Voice, Speed
- Preview / Save draft / Set active (disabled for production)

Astra Auto is the long-term product abstraction. Dograh remains the engine underneath.

## Production safety

- Process default remains `TTS_PROVIDER=rumik` (or whatever is already set).
- Employee create still composes agents with Rumik TTS.
- Draft prefs never flip Dograh / Maya / workflow TTS.
- Preview synthesizes via `/api/tts` only. It does not write active config.
- Set active is gated (`set_active_enabled: false`). A request may be recorded with `applied: false` only.
- English Rumik fallback (`speaker_2` / `mulberry` / `en-IN`) is preserved until another config is validated.

## Smoke

```sh
cd dashboard
node --test test/tts-voice-catalog.test.js test/voice-catalog.test.js test/providers.test.js
# With a running server + session cookie:
curl -sS -b 'rxv_sess=...' 'http://127.0.0.1:8787/api/voice/catalog' | head
```

Optional preview / discovery keys (server `.env` only): `DOGRAH_BASE_URL`, `DOGRAH_API_KEY`, `SARVAM_API_KEY`, `DEEPGRAM_API_KEY` (Aura uses the same Deepgram key as STT).
