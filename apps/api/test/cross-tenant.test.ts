/**
 * Cross-tenant isolation (G4/H1 "done when"). For EVERY route registered on the
 * real app, tenant B's credentials are pointed at tenant A's resources and must get
 * 403/404, never A's data. Runs DB-free: the real Fastify app, plugins and handlers
 * on top of the in-memory FakeDb (test/helpers/fake-db.ts).
 *
 * A new route fails this test until it is either tenant-scoped through a path or
 * query parameter, or listed in NOT_TENANT_SCOPED with a reason.
 */
process.env.LOG_LEVEL = 'silent';

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

const { buildWorld, listRoutes, ORIGIN } = await import('./helpers/tenants.ts');
type World = Awaited<ReturnType<typeof buildWorld>>;

/** Routes that do not address a tenant's resources by id, and why that is safe. */
const NOT_TENANT_SCOPED: Record<string, string> = {
  'GET /healthz': 'liveness probe, no data',
  'GET /metrics': 'process-wide Prometheus counters, no tenant data; METRICS_TOKEN bearer',
  'GET /readyz': 'readiness probe, no data',
  'GET /v1/auth/config': 'public captcha config',
  'POST /v1/auth/login': 'public; returns only the caller',
  'POST /v1/auth/signup': 'public; creates the caller’s own org',
  'POST /v1/auth/logout': 'acts on the caller only',
  'POST /v1/auth/verify-email': 'public; the token is the credential',
  'POST /v1/auth/verify-email/resend': 'acts on the caller only',
  'POST /v1/auth/password/forgot': 'public; always the same answer',
  'POST /v1/auth/password/reset': 'public; the token is the credential',
  'GET /v1/me': 'returns the caller only',
  'GET /v1/me/digest': 'the caller’s own digest preference',
  'PATCH /v1/me/digest': 'acts on the caller only',
  'POST /v1/digest/unsubscribe': 'public; the signed token is the credential',
  'DELETE /v1/me': 'deletes the caller only (password confirm)',
  'GET /v1/system': 'aggregates over the caller’s owned projects only',
  'GET /v1/projects': 'lists the caller’s memberships only',
  'POST /v1/projects': 'creates in an org the caller owns',
  'POST /v1/invites/preview': 'public; the token is the credential (checked below)',
  'POST /v1/invites/accept': 'email-bound invite token (checked below)',
  // Ingest-key routes derive the project from the key, never from the request.
  'POST /v1/ingest': 'project comes from the bearer key',
  'POST /v1/agent/register': 'project comes from the bearer key',
  'POST /v1/agent/heartbeat': 'project comes from the bearer key',
  'GET /v1/agent/policy': 'project comes from the bearer key',
  'GET /v1/agent/whoami': 'project comes from the bearer key',
  'POST /v1/agent/selftest-report': 'project comes from the bearer key',
  // No session: authenticated by the Slack signature, checked with the secret of the project
  // named in the button value (see slack-actions.test.ts for the A-signature-on-B case).
  'POST /v1/integrations/slack/actions': 'Slack-signed per project; no session or cookie',
};

/** Tenant-scoped through the query string rather than the path. */
const QUERY_SCOPED = new Set(['GET /v1/stream']);
const KEY_ROUTES = new Set(
  Object.keys(NOT_TENANT_SCOPED).filter(
    (k) => k.includes('/v1/ingest') || k.includes('/v1/agent/'),
  ),
);

function fill(url: string, w: World): string {
  const a = w.a;
  const ids: Record<string, string> = {
    pid: a.project,
    aid: a.attacker,
    kid: a.key,
    bid: a.block,
    cid: a.channel,
    oid: a.org,
    uid: a.owner,
    eid: a.export,
    iid: url.startsWith('/v1/orgs/') ? a.invite : a.incident,
  };
  const path = url.replace(/:(\w+)/g, (_, p: string) => {
    const v = ids[p];
    if (!v) throw new Error(`cross-tenant test: no tenant-A id for :${p} in ${url}; add one`);
    return v;
  });
  return `${path}?project=${a.project}&incident=${a.incident}`;
}

function aIds(w: World): string[] {
  const a = w.a;
  return [
    a.org,
    a.owner,
    a.ownerEmail,
    a.project,
    a.incident,
    a.attacker,
    a.key,
    a.block,
    a.channel,
    a.invite,
    a.export,
  ];
}

describe('cross-tenant isolation', () => {
  let w: World;
  before(async () => {
    w = await buildWorld();
  });
  after(async () => {
    await w.close();
  });

  it('the fake database serves tenant A to tenant A (positive control)', async () => {
    const own = await w.app.inject({
      method: 'GET',
      url: `/v1/projects/${w.a.project}`,
      headers: { cookie: w.cookie(w.a.owner) },
    });
    assert.equal(own.statusCode, 200, own.body);
    assert.equal(own.json().id, w.a.project);
    const members = await w.app.inject({
      method: 'GET',
      url: `/v1/orgs/${w.a.org}/members`,
      headers: { cookie: w.cookie(w.a.owner) },
    });
    assert.equal(members.statusCode, 200, members.body);
    assert.equal(members.json().members[0].user_id, w.a.owner);
  });

  it('every route is either tenant-scoped or explicitly classified', () => {
    const unclassified = listRoutes(w.app)
      .map((r) => `${r.method} ${r.url}`)
      .filter((k) => !(k in NOT_TENANT_SCOPED) && !QUERY_SCOPED.has(k) && !k.includes('/:'));
    assert.deepEqual(unclassified, [], 'classify these routes in NOT_TENANT_SCOPED or scope them');
  });

  it("tenant B's session gets 403/404 on every tenant-A route", async () => {
    const routes = listRoutes(w.app).filter(
      (r) => r.url.includes('/:') || QUERY_SCOPED.has(`${r.method} ${r.url}`),
    );
    assert.ok(routes.length >= 30, `expected the full route table, got ${routes.length}`);
    const leaks: string[] = [];
    for (const r of routes) {
      const res = await w.app.inject({
        method: r.method as 'GET',
        url: fill(r.url, w),
        headers: {
          cookie: w.cookie(w.b.owner),
          origin: ORIGIN,
          ...(r.method === 'GET' ? {} : { 'content-type': 'application/json' }),
        },
        ...(r.method === 'GET' ? {} : { payload: '{}' }),
      });
      const leaked = aIds(w).filter((id) => res.body.includes(id));
      if (![403, 404].includes(res.statusCode) || leaked.length)
        leaks.push(`${r.method} ${r.url} -> ${res.statusCode} ${res.body.slice(0, 160)}`);
    }
    assert.deepEqual(leaks, []);
  });

  it("tenant A's own owner passes the access gate on the same routes (so the 404s above are real)", async () => {
    const routes = listRoutes(w.app).filter(
      (r) => r.url.includes('/:') || QUERY_SCOPED.has(`${r.method} ${r.url}`),
    );
    const gated: string[] = [];
    for (const r of routes) {
      // Member removal/demotion of A's only owner is refused by design; covered in identity-routes.
      if (r.url.startsWith('/v1/orgs/:oid/members/:uid')) continue;
      // An authorized /v1/stream is an open SSE response that never ends.
      if (r.url === '/v1/stream') continue;
      const res = await w.app.inject({
        method: r.method as 'GET',
        url: fill(r.url, w),
        headers: {
          cookie: w.cookie(w.a.owner),
          origin: ORIGIN,
          ...(r.method === 'GET' ? {} : { 'content-type': 'application/json' }),
        },
        ...(r.method === 'GET' ? {} : { payload: '{}' }),
      });
      let err: { code?: string; message?: string } = {};
      try {
        err = res.json()?.error ?? {};
      } catch {
        err = {};
      }
      if (
        res.statusCode === 401 ||
        err.code === 'insufficient_role' ||
        /^(Project|Organization|Incident|Attacker) not found$/.test(err.message ?? '')
      )
        gated.push(`${r.method} ${r.url} -> ${res.statusCode} ${err.code} ${err.message}`);
    }
    assert.deepEqual(gated, []);
  });

  it("tenant B's session sees nothing of tenant A on unscoped session routes", async () => {
    for (const key of Object.keys(NOT_TENANT_SCOPED)) {
      if (KEY_ROUTES.has(key)) continue;
      const [method, url] = key.split(' ') as [string, string];
      const res = await w.app.inject({
        method: method as 'GET',
        url,
        headers: {
          cookie: w.cookie(w.b.owner),
          origin: ORIGIN,
          ...(method === 'GET' ? {} : { 'content-type': 'application/json' }),
        },
        ...(method === 'GET' ? {} : { payload: '{}' }),
      });
      const leaked = aIds(w).filter((id) => res.body.includes(id));
      assert.deepEqual(leaked, [], `${key} leaked tenant A data: ${res.body.slice(0, 200)}`);
    }
  });

  it("tenant B's ingest key cannot reach tenant A, and A's session is not an ingest credential", async () => {
    for (const key of KEY_ROUTES) {
      const [method, url] = key.split(' ') as [string, string];
      const withSession = await w.app.inject({
        method: method as 'GET',
        url: `${url}?project=${w.a.project}`,
        headers: { cookie: w.cookie(w.a.owner), 'content-type': 'application/json' },
        ...(method === 'GET' ? {} : { payload: '{}' }),
      });
      assert.equal(withSession.statusCode, 401, `${key} accepted a session cookie`);
      const withKey = await w.app.inject({
        method: method as 'GET',
        url: `${url}?project=${w.a.project}`,
        headers: {
          authorization: `Bearer ${w.b.ingestKey}`,
          'content-type': 'application/json',
        },
        ...(method === 'GET' ? {} : { payload: '{}' }),
      });
      const leaked = aIds(w).filter((id) => withKey.body.includes(id));
      assert.deepEqual(leaked, [], `${key} leaked tenant A data with B's key`);
    }
  });

  it("tenant A's invite token is useless to tenant B", async () => {
    // The owner sweep above revoked it (DELETE /v1/orgs/:oid/invites/:iid); make it live again.
    const row = w.fake.table('org_invites').find((i) => i.id === w.a.invite)!;
    row.revoked_at = null;
    const forged = `${w.a.invite}.${'x'.repeat(43)}`;
    const preview = await w.app.inject({
      method: 'POST',
      url: '/v1/invites/preview',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ token: forged }),
    });
    assert.equal(preview.statusCode, 404);
    const accept = await w.app.inject({
      method: 'POST',
      url: '/v1/invites/accept',
      headers: { cookie: w.cookie(w.b.owner), origin: ORIGIN, 'content-type': 'application/json' },
      payload: JSON.stringify({ token: w.a.inviteToken }),
    });
    // The real token, but addressed to someone else: B cannot join A with it.
    assert.equal(accept.statusCode, 403);
    assert.equal(accept.json().error.code, 'E_INVITE_EMAIL_MISMATCH');
    assert.ok(
      !w.fake.table('memberships').some((m) => m.org_id === w.a.org && m.user_id === w.b.owner),
    );
  });

  /* ---------------- soft-deleted projects (data handling, H5) ---------------- */

  const json = (cookie: string, method: string, url: string, body?: unknown) =>
    w.app.inject({
      method: method as 'GET',
      url,
      headers: {
        cookie,
        origin: ORIGIN,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
    });

  it('tenant B cannot delete tenant A’s project, even with the right slug', async () => {
    const res = await json(w.cookie(w.b.owner), 'DELETE', `/v1/projects/${w.a.project}`, {
      confirm: 'project-a',
    });
    assert.equal(res.statusCode, 404);
    assert.ok(!w.fake.table('projects').find((p) => p.id === w.a.project)!.deleted_at);
  });

  it('once A deletes its project, every project route answers 404 to A as well', async () => {
    const del = await json(w.cookie(w.a.owner), 'DELETE', `/v1/projects/${w.a.project}`, {
      confirm: 'project-a',
    });
    assert.equal(del.statusCode, 200, del.body);
    const routes = listRoutes(w.app).filter(
      (r) =>
        (r.url.includes('/:') || QUERY_SCOPED.has(`${r.method} ${r.url}`)) &&
        !r.url.startsWith('/v1/orgs/') &&
        r.url !== '/v1/projects/:pid/restore',
    );
    const open: string[] = [];
    for (const r of routes) {
      const res = await w.app.inject({
        method: r.method as 'GET',
        url: fill(r.url, w),
        headers: {
          cookie: w.cookie(w.a.owner),
          origin: ORIGIN,
          ...(r.method === 'GET' ? {} : { 'content-type': 'application/json' }),
        },
        ...(r.method === 'GET' ? {} : { payload: '{}' }),
      });
      if (res.statusCode !== 404) open.push(`${r.method} ${r.url} -> ${res.statusCode}`);
    }
    assert.deepEqual(open, []);
    const list = await json(w.cookie(w.a.owner), 'GET', '/v1/projects');
    assert.ok(!list.body.includes(w.a.project), 'deleted project still listed');
  });

  it('a deleted project’s ingest key is refused', async () => {
    const res = await w.app.inject({
      method: 'GET',
      url: '/v1/agent/whoami',
      headers: { authorization: `Bearer ${w.a.ingestKey}` },
    });
    assert.equal(res.statusCode, 403);
  });

  it('tenant B can neither list nor restore tenant A’s deleted project', async () => {
    const list = await json(w.cookie(w.b.owner), 'GET', `/v1/orgs/${w.a.org}/deleted-projects`);
    assert.equal(list.statusCode, 404);
    const own = await json(w.cookie(w.b.owner), 'GET', `/v1/orgs/${w.b.org}/deleted-projects`);
    assert.equal(own.statusCode, 200);
    assert.ok(!own.body.includes(w.a.project));
    const restore = await json(
      w.cookie(w.b.owner),
      'POST',
      `/v1/projects/${w.a.project}/restore`,
      {},
    );
    assert.equal(restore.statusCode, 404);
    assert.ok(w.fake.table('projects').find((p) => p.id === w.a.project)!.deleted_at);
  });

  it('A restores its project inside the grace period and can reach it again', async () => {
    const res = await json(w.cookie(w.a.owner), 'POST', `/v1/projects/${w.a.project}/restore`, {});
    assert.equal(res.statusCode, 200, res.body);
    const get = await json(w.cookie(w.a.owner), 'GET', `/v1/projects/${w.a.project}`);
    assert.equal(get.statusCode, 200);
  });
});
