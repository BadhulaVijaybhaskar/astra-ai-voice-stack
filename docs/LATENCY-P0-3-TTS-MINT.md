# LATENCY P0.3 — Browser Talk TTS mint / first-audio path

**Frozen:** Sarvam `bulbul:v3` speaker **priya**. No PSTN. No S2S.

## Root cause (≤5)

1. Browser Talk `/api/ws-connect` defaulted to Rumik model `mulberry` (client `tts.model || 'mulberry'` + process TTS default Rumik).
2. Live Hostinger Rumik WS mint with `mulberry` returns `unsupported_model` (dead path).
3. Rumik cannot synthesize Sarvam **priya**; priya is Sarvam-only.
4. Working measure TTS was Sarvam HTTP `bulbul:v3` / priya, but full REST WAV waits for the complete clip before first audible (TTFB dominated ~1511ms).
5. Warm mint reused Rumik WS tokens only; after remap, Browser Talk needed Sarvam HTTP stream + TLS keep-alive reuse.

## Change

- Mint remaps Rumik/mulberry → Sarvam `http_stream` `bulbul:v3` / `priya` (no dead `ws_url`).
- New `POST /api/tts/stream` proxies Sarvam `/text-to-speech/stream` as linear16 @ 24kHz; client plays first PCM chunk as honest `tts_first_audio`.
- Warm `/api/ws-connect` at speech_end keeps TLS keep-alive path hot; stage_trace notes cold vs warm.

## Calling re-measure

Browser Talk with **real mic** (≥40 audio turns when claiming gates). Typed-only is not acceptance. priya frozen. Overlay rebuild not required for this dashboard mint/stream fix (Dograh Sarvam TOKEN path unchanged).
