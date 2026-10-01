# LATENCY P0.2 — Voice path (Dograh/Rumik overlay + Sarvam + WF8 + Groq RL)

**Branch owns:** Sarvam bulbul:v3/priya TTFB, WF8 pre-speech Groq prune, generalized
first-audio architecture (HI-ack pattern → ordinary EN/TE), Groq rate-limit
bounded fallback.

**Frozen:** Maya voice **priya** / `bulbul:v3`, DID `+918065353938`, WF8 id `8`,
ASR guard, booking no-hangup, answer depth + demo-push policy. **No PSTN.**

**Live Hostinger measurement still required before claiming P50/P90/P95.** Synthetic
numbers from P0 remain design budgets only.

---

## Map of changes

### 1) Sarvam TTS TTFB (overlay)

Verified in pipecat docs: default `text_aggregation_mode=SENTENCE` buffers until a
sentence boundary before synthesis, which delays first-frame forward.

| Fix | Where |
|---|---|
| `text_aggregation_mode=TOKEN` (fallback `aggregate_sentences=False`) | `rumik-overlay-local/service_factory.py` Sarvam branch |
| `min_buffer_size=20` | Sarvam settings (+ registry field) |
| Keep `silence_time_s=0.2` | Already from P0 (#52) |
| Dashboard TLS keep-alive agent | `dashboard/lib/core.js` (`KEEP_ALIVE_AGENT`) |

Voice stays **priya** / **bulbul:v3**. Path only.

### 2) `create_llm_service_with_model_override`

Added in `rumik-overlay-local/service_factory.py`. Thin override wrapper over
`create_llm_service_from_provider`. `create_llm_service` now delegates to it.
Regression guard: `dashboard/test/latency-p0-2.test.js` (overlay source asserts).

### 3) WF8 pre-speech Groq prune

Astra graph has no separate classifier/lang/qual/summarizer **nodes**. Extra Groq
cost before first speech comes from (a) oversized global prompt and (b) NL edge
routers / deferred hops.

| Change | Effect |
|---|---|
| `GLOBAL_PROMPT_HOT` on global node | Smaller TTFT prompt; qual bank moved to Qualify |
| `meta.pre_speech_policy` | Documents hops to defer |
| Edge `prefer_local_policy: true` | Prefer local booking/hangup policy over router LLM |
| `GET /api/employees/maya/wf8-node-trace` | Lists `deferred_pre_speech_groq_hops` |

Import `workflows/maya-receptionist.json` to Dograh WF8 manually on Hostinger.

### 4) HI booking-ack architecture generalized

Same pipeline for all languages (no latency branch on language strings):

- Tool / booking → `ack_before_llm_then_stream` (`emit_before_llm`)
- Ordinary EN/TE/HI → `stream_first_safe_phrase` with aggressive `phrase_opts`
  (`minChars: 16`, `minWords: 3`), never wait for `llm_complete` / tools

API: `voiceFastPath.planFirstAudio()` used by `/api/chat/stream` and booking-ack.

### 5) Groq rate-limit bounded fallback

Exact upstream shape:

```
HTTP 429
{ "error": { "message": "...", "type": "tokens"|"requests", "code": "rate_limit_exceeded" } }
Headers: retry-after, x-ratelimit-*
```

Bounded behaviour (`dashboard/lib/llm-stream.js`):

- At most **one** short retry when `retry-after <= 2s`
- Otherwise immediate spoken bridge (never empty / silent)
- No long retry storms
- Non-stream `providers.llmGroq.chat` uses the same classifier + fallback

---

## How to verify

```sh
cd dashboard && node --test \
  test/latency-p0-2.test.js \
  test/turn-latency.test.js \
  test/latency-evidence-harness.test.js \
  test/maya-conversation-policy.test.js \
  test/asr-sanity-guard.test.js
```

Hostinger (manual · no PSTN from this PR):

1. Deploy dashboard tip from this branch. Preserve `.env`.
2. Rebuild Rumik/Dograh overlay from `rumik-overlay-local/`
   (`bash deploy/02-build-rumik-overlay.sh`). Confirm Sarvam TOKEN aggregation +
   `silence_time_s=0.2` + `create_llm_service_with_model_override` present.
3. Diff/import `workflows/maya-receptionist.json` into Dograh **WF8** (HOT global,
   Qualify holds deferred qual bank). Do **not** change DID, priya, or WF id.
4. Browser Talk ≥20 turns (EN / TE / MIXED / HI booking). Capture
   `GET /api/talk/latency/report`. Fill AFTER_* only from live data.
5. Quality gates unchanged: ANSWER_COMPLETENESS · NATURAL_PACING ·
   CUSTOMER_NOT_RUSHED · DEMO_PUSH_REDUCED.

---

## Risks

- Dograh's vendored pipecat may lack `TextAggregationMode`; overlay falls back to
  `aggregate_sentences=False`. Confirm after rebuild.
- `min_buffer_size` ignored if Settings rejects the field (TypeError caught).
- HOT global is shorter; if Hostinger import still uses an old full global, re-import.
- Groq RL fallback is a brief bridge, not a full answer. Prefer stream path + healthy quota.
- **Do not claim live P50 until Hostinger Browser Talk evidence is pasted.**

## Collisions

Prefer additive overlay / TTS / WF8 changes if overlapping with the main LATENCY
P0.2 agent on dashboard-only UI paths. This slice touches: `rumik-overlay-local/`,
`workflows/maya-receptionist.json`, `dashboard/lib/{llm-stream,voice-fast-path,wf8-node-trace,maya-conversation-policy,core,providers}.js`,
`dashboard/server.js` chat stream / booking-ack, tests + docs.
