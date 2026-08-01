import { randomBytes, randomUUID } from 'node:crypto';
import { BrowserContext, Page, chromium } from 'playwright';
import { config } from './config.js';
import { AccountLockManager } from './account-lock-manager.js';
import { ApprovalRecord, ApprovalStore } from './approval-store.js';
import { detectXSecurityState } from './x-page.js';
import { ApiError, SessionStatus, WorkerResponse } from './types.js';

/**
 * X/Twitter supports: like (toggle) and reply.
 * No multi-reaction picker — X only has a single like button.
 * 'reply' is used instead of 'comment' to reflect the platform's terminology.
 */
type ActionRequest =
  | { postUrl: string; action: 'like'; approvalId: string }
  | { postUrl: string; action: 'reply'; comment: string; approvalId: string };

interface ActiveSession {
  accountId: string; sessionId: string; viewerToken: string;
  context: BrowserContext; page: Page; release: () => Promise<void>;
  timeout: NodeJS.Timeout; status: SessionStatus;
  pending?: () => Promise<WorkerResponse>;
}

export class XSessionManager {
  private sessions = new Map<string, ActiveSession>();
  private byAccount = new Map<string, string>();

  constructor(
    private locks: AccountLockManager,
    private approvals = new ApprovalStore(`${config.X_PROFILE_ROOT}/.approvals`)
  ) {}

  private viewer(session: ActiveSession) { const base = config.PUBLIC_BASE_URL.replace(/\/$/, ''); const token = encodeURIComponent(session.viewerToken); return `${base}/novnc/vnc.html?autoconnect=true&resize=scale&path=novnc/websockify%3Ftoken%3D${token}&token=${token}`; }
  private response(accountId: string, session?: ActiveSession, overrides: Partial<WorkerResponse> = {}): WorkerResponse { return { accountId, sessionId: session?.sessionId ?? null, status: session?.status ?? 'idle', viewerUrl: session ? this.viewer(session) : null, loggedIn: false, errorCode: null, errorMessage: null, ...overrides }; }
  private requireActive(accountId: string) { const session = this.sessions.get(this.byAccount.get(accountId) ?? ''); if (!session) throw new ApiError('SESSION_NOT_FOUND', 'No active browser session for this account.', 404); return session; }
  canView(token: string | undefined) { return !!token && [...this.sessions.values()].some((x) => x.viewerToken === token); }

  private async open(accountId: string, interactive = false, proxy?: string, cookies?: any[]): Promise<ActiveSession> {
    if (this.byAccount.has(accountId)) throw new ApiError('SESSION_ALREADY_ACTIVE', 'This account already has an active browser session.', 409);
    if (this.sessions.size >= config.MAX_ACTIVE_BROWSERS) throw new ApiError('BROWSER_CAPACITY_REACHED', 'Global active browser limit has been reached.', 429);
    const sessionId = randomUUID(); const release = await this.locks.acquire(accountId, sessionId);
    try {
      const resolvedProxy = proxy ?? config.BROWSER_PROXY;
      let proxySettings: any = {};
      if (resolvedProxy) {
        try {
          const u = new URL(resolvedProxy);
          proxySettings = u.username || u.password
            ? { proxy: { server: `${u.protocol}//${u.host}`, username: decodeURIComponent(u.username), password: decodeURIComponent(u.password) } }
            : { proxy: { server: resolvedProxy } };
        } catch { proxySettings = { proxy: { server: resolvedProxy } }; }
      }
      const context = await chromium.launchPersistentContext(this.locks.profilePath(accountId), {
        headless: !interactive, viewport: { width: 1280, height: 720 }, ...proxySettings,
        args: ['--no-sandbox', '--disable-dev-shm-usage', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-gpu', '--disable-software-rasterizer', '--disable-extensions', '--disable-default-apps', '--disable-sync', '--disable-translate', '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-features=TranslateUI,BlinkGenPropertyTrees', '--mute-audio', '--hide-scrollbars', '--metrics-recording-only', '--memory-pressure-off', '--js-flags=--max-old-space-size=256', '--disable-blink-features=AutomationControlled', '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'],
      });
      const page = context.pages()[0] ?? await context.newPage();
      if (cookies && cookies.length > 0) {
        try {
          await context.addCookies(cookies.map((c) => ({ name: c.name, value: c.value, domain: c.domain || '.x.com', path: c.path || '/' })));
        } catch (err) { console.error(`[X] Failed to inject cookies for ${accountId}`, err); }
      }
      const session = { accountId, sessionId, viewerToken: randomBytes(24).toString('base64url'), context, page, release, status: 'browser_ready' as SessionStatus, timeout: undefined as unknown as NodeJS.Timeout };
      session.timeout = setTimeout(() => void this.close(session, 'timed_out'), config.SESSION_TIMEOUT_SECONDS * 1000);
      this.sessions.set(sessionId, session); this.byAccount.set(accountId, sessionId); context.once('close', () => void this.externalClose(session)); return session;
    } catch (e) { await release(); throw e; }
  }

  private async cookiesLoggedIn(context: BrowserContext) {
    const xc = await context.cookies('https://x.com');
    const tc = await context.cookies('https://twitter.com');
    return [...xc, ...tc].some((c) => c.name === 'auth_token' && c.value.length > 0);
  }
  private async check(page: Page) { const state = await detectXSecurityState(page); return state === 'ready' && await this.cookiesLoggedIn(page.context()); }

  async start(accountId: string, proxy?: string, cookies?: any[]) { const session = await this.open(accountId, true, proxy, cookies); await session.page.goto('https://x.com/', { waitUntil: 'domcontentloaded', timeout: 45_000 }); const state = await detectXSecurityState(session.page); session.status = state === 'ready' ? 'browser_ready' : 'manual_intervention_required'; return this.response(accountId, session, { loggedIn: state === 'ready' && await this.cookiesLoggedIn(session.context) }); }
  async get(accountId: string) { const s = this.sessions.get(this.byAccount.get(accountId) ?? ''); return s ? this.response(accountId, s, { loggedIn: await this.cookiesLoggedIn(s.context).catch(() => false) }) : this.response(accountId); }
  async continue(accountId: string) { const s = this.requireActive(accountId); if (!await this.check(s.page)) { s.status = 'manual_intervention_required'; return this.response(accountId, s, { errorCode: 'MANUAL_INTERVENTION_REQUIRED', errorMessage: 'Complete X login or verification in the browser, then continue.' }); } if (s.pending) return s.pending(); await this.close(s, 'completed'); return this.response(accountId, undefined, { sessionId: s.sessionId, status: 'completed', loggedIn: true }); }
  async cancel(accountId: string) { const s = this.requireActive(accountId); await this.close(s, 'cancelled'); return this.response(accountId, undefined, { sessionId: s.sessionId, status: 'cancelled' }); }

  private async manual(accountId: string, current: ActiveSession, url: string, proxy?: string, pending?: () => Promise<WorkerResponse>) { await this.close(current, 'cancelled'); const session = await this.open(accountId, true, proxy); await session.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 }); session.status = 'manual_intervention_required'; session.pending = pending; return session; }

  async validate(accountId: string, proxy?: string, cookies?: any[]) { const current = this.sessions.get(this.byAccount.get(accountId) ?? ''); if (current) return this.response(accountId, current, { loggedIn: await this.check(current.page) }); const s = await this.open(accountId, false, proxy, cookies); try { await s.page.goto('https://x.com/', { waitUntil: 'domcontentloaded', timeout: 45_000 }); const loggedIn = await this.check(s.page); if (!loggedIn) { const m = await this.manual(accountId, s, 'https://x.com/', proxy); return this.response(accountId, m, { loggedIn: false, errorCode: 'MANUAL_INTERVENTION_REQUIRED', errorMessage: 'Login or verification is required.' }); } await this.close(s, 'completed'); return this.response(accountId, undefined, { sessionId: s.sessionId, status: 'completed', loggedIn: true }); } catch (e) { await this.close(s, 'failed'); throw e; } }

  private async usePage(accountId: string, url: string, proxy?: string) { const existing = this.sessions.get(this.byAccount.get(accountId) ?? ''); const s = existing ?? await this.open(accountId, false, proxy); await s.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 }); return { s, transient: !existing }; }

  async inspect(accountId: string, postUrl: string) {
    const { s, transient } = await this.usePage(accountId, postUrl);
    const security = await detectXSecurityState(s.page);
    if (security !== 'ready' || !await this.cookiesLoggedIn(s.context)) { const m = transient ? await this.manual(accountId, s, postUrl) : s; m.status = 'manual_intervention_required'; return this.response(accountId, m, { errorCode: 'MANUAL_INTERVENTION_REQUIRED', errorMessage: 'Login or verification required before inspecting this post.' }); }
    const result = await this.inspectTargetPost(s.page);
    if (transient) await this.close(s, 'completed');
    return this.response(accountId, transient ? undefined : s, { status: 'completed', loggedIn: true, result });
  }

  async execute(accountId: string, input: ActionRequest) {
    const fingerprint = this.approvals.fingerprint(accountId, input.postUrl, input.action, undefined, input.action === 'reply' ? input.comment : undefined);
    const started = await this.approvals.begin(accountId, input.approvalId, fingerprint);
    if (started.duplicate) { if (started.record.status === 'running') await this.approvals.complete(started.record, 'outcome_unknown'); const status = started.record.status === 'running' ? 'outcome_unknown' : started.record.status as SessionStatus; return this.response(accountId, undefined, { status, errorCode: status === 'outcome_unknown' ? 'OUTCOME_UNKNOWN' : null, result: { approvalId: input.approvalId, idempotent: true, previousState: started.record.previousState ?? null, finalState: started.record.finalState ?? null } }); }
    try { return await this.perform(accountId, input, started.record); }
    catch { await this.approvals.complete(started.record, 'outcome_unknown'); return this.response(accountId, undefined, { status: 'outcome_unknown', errorCode: 'OUTCOME_UNKNOWN', errorMessage: 'The action could not start or be confirmed; it was not retried.', result: { approvalId: input.approvalId } }); }
  }

  private async perform(accountId: string, input: ActionRequest, record: ApprovalRecord): Promise<WorkerResponse> {
    const { s, transient } = await this.usePage(accountId, input.postUrl);
    const security = await detectXSecurityState(s.page);
    if (security !== 'ready' || !await this.cookiesLoggedIn(s.context)) { const m = transient ? await this.manual(accountId, s, input.postUrl, undefined, () => this.perform(accountId, input, record)) : s; m.status = 'manual_intervention_required'; m.pending = () => this.perform(accountId, input, record); await this.approvals.complete(record, 'manual_intervention_required'); return this.response(accountId, m, { errorCode: 'MANUAL_INTERVENTION_REQUIRED', errorMessage: 'Complete X verification in the browser, then press Continue.' }); }
    s.status = 'running';
    try {
      const result = input.action === 'like' ? await this.like(s.page) : await this.reply(s.page, input.comment);
      if (result.confirmed) { await this.approvals.complete(record, 'completed', result.previous, result.final); if (transient) await this.close(s, 'completed'); return this.response(accountId, transient ? undefined : s, { status: 'completed', loggedIn: true, result: { approvalId: input.approvalId, previousState: result.previous, finalState: result.final, diagnostic: result.diagnostic } }); }
      await this.approvals.complete(record, 'outcome_unknown', result.previous, result.final); s.status = 'outcome_unknown'; return this.response(accountId, s, { errorCode: 'OUTCOME_UNKNOWN', errorMessage: 'The final X state could not be confirmed.', result: { approvalId: input.approvalId, previousState: result.previous, finalState: result.final, diagnostic: result.diagnostic } });
    } catch {
      const sec = await detectXSecurityState(s.page).catch(() => 'ready');
      if (sec !== 'ready') { const m = transient ? await this.manual(accountId, s, input.postUrl, undefined, () => this.perform(accountId, input, record)) : s; m.status = 'manual_intervention_required'; m.pending = () => this.perform(accountId, input, record); await this.approvals.complete(record, 'manual_intervention_required'); return this.response(accountId, m, { errorCode: 'MANUAL_INTERVENTION_REQUIRED', errorMessage: 'X requires manual verification before this action can finish.' }); }
      await this.approvals.complete(record, 'outcome_unknown'); s.status = 'outcome_unknown'; return this.response(accountId, s, { errorCode: 'OUTCOME_UNKNOWN', errorMessage: 'The action result could not be confirmed; it was not retried.', result: { approvalId: input.approvalId } });
    }
  }

  // ── Post inspection ────────────────────────────────────────────────────────

  private async inspectTargetPost(page: Page): Promise<Record<string, unknown>> {
    await page.waitForTimeout(2000);

    // X tweet page: article[data-testid="tweet"] contains the tweet
    const tweet = page.locator('article[data-testid="tweet"]').first();
    const root = await tweet.count() ? tweet : page.locator('body');

    let visibleAuthorName: string | null = null;
    const authorEl = root.locator('[data-testid="User-Name"] span, [data-testid="UserName"] span').filter({ visible: true }).first();
    if (await authorEl.count()) {
      visibleAuthorName = (await authorEl.innerText()).trim() || null;
    }

    let visiblePostText: string | null = null;
    const tweetText = root.locator('[data-testid="tweetText"]').filter({ visible: true }).first();
    if (await tweetText.count()) {
      visiblePostText = (await tweetText.innerText()).trim().slice(0, 12000) || null;
    }
    if (!visiblePostText) {
      visiblePostText = (await root.innerText()).trim().slice(0, 12000) || null;
    }

    if (!visibleAuthorName && !visiblePostText) throw new ApiError('TARGET_POST_NOT_FOUND', 'Could not identify the X post content.');
    return { visiblePostText, visibleAuthorName };
  }

  // ── Actions ───────────────────────────────────────────────────────────────

  /** Toggle like on an X/Twitter post. */
  private async like(page: Page): Promise<{ confirmed: boolean; previous: string | null; final: string | null; diagnostic: string }> {
    await page.waitForTimeout(1500);

    // X like button uses data-testid="like" (not liked) or "unlike" (liked)
    const likeBtn = page.locator('[data-testid="like"], [data-testid="unlike"]').filter({ visible: true }).first();
    if (!await likeBtn.count()) return { confirmed: false, previous: null, final: null, diagnostic: 'like_button_not_found' };

    const beforeTestId = await likeBtn.getAttribute('data-testid').catch(() => null);
    const wasLiked = beforeTestId === 'unlike';

    if (wasLiked) return { confirmed: true, previous: 'like', final: 'like', diagnostic: 'already_active' };

    await likeBtn.click({ force: true, delay: 100 });
    await page.waitForTimeout(2000);

    // Re-query since testid changes after click
    const afterBtn = page.locator('[data-testid="like"], [data-testid="unlike"]').filter({ visible: true }).first();
    const afterTestId = await afterBtn.getAttribute('data-testid').catch(() => null);
    const isNowLiked = afterTestId === 'unlike';

    return { confirmed: isNowLiked, previous: null, final: isNowLiked ? 'like' : null, diagnostic: isNowLiked ? 'confirmed_from_post' : 'like_state_not_confirmed' };
  }

  /** Reply to an X/Twitter post. X uses 'reply' instead of 'comment'. */
  private async reply(page: Page, text: string): Promise<{ confirmed: boolean; previous: string | null; final: string | null; diagnostic: string }> {
    if (!text.trim()) throw new ApiError('INVALID_COMMENT', 'reply must be non-empty.');
    await page.waitForTimeout(1500);

    // Click the reply button
    const replyBtn = page.locator('[data-testid="reply"]').filter({ visible: true }).first();
    if (!await replyBtn.count()) return { confirmed: false, previous: null, final: null, diagnostic: 'reply_button_not_found' };
    await replyBtn.click();
    await page.waitForTimeout(800);

    // Type in the compose box
    const composer = page.locator('[data-testid="tweetTextarea_0"], [contenteditable="true"][aria-label*="reply" i], [contenteditable="true"][aria-label*="Post" i]').filter({ visible: true }).first();
    if (!await composer.count()) return { confirmed: false, previous: null, final: null, diagnostic: 'reply_composer_not_found' };

    const before = await page.locator('body').innerText();
    const beforeCount = before.split(text).length - 1;

    await composer.click();
    await composer.fill(text);

    // Submit the reply
    const submitBtn = page.locator('[data-testid="tweetButton"], [data-testid="tweetButtonInline"]').filter({ visible: true }).first();
    if (await submitBtn.count()) { await submitBtn.click(); } else { await composer.press('Control+Enter'); }

    await page.waitForTimeout(2500);

    const after = await page.locator('body').innerText();
    const confirmed = after.split(text).length - 1 > beforeCount;
    return { confirmed, previous: null, final: confirmed ? 'reply_present' : null, diagnostic: confirmed ? 'reply_visible_on_post' : 'reply_not_visible_after_submit' };
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  private async close(s: ActiveSession, status: SessionStatus) { clearTimeout(s.timeout); this.sessions.delete(s.sessionId); this.byAccount.delete(s.accountId); try { await s.context.close(); } finally { await s.release(); } s.status = status; }
  private async externalClose(s: ActiveSession) { if (!this.sessions.has(s.sessionId)) return; clearTimeout(s.timeout); this.sessions.delete(s.sessionId); this.byAccount.delete(s.accountId); await s.release(); }
  async shutdown() { await Promise.all([...this.sessions.values()].map((s) => this.close(s, 'cancelled'))); }
}
