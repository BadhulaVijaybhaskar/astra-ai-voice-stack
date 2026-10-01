# TTS Voice Catalog (Sarvam + Deepgram Aura + Rumik)

Draft-only voice catalog for **Astra Voice**. Does not change live production TTS or Dograh workflow voices.

## Endpoints

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/api/tts/voices` | Authenticated. Normalized catalog. Optional `?provider=sarvam\|deepgram\|rumik`, `?language=`, `?model=`. |
| `GET` | `/api/tts/draft-prefs` | Authenticated. Tenant draft prefs. |
| `PUT` / `POST` | `/api/tts/draft-prefs` | Owner/admin. Saves draft prefs. `apply_live` is always forced `false`. |
| `POST` | `/api/tts` | Existing synthesize. Pass `provider`, `voice_id` / `speaker`, `language` for preview. Keys never returned. |

## Normalized voice item

```json
{
  "provider": "sarvam",
  "voice_id": "shubh",
  "display_name": "Shubh",
  "language": "",
  "model": "bulbul:v3",
  "gender": "male",
  "status": "available"
}
```

Sarvam speakers are multilingual across official Bulbul languages; `language` on the row is empty and language pickers use `languages.sarvam` + `language_map.sarvam`.

## Config source

`dashboard/lib/tts-voice-catalog.js` is the single backend config file (Sarvam has no account voice-list API for this shape). Update speakers/models there without frontend changes.

## Production safety

- Process default remains `TTS_PROVIDER=rumik` (or whatever is already set).
- Employee create still composes agents with Rumik TTS.
- Draft prefs never flip Dograh / workflow TTS.
- UI Apply to live TTS control is disabled.

## Smoke

```sh
cd dashboard
node --test test/tts-voice-catalog.test.js
# With a running server + session cookie:
curl -sS -b 'rxv_sess=...' 'http://127.0.0.1:8787/api/tts/voices?provider=sarvam' | head
```

Optional preview keys (server `.env` only): `SARVAM_API_KEY`, `DEEPGRAM_API_KEY` (Aura uses the same Deepgram key as STT).
