import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0', ''])
  .optional()
  .transform((v) => v === 'true' || v === '1');

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  ROLE: z.enum(['api', 'worker', 'all']).default('all'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().positive().default(8080),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATABASE_URL: z.string().min(1).default('postgres://lxs:lxs@localhost:5432/lxs'),
  SESSION_SECRET: z.string().min(16).default('dev-only-session-secret-change-me'),
  SESSION_TTL_HOURS: z.coerce
    .number()
    .int()
    .positive()
    .default(24 * 7),
  COOKIE_SECURE: bool,
  CORS_ORIGINS: z
    .string()
    .default('http://localhost:3000,http://localhost:3010,http://localhost:5173'),
  DEV_AUTH_BYPASS: bool,
  INGEST_RATE_PER_MIN: z.coerce.number().int().positive().default(1200),
  API_RATE_PER_MIN: z.coerce.number().int().positive().default(1200),
  MAX_BODY_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(2 * 1024 * 1024),
  PUBLIC_URL: z.string().default('http://localhost:8080'),
  DEMO_MODE: bool,
  // Optional, unused at boot: the API never needs these to start.
  LLM_PROVIDER: z.string().optional(),
  LLM_API_KEY: z.string().optional(),
});

export type Env = z.infer<typeof EnvSchema>;

function load(): Env {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error('Invalid environment configuration:');
    for (const issue of parsed.error.issues)
      console.error(`  ${issue.path.join('.')}: ${issue.message}`);
    process.exit(1);
  }
  const env = parsed.data;
  if (env.NODE_ENV === 'production' && env.SESSION_SECRET === 'dev-only-session-secret-change-me') {
    console.error('SESSION_SECRET must be set in production');
    process.exit(1);
  }
  if (
    env.DEV_AUTH_BYPASS &&
    (env.NODE_ENV !== 'development' || !['127.0.0.1', '::1', 'localhost'].includes(env.HOST))
  ) {
    console.error('DEV_AUTH_BYPASS is allowed only in development when HOST is loopback');
    process.exit(1);
  }
  return env;
}

export const env: Env = load();
export const roleHasApi = env.ROLE === 'api' || env.ROLE === 'all';
export const roleHasWorker = env.ROLE === 'worker' || env.ROLE === 'all';
