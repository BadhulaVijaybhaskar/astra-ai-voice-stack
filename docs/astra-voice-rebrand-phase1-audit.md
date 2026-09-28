# Astra Voice Rebrand — Phase 1 Audit

**Status:** Coordinator-ready. Docs only. No product UI/CSS/JS mutations in this phase.  
**Repo:** `BadhulaVijaybhaskar/astra-ai-voice-stack` (working tree: `dashboard/` console + APIs)  
**Date:** 2026-09-28  
**Scope:** Inventory current **Astra AI** calling console against brand locks for **Astra Voice** (AstraConnect product family). Preserve backends, APIs, auth, providers, CallJob, and workflows.

**Brand locks (source of truth for later phases)**

| Lock | Requirement |
| --- | --- |
| Wordmark | **Astra Voice** with approved AC symbol. Not “Astra AI”, not “AstraConnect Voice”. |
| Approved lockup | User PNG: electric-blue **A** + teal **C** interlocking AC mark + wordmark “Astra voice” (lockup uses lowercase *v*; product chrome should prefer title case **Astra Voice** unless design systems locks the lockup casing). |
| Colour | Electric blue primary. Neutrals: white / off-white / graphite / cool gray. Green only for success. |
| Product feel | Operational calm/dense console. Not marketing/cinematic. Follow AstraConnect product-app principles (hierarchy, claim safety, no provider brand exposure). |
| Non-goals | Do not change CallJob dial path, provider adapters, auth, or invent metrics. |

**Reference assets reviewed (session uploads / local light tree)**

| Asset | Verdict |
| --- | --- |
| User lockup PNG (`astra-voice-lockup-user`) | **Approved Astra Voice lockup** — AC mark (blue A + teal C) + “Astra voice”. Target for product chrome. |
| Uploaded `logo.svg` | Byte-identical to `dashboard/public/assets/logo.svg`. **Old Astra AI text wordmark** (`astra` + purple→cyan `AI`). Not the AC symbol. |
| Uploaded `logo-mark.png` | Byte-identical to `dashboard/public/assets/logo-mark.png`. **Old Astra AI ribbon-A mark** (purple→cyan 3D A + swoosh + sparkle). Not the approved AC symbol. |
| Repo `logo.png` / `logo-lockup.png` | Full **Astra AI** lockups (ribbon A + “astra AI” + tagline “exceed expectations”). Deprecated for customer chrome. |
| Repo `favicon.svg` / `og.svg` | Astra AI titles + purple→cyan volt gradient. |

---

## 1. Logo inventory

### Live product assets (`dashboard/public/assets/`)

| File | Role today | Brand family | Phase-2+ action |
| --- | --- | --- | --- |
| `logo-mark.png` (620×620) | Sidebar / auth mark via `brandMark()` | Old Astra AI ribbon A | Replace with AC mark crop / SVG |
| `logo.png` (1200×400) | Full lockup (marketing / ops docs) | Old Astra AI | Replace or retire |
| `logo-lockup.png` (600×200) | Compact lockup | Old Astra AI | Replace or retire |
| `logo.svg` | Text-only “astra AI” wordmark | Old Astra AI | New “Astra Voice” SVG or drop in favour of lockup PNG |
| `favicon.svg` / `favicon.png` | Tab icon (simplified A + volt stroke) | Old Astra AI | AC mark favicon |
| `og.svg` | Social card “Astra AI… Rs 1” | Old Astra AI + purple→cyan | New OG for Astra Voice |

### Approved vs old (critical distinction)

```
APPROVED (target)          CURRENT REPO (shipped)
─────────────────          ──────────────────────
AC symbol                  Ribbon “A” + sparkle
  blue A + teal C            purple → cyan gradient
“Astra voice” wordmark     “astra AI” + “exceed expectations”
Electric blue / teal       Violet #6B21A8 + cyan #06B6D4
Graphite text on black     Charcoal + gradient “AI”
```

The files attached from the local Astra light tree (`logo.svg`, `logo-mark.png`) are **the old mark**, already in this repo (MD5 match). Do not treat them as AstraConnect AC assets.

### Where logos render

- Console SPA shell: `dashboard/public/assets/app.js` → `brandMark()` + wordmark `astra` + `<em>AI</em>` (sidebar, auth gate).
- Marketing: `dashboard/public/index.html` nav/footer brands.
- Legacy: `console.html`, `demo.html` footer, HVAC desk eyebrows.
- Docs/README badges reference `logo-lockup.png`.

---

## 2. Brand strings

### Customer-facing hotspots (must change in UI phases)

| Surface | Examples |
| --- | --- |
| Document titles / meta | `app.html`: “Astra AI , Console”; `index.html` title/og; `console.html`: “Astra AI Agent Console” |
| Shell chrome | Sidebar `astra` + `AI`; topbar crumb `Astra AI`; auth “New to Astra AI.” |
| Defaults / placeholders | Greeting “calling Astra AI”; Studio sample “Welcome to Astra AI…”; HIPAA copy “retention in Astra AI” |
| Demo / HVAC | `demo.html` “Powered by Astra AI”; `hvac.js` “Astra AI · Operations” |
| SVG aria | `logo.svg` / `favicon.svg` / `og.svg` titles |

Rough counts (repo-wide, excl. `.git`): **~95** `Astra AI`, **~17** `Astra Voice` (mostly TTS/economics naming on marketing), **0** `AstraConnect`, **~71** legacy `rapidx` / RapidX (cookie `rxv_sess`, env `RAPIDX_*`, deploy paths, docs credentials).

### Naming collisions to resolve

| Current usage | Intent | Rebrand rule |
| --- | --- | --- |
| “Astra Voice” on marketing as **TTS/economics chip** | Rumik-class voice layer | Product name is now **Astra Voice**; TTS layer copy must not compete (prefer “Voice runtime” / layer labels already used in console). |
| “Astra AI Voice” compare label | Marketing | Rename to Astra Voice. |
| Seed tenant `Astra AI Test` / user `Astra AI Demo` | Boot seed | Rename strings; keep IDs/behaviour. |
| PayU `productinfo` “Astra AI … Credits” | Billing descriptor | Rename for statement clarity. |
| Package `"name": "astra-ai"` | npm identity | Optional rename later; not customer-visible. |
| `demo@rapidx.ai` in CLAUDE/SPEC | Legacy docs | Align docs with live `TEST_USER_*` / astra.local patterns. |

### Safe to leave (ops / internal)

- `lib/*.js` file headers, Super Admin diagnostics provider inventory, workflow JSON prompts, server adapter code paths.
- Company references: Astranova / AstraNova Digital Services (service company ≠ product brand). Prefer **AstraConnect** parent only where product architecture copy needs it; customer chrome stays **Astra Voice**.

---

## 3. Colour tokens

**Source of truth today:** `dashboard/public/assets/brand.css` (also loaded by marketing + console).

| Token / hex | Role today | vs Astra Voice lock |
| --- | --- | --- |
| `--accent` `#6B21A8`, `--a-violet` `#642C8F`, `#7C3AED` | Primary purple | **Misaligned** — purple is Astra AI era; Voice primary should be electric blue |
| `--accent-2` / `--a-cyan` `#06B6D4` | Cyan end of volt gradient | Close to teal accent in AC mark, but currently secondary to purple |
| `--grad-volt` purple→cyan | Primary CTAs, wordmark em, sparks, waveforms | **Replace** with electric-blue primary system; no purple wash |
| `--ok` `#059669` | Success | Keep green for success only |
| `--bg` white, `--bg-2` `#F4F4F5`, `--ink` `#111827`, `--ink-dim` `#6B7280` | Neutrals | Largely compatible with white/off-white/graphite/cool gray |
| Hardcoded hex in `app.js` sparkline/waveform, `marketing.js` `VOLT`, `og.svg`, tenant `branding.color` default | Scattered | Sweep with token change |

**DESIGN.md drift:** still describes a “unified dark shell” while `brand.css` / `app.css` are a **light white canvas** with purple→cyan accents. Rebrand should document the light operational console and drop purple cinematic language.

**Green rule:** `--ok` already reserved for success. Avoid teal-as-success confusion with AC mark teal; mark teal is brand chrome only, not status.

---

## 4. Nav vs target IA

### Shipped nav (`ROUTES` in `app.js`)

| Group | Items | Audience |
| --- | --- | --- |
| HOME | Home | All |
| JOURNEY | My Employees, Conversations, Training, Phone Numbers, Performance | All |
| LEADS | Instant Leads, Campaigns | All |
| ACCOUNT | Billing, Support, Account, Admin→**Diagnostics** (super_admin label) | Role-gated |
| ADVANCED → UI label **DIAGNOSTICS** | Agents, Workflows, Presets, Voice Studio, Demo links, Talk to it, Knowledge, Integrations | **Super Admin only** |

### vs `docs/NAV-IA.md`

North-star items match. Order differs slightly (IA doc lists Instant Leads/Campaigns earlier; code keeps LEADS as its own group). Provider-era demotion to Diagnostics matches Phase 16/21. **No IA rebuild required for rebrand** — rename chrome and polish labels only.

### Target customer IA (preserve)

1. Home  
2. My Employees (+ Employee Studio)  
3. Instant Leads / Campaigns  
4. Conversations  
5. Training  
6. Phone Numbers  
7. Performance  
8. Account / Billing / Support  

Diagnostics remain Super Admin only.

---

## 5. Shell / topbar / provider pills

| Element | Current | Gap |
| --- | --- | --- |
| Sidebar brand | Old `logo-mark.png` + `astra`/`AI` | Swap AC + Astra Voice |
| Topbar crumb | Hardcoded `Astra AI` | → `Astra Voice` |
| Health chips | TTS / Brain / Telephony from `GET /api/health` | Layer names OK; **non–super_admin public health omits `providers`**, so chips may stay empty/bad for customers |
| Home “Demo path” runtime | Voice / Brain / Listening / Telephony via `/api/providers` layers | Customer-safe; keep |
| Account providers panel | Explicitly hides brand inventory for customers | Keep |

**Rebrand note:** Prefer product-layer labels (Voice / Brain / Listening / Telephony) over TTS acronym and never surface Dograh / Rumik / VoBiz / Deepgram / Groq on customer chrome.

---

## 6. Home KPIs — replace “characters synthesized” / “estimated spend”

### Current Home (`viewOverview`)

| KPI | API | Truthfulness |
| --- | --- | --- |
| Employees | `/api/employees` | Real |
| **Characters synthesized** | `/api/usage` → `totals.chars` | Real but **narrow**: bumped only on Studio `POST /api/tts`, not phone-runtime TTS |
| **Estimated spend** | `totals.costInr` | **Derived promo math**, not wallet/ledger |
| Sparkline | chars/day | Same TTS-only scope |
| Runtime ready | `/api/providers` layers | Real product readiness |

Server formula (`server.js`): `INR_PER_1K_CHARS = 0.12`, `INR_PER_CALL = 0.9`. Client fallback `RATE.mulberry = 0.50` **diverges** if `costInr` missing. Soft wallet debits in `plans.js` are separate and fail-open.

### Recommended Home KPI set (truthful)

Prefer Performance/Calls facts already available:

| Candidate | Source | Notes |
| --- | --- | --- |
| Employees | existing | Keep |
| Conversations / Calls | `/api/performance` or calls count | Real |
| Connected / completed (or conversion) | performance aggregates | Show `—` when null; never invent |
| Minutes used | entitlements usage (`plans`) | Real duration floor-sum; already on Billing |
| Wallet balance | Billing wallet | Real; optional Home teaser |

**Do not** keep characters synthesized / estimated spend as primary customer proof unless reframed as “Studio preview usage” with explicit scope. No fake connect rates.

---

## 7. Employees / Studio

| Surface | Label | Audience |
| --- | --- | --- |
| Nav | **My Employees** | Customers |
| Detail | **Employee Studio** (tabs: Overview, Instructions, Workflow, Training, Assign Number, Leads, Timeline, Actions, Outcomes, Voice, Settings) | Customers |
| Diagnostics | **Voice Studio**, Agents, Workflows, Presets, Talk to it | Super Admin |

Compose copy still says Astra builds an **agent and workflow** under the hood — correct architecture; keep internals, soften customer-facing “Agent” labels where IA already says Employee. Default greetings/Studio sample text still say Astra AI.

Empty: “No employees yet” / create from job template — fine; rebrand tone only.

---

## 8. Leads / Campaigns / Conversations / Performance / Numbers / Billing

| Area | Capability (keep) | Brand-sensitive notes |
| --- | --- | --- |
| Instant Leads | Lead → CallJob → confirm dial → Conversation | Clean of providers. Fallback agent picker if no employees. |
| Campaigns | CSV/XLSX → map → validate → same CallJob path | Clean. Demo seed company “Astra Demo”. |
| Conversations | Calls alias; sync; recording | Sync toast “upstream runs” mildly infra-flavoured. |
| Performance | Honest aggregates; empty → `—` / 0 | “Connected” = lead↔employee assignment, **not** telephony connect rate. Clarify label in later UX polish. |
| Phone Numbers | Assign to Employee; inbound; dial | Seed “AstraNova Main Line”; BYON option label `twilio`. Copy already: provider portals invisible. |
| Billing | Wallet, packs, entitlements, PayU | `productinfo` “Astra AI … Credits”; “PayU mode” visible; provider invoices correctly suppressed. |

Empty states across these surfaces are honest (no invented charts). Copy polish only in rebrand passes.

---

## 9. Empty states (inventory)

| Surface | Representative copy |
| --- | --- |
| Home spark | No usage yet |
| Employees | No employees yet |
| Instant Leads | No call jobs yet / No leads yet |
| Campaigns | No campaigns yet |
| Conversations | No conversations yet |
| Training hub | No employees yet. Create one, then add training. |
| Employee Training tab | No knowledge linked yet |
| Phone Numbers | No Phone Numbers assigned yet |
| Performance | `—` / 0 (no fake series) |
| Billing | No usage rows yet / No wallet activity yet |
| Diagnostics Agents/Workflows | No agents/workflows yet |

Principle to preserve: empty stays empty. Rebrand does not invent placeholder KPIs.

---

## 10. Provider jargon

| Audience | Finding |
| --- | --- |
| Customer journey nav | Clean of Dograh / Rumik / VoBiz / Deepgram / Groq |
| Customer Account | Provider brand inventory gated to Super Admin |
| Marketing `index.html` | Intentional competitor names (ElevenLabs, Gemini, Twilio) + “Astra Voice” as voice economics |
| Voice Studio (Diagnostics) | ElevenLabs comparison, mulberry/muga model tags |
| BYON | `twilio` option label |
| Package.json / README / CLAUDE | Full stack named (ops OK) |

**Claim safety:** keep Diagnostics honest; never promote internal providers on customer chrome. Rebrand should not re-open provider pills in the topbar for tenants.

---

## 11. API readiness for truthful metrics

| Need | Ready? | Endpoint / module |
| --- | --- | --- |
| Employee count | Yes | `/api/employees` |
| Call / conversation counts | Yes | `/api/performance`, `/api/conversations` |
| Conversion rate (heuristic) | Yes, nullable | `analytics.buildDashboard` → `conversionRatePct` |
| Avg duration / minutes | Partial | Computed in analytics; minutes entitlement in `plans` |
| Outcome breakdowns | Yes | Performance tables |
| Campaign analytics | Yes | `/api/campaigns/:id/analytics` |
| Wallet / credits | Yes | Billing APIs; not on Home today |
| Studio chars | Yes but scoped | `/api/usage` chars = TTS preview path only |
| Estimated spend as billed truth | **No** | Promo formula only |
| Telephony connect rate | **No named metric** | Do not invent; use CallJob/call statuses if product defines one later |
| Phone-runtime TTS chars | **No** | Not in usage bump path |

Home KPI replacement can be done with **existing** Performance + Employees (+ optional wallet) without backend invention. Optional later: unify usage cost rates; separate Studio preview usage from live call economics.

---

## 12. Training — global vs in-employee

**Both exist and should remain.**

1. **Global nav → Training** (`viewTrainingHub`): lists employees + training asset counts; CTA deep-links `#/employees?id=…&tab=training`.
2. **Employee Studio → Training tab**: attach/remove knowledge, FAQ/notes via `/api/employees/:id/training` + `/api/knowledge`.

Advanced **Knowledge** CRUD stays Super Admin Diagnostics. Rebrand: keep dual entry; align empty-state and hub copy to Astra Voice tone only.

---

## 13. Frontend stack

| Question | Answer |
| --- | --- |
| Stack | **Vanilla HTML / CSS / JS** SPA (`app.html` + `assets/app.js`, hash routing) |
| React / shadcn / Framer Motion | **None** |
| Build / bundler | **None** |
| Runtime deps | `ws` only (`dashboard/package.json`) |
| CSS system | Hand-authored `brand.css` + `app.css` + `marketing.css` |
| Secondary pages | `index.html`, `console.html`, `demo.html`, `hvac.html` — also vanilla |

Implication: rebrand is a **token + asset + string sweep** in static files, not a design-system migration. Soft motion already via CSS; keep calm/dense, no cinematic marketing motion inside the console.

---

## 14. Suggested effort — Phases 2–14 (rebrand track)

These are **rebrand delivery phases**, not the historical product Phases 1–22 already shipped. Effort is relative (S/M/L) and component-scoped. No calendar estimates.

| Phase | Focus | Components | Size | Risk |
| --- | --- | --- | --- | --- |
| **2** | Asset pack | AC mark SVG/PNG, lockup light/dark, favicon, OG; replace `logo*` without touching JS logic | S | Wrong mark if light-tree assets reused |
| **3** | Design tokens | Retheme `brand.css`: electric blue primary, drop purple volt; keep neutrals + green=success | M | Hardcoded hex leftovers |
| **4** | Shell chrome | Sidebar/auth/topbar crumb → Astra Voice + AC mark | S | Miss legacy `console.html` |
| **5** | Home KPIs | Replace chars/spend with truthful Performance/Employees/minutes/wallet teaser | M | Must not invent rates |
| **6** | String sweep — console | Titles, crumbs, placeholders, HIPAA, Studio defaults, empty-state tone | M | Dual `public/app.js` vs `assets/app.js` |
| **7** | Employees / Studio | Soften Agent wording in customer tabs; keep Workflow API; Diagnostics Voice Studio label OK | S–M | Tests asserting greetings |
| **8** | Leads / Campaigns / Conversations | Copy polish; clarify “connected”; seed “Astra Demo” rename | S | — |
| **9** | Performance / Numbers / Billing | Labels; PayU productinfo; AstraNova Main Line seed; twilio BYON label | S–M | Test fixtures |
| **10** | Marketing landing | `index.html` / marketing CSS-JS / OG: Astra Voice product, electric blue, claim-safe | M | Competitor compare narrative |
| **11** | Demo / HVAC / legacy console | `demo.html`, `hvac.*`, `console.html` alignment or deprecation note | S | Forgotten surfaces |
| **12** | Provider jargon pass | Audit customer JSON/UI again; keep Diagnostics leaks intentional | S | Health chip vs publicHealth mismatch |
| **13** | Docs / package / seeds | README, DESIGN, CLAUDE, PayU names, demo tenant strings; optional package rename | S | Doc credential drift |
| **14** | QA / acceptance | Visual + string checklist; no API regressions; empty states; reduced-motion | M | Purple hex regressions |

**Out of scope for 2–14:** CallJob path, provider adapters, auth sessions, Dograh/VoBiz wiring, inventing analytics, React rewrite.

---

## 15. Risks

1. **Wrong logo adoption** — uploaded light-tree `logo.svg` / `logo-mark.png` are old Astra AI; only the user AC lockup is approved.  
2. **Purple token debt** — `--grad-volt` and hardcoded `#6B21A8`/`#7C3AED` appear across CSS, SVG, canvas sparks, marketing, OG, tenant branding default.  
3. **“Astra Voice” dual meaning** — today marketing uses it as TTS brand; product rename requires layer-copy cleanup to avoid “Voice Voice”.  
4. **Home economics honesty** — shipping “estimated spend” as brand proof violates claim safety; chars are Studio-scoped.  
5. **Health chips vs sanitized health** — customers may see broken TTS/Brain/Telephony pills; fix carefully without exposing provider brands.  
6. **Test fixtures** — workflows/phone-numbers/employees tests assert AstraNova / greeting strings.  
7. **Legacy dual frontends** — `public/app.js` + `console.html` can miss a string sweep focused only on `assets/app.js`.  
8. **rapidx ops identity** — cookie/env/deploy names are non-UI but brand-leaky in docs and support runbooks.  
9. **Cinematic drift** — marketing motion/glow must not bleed into the operational console (skill: calm/dense product apps).  
10. **Lockup casing** — approved art shows “Astra voice”; product UI copy likely “Astra Voice”. Decide once in Phase 2 asset brief.

---

## 16. Coordinator checklist (Phase 1 exit)

- [x] Logo inventory with approved AC vs old ribbon A  
- [x] Brand string map (customer vs ops)  
- [x] Colour token gap vs electric blue / neutrals / green=success  
- [x] Nav vs NAV-IA (no structural rebuild required)  
- [x] Shell/topbar provider pill behaviour  
- [x] Home KPI replacement guidance (API-ready, truthful)  
- [x] Employees/Studio, Leads→Billing surface notes  
- [x] Empty states + provider jargon + Training dual entry  
- [x] Frontend stack confirmed vanilla  
- [x] Phases 2–14 effort framing + risks  
- [x] Zero product UI mutations in this PR  

**Phase 1 success:** this document is sufficient to assign Phases 2–14 without further discovery of brand assets or Home metric honesty.
