/**
 * Project export (H5). One job writes a bundle of everything a project holds, minus secrets:
 *
 *   lxs-export-<slug>-<date>.tar
 *     manifest.json            format, project, per-table row counts and sha256, exclusions
 *     tables/<table>.ndjson.gz one JSON object per line, gzip
 *
 * Rows are streamed from a Postgres cursor through gzip to disk, so no table is ever held in
 * memory. Secret columns are dropped in SQL (`to_jsonb(t) - 'col'`) and again in JS before a
 * row is written. The finished tar goes to EXPORT_STORAGE and is downloadable for
 * EXPORT_TTL_HOURS; maintenance deletes it afterwards.
 */
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, open, rename, rm, stat, unlink } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { and, eq } from 'drizzle-orm';
import { db, sql as rawSql } from '../db/client.js';
import { projectExports, projects } from '../db/schema.js';
import { env } from '../env.js';
import { audit } from '../lib/audit.js';

export type Row = Record<string, unknown>;

/* ------------------------------- storage ------------------------------- */

/** Where finished bundles live. Keys are `<project id>/<export id>.tar`. */
export interface ExportStorage {
  readonly kind: 'local' | 's3';
  /** Move a finished local file into storage; returns its size in bytes. */
  put(key: string, localPath: string): Promise<number>;
  /** A stream of the stored object, or null when it is gone. */
  get(key: string): Promise<Readable | null>;
  remove(key: string): Promise<void>;
}

const SAFE_KEY = /^[0-9a-f-]{36}\/[0-9a-f-]{36}\.tar$/;

export class LocalExportStorage implements ExportStorage {
  readonly kind = 'local' as const;
  readonly root: string;
  constructor(root: string) {
    this.root = resolve(root);
  }
  /** Absolute path for a key; refuses anything that is not a generated key. */
  path(key: string): string {
    if (!SAFE_KEY.test(key)) throw new Error(`invalid export key: ${key}`);
    const p = resolve(this.root, key);
    if (!p.startsWith(this.root + sep)) throw new Error(`invalid export key: ${key}`);
    return p;
  }
  async put(key: string, localPath: string): Promise<number> {
    const dest = this.path(key);
    await mkdir(dirname(dest), { recursive: true });
    await rename(localPath, dest);
    return (await stat(dest)).size;
  }
  async get(key: string): Promise<Readable | null> {
    // Open now, so a file removed between this check and the read cannot error mid-response.
    const fh = await open(this.path(key), 'r').catch(() => null);
    return fh ? fh.createReadStream() : null;
  }
  async remove(key: string): Promise<void> {
    await unlink(this.path(key)).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== 'ENOENT') throw err;
    });
  }
}

/**
 * S3 adapter: not implemented. `@aws-sdk/client-s3` is not a dependency yet, and env.ts
 * refuses EXPORT_STORAGE=s3 at boot so this is never reached by accident.
 * TODO(H5): add @aws-sdk/client-s3 and implement put (multipart Upload from a file stream,
 * SSE on), get (GetObject Body stream) and remove (DeleteObject) under EXPORT_S3_PREFIX,
 * plus a bucket lifecycle rule as a second line of expiry.
 */
export class S3ExportStorage implements ExportStorage {
  readonly kind = 's3' as const;
  constructor(
    readonly bucket: string | undefined,
    readonly prefix: string,
  ) {}
  put(): Promise<number> {
    return Promise.reject(new Error('EXPORT_STORAGE=s3 is not implemented'));
  }
  get(): Promise<Readable | null> {
    return Promise.reject(new Error('EXPORT_STORAGE=s3 is not implemented'));
  }
  remove(): Promise<void> {
    return Promise.reject(new Error('EXPORT_STORAGE=s3 is not implemented'));
  }
}

let storageOverride: ExportStorage | null = null;
/** Tests swap the storage; pass null to restore the configured one. */
export const setExportStorage = (s: ExportStorage | null): void => {
  storageOverride = s;
};
export function exportStorage(): ExportStorage {
  if (storageOverride) return storageOverride;
  return env.EXPORT_STORAGE === 's3'
    ? new S3ExportStorage(env.EXPORT_S3_BUCKET, env.EXPORT_S3_PREFIX)
    : new LocalExportStorage(env.EXPORT_DIR);
}

export const exportKey = (projectId: string, exportId: string): string =>
  `${projectId}/${exportId}.tar`;

/* --------------------------------- tar --------------------------------- */

/** A 512-byte ustar header for a regular file. Names must be ASCII and under 100 bytes. */
export function tarHeader(name: string, size: number, mtime = new Date()): Buffer {
  if (Buffer.byteLength(name) > 99) throw new Error(`tar name too long: ${name}`);
  const h = Buffer.alloc(512, 0);
  const put = (s: string, off: number, len: number) => h.write(s, off, len, 'ascii');
  const oct = (n: number, len: number) => `${n.toString(8).padStart(len - 1, '0')}\0`;
  put(name, 0, 100);
  put(oct(0o644, 8), 100, 8);
  put(oct(0, 8), 108, 8);
  put(oct(0, 8), 116, 8);
  put(oct(size, 12), 124, 12);
  put(oct(Math.floor(mtime.getTime() / 1000), 12), 136, 12);
  put('        ', 148, 8); // checksum placeholder: eight spaces
  put('0', 156, 1); // regular file
  put('ustar\0', 257, 6);
  put('00', 263, 2);
  put('lxs', 265, 32);
  put('lxs', 297, 32);
  let sum = 0;
  for (const b of h) sum += b;
  put(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8);
  return h;
}

/** Write a tar of local files to `out`, streaming each file's bytes. */
export async function writeTar(
  out: string,
  entries: { name: string; path: string }[],
): Promise<void> {
  async function* chunks() {
    for (const e of entries) {
      const { size } = await stat(e.path);
      yield tarHeader(e.name, size);
      for await (const c of createReadStream(e.path)) yield c as Buffer;
      const pad = (512 - (size % 512)) % 512;
      if (pad) yield Buffer.alloc(pad, 0);
    }
    yield Buffer.alloc(1024, 0); // two zero blocks end the archive
  }
  await pipeline(Readable.from(chunks()), createWriteStream(out));
}

/* -------------------------------- tables ------------------------------- */

type Sql = typeof rawSql;

export interface TableSpec {
  name: string;
  /** Columns that never leave the database: secrets, key hashes, encrypted values. */
  exclude: string[];
  /** Rows as `{ r: <jsonb row> }`, in a stable order. */
  query: (sql: Sql, projectId: string) => unknown;
}

/**
 * Every table that belongs to a project. Excluded: the project's password salt, ingest key
 * hashes, honeytoken value hashes, and the encrypted webhook URLs and signing secrets.
 * Attacker-typed credentials in `events` are the customer's telemetry and are included as
 * stored (clear only for the common-credentials list, else masked/salted, or hashed after
 * CREDENTIAL_HASH_DAYS).
 */
export const TABLES: TableSpec[] = [
  {
    name: 'project',
    exclude: ['password_salt'],
    query: (sql, pid) =>
      sql`select to_jsonb(t) - 'password_salt' as r from projects t where t.id = ${pid}::uuid`,
  },
  {
    name: 'sensors',
    exclude: [],
    query: (sql, pid) =>
      sql`select to_jsonb(t) as r from sensors t where t.project_id = ${pid}::uuid order by t.first_seen_at, t.id`,
  },
  {
    name: 'decoys',
    exclude: [],
    query: (sql, pid) =>
      sql`select to_jsonb(t) as r from decoys t where t.project_id = ${pid}::uuid order by t.decoy_key, t.id`,
  },
  {
    name: 'api_keys',
    exclude: ['key_hash'],
    query: (sql, pid) =>
      sql`select to_jsonb(t) - 'key_hash' as r from api_keys t where t.project_id = ${pid}::uuid order by t.created_at, t.id`,
  },
  {
    name: 'attackers',
    exclude: [],
    query: (sql, pid) =>
      sql`select to_jsonb(t) as r from attackers t where t.project_id = ${pid}::uuid order by t.first_seen_at, t.id`,
  },
  {
    name: 'incidents',
    exclude: [],
    query: (sql, pid) =>
      sql`select to_jsonb(t) as r from incidents t where t.project_id = ${pid}::uuid order by t.number`,
  },
  {
    name: 'detections',
    exclude: [],
    query: (sql, pid) =>
      sql`select to_jsonb(d) as r from detections d join incidents i on i.id = d.incident_id
          where i.project_id = ${pid}::uuid order by i.number, d.created_at, d.id`,
  },
  {
    name: 'incident_notes',
    exclude: [],
    query: (sql, pid) =>
      sql`select to_jsonb(n) as r from incident_notes n join incidents i on i.id = n.incident_id
          where i.project_id = ${pid}::uuid order by i.number, n.created_at, n.id`,
  },
  {
    name: 'ai_summaries',
    exclude: [],
    query: (sql, pid) =>
      sql`select to_jsonb(s) as r from ai_summaries s join incidents i on i.id = s.incident_id
          where i.project_id = ${pid}::uuid order by i.number, s.created_at, s.id`,
  },
  {
    name: 'events',
    exclude: [],
    query: (sql, pid) =>
      sql`select to_jsonb(t) as r from events t where t.project_id = ${pid}::uuid order by t.received_at, t.id`,
  },
  {
    name: 'blocklist_entries',
    exclude: [],
    query: (sql, pid) =>
      sql`select to_jsonb(t) as r from blocklist_entries t where t.project_id = ${pid}::uuid order by t.created_at, t.id`,
  },
  {
    name: 'response_actions',
    exclude: [],
    query: (sql, pid) =>
      sql`select to_jsonb(t) as r from response_actions t where t.project_id = ${pid}::uuid order by t.requested_at, t.id`,
  },
  {
    name: 'honeytokens',
    exclude: ['value_sha256'],
    query: (sql, pid) =>
      sql`select to_jsonb(t) - 'value_sha256' as r from honeytokens t where t.project_id = ${pid}::uuid order by t.created_at, t.id`,
  },
  {
    name: 'notification_channels',
    exclude: ['url_encrypted', 'secret_encrypted'],
    query: (sql, pid) =>
      sql`select to_jsonb(t) - 'url_encrypted' - 'secret_encrypted' as r from notification_channels t
          where t.project_id = ${pid}::uuid order by t.created_at, t.id`,
  },
  {
    name: 'containment_reports',
    exclude: [],
    query: (sql, pid) =>
      sql`select to_jsonb(t) as r from containment_reports t where t.project_id = ${pid}::uuid order by t.created_at, t.id`,
  },
  {
    name: 'audit_logs',
    exclude: [],
    query: (sql, pid) =>
      sql`select to_jsonb(t) as r from audit_logs t where t.project_id = ${pid}::uuid order by t.created_at, t.id`,
  },
];

/** Batches of rows for one table. The default reads a server-side cursor 500 rows at a time. */
export type RowSource = (spec: TableSpec, projectId: string) => AsyncIterable<Row[]>;

export const CURSOR_ROWS = 500;

const cursorSource: RowSource = (spec, projectId) => {
  const q = spec.query(rawSql, projectId) as unknown as {
    cursor: (n: number) => AsyncIterable<{ r: Row }[]>;
  };
  const it = q.cursor(CURSOR_ROWS);
  return (async function* () {
    for await (const batch of it) yield batch.map((x) => x.r);
  })();
};

export function omit(row: Row, keys: string[]): Row {
  if (keys.length === 0) return row;
  const out: Row = {};
  for (const [k, v] of Object.entries(row)) if (!keys.includes(k)) out[k] = v;
  return out;
}

/** Stream one table to `<file>` as gzip NDJSON. Returns the row count and the file's sha256. */
export async function writeTable(
  spec: TableSpec,
  projectId: string,
  file: string,
  source: RowSource,
): Promise<{ rows: number; sha256: string; bytes: number }> {
  let rows = 0;
  async function* lines() {
    for await (const batch of source(spec, projectId))
      for (const r of batch) {
        rows++;
        yield `${JSON.stringify(omit(r, spec.exclude))}\n`;
      }
  }
  const hash = createHash('sha256');
  let bytes = 0;
  const gzip = createGzip();
  gzip.on('data', (c: Buffer) => {
    hash.update(c);
    bytes += c.length;
  });
  await pipeline(Readable.from(lines()), gzip, createWriteStream(file));
  return { rows, sha256: hash.digest('hex'), bytes };
}

/* --------------------------------- job --------------------------------- */

export interface ExportDeps {
  source?: RowSource;
  storage?: ExportStorage;
  /** Scratch space for the bundle before it is handed to storage. */
  workDir?: string;
  now?: () => Date;
}

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 500);

/**
 * Run one export. Only an export still `pending` is picked up (claimed atomically), so a
 * duplicate job is a no-op. A failure marks the row `failed` with the reason.
 */
export async function exportProject(exportId: string, deps: ExportDeps = {}): Promise<void> {
  const source = deps.source ?? cursorSource;
  const storage = deps.storage ?? exportStorage();
  const now = deps.now ?? (() => new Date());

  const [claimed] = await db
    .update(projectExports)
    .set({ status: 'running', startedAt: now() })
    .where(and(eq(projectExports.id, exportId), eq(projectExports.status, 'pending')))
    .returning();
  if (!claimed) return;

  const work = resolve(deps.workDir ?? join(env.EXPORT_DIR, '.tmp'), exportId);
  try {
    const [project] = await db
      .select({ id: projects.id, name: projects.name, slug: projects.slug, orgId: projects.orgId })
      .from(projects)
      .where(eq(projects.id, claimed.projectId))
      .limit(1);
    if (!project) throw new Error('project no longer exists');

    await mkdir(join(work, 'tables'), { recursive: true });
    const tables: { name: string; file: string; rows: number; sha256: string; bytes: number }[] =
      [];
    for (const spec of TABLES) {
      const file = `tables/${spec.name}.ndjson.gz`;
      const r = await writeTable(spec, project.id, join(work, file), source);
      tables.push({ name: spec.name, file, ...r });
    }
    const createdAt = now();
    const manifest = {
      format: 'lxs-project-export',
      version: 1,
      export_id: exportId,
      created_at: createdAt.toISOString(),
      project: { id: project.id, org_id: project.orgId, name: project.name, slug: project.slug },
      encoding: 'one JSON object per line (NDJSON), gzip; column names as in the database',
      tables,
      excluded: Object.fromEntries(
        TABLES.filter((t) => t.exclude.length).map((t) => [t.name, t.exclude]),
      ),
      notes: [
        'Secrets are not exported: the project password salt, ingest key hashes, honeytoken value hashes, and encrypted alert URLs and signing secrets.',
        'Captured passwords are as stored: clear only for the common-credentials list, otherwise masked and salted; events older than the credential-hashing window carry password_hash (sha256 with a deployment pepper) and password_length instead.',
      ],
    };
    const manifestPath = join(work, 'manifest.json');
    const fh = await open(manifestPath, 'w');
    await fh.writeFile(`${JSON.stringify(manifest, null, 2)}\n`);
    await fh.close();

    const tarPath = join(work, 'bundle.tar');
    await writeTar(tarPath, [
      { name: 'manifest.json', path: manifestPath },
      ...tables.map((t) => ({ name: t.file, path: join(work, t.file) })),
    ]);
    const key = exportKey(project.id, exportId);
    const size = await storage.put(key, tarPath);
    const done = now();
    await db
      .update(projectExports)
      .set({
        status: 'ready',
        storage: storage.kind,
        objectKey: key,
        sizeBytes: size,
        rowCounts: Object.fromEntries(tables.map((t) => [t.name, t.rows])),
        completedAt: done,
        expiresAt: new Date(done.getTime() + env.EXPORT_TTL_HOURS * 3_600_000),
      })
      .where(eq(projectExports.id, exportId));
    await audit(db, {
      orgId: project.orgId,
      projectId: project.id,
      actorType: 'system',
      action: 'project.export.ready',
      targetType: 'project_export',
      targetId: exportId,
      metadata: { size_bytes: size, rows: tables.reduce((n, t) => n + t.rows, 0) },
    });
  } catch (err) {
    await db
      .update(projectExports)
      .set({ status: 'failed', error: errText(err), completedAt: now() })
      .where(eq(projectExports.id, exportId));
    throw err;
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }
}
