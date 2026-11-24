import { createHmac, timingSafeEqual } from 'node:crypto';
import { and, sql as dsql, eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { db } from '../db/client.js';
import {
  attackers,
  incidents,
  memberships,
  organizations,
  projects,
  responsePolicies,
  slackIntegrations,
  slackUserLinks,
  users,
} from '../db/schema.js';
import { env } from '../env.js';
import {
  postJson,
  SLACK_ACTIONS,
  SLACK_RESPONSE_BLOCK_ID,
  slackActionValue,
} from '../lib/alert-delivery.js';
import { audit } from '../lib/audit.js';
import { parseRanges, targetGuard } from '../lib/auto-block.js';
import { decryptSecret, encryptSecret } from '../lib/channel-crypto.js';
import { HttpError, invalid, notFound } from '../lib/errors.js';
import { STREAM_CHANNEL, streamPayload } from '../lib/notify.js';
import { parse } from '../lib/parse.js';
import { iso } from '../lib/serialize.js';
import {
  isUuid,
  projectAccess,
  type Role,
  requireSession,
  roleAtLeast,
} from '../plugins/auth-session.js';
import { blockIp, unblockIp } from './response.js';

/**
 * Block from Slack. Incoming webhooks cannot carry buttons that call back to us, so this needs a
 * Slack app per project (its signing secret, optionally its bot token). Slack posts button
 * clicks to POST /v1/integrations/slack/actions; that route has no session: it is authenticated
 * by the Slack signature of the project named in the button, checked with that project's secret.
 */

/* ───────── signature (pure) ───────── */

export const SLACK_TOLERANCE_SEC = 300;

export const slackSignature = (secret: string, timestamp: string, body: string): string =>
  `v0=${createHmac('sha256', secret).update(`v0:${timestamp}:${body}`).digest('hex')}`;

/** `X-Slack-Signature` v0 over `v0:<timestamp>:<raw body>`, 5 minute window, constant-time compare. */
export function verifySlackSignature(p: {
  secret: string;
  body: string;
  timestamp: string | undefined;
  signature: string | undefined;
  nowSec?: number;
  toleranceSec?: number;
}): boolean {
  const now = p.nowSec ?? Math.floor(Date.now() / 1000);
  if (!p.timestamp || !/^\d{1,12}$/.test(p.timestamp) || !p.signature) return false;
  if (Math.abs(now - Number(p.timestamp)) > (p.toleranceSec ?? SLACK_TOLERANCE_SEC)) return false;
  if (!/^v0=[0-9a-f]{64}$/.test(p.signature)) return false;
  const want = Buffer.from(slackSignature(p.secret, p.timestamp, p.body), 'utf8');
  const got = Buffer.from(p.signature, 'utf8');
  return got.length === want.length && timingSafeEqual(got, want);
}

/* ───────── payload (pure) ───────── */

export interface SlackActionValue {
  p: string;
  i: string;
  b?: string;
}

export interface ParsedSlackAction {
  actionId: string;
  value: SlackActionValue;
  user: { id: string; name: string | null };
  teamId: string | null;
  responseUrl: string | null;
  messageBlocks: Record<string, unknown>[];
}

/** Parse the form-encoded `payload=` of a block_actions request. Null when it is not one of ours. */
export function parseSlackAction(rawBody: string): ParsedSlackAction | null {
  let payload: Record<string, unknown>;
  try {
    const p = new URLSearchParams(rawBody).get('payload');
    if (!p) return null;
    payload = JSON.parse(p) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (payload.type !== 'block_actions' || !Array.isArray(payload.actions)) return null;
  const a = payload.actions[0] as { action_id?: unknown; value?: unknown } | undefined;
  if (!a || typeof a.action_id !== 'string' || typeof a.value !== 'string') return null;
  let value: SlackActionValue;
  try {
    value = JSON.parse(a.value) as SlackActionValue;
  } catch {
    return null;
  }
  if (!value || typeof value.p !== 'string' || typeof value.i !== 'string') return null;
  if (!isUuid(value.p) || !isUuid(value.i) || (value.b !== undefined && !isUuid(value.b)))
    return null;
  const user = (payload.user ?? {}) as { id?: unknown; username?: unknown; name?: unknown };
  if (typeof user.id !== 'string' || !/^[UW][A-Z0-9]{2,20}$/.test(user.id)) return null;
  const team = (payload.team ?? {}) as { id?: unknown };
  const message = (payload.message ?? {}) as { blocks?: unknown };
  return {
    actionId: a.action_id,
    value,
    user: {
      id: user.id,
      name:
        typeof user.username === 'string'
          ? user.username
          : typeof user.name === 'string'
            ? user.name
            : null,
    },
    teamId: typeof team.id === 'string' ? team.id : null,
    responseUrl: typeof payload.response_url === 'string' ? payload.response_url : null,
    messageBlocks: Array.isArray(message.blocks)
      ? (message.blocks as Record<string, unknown>[])
      : [],
  };
}

/** Only Slack's own response URLs are ever posted to. */
export const isSlackResponseUrl = (u: string | null): u is string => {
  if (!u) return false;
  try {
    const url = new URL(u);
    return url.protocol === 'https:' && url.hostname === 'hooks.slack.com' && !url.port;
  } catch {
    return false;
  }
};

const STATUS_BLOCK_ID = 'lxs_response_status';

/** The original alert with its response buttons replaced by a status line (+ next action). */
export function updatedMessage(
  original: Record<string, unknown>[],
  status: string,
  next?: { actionId: string; label: string; value: string; style?: 'danger' | 'primary' },
): Record<string, unknown> {
  const kept = original.filter(
    (b) => b.block_id !== SLACK_RESPONSE_BLOCK_ID && b.block_id !== STATUS_BLOCK_ID,
  );
  const blocks: Record<string, unknown>[] = [
    ...kept,
    {
      type: 'context',
      block_id: STATUS_BLOCK_ID,
      elements: [{ type: 'mrkdwn', text: status }],
    },
  ];
  if (next)
    blocks.push({
      type: 'actions',
      block_id: SLACK_RESPONSE_BLOCK_ID,
      elements: [
        {
          type: 'button',
          action_id: next.actionId,
          text: { type: 'plain_text', text: next.label },
          value: next.value,
          ...(next.style && { style: next.style }),
        },
      ],
    });
  return { replace_original: true, text: status, blocks };
}

const ephemeral = (text: string) => ({
  response_type: 'ephemeral',
  replace_original: false,
  text,
});

/* ───────── transport (swappable in tests) ───────── */

export interface SlackTransport {
  /** users.info with the bot token; the member's email, or null. */
  userEmail(botToken: string, slackUserId: string): Promise<string | null>;
  /** POST to the action's response_url. */
  respond(responseUrl: string, body: Record<string, unknown>): Promise<void>;
}

const httpTransport: SlackTransport = {
  async userEmail(token, userId) {
    try {
      const res = await fetch(
        `https://slack.com/api/users.info?user=${encodeURIComponent(userId)}`,
        {
          headers: { authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(2500),
          redirect: 'error',
        },
      );
      const body = (await res.json()) as { ok?: boolean; user?: { profile?: { email?: string } } };
      return body.ok ? (body.user?.profile?.email ?? null) : null;
    } catch {
      return null;
    }
  },
  async respond(url, body) {
    if (!isSlackResponseUrl(url)) return;
    await postJson(url, JSON.stringify(body), {});
  },
};

let transport: SlackTransport = httpTransport;
/** Tests: replace the Slack HTTP calls. Returns the previous transport. */
export function setSlackTransport(t: SlackTransport): SlackTransport {
  const prev = transport;
  transport = t;
  return prev;
}

/* ───────── helpers used elsewhere ───────── */

/** For the alert formatter: interactive buttons only when the project has a Slack app. */
export async function slackInteractive(
  projectId: string,
): Promise<{ projectId: string } | undefined> {
  try {
    const [row] = await db
      .select({ projectId: slackIntegrations.projectId })
      .from(slackIntegrations)
      .where(eq(slackIntegrations.projectId, projectId))
      .limit(1);
    return row ? { projectId } : undefined;
  } catch {
    return undefined;
  }
}

const denied = () =>
  new HttpError(401, 'invalid_signature', 'Slack request signature verification failed');

async function resolveMember(
  integration: typeof slackIntegrations.$inferSelect,
  orgId: string,
  slackUserId: string,
): Promise<{ userId: string; role: Role; via: 'email' | 'link' } | { error: string }> {
  let userId: string | null = null;
  let via: 'email' | 'link' = 'link';
  if (integration.botTokenEncrypted) {
    let token: string;
    try {
      token = decryptSecret(integration.botTokenEncrypted);
    } catch {
      return { error: 'The Slack bot token cannot be decrypted (check ENCRYPTION_KEY).' };
    }
    const email = await transport.userEmail(token, slackUserId);
    if (email) {
      const [u] = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, email.trim().toLowerCase()))
        .limit(1);
      if (u) {
        userId = u.id;
        via = 'email';
      }
    }
  }
  if (!userId) {
    const [link] = await db
      .select({ userId: slackUserLinks.userId })
      .from(slackUserLinks)
      .where(
        and(
          eq(slackUserLinks.projectId, integration.projectId),
          eq(slackUserLinks.slackUserId, slackUserId),
        ),
      )
      .limit(1);
    userId = link?.userId ?? null;
  }
  if (!userId)
    return {
      error:
        'Your Slack account is not linked to an LXS member of this project. Ask an owner to link it in Settings → Response.',
    };
  const [m] = await db
    .select({ role: memberships.role, disabledAt: organizations.disabledAt })
    .from(memberships)
    .innerJoin(organizations, eq(organizations.id, memberships.orgId))
    .where(and(eq(memberships.orgId, orgId), eq(memberships.userId, userId)))
    .limit(1);
  if (!m) return { error: 'You are not a member of this LXS project.' };
  if (m.disabledAt) return { error: 'This LXS organization is disabled.' };
  return { userId, role: m.role as Role, via };
}

/* ───────── routes ───────── */

const SlackConfig = z.object({
  signing_secret: z
    .string()
    .trim()
    .regex(
      /^[A-Za-z0-9]{16,128}$/,
      'signing_secret must be the app signing secret (letters and digits)',
    )
    .optional(),
  bot_token: z
    .string()
    .trim()
    .regex(/^xoxb-[A-Za-z0-9-]{10,250}$/, 'bot_token must be a bot token starting with xoxb-')
    .nullable()
    .optional(),
  team_id: z
    .string()
    .trim()
    .regex(/^T[A-Z0-9]{2,20}$/, 'team_id must look like T0123ABCD')
    .nullable()
    .optional(),
});

const UserLinks = z.object({
  links: z
    .array(
      z.object({
        slack_user_id: z
          .string()
          .regex(/^[UW][A-Z0-9]{2,20}$/, 'slack_user_id must look like U0123ABCD'),
        user_id: z.string().uuid(),
      }),
    )
    .max(200),
});

export async function slackIntegrationRoutes(app: FastifyInstance): Promise<void> {
  // Slack posts application/x-www-form-urlencoded. Keep the raw string: the signature covers it.
  // Encapsulated: this parser applies to this plugin's routes only.
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string', bodyLimit: 256 * 1024 },
    (_req: FastifyRequest, body: string | Buffer, done: (e: Error | null, b?: unknown) => void) =>
      done(null, typeof body === 'string' ? body : body.toString('utf8')),
  );

  app.post('/v1/integrations/slack/actions', async (req, reply) => {
    const raw = req.body;
    if (typeof raw !== 'string') throw denied();
    const ts = req.headers['x-slack-request-timestamp'];
    const sig = req.headers['x-slack-signature'];
    const timestamp = typeof ts === 'string' ? ts : undefined;
    const signature = typeof sig === 'string' ? sig : undefined;
    // Cheap checks before any lookup: a stale or missing timestamp is refused outright.
    if (
      !timestamp ||
      !/^\d{1,12}$/.test(timestamp) ||
      Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp)) > SLACK_TOLERANCE_SEC
    )
      throw denied();
    const action = parseSlackAction(raw);
    if (!action) throw denied();
    const [integration] = await db
      .select()
      .from(slackIntegrations)
      .where(eq(slackIntegrations.projectId, action.value.p))
      .limit(1);
    if (!integration) throw denied();
    let secret: string;
    try {
      secret = decryptSecret(integration.signingSecretEncrypted);
    } catch {
      throw denied();
    }
    // The secret is the button's project's own: a valid signature for project A never acts on B.
    if (!verifySlackSignature({ secret, body: raw, timestamp, signature })) throw denied();
    if (integration.teamId && action.teamId !== integration.teamId) throw denied();

    const respond = (body: Record<string, unknown>) => {
      if (!isSlackResponseUrl(action.responseUrl)) return;
      void transport.respond(action.responseUrl, body).catch(() => {});
    };
    const done = () => reply.status(200).send('');

    const [row] = await db
      .select({ incident: incidents, project: projects, ip: attackers.ip })
      .from(incidents)
      .innerJoin(projects, eq(projects.id, incidents.projectId))
      .innerJoin(attackers, eq(attackers.id, incidents.attackerId))
      .where(and(eq(incidents.id, action.value.i), eq(incidents.projectId, integration.projectId)))
      .limit(1);
    if (!row) {
      respond(ephemeral('LXS: that incident no longer exists in this project.'));
      return done();
    }
    const { incident, project } = row;
    const ip = String(row.ip);
    const slackMeta = {
      via: 'slack',
      slack_user_id: action.user.id,
      slack_user_name: action.user.name,
      slack_team_id: action.teamId,
    };

    const member = await resolveMember(integration, project.orgId, action.user.id);
    if ('error' in member) {
      await audit(db, {
        orgId: project.orgId,
        projectId: project.id,
        actorType: 'system',
        actorId: 'slack',
        action: 'response.slack.denied',
        targetType: 'incident',
        targetId: incident.id,
        metadata: { ...slackMeta, action: action.actionId, reason: member.error },
        req,
      });
      respond(ephemeral(`LXS: ${member.error}`));
      return done();
    }
    if (!roleAtLeast(member.role, 'analyst')) {
      await audit(db, {
        orgId: project.orgId,
        projectId: project.id,
        actorType: 'user',
        actorId: member.userId,
        action: 'response.slack.denied',
        targetType: 'incident',
        targetId: incident.id,
        metadata: { ...slackMeta, action: action.actionId, reason: 'insufficient_role' },
        req,
      });
      respond(ephemeral('LXS: blocking needs the analyst role in this project.'));
      return done();
    }
    const who = `<@${action.user.id}>`;
    const access = { project, user: { id: member.userId } };
    const auditMeta = { ...slackMeta, slack_identity: member.via };

    if (action.actionId === SLACK_ACTIONS.block) {
      const [pol] = await db
        .select({ allowPrivate: responsePolicies.allowPrivate })
        .from(responsePolicies)
        .where(eq(responsePolicies.projectId, project.id))
        .limit(1);
      const guard = targetGuard(ip, {
        allowlist: (project.allowlist ?? []).map(String),
        platformRanges: parseRanges(env.PLATFORM_IP_RANGES),
        allowPrivate: pol?.allowPrivate ?? false,
      });
      if (!guard.ok) {
        respond(ephemeral(`LXS: not blocked (${guard.reason.replace(/_/g, ' ')}).`));
        return done();
      }
      let res: Awaited<ReturnType<typeof blockIp>>;
      try {
        res = await blockIp(
          access,
          {
            ip,
            durationHours: 24,
            reason: `Blocked from Slack by ${action.user.name ?? action.user.id}`,
            incidentId: incident.id,
          },
          req,
          { source: 'slack', audit: auditMeta },
        );
      } catch (err) {
        respond(ephemeral(`LXS: could not block: ${err instanceof Error ? err.message : 'error'}`));
        return done();
      }
      await db.execute(
        dsql`select pg_notify(${STREAM_CHANNEL}, ${streamPayload(project.id, 'incident.updated', { id: incident.id, blocked: true })})`,
      );
      respond(
        updatedMessage(action.messageBlocks, `:no_entry: \`${ip}\` blocked for 24 h by ${who}`, {
          actionId: SLACK_ACTIONS.undo,
          label: 'Undo block',
          value: slackActionValue(project.id, incident.id, res.blocklist_entry_id),
        }),
      );
      return done();
    }

    if (action.actionId === SLACK_ACTIONS.undo) {
      if (!action.value.b) throw denied();
      try {
        await unblockIp(access, { entryId: action.value.b, incidentId: incident.id }, req, {
          audit: auditMeta,
        });
      } catch {
        respond(ephemeral('LXS: that block is no longer active.'));
        return done();
      }
      await db.execute(
        dsql`select pg_notify(${STREAM_CHANNEL}, ${streamPayload(project.id, 'incident.updated', { id: incident.id, blocked: false })})`,
      );
      respond(
        updatedMessage(
          action.messageBlocks,
          `:leftwards_arrow_with_hook: \`${ip}\` unblocked by ${who}`,
          {
            actionId: SLACK_ACTIONS.block,
            label: 'Block 24h',
            value: slackActionValue(project.id, incident.id),
            style: 'danger',
          },
        ),
      );
      return done();
    }

    if (action.actionId === SLACK_ACTIONS.ignore) {
      await audit(db, {
        orgId: project.orgId,
        projectId: project.id,
        actorType: 'user',
        actorId: member.userId,
        action: 'response.slack.ignore',
        targetType: 'incident',
        targetId: incident.id,
        metadata: { ...auditMeta, ip },
        req,
      });
      respond(
        updatedMessage(action.messageBlocks, `Ignored by ${who}. No action taken.`, {
          actionId: SLACK_ACTIONS.block,
          label: 'Block 24h',
          value: slackActionValue(project.id, incident.id),
          style: 'danger',
        }),
      );
      return done();
    }
    throw denied();
  });

  /* ---- per-project configuration (session) ---- */

  const auth = { preHandler: requireSession };
  const base = '/v1/projects/:pid/integrations/slack';

  app.get(base, auth, async (req) => {
    const { project } = await projectAccess(req, (req.params as { pid: string }).pid, 'owner');
    const [row] = await db
      .select()
      .from(slackIntegrations)
      .where(eq(slackIntegrations.projectId, project.id))
      .limit(1);
    const links = await db
      .select({
        slackUserId: slackUserLinks.slackUserId,
        userId: slackUserLinks.userId,
        email: users.email,
      })
      .from(slackUserLinks)
      .innerJoin(users, eq(users.id, slackUserLinks.userId))
      .where(eq(slackUserLinks.projectId, project.id));
    return {
      configured: !!row,
      has_bot_token: !!row?.botTokenEncrypted,
      team_id: row?.teamId ?? null,
      updated_at: iso(row?.updatedAt ?? null),
      request_url: `${env.PUBLIC_URL.replace(/\/+$/, '')}/v1/integrations/slack/actions`,
      user_links: links.map((l) => ({
        slack_user_id: l.slackUserId,
        user_id: l.userId,
        email: l.email,
      })),
    };
  });

  app.put(base, auth, async (req) => {
    const { project, user } = await projectAccess(
      req,
      (req.params as { pid: string }).pid,
      'owner',
    );
    const b = parse(SlackConfig, req.body);
    const [existing] = await db
      .select()
      .from(slackIntegrations)
      .where(eq(slackIntegrations.projectId, project.id))
      .limit(1);
    if (!existing && !b.signing_secret)
      throw invalid('signing_secret is required to connect a Slack app');
    const set = {
      ...(b.signing_secret && { signingSecretEncrypted: encryptSecret(b.signing_secret) }),
      ...(b.bot_token !== undefined && {
        botTokenEncrypted: b.bot_token ? encryptSecret(b.bot_token) : null,
      }),
      ...(b.team_id !== undefined && { teamId: b.team_id }),
      updatedAt: new Date(),
    };
    if (existing)
      await db
        .update(slackIntegrations)
        .set(set)
        .where(eq(slackIntegrations.projectId, project.id));
    else
      await db.insert(slackIntegrations).values({
        projectId: project.id,
        signingSecretEncrypted: encryptSecret(b.signing_secret!),
        botTokenEncrypted: b.bot_token ? encryptSecret(b.bot_token) : null,
        teamId: b.team_id ?? null,
        createdBy: user.id,
      });
    await audit(db, {
      orgId: project.orgId,
      projectId: project.id,
      actorType: 'user',
      actorId: user.id,
      action: existing ? 'integration.slack.update' : 'integration.slack.create',
      targetType: 'project',
      targetId: project.id,
      // Never the secrets themselves.
      metadata: {
        signing_secret_changed: !!b.signing_secret,
        bot_token: b.bot_token === undefined ? 'unchanged' : b.bot_token ? 'set' : 'removed',
        team_id: b.team_id ?? existing?.teamId ?? null,
      },
      req,
    });
    return { ok: true };
  });

  app.delete(base, auth, async (req, reply) => {
    const { project, user } = await projectAccess(
      req,
      (req.params as { pid: string }).pid,
      'owner',
    );
    const gone = await db
      .delete(slackIntegrations)
      .where(eq(slackIntegrations.projectId, project.id))
      .returning({ projectId: slackIntegrations.projectId });
    if (!gone.length) throw notFound('Slack integration');
    await db.delete(slackUserLinks).where(eq(slackUserLinks.projectId, project.id));
    await audit(db, {
      orgId: project.orgId,
      projectId: project.id,
      actorType: 'user',
      actorId: user.id,
      action: 'integration.slack.delete',
      targetType: 'project',
      targetId: project.id,
      req,
    });
    return reply.status(204).send();
  });

  app.put(`${base}/user-links`, auth, async (req) => {
    const { project, user } = await projectAccess(
      req,
      (req.params as { pid: string }).pid,
      'owner',
    );
    const b = parse(UserLinks, req.body);
    const members = await db
      .select({ userId: memberships.userId })
      .from(memberships)
      .where(eq(memberships.orgId, project.orgId));
    const ids = new Set(members.map((m) => m.userId));
    const bad = b.links.filter((l) => !ids.has(l.user_id));
    if (bad.length)
      throw invalid(`Not members of this organization: ${bad.map((l) => l.user_id).join(', ')}`);
    const seen = new Set<string>();
    const links = b.links.filter((l) => !seen.has(l.slack_user_id) && seen.add(l.slack_user_id));
    await db.transaction(async (tx) => {
      await tx.delete(slackUserLinks).where(eq(slackUserLinks.projectId, project.id));
      if (links.length)
        await tx.insert(slackUserLinks).values(
          links.map((l) => ({
            projectId: project.id,
            slackUserId: l.slack_user_id,
            userId: l.user_id,
          })),
        );
      await audit(tx, {
        orgId: project.orgId,
        projectId: project.id,
        actorType: 'user',
        actorId: user.id,
        action: 'integration.slack.user_links',
        targetType: 'project',
        targetId: project.id,
        metadata: { count: links.length },
        req,
      });
    });
    return { ok: true, count: links.length };
  });
}
