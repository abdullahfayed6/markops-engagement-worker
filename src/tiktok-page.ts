import { Page } from 'playwright';

export type SecurityState = 'logged_out' | 'manual_intervention_required' | 'ready';

/**
 * Classify the current TikTok page state.
 * Returns 'manual_intervention_required' for captcha, email/phone verification, or 2FA screens.
 * Returns 'logged_out' when a login form is present.
 * Returns 'ready' when the user appears to be logged in on a normal page.
 */
export function classifyTikTokPage(url: string, text: string, hasLoginForm: boolean): SecurityState {
  const normalizedUrl = url.toLowerCase();
  const normalizedText = text.toLowerCase();

  if (
    /\/login|captcha|\/verify|checkpoint|two-factor|2fa/.test(normalizedUrl) ||
    /verify your account|confirm your identity|suspicious activity|enter the code|send code|complete the captcha/.test(normalizedText)
  ) {
    return 'manual_intervention_required';
  }

  return hasLoginForm ? 'logged_out' : 'ready';
}

export async function detectTikTokSecurityState(page: Page): Promise<SecurityState> {
  const url = page.url().toLowerCase();
  const text = (await page.locator('body').innerText({ timeout: 3000 }).catch(() => '')).toLowerCase();
  const hasLoginForm = (await page.locator(
    '[data-e2e="login-button"], input[placeholder*="Email"], input[placeholder*="Phone"], input[name="username"]'
  ).count()) > 0;
  return classifyTikTokPage(url, text, hasLoginForm);
}

/**
 * Check if TikTok session cookies indicate a logged-in user.
 * TikTok stores session in the 'sessionid' cookie on tiktok.com.
 */
export async function isTikTokLoggedIn(page: Page): Promise<boolean> {
  const cookies = await page.context().cookies('https://www.tiktok.com');
  return cookies.some((c) => c.name === 'sessionid' && c.value.length > 0);
}
