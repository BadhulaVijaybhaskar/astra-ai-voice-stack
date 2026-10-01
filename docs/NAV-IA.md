# Nav / IA (Astra Voice platform)

Customer navigation is a **SaaS platform shell**, not a 7-step onboarding slideshow.

## Primary navigation (exact labels)

1. **Overview**
2. **AI Employees**
3. **Calls**
4. **Conversations**
5. **Leads**
6. **Automations**
7. **Integrations**
8. **Analytics**
9. **Settings**

## AI Employee detail (Maya and others)

When opening an employee, tabs are:

1. Overview
2. Instructions
3. Knowledge
4. Voice & Language
5. Routing
6. Actions
7. Testing
8. Outcomes

Do **not** use permanent IA labels Employee / Knowledge / Language / Routing / Call / Outcome / Next outside Guided Setup.

## Guided Setup / Demo Journey (optional)

The 7-step investor storyboard lives under **Guided Setup** (`#/ai-employee-setup`, feature-flagged). It is reachable from Maya Overview CTAs (Configure / Run Live Demo / Guided Setup) and appears under **TOOLS**, never as primary nav.

Steps inside Guided Setup only: Employee → Knowledge → Voice → Routing → Conversation → Outcome → Action.

## Tools / Account / Diagnostics

- **TOOLS**: Guided Setup (flagged), Campaigns, Training hub, Phone Numbers
- **ACCOUNT**: Billing, Support, Admin/Diagnostics
- **DIAGNOSTICS** (Super Admin): Agents, Workflows, Presets, Voice Studio, Talk, Knowledge library, Demo links

## Product rules

- Customer product name: **Astra Voice** (parent AstraConnect). Never "Astra AI" in customer UI.
- Live vs Demo Preview hard split. Never fake analytics.
- PSTN dials require explicit authorization UI.
- Prefer abstracting provider brands in primary investor UI.

See [AI-EMPLOYEE-JOURNEY.md](./AI-EMPLOYEE-JOURNEY.md), [EMPLOYEES.md](./EMPLOYEES.md), [CALLS.md](./CALLS.md), [CONVERSATIONS.md](./CONVERSATIONS.md).
