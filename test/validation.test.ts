import { describe, expect, it } from 'vitest';
import { assertAccountId } from '../src/account-lock-manager.js';
import { assertFacebookUrl, isAuthorized } from '../src/security.js';
describe('account and URL validation', () => {
  it('accepts a safe account ID and rejects traversal', () => { expect(assertAccountId('account_1-a')).toBe('account_1-a'); expect(() => assertAccountId('../etc')).toThrow(); expect(() => assertAccountId('a/b')).toThrow(); });
  it('only accepts configured HTTPS Facebook hosts', () => { expect(assertFacebookUrl('https://www.facebook.com/example').hostname).toBe('www.facebook.com'); expect(() => assertFacebookUrl('https://evil.example/facebook.com')).toThrow(); expect(() => assertFacebookUrl('http://facebook.com/x')).toThrow(); });
  it('requires the exact worker secret', () => { expect(isAuthorized('test-worker-secret-with-adequate-length')).toBe(true); expect(isAuthorized('wrong')).toBe(false); });
});
