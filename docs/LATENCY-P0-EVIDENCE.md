# LATENCY P0 / P0.2 — Sub-1000ms first audio (no PSTN)

**Tip baseline:** `7f03dd0` · Maya `emp_33eae8ef454680f0` · Dograh **WF8** · Sarvam `bulbul:v3` **priya** · DID `+918065353938`

**Primary metric:** `speech_end → first audible` (**<=1000ms** ordinary · stretch <=1200 · **hard fail >2500**).  
**Tool turns:** first spoken ack **<=1200ms**; Cal.com / tools stay in the background.  
**Latency ≠ shorter answers.** Once speech starts, Maya may continue as long as the question needs. Report **FIRST AUDIO** percentiles separately from **TOTAL RESPONSE DURATION**.

Stack preserved: Deepgram nova-3-general multi → Groq Llama 3.3 70B stream → Sarvam bulbul:v3 priya (Dograh) / Rumik WS (legacy Browser Talk). No realtime speech-to-speech swap.

---

## P0.2 measurement semantics (blocking)

Every Browser Talk turn emits a **monotonic** `stage_trace` with **one clock** (client `performance.now` offsets from `speech_end`):

| Mark | Stage |
| --- | --- |
| t0 | speech_end |
| t1 | stt_final |
| t2 | llm_request |
| t3 | llm_first_token |
| t4 | first_safe_phrase |
| t5 | tts_request |
| t6 | tts_first_audio (first byte) |
| t7 | playback_start |

**Derived (same turn, same origin):**

- STT = t1−t0  
- orchestration = t2−t1  
- Groq TTFT = t3−t2  
- phrase_accum = t4−t3  
- TTS TTFB = t6−t5  
- playback_buffer = t7−t6  
- TOTAL = t7−t0  

Exposed in `GET /api/talk/latency/report` as `report.STAGE_BREAKDOWN` and per-trace `stage_trace` / `derived_ms`. Browser Talk UI shows STT · TTFT · TTS · TOTAL from the same offsets.

### Why prior Hostinger medians looked inconsistent

Live flawed P0.1 sample: FIRST_AUDIO P50 **1764** / P90 **3257** / P95 **3362**; HI booking ack P50 **707**; reported Groq TTFT ~**808** + TTS first-byte ~**1876** while TOTAL first audio P50 was **1764**.

Those stage medians were **not additive** because:

1. Server `Date.now` was written into client `llm_first_token` while `speech_end` used client `Date.now` (clock skew).  
2. UI "Brain" used full stream `latency_ms`, not TTFT.  
3. TTS duration used `performance.now` while stages used `Date.now`.  
4. TTFT and TTS TTFB run in parallel with phrase accumulation; they are not a serial sum.  
5. **Never sum medians across unrelated turns.** Percentile each derived gap independently from per-turn `stage_trace`. Do **not** compute `P50(TTFT)+P50(TTFB)` and compare to `P50(TOTAL)`.

Harness / synthetic numbers in `docs/LATENCY-P0-SYNTHETIC-EVIDENCE.json` are **non-acceptance**. Live Hostinger replaces AFTER_* after coordinator retest.

---

## P0.2 workstreams

| # | Workstream | Change |
| --- | --- | --- |
| 0 | Measurement | Monotonic t0–t7 `stage_trace`; report STAGE_BREAKDOWN; UI marks; document non-additive medians. |
| 1 | Groq rate limit | Classify HTTP **429** / TPM/RPM; at most one fast fallback to `GROQ_FALLBACK_MODEL` (`llama-3.1-8b-instant`); else cached short ack. Never empty answer. Never long blocking retries. |
| 1b | Single LLM before first speech | Ordinary: ≤1 main Groq stream before first audio. Booking: **0** (local ack). Defer classifier / language / qualification / summarizer. |
| 2 | Groq TTFT | Compact first-response system (Maya core + customer context ≤420 + language). No full transcripts / every tool schema on hot path. |
| 3 | TTS TTFB | Upstream HTTPS keep-alive agent; warm Rumik WS mint at `speech_end` / while TTFT; stream first playable frame; overlay Sarvam `silence_time_s=0.2`; `full_response_aggregation=false`. Preserve `create_llm_service_with_model_override`. |
| 4 | First safe phrase | Flush TTS on first natural semantic phrase; continue LLM while speaking; measure `phrase_accum` separately. |
| 5 | HI ack architecture | Copy ack-first / defer-tools / fewer pre-speech LLMs to ordinary turns. Do **not** hard-code booking ack into unrelated answers. |

---

## Workstreams (P0.1 retained)

| # | Workstream | Change |
| --- | --- | --- |
| 1 | Turn detection | Client VAD silence **450ms**; MediaRecorder **100ms**; Finalize settle **700ms**. Target `speech_end→stt_final` **<=250ms**. |
| 2 | Deepgram streaming | `/api/stt/stream` forces **nova-3-general** + `language=multi`, `endpointing=100`, `utterance_end_ms=700`. |
| 3 | Groq streaming TTFT | `/api/chat/stream` NDJSON. **Never wait `llm_complete` for TTS.** |
| 4 | Chunked LLM→TTS | `extractFirstSafePhrase` flushes first natural sentence/punct to TTS while LLM continues. |
| 5 | Sarvam first-audio | Overlay: Sarvam `silence_time_s=0.2`; Rumik `full_response_aggregation=false`. Voice stays **priya**. |
| 6 | WF8 node trace | `GET /api/employees/maya/wf8-node-trace` marks REQUIRED_FOR_FIRST_RESPONSE YES/NO/ACK_ONLY. |
| 7 | Fast vs tool path | `voice-fast-path.classifyTurnPath`. Fast = stream phrase. Tool = ack-first. |
| 8 | Booking ack-first | Hindi/Hinglish/TE/EN ack spoken immediately; tools async. Silent wait >4s = FAIL. |
| 9 | Context compaction | First-response injection cap **420** chars. |
| 10 | Prompt token audit | `auditPromptTokens` + cached Maya global prompt. |
| 11 | Parallelize | Booking ack TTS ∥ Groq stream ∥ hangup-trace fire-and-forget. |
| 12 | Cache static | In-process `getCachedStatic('maya_global_prompt')`. |

---

## APIs

`POST/GET /api/talk/latency`, `GET /api/talk/latency?summary=1`, `GET /api/talk/latency/report`, `POST /api/chat/stream`, `POST /api/talk/booking-ack`.

Report also includes `measurement`, `hi_vs_ordinary`, `hostinger_apply_notes`, `GROQ_RATE_LIMIT`, `MULTI_LLM_BEFORE_FIRST_SPEECH`.

---

## Hostinger apply steps (manual · no PSTN from this PR)

1. **Deploy dashboard tip** from this branch. Preserve Hostinger `.env` (`DOGRAH_*`, `DEEPGRAM_*`, `GROQ_*`, `GROQ_FALLBACK_MODEL` optional, `SARVAM_*`, Cal.com).  
2. **Rebuild Rumik/Dograh overlay** from `rumik-overlay-local/` (`bash deploy/02-build-rumik-overlay.sh`). Confirm `full_response_aggregation` default false, Sarvam `silence_time_s=0.2`, and **`create_llm_service_with_model_override` still present**.  
3. **Diff/import** `workflows/maya-receptionist.json` into Dograh **WF8**. Prefer local booking/end-call routers (no classifier LLM before first audio). Do **not** change DID, priya, or WF id.  
4. **Browser Talk** (Maya): coordinator runs **≥30 turns** across EN / TE / MIXED / HI booking **after** merge/deploy (out of scope for this PR).  
5. Capture `GET /api/talk/latency/report` JSON. Use `STAGE_BREAKDOWN` (per-gap percentiles). Never sum TTFT+TTFB medians.  
6. Quality gates (human): ANSWER_COMPLETENESS · NATURAL_PACING · CUSTOMER_NOT_RUSHED · DEMO_PUSH_REDUCED.  
7. **Still no automation PSTN.**

---

## HI booking ack vs ordinary (architecture)

| | HI booking ack | Ordinary EN/TE/MIXED |
| --- | --- | --- |
| First audio | Local ack, **0 LLM** | Stream first safe phrase, **1 LLM** |
| Tools before speech | No | No |
| Why HI looked ~707ms | Ack text is local; TTS starts immediately | Broken when multi-LLM / RL / cold TTS mint stacks |

Copy the **architecture** (ack-first / defer secondary LLMs / tools after speech), not booking phrases, into ordinary turns.

---

## Irreducible floor (if sub-1000 impossible)

If live Hostinger shows `Groq TTFT + Sarvam TTFB` alone >1000ms **on the same turn** (from `stage_trace`, not summed medians) after streaming, name that sum as the irreducible stage before proposing any architecture change. Do **not** switch to native realtime speech-to-speech solely because a transcript suggested it.

---

## FINAL REPORT fields

Fill AFTER_* from Hostinger `GET /api/talk/latency/report` after ≥30 live turns. Synthetic designed numbers are **non-acceptance**.

```
BEFORE tip: 7f03dd0
BEFORE first_audio median (proxy): 14403 ms
P0.1 flawed live FIRST_AUDIO P50/P90/P95: 1764 / 3257 / 3362
P0.1 flawed HI booking ack P50: 707
P0.1 Groq RL empty answers: 6/22

AFTER FIRST_AUDIO P50: <from Hostinger>
AFTER FIRST_AUDIO P90: <from Hostinger>
AFTER FIRST_AUDIO P95: <from Hostinger>
AFTER TOTAL_RESPONSE_DURATION P50: <from Hostinger>

STAGE_BREAKDOWN (percentile each gap independently from stage_trace):
  STT P50: ...
  Groq_TTFT P50: ...
  phrase_accum P50: ...
  TTS_TTFB P50: ...
  TOTAL P50: ...
  NOTE: do not sum gap P50s

GROQ_RATE_LIMIT fail_count: ...
MULTI_LLM_BEFORE_FIRST_SPEECH fail_count: ...

PASS/FAIL MATRIX: (PENDING_HOSTINGER until coordinator retest)
  SARVAM_PRIYA_WF8: PASS (preserved)
  CALCOM_UID_GATE: PASS (preserved)
  TELUGU_ASR_GUARD: PASS (preserved)
  HINDI_BOOKING_NO_HANGUP: PASS (preserved)

READY FOR PSTN QA: NO_PENDING_HOSTINGER_MEASUREMENT
```

---

## Unit / harness

```sh
cd dashboard && node --test \
  test/turn-latency.test.js \
  test/latency-evidence-harness.test.js \
  test/latency-p0-2-groq-rl.test.js \
  test/maya-conversation-policy.test.js \
  test/asr-sanity-guard.test.js
```
