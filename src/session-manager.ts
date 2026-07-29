import { randomUUID } from 'node:crypto';
import { BrowserContext, Page, chromium } from 'playwright';
import { config } from './config.js';
import { AccountLockManager } from './account-lock-manager.js';
import { ApiError, SessionStatus, WorkerResponse } from './types.js';

interface ActiveSession {
  accountId: string; sessionId: string; context: BrowserContext; page: Page;
  release: () => Promise<void>; timeout: NodeJS.Timeout; status: SessionStatus;
}

export class SessionManager {
  private readonly sessions = new Map<string, ActiveSession>();
  private readonly byAccount = new Map<string, string>();
  constructor(private readonly locks: AccountLockManager) {}

  private response(accountId: string, session?: ActiveSession, overrides: Partial<WorkerResponse> = {}): WorkerResponse {
    return {
      accountId, sessionId: session?.sessionId ?? null, status: session?.status ?? 'idle',
      viewerUrl: session ? `${config.PUBLIC_BASE_URL.replace(/\/$/, '')}/novnc/vnc.html?autoconnect=true&resize=scale&path=novnc/websockify` : null,
      loggedIn: false, errorCode: null, errorMessage: null, ...overrides
    };
  }
  private active(accountId: string): ActiveSession {
    const session = this.sessions.get(this.byAccount.get(accountId) ?? '');
    if (!session) throw new ApiError('SESSION_NOT_FOUND', 'No active browser session exists for this account.', 404);
    return session;
  }
  async start(accountId: string): Promise<WorkerResponse> {
    if (this.byAccount.has(accountId)) throw new ApiError('SESSION_ALREADY_ACTIVE', 'This account already has an active session.', 409);
    if (this.sessions.size >= config.MAX_ACTIVE_BROWSERS) throw new ApiError('BROWSER_CAPACITY_REACHED', 'Global active browser limit has been reached.', 429);
    const sessionId = randomUUID();
    const release = await this.locks.acquire(accountId, sessionId);
    try {
      const context = await chromium.launchPersistentContext(this.locks.profilePath(accountId), {
        headless: false, viewport: { width: 1440, height: 900 }, args: ['--no-sandbox', '--disable-dev-shm-usage']
      });
      const page = context.pages()[0] ?? await context.newPage();
      await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 45_000 });
      const session = { accountId, sessionId, context, page, release, status: 'active' as const, timeout: undefined as unknown as NodeJS.Timeout };
      session.timeout = setTimeout(() => void this.close(session, 'expired'), config.SESSION_TIMEOUT_SECONDS * 1000);
      this.sessions.set(sessionId, session); this.byAccount.set(accountId, sessionId);
      return this.response(accountId, session);
    } catch (error) { await release(); throw error; }
  }
  private async hasAuthenticatedCookies(context: BrowserContext): Promise<boolean> {
    const cookies = await context.cookies('https://www.facebook.com');
    return cookies.some((cookie) => cookie.name === 'c_user' && cookie.value.length > 0) && cookies.some((cookie) => cookie.name === 'xs');
  }
  private async verifyFacebookLogin(context: BrowserContext): Promise<boolean> {
    if (!await this.hasAuthenticatedCookies(context)) return false;
    const page = context.pages()[0] ?? await context.newPage();
    try {
      await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 45_000 });
      if (/\/login|\/checkpoint/i.test(page.url())) return false;
      return await page.locator('input[name="email"], input[name="pass"]').count() === 0;
    } catch { return false; }
  }
  async get(accountId: string): Promise<WorkerResponse> {
    const session = this.sessions.get(this.byAccount.get(accountId) ?? '');
    return session ? this.response(accountId, session, { loggedIn: await this.hasAuthenticatedCookies(session.context) }) : this.response(accountId);
  }
  async continue(accountId: string): Promise<WorkerResponse> {
    const session = this.active(accountId); const loggedIn = await this.verifyFacebookLogin(session.context);
    if (!loggedIn) return this.response(accountId, session, { status: 'error', loggedIn: false, errorCode: 'FACEBOOK_LOGIN_NOT_CONFIRMED', errorMessage: 'Facebook login cookies were not found. Complete login in the browser and try Continue again.' });
    await this.close(session, 'logged_in');
    return this.response(accountId, undefined, { sessionId: session.sessionId, status: 'logged_in', loggedIn: true });
  }
  async cancel(accountId: string): Promise<WorkerResponse> {
    const session = this.active(accountId); await this.close(session, 'cancelled');
    return this.response(accountId, undefined, { sessionId: session.sessionId, status: 'cancelled' });
  }
  async validate(accountId: string): Promise<WorkerResponse> {
    const current = this.sessions.get(this.byAccount.get(accountId) ?? '');
    if (current) return this.response(accountId, current, { loggedIn: await this.verifyFacebookLogin(current.context) });
    if (this.sessions.size >= config.MAX_ACTIVE_BROWSERS) throw new ApiError('BROWSER_CAPACITY_REACHED', 'Cannot validate while another browser is active.', 429);
    const sessionId = randomUUID(); const release = await this.locks.acquire(accountId, sessionId);
    try {
      const context = await chromium.launchPersistentContext(this.locks.profilePath(accountId), { headless: false, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
      const isLoggedIn = await this.verifyFacebookLogin(context); await context.close(); await release();
      return this.response(accountId, undefined, { sessionId, status: isLoggedIn ? 'logged_in' : 'idle', loggedIn: isLoggedIn });
    } catch (error) { await release(); throw error; }
  }
  private async close(session: ActiveSession, status: SessionStatus): Promise<void> {
    clearTimeout(session.timeout); this.sessions.delete(session.sessionId); this.byAccount.delete(session.accountId);
    try { await session.context.close(); } finally { await session.release(); }
    session.status = status;
  }
  async shutdown(): Promise<void> { await Promise.all([...this.sessions.values()].map((session) => this.close(session, 'cancelled'))); }
}
