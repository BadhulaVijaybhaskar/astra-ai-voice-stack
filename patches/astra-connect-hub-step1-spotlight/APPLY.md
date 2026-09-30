# Step 1 spotlight callouts (Apply in astra-connect-hub)

## Target repo
https://github.com/BadhulaVijaybhaskar/astra-connect-hub

The 7-step Astra Voice walkthrough (`VoiceWorkspace`, Create AI Employee / Teach Maya)
lives there, not in astra-ai-voice-stack. This agent only had write access to
astra-ai-voice-stack, so the implementation is carried here as an applyable patch.

## Local branch already prepared
On the machine that built this: `/tmp/astra-repos/astra-connect-hub` branch
`cursor/step1-spotlight-callouts-fc4d` commit `Add Step 1 spotlight callouts…`.

## Apply
```sh
git clone https://github.com/BadhulaVijaybhaskar/astra-connect-hub.git
cd astra-connect-hub
git checkout -b cursor/step1-spotlight-callouts-fc4d
git apply path/to/0001-step1-spotlight.patch
# or copy mirrored files:
#   src/components/astra-spotlight.tsx (new)
#   src/components/astra-workspaces.tsx (replace)
#   and the --astra-blue + spotlight CSS bits from the patch for src/styles.css
npm i
npm run dev
# open http://localhost:5173/astra-voice → HOW IT WORKS → Step 01
```

## Behavior
- Right-panel-only tips on Step 01: Maya profile → Job → Readiness → Continue
- ~2.5s auto-advance; click/tap advances; prefers-reduced-motion holds tip 1 until tap
- Soft electric-blue ring `#0077ec` / `--astra-blue`
- Shared helpers in `astra-spotlight.tsx` for later steps

## Files touched in connect-hub
- `src/components/astra-spotlight.tsx` (new)
- `src/components/astra-workspaces.tsx`
- `src/styles.css` (`--astra-blue` + spotlight root)
- `src/components/astra-site.tsx` (UTF-8 copyright glyph fix so Vite can load the module)
