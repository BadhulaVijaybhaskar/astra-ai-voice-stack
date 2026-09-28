# AstraConnect Design System (Voice-owned spec)

**Status:** Phase 2 foundation complete. Phase 3 owns Home / shell polish against this contract.  
**Implements in:** `dashboard/public/assets/brand.css` + `app.css` (vanilla CSS)  
**Related:** `docs/astra-voice-rebrand-phase1-audit.md`, Phase 2 PR #27, Phase 3 Home / shell  

**Execution lock (USER OVERRIDE):**
- Voice-only work. Do **not** contact, coordinate with, open PRs against, or wait on any AstraConnect website repo or agent.
- Voice app stays **LIGHT operational**. No cinematic / Guide / hero-orb patterns in the console.
- Phase 3 may refine Home KPIs, activation journey, and empty states using **real data only**. No fabricated metrics. No backend renames for branding. No deploy from polish alone.

No em dashes in this codebase. Use commas or periods.

---

## 1. Principles

| Rule | Detail |
| --- | --- |
| Product name | Customer chrome: **Astra Voice** (not Astra AI). |
| Console feel | Light, operational, calm/dense. White / off-white canvas + electric blue. |
| Stack | Vanilla HTML / CSS / JS. No React rewrite. |
| Logos | USER OVERRIDE sole SoT (§11). No Design graphite-C pack. No redraw. |
| Green | `--astra-green*` documents Chat identity only. **Never** theme Voice green. Status uses `--success`. |
| Motion | Soft, purposeful, reduced-motion safe. Not cinematic. |

---

## 2. Brand blues (`--astra-blue*` = Voice electric blue)

| Token | OKLCH | Hex | Role |
| --- | --- | --- | --- |
| `--astra-blue` / `--voice` | `oklch(0.58 0.2 255)` | `#0077ec` | Primary CTA, links, selected rail |
| `--astra-blue-hover` | (derived) | `#0066c9` | Hover / pressed |
| `--astra-blue-soft` / `--voice-soft` | `oklch(0.965 0.025 250)` | `#e7f5ff` | Soft wash, selected nav |
| `--astra-blue-foreground` / `--voice-foreground` | `oklch(1 0 0)` | `#FFFFFF` | On solid blue |

Equal literals in `brand.css` (no circular `var()`):

```css
--astra-blue:            #0077ec;
--astra-blue-hover:      #0066c9;
--astra-blue-soft:       #e7f5ff;
--astra-blue-foreground: #FFFFFF;
--voice:                 #0077ec; /* = --astra-blue */
--voice-soft:            #e7f5ff; /* = --astra-blue-soft */
--voice-foreground:      #FFFFFF; /* = --astra-blue-foreground */
```

Prefer `--astra-blue*` in new CSS; keep `--voice*` for existing console classes. Legacy `--accent` → `--astra-blue`.

---

## 3. `--astra-green*` (Chat identity; do not theme Voice)

| Token | Also named | OKLCH | Hex ≈ | Use |
| --- | --- | --- | --- | --- |
| `--astra-green` | `--chat` | `oklch(0.67 0.15 166)` | `#00b180` | Document Chat identity only |
| `--astra-green-dark` | `--chat-dark` | `oklch(0.42 0.11 167)` | `#005f40` | Document only |
| `--astra-green-soft` | `--chat-soft` | `oklch(0.965 0.03 166)` | `#e2faef` | Document only |

Not Chat green: AC-mark teal `--mark-teal` `#09b5a5` (logo only); `--success` `#24a656` (status only).

---

## 4. Surfaces, text, borders, base status, radii, shadows

### Surfaces

| Token | OKLCH | Hex | Legacy |
| --- | --- | --- | --- |
| `--background` | `oklch(0.995 0.002 245)` | `#fcfeff` | `--bg`, `--canvas` |
| `--surface` | `oklch(0.975 0.008 250)` | `#f3f7fc` | `--bg-2`, `--raised` |
| `--surface-elevated` | `oklch(1 0 0)` | `#FFFFFF` | `--panel` |
| `--surface-muted` | — | `#f8fafc` | `--panel-2` |

### Neutrals / text

| Token | Hex | Legacy |
| --- | --- | --- |
| `--astra-navy` / `--text-primary` | `#051223` | `--ink` |
| `--astra-graphite` / `--text-secondary` | `#1e2a3a` | `--ink-soft` |
| `--astra-gray` / `--text-muted` | `#556272` | `--ink-dim`, `--muted` |
| `--astra-gray-soft` / `--text-faint` | `#8492a6` | `--ink-faint` |
| `--text-on-brand` | `#FFFFFF` | `--voice-foreground` |

### Borders

| Token | Value | Legacy |
| --- | --- | --- |
| `--border` | `#dae2eb` | `--line` |
| `--border-strong` | `#c8d3e0` | `--line-2` |
| `--border-focus` | `rgba(0,119,236,0.7)` | input focus |

### Base status

| Token | OKLCH / note | Hex | Legacy |
| --- | --- | --- | --- |
| `--success` | `oklch(0.64 0.16 151)` | `#24a656` | `--ok` |
| `--warning` | `oklch(0.75 0.15 78)` | `#e1a01d` | `--warn` |
| `--error` | restrained red | `#DC2626` | `--bad` |

### Radii

| Token | Value | Legacy |
| --- | --- | --- |
| `--radius-sm` … `--radius-pill` | `8` / `12` / `16` / `22` / `999px` | `--r-sm` … `--r-pill` |

### Shadows

| Token | Role | Legacy |
| --- | --- | --- |
| `--shadow-sm` | Cards | `--shadow-card` |
| `--shadow-md` | Auth / pop | `--shadow-pop` |
| `--shadow-focus` | Input ring | — |
| `--shadow-brand` | Primary CTA | `--glow-accent` |

Keep shadows soft. No multi-layer glow spectacle in the console.

---

## 5. Status language (badges)

Call / lead / conversation badges. Tokens: `--status-{name}-fg|bg|border`.

| Status | FG | Soft BG | Border |
| --- | --- | --- | --- |
| Ready | `#0077ec` | `#e7f5ff` | `rgba(0,119,236,0.28)` |
| Calling | `#b45309` | `#fff7ed` | `rgba(225,160,29,0.40)` |
| Connected | `#24a656` | `#ecfdf3` | `rgba(36,166,86,0.28)` |
| Completed | `#15803d` | `#ecfdf3` | `rgba(36,166,86,0.28)` |
| Qualified | `#047857` | `#ecfdf3` | `rgba(36,166,86,0.35)` |
| Callback | `#e1a01d` | `#fffbeb` | `rgba(225,160,29,0.40)` |
| Not interested | `#556272` | `#f3f7fc` | `rgba(85,98,114,0.28)` |
| No answer | `#8492a6` | `#f8fafc` | `rgba(132,146,166,0.35)` |
| Failed | `#DC2626` | `#fef2f2` | `rgba(220,38,38,0.32)` |

Prefer honest empty states. Never invent connect rates or KPIs. Do not use Chat green for Voice badges.

---

## 6. Components (product patterns; preserve IA)

| Domain | Pattern | Brand note |
| --- | --- | --- |
| Employee | List → Employee Studio tabs | Customer “Employee”; Agents stay Diagnostics |
| Call / Conversation | List + detail | Honest empty; calm sync copy |
| Lead | Instant Leads → CallJob confirm | No provider brands on chrome |
| Campaign | Upload → map → validate → dial | Same CallJob path |
| Performance | Aggregates; `—` when null | No invented rates |
| Phone Number | Assign to Employee | Provider portals hidden |
| Billing | Wallet / packs | Status colors for events only |

**Do not** redesign nav structure, Employee Studio IA, or CallJob workflows in the design-system contract alone. Phase 3 Home polish follows the preferred KPI hierarchy with honest empty states.

Shell: sidebar lockup, crumb **Astra Voice**. Provider / runtime health chips are Super Admin diagnostics only.

---

## 7. Buttons / forms / badges (vanilla classes)

### Buttons (`brand.css` / `app.css`)

| Class | Treatment |
| --- | --- |
| `.btn` | Base |
| `.btn-primary` | Solid `--astra-blue`, white label, `--shadow-brand` |
| `.btn-ghost` | Surface + `--border-strong` |
| `.btn-quiet` | Text; hover `--astra-blue-soft` |
| `.btn-lg` / `.btn-sm` | Sizes |
| `.btn-danger-soft` | Soft error |
| `.btn-dark` | Utility (e.g. impersonation exit) |

### Forms

| Class | Treatment |
| --- | --- |
| `.field` / `.field > label` | Stack; label `--text-muted` |
| `.input` / `.textarea` / `.select` | Elevated surface; focus `--border-focus` + `--shadow-focus` |
| `.auth-form` | Auth gate |

### Badges / pills

| Class | Role |
| --- | --- |
| `.pill` + `.dot` / `.warn` / `.bad` | Generic + status dots |
| `.badge-gold` | Soft brand chip |
| `.badge-live` / `.badge-ready` | Live vs ready |
| `.emp-status` / `.emp-status-*` | Employee lifecycle |
| `.hchip` | Topbar health |
| `.conversation-status` | Live call phase |

### Shell

`.side` / `.side-brand` / `.lockup`, `.nav` / `.nav a.active`, `.top` / `.crumb` / `.ttl`, `.card` / `.card-pad`, `.auth-card` / `.auth-lockup`

---

## 8. Typography scales

### App (Voice console) — operational

| Step | Size | Use |
| --- | --- | --- |
| Auth / rare H1 | ~1.55rem | Auth card title |
| Section / view title | ~0.98–1.15rem | Topbar `.ttl`, section heads |
| Body | `16px` / line-height `1.55` | Default |
| UI / nav | ~0.875rem | Sidebar links, controls |
| Meta / crumb | ~0.68–0.74rem uppercase | `.crumb`, `.nav-group`, eyebrows |
| Mono | `--mono` ~0.82rem | Codes, IDs |

Font stack: `--font` (Avenir Next / SF / Segoe). Letter-spacing slightly tight on headings.

### Marketing pages in this repo — display (landing only)

| Class | Scale | Use |
| --- | --- | --- |
| `.t-display` | `clamp(2.6rem, 6.2vw, 5.2rem)` | Hero display |
| `.t-h1` | `clamp(2rem, 4.2vw, 3.3rem)` | Marketing H1 |
| `.t-h2` | `clamp(1.55rem, 3vw, 2.4rem)` | Sections |
| `.t-h3` | `clamp(1.15rem, 1.8vw, 1.5rem)` | Subheads |
| `.t-lead` | `clamp(1.05rem, 1.5vw, 1.3rem)` | Lead copy |
| `.t-eyebrow` | `0.74rem` uppercase | Eyebrows |

Do **not** force marketing display ramp into the SPA.

---

## 9. Dark presentation variants (demos / marketing hosts in this repo)

Opt-in only (e.g. `.theme-dark` on a demo host). **Never** flip `:root` for `/app.html`.

| Role | Light (console default) | Dark presentation |
| --- | --- | --- |
| Background | `#fcfeff` | Near-navy `#0b1220` / `--astra-navy` |
| Surface elevated | `#FFFFFF` | Lifted navy panel |
| Text primary | `#051223` | Off-white |
| Text muted | `#556272` | ~70% off-white |
| Primary | `--astra-blue` `#0077ec` | Same blue (readable on dark) |
| Border | `#dae2eb` | White ~10–15% opacity |
| Status | `--success` / `--warning` / `--error` | Same hues; bump lightness for contrast |

Forbidden in Voice console: Guide orb, hero-canvas, cinematic glow stacks, Chat green theme.

---

## 10. Motion

Tokens in `brand.css`:

| Token | Value | Use |
| --- | --- | --- |
| `--ease` | `cubic-bezier(0.22, 1, 0.36, 1)` | Standard transitions |
| `--ease-out` | `cubic-bezier(0.16, 1, 0.3, 1)` | Reveals / exits |
| `--dur` | `0.55s` | Default duration |

Patterns:
- Buttons: short transform / shadow / color (~0.2–0.25s)
- Nav active: soft wash, no bounce spectacle
- `.reveal`: progressive enhancement only (`html.js`); content visible by default without JS
- `@media (prefers-reduced-motion: reduce)`: disable non-essential motion; force `.reveal` visible

Keep motion calm. No cinematic hero animations inside the console.

---

## 11. Logos (source of truth)

| File | Role |
| --- | --- |
| `astravoice-lockup.png` | Sidebar / auth ([AC] + “Astra voice”) |
| `astra-voice-ac-mark.png` | Favicon / compact / boot (electric blue A + teal C) |

Product: `dashboard/public/assets/brand/`  
Archive: `docs/assets/astra-voice-rebrand/user-logos/`  

USER OVERRIDE: use only these two PNGs. No Design graphite-C pack. No redraw. Art may read “Astra voice”; UI strings say **Astra Voice**.

---

## 12. Explicit non-goals

- No React rewrite  
- No Chat green or Guide graphite as Voice primary  
- No backend / API identifier renames for branding  
- No deploy from design-system / polish PRs alone  
- **No website repo PRs, agents, or external alias waits**  
- No fabricated Home KPIs or fake conversation rows  

**Phase 3+ Voice UI polish should treat this file as the Voice-owned design-system contract.**
