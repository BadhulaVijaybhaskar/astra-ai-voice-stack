# Astra Voice walkthrough spotlight callouts (steps 01–07)

## Target repo
https://github.com/BadhulaVijaybhaskar/astra-connect-hub

Branch prepared locally: `cursor/step1-spotlight-callouts-fc4d`

## What this adds
Self-explanatory highlight callouts on the HOW IT WORKS `VoiceWorkspace` demo:
- Soft electric-blue ring (`#0077ec` / `--astra-blue` / `--voice`)
- One tip bubble at a time, ~2.5s auto-advance, tap-to-skip
- Reduced motion: first tip holds until tap
- Auto demo advances to the next walkthrough step after each tip tour
- Footer: “Auto demo · advances on its own”
- Tip copy is data-driven in `VOICE_WALKTHROUGH_TIPS`

## Apply
```sh
git clone https://github.com/BadhulaVijaybhaskar/astra-connect-hub.git
cd astra-connect-hub
git checkout -b cursor/step1-spotlight-callouts-fc4d
git apply path/to/0001-all-steps-spotlight.patch
# or copy:
#   src/components/astra-spotlight.tsx
#   src/components/astra-workspaces.tsx
# and merge styles-snippets.css into src/styles.css
npm i
npm run dev
# http://localhost:5173/astra-voice → HOW IT WORKS
```

## Tip table
| Step | Target id | Tip |
|---|---|---|
| 01 | maya-profile | This is Maya — your AI employee. Name, team, and Ready all live here. |
| 01 | job-box | One-line brief. If she only remembered one thing, it’s this. |
| 01 | readiness | Her readiness strip. When these light up, she’s cleared for the floor. |
| 01 | continue | Next we’ll teach her how to talk — script, knowledge, rules. |
| 02 | system-prompt | Her job script. What she says and how she qualifies — edit here. |
| 02 | knowledge | Business knowledge. Drop PDFs, FAQs, or a site so she answers from your facts. |
| 02 | rules | Rules that decide who is a lead. Toggle what she must check. |
| 02 | continue | Next: pick how she sounds — voice and language. |
| 03 | voice-profile | How Maya sounds. Warm, natural, and ready for a sample listen. |
| 03 | voice-picker | Pick a demo voice. Each profile is tuned for a different kind of call. |
| 03 | language | Language she can speak. English plus regional options for your callers. |
| 03 | continue | Next: connect a number, hours, and calendar so she can go live. |
| 04 | number-routing | Her business number and routing. Who gets qualified leads after the call. |
| 04 | hours | Working hours. She only dials when your team is ready to follow up. |
| 04 | calendar | Calendar link. Booked demos land on the right owner’s schedule. |
| 04 | continue | Next: hear a sample conversation in her voice and language. |
| 05 | call-header | Live call context. Who she’s talking to, status, and language in use. |
| 05 | waveform | The call in motion. Audio presence while the conversation unfolds. |
| 05 | transcript | The transcript. Maya and the caller, including regional language turns. |
| 05 | continue | Next: see what she understood — structured fields from the talk. |
| 06 | outcome-header | Structured outcome. The call becomes clean customer context. |
| 06 | pipeline | Conversation → understanding → outcome → next action. The path in one glance. |
| 06 | fields | Extracted fields. Interest, team, timing — ready for your CRM shape. |
| 06 | status | Qualification status. Green means she’s marked this lead as ready. |
| 06 | continue | Next: the follow-up she recommends after the call. |
| 07 | next-action | Recommended next step. Owner, timing, and what to do after the call. |
| 07 | metrics | Demo metrics for this journey — calls, qualified rate, meetings booked. |
| 07 | summary | Outcome summary. Regional talk, captured as English context for follow-up. |
| 07 | continue | That’s the full path. Start over anytime to walk it again. |

## Auth needed for direct PR
Grant Cursor GitHub App write on `BadhulaVijaybhaskar/astra-connect-hub`, then push
`cursor/step1-spotlight-callouts-fc4d` from the local connect-hub clone.
