# Agent types and Dograh workflow bindings

Astra testing treats **agent type** as a first-class choice, separate from industry category tags.

## Agent types

| id | Direction | Purpose |
| --- | --- | --- |
| `inbound_receptionist` | inbound | Answers inbound calls, greets, routes or books |
| `outbound_callback` | outbound | Follow-up / "call me anytime" callbacks |
| `lead_qualifier` | both | Sales qualification |
| `support` | inbound | Customer support / intake |
| `custom` | both | Blank agent |

`GET /api/agent-types` returns the catalog with labels, short descriptions, directions, and `recommendedPresetIds`.

## AstraNova presets

| Preset | Type | Dograh binding |
| --- | --- | --- |
| **AstraNova English Receptionist** (`preset_astranova_eng_receptionist_v1`) | `inbound_receptionist` | **`dograhWorkflowId: 8`** ("Astanova v2 ENG") — live inbound test mapping |
| **AstraNova Outbound Callback (Jerry)** (`preset_astranova_outbound_jerry_v1`) | `outbound_callback` | `dograhWorkflowKey: 'outbound_callback'`, numeric id **still TBD** in Dograh |

Creating an agent from a preset copies `agentType`, `direction`, `dograhWorkflowId`, and `dograhWorkflowKey` onto the agent record. Explicit create-body fields still win for name, persona, and greeting.

## Out of scope

Plans, credits, and number marketplace are not part of this surface.
