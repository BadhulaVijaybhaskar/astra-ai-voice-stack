# Platform multilingual runtime — BEFORE evidence (Hostinger)

Captured tip: `41de8d5`. Exclude PSTN `716c8d6c`. call_id for EN→TE silence: none on legacy BT; vobiz WF8 runs below.

## ROOT CAUSE (confirmed)

**TTS `language_code` stuck at session-create `en-IN` / English-only path.**
Not ASR reject. Not Flux on the smoking-gun Browser Talk / vobiz runs (STT was already `nova-3-general` + `multi`).

When LLM emits Telugu after a language switch (or TE-first), TTS stays `en-IN` → **audible silence** while bot-text still shows Telugu.

## BEFORE runtime

| Layer | Before |
| --- | --- |
| Legacy BT STT | deepgram `nova-3-general` `multi` (OK) |
| Dograh STT + `multi` | could route Flux `flux-general-multi` (no TE) — banned defensively |
| BT TTS mint/stream | **never sent language**; defaulted `en-IN` |
| Voice lock | Maya often locked Deepgram Helena on omitted language; TE → `locked_voice_language_unsupported` OR Sarvam priya with **language stuck en-IN** |
| Mid-call | `applyCallLanguage` not wired to BT turns; languageVoiceConfig rows not used under locked policy (correct) but language_code also not updated (bug) |
| `primary_language` / `allowed_languages` | **null** on employee/session |
| Turn observability | no per-turn detected_lang / tts_language / ASR guard in filtered logs |
| ASR guard | Indic protected (not primary dropper) |

## Smoking-gun runs

| Run | Evidence |
| --- | --- |
| BT **140** (12:58 IST) | user “in Telugu” → LLM Telugu bot-text → user complain; TTS path historically Deepgram aura / en |
| BT mint **153** | STT multi, TTS lang en-IN, voice lock locked, initial lang en-IN |
| Control textchat **158** | Telugu STT+LLM works when TTS not in path → silence class = **TTS fail** |
| vobiz **167** `91a79e09-…` | ~4s greeting-only EN — short/silent hangup candidate |
| vobiz **168** `67b956bb-…` | EN dialog; wrong-lang ASR look |
| vobiz **165/166** | EN; 166 create_lead language=en |

## Maya config drift (emp_33eae8ef454680f0) — do not worsen

- `voice.language` = te-IN
- Top-level / languageVoiceConfig.te-IN → **tanya** (draft)
- Investor freeze: production TTS remains Sarvam bulbul:v3 **priya**
- Under `voice_lock=locked`: speaker stays **priya**; only `language_code` updates
- `allowedLanguages` / `primaryLanguage` were null → now first-class session fields

## AFTER runtime (this PR)

| Layer | After |
| --- | --- |
| Session contract | `primary_language`, `allowed_languages[]`, STT multi, `tts_language` every turn |
| BT TTS | mint + `/api/tts/stream` send `language` / `language_code` from detected/reply language |
| Voice lock | Multilingual employees lock Sarvam-capable speaker; Maya production_protected → **priya**; mid-call = language_code only |
| Flux | `language=multi` never routes Flux |
| Recovery | Empty STT / TTS fail → localized recovery utterance (never silence) |
| Observability | `language_turn`: primary, allowed, detected, raw/final, ASR guard, tts lang/voice |

#57 min_buffer PSTN silence is a **separate** fix already on main. Not this PR.
