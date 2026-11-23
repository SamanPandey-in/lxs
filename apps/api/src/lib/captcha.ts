/**
 * Captcha hook for public forms (signup, password-reset request). Off unless
 * `CAPTCHA_PROVIDER=turnstile`; then the client sends `captcha_token` and it is
 * verified server-side against Cloudflare's siteverify endpoint.
 */
import { env } from '../env.js';
import { HttpError } from './errors.js';

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface CaptchaConfig {
  provider: 'none' | 'turnstile';
  secret?: string;
}

export const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/** Public part of the configuration, for the dashboard to render the widget. */
export function captchaPublicConfig(): { provider: 'none' | 'turnstile'; site_key: string | null } {
  return {
    provider: env.CAPTCHA_PROVIDER,
    site_key: env.CAPTCHA_PROVIDER === 'turnstile' ? (env.TURNSTILE_SITE_KEY ?? null) : null,
  };
}

/** Throws 400 `E_CAPTCHA` when the provider is on and the token does not verify. */
export async function verifyCaptcha(
  token: unknown,
  remoteIp: string | undefined,
  cfg: CaptchaConfig = { provider: env.CAPTCHA_PROVIDER, secret: env.TURNSTILE_SECRET_KEY },
  fetchImpl: FetchLike = fetch,
): Promise<void> {
  if (cfg.provider === 'none') return;
  const fail = () => new HttpError(400, 'E_CAPTCHA', 'Complete the bot check and try again.');
  if (typeof token !== 'string' || token.length === 0 || token.length > 2048) throw fail();
  const form = new URLSearchParams({ secret: cfg.secret ?? '', response: token });
  if (remoteIp) form.set('remoteip', remoteIp);
  let ok = false;
  try {
    const res = await fetchImpl(TURNSTILE_VERIFY_URL, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(8_000),
    });
    const body = (await res.json().catch(() => null)) as { success?: boolean } | null;
    ok = res.ok && body?.success === true;
  } catch {
    ok = false; // fail closed: an unreachable verifier must not wave bots through
  }
  if (!ok) throw fail();
}
