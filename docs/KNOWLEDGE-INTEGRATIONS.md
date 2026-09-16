# Knowledge and Integrations (Sprint 4)

## Knowledge Base

Tenant-scoped FAQ/docs in portable JSON (`knowledgeEntries`).

Fields: `title`, `content` and/or `sourceUrl`, `status` (`draft` | `published` | `archived`), optional `tags`.

### Routes

- `GET /api/knowledge` list
- `POST /api/knowledge` create
- `POST /api/knowledge/update` `{id,...}`
- `POST /api/knowledge/delete` `{id}`
- `GET /api/knowledge/retrieve?q=` keyword overlap stub (published only)

No vector database in V1. Retrieval is for agent-context stubs only.

## Integrations

### Webhooks

Registry in `integrationWebhooks`: name, HTTPS URL, events, `secretHash`.
Raw secret returned once on create as `secretOnce`.

Events: `lead.created`, `call.completed`, `campaign.started`, `campaign.completed`.

- `GET /api/integrations` webhooks + CRM placeholders + event list
- `POST /api/integrations/webhooks` owner required
- `POST /api/integrations/webhooks/update` owner required
- `POST /api/integrations/webhooks/delete` owner required
- `POST /api/integrations/lead-created` stub outbound queue for matching webhooks

### CRM

HubSpot and Salesforce appear as `coming_soon`. Use webhooks until native connectors ship.
