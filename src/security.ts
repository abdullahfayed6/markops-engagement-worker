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

export function assertInstagramUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new ApiError('INVALID_POST_URL', 'postUrl must be a valid HTTPS Instagram URL.'); }
  if (url.protocol !== 'https:' || !config.allowedInstagramHosts.has(url.hostname.toLowerCase())) throw new ApiError('INVALID_POST_URL', 'postUrl must use an allowed Instagram hostname over HTTPS.');
  return url;
}

export function assertTikTokUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new ApiError('INVALID_POST_URL', 'postUrl must be a valid HTTPS TikTok URL.'); }
  if (url.protocol !== 'https:' || !config.allowedTikTokHosts.has(url.hostname.toLowerCase())) throw new ApiError('INVALID_POST_URL', 'postUrl must use an allowed TikTok hostname over HTTPS.');
  return url;
}

export function assertXUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new ApiError('INVALID_POST_URL', 'postUrl must be a valid HTTPS X URL.'); }
  if (url.protocol !== 'https:' || !config.allowedXHosts.has(url.hostname.toLowerCase())) throw new ApiError('INVALID_POST_URL', 'postUrl must use an allowed X hostname over HTTPS.');
  return url;
}
