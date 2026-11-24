import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  type CheckResult,
  type CommandResult,
  checkBuild,
  checkCompose,
  checkConfig,
  checkDaemon,
  checkDocker,
  checkEndpoint,
  checkImages,
  checkKey,
  checkPorts,
  composeImages,
  type DoctorDeps,
  formatResults,
  type HttpResult,
  readEnv,
  runDoctor,
} from '../src/cli/doctor.js';
import { LXSConfigError } from '../src/errors.js';
import { LXS } from '../src/index.js';

const KEY = 'ds_live_0123456789abcdefABCDEF0123456789';
const CWD = path.resolve('/proj');
const ok = (stdout = ''): CommandResult => ({ code: 0, stdout, stderr: '' });
const no = (stderr = ''): CommandResult => ({ code: 1, stdout: '', stderr });

const CFG = new LXS({ service: 'shop' })
  .create('web-bait', '/.env')
  .create('ssh', 2222, { hostname: 'db-backup-01' })
  .create('postgres', 5433)
  .resolve();

const COMPOSE = `services:
  ds-agent:
    image: \${LXS_AGENT_IMAGE:-ghcr.io/lxs/agent:0.1.0}
  ds-web:
    image: \${LXS_WEB_IMAGE:-ghcr.io/lxs/decoy-web:0.1.0}
`;

type Cmds = Record<string, CommandResult | ((args: string[]) => CommandResult)>;

/** A healthy machine; override any piece. Commands are keyed by their joined args. */
function deps(
  over: Partial<DoctorDeps> & { cmds?: Cmds; http?: DoctorDeps['http'] } = {},
): DoctorDeps {
  const cmds: Cmds = {
    '--version': ok('Docker version 27.3.1, build ce12230'),
    'version --format {{.Server.Version}}': ok('27.3.1\n'),
    'compose version --short': ok('2.29.7\n'),
    'image inspect': ok('[]'),
    'manifest inspect': ok('{}'),
    'ps --format {{.Names}}\t{{.Ports}}': ok(''),
    ...over.cmds,
  };
  const files: Record<string, string> = {
    [path.join(CWD, '.env.lxs')]: `LXS_ENDPOINT=https://api.example.test\nLXS_INGEST_KEY=${KEY}\n`,
    [path.join(CWD, 'lxs.compose.yml')]: COMPOSE,
  };
  const { cmds: _c, ...rest } = over;
  return {
    cwd: CWD,
    env: {},
    run: async (cmd, args) => {
      assert.equal(cmd, 'docker');
      const joined = args.join(' ');
      const hit =
        cmds[joined] ??
        Object.entries(cmds).find(([k]) => joined.startsWith(`${k} `))?.[1] ??
        no('unknown command');
      return typeof hit === 'function' ? hit(args) : hit;
    },
    http: async (url) => {
      if (url.endsWith('/healthz')) return { status: 200, body: { ok: true } };
      if (url.endsWith('/v1/agent/whoami'))
        return { status: 200, body: { project: { id: 'p1', name: 'Acme Shop' } } };
      return { status: 404, body: null };
    },
    portFree: async () => true,
    readFile: (f) => files[f] ?? null,
    loadConfig: async () => CFG,
    buildCheck: async () => ({ fresh: true, detail: 'lxs output is up to date (6 files)' }),
    ...rest,
  };
}

const status = (r: CheckResult) => r.status;

describe('docker checks', () => {
  it('passes on a working install and reports versions', async () => {
    const d = deps();
    assert.equal((await checkDocker(d)).detail, '27.3.1');
    assert.equal(status(await checkDaemon(d, true)), 'ok');
    assert.equal((await checkCompose(d, true)).detail, '2.29.7');
  });

  it('fails with an install hint when docker is missing', async () => {
    const d = deps({ cmds: { '--version': { code: 127, stdout: '', stderr: 'not found' } } });
    const r = await checkDocker(d);
    assert.equal(r.status, 'fail');
    assert.match(r.fix!, /docs\.docker\.com\/get-docker/);
    assert.equal(status(await checkDaemon(d, false)), 'warn');
    assert.equal(status(await checkCompose(d, false)), 'warn');
  });

  it('tells you to start the daemon when it does not answer', async () => {
    const r = await checkDaemon(
      deps({
        cmds: { 'version --format {{.Server.Version}}': no('Cannot connect to the Docker daemon') },
      }),
      true,
    );
    assert.equal(r.status, 'fail');
    assert.match(r.detail!, /Cannot connect/);
    assert.match(r.fix!, /Start Docker Desktop/);
  });

  it('requires compose v2', async () => {
    assert.equal(
      status(await checkCompose(deps({ cmds: { 'compose version --short': no() } }), true)),
      'fail',
    );
    const v1 = await checkCompose(
      deps({ cmds: { 'compose version --short': ok('1.29.2') } }),
      true,
    );
    assert.equal(v1.status, 'fail');
    assert.match(v1.fix!, /v2/);
    assert.equal(
      status(
        await checkCompose(deps({ cmds: { 'compose version --short': ok('v2.30.0') } }), true),
      ),
      'ok',
    );
  });
});

describe('config and ports', () => {
  it('reports the decoy count when the config loads', async () => {
    const r = await checkConfig(deps());
    assert.equal(r.result.status, 'ok');
    assert.match(r.result.detail!, /3 decoys/);
  });

  it('points at lxs init when there is no config, and keeps the hint out of the detail', async () => {
    const missing = await checkConfig(
      deps({
        loadConfig: async () => {
          throw new LXSConfigError(
            'E_CONFIG_NOT_FOUND',
            'no decoy.config.ts found.',
            'Run `npx lxs init` first.',
          );
        },
      }),
    );
    assert.equal(missing.result.status, 'fail');
    assert.match(missing.result.fix!, /lxs init --preset/);
    assert.ok(!missing.result.detail!.includes('Run'));
    assert.equal(missing.cfg, null);

    const bad = await checkConfig(
      deps({
        loadConfig: async () => {
          throw new LXSConfigError(
            'E_PORT_COLLISION',
            'host port 22 is declared twice.',
            'Use another port.',
          );
        },
      }),
    );
    assert.equal(bad.result.fix, 'Use another port.');
  });

  it('checks only network decoy ports', async () => {
    const asked: number[] = [];
    const portFree = async (p: number) => {
      asked.push(p);
      return true;
    };
    const r = await checkPorts(deps({ portFree }), CFG, true);
    assert.equal(r.status, 'ok');
    assert.deepEqual(asked, [2222, 5433]);
  });

  it('fails on a port held by something else, naming the decoy', async () => {
    const r = await checkPorts(deps({ portFree: async (p) => p !== 5433 }), CFG, true);
    assert.equal(r.status, 'fail');
    assert.match(r.detail!, /5433 \(postgres\)/);
    assert.match(r.fix!, /5433/);
  });

  it('accepts a port held by the running decoy container', async () => {
    const r = await checkPorts(
      deps({
        portFree: async (p) => p !== 2222,
        cmds: {
          'ps --format {{.Names}}\t{{.Ports}}': ok(
            'shop-ds-ssh-db-backup-01-1\t0.0.0.0:2222->2222/tcp\n',
          ),
        },
      }),
      CFG,
      true,
    );
    assert.equal(r.status, 'ok');
    assert.match(r.detail!, /running decoys/);
  });

  it('is skipped (warning) when the config did not load', async () => {
    assert.equal(status(await checkPorts(deps(), null, true)), 'warn');
  });
});

describe('.env.lxs, endpoint and key', () => {
  it('reads endpoint and key', () => {
    const r = readEnv(deps());
    assert.equal(r.result.status, 'ok');
    assert.equal(r.endpoint, 'https://api.example.test');
    assert.equal(r.key, KEY);
    assert.ok(!JSON.stringify(r.result).includes(KEY), 'the key is never echoed');
  });

  it('fails on a missing file, a missing endpoint, the placeholder or a malformed key', () => {
    const file = (text: string | null) =>
      readEnv(deps({ readFile: (f) => (f.endsWith('.env.lxs') ? text : null) })).result;
    assert.match(file(null).fix!, /lxs init/);
    assert.match(file(`LXS_INGEST_KEY=${KEY}\n`).detail!, /LXS_ENDPOINT is missing/);
    assert.match(
      file('LXS_ENDPOINT=https://x.test\nLXS_INGEST_KEY=ds_live_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\n')
        .detail!,
      /placeholder/,
    );
    const bad = file('LXS_ENDPOINT=https://x.test\nLXS_INGEST_KEY=hunter2\n');
    assert.equal(bad.status, 'fail');
    assert.ok(!JSON.stringify(bad).includes('hunter2'));
  });

  it('checks /healthz', async () => {
    assert.equal(status(await checkEndpoint(deps(), 'https://api.example.test')), 'ok');
    const down = await checkEndpoint(
      deps({
        http: async () => {
          throw new Error('getaddrinfo ENOTFOUND api.example.test');
        },
      }),
      'https://api.example.test',
    );
    assert.equal(down.status, 'fail');
    assert.match(down.detail!, /ENOTFOUND/);
    const html = await checkEndpoint(
      deps({ http: async () => ({ status: 404, body: null }) }),
      'https://x.test',
    );
    assert.match(html.fix!, /not the dashboard/);
    assert.equal(status(await checkEndpoint(deps(), undefined)), 'warn');
  });

  it('validates the key with whoami and names the project', async () => {
    const seen: { url: string; auth?: string }[] = [];
    const r = await checkKey(
      deps({
        http: async (url, init) => {
          seen.push({ url, auth: init?.headers?.authorization });
          return { status: 200, body: { project: { name: 'Acme Shop' } } };
        },
      }),
      'https://api.example.test',
      KEY,
    );
    assert.equal(r.status, 'ok');
    assert.equal(r.detail, "project 'Acme Shop'");
    assert.deepEqual(seen, [
      { url: 'https://api.example.test/v1/agent/whoami', auth: `Bearer ${KEY}` },
    ]);
  });

  it('falls back to the read-only policy route on servers without whoami', async () => {
    const urls: string[] = [];
    const r = await checkKey(
      deps({
        http: async (url): Promise<HttpResult> => {
          urls.push(url);
          return url.endsWith('/whoami') ? { status: 404, body: null } : { status: 200, body: {} };
        },
      }),
      'https://api.example.test',
      KEY,
    );
    assert.equal(r.status, 'ok');
    assert.deepEqual(
      urls.map((u) => u.split('/').pop()),
      ['whoami', 'policy'],
    );
  });

  it('explains rejected, revoked and rate-limited keys', async () => {
    const answer = (status: number, code?: string) =>
      checkKey(
        deps({ http: async () => ({ status, body: code ? { error: { code } } : null }) }),
        'https://x.test',
        KEY,
      );
    const unknown = await answer(401, 'invalid_key');
    assert.equal(unknown.status, 'fail');
    assert.match(unknown.fix!, /Copy it again/);
    assert.match((await answer(403, 'key_revoked')).fix!, /new key/);
    assert.equal((await answer(429)).status, 'warn');
    assert.equal(status(await checkKey(deps(), undefined, KEY)), 'warn');
  });
});

describe('images and build freshness', () => {
  it('resolves VAR:-default image refs from the environment', () => {
    assert.deepEqual(composeImages(COMPOSE, {}), [
      'ghcr.io/lxs/agent:0.1.0',
      'ghcr.io/lxs/decoy-web:0.1.0',
    ]);
    assert.deepEqual(
      composeImages(COMPOSE, { LXS_AGENT_IMAGE: 'me/agent:dev' })[0],
      'me/agent:dev',
    );
  });

  it('accepts local or pullable images and fails on neither', async () => {
    const local = await checkImages(deps(), true);
    assert.equal(local.status, 'ok');
    assert.match(local.detail!, /2 images \(2 local, 0 pullable\)/);

    const pullable = await checkImages(deps({ cmds: { 'image inspect': no() } }), true);
    assert.match(pullable.detail!, /0 local, 2 pullable/);

    const gone = await checkImages(
      deps({
        cmds: {
          'image inspect': no(),
          'manifest inspect': (args) => (args.at(-1)!.includes('agent') ? no('denied') : ok()),
        },
      }),
      true,
    );
    assert.equal(gone.status, 'fail');
    assert.match(gone.detail!, /ghcr\.io\/lxs\/agent:0\.1\.0/);
    assert.match(gone.fix!, /docker login/);
  });

  it('warns before the first build and when docker is down', async () => {
    assert.equal(status(await checkImages(deps({ readFile: () => null }), true)), 'warn');
    assert.equal(status(await checkImages(deps(), false)), 'warn');
  });

  it('reuses build --check', async () => {
    assert.equal(status(await checkBuild(deps(), true)), 'ok');
    const stale = await checkBuild(
      deps({ buildCheck: async () => ({ fresh: false, detail: 'lxs.compose.yml (out of date)' }) }),
      true,
    );
    assert.equal(stale.status, 'fail');
    assert.match(stale.detail!, /out of date/);
    assert.match(stale.fix!, /lxs build/);
    const thrown = await checkBuild(
      deps({
        buildCheck: async () => {
          throw new LXSConfigError(
            'E_NOT_GITIGNORED',
            '.env.lxs is not git-ignored.',
            'Add it to .gitignore.',
          );
        },
      }),
      true,
    );
    assert.equal(thrown.fix, 'Add it to .gitignore.');
    assert.equal(status(await checkBuild(deps(), false)), 'warn');
  });
});

describe('runDoctor', () => {
  it('prints one line per check, exits 0 when nothing fails', async () => {
    const lines: string[] = [];
    const code = await runDoctor({ cwd: CWD, deps: deps(), log: (m) => lines.push(m) });
    assert.equal(code, 0);
    const checks = lines.filter((l) => /^[✓✗!] /.test(l));
    assert.equal(checks.length, 10);
    assert.ok(
      checks.every((l) => l.startsWith('✓')),
      lines.join('\n'),
    );
    assert.match(lines.at(-1)!, /docker compose .* up -d/);
    assert.ok(!lines.join('\n').includes(KEY));
  });

  it('exits 1 on a failure and prints exactly one fix under it', async () => {
    const lines: string[] = [];
    const code = await runDoctor({
      cwd: CWD,
      deps: deps({ cmds: { 'version --format {{.Server.Version}}': no('daemon down') } }),
      log: (m) => lines.push(m),
    });
    assert.equal(code, 1);
    const i = lines.findIndex((l) => l.startsWith('✗ Docker daemon running'));
    assert.ok(i >= 0, lines.join('\n'));
    assert.match(lines[i + 1]!, /^ {4}fix: /);
    assert.ok(!lines[i + 2]!.startsWith('    fix:'));
    // Docker-dependent checks are skipped, not failed twice.
    assert.ok(lines.some((l) => l.startsWith('! Decoy images')));
  });

  it('--json prints a machine-readable report', async () => {
    const out: string[] = [];
    const code = await runDoctor({
      cwd: CWD,
      json: true,
      deps: deps({ portFree: async () => false }),
      log: (m) => out.push(m),
    });
    assert.equal(code, 1);
    const report = JSON.parse(out.join('\n')) as { ok: boolean; checks: CheckResult[] };
    assert.equal(report.ok, false);
    assert.equal(report.checks.length, 10);
    assert.equal(report.checks.find((c) => c.id === 'ports')!.status, 'fail');
  });

  it('formatResults summarises warnings', () => {
    const lines = formatResults([
      { id: 'a', title: 'A', status: 'ok' },
      { id: 'b', title: 'B', status: 'warn', detail: 'meh' },
    ]);
    assert.match(lines.at(-1)!, /All set \(1 warning\)/);
  });
});
