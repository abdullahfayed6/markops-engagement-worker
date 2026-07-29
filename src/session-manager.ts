import { randomBytes, randomUUID } from 'node:crypto';
import { BrowserContext, Page, chromium } from 'playwright';
import { config } from './config.js';
import { AccountLockManager } from './account-lock-manager.js';
import { ApprovalRecord, ApprovalStore } from './approval-store.js';
import { detectSecurityState, inspectVisiblePost } from './facebook-page.js';
import { ApiError, SessionStatus, WorkerResponse } from './types.js';

const reactions = ['like', 'love', 'care', 'haha', 'wow', 'sad', 'angry'] as const;
type Reaction = typeof reactions[number];
type ActionRequest = { postUrl: string; action: 'react'; reaction: Reaction; approvalId: string } | { postUrl: string; action: 'comment'; comment: string; approvalId: string };
interface ActiveSession { accountId: string; sessionId: string; viewerToken: string; context: BrowserContext; page: Page; release: () => Promise<void>; timeout: NodeJS.Timeout; status: SessionStatus; pending?: () => Promise<WorkerResponse>; }

export class SessionManager {
  private sessions = new Map<string, ActiveSession>(); private byAccount = new Map<string, string>();
  constructor(private locks: AccountLockManager, private approvals = new ApprovalStore(`${config.PROFILE_ROOT}/.approvals`)) {}
  private viewer(session: ActiveSession) { const base = config.PUBLIC_BASE_URL.replace(/\/$/, ''); const token = encodeURIComponent(session.viewerToken); return `${base}/novnc/vnc.html?autoconnect=true&resize=scale&path=novnc/websockify%3Ftoken%3D${token}&token=${token}`; }
  private response(accountId: string, session?: ActiveSession, overrides: Partial<WorkerResponse> = {}): WorkerResponse { return { accountId, sessionId: session?.sessionId ?? null, status: session?.status ?? 'idle', viewerUrl: session ? this.viewer(session) : null, loggedIn: false, errorCode: null, errorMessage: null, ...overrides }; }
  private requireActive(accountId: string) { const session = this.sessions.get(this.byAccount.get(accountId) ?? ''); if (!session) throw new ApiError('SESSION_NOT_FOUND', 'No active browser session exists for this account.', 404); return session; }
  canView(token: string | undefined) { return !!token && [...this.sessions.values()].some((x) => x.viewerToken === token); }
  private async open(accountId: string): Promise<ActiveSession> {
    if (this.byAccount.has(accountId)) throw new ApiError('SESSION_ALREADY_ACTIVE', 'This account already has an active browser session.', 409);
    if (this.sessions.size >= config.MAX_ACTIVE_BROWSERS) throw new ApiError('BROWSER_CAPACITY_REACHED', 'Global active browser limit has been reached.', 429);
    const sessionId = randomUUID(); const release = await this.locks.acquire(accountId, sessionId);
    try {
      const context = await chromium.launchPersistentContext(this.locks.profilePath(accountId), { headless: false, viewport: { width: 1440, height: 900 }, args: ['--no-sandbox', '--disable-dev-shm-usage', '--no-first-run', '--no-default-browser-check', '--disable-background-networking'] });
      const page = context.pages()[0] ?? await context.newPage();
      const session = { accountId, sessionId, viewerToken: randomBytes(24).toString('base64url'), context, page, release, status: 'browser_ready' as SessionStatus, timeout: undefined as unknown as NodeJS.Timeout };
      session.timeout = setTimeout(() => void this.close(session, 'timed_out'), config.SESSION_TIMEOUT_SECONDS * 1000);
      this.sessions.set(sessionId, session); this.byAccount.set(accountId, sessionId); context.once('close', () => void this.externalClose(session)); return session;
    } catch (e) { await release(); throw e; }
  }
  private async cookiesLoggedIn(context: BrowserContext) { const c = await context.cookies('https://www.facebook.com'); return c.some((x) => x.name === 'c_user' && x.value) && c.some((x) => x.name === 'xs' && x.value); }
  private async check(page: Page) { const state = await detectSecurityState(page); return state === 'ready' && await this.cookiesLoggedIn(page.context()); }
  async start(accountId: string) { const session = await this.open(accountId); await session.page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 45_000 }); const state = await detectSecurityState(session.page); session.status = state === 'ready' ? 'browser_ready' : 'manual_intervention_required'; return this.response(accountId, session, { loggedIn: state === 'ready' && await this.cookiesLoggedIn(session.context) }); }
  async get(accountId: string) { const s = this.sessions.get(this.byAccount.get(accountId) ?? ''); return s ? this.response(accountId, s, { loggedIn: await this.cookiesLoggedIn(s.context).catch(() => false) }) : this.response(accountId); }
  async continue(accountId: string) { const s = this.requireActive(accountId); if (!await this.check(s.page)) { s.status = 'manual_intervention_required'; return this.response(accountId, s, { errorCode: 'MANUAL_INTERVENTION_REQUIRED', errorMessage: 'Complete Facebook login or verification in the browser, then continue.' }); } if (s.pending) return s.pending(); await this.close(s, 'completed'); return this.response(accountId, undefined, { sessionId: s.sessionId, status: 'completed', loggedIn: true }); }
  async cancel(accountId: string) { const s = this.requireActive(accountId); await this.close(s, 'cancelled'); return this.response(accountId, undefined, { sessionId: s.sessionId, status: 'cancelled' }); }
  async validate(accountId: string) { const current = this.sessions.get(this.byAccount.get(accountId) ?? ''); if (current) return this.response(accountId, current, { loggedIn: await this.check(current.page) }); const s = await this.open(accountId); try { await s.page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 45_000 }); const loggedIn = await this.check(s.page); if (!loggedIn) { s.status = 'session_expired'; return this.response(accountId, s, { loggedIn: false, errorCode: 'MANUAL_INTERVENTION_REQUIRED', errorMessage: 'Login or verification is required.' }); } await this.close(s, 'completed'); return this.response(accountId, undefined, { sessionId: s.sessionId, status: 'completed', loggedIn: true }); } catch (e) { await this.close(s, 'failed'); throw e; } }
  private async usePage(accountId: string, url: string) { const existing = this.sessions.get(this.byAccount.get(accountId) ?? ''); const s = existing ?? await this.open(accountId); await s.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 }); return { s, transient: !existing }; }
  async inspect(accountId: string, postUrl: string) { const { s, transient } = await this.usePage(accountId, postUrl); const security = await detectSecurityState(s.page); if (security !== 'ready' || !await this.cookiesLoggedIn(s.context)) { s.status = 'manual_intervention_required'; return this.response(accountId, s, { errorCode: 'MANUAL_INTERVENTION_REQUIRED', errorMessage: 'Login or verification is required before inspecting this post.' }); } const result = await inspectVisiblePost(s.page); if (transient) await this.close(s, 'completed'); return this.response(accountId, transient ? undefined : s, { status: 'completed', loggedIn: true, result }); }
  async execute(accountId: string, input: ActionRequest) {
    const fingerprint = this.approvals.fingerprint(accountId, input.postUrl, input.action, input.action === 'react' ? input.reaction : undefined, input.action === 'comment' ? input.comment : undefined);
    const started = await this.approvals.begin(accountId, input.approvalId, fingerprint);
    if (started.duplicate && started.record.status === 'completed') return this.response(accountId, undefined, { status: 'completed', result: { approvalId: input.approvalId, idempotent: true, finalState: started.record.finalState ?? null } });
    return this.perform(accountId, input, started.record);
  }
  private async perform(accountId: string, input: ActionRequest, record: ApprovalRecord): Promise<WorkerResponse> {
    const { s, transient } = await this.usePage(accountId, input.postUrl); const security = await detectSecurityState(s.page);
    if (security !== 'ready' || !await this.cookiesLoggedIn(s.context)) { s.status = 'manual_intervention_required'; s.pending = () => this.perform(accountId, input, record); await this.approvals.complete(record, 'manual_intervention_required'); return this.response(accountId, s, { errorCode: 'MANUAL_INTERVENTION_REQUIRED', errorMessage: 'Complete Facebook verification in the browser, then press Continue.' }); }
    s.status = 'running';
    try {
      const result = input.action === 'react' ? await this.react(s.page, input.reaction) : await this.comment(s.page, input.comment);
      if (result.confirmed) { await this.approvals.complete(record, 'completed', result.previous, result.final); if (transient) await this.close(s, 'completed'); return this.response(accountId, transient ? undefined : s, { status: 'completed', loggedIn: true, result: { approvalId: input.approvalId, previousState: result.previous, finalState: result.final } }); }
      await this.approvals.complete(record, 'outcome_unknown', result.previous, result.final); s.status = 'outcome_unknown'; return this.response(accountId, s, { errorCode: 'OUTCOME_UNKNOWN', errorMessage: 'The final Facebook state could not be confirmed.', result: { approvalId: input.approvalId, previousState: result.previous, finalState: result.final } });
    } catch {
      const security = await detectSecurityState(s.page).catch(() => 'ready');
      if (security !== 'ready') { s.status = 'manual_intervention_required'; s.pending = () => this.perform(accountId, input, record); await this.approvals.complete(record, 'manual_intervention_required'); return this.response(accountId, s, { errorCode: 'MANUAL_INTERVENTION_REQUIRED', errorMessage: 'Facebook requires manual verification before this approved action can finish.' }); }
      await this.approvals.complete(record, 'outcome_unknown'); s.status = 'outcome_unknown'; return this.response(accountId, s, { errorCode: 'OUTCOME_UNKNOWN', errorMessage: 'The action result could not be confirmed; it was not retried.', result: { approvalId: input.approvalId } }); }
  }
  private async react(page: Page, requested: Reaction) { const body = (await page.locator('body').innerText()).toLowerCase(); const previous = reactions.find((x) => new RegExp(`\\b${x}\\b`).test(body)) ?? null; if (previous === requested) return { confirmed: true, previous, final: requested }; const buttons = page.getByRole('button', { name: /like|react/i }); const button = buttons.first(); await button.hover({ timeout: 5000 }); await page.waitForTimeout(500); const target = page.getByLabel(new RegExp(requested, 'i')).first(); if (await target.count()) await target.click(); else await page.getByText(new RegExp(`^${requested}$`, 'i')).first().click(); await page.waitForTimeout(800); const after = (await page.locator('body').innerText()).toLowerCase(); return { confirmed: after.includes(requested), previous, final: after.includes(requested) ? requested : null }; }
  private async comment(page: Page, text: string) { const composer = page.locator('[contenteditable="true"][role="textbox"], textarea').first(); if (!text.trim()) throw new ApiError('INVALID_COMMENT', 'comment must be non-empty.'); if (!await composer.count()) return { confirmed: false, previous: null, final: null }; const before = await page.locator('body').innerText(); if (before.includes(text)) return { confirmed: true, previous: 'existing_comment', final: 'existing_comment' }; await composer.click(); await composer.fill(text); await composer.press('Enter'); await page.waitForTimeout(1200); const after = await page.locator('body').innerText(); return { confirmed: after.includes(text), previous: null, final: after.includes(text) ? 'comment_present' : null }; }
  private async close(s: ActiveSession, status: SessionStatus) { clearTimeout(s.timeout); this.sessions.delete(s.sessionId); this.byAccount.delete(s.accountId); try { await s.context.close(); } finally { await s.release(); } s.status = status; }
  private async externalClose(s: ActiveSession) { if (!this.sessions.has(s.sessionId)) return; clearTimeout(s.timeout); this.sessions.delete(s.sessionId); this.byAccount.delete(s.accountId); await s.release(); }
  async shutdown() { await Promise.all([...this.sessions.values()].map((s) => this.close(s, 'cancelled'))); }
}
