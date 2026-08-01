import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import http from 'node:http';
import express, { NextFunction, Request, Response } from 'express';
import httpProxy from 'http-proxy';
import { z } from 'zod';
import { AccountLockManager, assertAccountId } from './account-lock-manager.js';
import { config } from './config.js';
import { isAuthorized, assertFacebookUrl, assertInstagramUrl, assertTikTokUrl, assertXUrl } from './security.js';
import { SessionManager } from './session-manager.js';
import { InstagramSessionManager } from './instagram-session-manager.js';
import { TikTokSessionManager } from './tiktok-session-manager.js';
import { XSessionManager } from './x-session-manager.js';
import { ApiError } from './types.js';

// ── Facebook action schema ──────────────────────────────────────────────────
const facebookActionSchema = z.discriminatedUnion('action', [
  z.object({ postUrl: z.string(), action: z.literal('react'), reaction: z.enum(['like','love','care','haha','wow','sad','angry']), approvalId: z.string() }),
  z.object({ postUrl: z.string(), action: z.literal('comment'), comment: z.string().min(1).max(5000), approvalId: z.string() }),
]);

// ── Instagram / TikTok action schema (like + comment only) ─────────────────
const simpleActionSchema = z.discriminatedUnion('action', [
  z.object({ postUrl: z.string(), action: z.literal('like'), approvalId: z.string() }),
  z.object({ postUrl: z.string(), action: z.literal('comment'), comment: z.string().min(1).max(5000), approvalId: z.string() }),
]);

// ── X action schema (like + reply) ─────────────────────────────────────────
const xActionSchema = z.discriminatedUnion('action', [
  z.object({ postUrl: z.string(), action: z.literal('like'), approvalId: z.string() }),
  z.object({ postUrl: z.string(), action: z.literal('reply'), comment: z.string().min(1).max(280), approvalId: z.string() }),
]);

// ── Session options (proxy + cookies) ─────────────────────────────────────
const sessionOptionsSchema = z.object({
  proxy: z.string().url().nullish(),
  cookies: z.array(z.object({
    name: z.string(),
    value: z.string(),
    domain: z.string().optional(),
    path: z.string().optional(),
  }).passthrough()).nullish(),
});

export function createApp() {
  const app = express();
  const proxy = httpProxy.createProxyServer({ target: 'http://127.0.0.1:6080', ws: true });

  // ── Platform session managers ────────────────────────────────────────────
  const facebookLocks   = new AccountLockManager(config.PROFILE_ROOT);
  const instagramLocks  = new AccountLockManager(config.INSTAGRAM_PROFILE_ROOT);
  const tiktokLocks     = new AccountLockManager(config.TIKTOK_PROFILE_ROOT);
  const xLocks          = new AccountLockManager(config.X_PROFILE_ROOT);

  const sessions          = new SessionManager(facebookLocks);
  const instagramSessions = new InstagramSessionManager(instagramLocks);
  const tiktokSessions    = new TikTokSessionManager(tiktokLocks);
  const xSessions         = new XSessionManager(xLocks);

  app.disable('x-powered-by');
  app.use(express.json({ limit: '32kb' }));

  // Request ID logging middleware
  app.use((req, res, next) => {
    const requestId = req.header('X-Request-Id')?.slice(0, 128) || randomUUID();
    res.setHeader('X-Request-Id', requestId);
    res.locals.requestId = requestId;
    res.on('finish', () => console.log(JSON.stringify({ level: 'info', event: 'request_complete', requestId, method: req.method, statusCode: res.statusCode })));
    next();
  });

  // Health check (public)
  app.get('/health', (_req, res) => res.json({ status: 'ok' }));

  // ── noVNC viewer: shared across all platforms ────────────────────────────
  // All platform session managers use the same noVNC instance.
  // canView checks across all managers.
  const canViewAny = (token: string | undefined) =>
    sessions.canView(token) ||
    instagramSessions.canView(token) ||
    tiktokSessions.canView(token) ||
    xSessions.canView(token);

  app.use('/novnc', (req, res) => {
    const isEntryPage = req.path === '/vnc.html' || req.path === '/' || req.path === '';
    if (isEntryPage) {
      const token = typeof req.query.token === 'string' ? req.query.token : undefined;
      if (!canViewAny(token)) return res.status(401).end();
    }
    return proxy.web(req, res);
  });

  // Auth guard for all API routes
  app.use((req, res, next) =>
    isAuthorized(req.header('X-Worker-Secret')) ? next() : res.status(401).json(errorBody('', res.locals.requestId, 'UNAUTHORIZED', 'Missing or invalid X-Worker-Secret.'))
  );

  const account = (req: Request) => {
    const value = req.params.accountId;
    if (Array.isArray(value) || !value) throw new ApiError('INVALID_ACCOUNT_ID', 'accountId must be a single path value.');
    return assertAccountId(value);
  };

  // ── Facebook accounts listing ────────────────────────────────────────────
  app.get('/accounts', async (_req, res) => {
    let accountIds: string[] = [];
    try {
      accountIds = (await readdir(config.PROFILE_ROOT, { withFileTypes: true }))
        .filter((x) => x.isDirectory() && !x.name.startsWith('.'))
        .map((x) => x.name)
        .filter((x) => { try { assertAccountId(x); return true; } catch { return false; } });
    } catch { /* empty */ }
    res.json({ accountIds, maxActiveBrowsers: config.MAX_ACTIVE_BROWSERS });
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // FACEBOOK routes (unchanged prefix — backwards compatible)
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  app.post('/accounts/:accountId/login/start',    async (req, res) => { const { proxy: p, cookies } = sessionOptionsSchema.parse(req.body); res.status(201).json(await sessions.start(account(req), p ?? undefined, cookies ?? undefined)); });
  app.get('/accounts/:accountId/session',         async (req, res) => res.json(await sessions.get(account(req))));
  app.post('/accounts/:accountId/session/continue', async (req, res) => res.json(await sessions.continue(account(req))));
  app.post('/accounts/:accountId/session/cancel',   async (req, res) => res.json(await sessions.cancel(account(req))));
  app.post('/accounts/:accountId/session/validate', async (req, res) => { const { proxy: p, cookies } = sessionOptionsSchema.parse(req.body); res.json(await sessions.validate(account(req), p ?? undefined, cookies ?? undefined)); });
  app.delete('/accounts/:accountId',              async (req, res) => { const id = account(req); await facebookLocks.removeProfile(id); res.json({ accountId: id, sessionId: null, status: 'completed', viewerUrl: null, loggedIn: false, errorCode: null, errorMessage: null }); });
  app.post('/accounts/:accountId/posts/inspect',  async (req, res) => { const postUrl = z.object({ postUrl: z.string() }).parse(req.body).postUrl; res.json(await sessions.inspect(account(req), assertFacebookUrl(postUrl).toString())); });
  app.post('/accounts/:accountId/posts/execute',  async (req, res) => { const action = facebookActionSchema.parse(req.body); action.postUrl = assertFacebookUrl(action.postUrl).toString(); res.json(await sessions.execute(account(req), action)); });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // INSTAGRAM routes — /instagram/accounts/:accountId/...
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  app.get('/instagram/accounts', async (_req, res) => {
    let accountIds: string[] = [];
    try {
      accountIds = (await readdir(config.INSTAGRAM_PROFILE_ROOT, { withFileTypes: true }))
        .filter((x) => x.isDirectory() && !x.name.startsWith('.'))
        .map((x) => x.name)
        .filter((x) => { try { assertAccountId(x); return true; } catch { return false; } });
    } catch { /* empty */ }
    res.json({ accountIds, maxActiveBrowsers: config.MAX_ACTIVE_BROWSERS });
  });

  app.post('/instagram/accounts/:accountId/login/start',      async (req, res) => { const { proxy: p, cookies } = sessionOptionsSchema.parse(req.body); res.status(201).json(await instagramSessions.start(account(req), p ?? undefined, cookies ?? undefined)); });
  app.get('/instagram/accounts/:accountId/session',           async (req, res) => res.json(await instagramSessions.get(account(req))));
  app.post('/instagram/accounts/:accountId/session/continue', async (req, res) => res.json(await instagramSessions.continue(account(req))));
  app.post('/instagram/accounts/:accountId/session/cancel',   async (req, res) => res.json(await instagramSessions.cancel(account(req))));
  app.post('/instagram/accounts/:accountId/session/validate', async (req, res) => { const { proxy: p, cookies } = sessionOptionsSchema.parse(req.body); res.json(await instagramSessions.validate(account(req), p ?? undefined, cookies ?? undefined)); });
  app.delete('/instagram/accounts/:accountId',                async (req, res) => { const id = account(req); await instagramLocks.removeProfile(id); res.json({ accountId: id, sessionId: null, status: 'completed', viewerUrl: null, loggedIn: false, errorCode: null, errorMessage: null }); });
  app.post('/instagram/accounts/:accountId/posts/inspect',    async (req, res) => { const postUrl = z.object({ postUrl: z.string() }).parse(req.body).postUrl; res.json(await instagramSessions.inspect(account(req), assertInstagramUrl(postUrl).toString())); });
  app.post('/instagram/accounts/:accountId/posts/execute',    async (req, res) => { const action = simpleActionSchema.parse(req.body); action.postUrl = assertInstagramUrl(action.postUrl).toString(); res.json(await instagramSessions.execute(account(req), action)); });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // TIKTOK routes — /tiktok/accounts/:accountId/...
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  app.get('/tiktok/accounts', async (_req, res) => {
    let accountIds: string[] = [];
    try {
      accountIds = (await readdir(config.TIKTOK_PROFILE_ROOT, { withFileTypes: true }))
        .filter((x) => x.isDirectory() && !x.name.startsWith('.'))
        .map((x) => x.name)
        .filter((x) => { try { assertAccountId(x); return true; } catch { return false; } });
    } catch { /* empty */ }
    res.json({ accountIds, maxActiveBrowsers: config.MAX_ACTIVE_BROWSERS });
  });

  app.post('/tiktok/accounts/:accountId/login/start',      async (req, res) => { const { proxy: p, cookies } = sessionOptionsSchema.parse(req.body); res.status(201).json(await tiktokSessions.start(account(req), p ?? undefined, cookies ?? undefined)); });
  app.get('/tiktok/accounts/:accountId/session',           async (req, res) => res.json(await tiktokSessions.get(account(req))));
  app.post('/tiktok/accounts/:accountId/session/continue', async (req, res) => res.json(await tiktokSessions.continue(account(req))));
  app.post('/tiktok/accounts/:accountId/session/cancel',   async (req, res) => res.json(await tiktokSessions.cancel(account(req))));
  app.post('/tiktok/accounts/:accountId/session/validate', async (req, res) => { const { proxy: p, cookies } = sessionOptionsSchema.parse(req.body); res.json(await tiktokSessions.validate(account(req), p ?? undefined, cookies ?? undefined)); });
  app.delete('/tiktok/accounts/:accountId',                async (req, res) => { const id = account(req); await tiktokLocks.removeProfile(id); res.json({ accountId: id, sessionId: null, status: 'completed', viewerUrl: null, loggedIn: false, errorCode: null, errorMessage: null }); });
  app.post('/tiktok/accounts/:accountId/posts/inspect',    async (req, res) => { const postUrl = z.object({ postUrl: z.string() }).parse(req.body).postUrl; res.json(await tiktokSessions.inspect(account(req), assertTikTokUrl(postUrl).toString())); });
  app.post('/tiktok/accounts/:accountId/posts/execute',    async (req, res) => { const action = simpleActionSchema.parse(req.body); action.postUrl = assertTikTokUrl(action.postUrl).toString(); res.json(await tiktokSessions.execute(account(req), action)); });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // X (Twitter) routes — /x/accounts/:accountId/...
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  app.get('/x/accounts', async (_req, res) => {
    let accountIds: string[] = [];
    try {
      accountIds = (await readdir(config.X_PROFILE_ROOT, { withFileTypes: true }))
        .filter((x) => x.isDirectory() && !x.name.startsWith('.'))
        .map((x) => x.name)
        .filter((x) => { try { assertAccountId(x); return true; } catch { return false; } });
    } catch { /* empty */ }
    res.json({ accountIds, maxActiveBrowsers: config.MAX_ACTIVE_BROWSERS });
  });

  app.post('/x/accounts/:accountId/login/start',      async (req, res) => { const { proxy: p, cookies } = sessionOptionsSchema.parse(req.body); res.status(201).json(await xSessions.start(account(req), p ?? undefined, cookies ?? undefined)); });
  app.get('/x/accounts/:accountId/session',           async (req, res) => res.json(await xSessions.get(account(req))));
  app.post('/x/accounts/:accountId/session/continue', async (req, res) => res.json(await xSessions.continue(account(req))));
  app.post('/x/accounts/:accountId/session/cancel',   async (req, res) => res.json(await xSessions.cancel(account(req))));
  app.post('/x/accounts/:accountId/session/validate', async (req, res) => { const { proxy: p, cookies } = sessionOptionsSchema.parse(req.body); res.json(await xSessions.validate(account(req), p ?? undefined, cookies ?? undefined)); });
  app.delete('/x/accounts/:accountId',                async (req, res) => { const id = account(req); await xLocks.removeProfile(id); res.json({ accountId: id, sessionId: null, status: 'completed', viewerUrl: null, loggedIn: false, errorCode: null, errorMessage: null }); });
  app.post('/x/accounts/:accountId/posts/inspect',    async (req, res) => { const postUrl = z.object({ postUrl: z.string() }).parse(req.body).postUrl; res.json(await xSessions.inspect(account(req), assertXUrl(postUrl).toString())); });
  app.post('/x/accounts/:accountId/posts/execute',    async (req, res) => { const action = xActionSchema.parse(req.body); action.postUrl = assertXUrl(action.postUrl).toString(); res.json(await xSessions.execute(account(req), action)); });

  // ── Global error handler ────────────────────────────────────────────────
  app.use((error: unknown, req: Request, res: Response, _next: NextFunction) => {
    const e = error instanceof ApiError ? error : new ApiError(
      error instanceof z.ZodError ? 'INVALID_REQUEST' : 'INTERNAL_ERROR',
      error instanceof z.ZodError ? 'Request validation failed.' : 'Unexpected internal error.',
      error instanceof z.ZodError ? 400 : 500
    );
    console.error(JSON.stringify({ level: 'error', event: 'request_failed', requestId: res.locals.requestId, errorCode: e.code, errorType: error instanceof Error ? error.name : 'unknown' }));
    const raw = req.params.accountId;
    const id = typeof raw === 'string' ? raw : '';
    res.status(e.statusCode).json(errorBody(id, res.locals.requestId, e.code, e.message));
  });

  return { app, sessions, instagramSessions, tiktokSessions, xSessions, proxy };
}

function errorBody(accountId: string, requestId: string, errorCode: string, errorMessage: string) {
  return { accountId, sessionId: null, status: 'failed', viewerUrl: null, loggedIn: false, errorCode, errorMessage, requestId };
}

const { app, sessions, instagramSessions, tiktokSessions, xSessions, proxy } = createApp();
const server = http.createServer(app);

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', 'http://local');
  const token = url.searchParams.get('token') ?? undefined;
  const canView = sessions.canView(token) || instagramSessions.canView(token) || tiktokSessions.canView(token) || xSessions.canView(token);
  if (!url.pathname.startsWith('/novnc/') || !canView) return socket.destroy();
  req.url = req.url?.replace(/^\/novnc/, '');
  proxy.ws(req, socket, head);
});

server.listen(config.PORT, '0.0.0.0', () => console.log(JSON.stringify({ level: 'info', event: 'server_started', port: config.PORT })));

const stop = () => void Promise.all([
  sessions.shutdown(),
  instagramSessions.shutdown(),
  tiktokSessions.shutdown(),
  xSessions.shutdown(),
]).finally(() => server.close(() => process.exit(0)));

process.on('SIGINT', stop);
process.on('SIGTERM', stop);
