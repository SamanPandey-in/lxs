/**
 * Data handling (H5/G11), DB-free: plans, captured-credential hashing, project export
 * (bundle contents, download, expiry), project soft delete / restore / purge, and account
 * delete. The real app and handlers run on the in-memory FakeDb.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const exportRoot = mkdtempSync(join(tmpdir(), 'lxs-export-test-'));
process.env.LOG_LEVEL = 'silent';
process.env.EXPORT_DIR = exportRoot;
process.env.CREDENTIAL_PEPPER = 'test-pepper-0123456789';

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { gunzipSync } from 'node:zlib';

const { buildWorld, addMember, ORIGIN } = await import('./helpers/tenants.ts');
const { env } = await import('../src/env.ts');
const { hashPassword } = await import('../src/lib/crypto.ts');
const { PLANS, planFor, effectiveRetentionDays } = await import('../src/lib/plans.ts');
const maint = await import('../src/worker/maintenance.ts');
const ex = await import('../src/worker/export-project.ts');
type World = Awaited<ReturnType<typeof buildWorld>>;
type Row = Record<string, unknown>;

/** Minimal ustar reader: name -> bytes. */
function untar(buf: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  let off = 0;
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    const name = h.subarray(0, 100).toString('ascii').replace(/\0.*$/s, '');
    const size = Number.parseInt(h.subarray(124, 136).toString('ascii').replace(/\0.*$/s, ''), 8);
    const stored = Number.parseInt(h.subarray(148, 156).toString('ascii'), 8);
    const copy = Buffer.from(h);
    copy.fill(0x20, 148, 156);
    assert.equal(
      copy.reduce((n, b) => n + b, 0),
      stored,
      `tar checksum of ${name}`,
    );
    out.set(name, buf.subarray(off + 512, off + 512 + size));
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}

const ndjson = (gz: Buffer): Row[] =>
  gunzipSync(gz)
    .toString('utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Row);

describe('plans', () => {
  it('free follows the env; unknown names fall back to free', () => {
    assert.equal(PLANS.free.maxProjects, env.MAX_PROJECTS_PER_ORG);
    assert.equal(PLANS.free.retentionDays, env.RETENTION_DAYS);
    assert.equal(planFor('team').name, 'team');
    assert.equal(planFor('enterprise-typo').name, 'free');
    assert.equal(planFor(null).plan, PLANS.free);
    assert.ok(PLANS.team.retentionDays > PLANS.free.retentionDays);
    assert.equal(effectiveRetentionDays(365, PLANS.free), PLANS.free.retentionDays);
    assert.equal(effectiveRetentionDays(7, PLANS.team), 7);
  });
});

describe('captured-credential hashing', () => {
  const pepper = 'pepper-for-tests-123';
  const digest = (v: string) =>
    `sha256:${createHash('sha256')
      .update(pepper + v)
      .digest('hex')}`;

  it('replaces a clear (common-list) password with a peppered hash and its length', () => {
    const r = maint.hashCredentialFields(
      { username: 'root', password_clear: 'admin123', dst: 'x' },
      { password: 'admin123', user: 'root' },
      pepper,
    );
    assert.equal(r.changed, true);
    assert.equal(r.fields.username, 'root');
    assert.equal(r.fields.password_hash, digest('admin123'));
    assert.match(String(r.fields.password_hash), /^sha256:[0-9a-f]{64}$/);
    assert.equal(r.fields.password_length, 8);
    assert.equal(r.fields.password_common, true);
    assert.equal(r.fields.dst, 'x');
    assert.ok(!('password_clear' in r.fields));
    assert.equal(r.raw?.password, digest('admin123'));
    assert.equal(r.raw?.user, 'root');
    assert.ok(!JSON.stringify(r).includes('admin123'));
  });

  it('drops the mask and re-keys the salted digest when the password was never stored', () => {
    const salted = 'a'.repeat(64);
    const r = maint.hashCredentialFields(
      { username: 'bob', password_masked: 'h***2', password_sha256: salted },
      null,
      pepper,
    );
    assert.equal(r.fields.password_hash, digest(`salted:${salted}`));
    assert.equal(r.fields.password_hash_of, 'salted_sha256');
    assert.ok(!('password_masked' in r.fields));
    assert.ok(!('password_sha256' in r.fields));
    assert.ok(!('password_length' in r.fields));
    assert.ok(!('password_common' in r.fields));
  });

  it('uses a raw password still on the event, and leaves credential-free events alone', () => {
    const r = maint.hashCredentialFields(
      { username: 'bob', password_masked: 'h***2', password_sha256: 'b'.repeat(64) },
      { password: 'hunter22' },
      pepper,
    );
    assert.equal(r.fields.password_hash, digest('hunter22'));
    assert.equal(r.fields.password_length, 8);
    const none = maint.hashCredentialFields({ url: '/admin' }, null, pepper);
    assert.equal(none.changed, false);
  });

  it('depends on the pepper', () => {
    const a = maint.hashCredentialFields({ password_clear: 'x1' }, null, 'pepper-one-xxxxxxxx');
    const b = maint.hashCredentialFields({ password_clear: 'x1' }, null, 'pepper-two-xxxxxxxx');
    assert.notEqual(a.fields.password_hash, b.fields.password_hash);
  });
});

describe('data handling routes', () => {
  let w: World;
  let storage: InstanceType<typeof ex.LocalExportStorage>;
  before(async () => {
    w = await buildWorld();
    storage = new ex.LocalExportStorage(exportRoot);
    ex.setExportStorage(storage);
  });
  after(async () => {
    ex.setExportStorage(null);
    await w.close();
    rmSync(exportRoot, { recursive: true, force: true });
  });

  const call = (method: string, url: string, user?: string, body?: unknown) =>
    w.app.inject({
      method: method as 'GET',
      url,
      headers: {
        ...(user ? { cookie: w.cookie(user) } : {}),
        origin: ORIGIN,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
    });
  const code = (r: { json: () => { error?: { code?: string } } }) => r.json().error?.code;
  const audits = (action: string) => w.fake.table('audit_logs').filter((a) => a.action === action);

  it('hash job reads only processed events past the window and writes back hashes', async () => {
    const seen: { sql: string; params: unknown[] }[] = [];
    let written: { id: string; f: Row; r: Row | null }[] = [];
    w.fake.raw.unshift(
      {
        match: /select id, fields, raw from events/,
        rows: (params, f) => {
          seen.push({ sql: f.queries.at(-1)!.sql, params });
          return seen.length > 1
            ? []
            : [
                {
                  id: '00000000-0000-0000-0000-000000000001',
                  fields: { username: 'root', password_clear: 'toor' },
                  raw: null,
                },
              ];
        },
      },
      {
        match: /jsonb_to_recordset/,
        rows: (params) => {
          written = JSON.parse(String(params[0]));
          return [];
        },
      },
    );
    try {
      const n = await maint.hashCapturedCredentials('pepper-for-tests-123', 30);
      assert.equal(n, 1);
      assert.match(seen[0]!.sql, /processed_at is not null/);
      const cutoff = new Date(String(seen[0]!.params[0])).getTime();
      // Never newer than the window: the correlator's 24 h lookback cannot see a hashed event.
      assert.ok(cutoff <= Date.now() - 30 * 86_400_000 + 1000);
      assert.ok(env.CREDENTIAL_HASH_DAYS >= 2);
      assert.equal(written[0]!.f.username, 'root');
      assert.match(String(written[0]!.f.password_hash), /^sha256:/);
      assert.ok(!JSON.stringify(written).includes('toor'));
    } finally {
      w.fake.raw.splice(0, 2);
    }
  });

  it('shows the plan and retention to any member', async () => {
    const viewer = addMember(w.fake, w.b.org, 'viewer');
    const res = await call('GET', `/v1/projects/${w.b.project}/data`, viewer);
    assert.equal(res.statusCode, 200, res.body);
    const b = res.json();
    assert.equal(b.plan.name, 'free');
    assert.equal(b.retention.events_days, Math.min(30, env.RETENTION_DAYS));
    assert.equal(b.retention.credential_hash_days, env.CREDENTIAL_HASH_DAYS);
    assert.equal(b.delete_grace_days, env.PROJECT_DELETE_GRACE_DAYS);
  });

  it('caps retention at the plan, and plan caps follow the org plan', async () => {
    const tooLong = await call('PATCH', `/v1/projects/${w.b.project}`, w.b.owner, {
      retention_days: 365,
    });
    assert.equal(tooLong.statusCode, 422, tooLong.body);
    const prev = env.MAX_PROJECTS_PER_ORG;
    env.MAX_PROJECTS_PER_ORG = 1;
    try {
      const capped = await call('POST', '/v1/projects', w.b.owner, {
        name: 'Second',
        org_id: w.b.org,
      });
      assert.equal(code(capped), 'E_LIMIT_REACHED');
      w.fake.table('organizations').find((o) => o.id === w.b.org)!.plan = 'team';
      const ok = await call('POST', '/v1/projects', w.b.owner, {
        name: 'Second',
        org_id: w.b.org,
      });
      assert.equal(ok.statusCode, 201, ok.body);
      const longer = await call('PATCH', `/v1/projects/${w.b.project}`, w.b.owner, {
        retention_days: 90,
      });
      assert.equal(longer.statusCode, 200, longer.body);
    } finally {
      env.MAX_PROJECTS_PER_ORG = prev;
      w.fake.table('organizations').find((o) => o.id === w.b.org)!.plan = 'free';
    }
  });

  let exportId = '';
  it('only owners request exports; one at a time; every request is audited', async () => {
    const analyst = addMember(w.fake, w.a.org, 'analyst');
    const denied = await call('POST', `/v1/projects/${w.a.project}/export`, analyst, {});
    assert.equal(denied.statusCode, 403);
    const res = await call('POST', `/v1/projects/${w.a.project}/export`, w.a.owner, {});
    assert.equal(res.statusCode, 202, res.body);
    exportId = res.json().id;
    assert.equal(res.json().status, 'pending');
    assert.equal(res.json().download_path, null);
    const again = await call('POST', `/v1/projects/${w.a.project}/export`, w.a.owner, {});
    assert.equal(again.statusCode, 409);
    assert.equal(code(again), 'E_EXPORT_BUSY');
    assert.equal(audits('project.export.request').length, 1);
    const list = await call('GET', `/v1/projects/${w.a.project}/exports`, analyst);
    assert.equal(list.statusCode, 403);
  });

  it('the job streams every table without secrets, and the owner downloads it', async () => {
    const data: Record<string, Row[]> = {
      project: [{ id: w.a.project, name: 'Project a', slug: 'project-a', password_salt: 'SALT' }],
      api_keys: [{ id: w.a.key, prefix: 'ds_live_aaaa', key_hash: 'KEYHASH' }],
      notification_channels: [
        { id: w.a.channel, name: 'ops', url_encrypted: 'ENCURL', secret_encrypted: 'ENCSEC' },
      ],
      honeytokens: [{ id: 'ht1', kind: 'aws', value_sha256: 'HTHASH' }],
      events: Array.from({ length: 1200 }, (_, i) => ({
        id: `ev-${i}`,
        event_type: 'auth.attempt',
        fields: { username: 'root', password_masked: 'a***n' },
      })),
    };
    const batches: number[] = [];
    const source: Parameters<typeof ex.exportProject>[1] = {
      storage,
      workDir: join(exportRoot, '.tmp'),
      source: (spec) =>
        (async function* () {
          const rows = data[spec.name] ?? [];
          for (let i = 0; i < rows.length; i += ex.CURSOR_ROWS) {
            batches.push(i);
            yield rows.slice(i, i + ex.CURSOR_ROWS);
          }
        })(),
    };
    await ex.exportProject(exportId, source);
    // Rows arrive in cursor-sized batches, not as one table.
    assert.ok(batches.length >= 3);
    const row = w.fake.table('project_exports').find((e) => e.id === exportId)!;
    assert.equal(row.status, 'ready', String(row.error));
    assert.ok(row.expires_at);

    // A second run of the same job is a no-op (only `pending` is claimed).
    await ex.exportProject(exportId, source);

    const list = await call('GET', `/v1/projects/${w.a.project}/exports`, w.a.owner);
    const item = list.json().items.find((i: { id: string }) => i.id === exportId);
    assert.equal(item.status, 'ready');
    assert.ok(item.download_path);

    const dl = await call('GET', item.download_path, w.a.owner);
    assert.equal(dl.statusCode, 200, dl.body);
    assert.match(String(dl.headers['content-disposition']), /attachment; filename="lxs-export-/);
    const files = untar(dl.rawPayload);
    const manifest = JSON.parse(files.get('manifest.json')!.toString('utf8'));
    assert.equal(manifest.format, 'lxs-project-export');
    assert.equal(manifest.project.id, w.a.project);
    assert.equal(manifest.tables.length, ex.TABLES.length);
    assert.equal(manifest.tables.find((t: { name: string }) => t.name === 'events').rows, 1200);
    for (const t of manifest.tables) assert.ok(files.has(t.file), `missing ${t.file}`);
    const all = [...files.values()]
      .map((b, i) => (i === 0 ? b.toString('utf8') : JSON.stringify(ndjson(b))))
      .join('\n');
    for (const secret of ['SALT', 'KEYHASH', 'ENCURL', 'ENCSEC', 'HTHASH'])
      assert.ok(!all.includes(secret), `${secret} leaked into the export`);
    assert.equal(ndjson(files.get('tables/events.ndjson.gz')!).length, 1200);
    assert.equal(audits('project.export.download').length, 1);
  });

  it('an expired export is refused and maintenance deletes its file', async () => {
    const row = w.fake.table('project_exports').find((e) => e.id === exportId)!;
    row.expires_at = new Date(Date.now() - 1000);
    const dl = await call(
      'GET',
      `/v1/projects/${w.a.project}/exports/${exportId}/download`,
      w.a.owner,
    );
    assert.equal(dl.statusCode, 410);
    const still = await storage.get(String(row.object_key));
    assert.ok(still);
    still.destroy();
    await new Promise((r) => still.once('close', r));
    const n = await maint.exportCleanup(storage);
    assert.equal(n, 1);
    assert.equal(row.status, 'expired');
    assert.equal(await storage.get(String(row.object_key)), null);
  });

  it('project delete needs the owner and the exact slug, revokes keys and hides it', async () => {
    const analyst = addMember(w.fake, w.a.org, 'analyst');
    const denied = await call('DELETE', `/v1/projects/${w.a.project}`, analyst, {
      confirm: 'project-a',
    });
    assert.equal(denied.statusCode, 403);
    const wrong = await call('DELETE', `/v1/projects/${w.a.project}`, w.a.owner, {
      confirm: 'project-b',
    });
    assert.equal(code(wrong), 'E_CONFIRM_MISMATCH');
    const ok = await call('DELETE', `/v1/projects/${w.a.project}`, w.a.owner, {
      confirm: 'project-a',
    });
    assert.equal(ok.statusCode, 200, ok.body);
    assert.equal(ok.json().keys_revoked, 1);
    const key = w.fake.table('api_keys').find((k) => k.id === w.a.key)!;
    assert.ok(key.revoked_at);
    assert.equal(audits('project.delete').length, 1);
    const get = await call('GET', `/v1/projects/${w.a.project}`, w.a.owner);
    assert.equal(get.statusCode, 404);
    const ingest = await w.app.inject({
      method: 'POST',
      url: '/v1/ingest',
      headers: { authorization: `Bearer ${w.a.ingestKey}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ events: [] }),
    });
    assert.equal(ingest.statusCode, 403);
    const deleted = await call('GET', `/v1/orgs/${w.a.org}/deleted-projects`, w.a.owner);
    assert.equal(deleted.json().items[0].id, w.a.project);
    assert.equal(deleted.json().items[0].restorable, true);
  });

  it('restore is refused once the grace period is over, and the purge removes the project', async () => {
    const p = w.fake.table('projects').find((r) => r.id === w.a.project)!;
    p.purge_after = new Date(Date.now() - 1000);
    const late = await call('POST', `/v1/projects/${w.a.project}/restore`, w.a.owner, {});
    assert.equal(late.statusCode, 410);
    assert.equal(code(late), 'E_PURGE_STARTED');
    const removed: string[] = [];
    const purged = await maint.purgeDeletedProjects({
      kind: 'local',
      put: async () => 0,
      get: async () => null,
      remove: async (k: string) => {
        removed.push(k);
      },
    });
    assert.deepEqual(purged, [w.a.project]);
    assert.ok(!w.fake.table('projects').some((r) => r.id === w.a.project));
    assert.ok(removed.some((k) => k.startsWith(`${w.a.project}/`)));
    assert.equal(audits('project.purge').length, 1);
  });

  it('account delete needs the password and refuses a last owner with other members', async () => {
    const owner = w.b.owner;
    w.fake.table('users').find((u) => u.id === owner)!.password_hash =
      await hashPassword('correct horse');
    const wrong = await call('DELETE', '/v1/me', owner, { password: 'nope' });
    assert.equal(wrong.statusCode, 403);
    assert.equal(code(wrong), 'E_PASSWORD_INVALID');
    // B's org has the viewer added earlier, so its only owner cannot just leave.
    const blocked = await call('DELETE', '/v1/me', owner, { password: 'correct horse' });
    assert.equal(blocked.statusCode, 409, blocked.body);
    assert.equal(code(blocked), 'E_LAST_OWNER');
    assert.ok(w.fake.table('users').some((u) => u.id === owner));
  });

  it('a non-owner member deleting their account just leaves the org', async () => {
    const analyst = addMember(w.fake, w.b.org, 'analyst');
    w.fake.table('users').find((u) => u.id === analyst)!.password_hash =
      await hashPassword('analyst pw');
    const res = await call('DELETE', '/v1/me', analyst, { password: 'analyst pw' });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().orgs_left, 1);
    assert.ok(!w.fake.table('users').some((u) => u.id === analyst));
    assert.ok(!w.fake.table('memberships').some((m) => m.user_id === analyst));
    assert.ok(!w.fake.table('organizations').find((o) => o.id === w.b.org)!.deleted_at);
    assert.match(String(res.headers['set-cookie']), /ds_session=;/);
  });

  it('the sole member deleting their account deletes the org through project soft delete', async () => {
    const owner = w.b.owner;
    w.fake.tables.memberships = w.fake
      .table('memberships')
      .filter((m) => m.org_id !== w.b.org || m.user_id === owner);
    const res = await call('DELETE', '/v1/me', owner, { password: 'correct horse' });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().orgs_deleted, 1);
    assert.ok(res.json().projects_deleted >= 1);
    assert.ok(w.fake.table('organizations').find((o) => o.id === w.b.org)!.deleted_at);
    const live = w.fake.table('projects').filter((p) => p.org_id === w.b.org && !p.deleted_at);
    assert.deepEqual(live, []);
    assert.ok(
      w.fake
        .table('api_keys')
        .filter((k) => k.project_id === w.b.project)
        .every((k) => k.revoked_at),
    );
    assert.ok(!w.fake.table('users').some((u) => u.id === owner));
    assert.ok(audits('org.delete').length >= 1);
  });
});

describe('export bundle pieces', () => {
  it('local storage refuses keys that are not generated export keys', () => {
    const s = new ex.LocalExportStorage(exportRoot);
    assert.throws(() => s.path('../../etc/passwd'));
    assert.throws(() => s.path('a/b.tar'));
    const key = ex.exportKey(
      '11111111-1111-1111-1111-111111111111',
      '22222222-2222-2222-2222-222222222222',
    );
    assert.ok(s.path(key).startsWith(s.root));
  });

  it('every table that carries a secret column excludes it', () => {
    const byName = Object.fromEntries(ex.TABLES.map((t) => [t.name, t.exclude]));
    assert.deepEqual(byName.project, ['password_salt']);
    assert.deepEqual(byName.api_keys, ['key_hash']);
    assert.deepEqual(byName.honeytokens, ['value_sha256']);
    assert.deepEqual(byName.notification_channels, ['url_encrypted', 'secret_encrypted']);
    for (const name of [
      'events',
      'incidents',
      'attackers',
      'detections',
      'incident_notes',
      'blocklist_entries',
      'audit_logs',
      'decoys',
    ])
      assert.ok(name in byName, `${name} is exported`);
  });
});
