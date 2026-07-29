import express, { NextFunction, Request, Response } from 'express';
import http from 'node:http';
import httpProxy from 'http-proxy';
import { config } from './config.js';
import { AccountLockManager, assertAccountId } from './account-lock-manager.js';
import { SessionManager } from './session-manager.js';
import { ApiError } from './types.js';

const app = express();
const sessions = new SessionManager(new AccountLockManager(config.PROFILE_ROOT));
const proxy = httpProxy.createProxyServer({ target: 'http://127.0.0.1:6080', ws: true, changeOrigin: false });
app.disable('x-powered-by'); app.use(express.json({ limit: '16kb' }));
app.use((req, res, next) => {
  if (req.header('X-Worker-Secret') === config.WORKER_SECRET) return next();
  const rawAccount = req.params.accountId;
  const accountId = typeof rawAccount === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(rawAccount) ? rawAccount : '';
  return res.status(401).json({ accountId, sessionId: null, status: 'error', viewerUrl: null, loggedIn: false, errorCode: 'UNAUTHORIZED', errorMessage: 'Missing or invalid X-Worker-Secret.' });
});
app.get('/health', (_req, res) => res.json({ status: 'ok' }));
app.use('/novnc', (req, res) => proxy.web(req, res));
const account = (req: Request) => {
  const value = req.params.accountId;
  if (Array.isArray(value) || !value) throw new ApiError('INVALID_ACCOUNT_ID', 'accountId must be a single path value.', 400);
  return assertAccountId(value);
};
app.post('/accounts/:accountId/login/start', async (req, res) => res.status(201).json(await sessions.start(account(req))));
app.get('/accounts/:accountId/session', async (req, res) => res.json(await sessions.get(account(req))));
app.post('/accounts/:accountId/session/continue', async (req, res) => res.json(await sessions.continue(account(req))));
app.post('/accounts/:accountId/session/cancel', async (req, res) => res.json(await sessions.cancel(account(req))));
app.post('/accounts/:accountId/session/validate', async (req, res) => res.json(await sessions.validate(account(req))));
app.delete('/accounts/:accountId', async (req, res) => { const locks = new AccountLockManager(config.PROFILE_ROOT); await locks.removeProfile(account(req)); res.json({ accountId: account(req), sessionId: null, status: 'idle', viewerUrl: null, loggedIn: false, errorCode: null, errorMessage: null }); });
app.use((error: unknown, req: Request, res: Response, _next: NextFunction) => {
  const e = error instanceof ApiError ? error : new ApiError('INTERNAL_ERROR', error instanceof Error ? error.message : 'Unexpected error.', 500);
  const rawAccount = req.params.accountId;
  const accountId = typeof rawAccount === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(rawAccount) ? rawAccount : '';
  res.status(e.statusCode).json({ accountId, sessionId: null, status: 'error', viewerUrl: null, loggedIn: false, errorCode: e.code, errorMessage: e.message });
});
const server = http.createServer(app);
server.on('upgrade', (req, socket, head) => {
  if (!req.url?.startsWith('/novnc/') || req.headers['x-worker-secret'] !== config.WORKER_SECRET) { socket.destroy(); return; }
  req.url = req.url.replace(/^\/novnc/, '');
  proxy.ws(req, socket, head);
});
server.listen(config.PORT, '0.0.0.0', () => console.log(`markops-engagement-worker listening on ${config.PORT}`));
const graceful = () => void sessions.shutdown().finally(() => server.close(() => process.exit(0)));
process.on('SIGTERM', graceful); process.on('SIGINT', graceful);
