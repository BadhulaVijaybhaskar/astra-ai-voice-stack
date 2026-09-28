# 12h celebrity demo readiness

## Code on tip (this branch)

- PRs **#13** (sanitize), **#14** (providerRunId), **#15** (Instant Leads) already on `main`. No rebase required.
- Fail-closed dial + voice tier stubs + customer provider leak strip (prior commit on this branch).
- **Excel/CSV bulk Campaigns** on the **same** `placeOutboundCallJob` → `createOutboundCall` path as Instant Leads (this commit). See [CAMPAIGNS-ANALYTICS.md](./CAMPAIGNS-ANALYTICS.md).

## Live VPS (audit)

`http://8.231.82.37:8787` still runs a **stale** build (`app.js?v=20260915-polish`):

- Anon `/api/health` still leaks provider inventory (deepgram/rumik/groq/vobiz)
- `/api/employees` and `/api/leads` → `not_found`
- Product journey APIs from `main@a2677f5`+ tip are **not deployed**

**After this PR merges:** redeploy tip via `deploy/06-deploy-dashboard.sh` with `GIT_SHA` / `DEPLOYED_AT` and preserve VPS `.env` (`DOGRAH_*`, `DEEPGRAM_API_KEY`, `GROQ_API_KEY`, `RUMIK_API_KEY`).

## Demo DID / sample file

- Fixture: `dashboard/demo-assets/campaign-demo-leads.csv` (+ `.xlsx`)
- 5× `900000000x` non-dialable + `REPLACE_WITH_AUTHORIZED_TEST` (must be replaced before any READY dial)
- Authorized live test DID when approved: `+918065353938`
- Do not place paid real dials without human confirm. Live phone proof remains **AWAITING EXTERNAL ACCEPTANCE**.

## VPS redeploy (required before claiming deployed)

Live box is still stale (`app.js?v=20260915-polish`). After this PR merges onto the deploy branch:

```sh
# on the VPS (paths may be /opt/rapidx-voice or /opt/astra-ai depending on install)
cd /opt/astra-ai   # or /opt/rapidx-voice
git fetch origin
git checkout <merged-tip-sha>   # or: git pull origin main
# preserve .env (DOGRAH_*, DEEPGRAM_API_KEY, GROQ_API_KEY, RUMIK_API_KEY)
docker restart rapidx-voice     # container name from deploy/06-deploy-dashboard.sh
# or: docker restart astra-ai
curl -s http://127.0.0.1:8787/api/health
# expect: no providers/models/selected on anon health; gitSha when GIT_SHA set
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8787/api/employees
# expect: 401 (endpoint exists) not 404
```

Do **not** claim the celebrity demo is live on VPS until the above redeploy is verified.
