/**
 * Outbound email. One `Mailer` interface, transports picked by `MAIL_TRANSPORT`:
 *
 * - `console` (dev default): writes the whole message, links included, to stdout,
 *   so verification, reset and invite flows can be completed locally without a
 *   provider. Never use it in production: the links are bearer secrets.
 * - `resend`: Resend's HTTP API (`RESEND_API_KEY`). Plain `fetch`, no SDK.
 * - `smtp`: not bundled. TODO: add `nodemailer` (or similar) and implement
 *   `SmtpMailer` against `SMTP_URL`. Until then selecting it fails at boot,
 *   loudly, rather than silently dropping mail.
 */
import { env } from '../env.js';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface Mailer {
  readonly transport: 'console' | 'resend' | 'smtp' | 'memory';
  send(message: MailMessage): Promise<void>;
}

export class ConsoleMailer implements Mailer {
  readonly transport = 'console' as const;
  constructor(
    private readonly from: string,
    private readonly write: (line: string) => void = (line) => console.log(line),
  ) {}

  async send(m: MailMessage): Promise<void> {
    this.write(
      [
        '──── mail (console transport) ────',
        `From:    ${this.from}`,
        `To:      ${m.to}`,
        `Subject: ${m.subject}`,
        '',
        m.text,
        '──────────────────────────────────',
      ].join('\n'),
    );
  }
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export class ResendMailer implements Mailer {
  readonly transport = 'resend' as const;
  constructor(
    private readonly apiKey: string,
    private readonly from: string,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  async send(m: MailMessage): Promise<void> {
    const res = await this.fetchImpl('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: this.from,
        to: [m.to],
        subject: m.subject,
        text: m.text,
        ...(m.html ? { html: m.html } : {}),
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Resend refused the message (HTTP ${res.status}): ${body.slice(0, 200)}`);
    }
  }
}

/** Test double: keeps every message in memory. */
export class MemoryMailer implements Mailer {
  readonly transport = 'memory' as const;
  readonly sent: MailMessage[] = [];
  async send(m: MailMessage): Promise<void> {
    this.sent.push(m);
  }
}

export function createMailer(cfg: {
  MAIL_TRANSPORT: 'console' | 'resend' | 'smtp';
  MAIL_FROM: string;
  RESEND_API_KEY?: string;
}): Mailer {
  switch (cfg.MAIL_TRANSPORT) {
    case 'console':
      return new ConsoleMailer(cfg.MAIL_FROM);
    case 'resend':
      if (!cfg.RESEND_API_KEY) throw new Error('MAIL_TRANSPORT=resend requires RESEND_API_KEY');
      return new ResendMailer(cfg.RESEND_API_KEY, cfg.MAIL_FROM);
    case 'smtp':
      // TODO(identity): implement SmtpMailer once an SMTP client dependency is approved.
      throw new Error(
        'MAIL_TRANSPORT=smtp is not implemented yet (no SMTP client is bundled). Use resend or console.',
      );
  }
}

let current: Mailer | null = null;

/** The process-wide mailer, created on first use from env. */
export function mailer(): Mailer {
  current ??= createMailer(env);
  return current;
}

/** Swap the mailer (tests). Returns the previous one. */
export function setMailer(m: Mailer | null): Mailer | null {
  const prev = current;
  current = m;
  return prev;
}

/**
 * Send without making the caller wait or fail: request handlers must answer in the
 * same time whether or not a mail went out (no account enumeration by timing).
 */
export function sendInBackground(
  message: MailMessage,
  log: { error: (obj: unknown, msg?: string) => void },
): void {
  void mailer()
    .send(message)
    .catch((err: unknown) => log.error({ err, to: message.to }, 'mail delivery failed'));
}

/** Absolute dashboard link: `APP_URL` + path + query. */
export function appLink(
  path: string,
  query: Record<string, string> = {},
  base = env.APP_URL,
): string {
  const url = new URL(path, base.endsWith('/') ? base : `${base}/`);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  return url.toString();
}

/* ------------------------------- templates ------------------------------- */

const footer = '\n\nIf you did not expect this email, you can ignore it.\n— LXS';

export function verifyEmailMessage(to: string, link: string): MailMessage {
  return {
    to,
    subject: 'Verify your LXS email address',
    text: `Confirm this address to finish setting up your LXS account:\n\n${link}\n\nThe link works once and expires in 24 hours.${footer}`,
  };
}

export function resetPasswordMessage(to: string, link: string): MailMessage {
  return {
    to,
    subject: 'Reset your LXS password',
    text: `Someone asked to reset the password for this LXS account. To choose a new one, open:\n\n${link}\n\nThe link works once and expires in 30 minutes. Resetting signs out every other session.${footer}`,
  };
}

export function inviteMessage(
  to: string,
  link: string,
  opts: { orgName: string; inviter: string; role: string },
): MailMessage {
  return {
    to,
    subject: `You're invited to ${opts.orgName} on LXS`,
    text: `${opts.inviter} invited you to join ${opts.orgName} on LXS as ${/^[aeiou]/.test(opts.role) ? 'an' : 'a'} ${opts.role}.\n\nAccept the invitation:\n\n${link}\n\nThe link expires in 7 days.${footer}`,
  };
}
