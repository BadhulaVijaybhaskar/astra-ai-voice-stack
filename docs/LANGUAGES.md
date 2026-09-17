# Languages (Phase 18)

First-class **Language** selection for Employee voice. India-first catalog.

## Supported (honest list)

| Id | Label |
| --- | --- |
| `en-IN` | English (India) |
| `hi-IN` | Hindi |
| `te-IN` | Telugu |
| `ta-IN` | Tamil |

Only languages the stack can route today. No invented voices. Customer copy uses **Language**, never STT/TTS vendor names.

## API

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/api/employees/languages` | Catalog. |
| `PUT` / `PATCH` / `POST` | `/api/employees/:id/language` | Body `{ language }`. Rejects unsupported ids. |
| `PATCH` | `/api/employees/:id` | Body `{ language }` or `{ voice: { language } }` also works. |

Wired into existing `employee.voice.language`.

## UI

Employee Studio → **Voice** tab: Language select + Save.

## See also

- [EMPLOYEES.md](./EMPLOYEES.md)
