# AstraConnect Design System

**Status:** Locked shared direction (pre–Phase 3 UI). Canonical token names for the AstraConnect product family.  
**Repo:** `BadhulaVijaybhaskar/astra-ai-voice-stack`  
**Implements in:** `dashboard/public/assets/brand.css` (vanilla CSS custom properties)  
**Related:** `docs/astra-voice-rebrand-phase1-audit.md`, Phase 2 PR brand foundation

No em dashes in this codebase. Use commas or periods.

---

## 1. Principles

| Rule | Detail |
| --- | --- |
| Family | **AstraConnect** is the parent product family. Customer-facing Voice chrome says **Astra Voice**, not Astra AI / AstraConnect Voice. |
| Voice app feel | **Light, operational, calm/dense console.** Not marketing/cinematic. |
| Marketing demos | May use a **dark presentation variant** (see §8). Do not port dark chrome into the Voice SPA. |
| Stack | **Vanilla HTML / CSS / JS.** No React rewrite. No shadcn / Tailwind migration required for Voice. |
| Tokens | Copy **values** into `brand.css`. Do not import website Chat/Guide/hero-orb utilities into the console. |
| Logos | **USER OVERRIDE sole SoT** (see §9). Do not use Design graphite-C Voice AC pack. Do not redraw. |

---

## 2. Canonical tokens

Canonical names are the AstraConnect shared vocabulary. Hex values below match the Phase 2 Voice lock (kit OKLCH → sRGB). Prefer these names in new CSS; keep `--voice*` / legacy aliases for existing console classes.

### 2.1 Brand blues (primary)

| Canonical | Hex | Role |
| --- | --- | --- |
| `--astra-blue` | `#0077ec` | Primary action / links / selected rail (kit `oklch(0.58 0.2 255)`) |
| `--astra-blue-hover` | `#0066c9` | Hover / pressed primary |
| `--astra-blue-soft` | `#e7f5ff` | Soft wash (selected nav, chips, focus tint) |
| `--astra-blue-foreground` | `#FFFFFF` | Text/icons on solid blue |

### 2.2 Brand greens (Chat family + status caution)

| Canonical | Hex | Role |
| --- | --- | --- |
| `--astra-green` | `#2eb88a` | **Astra Chat** product accent (kit-ish teal-green). **Not** a Voice UI theme. |
| `--astra-green-dark` | `#1f7a5c` | Chat dark / emphasis |
| `--astra-green-soft` | `#e8f8f2` | Chat soft wash |
| `--success` | `#24a656` | **Shared status** success only (kit `oklch(0.64 0.16 151)`) |

**Green rule:** Chat green ≠ success green ≠ AC-mark teal. Voice chrome never uses `--astra-green*` as primary. Mark teal lives in logo PNGs (`--mark-teal` / `#09b5a5`) as a restrained logo accent only.

### 2.3 Neutrals (graphite / navy)

| Canonical | Hex | Role |
| --- | --- | --- |
| `--astra-navy` | `#051223` | Primary ink / strong text (kit foreground) |
| `--astra-graphite` | `#1e2a3a` | Secondary strong text |
| `--astra-gray` | `#556272` | Muted / meta text |
| `--astra-gray-soft` | `#8492a6` | Faint labels, crumbs |

### 2.4 Surfaces

| Canonical | Hex | Role |
| --- | --- | --- |
| `--background` | `#fcfeff` | App canvas |
| `--surface` | `#f3f7fc` | Raised / sidebar wash / secondary fill |
| `--surface-elevated` | `#FFFFFF` | Cards / panels / auth card |
| `--surface-muted` | `#f8fafc` | Nested panel alternate |

### 2.5 Text

| Canonical | Maps to | Role |
| --- | --- | --- |
| `--text-primary` | `--astra-navy` | Body / headings |
| `--text-secondary` | `--astra-graphite` | Supporting copy |
| `--text-muted` | `--astra-gray` | Labels, meta |
| `--text-faint` | `--astra-gray-soft` | Eyebrows, crumbs |
| `--text-on-brand` | `--astra-blue-foreground` | On primary buttons |

### 2.6 Borders

| Canonical | Hex | Role |
| --- | --- | --- |
| `--border` | `#dae2eb` | Default hairline |
| `--border-strong` | `#c8d3e0` | Inputs, stronger dividers |
| `--border-focus` | `rgba(0,119,236,0.7)` | Focus ring border |

### 2.7 Status (shared language)

| Canonical | Hex | Language (UI copy) |
| --- | --- | --- |
| `--success` | `#24a656` | Success / ready / connected (when true) |
| `--warning` | `#e1a01d` | Warning / needs attention |
| `--error` | `#DC2626` | Error / failed / blocked |

Shared status language across Voice surfaces:

| State | Prefer | Avoid |
| --- | --- | --- |
| Success | “Ready”, “Completed”, “Delivered” | Fake green “Connected” telephony rates |
| Warning | “Needs attention”, “Pending” | Alarmist red for soft waits |
| Error | “Failed”, “Blocked”, clear next step | Purple/brand color for errors |
| Empty | Honest empty (“No … yet”) | Invented KPIs or placeholder charts |

### 2.8 Radius

| Canonical | Value | Role |
| --- | --- | --- |
| `--radius-sm` | `8px` | Chips, compact controls |
| `--radius-md` | `12px` | Buttons, inputs |
| `--radius-lg` | `16px` | Cards |
| `--radius-xl` | `22px` | Auth / hero panels |
| `--radius-pill` | `999px` | Pills, health chips |

### 2.9 Shadow

| Canonical | Value | Role |
| --- | --- | --- |
| `--shadow-sm` | `0 1px 2px rgba(5,18,35,0.04), 0 8px 24px -14px rgba(5,18,35,0.10)` | Cards |
| `--shadow-md` | `0 20px 48px -24px rgba(5,18,35,0.18)` | Popovers / auth |
| `--shadow-focus` | `0 0 0 4px rgba(0,119,236,0.12)` | Input focus ring |
| `--shadow-brand` | `0 0 0 1px rgba(0,119,236,0.22), 0 10px 28px -12px rgba(0,119,236,0.28)` | Primary CTA elevation |

Keep shadows soft. No multi-layer glow stacks, no Guide-orb bloom in the Voice console.

---

## 3. Mapping to Voice `brand.css` (`--voice*` and legacy)

Phase 2 Voice console keeps `--voice*` and older aliases for compatibility. Canonical `--astra-*` names are first-class; `--voice` resolves to `--astra-blue`.

| Canonical | Voice / legacy alias in `brand.css` |
| --- | --- |
| `--astra-blue` | `--voice`, `--accent`, `--a-indigo`, `--a-violet`, `--a-cyan` (legacy cyan → blue) |
| `--astra-blue-hover` | Used by `.btn-primary:hover` / `--a-sky` / `--gold-deep` |
| `--astra-blue-soft` | `--voice-soft` |
| `--astra-blue-foreground` | `--voice-foreground`, `--accent-ink` |
| `--mark-teal` | AC logo only (`--accent-2`); not Chat green |
| `--background` | `--bg`, `--canvas` |
| `--surface` | `--bg-2`, `--raised` |
| `--surface-elevated` | `--panel` |
| `--surface-muted` | `--panel-2` |
| `--text-primary` | `--ink`, `--ink-dark` |
| `--text-secondary` | `--ink-soft` |
| `--text-muted` | `--ink-dim`, `--muted` |
| `--text-faint` | `--ink-faint`, `--text-dim` |
| `--border` | `--line` |
| `--border-strong` | `--line-2` |
| `--success` | `--ok` |
| `--warning` | `--warn` |
| `--error` | `--bad` |
| `--radius-sm` … `--radius-pill` | `--r-sm`, `--r`, `--r-lg`, `--r-xl`, `--r-pill` |
| `--shadow-sm` / `--shadow-md` | `--shadow-card` / `--shadow-pop` |
| `--shadow-brand` | `--glow-accent` |

**Retired as brand identity:** purple `#6B21A8`, `#7C3AED`, purple→cyan `--grad-volt` identity. `--grad-volt` may remain as a soft **blue** wash alias only.

**Do not import into Voice `brand.css` as UI theme:** `--chat*`, `--guide*`, website `hero-orb` / `hero-canvas` / `hero-ecosystem` utilities.

---

## 4. Product component patterns (Voice console)

Preserve IA and workflows. Brand foundation + later polish only. Do not redesign Home KPIs or nav structure in token work.

| Domain | Pattern | Notes |
| --- | --- | --- |
| **Employee** | List → Employee Studio tabs | Customer label “Employee”; Agents stay Diagnostics |
| **Call / Conversation** | Conversations list + detail | Honest empty; sync copy stays calm |
| **Lead** | Instant Leads → CallJob confirm | No provider brands on customer chrome |
| **Campaign** | Upload → map → validate → dial path | Same CallJob path as Instant Leads |
| **Performance** | Aggregate tables, `—` when null | Never invent connect rates |
| **Phone Number** | Assign to Employee | Provider portals invisible to customers |
| **Billing** | Wallet / packs / entitlements | Status colors for wallet events only |

Shell chrome: sidebar lockup, top crumb **Astra Voice**, health chips as product layers (Voice / Brain / Listening / Telephony labels preferred over raw provider names for customers).

---

## 5. Button / form / badge families

### Buttons
| Family | Class / token | Look |
| --- | --- | --- |
| Primary | `.btn-primary` | Solid `--astra-blue`, white label, `--shadow-brand` |
| Ghost | `.btn-ghost` | Surface + `--border-strong` |
| Quiet | `.btn-quiet` | Text only; hover `--astra-blue-soft` |
| Danger | (prefer explicit) | `--error` border/text; never purple |

### Forms
| Element | Token use |
| --- | --- |
| Label | `--text-muted` |
| Input | `--surface-elevated`, `--border-strong`; focus `--border-focus` + `--shadow-focus` |
| Error text | `--error` |
| Helper | `--text-faint` |

### Badges / pills
| Kind | Treatment |
| --- | --- |
| Neutral | `--surface` + `--border` |
| Brand soft | `--astra-blue-soft` + blue text |
| Success / warn / error | status tokens + soft tint backgrounds |
| Health chips | pill; ok/warn/bad dots only (no Chat green theme) |

---

## 6. Typography scale

### App (Voice console)
Operational, slightly condensed. Existing `brand.css` / `app.css` scale:

| Step | Approx | Use |
| --- | --- | --- |
| Page title / H1 | ~1.55–2rem | Auth, rare page titles |
| Section H2 | ~1.15–1.5rem | View headers |
| Body | 16px / 1.55 | Default |
| UI / nav | ~0.875rem | Sidebar, controls |
| Meta / crumb | ~0.68–0.74rem uppercase | Crumbs, group labels |
| Mono | `--mono` | Codes, IDs |

Font stack: geometric sans already in `--font` (Avenir Next / SF / Segoe). Do not force marketing display fonts into the SPA.

### Marketing (landing / demos)
Larger fluid display (`.t-display`, `.t-h1`) is allowed on marketing pages only. Same color tokens; denser type ramp stays out of the console.

---

## 7. Voice stays light operational

| Do | Do not |
| --- | --- |
| White / off-white canvas, blue primary | Dark shell as default Voice theme |
| Soft blue selection washes | Purple/cyan volt identity |
| Dense sidebar + sticky topbar | Cinematic hero orbs inside app |
| Solid primary buttons | Glow-heavy / multi-shadow spectacle |

---

## 8. Dark presentation variant (marketing demos only)

Allowed for **marketing decks, demo.html presentation skins, recorded demos**, not for the authenticated Voice console default.

| Token role | Dark variant guidance |
| --- | --- |
| Background | Near-navy `#0b1220` or `--astra-navy` |
| Surface | Slightly lifted navy panels |
| Text | Off-white primary; muted at ~70% |
| Primary | Still `--astra-blue` (readable on dark) |
| Borders | White at ~10–15% opacity |
| Status | Same hue family; bump lightness for contrast |

Rules:
1. Opt-in class/context only (e.g. `.theme-dark` on a demo host), never flip `:root` for `/app.html`.
2. Do not import Guide orb / hero-canvas utility stacks.
3. Logos: use approved PNGs; ensure contrast on dark (lockup already ships on transparent/dark-friendly art).

---

## 9. Logos (source of truth)

**USER OVERRIDE. Sole assets. No redraw. No Design graphite-C pack.**

| File | Role |
| --- | --- |
| `astravoice-lockup.png` | Sidebar / auth lockup ([AC] + “Astra voice”) |
| `astra-voice-ac-mark.png` | Favicon / compact / boot mark (electric blue A + teal C) |

Product paths: `dashboard/public/assets/brand/`  
Archive: `docs/assets/astra-voice-rebrand/user-logos/`

Art may read “Astra voice”; UI strings say **Astra Voice**.

---

## 10. Explicit non-goals

- No React / design-system framework rewrite
- No Home KPI redesign, nav IA rebuild, or workflow changes from this doc
- No Chat green or Guide graphite as Voice primary
- No deploy from docs/token-alias commits alone
- No backend/API identifier renames for branding

---

## 11. Adoption checklist (later UI phases)

1. Prefer `--astra-blue*` in new CSS; leave `--voice*` working via alias.
2. Sweep hardcoded purple hex when touching a file.
3. Marketing Phase: titles/OG/lockups; keep dark variant opt-in.
4. Optional later: server seed `branding.color` → `#0077ec` (backend pass, not required here).

**Phase 3+ UI work should treat this file as the shared token and pattern contract.**
