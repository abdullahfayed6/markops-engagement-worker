import { Page } from 'playwright';

export type SecurityState = 'logged_out' | 'manual_intervention_required' | 'ready';
export function classifyFacebookPage(url: string, text: string, hasLoginForm: boolean): SecurityState {
  const normalizedUrl = url.toLowerCase(); const normalizedText = text.toLowerCase();
  if (/\/checkpoint|\/login|\/recover|\/two_step/.test(normalizedUrl) || /captcha|security check|approve your login|confirm your identity|two-factor authentication/.test(normalizedText)) return 'manual_intervention_required';
  return hasLoginForm ? 'logged_out' : 'ready';
}
export async function detectSecurityState(page: Page): Promise<SecurityState> {
  const url = page.url().toLowerCase(); const text = (await page.locator('body').innerText({ timeout: 3000 }).catch(() => '')).toLowerCase();
  return classifyFacebookPage(url, text, (await page.locator('input[name="email"], input[name="pass"], [aria-label="Email address or mobile number"]').count()) > 0);
}

export async function inspectVisiblePost(page: Page): Promise<Record<string, unknown>> {
  const article = page.locator('[role="article"]').first(); const root = await article.count() ? article : page.locator('body');
  const text = (await root.innerText()).trim().slice(0, 12000);
  const author = await root.locator('h2 a, h3 a, strong a').first().innerText().catch(() => null);
  const imageCount = await root.locator('img').count(); const hasVideo = await root.locator('video, [role="button"][aria-label*="Play"]').count() > 0;
  const pressed = await root.locator('[aria-pressed="true"]').allTextContents();
  const currentReaction = ['like','love','care','haha','wow','sad','angry'].find((x) => pressed.join(' ').toLowerCase().includes(x)) ?? null;
  const commentingAvailable = await root.locator('[contenteditable="true"], textarea, [aria-label*="Comment"]').count() > 0;
  return { visiblePostText: text, visibleAuthorName: author, imageCount, hasVideo, currentReaction, commentingAvailable };
}
