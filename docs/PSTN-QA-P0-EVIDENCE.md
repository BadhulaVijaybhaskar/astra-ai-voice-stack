# PSTN QA P0 evidence matrix (score was 34/100)

Fixes land as code + policy in this PR. **Do not place PSTN from the cloud agent.**
Hostinger staging is live for human validation after merge/deploy.

Maya fixture: `emp_33eae8ef454680f0` · Dograh WF8 · Sarvam `bulbul:v3` priya · DID `+918065353938`.

---

## P0-1 Telugu / mixed-language ASR

| Item | Expected | Code / evidence |
| --- | --- | --- |
| Phrase A | `ఇది లీడ్ క్వాలిఫికేషన్ కి ఎలా యూస్ అవుతుంది?` accepted | `asr.QA_FIXTURES.telugu_mixed` + unit test |
| Phrase B | `hot leads should be passed to the sales team` accepted | `te_en_hot_leads` fixture |
| Garbage | `jc hot need matters sales team antibiotics` **rejected** | `evaluateTranscript` → `action=reject` |
| STT path | Deepgram `nova-3-general` + `language=multi` preferred | `VALIDATED_MULTILINGUAL_STT` + `/api/stt/stream` query |
| Capture | provider/model/lang, partials, final, confidence, guard, llm allow | `buildSttTrace` + `POST /api/stt` envelope |
| Guard | garbage never enters normal `/api/chat` business dialogue | `apiChat` pre-check on last user turn |

### Reproduce (Browser Talk / Hostinger)

1. Employee Studio → Maya → Talk (or Hostinger Browser Talk).
2. Speak Phrase A (Telugu mixed) and Phrase B (TE-EN).
3. Inspect Network: `POST /api/stt` / stream ProxyReady model, and any chat turn.
4. Paste a garbage string into legacy Talk text box: chat must clarify/reject, not answer as if it were a real sales sentence.
5. Unit: `cd dashboard && node --test test/asr-sanity-guard.test.js`

---

## P0-2 Hindi booking must not terminate

| Item | Expected | Code / evidence |
| --- | --- | --- |
| Phrase | `Okay, demo schedule kar sakte ho?` | booking intent, **not** end-call |
| Flow | email → availability → offer slot → confirmation → Cal.com | `BOOKING_STAGES` |
| Hangup | If agent ended on that phrase → `booking_intent_misfire` | `classifyHangupCause` |
| Workflow | End Call edges forbid booking language | `workflows/maya-receptionist.json` |
| WF8 | Protected. Manual Hostinger import only | `maya_production_protected` |

### Reproduce (Browser Talk)

1. Start Maya Talk. Say the Hindi booking phrase.
2. Call must continue into email ask (not hang up).
3. `POST /api/talk/hangup-trace` with last user text should report `end_call_eligible=false`.
4. Unit: `node --test test/maya-conversation-policy.test.js`

### Hostinger hangup trace

When a live call ends, record: provider `HangupCause`, last user transcript, workflow end node.
Feed into `classifyHangupCause`. P0 failure signature: `booking_intent_misfire`.

---

## P0-3 Latency instrumentation (9–12s)

| Marker | Meaning |
| --- | --- |
| `speech_end` | VAD decided user stopped |
| `stt_final` | Final transcript ready |
| `llm_request` | Brain request started |
| `llm_first_token` | First LLM token (or first usable chunk) |
| `llm_complete` | Brain finished |
| `tts_request` | Voice mint/request started |
| `tts_first_audio` | First audio bytes |
| `playback_start` | Browser started playback |

API: `POST /api/talk/latency`, `GET /api/talk/latency?slowOnly=1`.

Slow threshold default: **9000 ms** speech_end → playback_start.

### Reproduce

1. Browser Talk legacy path (mic loop) emits stage marks to `/api/talk/latency`.
2. After a slow turn, `GET /api/talk/latency?slowOnly=1` shows bottleneck gap.
3. Unit: `node --test test/turn-latency.test.js` (synthetic 10.1s slow turn).

WebRTC Dograh embed path: wall-clock call duration remains in UI; stage marks that are not observable client-side are documented as `n/a` until Dograh run metrics are pulled on Hostinger.

---

## P0-4 Repetitive demo push

| Rule | Enforcement |
| --- | --- |
| Understand need first | Maya global policy |
| 2–4 qualification questions | `qualify_min/max` + question bank |
| Summarize then suggest booking | instructions + Qualify stage |
| On demo intent: stop selling → booking | `nextDialogueAction` + Booking stage |

Prompts: `prompts/maya-system-prompts.md`.

---

## Hostinger validation checklist (human)

1. Deploy dashboard tip. Preserve `.env` (`DOGRAH_*`, `DEEPGRAM_*`, `GROQ_*`, `SARVAM_*`, Cal.com).
2. Diff/import Maya prompts/edges from `workflows/maya-receptionist.json` into WF8 (manual).
3. Browser Talk: Telugu + TE-EN phrases; confirm transcripts + no garbage answers.
4. Browser Talk: Hindi booking phrase; confirm email ask, no hangup.
5. Capture one slow turn latency JSON if delay ≥ 9s.
6. Confirm Maya still does not auto-pitch demo before qualification.
7. **Still do not place PSTN from automation.** Optional human PSTN only after Browser Talk pass.

---

## Unit test command

```sh
cd dashboard && node --test \
  test/asr-sanity-guard.test.js \
  test/maya-conversation-policy.test.js \
  test/turn-latency.test.js
```
