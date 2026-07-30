import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import http from 'node:http';
import express, { NextFunction, Request, Response } from 'express';
import httpProxy from 'http-proxy';
import { z } from 'zod';
import { AccountLockManager, assertAccountId } from './account-lock-manager.js';
import { config } from './config.js';
import { isAuthorized, assertFacebookUrl } from './security.js';
import { SessionManager } from './session-manager.js';
import { ApiError } from './types.js';

const actionSchema = z.discriminatedUnion('action', [z.object({ postUrl: z.string(), action: z.literal('react'), reaction: z.enum(['like','love','care','haha','wow','sad','angry']), approvalId: z.string() }), z.object({ postUrl: z.string(), action: z.literal('comment'), comment: z.string().min(1).max(5000), approvalId: z.string() })]);
export function createApp() {
  const app = express(); const locks = new AccountLockManager(config.PROFILE_ROOT); const sessions = new SessionManager(locks); const proxy = httpProxy.createProxyServer({ target: 'http://127.0.0.1:6080', ws: true });
  app.disable('x-powered-by'); app.use(express.json({ limit: '32kb' }));
  app.use((req, res, next) => { const requestId = req.header('X-Request-Id')?.slice(0, 128) || randomUUID(); res.setHeader('X-Request-Id', requestId); res.locals.requestId = requestId; res.on('finish', () => console.log(JSON.stringify({ level: 'info', event: 'request_complete', requestId, method: req.method, statusCode: res.statusCode }))); next(); });
  app.get('/health', (_req, res) => res.json({ status: 'ok' }));
  // noVNC viewer: enforce token only on the main entry (vnc.html / root).
  // Static assets (JS, CSS, sounds, images) are fetched by the browser without
  // carrying the session token in their URL, so they must pass through freely.
  // The WebSocket upgrade (websockify) is guarded separately in server.on('upgrade').
  app.use('/novnc', (req, res) => {
    const isEntryPage = req.path === '/vnc.html' || req.path === '/' || req.path === '';
    if (isEntryPage) {
      const token = typeof req.query.token === 'string' ? req.query.token : undefined;
      if (!sessions.canView(token)) return res.status(401).end();
    }
    return proxy.web(req, res);
  });

  app.use((req, res, next) => isAuthorized(req.header('X-Worker-Secret')) ? next() : res.status(401).json(errorBody('', res.locals.requestId, 'UNAUTHORIZED', 'Missing or invalid X-Worker-Secret.')));
  const account = (req: Request) => { const value = req.params.accountId; if (Array.isArray(value) || !value) throw new ApiError('INVALID_ACCOUNT_ID', 'accountId must be a single path value.'); return assertAccountId(value); };
  app.get('/accounts', async (_req, res) => { let accountIds: string[] = []; try { accountIds = (await readdir(config.PROFILE_ROOT, { withFileTypes: true })).filter((x) => x.isDirectory() && !x.name.startsWith('.')).map((x) => x.name).filter((x) => { try { assertAccountId(x); return true; } catch { return false; } }); } catch { /* empty */ } res.json({ accountIds, maxActiveBrowsers: config.MAX_ACTIVE_BROWSERS }); });
  const sessionOptionsSchema = z.object({
    proxy: z.string().url().nullish(),
    cookies: z.array(z.object({
      name: z.string(),
      value: z.string(),
      domain: z.string().optional(),
      path: z.string().optional(),
    }).passthrough()).nullish()
  });
  app.post('/accounts/:accountId/login/start', async (req, res) => { const { proxy, cookies } = sessionOptionsSchema.parse(req.body); res.status(201).json(await sessions.start(account(req), proxy ?? undefined, cookies ?? undefined)); });
  app.get('/accounts/:accountId/session', async (req, res) => res.json(await sessions.get(account(req))));
  app.post('/accounts/:accountId/session/continue', async (req, res) => res.json(await sessions.continue(account(req))));
  app.post('/accounts/:accountId/session/cancel', async (req, res) => res.json(await sessions.cancel(account(req))));
  app.post('/accounts/:accountId/session/validate', async (req, res) => { const { proxy, cookies } = sessionOptionsSchema.parse(req.body); res.json(await sessions.validate(account(req), proxy ?? undefined, cookies ?? undefined)); });
  app.delete('/accounts/:accountId', async (req, res) => { const id = account(req); await locks.removeProfile(id); res.json({ accountId: id, sessionId: null, status: 'completed', viewerUrl: null, loggedIn: false, errorCode: null, errorMessage: null }); });
  app.post('/accounts/:accountId/posts/inspect', async (req, res) => { const postUrl = z.object({ postUrl: z.string() }).parse(req.body).postUrl; res.json(await sessions.inspect(account(req), assertFacebookUrl(postUrl).toString())); });
  app.post('/accounts/:accountId/posts/execute', async (req, res) => { const action = actionSchema.parse(req.body); action.postUrl = assertFacebookUrl(action.postUrl).toString(); res.json(await sessions.execute(account(req), action)); });
  app.use((error: unknown, req: Request, res: Response, _next: NextFunction) => { const e = error instanceof ApiError ? error : new ApiError(error instanceof z.ZodError ? 'INVALID_REQUEST' : 'INTERNAL_ERROR', error instanceof z.ZodError ? 'Request validation failed.' : 'Unexpected internal error.', error instanceof z.ZodError ? 400 : 500); console.error(JSON.stringify({ level: 'error', event: 'request_failed', requestId: res.locals.requestId, errorCode: e.code, errorType: error instanceof Error ? error.name : 'unknown' })); const raw = req.params.accountId; const id = typeof raw === 'string' ? raw : ''; res.status(e.statusCode).json(errorBody(id, res.locals.requestId, e.code, e.message)); });
  return { app, sessions, proxy };
}
function errorBody(accountId: string, requestId: string, errorCode: string, errorMessage: string) { return { accountId, sessionId: null, status: 'failed', viewerUrl: null, loggedIn: false, errorCode, errorMessage, requestId }; }
const { app, sessions, proxy } = createApp(); const server = http.createServer(app);
server.on('upgrade', (req, socket, head) => { const url = new URL(req.url ?? '/', 'http://local'); if (!url.pathname.startsWith('/novnc/') || !sessions.canView(url.searchParams.get('token') ?? undefined)) return socket.destroy(); req.url = req.url?.replace(/^\/novnc/, ''); proxy.ws(req, socket, head); });
server.listen(config.PORT, '0.0.0.0', () => console.log(JSON.stringify({ level: 'info', event: 'server_started', port: config.PORT })));
const stop = () => void sessions.shutdown().finally(() => server.close(() => process.exit(0))); process.on('SIGINT', stop); process.on('SIGTERM', stop);
