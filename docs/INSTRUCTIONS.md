# Instructions (Teach) — Phase 5

Customer-facing **Instructions** for an AI Employee. This is teaching language, not prompt engineering jargon.

## What it edits

| Field | Stored on | Customer label |
| --- | --- | --- |
| Brief | `employee.description` | Brief |
| Greeting | linked `agent.greeting` | Greeting |
| Instructions | linked `agent.persona` | Instructions |
| Step guidance | linked `workflow.graphJson.nodes[].prompt` | Step guidance |

Reuse: existing Agent + Workflow fields. No duplicated prompt blob on the Employee.

## API

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/api/employees/:id/instructions` | Brief, greeting, instructions, workflow steps. |
| `PUT` / `PATCH` / `POST` | `/api/employees/:id/instructions` | Persist edits. Requires linked agent for greeting/instructions. |

Public JSON never includes Dograh / VoBiz / Rumik / STT / TTS / LLM terms.

## UI

Employee Studio → **Instructions** tab. Editable form with Save. Empty agent shows a clear empty state.

## See also

- [EMPLOYEES.md](./EMPLOYEES.md)
- [OUTCOMES.md](./OUTCOMES.md)
- [LEADS.md](./LEADS.md)
