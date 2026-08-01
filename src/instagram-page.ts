import { Page } from 'playwright';

export type SecurityState = 'logged_out' | 'manual_intervention_required' | 'ready';

/**
 * Classify the current Instagram page state.
 * Returns 'manual_intervention_required' for any checkpoint, 2FA, or verification screen.
 * Returns 'logged_out' when a login form is present.
 * Returns 'ready' when the user appears to be logged in and on a normal page.
 */
export function classifyInstagramPage(url: string, text: string, hasLoginForm: boolean): SecurityState {
  const normalizedUrl = url.toLowerCase();
  const normalizedText = text.toLowerCase();

  if (
    /\/accounts\/login|\/accounts\/emailsignup|\/challenge|two_factor|\/verify|checkpoint/.test(normalizedUrl) ||
    /verify your account|confirm your identity|suspicious login|enter the code|two-factor|send code to|we sent a code/.test(normalizedText)
  ) {
    return 'manual_intervention_required';
  }

  return hasLoginForm ? 'logged_out' : 'ready';
}

export async function detectInstagramSecurityState(page: Page): Promise<SecurityState> {
  const url = page.url().toLowerCase();
  const text = (await page.locator('body').innerText({ timeout: 3000 }).catch(() => '')).toLowerCase();
  const hasLoginForm = (await page.locator(
    'input[name="username"], input[name="password"], [aria-label="Phone number, username, or email"]'
  ).count()) > 0;
  return classifyInstagramPage(url, text, hasLoginForm);
}

/**
 * Check if Instagram session cookies indicate a logged-in user.
 * Instagram stores the session in the 'sessionid' cookie.
 */
export async function isInstagramLoggedIn(page: Page): Promise<boolean> {
  const cookies = await page.context().cookies('https://www.instagram.com');
  return cookies.some((c) => c.name === 'sessionid' && c.value.length > 0);
}
