/**
 * Two tenants (A and B) seeded into a FakeDb, plus helpers to build the real app
 * against it and to sign session cookies. Import this only after setting
 * process.env (LOG_LEVEL etc.), since it pulls in src/env.ts.
 */
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.ts';
import { sql } from '../../src/db/client.ts';
import { env } from '../../src/env.ts';
import { sha256, signToken } from '../../src/lib/crypto.ts';
import { MemoryMailer, setMailer } from '../../src/lib/mailer.ts';
import { mintToken } from '../../src/lib/tokens.ts';
import { SESSION_COOKIE } from '../../src/plugins/auth-session.ts';
import { FakeDb, installFakeDb } from './fake-db.ts';

export const ORIGIN = 'http://localhost:3000';

export interface Tenant {
  org: string;
  owner: string;
  ownerEmail: string;
  project: string;
  incident: string;
  attacker: string;
  key: string; // api_keys row id
  ingestKey: string; // the bearer secret
  block: string;
  channel: string;
  invite: string;
  inviteToken: string;
  export: string; // project_exports row id
}

function seedTenant(fake: FakeDb, name: 'a' | 'b'): Tenant {
  const t: Tenant = {
    org: randomUUID(),
    owner: randomUUID(),
    ownerEmail: `owner-${name}@example.test`,
    project: randomUUID(),
    incident: randomUUID(),
    attacker: randomUUID(),
    key: randomUUID(),
    ingestKey: `ds_live_${name.repeat(32)}`,
    block: randomUUID(),
    channel: randomUUID(),
    invite: '',
    inviteToken: '',
    export: randomUUID(),
  };
  const now = new Date();
  fake.table('organizations').push({
    id: t.org,
    name: `Org ${name.toUpperCase()}`,
    slug: `org-${name}`,
    created_at: now,
    disabled_at: null,
    disabled_reason: null,
  });
  fake.table('users').push({
    id: t.owner,
    email: t.ownerEmail,
    username: `owner-${name}`,
    name: `Owner ${name.toUpperCase()}`,
    password_hash: 'scrypt$x$y',
    session_version: 0,
    email_verified_at: now,
    created_at: now,
  });
  fake
    .table('memberships')
    .push({ org_id: t.org, user_id: t.owner, role: 'owner', created_at: now });
  fake.table('projects').push({
    id: t.project,
    org_id: t.org,
    name: `Project ${name}`,
    slug: `project-${name}`,
    environment: 'production',
    policy_version: 1,
    incident_seq: 1,
    password_salt: Buffer.alloc(16),
    allowlist: [],
    retention_days: 30,
    ai_enabled: true,
    ai_daily_cap: 200,
    created_at: now,
    archived_at: null,
  });
  fake.table('attackers').push({ id: t.attacker, project_id: t.project, created_at: now });
  fake.table('incidents').push({
    id: t.incident,
    project_id: t.project,
    attacker_id: t.attacker,
    status: 'open',
    severity: 'high',
    created_at: now,
  });
  fake.table('api_keys').push({
    id: t.key,
    project_id: t.project,
    name: 'sensor-1',
    prefix: t.ingestKey.slice(0, 12),
    key_hash: sha256(t.ingestKey),
    scopes: ['ingest'],
    created_at: now,
    revoked_at: null,
  });
  fake.table('blocklist_entries').push({ id: t.block, project_id: t.project, created_at: now });
  fake.table('project_exports').push({
    id: t.export,
    project_id: t.project,
    org_id: t.org,
    requested_by: t.owner,
    status: 'failed',
    storage: 'local',
    object_key: null,
    row_counts: {},
    error: 'seeded',
    created_at: new Date(now.getTime() - 2 * 86_400_000),
  });
  fake
    .table('notification_channels')
    .push({ id: t.channel, project_id: t.project, created_at: now });
  const inv = mintToken();
  t.invite = inv.id;
  t.inviteToken = inv.token;
  fake.table('org_invites').push({
    id: inv.id,
    org_id: t.org,
    email: `invitee-${name}@example.test`,
    role: 'analyst',
    token_hash: inv.hash,
    invited_by: t.owner,
    expires_at: new Date(Date.now() + 86_400_000),
    accepted_at: null,
    accepted_by: null,
    revoked_at: null,
    created_at: now,
  });
  return t;
}

/** Add a user to an org with a role; returns the user id. */
export function addMember(
  fake: FakeDb,
  orgId: string,
  role: 'owner' | 'analyst' | 'viewer',
  opts: { verified?: boolean; email?: string } = {},
): string {
  const id = randomUUID();
  fake.table('users').push({
    id,
    email: opts.email ?? `${role}-${id.slice(0, 8)}@example.test`,
    username: `${role}-${id.slice(0, 8)}`,
    name: role,
    password_hash: 'scrypt$x$y',
    session_version: 0,
    email_verified_at: opts.verified === false ? null : new Date(),
    created_at: new Date(),
  });
  fake.table('memberships').push({ org_id: orgId, user_id: id, role, created_at: new Date() });
  return id;
}

export function cookieFor(userId: string, version = 0): string {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  return `${SESSION_COOKIE}=${signToken({ uid: userId, exp, ver: version }, env.SESSION_SECRET)}`;
}

export interface World {
  app: FastifyInstance;
  fake: FakeDb;
  a: Tenant;
  b: Tenant;
  mail: MemoryMailer;
  /** A valid session cookie for `userId` at its current session_version. */
  cookie: (userId: string) => string;
  close: () => Promise<void>;
}

export async function buildWorld(): Promise<World> {
  const fake = new FakeDb();
  fake.defaults = {
    users: { session_version: 0, name: '', email_verified_at: null },
    memberships: { role: 'owner' },
    projects: {
      environment: 'production',
      archived_at: null,
      ai_enabled: true,
      deleted_at: null,
      purge_after: null,
    },
    organizations: { plan: 'free', deleted_at: null },
    project_exports: { status: 'pending', row_counts: {}, error: null, expires_at: null },
    api_keys: { scopes: ['ingest'], revoked_at: null },
  };
  // Raw SQL the generic engine cannot read: answer what the identity routes need.
  fake.raw.push(
    { match: /pg_advisory_xact_lock/, rows: () => [{ ok: true }] },
    {
      match: /FROM memberships WHERE org_id = \$1::uuid AND role = 'owner' FOR UPDATE/,
      rows: (p, f) =>
        f
          .table('memberships')
          .filter((m) => m.org_id === p[0] && m.role === 'owner')
          .map((m) => ({ user_id: m.user_id })),
    },
    {
      match: /count\(\*\)::int AS n FROM projects/,
      rows: (p, f) => [
        {
          n: f.table('projects').filter((r) => r.org_id === p[0] && !r.archived_at && !r.deleted_at)
            .length,
        },
      ],
    },
    {
      match: /count\(\*\)::int AS n FROM api_keys/,
      rows: (p, f) => {
        const pids = new Set(
          f
            .table('projects')
            .filter((r) => r.org_id === p[0])
            .map((r) => r.id),
        );
        return [
          { n: f.table('api_keys').filter((k) => pids.has(k.project_id) && !k.revoked_at).length },
        ];
      },
    },
    { match: /count\(\*\)::int AS pending FROM org_invites/, rows: () => [{ pending: 0 }] },
  );
  const a = seedTenant(fake, 'a');
  const b = seedTenant(fake, 'b');
  const uninstall = installFakeDb(fake);
  const mail = new MemoryMailer();
  const prevMailer = setMailer(mail);
  const app = await buildApp();
  await app.ready();
  return {
    app,
    fake,
    a,
    b,
    mail,
    cookie: (userId: string) =>
      cookieFor(
        userId,
        Number(fake.table('users').find((u) => u.id === userId)?.session_version ?? 0),
      ),
    close: async () => {
      await app.close();
      setMailer(prevMailer);
      uninstall();
      // The SSE plugin opens a real LISTEN connection at startup; end it so the run can exit.
      await sql.end({ timeout: 0 });
    },
  };
}

export interface RouteDef {
  method: string;
  url: string;
}

/** Every method+path registered on the app, parsed from printRoutes (HEAD/OPTIONS dropped). */
export function listRoutes(app: FastifyInstance): RouteDef[] {
  const out: RouteDef[] = [];
  const stack: string[] = [];
  for (const line of app.printRoutes({ commonPrefix: false }).split('\n')) {
    const at = line.indexOf('── ');
    if (at < 0) continue;
    const depth = Math.round((at - 1) / 4);
    const rest = line.slice(at + 3);
    const paren = rest.lastIndexOf(' (');
    const seg = paren < 0 ? rest.trim() : rest.slice(0, paren);
    const full = (depth > 0 ? stack[depth - 1] : '') + seg;
    stack[depth] = full;
    stack.length = depth + 1;
    if (paren < 0 || full === '*') continue;
    for (const m of rest
      .slice(paren + 2, -1)
      .split(',')
      .map((s) => s.trim()))
      if (m !== 'HEAD' && m !== 'OPTIONS') out.push({ method: m, url: full });
  }
  return out;
}
