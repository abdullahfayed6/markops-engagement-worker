# MarkOps Engagement Worker — Integration Guide

This document is the integration contract between the main MarkOps application and `markops-engagement-worker`.

## 1. Responsibilities

The worker owns:

- persistent Chromium profiles for Facebook accounts;
- manual Facebook login, 2FA, CAPTCHA, checkpoint, and consent takeover;
- reading the visible text and publisher name of one linked Facebook post;
- executing exactly one approved reaction or comment;
- action idempotency and browser/profile locking.

The main MarkOps application owns:

- its users, account records, permissions, and approval UI;
- AI generation of comment suggestions;
- showing the exact proposed comment to a user and recording approval;
- generating a globally unique `approvalId` for every approved intent;
- calling the worker from its backend only.

The worker never generates, rewrites, translates, or moderates comment text.

## 2. Connection settings

Configure these secrets in the MarkOps backend:

```env
ENGAGEMENT_WORKER_URL=https://markops-engagement-worker-production.up.railway.app
ENGAGEMENT_WORKER_SECRET=<same value as WORKER_SECRET on the worker>
```

Every endpoint except `GET /health` requires:

```http
X-Worker-Secret: <WORKER_SECRET>
```

Calls containing `X-Worker-Secret` must originate from the MarkOps backend. Never expose this header or secret to browser JavaScript. The worker compares it in constant time.

Optionally send a trace ID:

```http
X-Request-Id: <markops-request-id>
```

The worker returns `X-Request-Id` on the response and uses it in privacy-safe structured logs.

## 3. Identifiers and validation

### `accountId`

Use the stable MarkOps Facebook-account record ID, not an email address or password. It must match:

```regex
^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$
```

Each value maps to one profile:

```text
/data/accounts/{accountId}
```

### `postUrl`

Must be HTTPS and use a hostname configured in `FACEBOOK_ALLOWED_HOSTS`. Share links such as this are supported:

```text
https://www.facebook.com/share/p/...
```

The worker follows Facebook redirects and targets the post identified by the resolved publisher/post controls, not the first post displayed on the page.

### `approvalId`

Must be 8–128 URL-safe characters:

```regex
^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$
```

Recommended value:

```text
engagement_<database-approval-uuid>
```

It is an idempotency key bound to the account, post URL, action, reaction, and exact comment text. Reusing it for different input returns `APPROVAL_ID_CONFLICT`. Never reuse an `approvalId` to request a new action.

## 4. Common response

Account/session/action endpoints use this envelope:

```json
{
  "accountId": "facebook_account_123",
  "sessionId": null,
  "status": "completed",
  "viewerUrl": null,
  "loggedIn": true,
  "errorCode": null,
  "errorMessage": null,
  "result": {}
}
```

`result` depends on the endpoint. `viewerUrl` is non-null only while a browser is intentionally kept alive.

## 5. Status handling

| Status | Meaning | MarkOps behaviour |
|---|---|---|
| `idle` | No active browser session | Normal inactive state |
| `starting` | Browser startup is in progress | Show loading state |
| `browser_ready` | Interactive browser is ready | Open or embed `viewerUrl` |
| `manual_intervention_required` | Login/security/manual step required | Show `viewerUrl` and Continue/Cancel controls |
| `running` | Approved action is being processed | Disable duplicate submission |
| `completed` | Operation confirmed | Save success state |
| `failed` | Operation failed before a safe outcome | Show `errorCode`; retry only after review |
| `cancelled` | User cancelled manual session | Return UI to idle state |
| `timed_out` | Browser session exceeded timeout | Start again if still needed |
| `session_expired` | Facebook session is not usable | Start manual login |
| `outcome_unknown` | Worker cannot prove whether an action happened | Never automatically retry, especially comments |

## 6. Endpoints

### `GET /health`

Public Railway health check.

Response:

```json
{ "status": "ok" }
```

### `GET /accounts`

Lists stored account profiles.

```json
{
  "accountIds": ["facebook_account_123"],
  "maxActiveBrowsers": 2
}
```

### `POST /accounts/:accountId/login/start`

Creates/opens the persistent profile and launches an interactive Facebook login session.

Request body: none.

Typical response:

```json
{
  "accountId": "facebook_account_123",
  "sessionId": "f36fa618-7f21-46ca-90c8-3c461d80242f",
  "status": "manual_intervention_required",
  "viewerUrl": "https://worker.example/novnc/vnc.html?...",
  "loggedIn": false,
  "errorCode": null,
  "errorMessage": null
}
```

If the account already has an active session, the worker returns HTTP `409` with `SESSION_ALREADY_ACTIVE` or `ACCOUNT_BUSY`. If global capacity is full, it returns HTTP `429` with `BROWSER_CAPACITY_REACHED`.

### `GET /accounts/:accountId/session`

Gets the in-memory browser-session state for an account. It does not launch Chromium.

Use for UI refresh/polling while a manual session is open. A returned `idle` state means there is no active browser session; it does not prove the saved Facebook profile is logged in.

### `POST /accounts/:accountId/session/continue`

Called after the user finishes manual work in noVNC.

- For a login-only session: verifies login, closes Chromium, and persists the profile.
- For a pending approved action: verifies login/security state, resumes the original action using its original immutable input, then returns the action result.
- If manual work is incomplete: returns `manual_intervention_required` and keeps the browser open.

Request body: none.

### `POST /accounts/:accountId/session/cancel`

Closes the active browser, releases the account lock, and cancels any pending manual flow. It does not delete the saved account profile.

Request body: none.

### `POST /accounts/:accountId/session/validate`

Restarts Chromium using the saved profile and checks whether Facebook login is usable.

- Valid session: `status=completed`, `loggedIn=true`, browser closes.
- Login/checkpoint required: `status=manual_intervention_required`, `viewerUrl` is returned and browser stays open.

Request body: none.

### `DELETE /accounts/:accountId`

Deletes the persistent account profile. The account must not have an active lock/session. This is destructive and requires Facebook login again if recreated.

### `POST /accounts/:accountId/posts/inspect`

Reads only the linked post's visible publisher name and visible post text. It does not return HTML, comments, image data, reaction counts, or private browser data.

Request:

```json
{
  "postUrl": "https://www.facebook.com/share/p/1DAxet5EaT/"
}
```

Successful `result`:

```json
{
  "visiblePostText": "Visible text of the linked post",
  "visibleAuthorName": "Publisher name"
}
```

Use these two values as AI context. Do not send browser profile data, cookies, or the worker secret to the AI.

### `POST /accounts/:accountId/posts/execute`

Executes one explicitly approved action. Normal execution is headless. If Facebook requires manual verification, the response includes `viewerUrl` and the browser stays open.

#### Reaction request

```json
{
  "postUrl": "https://www.facebook.com/share/p/1DAxet5EaT/",
  "action": "react",
  "reaction": "like",
  "approvalId": "engagement_9d73b899-c47f-4ec4-9978-148bd540d601"
}
```

Supported reactions:

```text
like, love, care, haha, wow, sad, angry
```

Successful `result`:

```json
{
  "approvalId": "engagement_9d73b899-c47f-4ec4-9978-148bd540d601",
  "previousState": null,
  "finalState": "like",
  "diagnostic": "confirmed_from_target_post"
}
```

If the requested reaction is already confirmed, the worker returns completed with `diagnostic=already_active` and does not click again.

#### Comment request

```json
{
  "postUrl": "https://www.facebook.com/share/p/1DAxet5EaT/",
  "action": "comment",
  "comment": "The exact user-approved comment",
  "approvalId": "engagement_f721f98b-7dbf-4ce0-96f3-f2d1c7b1583b"
}
```

The worker publishes the exact `comment` string without changing whitespace, language, punctuation, or emoji. It never logs or persists the comment text in the approval record.

Successful `result`:

```json
{
  "approvalId": "engagement_f721f98b-7dbf-4ce0-96f3-f2d1c7b1583b",
  "previousState": null,
  "finalState": "comment_present",
  "diagnostic": "comment_visible_on_target_post"
}
```

## 7. Recommended MarkOps workflow

### Account connection

1. Create a MarkOps account record and derive a valid stable worker `accountId`.
2. Call `login/start` from the MarkOps backend.
3. Send `viewerUrl` to the authorized MarkOps UI.
4. Embed it or open it in a new tab.
5. User manually completes Facebook login/security checks.
6. UI calls the MarkOps backend Continue route.
7. Backend calls worker `session/continue`.
8. Save the account as connected only when `loggedIn=true` and `status=completed`.

### AI comment approval and execution

1. Backend calls `posts/inspect`.
2. Backend sends only `visibleAuthorName` and `visiblePostText` to the AI.
3. AI returns a proposed comment to MarkOps, not to the worker.
4. MarkOps displays the exact proposal to the user.
5. User explicitly approves it.
6. MarkOps stores an immutable approval record containing account, post URL, exact text, and UUID.
7. Backend calls `posts/execute` using that approval UUID as `approvalId`.
8. If `completed`, store success.
9. If `manual_intervention_required`, show `viewerUrl`; after the user finishes, call `session/continue`. Do not construct a second execute request.
10. If `outcome_unknown`, flag for human review and do not automatically retry.

## 8. noVNC embedding

`viewerUrl` contains an opaque, session-specific viewer token. It does not contain `WORKER_SECRET`.

```html
<iframe
  src="WORKER_VIEWER_URL"
  title="Facebook manual verification"
  allow="clipboard-read; clipboard-write"
  style="width:100%;height:800px;border:0"
></iframe>
```

Rules:

- show it only to an authorized MarkOps user;
- do not persist or log it;
- do not append `WORKER_SECRET`;
- replace/remove the iframe when the session completes, is cancelled, or times out;
- on local Windows development, use the directly opened Chromium window; noVNC is started by Docker on Railway.

## 9. TypeScript backend client

```ts
type WorkerStatus =
  | 'idle' | 'starting' | 'browser_ready'
  | 'manual_intervention_required' | 'running' | 'completed'
  | 'failed' | 'cancelled' | 'timed_out'
  | 'session_expired' | 'outcome_unknown';

export async function callWorker<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${process.env.ENGAGEMENT_WORKER_URL}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      'X-Worker-Secret': process.env.ENGAGEMENT_WORKER_SECRET!,
      'X-Request-Id': crypto.randomUUID(),
      ...init.headers,
    },
    signal: AbortSignal.timeout(120_000),
  });

  const payload = await response.json();
  if (!response.ok) {
    throw Object.assign(new Error(payload.errorMessage ?? 'Worker request failed'), {
      status: response.status,
      code: payload.errorCode,
      payload,
    });
  }
  return payload as T;
}
```

Do not apply short generic HTTP timeouts to browser-starting or Facebook-navigation endpoints. A backend timeout does not prove the action failed; query the account session and respect idempotency before deciding what to do.

## 10. Error and retry policy

| HTTP / error | Meaning | Retry rule |
|---|---|---|
| `400 INVALID_ACCOUNT_ID` | Unsafe/invalid account ID | Fix input; do not retry unchanged |
| `400 INVALID_POST_URL` | URL is not an allowed HTTPS Facebook URL | Fix input |
| `400 INVALID_APPROVAL_ID` | Approval ID format invalid | Generate a valid ID |
| `400 INVALID_REQUEST` | Body schema invalid | Fix input |
| `409 SESSION_ALREADY_ACTIVE` | Account already has an active session | Read `/session`; do not open another |
| `409 ACCOUNT_BUSY` | Persistent profile lock is held | Wait/review active worker instance |
| `409 APPROVAL_ID_CONFLICT` | Same approval ID used for different intent | Security/integration error; never overwrite |
| `429 BROWSER_CAPACITY_REACHED` | `MAX_ACTIVE_BROWSERS` reached | Retry later with bounded backoff |
| `MANUAL_INTERVENTION_REQUIRED` | Facebook needs a human | Show viewer; Continue after completion |
| `TARGET_POST_NOT_FOUND` | Linked post UI/content could not be identified | Human review; Facebook UI or permissions may differ |
| `OUTCOME_UNKNOWN` | Final action state could not be proven | Never auto-retry comments; human review |
| `500 INTERNAL_ERROR` | Unexpected worker failure | Use request ID to investigate before retrying an action |

## 11. Railway production checklist

- Deploy as a separate Railway service using the repository Dockerfile.
- Attach a Railway Volume mounted exactly at `/data`.
- Set `PROFILE_ROOT=/data/accounts`.
- Set `PUBLIC_BASE_URL` to the worker's public HTTPS domain.
- Set the same long `WORKER_SECRET` in the worker and MarkOps backend secret stores.
- Set `MAX_ACTIVE_BROWSERS=1`. The current container has one Xvfb/noVNC desktop; multiple stored accounts are supported sequentially, but simultaneous headed sessions would share that desktop.
- Configure health path `/health`.
- Do not use multiple Railway replicas with a single shared profile unless profile locking/storage semantics have been explicitly validated.
- Never expose the worker secret, Facebook cookies, profile files, or approval records to the frontend or AI.

## 12. OpenAPI contract

The machine-readable API contract is [`openapi.yaml`](./openapi.yaml). Keep it updated whenever an endpoint, status, request body, or response field changes.
