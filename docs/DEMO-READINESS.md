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

## Demo DID

Test DID: `+918065353938`. Sample campaign file includes this DID once plus non-dialable placeholders only. Do not place paid real dials without human confirm. Live phone proof remains **AWAITING EXTERNAL ACCEPTANCE**.

## Smoke after deploy

```sh
curl -s http://$VPS_IP:8787/api/health
# expect: ok, version, gitSha|null — NO providers/models/selected

curl -s -D- http://$VPS_IP:8787/console.html | head
# expect: 302 /app.html for anon

cd dashboard && npm test
```
