/**
 * A tiny in-memory stand-in for Postgres, plugged in under drizzle.
 *
 * drizzle's postgres-js session sends every query through `client.unsafe(sql, params)`
 * (and transactions through `client.begin`). Swapping that client on the live `db`
 * object lets route tests run the real Fastify app, real auth plugins and real
 * handlers with no database. The "engine" understands just the SQL drizzle emits for
 * simple CRUD: one FROM table, inner/left joins on column equality, WHERE built from
 * `=`, `<>`, `>`, `<`, `IS [NOT] NULL` and `IN`, LIMIT, INSERT ... VALUES, UPDATE ... SET
 * col = $n, DELETE and RETURNING. Anything else (raw `db.execute`, aggregates) goes to
 * `raw` handlers or returns no rows. ORs are treated as ANDs (stricter, never looser).
 *
 * The raw postgres.js `sql` tag is NOT faked: a handler that reaches it fails with a
 * connection error, which a test sees as a 500.
 */
import { randomUUID } from 'node:crypto';
import { db } from '../../src/db/client.ts';

export type Row = Record<string, unknown>;
type RowSet = Record<string, Row | null>;

export interface RawHandler {
  match: RegExp;
  rows: (params: unknown[], fake: FakeDb) => Row[];
}

function splitTop(s: string, sep = ','): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = false;
  let cur = '';
  for (const ch of s) {
    if (ch === '"') quote = !quote;
    if (!quote && ch === '(') depth++;
    if (!quote && ch === ')') depth--;
    if (!quote && depth === 0 && ch === sep) {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** Index of the ` from ` that ends the select list (ignoring subqueries); -1 if none. */
function topLevelFrom(q: string): number {
  let depth = 0;
  let quote = false;
  for (let i = 0; i < q.length; i++) {
    const ch = q[i];
    if (ch === '"') quote = !quote;
    if (quote) continue;
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (depth === 0 && q.startsWith(' from ', i)) return i;
  }
  return -1;
}

/** The column an output expression names: `"t"."c"` → [t, c]; `"c"` → [null, c]. */
function colRef(expr: string): [string | null, string] | null {
  const q = expr.match(/^"(\w+)"\."(\w+)"$/);
  if (q) return [q[1]!, q[2]!];
  const u = expr.match(/^"(\w+)"$/);
  if (u) return [null, u[1]!];
  return null;
}

function norm(v: unknown): unknown {
  if (v instanceof Date) return v.getTime();
  if (Buffer.isBuffer(v)) return v.toString('hex');
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v)) return new Date(v).getTime();
  return v;
}

function cmp(a: unknown, op: string, b: unknown): boolean {
  const x = norm(a);
  const y = norm(b);
  if (x == null || y == null) return false;
  switch (op) {
    case '=':
      return String(x) === String(y);
    case '<>':
      return String(x) !== String(y);
    case '>':
      return (x as number) > (y as number);
    case '<':
      return (x as number) < (y as number);
    case '>=':
      return (x as number) >= (y as number);
    case '<=':
      return (x as number) <= (y as number);
  }
  return true;
}

export class FakeDb {
  tables: Record<string, Row[]> = {};
  raw: RawHandler[] = [];
  /** Column defaults applied on INSERT (Postgres DEFAULTs the fake cannot know). */
  defaults: Record<string, Row> = {};
  queries: { sql: string; params: unknown[] }[] = [];

  table(name: string): Row[] {
    this.tables[name] ??= [];
    return this.tables[name]!;
  }

  private value(set: RowSet, primary: string, ref: string, params: unknown[]): unknown {
    const p = ref.match(/^\$(\d+)$/);
    if (p) return params[Number(p[1]) - 1];
    if (ref === 'now()') return new Date();
    const c = ref.replace(/::\w+/g, '').match(/^"(\w+)"\."(\w+)"$/);
    if (c) return set[c[1]!]?.[c[2]!];
    const u = ref.match(/^"(\w+)"$/);
    if (u) return set[primary]?.[u[1]!];
    return undefined;
  }

  private matches(set: RowSet, primary: string, where: string, params: unknown[]): boolean {
    const atom =
      /("\w+"\."\w+"(?:::\w+)?)\s*(=|<>|>=|<=|>|<)\s*(\$\d+|now\(\)|"\w+"\."\w+"(?:::\w+)?)/g;
    for (const m of where.matchAll(atom))
      if (
        !cmp(
          this.value(set, primary, m[1]!, params),
          m[2]!,
          this.value(set, primary, m[3]!, params),
        )
      )
        return false;
    for (const m of where.matchAll(/("\w+"\."\w+") is (not )?null/g)) {
      const v = this.value(set, primary, m[1]!, params);
      if (m[2] ? v == null : v != null) return false;
    }
    for (const m of where.matchAll(/("\w+"\."\w+") in \(([^)]*)\)/g)) {
      const v = this.value(set, primary, m[1]!, params);
      const opts = splitTop(m[2]!).map((r) => this.value(set, primary, r, params));
      if (!opts.some((o) => cmp(v, '=', o))) return false;
    }
    return true;
  }

  private clause(sql: string, start: string): string {
    const i = sql.search(new RegExp(` ${start} `));
    if (i < 0) return '';
    const rest = sql.slice(i + start.length + 2);
    const end = rest.search(/ (order by|limit|returning|for update|group by|offset) /);
    return end < 0 ? rest : rest.slice(0, end);
  }

  private project(sets: RowSet[], primary: string, list: string): unknown[][] {
    const cols = splitTop(list).map(colRef);
    return sets.map((s) =>
      cols.map((c) => (c ? (c[0] ? s[c[0]]?.[c[1]] : s[primary]?.[c[1]]) : null) ?? null),
    );
  }

  /** Execute one statement; returns rows as arrays of the output columns, plus objects. */
  run(sql: string, params: unknown[]): { arrays: unknown[][]; objects: Row[] } {
    this.queries.push({ sql, params });
    for (const h of this.raw)
      if (h.match.test(sql)) {
        const objects = h.rows(params, this);
        return { arrays: objects.map((o) => Object.values(o)), objects };
      }
    const q = sql.replace(/\s+/g, ' ').trim();
    if (/^select /i.test(q) && topLevelFrom(q) > 0) {
      const at = topLevelFrom(q);
      const list = q.slice(7, at);
      const fm = q.slice(at).match(/^ from "(\w+)"(.*)$/i);
      if (!fm) return { arrays: [], objects: [] };
      const [, primary, tail] = fm as unknown as [string, string, string];
      let sets: RowSet[] = this.table(primary).map((r) => ({ [primary]: r }));
      for (const j of tail.matchAll(
        / (inner|left) join "(\w+)" on (.+?)(?= (?:inner|left) join | where | order by | limit |$)/g,
      )) {
        const [, kind, t, on] = j as unknown as [string, string, string, string];
        const next: RowSet[] = [];
        for (const s of sets) {
          const hits = this.table(t).filter((r) =>
            this.matches({ ...s, [t]: r }, primary, on, params),
          );
          if (hits.length) for (const h of hits) next.push({ ...s, [t]: h });
          else if (kind === 'left') next.push({ ...s, [t]: null });
        }
        sets = next;
      }
      const where = this.clause(` ${tail} `, 'where');
      sets = sets.filter((s) => this.matches(s, primary, where, params));
      const lim = q.match(/ limit \$(\d+)/);
      if (lim) sets = sets.slice(0, Number(params[Number(lim[1]) - 1]));
      const arrays = this.project(sets, primary, list);
      return { arrays, objects: sets.map((s) => ({ ...s[primary] })) };
    }

    const ins = q.match(
      /^insert into "(\w+)" \(([^)]*)\) values (.+?)(?: on conflict .*?)?(?: returning (.+))?$/i,
    );
    if (ins) {
      const [, t, colList, valuesPart, returning] = ins as unknown as [
        string,
        string,
        string,
        string,
        string?,
      ];
      const cols = splitTop(colList).map((c) => c.replace(/"/g, ''));
      const tuples = splitTop(valuesPart).map((tuple) => splitTop(tuple.replace(/^\(|\)$/g, '')));
      const inserted: Row[] = [];
      for (const tuple of tuples) {
        const row: Row = { id: randomUUID(), created_at: new Date(), ...this.defaults[t] };
        cols.forEach((c, i) => {
          const v = tuple[i]!;
          if (v === 'default') return;
          row[c] = this.value({}, t, v, params);
        });
        this.table(t).push(row);
        inserted.push(row);
      }
      const arrays = returning
        ? this.project(
            inserted.map((r) => ({ [t]: r })),
            t,
            returning,
          )
        : [];
      return { arrays, objects: inserted };
    }

    const upd = q.match(/^update "(\w+)" set (.+?)(?: where (.+?))?(?: returning (.+))?$/i);
    if (upd) {
      const [, t, setPart, where = '', returning] = upd as unknown as [
        string,
        string,
        string,
        string?,
        string?,
      ];
      const hits = this.table(t).filter((r) => this.matches({ [t]: r }, t, where, params));
      for (const r of hits)
        for (const a of splitTop(setPart)) {
          const s = a.match(/^"(\w+)" = (.+)$/);
          if (!s) continue;
          const [, col, expr] = s as unknown as [string, string, string];
          if (/^\$\d+$/.test(expr) || expr === 'now()') r[col] = this.value({}, t, expr, params);
          else if (/^null$/i.test(expr)) r[col] = null;
          else if (/\+ 1$/.test(expr)) r[col] = Number(r[col] ?? 0) + 1;
          else if (/^coalesce\(/.test(expr)) r[col] ??= new Date();
        }
      const arrays = returning
        ? this.project(
            hits.map((r) => ({ [t]: r })),
            t,
            returning,
          )
        : [];
      return { arrays, objects: hits };
    }

    const del = q.match(/^delete from "(\w+)"(?: where (.+?))?(?: returning (.+))?$/i);
    if (del) {
      const [, t, where = ''] = del as unknown as [string, string, string?];
      const rows = this.table(t);
      const gone = rows.filter((r) => this.matches({ [t]: r }, t, where, params));
      this.tables[t] = rows.filter((r) => !gone.includes(r));
      return { arrays: [], objects: gone };
    }

    return { arrays: [], objects: [] };
  }

  /** The postgres.js-shaped client drizzle talks to. */
  client(): unknown {
    const self = this;
    const client = {
      unsafe(sql: string, params: unknown[] = []) {
        const exec = () => Promise.resolve().then(() => self.run(sql, params));
        return {
          values: () => exec().then((r) => r.arrays),
          // biome-ignore lint/suspicious/noThenProperty: mimics postgres.js' thenable query
          then: (ok: (v: unknown) => unknown, err?: (e: unknown) => unknown) =>
            exec()
              .then((r) => r.objects)
              .then(ok, err),
        };
      },
      begin: (fn: (c: unknown) => unknown) => Promise.resolve().then(() => fn(client)),
      savepoint: (fn: (c: unknown) => unknown) => Promise.resolve().then(() => fn(client)),
    };
    return client;
  }
}

/** Route every drizzle query on the shared `db` to `fake`. Returns an uninstaller. */
export function installFakeDb(fake: FakeDb): () => void {
  const session = (db as unknown as { session: { client: unknown } }).session;
  const prev = session.client;
  session.client = fake.client();
  return () => {
    session.client = prev;
  };
}
