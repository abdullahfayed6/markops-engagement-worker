import { z } from 'zod';

const configSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  WORKER_SECRET: z.string().min(24),
  PROFILE_ROOT: z.string().min(1).default('/data/accounts'),
  MAX_ACTIVE_BROWSERS: z.coerce.number().int().min(1).default(1),
  SESSION_TIMEOUT_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
  PUBLIC_BASE_URL: z.string().url(),
  MARKOPS_URL: z.string().url().optional()
});

export const config = configSchema.parse(process.env);
