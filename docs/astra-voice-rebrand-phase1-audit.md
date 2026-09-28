# Astra Voice Rebrand — Phase 1 Audit

**Status:** Coordinator-ready (brand kit + Design favicon / pending Voice AC mark notes). Docs only. No product UI/CSS/JS mutations in this phase.  
**Repo:** `BadhulaVijaybhaskar/astra-ai-voice-stack` (working tree: `dashboard/` console + APIs)  
**Date:** 2026-09-28  
**Scope:** Inventory current **Astra AI** calling console against brand locks for **Astra Voice** (AstraConnect product family). Preserve backends, APIs, auth, providers, CallJob, and workflows.

**Brand locks (source of truth for later phases)**

| Lock | Requirement |
| --- | --- |
| Wordmark | **Astra Voice** with approved AC symbol. Not “Astra AI”, not “AstraConnect Voice”. |
| App lockup | Canonical kit **`astravoice.png`** — preferred Voice wordmark for sidebar / auth / product chrome. Prefer over any purple `astra AI` SVG/PNG in the calling repo. |
| Discrete AC mark | Hub **`favicon.png`** (blue A + green C on black). No standalone approved AC monogram SVG in the marketing repo yet. |
| Voice-only AC mark | **Pending from Design** (electric blue). Until then, favicon may seed sidebar icon work but Voice chrome must not give green equal weight. |
| Colour | Electric blue primary (`--voice`). Neutrals: white / off-white / graphite / cool gray. Green only for **success** (not Chat theme; not equal-weight AC green in Voice chrome). |
| Product feel | Operational calm/dense console. Not marketing/cinematic. Do **not** import website hero/orb/Guide patterns into the Voice app. |
| Non-goals | Do not change CallJob dial path, provider adapters, auth, or invent metrics. |

### Approved AstraConnect brand kit (canonical — supersedes earlier session lockup notes)

Kit received as uploads (website / AstraConnect brand system). These are the **source of truth** for Phase 2+ asset work:

| File | Use in Voice calling console | Do not use for |
| --- | --- | --- |
| **`astravoice.png`** | **Prefer this** — Voice app wordmark / sidebar / auth lockup ([AC] + Astra voice) | — |
| **Hub `favicon.png`** (`astraconnect-favicon-ac.png`) | **Discrete AC mark** today — blue A + green C on black (64×64). Interim base for favicon / compact mark only | Do not treat green as co-primary in Voice chrome; not a Voice-only mark |
| **`astraconnect-logo.png`** | Larger parent AC raster (same family as hub favicon). Optional high-res source | Do not substitute as the Voice app title; no approved standalone AC **SVG** yet |
| **`astraconnect-full-logo.png`** | Full **AstraConnect** parent lockup | Marketing / parent only — **not** the Voice app title |
| **`astrachat.png`** | Reference only (Chat product lockup) | **Do not** theme the Voice app green / Chat accent |
| **`astraconnect-styles.css`** | Token extraction for Phase 2 (`--voice*`, neutrals, success) | Do not lift website cinematic utilities (`hero-orb`, `hero-canvas`, Guide orb, `shadow-guide`) into the console |
| **Voice-only AC mark (electric blue)** | **Pending from Design** — block / swap when delivered | Do not invent a monochrome/blue-only SVG ahead of Design |

**Design agent note (2026-09-28):** There is **no** standalone approved AC monogram SVG in the marketing repo yet. The discrete AC mark for geometry/reference is the hub **`favicon.png`**. Voice console should lead with **`astravoice.png`**; if the favicon is used as a sidebar-icon base, **do not give green equal visual weight** in Voice chrome. Await the Voice-only AC mark (electric blue) from Design.

Earlier light-tree uploads (`logo.svg`, `logo-mark.png`) and in-repo `dashboard/public/assets/logo*` remain **deprecated Astra AI** assets (ribbon A / purple→cyan wordmark). Prefer **`astravoice.png`** over those for every customer-facing Voice surface.

**Also reviewed (historical / deprecated)**

| Asset | Verdict |
| --- | --- |
| Prior user lockup PNG | Same family as `astravoice.png` (AC + Astra voice). Kit file is now the named canonical. |
| Uploaded / repo `logo.svg` | Byte-identical. Old **astra AI** text wordmark. Do not ship. |
| Uploaded / repo `logo-mark.png` | Byte-identical. Old ribbon-A mark. Do not ship. |
| Repo `logo.png` / `logo-lockup.png` | Old Astra AI lockups + “exceed expectations”. Retire. |
| Repo `favicon.svg` / `og.svg` | Astra AI + purple volt gradient. Rebuild from hub AC favicon geometry, then swap to **pending Voice AC mark** when Design delivers. |

---

## 1. Logo inventory

### Canonical kit → product mapping (Phase 2)

| Canonical kit file | Suggested console destination | Notes |
| --- | --- | --- |
| `astravoice.png` | **Primary** sidebar / auth wordmark (replace `brandMark()` + `astra`/`AI` text, or single `<img>` lockup) | Prefer this asset. Lockup art uses “Astra voice” (lowercase *v*); chrome aria/title strings still use **Astra Voice**. |
| Hub `favicon.png` (AC on black) | Interim browser favicon / optional compact sidebar icon **base** | Discrete approved AC mark today. Blue A + green C — **do not give green equal weight** in Voice chrome. **Pending Voice AC mark from Design** (electric blue) should replace this for Voice-native mark usage. |
| `astraconnect-logo.png` | Optional high-res raster of parent AC | Same dual-colour family; no standalone approved AC **SVG** in marketing repo yet. |
| `astraconnect-full-logo.png` | Optional marketing/footer parent credit only | Never as console product title. |
| `astrachat.png` | None in Voice app | Reference so implementers do not confuse Chat green with Voice blue. |
| Voice-only AC mark (electric blue) | Favicon + any mark-only chrome once delivered | **Pending from Design** — track as Phase 2/3 dependency. |

### Live product assets (`dashboard/public/assets/`) — current, to replace

| File | Role today | Brand family | Phase-2+ action |
| --- | --- | --- | --- |
| `logo-mark.png` (620×620) | Sidebar / auth mark via `brandMark()` | Old Astra AI ribbon A | Prefer full `astravoice.png` lockup; interim mark may derive from hub favicon until **pending Voice AC mark** arrives |
| `logo.png` / `logo-lockup.png` | Full lockups | Old Astra AI | Retire; Voice surfaces use `astravoice.png` |
| `logo.svg` | Text-only “astra AI” wordmark | Old Astra AI | **Do not prefer** over `astravoice.png`; delete or stop referencing |
| `favicon.svg` / `favicon.png` | Tab icon | Old Astra AI | Replace with hub AC favicon interim → then **pending Voice AC mark** |
| `og.svg` | Social card | Old Astra AI + purple→cyan | New OG using `astravoice.png` / Voice AC mark + `--voice` |

### Approved vs old (critical distinction)

```
APPROVED (canonical kit)                    CURRENT REPO (shipped)
─────────────────────────                    ──────────────────────
astravoice.png (preferred Voice wordmark)   logo-mark / logo.svg ribbon + “astra AI”
Hub favicon.png (discrete AC; dual colour)  purple → cyan 3D A + sparkle
Voice-only AC mark                          (missing — pending Design)
Electric blue UI primary (--voice)          Violet #6B21A8 + cyan #06B6D4 gradient
```

Light-tree `logo.svg` / `logo-mark.png` are **old marks** (MD5-identical to repo). They are **not** AstraConnect AC assets. There is **no** approved standalone AC monogram SVG yet.

### Where logos render today

- Console SPA shell: `dashboard/public/assets/app.js` → `brandMark()` + wordmark `astra` + `<em>AI</em>` (sidebar, auth gate).
- Marketing: `dashboard/public/index.html` nav/footer brands.
- Legacy: `console.html`, `demo.html` footer, HVAC desk eyebrows.
- Docs/README badges reference `logo-lockup.png`.

**Phase 2 rule:** wire **`astravoice.png`** into sidebar/auth first (dense ~28–36px height). Use hub favicon only as interim mark/favicon seed; suppress equal green weight in Voice chrome; swap mark to **pending Voice AC mark from Design** when available.
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

### Current console (`dashboard/public/assets/brand.css`)

| Token / hex | Role today | vs Astra Voice lock |
| --- | --- | --- |
| `--accent` `#6B21A8`, `--a-violet` `#642C8F`, `#7C3AED` | Primary purple | **Misaligned** — replace with `--voice` electric blue |
| `--accent-2` / `--a-cyan` `#06B6D4` | Cyan end of volt gradient | AC mark teal is brand chrome only; not Chat green |
| `--grad-volt` purple→cyan | Primary CTAs, wordmark em, sparks, waveforms | **Remove**; primary fills use solid `--voice` (optional soft wash via `--voice-soft`) |
| `--ok` `#059669` | Success | Map to kit `--success`; green for success only |
| `--bg` white, `--bg-2` `#F4F4F5`, `--ink` `#111827`, `--ink-dim` `#6B7280` | Neutrals | Align to kit background / foreground / muted / surface / border |
| Hardcoded hex in `app.js` sparkline/waveform, `marketing.js` `VOLT`, `og.svg`, tenant `branding.color` default | Scattered | Sweep onto `--voice` |

**DESIGN.md drift:** still describes a “unified dark shell” while `brand.css` / `app.css` are a **light white canvas** with purple→cyan accents. Rebrand should document the light operational console.

### Canonical kit tokens (`astraconnect-styles.css` — website `:root`)

Extract **product-app** tokens only. Values are OKLCH in the kit; approximate sRGB hex below for the vanilla console (verify in browser before locking hex):

| Kit token | Kit value | ≈ sRGB | Voice console use |
| --- | --- | --- | --- |
| `--voice` | `oklch(0.58 0.2 255)` | `#0077ec` | **Primary accent** (CTAs, active nav, focus ring, links) |
| `--voice-foreground` | `oklch(1 0 0)` | `#ffffff` | Text/icon on primary buttons |
| `--voice-soft` | `oklch(0.965 0.025 250)` | `#e7f5ff` | Soft selected/hover wash, chip fill |
| `--background` | `oklch(0.995 0.002 245)` | `#fcfeff` | App canvas (`--bg`) |
| `--foreground` | `oklch(0.18 0.04 255)` | `#051223` | Primary ink (`--ink`) |
| `--muted-foreground` | `oklch(0.49 0.03 255)` | `#556272` | Secondary text (`--ink-dim` / `--muted`) |
| `--surface` | `oklch(0.975 0.008 250)` | `#f3f7fc` | Raised / sidebar wash (`--bg-2` / `--raised`) |
| `--border` | `oklch(0.91 0.015 250)` | `#dae2eb` | Hairlines (`--line`) |
| `--card` | `oklch(1 0 0)` | `#ffffff` | Panels (`--panel`) |
| `--success` | `oklch(0.64 0.16 151)` | `#24a656` | Success only (`--ok`) |
| `--warning` | `oklch(0.75 0.15 78)` | `#e1a01d` | Warnings (`--warn`) |

### Phase 2 token plan (recommended mapping into `brand.css`)

1. Add `--voice`, `--voice-foreground`, `--voice-soft` as first-class tokens.  
2. Point legacy aliases at Voice: `--accent: var(--voice)`; `--accent-ink: var(--voice-foreground)`; retire `--grad-volt` / purple hex.  
3. Remap neutrals: `--bg` ← background, `--ink` ← foreground, `--ink-dim` ← muted-foreground, `--bg-2`/`--raised` ← surface, `--line` ← border, `--panel` ← card.  
4. Remap `--ok` ← `--success`; keep destructive as-is unless kit mandates change.  
5. Default tenant `branding.color` → `--voice` approx hex (not `#6B21A8`).  
6. Sparklines / waveforms / selection / primary buttons → solid `--voice` (and `--voice-soft` fills), not purple→cyan gradients.

### Explicitly do **not** import from the website stylesheet

| Kit / website item | Why exclude from Voice console |
| --- | --- |
| `--chat`, `--chat-dark`, `--chat-soft` | Astra Chat product colours — **do not theme Voice green** |
| `--guide`, `--guide-foreground`, `--guide-muted`, `--guide-border` | Astra Guide graphite orb system |
| `@utility hero-orb`, `hero-canvas`, `hero-ecosystem`, `hero-signal`, `hero-chip` | Marketing / cinematic landing patterns |
| `@utility shadow-guide`, large `shadow-panel` | Glow / depth looks wrong on a dense ops console |
| Tailwind `@theme` / `tw-animate-css` stack | Console stays vanilla CSS; copy **values**, not the website build pipeline |
| Manrope-as-marketing display scale (`page-title`, `section-title`) | Optional later; do not force marketing type ramp into the SPA |

**Green rule:** success green ≠ Chat green ≠ AC-mark teal. Mark teal lives inside logo PNGs only; UI status green uses `--success`. Chat tokens stay out of Voice `brand.css`.

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
| Sidebar brand | Old `logo-mark.png` + `astra`/`AI` | Prefer **`astravoice.png`** wordmark; interim mark may use hub favicon base without equal-weight green; swap to **pending Voice AC mark** |
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
| **2** | Asset pack | Stage `astravoice.png` → sidebar/auth wordmark; hub `favicon.png` → interim favicon/mark base; retire purple `logo.svg` / ribbon marks; new OG; **swap mark when pending Voice AC mark arrives** | S | Equal-weight green from hub favicon; inventing blue SVG ahead of Design; using Chat/parent full lockup |
| **3** | Design tokens | Map kit `--voice` / `--voice-soft` / `--voice-foreground` + neutrals/success into `brand.css`; drop `--grad-volt`; **no** Chat/Guide/hero-orb import | M | Hardcoded hex leftovers; accidental Chat green / AC green as UI primary |
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

1. **Wrong logo adoption** — light-tree / repo `logo.svg` + ribbon `logo-mark.png` are old Astra AI. Prefer **`astravoice.png`** for Voice chrome. Discrete AC mark today = hub **`favicon.png`** (not an approved standalone SVG). Never use `astrachat.png` or `astraconnect-full-logo.png` as the console title.  
2. **Pending Voice AC mark from Design** — electric-blue Voice-only monogram not delivered yet. Interim hub favicon is dual-colour (blue A + green C); Voice chrome must not give green equal weight. Do not invent a replacement SVG ahead of Design.  
3. **Purple token debt** — `--grad-volt` and hardcoded `#6B21A8`/`#7C3AED` appear across CSS, SVG, canvas sparks, marketing, OG, tenant branding default.  
4. **Website CSS over-import** — `astraconnect-styles.css` includes Chat, Guide, and cinematic `hero-orb` / `hero-canvas` utilities. Phase 2 must extract Voice + neutrals + success only.  
5. **Chat / AC green confusion** — `--chat*`, `astrachat.png`, and hub favicon green C are not Voice UI primary; green in app chrome = success only.  
6. **“Astra Voice” dual meaning** — today marketing uses it as TTS brand; product rename requires layer-copy cleanup to avoid “Voice Voice”.  
7. **Home economics honesty** — shipping “estimated spend” as brand proof violates claim safety; chars are Studio-scoped.  
8. **Health chips vs sanitized health** — customers may see broken TTS/Brain/Telephony pills; fix carefully without exposing provider brands.  
9. **Test fixtures** — workflows/phone-numbers/employees tests assert AstraNova / greeting strings.  
10. **Legacy dual frontends** — `public/app.js` + `console.html` can miss a string sweep focused only on `assets/app.js`.  
11. **rapidx ops identity** — cookie/env/deploy names are non-UI but brand-leaky in docs and support runbooks.  
12. **Cinematic drift** — do not port Guide orb, hero washes, or glow utilities into the dense console.  
13. **Lockup casing** — kit art shows “Astra voice”; product UI copy likely “Astra Voice”. Decide once in Phase 2 asset brief.

---

## 16. Coordinator checklist (Phase 1 exit)

- [x] Canonical AstraConnect kit cited (`astravoice.png` preferred over purple repo SVG)  
- [x] Discrete AC mark = hub `favicon.png`; **no** approved standalone AC SVG yet  
- [x] Noted **pending Voice AC mark from Design** (electric blue); Voice chrome must not give green equal weight  
- [x] Logo inventory: Voice lockup vs hub AC favicon vs parent full vs Chat reference vs old ribbon A  
- [x] Brand string map (customer vs ops)  
- [x] Colour token gap + Phase 2 plan from `--voice` / `--voice-soft` / `--voice-foreground` + neutrals  
- [x] Explicit exclusion of Chat theme, Guide orb, website cinematic utilities  
- [x] Nav vs NAV-IA (no structural rebuild required)  
- [x] Shell/topbar provider pill behaviour  
- [x] Home KPI replacement guidance (API-ready, truthful)  
- [x] Employees/Studio, Leads→Billing surface notes  
- [x] Empty states + provider jargon + Training dual entry  
- [x] Frontend stack confirmed vanilla  
- [x] Phases 2–14 effort framing + risks  
- [x] Zero product UI mutations in this PR  

**Phase 1 success:** this document is sufficient to assign Phases 2–14 without further discovery of brand assets or Home metric honesty. Kit files are the asset/token source of truth; implementers should stage them into `dashboard/public/assets/` only when Phase 2 begins (not in this docs PR). Track Design delivery of the Voice-only AC mark as a Phase 2/3 dependency.
