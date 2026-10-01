# LATENCY P0 — Sub-1000ms first audio (no PSTN)

**Tip baseline:** `7f03dd0` · Maya `emp_33eae8ef454680f0` · Dograh **WF8** · Sarvam `bulbul:v3` **priya** · DID `+918065353938`

**Primary metric:** `speech_end → first audible` (**<=1000ms** ordinary · stretch <=1200 · **hard fail >2500**).  
**Tool turns:** first spoken ack **<=1200ms**; Cal.com / tools stay in the background.  
**Latency ≠ shorter answers.** Once speech starts, Maya may continue as long as the question needs. Report **FIRST AUDIO** percentiles separately from **TOTAL RESPONSE DURATION**.

Stack preserved: Deepgram nova-3-general multi → Groq Llama 3.3 70B stream → Sarvam bulbul:v3 priya (Dograh) / Rumik WS (legacy Browser Talk). No realtime speech-to-speech swap.

---

## Workstreams (1–13)

| # | Workstream | Change |
| --- | --- | --- |
| 1 | Turn detection | Client VAD silence **450ms**; MediaRecorder **100ms**; Finalize settle **700ms**. Target `speech_end→stt_final` **<=250ms**. |
| 2 | Deepgram streaming | `/api/stt/stream` forces **nova-3-general** + `language=multi`, `endpointing=100`, `utterance_end_ms=700`. |
| 3 | Groq streaming TTFT | `/api/chat/stream` NDJSON. **Never wait `llm_complete` for TTS.** |
| 4 | Chunked LLM→TTS | `extractFirstSafePhrase` flushes first natural sentence/punct to TTS while LLM continues. |
| 5 | Sarvam first-audio | Overlay: Sarvam `silence_time_s=0.2`; Rumik `full_response_aggregation=false`. Voice stays **priya**. Dashboard uses first-phrase chunked REST/WS. |
| 6 | WF8 node trace | `GET /api/employees/maya/wf8-node-trace` marks REQUIRED_FOR_FIRST_RESPONSE YES/NO/ACK_ONLY. End Call = NO. Booking = ACK_ONLY. |
| 7 | Fast vs tool path | `voice-fast-path.classifyTurnPath`. Fast = stream phrase. Tool = ack-first. |
| 8 | Booking ack-first | Hindi/Hinglish/TE/EN ack spoken immediately; tools async. Silent wait >4s = FAIL. |
| 9 | Context compaction | First-response injection cap **420** chars (`firstResponse` / `maxChars`). Quality facts kept. |
| 10 | Prompt token audit | `auditPromptTokens` + cached Maya global prompt. Do not double-prepend policy. |
| 11 | Parallelize | Booking ack TTS ∥ Groq stream ∥ hangup-trace fire-and-forget. |
| 12 | Cache static | In-process `getCachedStatic('maya_global_prompt')`. |
| 13 | >=20 Browser Talk turns | Harness `test/latency-evidence-harness.test.js` + `docs/LATENCY-P0-SYNTHETIC-EVIDENCE.json`. Live Hostinger replaces AFTER_*. |

---

## Stage marks (absolute from `speech_end`)

`speech_end` → `stt_final` → `llm_request` → `llm_first_token` → `llm_complete` → `tool_start` → `tool_complete` → `tts_request` → `tts_first_audio` → `playback_start` → `response_complete`

APIs: `POST/GET /api/talk/latency`, `GET /api/talk/latency?summary=1`, `GET /api/talk/latency/report`, `POST /api/chat/stream`, `POST /api/talk/booking-ack`.

---

## Hostinger apply steps (manual · no PSTN from this PR)

1. **Deploy dashboard tip** from this branch. Preserve Hostinger `.env` (`DOGRAH_*`, `DEEPGRAM_*`, `GROQ_*`, `SARVAM_*`, Cal.com).  
2. **Rebuild Rumik/Dograh overlay** from `rumik-overlay-local/` (`bash deploy/02-build-rumik-overlay.sh` or equivalent). Confirm `full_response_aggregation` default false and Sarvam `silence_time_s=0.2`.  
3. **Diff/import** `workflows/maya-receptionist.json` into Dograh **WF8** (Global + Booking ack-first + adaptive length). Do **not** change DID, priya, or WF id.  
4. **Browser Talk** (Maya): run **>=20 turns** across EN / TE / MIXED / HI booking.  
5. Capture `GET /api/talk/latency/report` JSON. Paste AFTER_* into the FINAL REPORT below.  
6. Quality gates (human): ANSWER_COMPLETENESS · NATURAL_PACING · CUSTOMER_NOT_RUSHED · DEMO_PUSH_REDUCED.  
7. **Still no automation PSTN.** PSTN QA only after Browser Talk first-audio PASS.

---

## Irreducible floor (if sub-1000 impossible)

If live Hostinger shows `Groq TTFT + Sarvam TTFB` alone >1000ms after streaming, name that sum as the irreducible stage before proposing any architecture change. Do **not** switch to native realtime speech-to-speech solely because a transcript suggested it.

Designed budget (code path, not live RTT):

| Stage | Designed ms |
| --- | ---: |
| speech_end→stt_final | ~180–220 |
| stt_final→llm_first_token | ~220–300 |
| first_phrase→tts_first_audio | ~180–250 |
| **first_audio total** | **~900–1000** |
| total_response_duration | adaptive (may be multi-second; intentional) |

---

## FINAL REPORT fields

Fill AFTER_* from Hostinger `GET /api/talk/latency/report` after >=20 live turns. Synthetic designed numbers are in `docs/LATENCY-P0-SYNTHETIC-EVIDENCE.json`.

```
BEFORE tip: 7f03dd0
BEFORE first_audio median (proxy): 14403 ms
BEFORE mixed ~25800 ms
BEFORE max: 54597 ms
BEFORE bottleneck: WF8 LLM/tool especially booking (speech blocked on tools)

AFTER FIRST_AUDIO P50: <from Hostinger>
AFTER FIRST_AUDIO P90: <from Hostinger>
AFTER FIRST_AUDIO P95: <from Hostinger>
AFTER TOTAL_RESPONSE_DURATION P50: <from Hostinger>   # NOT optimized by shortening answers

ENGLISH FIRST_AUDIO P50/P90/P95: ...
TELUGU FIRST_AUDIO P50/P90/P95: ...
MIXED FIRST_AUDIO P50/P90/P95: ...
HINDI_BOOKING FIRST_AUDIO P50/P90/P95: ...

STAGE BREAKDOWN (median absolute from speech_end):
  stt_final: ...
  llm_first_token: ...
  tts_first_audio: ...
  tool_complete: ...
  response_complete: ...

BOTTLENECKS: ...
SILENT_WAITS fail_count (threshold 4000ms): ...

PASS/FAIL MATRIX:
  FIRST_AUDIO_ORDINARY_<=1000: PASS|FAIL|PENDING_HOSTINGER
  FIRST_AUDIO_STRETCH_<=1200: PASS|FAIL|PENDING_HOSTINGER
  HARD_FAIL_>2500: PASS|FAIL|PENDING_HOSTINGER
  TOOL_ACK_<=1200: PASS|FAIL|PENDING_HOSTINGER
  ANSWER_COMPLETENESS: PASS|FAIL|PENDING_HOSTINGER
  NATURAL_PACING: PASS|FAIL|PENDING_HOSTINGER
  CUSTOMER_NOT_RUSHED: PASS|FAIL|PENDING_HOSTINGER
  DEMO_PUSH_REDUCED: PASS|FAIL|PENDING_HOSTINGER
  TELUGU_ASR_GUARD: PASS (preserved)
  HINDI_BOOKING_NO_HANGUP: PASS (preserved)
  SARVAM_PRIYA_WF8: PASS (preserved)
  CALCOM_UID_GATE: PASS (preserved)
  CONTINUOUS_CONTEXT_QUALITY: PASS (compacted, not deleted)

READY FOR PSTN QA: NO_PENDING_HOSTINGER_MEASUREMENT
```

---

## Unit / harness

```sh
cd dashboard && node --test \
  test/latency-p0-2.test.js \
  test/turn-latency.test.js \
  test/latency-evidence-harness.test.js \
  test/maya-conversation-policy.test.js \
  test/asr-sanity-guard.test.js
```

See also `docs/LATENCY-P0-2.md` for Sarvam TOKEN aggregation, WF8 pre-speech Groq
deferrals, generalized first-audio plan, and Groq 429 bounded fallback.
