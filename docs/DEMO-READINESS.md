# 12h celebrity demo readiness

## Code on `main` (after this PR)

- PRs **#13** (sanitize), **#14** (providerRunId), **#15** (Instant Leads) are already merged. No rebase required.
- Phases 1–22 Employee product layer is on `main`.
- Fail-closed dial: outbound requires a resolved Astra Phone Number. No silent `DOGRAH_PHONE_NUMBER_ID` fallback for product dials.
- Customer `/api/providers` returns product layer flags only. Super Admin keeps full inventory.
- Employee Voice tab: Standard / Regional Premium / Licensed Brand / Private Enterprise stubs. See [CELEBRITY-VOICES.md](./CELEBRITY-VOICES.md).

## Live VPS (as of audit)

`http://8.231.82.37:8787` was running a **stale** dashboard build:

- Anon `/api/health` still leaked provider inventory  
- `/console.html` was public  
- `/api/employees`, `/api/leads`, `/api/version` missing  
- Demo login `demo@rapidx.ai` / `rapidxvoice` rejected  

**Action:** redeploy dashboard from current `main` via `deploy/06-deploy-dashboard.sh` (sets `GIT_SHA` / `DEPLOYED_AT`). Preserve existing VPS `.env` (include `DEEPGRAM_API_KEY`, `GROQ_API_KEY`, `RUMIK_API_KEY`, `DOGRAH_*`).

## Demo DID

Test DID: `+918065353938`. Do not place paid real dials without human confirm. Live phone proof remains **AWAITING EXTERNAL ACCEPTANCE**.

## Smoke after deploy

```sh
curl -s http://$VPS_IP:8787/api/health
# expect: ok, version, gitSha|null, deployedAt|null — NO providers/models/selected

curl -s -D- http://$VPS_IP:8787/console.html | head
# expect: 302 /app.html for anon

cd dashboard && npm test
```
