# MarkOps Engagement Worker

A separate Node.js/TypeScript worker for manually establishing and preserving isolated Facebook browser sessions. This phase intentionally has **no Like or Comment automation**. It never stores passwords, and it does not solve or bypass CAPTCHAs, checkpoints, 2FA, or any other Facebook security challenge.

## What it does

- Creates one persistent Chromium profile per valid account ID at `/data/accounts/{accountId}`.
- Uses atomic per-account lock files, so a profile cannot be opened by two worker browser processes at once.
- Enforces `MAX_ACTIVE_BROWSERS` globally (default `1`).
- Launches headed Chromium on Xvfb and exposes the active display through noVNC.
- Lets the user complete all Facebook verification manually, then checks for Facebook's authenticated session cookies before saving/closing the profile.
- Times out abandoned browser sessions and closes Chromium before releasing the lock.

`accountId` must match `^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$`; paths are constructed only after this validation.

## Railway deployment

1. Create a new Railway project and deploy this repository as a **separate service**. Do not add it to the MarkOps application service.
2. Add a Railway Volume mounted at `/data`. This is required; without it, account sessions are lost on each deployment.
3. Add these Railway variables (use a long random value for `WORKER_SECRET`):

   ```text
   PORT=3000
   WORKER_SECRET=<at-least-24-character-secret>
   PROFILE_ROOT=/data/accounts
   MAX_ACTIVE_BROWSERS=1
   SESSION_TIMEOUT_SECONDS=900
   PUBLIC_BASE_URL=https://<the-public-worker-domain>
   MARKOPS_URL=https://<your-markops-domain>
   ```

4. Generate a Railway public domain, then set `PUBLIC_BASE_URL` to that exact HTTPS URL and redeploy. The `viewerUrl` response uses this value.
5. Railway supplies `PORT` at runtime; the example value is only for local use. The server listens on `0.0.0.0`.
6. The Docker image includes an internal Docker health check that calls `GET /health` with the required secret header. Do not configure Railway's unauthenticated HTTP health-check path: Railway health checks cannot add `X-Worker-Secret`, while this worker intentionally protects every endpoint.

## Local run

Copy `.env.example` to `.env`, set real values, then run:

```bash
npm install
npm run dev
```

For headed Chromium locally, run under an X server (Linux) or use Docker. The production Docker entrypoint starts Xvfb, x11vnc, and noVNC automatically.

## API

Every endpoint requires:

```http
X-Worker-Secret: <WORKER_SECRET>
```

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/health` | Authenticated liveness response |
| POST | `/accounts/:accountId/login/start` | Start a manual, headed Facebook-login session |
| GET | `/accounts/:accountId/session` | Inspect an active session |
| POST | `/accounts/:accountId/session/continue` | Verify login cookies, persist profile, and close browser |
| POST | `/accounts/:accountId/session/cancel` | Close browser without login confirmation |
| POST | `/accounts/:accountId/session/validate` | Check saved session cookies safely |
| DELETE | `/accounts/:accountId` | Delete an inactive account's profile |

All account endpoints return this shape:

```json
{
  "accountId": "example-account",
  "sessionId": "uuid-or-null",
  "status": "active",
  "viewerUrl": "https://worker.example/novnc/vnc.html?...",
  "loggedIn": false,
  "errorCode": null,
  "errorMessage": null
}
```

Start a login, then open the returned `viewerUrl` inside MarkOps (an iframe or a new tab). noVNC's WebSocket handshake also requires `X-Worker-Secret`; MarkOps should attach it when embedding/proxying the viewer. Complete login/2FA/CAPTCHA/checkpoints yourself in the browser, then call `/session/continue`. If login cannot be confirmed, the browser stays open so the user can resolve it manually.

## Security and operational notes

- Never place Facebook passwords in MarkOps or this worker. Login state is limited to Chromium's encrypted profile files on the mounted volume.
- noVNC itself has no separate password because access is gated by the worker-secret header. Restrict the worker domain to MarkOps or place it behind an authenticated MarkOps reverse proxy before broad production use.
- The on-disk account lock is intentionally retained if the worker crashes rather than risking concurrent access to a Chromium profile. Restart/recovery should inspect the lock before removing it; do not delete a lock while a worker may still be running.
- A session timeout is not a Facebook logout. It safely closes the browser and retains the profile if Facebook has already set its session cookies.
