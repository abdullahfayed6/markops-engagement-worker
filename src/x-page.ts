import { Page } from 'playwright';

export type SecurityState = 'logged_out' | 'manual_intervention_required' | 'ready';

/**
 * Classify the current X/Twitter page state.
 * Returns 'manual_intervention_required' for challenge flows, 2FA, or phone/email verification.
 * Returns 'logged_out' when a login form is present.
 * Returns 'ready' when the user appears to be logged in on a normal page.
 */
export function classifyXPage(url: string, text: string, hasLoginForm: boolean): SecurityState {
  const normalizedUrl = url.toLowerCase();
  const normalizedText = text.toLowerCase();

  if (
    /\/i\/flow\/login|\/i\/flow\/signup|\/account\/login_challenge|challenge|two_factor|\/account\/login_verification|suspended/.test(normalizedUrl) ||
    /verify your identity|confirm your identity|suspicious login|enter your phone|enter your email|phone number|unusual activity|account locked/.test(normalizedText)
  ) {
    return 'manual_intervention_required';
  }

  return hasLoginForm ? 'logged_out' : 'ready';
}

export async function detectXSecurityState(page: Page): Promise<SecurityState> {
  const url = page.url().toLowerCase();
  const text = (await page.locator('body').innerText({ timeout: 3000 }).catch(() => '')).toLowerCase();
  const hasLoginForm = (await page.locator(
    'input[autocomplete="username"], input[name="text"][autocomplete="username"], [data-testid="LoginForm_Login_Button"]'
  ).count()) > 0;
  return classifyXPage(url, text, hasLoginForm);
}

/**
 * Check if X/Twitter session cookies indicate a logged-in user.
 * X stores the auth session in 'auth_token' cookie.
 */
export async function isXLoggedIn(page: Page): Promise<boolean> {
  // Try both x.com and twitter.com cookies
  const xCookies = await page.context().cookies('https://x.com');
  const twCookies = await page.context().cookies('https://twitter.com');
  const all = [...xCookies, ...twCookies];
  return all.some((c) => c.name === 'auth_token' && c.value.length > 0);
}
