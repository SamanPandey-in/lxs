import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { checkLiteralHost, type Resolver, SsrfError, safeLookup } from './ssrf.js';

/* ───────── types and ranks ───────── */

export const SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;
export type Severity = (typeof SEVERITIES)[number];
export const severityRank = (s: string): number => SEVERITIES.indexOf(s as Severity);

export interface AlertIncident {
  id: string;
  number: number;
  title: string;
  severity: string;
  score: number;
  label: string;
  srcIp: string;
  stages: string[];
  techniques: string[];
  realAssetReached: boolean;
  honeytokenUsed: boolean;
}

export interface ChannelFilter {
  enabled: boolean;
  minSeverity: string;
  labels: string[];
}

/** Severity at or above the channel minimum, and label in the channel's list (empty list = any). */
export function matchesChannel(c: ChannelFilter, i: { severity: string; label: string }): boolean {
  if (!c.enabled) return false;
  const min = severityRank(c.minSeverity);
  const sev = severityRank(i.severity);
  if (sev < 0 || sev < (min < 0 ? severityRank('high') : min)) return false;
  return c.labels.length === 0 || c.labels.includes(i.label);
}

/* ───────── dedupe / cooldown ───────── */

/** A climbing chain pages at most once per step per incident, and is throttled per attacker. */
export const COOLDOWN_MS = 10 * 60 * 1000;

export interface PriorDelivery {
  incidentId: string | null;
  severity: string;
  status: string; // sending | ok | failed
  createdAt: Date;
}

export interface Sibling {
  id: string;
  severity: string;
  label: string;
  openedAt: Date;
}

export type Decision =
  | { action: 'send' }
  | { action: 'skip'; reason: 'filtered' | 'duplicate' | 'superseded' | 'cooldown' }
  | { action: 'defer'; until: Date };

/**
 * Decide whether to page channel C about incident I.
 *
 * - `prior`: this channel's deliveries for the same attacker (any incident), newest first.
 * - `siblings`: the attacker's other open incidents in the project.
 *
 * Rules, in order:
 * 1. Channel filter (min_severity, labels, enabled).
 * 2. One message per incident per severity step: skip when this incident already paged at
 *    this severity or higher.
 * 3. A newer open incident from the same attacker at the same or higher severity (that this
 *    channel would also accept) supersedes this one (it gets its own job), so a replay that opens several incidents pages once.
 * 4. Cooldown per attacker: within COOLDOWN_MS of a page, a same-or-lower severity is skipped;
 *    a higher non-critical step is deferred to the end of the cooldown (sent then only if it is
 *    still above what was paged). Critical always goes out once, immediately.
 * Failed deliveries never count as "already paged".
 */
export function decide(input: {
  channel: ChannelFilter;
  incident: { id: string; severity: string; label: string; openedAt: Date };
  prior: PriorDelivery[];
  siblings: Sibling[];
  now: Date;
  cooldownMs?: number;
}): Decision {
  const { channel, incident, now } = input;
  const cooldown = input.cooldownMs ?? COOLDOWN_MS;
  if (!matchesChannel(channel, incident)) return { action: 'skip', reason: 'filtered' };
  const rank = severityRank(incident.severity);
  const live = input.prior.filter((p) => p.status === 'ok' || p.status === 'sending');

  if (live.some((p) => p.incidentId === incident.id && severityRank(p.severity) >= rank))
    return { action: 'skip', reason: 'duplicate' };

  if (
    input.siblings.some(
      (s) =>
        s.id !== incident.id &&
        s.openedAt.getTime() > incident.openedAt.getTime() &&
        severityRank(s.severity) >= rank &&
        matchesChannel(channel, s),
    )
  )
    return { action: 'skip', reason: 'superseded' };

  const recent = live.filter((p) => now.getTime() - p.createdAt.getTime() < cooldown);
  if (recent.length === 0) return { action: 'send' };
  const maxRecent = Math.max(...recent.map((p) => severityRank(p.severity)));
  if (rank <= maxRecent) return { action: 'skip', reason: 'cooldown' };
  if (incident.severity === 'critical') return { action: 'send' };
  const oldest = Math.min(...recent.map((p) => p.createdAt.getTime()));
  return { action: 'defer', until: new Date(oldest + cooldown) };
}

/* ───────── formatters ───────── */

const SEV_LABEL: Record<string, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  critical: 'Critical',
};
const sevLabel = (s: string) => SEV_LABEL[s] ?? s;

export const incidentUrl = (dashboardUrl: string, id: string): string =>
  `${dashboardUrl.replace(/\/+$/, '')}/incidents/${encodeURIComponent(id)}`;

export function killChainSummary(i: Pick<AlertIncident, 'stages' | 'techniques'>): string {
  const stages = i.stages.length ? i.stages.join(' → ') : 'no stages reached';
  const t = i.techniques.length;
  return `${stages} (${t} technique${t === 1 ? '' : 's'})`;
}

/** Slack's mrkdwn treats &, < and > as control characters. */
const slackEscape = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Interactive buttons (need a Slack app; see docs/ALERTS.md). Handled by modules/integrations-slack.ts. */
export const SLACK_ACTIONS = {
  block: 'lxs_block_24h',
  ignore: 'lxs_ignore',
  undo: 'lxs_undo_block',
} as const;
export const SLACK_RESPONSE_BLOCK_ID = 'lxs_response';

/** Button value: which project and incident the click is about (the signature is checked per project). */
export const slackActionValue = (projectId: string, incidentId: string, blockId?: string): string =>
  JSON.stringify({ p: projectId, i: incidentId, ...(blockId && { b: blockId }) });

export function formatSlack(
  i: AlertIncident,
  dashboardUrl: string,
  /** Set only when the project has a Slack app configured: adds Block 24h / Ignore on Critical. */
  interactive?: { projectId: string },
): Record<string, unknown> {
  const url = incidentUrl(dashboardUrl, i.id);
  const headline = `[${sevLabel(i.severity)}] #${i.number} ${i.title}`;
  const flags = [
    i.realAssetReached ? 'real asset reached' : null,
    i.honeytokenUsed ? 'honeytoken used' : null,
  ].filter(Boolean);
  return {
    text: `${headline} (${i.srcIp}, score ${i.score})`,
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: headline.slice(0, 150), emoji: false } },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Severity*\n${sevLabel(i.severity)}` },
          { type: 'mrkdwn', text: `*Score*\n${i.score}` },
          { type: 'mrkdwn', text: `*Attacker IP*\n\`${slackEscape(i.srcIp)}\`` },
          { type: 'mrkdwn', text: `*Label*\n${slackEscape(i.label)}` },
        ],
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Kill chain*\n${slackEscape(killChainSummary(i))}${flags.length ? `\n*Flags:* ${flags.join(', ')}` : ''}`,
        },
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: 'Open incident' },
            url,
            style: i.severity === 'critical' ? 'danger' : 'primary',
          },
        ],
      },
      ...(interactive && i.severity === 'critical'
        ? [
            {
              type: 'actions',
              block_id: SLACK_RESPONSE_BLOCK_ID,
              elements: [
                {
                  type: 'button',
                  action_id: SLACK_ACTIONS.block,
                  text: { type: 'plain_text', text: 'Block 24h' },
                  style: 'danger',
                  value: slackActionValue(interactive.projectId, i.id),
                  confirm: {
                    title: { type: 'plain_text', text: 'Block this source?' },
                    text: {
                      type: 'mrkdwn',
                      text: `Block \`${slackEscape(i.srcIp)}\` on every sensor for 24 hours.`,
                    },
                    confirm: { type: 'plain_text', text: 'Block 24h' },
                    deny: { type: 'plain_text', text: 'Cancel' },
                  },
                },
                {
                  type: 'button',
                  action_id: SLACK_ACTIONS.ignore,
                  text: { type: 'plain_text', text: 'Ignore' },
                  value: slackActionValue(interactive.projectId, i.id),
                },
              ],
            },
          ]
        : []),
    ],
  };
}

export function formatWebhook(
  i: AlertIncident,
  dashboardUrl: string,
  projectId: string,
  now = new Date(),
): Record<string, unknown> {
  return {
    type: 'incident.alert',
    sent_at: now.toISOString(),
    project_id: projectId,
    incident: {
      id: i.id,
      number: i.number,
      title: i.title,
      severity: i.severity,
      score: i.score,
      label: i.label,
      attacker_ip: i.srcIp,
      stages: i.stages,
      techniques: i.techniques,
      real_asset_reached: i.realAssetReached,
      honeytoken_used: i.honeytokenUsed,
      kill_chain: killChainSummary(i),
      url: incidentUrl(dashboardUrl, i.id),
    },
  };
}

export function formatTest(
  type: string,
  channelName: string,
  dashboardUrl: string,
  projectId: string,
  now = new Date(),
): Record<string, unknown> {
  const text = `LXS test alert for channel "${channelName}". Delivery works.`;
  if (type === 'slack')
    return {
      text,
      blocks: [
        { type: 'section', text: { type: 'mrkdwn', text: slackEscape(text) } },
        {
          type: 'context',
          elements: [{ type: 'mrkdwn', text: `Sent ${now.toISOString()} from ${dashboardUrl}` }],
        },
      ],
    };
  return { type: 'test', sent_at: now.toISOString(), project_id: projectId, message: text };
}

/* ───────── signing ───────── */

export const generateSigningSecret = (): string => `whsec_${randomBytes(32).toString('base64url')}`;

/** `X-LXS-Signature: t=<unix>,v1=<hex hmac-sha256(secret, "<t>.<body>")>` */
export function signatureHeader(secret: string, body: string, t: number): string {
  const v1 = createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
  return `t=${t},v1=${v1}`;
}

/** Receiver-side check (exported for tests and as the reference for the docs). */
export function verifySignature(
  secret: string,
  body: string,
  header: string,
  toleranceSec = 300,
  nowSec = Math.floor(Date.now() / 1000),
): boolean {
  const parts = Object.fromEntries(
    header.split(',').map((kv) => {
      const i = kv.indexOf('=');
      return [kv.slice(0, i).trim(), kv.slice(i + 1).trim()];
    }),
  );
  const t = Number(parts.t);
  if (!Number.isInteger(t) || Math.abs(nowSec - t) > toleranceSec || !parts.v1) return false;
  const expected = Buffer.from(signatureHeader(secret, body, t).split('v1=')[1]!, 'hex');
  const given = Buffer.from(String(parts.v1), 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/* ───────── transport ───────── */

export interface DeliveryResult {
  delivered: boolean;
  status: number | null;
  error: string | null;
}

export interface PostOptions {
  timeoutMs?: number;
  allowPrivate?: boolean;
  resolver?: Resolver;
}

export const DELIVERY_TIMEOUT_MS = 5000;

/**
 * POST a JSON body. Never follows redirects, gives up after `timeoutMs` in total, and
 * connects only to addresses that pass the SSRF check at connect time. Never throws.
 */
export function postJson(
  url: string,
  body: string,
  headers: Record<string, string>,
  opts: PostOptions = {},
): Promise<DeliveryResult> {
  const timeoutMs = opts.timeoutMs ?? DELIVERY_TIMEOUT_MS;
  return new Promise((resolve) => {
    let settled = false;
    const done = (r: DeliveryResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    let u: URL;
    try {
      u = new URL(url);
      if (u.protocol !== 'https:' && u.protocol !== 'http:')
        throw new SsrfError(`refused: unsupported scheme ${u.protocol}`);
      checkLiteralHost(u.hostname, !!opts.allowPrivate);
    } catch (err) {
      return resolve({ delivered: false, status: null, error: errMessage(err) });
    }
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(
      u,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': String(Buffer.byteLength(body)),
          'user-agent': 'LXS-Alerts/1',
          ...headers,
        },
        lookup: safeLookup({ allowPrivate: opts.allowPrivate, resolver: opts.resolver }),
        agent: false,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        let snippet = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => {
          if (snippet.length < 200) snippet += c;
        });
        res.on('error', () => {});
        res.on('end', () => {
          if (status >= 200 && status < 300) done({ delivered: true, status, error: null });
          else if (status >= 300 && status < 400)
            done({ delivered: false, status, error: `redirect refused (HTTP ${status})` });
          else
            done({
              delivered: false,
              status,
              error: `HTTP ${status}${snippet ? `: ${snippet.trim().slice(0, 200)}` : ''}`,
            });
        });
      },
    );
    const timer = setTimeout(() => {
      done({ delivered: false, status: null, error: `timeout after ${timeoutMs} ms` });
      req.destroy();
    }, timeoutMs);
    req.on('error', (err) => done({ delivered: false, status: null, error: errMessage(err) }));
    req.end(body);
  });
}

function errMessage(err: unknown): string {
  const e = err as { message?: string; code?: string };
  const m = e?.message || String(err);
  return (e?.code && !m.includes(e.code) ? `${e.code}: ${m}` : m).slice(0, 300);
}

/** Build and send one message for a channel. */
export function sendToChannel(
  ch: { type: string; url: string; secret: string | null },
  payload: Record<string, unknown>,
  opts: PostOptions & { now?: Date } = {},
): Promise<DeliveryResult> {
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = {};
  if (ch.type !== 'slack' && ch.secret) {
    const t = Math.floor((opts.now ?? new Date()).getTime() / 1000);
    headers['x-lxs-signature'] = signatureHeader(ch.secret, body, t);
  }
  return postJson(ch.url, body, headers, opts);
}
