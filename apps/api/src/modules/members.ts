/**
 * Organization members and invitations.
 *
 *   GET    /v1/orgs/:oid/members              any member (owners also see pending invites)
 *   POST   /v1/orgs/:oid/invites              owner, verified email
 *   DELETE /v1/orgs/:oid/invites/:iid         owner
 *   PATCH  /v1/orgs/:oid/members/:uid         owner (never demotes the last owner)
 *   DELETE /v1/orgs/:oid/members/:uid         owner, or the member themselves (leave)
 *   POST   /v1/invites/preview                public: who invited whom, for the accept page
 *   POST   /v1/invites/accept                 session whose email matches the invite
 *
 * Invite tokens travel in request bodies, never in API paths, so they do not end up
 * in request logs. Every membership change is written to the audit log.
 */
import { and, asc, sql as dsql, eq, gt, isNull } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { type DbOrTx, db } from '../db/client.js';
import { memberships, organizations, orgInvites, users } from '../db/schema.js';
import { audit } from '../lib/audit.js';
import { conflict, HttpError, notFound } from '../lib/errors.js';
import { appLink, inviteMessage, sendInBackground } from '../lib/mailer.js';
import { parse } from '../lib/parse.js';
import { iso } from '../lib/serialize.js';
import { INVITE_TTL_MS, mintToken, parseToken, secretMatches } from '../lib/tokens.js';
import {
  isUuid,
  orgAccess,
  orgDisabled,
  type Role,
  requireSession,
  requireVerified,
} from '../plugins/auth-session.js';

const RoleSchema = z.enum(['owner', 'analyst', 'viewer']);
const InviteBody = z.object({
  email: z.string().trim().toLowerCase().email().max(256),
  role: RoleSchema.default('viewer'),
});
const RoleBody = z.object({ role: RoleSchema });
const TokenBody = z.object({ token: z.string().min(1).max(256) });

/** Pending invites an org may hold at once, so invites cannot be used to spam inboxes. */
export const MAX_PENDING_INVITES = 50;

export const E_LAST_OWNER = 'E_LAST_OWNER';
export const E_INVITE_INVALID = 'E_INVITE_INVALID';
export const E_INVITE_EMAIL_MISMATCH = 'E_INVITE_EMAIL_MISMATCH';

export const inviteInvalid = () =>
  new HttpError(
    400,
    E_INVITE_INVALID,
    'This invitation is invalid, expired or already used. Ask an owner for a new one.',
  );

export type InviteRow = typeof orgInvites.$inferSelect;
export type InviteStatus = 'pending' | 'accepted' | 'revoked' | 'expired';

export function inviteStatus(i: InviteRow, now = Date.now()): InviteStatus {
  if (i.acceptedAt) return 'accepted';
  if (i.revokedAt) return 'revoked';
  if (i.expiresAt.getTime() <= now) return 'expired';
  return 'pending';
}

/** Resolve a presented invite token. Null unless the id exists and the secret matches. */
export async function findInvite(
  dbx: DbOrTx,
  token: unknown,
): Promise<{ invite: InviteRow; orgName: string; orgDisabled: boolean } | null> {
  const parsed = parseToken(token);
  if (!parsed) return null;
  const [row] = await dbx
    .select({
      invite: orgInvites,
      orgName: organizations.name,
      disabledAt: organizations.disabledAt,
    })
    .from(orgInvites)
    .innerJoin(organizations, eq(organizations.id, orgInvites.orgId))
    .where(eq(orgInvites.id, parsed.id))
    .limit(1);
  if (!row || !secretMatches(parsed.secret, row.invite.tokenHash)) return null;
  return { invite: row.invite, orgName: row.orgName, orgDisabled: row.disabledAt != null };
}

/**
 * Join the invite's org inside a transaction. The conditional update is the single-use
 * guard: two concurrent accepts cannot both succeed.
 */
export async function acceptInviteTx(
  tx: DbOrTx,
  invite: InviteRow,
  user: { id: string },
  req?: FastifyRequest,
): Promise<Role> {
  const [claimed] = await tx
    .update(orgInvites)
    .set({ acceptedAt: dsql`now()`, acceptedBy: user.id })
    .where(
      and(
        eq(orgInvites.id, invite.id),
        isNull(orgInvites.acceptedAt),
        isNull(orgInvites.revokedAt),
        gt(orgInvites.expiresAt, dsql`now()`),
      ),
    )
    .returning({ id: orgInvites.id });
  if (!claimed) throw inviteInvalid();
  const [existing] = await tx
    .select({ role: memberships.role })
    .from(memberships)
    .where(and(eq(memberships.orgId, invite.orgId), eq(memberships.userId, user.id)))
    .limit(1);
  // Already a member: keep the current role rather than silently changing it.
  if (existing) return existing.role as Role;
  await tx.insert(memberships).values({ orgId: invite.orgId, userId: user.id, role: invite.role });
  await audit(tx, {
    orgId: invite.orgId,
    actorType: 'user',
    actorId: user.id,
    action: 'member.join',
    targetType: 'user',
    targetId: user.id,
    metadata: { role: invite.role, invite_id: invite.id },
    req,
  });
  return invite.role as Role;
}

/** Owner count, with the owner rows locked so concurrent demotions serialize. */
async function lockedOwnerCount(tx: DbOrTx, orgId: string): Promise<number> {
  const rows = (await tx.execute(dsql`
    SELECT user_id FROM memberships WHERE org_id = ${orgId}::uuid AND role = 'owner' FOR UPDATE
  `)) as unknown as { user_id: string }[];
  return rows.length;
}

const lastOwner = () =>
  new HttpError(
    409,
    E_LAST_OWNER,
    'An organization needs at least one owner. Make someone else an owner first.',
  );

export async function memberRoutes(app: FastifyInstance): Promise<void> {
  const auth = { preHandler: requireSession };
  const publicTight = { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } };

  app.get('/v1/orgs/:oid/members', auth, async (req) => {
    const { orgId, role } = await orgAccess(req, (req.params as { oid: string }).oid);
    const [org] = await db
      .select({ id: organizations.id, name: organizations.name, slug: organizations.slug })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1);
    const rows = await db
      .select({
        userId: memberships.userId,
        role: memberships.role,
        joinedAt: memberships.createdAt,
        email: users.email,
        username: users.username,
        name: users.name,
        emailVerifiedAt: users.emailVerifiedAt,
      })
      .from(memberships)
      .innerJoin(users, dsql`${users.id}::text = ${memberships.userId}`)
      .where(eq(memberships.orgId, orgId))
      .orderBy(asc(memberships.createdAt));
    const invites =
      role === 'owner'
        ? await db
            .select()
            .from(orgInvites)
            .where(
              and(
                eq(orgInvites.orgId, orgId),
                isNull(orgInvites.acceptedAt),
                isNull(orgInvites.revokedAt),
              ),
            )
            .orderBy(asc(orgInvites.createdAt))
        : [];
    return {
      org: org ?? null,
      my_role: role,
      members: rows.map((m) => ({
        user_id: m.userId,
        email: m.email,
        username: m.username,
        name: m.name,
        role: m.role,
        email_verified: m.emailVerifiedAt != null,
        joined_at: iso(m.joinedAt),
      })),
      invites: invites.map((i) => ({
        id: i.id,
        email: i.email,
        role: i.role,
        status: inviteStatus(i),
        invited_by: i.invitedBy,
        created_at: iso(i.createdAt),
        expires_at: iso(i.expiresAt),
      })),
    };
  });

  app.post(
    '/v1/orgs/:oid/invites',
    { ...auth, config: { rateLimit: { max: 30, timeWindow: '1 hour' } } },
    async (req, reply) => {
      const { orgId, user } = await orgAccess(req, (req.params as { oid: string }).oid, 'owner');
      requireVerified(user);
      const body = parse(InviteBody, req.body);
      const [member] = await db
        .select({ userId: memberships.userId })
        .from(memberships)
        .innerJoin(users, dsql`${users.id}::text = ${memberships.userId}`)
        .where(and(eq(memberships.orgId, orgId), eq(users.email, body.email)))
        .limit(1);
      if (member) throw conflict('That person is already a member of this organization');
      const [{ pending }] = (await db.execute(dsql`
        SELECT count(*)::int AS pending FROM org_invites
        WHERE org_id = ${orgId}::uuid AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()
      `)) as unknown as [{ pending: number }];
      if (pending >= MAX_PENDING_INVITES)
        throw new HttpError(
          403,
          'E_LIMIT_REACHED',
          `This organization already has ${MAX_PENDING_INVITES} pending invitations. Revoke some first.`,
          { kind: 'invites', limit: MAX_PENDING_INVITES },
        );
      const t = mintToken();
      const expiresAt = new Date(Date.now() + INVITE_TTL_MS);
      const { row, orgName } = await db.transaction(async (tx) => {
        // One live invite per address: re-inviting replaces the old link.
        await tx
          .update(orgInvites)
          .set({ revokedAt: dsql`now()` })
          .where(
            and(
              eq(orgInvites.orgId, orgId),
              eq(orgInvites.email, body.email),
              isNull(orgInvites.acceptedAt),
              isNull(orgInvites.revokedAt),
            ),
          );
        const [inserted] = await tx
          .insert(orgInvites)
          .values({
            id: t.id,
            orgId,
            email: body.email,
            role: body.role,
            tokenHash: t.hash,
            invitedBy: user.id,
            expiresAt,
          })
          .returning();
        const [org] = await tx
          .select({ name: organizations.name })
          .from(organizations)
          .where(eq(organizations.id, orgId))
          .limit(1);
        await audit(tx, {
          orgId,
          actorType: 'user',
          actorId: user.id,
          action: 'member.invite',
          targetType: 'invite',
          targetId: t.id,
          metadata: { email: body.email, role: body.role },
          req,
        });
        return { row: inserted!, orgName: org?.name ?? 'an organization' };
      });
      sendInBackground(
        inviteMessage(body.email, appLink(`/invite/${t.token}`), {
          orgName,
          inviter: user.name || user.email,
          role: body.role,
        }),
        req.log,
      );
      return reply.status(201).send({
        id: row.id,
        email: row.email,
        role: row.role,
        status: 'pending',
        invited_by: row.invitedBy,
        created_at: iso(row.createdAt),
        expires_at: iso(row.expiresAt),
      });
    },
  );

  app.delete('/v1/orgs/:oid/invites/:iid', auth, async (req, reply) => {
    const { oid, iid } = req.params as { oid: string; iid: string };
    const { orgId, user } = await orgAccess(req, oid, 'owner');
    if (!isUuid(iid)) throw notFound('Invite');
    const [row] = await db
      .update(orgInvites)
      .set({ revokedAt: dsql`now()` })
      .where(
        and(
          eq(orgInvites.id, iid),
          eq(orgInvites.orgId, orgId),
          isNull(orgInvites.acceptedAt),
          isNull(orgInvites.revokedAt),
        ),
      )
      .returning({ id: orgInvites.id, email: orgInvites.email });
    if (!row) throw notFound('Invite');
    await audit(db, {
      orgId,
      actorType: 'user',
      actorId: user.id,
      action: 'member.invite_revoke',
      targetType: 'invite',
      targetId: row.id,
      metadata: { email: row.email },
      req,
    });
    return reply.status(204).send();
  });

  app.patch('/v1/orgs/:oid/members/:uid', auth, async (req) => {
    const { oid, uid } = req.params as { oid: string; uid: string };
    const { orgId, user } = await orgAccess(req, oid, 'owner');
    const body = parse(RoleBody, req.body);
    const from = await db.transaction(async (tx) => {
      const owners = await lockedOwnerCount(tx, orgId);
      const [m] = await tx
        .select({ role: memberships.role })
        .from(memberships)
        .where(and(eq(memberships.orgId, orgId), eq(memberships.userId, uid)))
        .limit(1);
      if (!m) throw notFound('Member');
      if (m.role === body.role) return m.role;
      if (m.role === 'owner' && owners <= 1) throw lastOwner();
      await tx
        .update(memberships)
        .set({ role: body.role })
        .where(and(eq(memberships.orgId, orgId), eq(memberships.userId, uid)));
      await audit(tx, {
        orgId,
        actorType: 'user',
        actorId: user.id,
        action: 'member.role_change',
        targetType: 'user',
        targetId: uid,
        metadata: { from: m.role, to: body.role },
        req,
      });
      return m.role;
    });
    return { user_id: uid, role: body.role, previous_role: from };
  });

  app.delete('/v1/orgs/:oid/members/:uid', auth, async (req, reply) => {
    const { oid, uid } = req.params as { oid: string; uid: string };
    // Anyone may leave; removing somebody else needs owner.
    const self = req.user?.id === uid;
    const { orgId, user } = await orgAccess(req, oid, self ? 'viewer' : 'owner');
    await db.transaction(async (tx) => {
      const owners = await lockedOwnerCount(tx, orgId);
      const [m] = await tx
        .select({ role: memberships.role })
        .from(memberships)
        .where(and(eq(memberships.orgId, orgId), eq(memberships.userId, uid)))
        .limit(1);
      if (!m) throw notFound('Member');
      if (m.role === 'owner' && owners <= 1) throw lastOwner();
      await tx
        .delete(memberships)
        .where(and(eq(memberships.orgId, orgId), eq(memberships.userId, uid)));
      await audit(tx, {
        orgId,
        actorType: 'user',
        actorId: user.id,
        action: self ? 'member.leave' : 'member.remove',
        targetType: 'user',
        targetId: uid,
        metadata: { role: m.role },
        req,
      });
    });
    return reply.status(204).send();
  });

  /* ---------------------------- invite links ---------------------------- */

  app.post('/v1/invites/preview', publicTight, async (req) => {
    const { token } = parse(TokenBody, req.body);
    const found = await findInvite(db, token);
    if (!found) throw notFound('Invitation');
    const { invite, orgName } = found;
    return {
      org_name: orgName,
      email: invite.email,
      role: invite.role,
      status: found.orgDisabled ? 'revoked' : inviteStatus(invite),
      expires_at: iso(invite.expiresAt),
    };
  });

  app.post('/v1/invites/accept', { preHandler: requireSession, ...publicTight }, async (req) => {
    const { token } = parse(TokenBody, req.body);
    const user = req.user!;
    const found = await findInvite(db, token);
    if (!found || inviteStatus(found.invite) !== 'pending') throw inviteInvalid();
    if (found.orgDisabled) throw orgDisabled();
    if (found.invite.email !== user.email.toLowerCase())
      throw new HttpError(
        403,
        E_INVITE_EMAIL_MISMATCH,
        `This invitation was sent to ${found.invite.email}. Sign in with that address to accept it.`,
      );
    const role = await db.transaction(async (tx) => {
      const r = await acceptInviteTx(tx, found.invite, user, req);
      // Following the emailed link proves the address.
      if (!user.emailVerified)
        await tx
          .update(users)
          .set({ emailVerifiedAt: dsql`now()` })
          .where(and(eq(users.id, user.id), isNull(users.emailVerifiedAt)));
      return r;
    });
    return { org_id: found.invite.orgId, org_name: found.orgName, role };
  });
}
