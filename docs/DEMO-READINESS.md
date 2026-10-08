# 12h celebrity demo readiness

## Code on tip (this branch)

- PRs **#13** (sanitize), **#14** (providerRunId), **#15** (Instant Leads) already on `main`. No rebase required.
- Fail-closed dial + voice tier stubs + customer provider leak strip (prior commit on this branch).
- **Excel/CSV bulk Campaigns** on the **same** `placeOutboundCallJob` → `createOutboundCall` path as Instant Leads (this commit). See [CAMPAIGNS-ANALYTICS.md](./CAMPAIGNS-ANALYTICS.md).

## Production host

AstraConnect runs on **Hostinger KVM only** (`194.238.17.38`, base path `/opt/astra`,
public host `194-238-17-38.sslip.io`). The old Google Cloud VPS is no longer part of
the architecture and must not be used as a deploy or audit target.

Live Astra app: `/opt/astra/astra-ai` (container `astra-dograh-astra-ai-1`, internal
port 8787, reached through nginx). Dograh stack: `/opt/astra/dograh`
(`docker-compose.hostinger.yaml`).

## Demo DID / sample file

- Fixture: `dashboard/demo-assets/campaign-demo-leads.csv` (+ `.xlsx`)
- 5× `900000000x` non-dialable + `REPLACE_WITH_AUTHORIZED_TEST` (must be replaced before any READY dial)
- Authorized live test DID when approved: `+918065353938`
- Do not place paid real dials without human confirm. Live phone proof remains **AWAITING EXTERNAL ACCEPTANCE**.

## Redeploy (Hostinger)

Follow the Hostinger deploy runbook used for PR deploys: back up
`/opt/astra/astra-ai/data/db.json` and the active `.env` into
`/opt/astra/backups/pre-deploy-<ref>-<ts>/`, update `/opt/astra/astra-ai`, then
recreate only the Astra service:

```sh
cd /opt/astra/dograh
docker compose -f docker-compose.hostinger.yaml -f docker-compose.override.hostinger.yaml up -d astra-ai
docker exec astra-dograh-astra-ai-1 wget -qO- http://127.0.0.1:8787/api/health
# expect: no providers/models/selected on anon health; gitSha when GIT_SHA set
```

Do **not** claim a demo is live until the redeploy is verified on Hostinger.
