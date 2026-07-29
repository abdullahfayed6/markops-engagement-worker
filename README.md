# MarkOps Engagement Worker

Railway-deployable, manual-browser worker for isolated Facebook account profiles. It uses headed Chromium, Xvfb, x11vnc, and noVNC. It does not store passwords, solve CAPTCHA/2FA/checkpoints, use stealth or proxy rotation, generate comments, or run scheduled/bulk actions.

## Local development

```powershell
Copy-Item .env.example .env
# Set a random 24+ character WORKER_SECRET and PUBLIC_BASE_URL=http://localhost:3000
npm install
npx playwright install chromium
npm run check
npm run build
npm test
npm start
```

On Windows, Chromium opens as a desktop window. noVNC is supplied by the Docker entrypoint, so `viewerUrl` is intended for Docker/Railway.

## Docker

```bash
docker build -t markops-engagement-worker .
docker run --rm -p 3000:3000 -v worker-data:/data --env-file .env markops-engagement-worker
```

The container starts Xvfb, x11vnc, websockify/noVNC, and the worker. SIGTERM/SIGINT closes active browser contexts before exit.

## Railway deployment

1. Create a **separate** Railway service from this repository; no Docker Compose is required.
2. Add a Railway Volume mounted exactly at `/data`.
3. Add variables: `WORKER_SECRET` (long random secret), `PUBLIC_BASE_URL` (the generated Railway HTTPS domain), `PROFILE_ROOT=/data/accounts`, `MAX_ACTIVE_BROWSERS=2`, `SESSION_TIMEOUT_SECONDS=900`, `FACEBOOK_ALLOWED_HOSTS=facebook.com,www.facebook.com,m.facebook.com`, and optionally `MARKOPS_URL`.
4. Railway supplies `PORT`; do not hard-code it. Deploy with the included `Dockerfile` and `railway.toml`.
5. Configure Railway health check path `/health`. It is intentionally public; every worker/API endpoint is protected by `X-Worker-Secret`.

Profiles are persisted at `/data/accounts/{accountId}`. Approval idempotency records live under `/data/accounts/.approvals` and contain hashes and state only—not comment text or browser data.

## Viewer embedding

`login/start`, manual intervention, and unknown outcomes return a short-lived-session `viewerUrl`. Embed it in MarkOps in an iframe or open it in a new tab. It contains an opaque session viewer token, never `WORKER_SECRET`; noVNC WebSockets validate that token through the same Railway domain. Treat the viewer URL as sensitive and do not log it.

## API sequence

All API calls except `GET /health` require `X-Worker-Secret`.

```powershell
$h=@{'X-Worker-Secret'=$env:WORKER_SECRET}
# 1. Start manual login
$login=Invoke-RestMethod -Method Post -Uri "$env:PUBLIC_BASE_URL/accounts/account-1/login/start" -Headers $h
# 2. Open $login.viewerUrl in MarkOps/browser and complete Facebook login yourself.
# 3. Persist the verified session and close Chromium
Invoke-RestMethod -Method Post -Uri "$env:PUBLIC_BASE_URL/accounts/account-1/session/continue" -Headers $h
# 4. Inspect visible post information
Invoke-RestMethod -Method Post -Uri "$env:PUBLIC_BASE_URL/accounts/account-1/posts/inspect" -Headers $h -ContentType application/json -Body '{"postUrl":"https://www.facebook.com/example/posts/123"}'
# 5. Execute exactly one approved action
Invoke-RestMethod -Method Post -Uri "$env:PUBLIC_BASE_URL/accounts/account-1/posts/execute" -Headers $h -ContentType application/json -Body '{"postUrl":"https://www.facebook.com/example/posts/123","action":"react","reaction":"like","approvalId":"approval-000001"}'
```

curl equivalent:

```bash
curl -X POST "$PUBLIC_BASE_URL/accounts/account-1/posts/inspect" -H "X-Worker-Secret: $WORKER_SECRET" -H 'Content-Type: application/json' -d '{"postUrl":"https://www.facebook.com/example/posts/123"}'
```

## Behaviour and limitations

- `GET /accounts` lists stored profile directories; account IDs allow only letters, digits, `_`, and `-`.
- Browser profiles have atomic per-account locks and global `MAX_ACTIVE_BROWSERS` capacity.
- Inspection reads rendered, visible text only and never stores raw Facebook HTML.
- Actions require unique `approvalId`; duplicate identical approvals return the recorded result. Comment content is used only for the requested visible UI action and is never logged or persisted by the worker.
- If login, consent, CAPTCHA, 2FA, checkpoint, session expiry, or another security screen is detected, the worker returns `manual_intervention_required`, keeps the browser open, and resumes the pending approved action only after `session/continue`.
- Facebook UI changes can make a visible selector unconfirmable. The worker returns `outcome_unknown` and never auto-retries comments in that case.
