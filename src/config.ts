import { z } from 'zod';

const configSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  WORKER_SECRET: z.string().min(24),
  PROFILE_ROOT: z.string().min(1).default('/data/accounts'),
  MAX_ACTIVE_BROWSERS: z.coerce.number().int().min(1).default(2),
  SESSION_TIMEOUT_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
  PUBLIC_BASE_URL: z.string().url(),
  FACEBOOK_ALLOWED_HOSTS: z.string().default('facebook.com,www.facebook.com,m.facebook.com'),
  MARKOPS_URL: z.string().url().optional()
});

const testDefaults = process.env.VITEST ? { WORKER_SECRET: 'test-worker-secret-with-adequate-length', PUBLIC_BASE_URL: 'http://localhost:3000' } : {};
const parsed = configSchema.parse({ ...testDefaults, ...process.env });
export const config = { ...parsed, allowedFacebookHosts: new Set(parsed.FACEBOOK_ALLOWED_HOSTS.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean)) };
