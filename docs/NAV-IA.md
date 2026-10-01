# Nav / IA (Astra Voice platform)

Customer navigation is a **SaaS platform shell**, not a 7-step onboarding slideshow.
Investor dark (`#07111F`) is the primary polished experience.

## Primary navigation (exact labels)

1. **Overview**
2. **AI Employees**
3. **Calls**
4. **Leads**
5. **Automations**
6. **Integrations**
7. **Analytics**

## Secondary (TOOLS)

1. **Phone Numbers**
2. **Campaigns**
3. **Settings**
4. **Guided Setup** (optional / feature-flagged; hidden in Investor Demo)
5. **Training hub** (hidden in Investor Demo)
6. **Conversations** remains routed when present; hidden in Investor Demo if unfinished

## Account

Billing, Support, Admin/Diagnostics (Diagnostics Super Admin only; hidden in Investor Demo)

## AI Employee detail (Maya and others)

Underline tabs:

1. Overview
2. Instructions
3. Knowledge
4. Voice & Language
5. Routing
6. Actions
7. Testing
8. Outcomes

**Run Live Demo** opens a focused live-call workspace (`tab=live-demo`), not a permanent nav item.

Hero actions only: **Run Live Demo** · **Test Call** · **Edit**. No duplicate Configure / Go live in the hero.

Product status labels (exactly one): Draft | Ready to Test | Ready to Go Live | Live | Paused | Needs Attention.

## Investor Demo mode

Top-right toggle. Hides developer controls, unfinished experimental nav (Conversations, Guided Setup, Diagnostics modules), and emphasizes Maya, Live Demo, Calls, Outcomes, Integrations.

## Guided Setup / Demo Journey (optional)

The 7-step investor storyboard lives under **Guided Setup** (`#/ai-employee-setup`, feature-flagged). Never primary nav.

## Product rules

- Customer product name: **Astra Voice** (parent AstraConnect). Never "Astra AI" in customer UI.
- Live vs Demo Preview hard split. Never fake analytics.
- PSTN dials require explicit authorization UI.
- Prefer abstracting provider brands in primary investor UI.
- Phone numbers come from employee↔number mapping (never fake hardcoded DIDs in UI).
- Cal.com: Connected · Astra Voice Demo · 30 minutes (hide Event Type ID).
- Voice draft copy: "Draft voice" / "Not active" (never "Preview only · production voice unchanged").

See [AI-EMPLOYEE-JOURNEY.md](./AI-EMPLOYEE-JOURNEY.md), [EMPLOYEES.md](./EMPLOYEES.md), [CALLS.md](./CALLS.md), [CONVERSATIONS.md](./CONVERSATIONS.md).
