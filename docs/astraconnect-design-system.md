# Astra Voice Design System (Voice app)

**Status:** Phase 2 brand foundation. Voice-side token and pattern spec for **this repo only**.  
**Implements in:** `dashboard/public/assets/brand.css` + `app.css` (vanilla CSS)  
**Related:** `docs/astra-voice-rebrand-phase1-audit.md`, Phase 2 PR #27  

**Scope lock:** Voice-only. Do not connect to, coordinate with, or depend on any AstraConnect website repo or agent. No website PRs, no waiting on external aliases.

No em dashes in this codebase. Use commas or periods.

---

## 1. Principles

| Rule | Detail |
| --- | --- |
| Product name | Customer chrome says **Astra Voice** (not Astra AI). |
| Voice app | **Light, operational, calm/dense.** Not cinematic. |
| Marketing pages in this repo | Optional **dark presentation** (§9) for demos only. Never default `/app.html` to dark. |
| Stack | **Vanilla HTML/CSS/JS.** No React rewrite. |
| Logos | USER OVERRIDE sole SoT (§10). No Design graphite-C pack. No redraw. |
| Green | Chat-product greens (`--astra-green*` / `--chat*`) must **not** theme Voice UI. Status uses `--success` only. |

---

## 2. Brand blues (`--astra-blue*` ↔ `--voice*`)

Voice electric blue is the primary accent. Both name families are first-class in this app (equal literals, no circular `var()`).

| Token | OKLCH | Hex | Role |
| --- | --- | --- | --- |
| `--astra-blue` / `--voice` | `oklch(0.58 0.2 255)` | `#0077ec` | Primary CTA, links, selected rail |
| `--astra-blue-hover` | (derived) | `#0066c9` | Hover / pressed primary |
| `--astra-blue-soft` / `--voice-soft` | `oklch(0.965 0.025 250)` | `#e7f5ff` | Soft wash, selected nav, chip fill |
| `--astra-blue-foreground` / `--voice-foreground` | `oklch(1 0 0)` | `#FFFFFF` | Text/icon on solid blue |

```css
--astra-blue:            #0077ec;
--astra-blue-hover:      #0066c9;
--astra-blue-soft:       #e7f5ff;
--astra-blue-foreground: #FFFFFF;
--voice:                 #0077ec; /* = --astra-blue */
--voice-soft:            #e7f5ff; /* = --astra-blue-soft */
--voice-foreground:      #FFFFFF; /* = --astra-blue-foreground */
```

New Voice CSS may use either `--astra-blue` or `--voice`. Prefer `--astra-blue*` in new work; keep `--voice*` for existing console classes.

---

## 3. Reserved greens (do not theme Voice)

Named for clarity and to avoid accidental reuse. **Not** Voice primary, selected nav, or CTA fill.

| Token | Also named | OKLCH | Hex ≈ | Note |
| --- | --- | --- | --- | --- |
| `--astra-green` | `--chat` | `oklch(0.67 0.15 166)` | `#00b180` | Reserved Chat-product hue |
| `--astra-green-dark` | `--chat-dark` | `oklch(0.42 0.11 167)` | `#005f40` | Reserved |
| `--astra-green-soft` | `--chat-soft` | `oklch(0.965 0.03 166)` | `#e2faef` | Reserved |

**Also not Chat-product green:**
- AC-mark teal (`--mark-teal` `#09b5a5`) — logo chrome only  
- `--success` `#24a656` / `oklch(0.64 0.16 151)` — **status** green only  

---

## 4. Surfaces, text, borders, status base, radii, shadows

### Surfaces

| Token | OKLCH | Hex | Legacy alias |
| --- | --- | --- | --- |
| `--background` | `oklch(0.995 0.002 245)` | `#fcfeff` | `--bg`, `--canvas` |
| `--surface` | `oklch(0.975 0.008 250)` | `#f3f7fc` | `--bg-2`, `--raised` |
| `--surface-elevated` | `oklch(1 0 0)` | `#FFFFFF` | `--panel` |
| `--surface-muted` | — | `#f8fafc` | `--panel-2` |

### Text

| Token | Hex | Legacy alias |
| --- | --- | --- |
| `--text-primary` | `#051223` (`oklch(0.18 0.04 255)`) | `--ink`, `--astra-navy` |
| `--text-secondary` | `#1e2a3a` | `--ink-soft`, `--astra-graphite` |
| `--text-muted` | `#556272` (`oklch(0.49 0.03 255)`) | `--ink-dim`, `--muted` |
| `--text-faint` | `#8492a6` | `--ink-faint` |
| `--text-on-brand` | `#FFFFFF` | `--voice-foreground` |

### Borders

| Token | Hex / value | Legacy alias |
| --- | --- | --- |
| `--border` | `#dae2eb` (`oklch(0.91 0.015 250)`) | `--line` |
| `--border-strong` | `#c8d3e0` | `--line-2` |
| `--border-focus` | `rgba(0,119,236,0.7)` | input focus border |

### Base status

| Token | OKLCH | Hex | Legacy alias |
| --- | --- | --- | --- |
| `--success` | `oklch(0.64 0.16 151)` | `#24a656` | `--ok` |
| `--warning` | `oklch(0.75 0.15 78)` | `#e1a01d` | `--warn` |
| `--error` | restrained red | `#DC2626` | `--bad` |

### Radii

| Token | Value | Legacy alias |
| --- | --- | --- |
| `--radius-sm` | `8px` | `--r-sm` |
| `--radius-md` | `12px` | `--r` |
| `--radius-lg` | `16px` | `--r-lg` |
| `--radius-xl` | `22px` | `--r-xl` |
| `--radius-pill` | `999px` | `--r-pill` |

### Shadows

| Token | Value | Legacy alias |
| --- | --- | --- |
| `--shadow-sm` | `0 1px 2px rgba(5,18,35,0.04), 0 8px 24px -14px rgba(5,18,35,0.10)` | `--shadow-card` |
| `--shadow-md` | `0 20px 48px -24px rgba(5,18,35,0.18)` | `--shadow-pop` |
| `--shadow-focus` | `0 0 0 4px rgba(0,119,236,0.12)` | input focus ring |
| `--shadow-brand` | `0 0 0 1px rgba(0,119,236,0.22), 0 10px 28px -12px rgba(0,119,236,0.28)` | `--glow-accent` |

---

## 5. Status badge tokens (call / lead / conversation)

Operational Voice badges. Tokens are **fg + soft bg + border**. Do not invent fake telephony connect rates; “Connected” means a real connected/assigned state when the product exposes it.

| Status | Token prefix | FG | Soft BG | Border |
| --- | --- | --- | --- | --- |
| **Ready** | `--status-ready-*` | `#0077ec` | `#e7f5ff` | `rgba(0,119,236,0.28)` |
| **Calling** | `--status-calling-*` | `#b45309` | `#fff7ed` | `rgba(225,160,29,0.40)` |
| **Connected** | `--status-connected-*` | `#24a656` | `#ecfdf3` | `rgba(36,166,86,0.28)` |
| **Completed** | `--status-completed-*` | `#15803d` | `#ecfdf3` | `rgba(36,166,86,0.28)` |
| **Qualified** | `--status-qualified-*` | `#047857` | `#ecfdf3` | `rgba(36,166,86,0.35)` |
| **Callback** | `--status-callback-*` | `#e1a01d` | `#fffbeb` | `rgba(225,160,29,0.40)` |
| **Not interested** | `--status-not-interested-*` | `#556272` | `#f3f7fc` | `rgba(85,98,114,0.28)` |
| **No answer** | `--status-no-answer-*` | `#8492a6` | `#f8fafc` | `rgba(132,146,166,0.35)` |
| **Failed** | `--status-failed-*` | `#DC2626` | `#fef2f2` | `rgba(220,38,38,0.32)` |

Suffixes: `-fg`, `-bg`, `-border` (e.g. `--status-ready-fg`).

| Prefer | Avoid |
| --- | --- |
| Ready, Calling, Connected, Completed, Qualified, Callback, Not interested, No answer, Failed | Purple for errors; Chat green for Voice badges |
| Honest empty (“No … yet”) | Invented KPIs |

Existing console classes (later polish may map onto tokens; not a Home redesign now):

| Class | Approx mapping |
| --- | --- |
| `.badge-ready` | Ready |
| `.badge-live` | Connected / live success |
| `.emp-status-ready` / `-live` / `-paused` / `-draft` | Employee lifecycle |
| `.conversation-status.*` | Live talk phases (idle≈Ready, listening≈Connected, error≈Failed) |
| `.pill` + outcome labels | Qualified / Callback / etc. when outcomes render |

---

## 6. Vanilla console class names (`brand.css` / `app.css`)

### Buttons

| Class | Role |
| --- | --- |
| `.btn` | Base control |
| `.btn-primary` | Solid `--astra-blue` / `--voice` |
| `.btn-ghost` | Outlined / surface |
| `.btn-quiet` | Text button |
| `.btn-lg` / `.btn-sm` | Size variants |
| `.btn-danger-soft` | Soft destructive (`app.css`) |
| `.btn-dark` | Dark utility (e.g. impersonation exit) |

### Forms

| Class | Role |
| --- | --- |
| `.field` | Label + control stack |
| `.field > label` | Field label (`--text-muted`) |
| `.input` | Text input |
| `.textarea` | Multiline |
| `.select` | Native select (`.is-empty` muted) |
| `.auth-form` | Auth gate form layout (`app.css`) |

Focus: `--border-focus`, `--shadow-focus`.

### Badges / pills / chips

| Class | Role |
| --- | --- |
| `.pill` | Generic pill |
| `.pill .dot` / `.warn` / `.bad` | Status dots |
| `.badge-gold` | Soft brand chip |
| `.badge-live` / `.badge-ready` | Live vs ready badges |
| `.emp-status` / `.emp-status-*` | Employee status pills |
| `.hchip` / `.hchip.ok` | Topbar health chips |
| `.conversation-status` | Live call phase pill |

### Shell primitives

| Class | Role |
| --- | --- |
| `.side` / `.side-brand` / `.lockup` | Sidebar + lockup image |
| `.nav` / `.nav a.active` | Nav; active uses `--voice-soft` |
| `.top` / `.crumb` / `.ttl` | Topbar crumb + title |
| `.card` / `.card-pad` | Panels |
| `.auth-card` / `.auth-lockup` | Auth gate |

---

## 7. Product patterns (preserve IA)

Employee, Call/Conversation, Lead, Campaign, Performance, Phone Number, Billing: keep shipped nav and workflows. Brand/token work only. **No Home KPI redesign** from this doc.

---

## 8. Typography

**App:** operational scale in `brand.css` / `app.css` (body 16px, nav ~0.875rem, crumbs ~0.68–0.74rem uppercase). Font stack `--font`.  
**Marketing pages in this repo:** fluid `.t-display` / `.t-h1` on landing only. Do not force marketing display ramp into the SPA.

---

## 9. Dark presentation (demos in this repo only)

Opt-in (e.g. `.theme-dark` on a demo host). Keep `--astra-blue` readable on dark navy canvases. Do **not** flip `:root` for `/app.html`. No Guide orb / hero-canvas imports into the Voice console.

---

## 10. Logos (source of truth)

| File | Role |
| --- | --- |
| `astravoice-lockup.png` | Sidebar / auth |
| `astra-voice-ac-mark.png` | Favicon / compact / boot |

Paths: `dashboard/public/assets/brand/` (product), `docs/assets/astra-voice-rebrand/user-logos/` (archive).

---

## 11. Explicit non-goals

- No React rewrite  
- No Home / nav / workflow redesign from this doc  
- No Chat green as Voice primary  
- No deploy from docs/token commits alone  
- No backend identifier renames  
- **No website repo coordination, PRs, or waiting on external aliases**  

**Phase 3+ Voice UI work should treat this file as the Voice-side token and pattern contract.**
