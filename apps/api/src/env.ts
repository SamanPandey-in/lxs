import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0', ''])
  .optional()
  .transform((v) => v === 'true' || v === '1');

/** Dev-only fallback; refused in production. Not 32 bytes of key material by itself: see parseEncryptionKey. */
export const DEV_ENCRYPTION_KEY = 'dev-only-encryption-key-change-me';
/** Dev-only credential pepper; refused in production. */
export const DEV_CREDENTIAL_PEPPER = 'dev-only-credential-pepper-change-me';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  ROLE: z.enum(['api', 'worker', 'all']).default('all'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().positive().default(8080),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATABASE_URL: z.string().min(1).default('postgres://lxs:lxs@localhost:5432/lxs'),
  SESSION_SECRET: z.string().min(16).default('dev-only-session-secret-change-me'),
  // 32 bytes, base64 or hex. Encrypts notification channel URLs and signing secrets.
  ENCRYPTION_KEY: z.string().min(1).default(DEV_ENCRYPTION_KEY),
  // Base URL of the dashboard, used for incident links in alerts.
  DASHBOARD_URL: z.string().url().default('http://localhost:3000'),
  // Development only: let alerts reach private/loopback receivers (local test webhooks).
  NOTIFY_ALLOW_PRIVATE: bool,
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
  INGEST_PROJECT_EVENTS_PER_MIN: z.coerce.number().int().positive().default(100_000),
  INGEST_PROJECT_BYTES_PER_MIN: z.coerce
    .number()
    .int()
    .positive()
    .default(256 * 1024 * 1024),
  INGEST_SENSOR_EVENTS_PER_MIN: z.coerce.number().int().positive().default(20_000),
  INGEST_SENSOR_BYTES_PER_MIN: z.coerce
    .number()
    .int()
    .positive()
    .default(64 * 1024 * 1024),
  API_RATE_PER_MIN: z.coerce.number().int().positive().default(1200),
  MAX_BODY_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(2 * 1024 * 1024),
  PUBLIC_URL: z.string().default('http://localhost:8080'),
  DEMO_MODE: bool,
  // Optional: without a real key every incident keeps its deterministic template summary.
  LLM_PROVIDER: z.string().optional(),
  LLM_API_KEY: z.string().optional(),
  LLM_MODEL: z.string().optional(),
  LLM_BASE_URL: z.string().optional(),
  LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(90_000),
  // Provider calls per project per UTC day; past it, incidents get the template.
  LLM_DAILY_CAP: z.coerce.number().int().nonnegative().default(200),
  LLM_DEBOUNCE_SECONDS: z.coerce.number().int().nonnegative().default(15),
  // Identity and tenancy. APP_URL is the dashboard origin used in emailed links.
  APP_URL: z.string().url().default('http://localhost:3000'),
  // console: log the mail (dev). resend: Resend HTTP API. smtp: not bundled yet (see lib/mailer.ts).
  MAIL_TRANSPORT: z.enum(['console', 'resend', 'smtp']).default('console'),
  MAIL_FROM: z.string().min(3).default('LXS <no-reply@lxs.dev>'),
  RESEND_API_KEY: z.string().optional(),
  SMTP_URL: z.string().optional(),
  // Bot check on signup and password-reset requests. none = off (default).
  CAPTCHA_PROVIDER: z.enum(['none', 'turnstile']).default('none'),
  TURNSTILE_SITE_KEY: z.string().optional(),
  TURNSTILE_SECRET_KEY: z.string().optional(),
  // Abuse limits (H1): per-organization caps and the signup rate per client IP.
  MAX_PROJECTS_PER_ORG: z.coerce.number().int().positive().default(5),
  MAX_KEYS_PER_ORG: z.coerce.number().int().positive().default(10),
  SIGNUP_RATE_PER_HOUR: z.coerce.number().int().positive().default(10),
  // Bearer token for GET /metrics. Unset: open in dev/test, disabled (404) in production.
  METRICS_TOKEN: z.string().min(16).optional(),
  // Weekly digest schedule (pg-boss cron, UTC). Default Monday 09:00. "off" disables it.
  DIGEST_CRON: z.string().min(1).default('0 9 * * 1'),
  // Data handling (H5/G11). Retention for the `free` plan (lib/plans.ts); other plans are fixed.
  RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(30),
  RAW_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(7),
  // Project exports: where finished bundles live and how long they can be downloaded.
  EXPORT_STORAGE: z.enum(['local', 's3']).default('local'),
  EXPORT_DIR: z.string().min(1).default('./var/exports'),
  EXPORT_S3_BUCKET: z.string().optional(),
  EXPORT_S3_PREFIX: z.string().default('exports/'),
  EXPORT_TTL_HOURS: z.coerce.number().int().positive().default(24),
  // Soft-deleted projects are purged for good after this many days (restorable until then).
  PROJECT_DELETE_GRACE_DAYS: z.coerce.number().int().min(0).max(90).default(7),
  // Attacker-typed passwords are replaced by a peppered hash after this many days. At least 2,
  // so hashing never touches events the correlator can still read back (24 h lookback).
  CREDENTIAL_HASH_DAYS: z.coerce.number().int().min(2).max(3650).default(30),
  // Per-deployment secret mixed into captured-credential hashes. Required in production.
  CREDENTIAL_PEPPER: z.string().min(16).default(DEV_CREDENTIAL_PEPPER),
});

export type Env = z.infer<typeof EnvSchema>;

/** 32 raw bytes from 64 hex chars or base64/base64url, else null. */
export function decodeKey32(v: string): Buffer | null {
  const s = v.trim();
  if (/^[0-9a-fA-F]{64}$/.test(s)) return Buffer.from(s, 'hex');
  if (/^[A-Za-z0-9+/_-]{43}={0,1}$/.test(s)) {
    const b = Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    if (b.length === 32) return b;
  }
  return null;
}

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
  if (env.NODE_ENV === 'production' && env.ENCRYPTION_KEY === DEV_ENCRYPTION_KEY) {
    console.error('ENCRYPTION_KEY must be set in production (32 bytes, base64 or hex)');
    process.exit(1);
  }
  if (env.ENCRYPTION_KEY !== DEV_ENCRYPTION_KEY && !decodeKey32(env.ENCRYPTION_KEY)) {
    console.error('ENCRYPTION_KEY must decode to exactly 32 bytes (base64 or 64 hex chars)');
    process.exit(1);
  }
  if (env.NODE_ENV === 'production' && env.CREDENTIAL_PEPPER === DEV_CREDENTIAL_PEPPER) {
    console.error('CREDENTIAL_PEPPER must be set in production (at least 16 characters)');
    process.exit(1);
  }
  if (env.EXPORT_STORAGE === 's3') {
    // The S3 adapter is a stub (worker/export-project.ts); refuse rather than fail per export.
    console.error('EXPORT_STORAGE=s3 is not implemented yet; use EXPORT_STORAGE=local');
    process.exit(1);
  }
  if (env.NODE_ENV === 'production' && env.NOTIFY_ALLOW_PRIVATE) {
    console.error('NOTIFY_ALLOW_PRIVATE is not allowed in production');
    process.exit(1);
  }
  if (
    env.DEV_AUTH_BYPASS &&
    (env.NODE_ENV !== 'development' || !['127.0.0.1', '::1', 'localhost'].includes(env.HOST))
  ) {
    console.error('DEV_AUTH_BYPASS is allowed only in development when HOST is loopback');
    process.exit(1);
  }
  if (env.MAIL_TRANSPORT === 'resend' && !env.RESEND_API_KEY) {
    console.error('MAIL_TRANSPORT=resend requires RESEND_API_KEY');
    process.exit(1);
  }
  if (
    env.CAPTCHA_PROVIDER === 'turnstile' &&
    !(env.TURNSTILE_SECRET_KEY && env.TURNSTILE_SITE_KEY)
  ) {
    console.error(
      'CAPTCHA_PROVIDER=turnstile requires TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY',
    );
    process.exit(1);
  }
  return env;
}

export const env: Env = load();
export const roleHasApi = env.ROLE === 'api' || env.ROLE === 'all';
export const roleHasWorker = env.ROLE === 'worker' || env.ROLE === 'all';
