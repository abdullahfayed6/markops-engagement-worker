import { timingSafeEqual } from 'node:crypto';
import { config } from './config.js';
import { ApiError } from './types.js';

export function isAuthorized(value: string | undefined): boolean {
  if (!value) return false;
  const supplied = Buffer.from(value); const expected = Buffer.from(config.WORKER_SECRET);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

export function assertFacebookUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new ApiError('INVALID_POST_URL', 'postUrl must be a valid HTTPS Facebook URL.'); }
  if (url.protocol !== 'https:' || !config.allowedFacebookHosts.has(url.hostname.toLowerCase())) throw new ApiError('INVALID_POST_URL', 'postUrl must use an allowed Facebook hostname over HTTPS.');
  return url;
}
