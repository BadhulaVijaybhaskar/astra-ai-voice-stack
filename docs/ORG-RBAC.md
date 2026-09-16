# Org, RBAC, audit, and secrets (Sprint 3)

Tenants are the persistence unit. Product UI calls them **workspaces** (and
sometimes **organizations**). `GET /api/me` returns `workspaceName` and
`organizationName` aliases that always equal `tenant.name`.

## Roles

| Role | Scope |
| --- | --- |
| `member` | Use agents, studio, calls, numbers, billing read |
| `owner` | Workspace settings, members, audit, privacy, BYON, demo links |
| `admin` | Platform support, PayU events, provider health, wallet adjust |
| `super_admin` | All admin plus tenants, users, impersonation |

Sensitive mutations emit `auditEvents`. Owners see their tenant via
`GET /api/audit`. Admins see the platform feed via `GET /api/admin/audit`.

## Secrets

Provider API keys live in `.env` only. `GET /api/admin/providers` returns
`configured: true|false` and the **names** of required env keys. Values are
never returned. Customers must never see Dograh, VoBiz, Rumik, Groq, or
Deepgram secret material.

## Key routes

- `POST /api/tenant/update` `{ name|workspaceName, color }` owner required, audits `tenant.updated`
- `GET /api/audit` owner required
- `GET /api/admin/providers` admin required, configured flags only
- `GET /api/admin/tenants`, `/api/admin/users` super admin
