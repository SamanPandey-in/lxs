import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { COMPOSE_FILE } from '../generate/index.js';

export interface Check {
  name: string;
  target: string;
  passed: boolean;
  /** Skipped checks are shown but not counted (e.g. host firewall without sudo, Docker Desktop). */
  skipped?: boolean;
  detail: string;
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type Runner = (
  cmd: string,
  args: string[],
  opts?: { timeoutMs?: number },
) => Promise<ExecResult>;

export const defaultRunner: Runner = (cmd, args, opts) =>
  new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { timeout: opts?.timeoutMs ?? 20_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        const code = err
          ? typeof (err as { code?: unknown }).code === 'number'
            ? (err as { code: number }).code
            : 127
          : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });

export interface SelftestOptions {
  cwd: string;
  report?: boolean;
  runner?: Runner;
  log?: (msg: string) => void;
}

interface ManifestDecoy {
  id: string;
  type: string;
  mount: string | number;
}
interface Manifest {
  service: string;
  decoys: ManifestDecoy[];
}

const PROBE_PY = `import socket,sys
h,p=sys.argv[1],int(sys.argv[2])
s=socket.socket();s.settimeout(2)
try:
    s.connect((h,p));print("OPEN")
except Exception:
    print("BLOCKED")
`;

const FS_PROBE_JS = "process.stdout.write(require('fs').readFileSync('/proc/net/dev','utf8'))";

const REPORT_JS = `const http=require('http');const body=process.argv[1];
const r=http.request({socketPath:'/run/lxs/agent/agent.sock',method:'POST',path:'/v1/selftest-report',headers:{'content-type':'application/json','content-length':Buffer.byteLength(body)},timeout:8000},res=>{res.resume();res.on('end',()=>process.exit(res.statusCode<300?0:1));});
r.on('error',()=>process.exit(2));r.end(body);`;

function readManifest(cwd: string): Manifest {
  const p = path.join(cwd, '.lxs/manifest.json');
  if (!fs.existsSync(p))
    throw new Error('.lxs/manifest.json not found. Run `npx lxs build` first.');
  return JSON.parse(fs.readFileSync(p, 'utf8')) as Manifest;
}

function readEndpoint(cwd: string): string | null {
  try {
    const env = fs.readFileSync(path.join(cwd, '.env.lxs'), 'utf8');
    const m = /^LXS_ENDPOINT=(.+)$/m.exec(env);
    return m?.[1]?.trim() ?? null;
  } catch {
    return null;
  }
}

export async function runSelftest(
  opts: SelftestOptions,
): Promise<{ passed: boolean; checks: Check[] }> {
  const run = opts.runner ?? defaultRunner;
  const log = opts.log ?? console.log;
  const manifest = readManifest(opts.cwd);
  const checks: Check[] = [];
  const add = (c: Check): void => {
    checks.push(c);
  };

  const composeFiles: string[] = [];
  for (const c of ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml']) {
    if (fs.existsSync(path.join(opts.cwd, c))) {
      composeFiles.push(c);
      break;
    }
  }
  composeFiles.push(COMPOSE_FILE);
  const composeArgs = composeFiles.flatMap((f) => ['-f', f]);

  const docker = await run('docker', ['version', '--format', '{{.Server.Version}}']);
  if (docker.code !== 0) {
    throw new Error(
      'docker is not reachable. Start the stack first: docker compose -f docker-compose.yml -f lxs.compose.yml up -d',
    );
  }

  const info = await run('docker', ['info', '--format', '{{.OperatingSystem}}']);
  if (/docker desktop/i.test(info.stdout)) {
    log(
      'note: Docker Desktop detected. Host firewall rules (infra/victim/ds-firewall.sh) cannot be applied here, so network-egress',
    );
    log(
      '      probes from the SSH decoy are expected to FAIL on this machine. Run selftest on the Linux victim host for a real result.',
    );
  }

  const idOf = async (service: string): Promise<string | null> => {
    const r = await run('docker', ['compose', ...composeArgs, 'ps', '-q', service]);
    const id = r.stdout.trim().split(/\s+/)[0];
    return r.code === 0 && id ? id : null;
  };
  const exec = (id: string, args: string[]): Promise<ExecResult> =>
    run('docker', ['exec', id, ...args], { timeoutMs: 15_000 });
  // Distroless images keep node at /nodejs/bin/node and have no shell; other images have it on PATH.
  const notFound = (r: ExecResult): boolean =>
    r.code === 126 ||
    r.code === 127 ||
    /executable file not found|no such file or directory|OCI runtime exec failed/i.test(r.stderr);
  const execNode = async (id: string, args: string[]): Promise<ExecResult> => {
    const first = await exec(id, ['/nodejs/bin/node', ...args]);
    return notFound(first) ? exec(id, ['node', ...args]) : first;
  };

  const sshDecoys = manifest.decoys.filter((d) => d.type === 'ssh');
  const services = [
    'ds-agent',
    ...(manifest.decoys.some((d) => d.type.startsWith('web')) ? ['ds-web'] : []),
    ...sshDecoys.map((d) => `ds-${d.id}`),
  ];

  const ids = new Map<string, string>();
  for (const s of services) {
    const id = await idOf(s);
    if (!id) add({ name: 'container running', target: s, passed: false, detail: 'not running' });
    else ids.set(s, id);
  }

  /* hardening, from docker inspect */
  for (const [svc, id] of ids) {
    const r = await run('docker', ['inspect', id]);
    if (r.code !== 0) {
      add({
        name: 'docker inspect',
        target: svc,
        passed: false,
        detail: r.stderr.trim() || 'failed',
      });
      continue;
    }
    const info = (JSON.parse(r.stdout) as Array<Record<string, any>>)[0] ?? {};
    const hc = (info.HostConfig ?? {}) as Record<string, any>;
    const user = String(info.Config?.User ?? '');
    const problems: string[] = [];
    if (hc.ReadonlyRootfs !== true) problems.push('rootfs writable');
    if (!(hc.CapDrop ?? []).map(String).some((c: string) => c.toUpperCase() === 'ALL'))
      problems.push('capabilities not dropped');
    if (!(hc.SecurityOpt ?? []).some((o: string) => o.startsWith('no-new-privileges')))
      problems.push('no-new-privileges missing');
    if (!(hc.Memory > 0)) problems.push('no memory limit');
    if (!(hc.PidsLimit > 0)) problems.push('no pids limit');
    if (user === '' || user === '0' || user === 'root' || user.startsWith('0:'))
      problems.push('runs as root');
    add({
      name: 'read-only rootfs, caps ALL dropped, no-new-privileges, non-root, limits',
      target: svc,
      passed: problems.length === 0,
      detail: problems.length === 0 ? 'ok' : problems.join('; '),
    });

    if (svc === 'ds-web') {
      add({
        name: 'network mode',
        target: svc,
        passed: hc.NetworkMode === 'none',
        detail: String(hc.NetworkMode),
      });
    }
    if (svc.startsWith('ds-ssh') || sshDecoys.some((d) => `ds-${d.id}` === svc)) {
      const nets = Object.keys((info.NetworkSettings?.Networks ?? {}) as Record<string, unknown>);
      add({
        name: 'attached networks',
        target: svc,
        passed: nets.length === 1 && (nets[0] ?? '').endsWith('ds_trap'),
        detail: nets.join(', ') || 'none',
      });
    }
  }

  /* ds-web: lo only, no agent socket */
  const web = ids.get('ds-web');
  if (web) {
    const r = await execNode(web, ['-e', FS_PROBE_JS]);
    const ifaces = r.stdout
      .split('\n')
      .slice(2)
      .map((l) => l.split(':')[0]?.trim())
      .filter((x): x is string => !!x);
    add({
      name: 'network interfaces',
      target: 'ds-web',
      passed: r.code === 0 && ifaces.length > 0 && ifaces.every((i) => i === 'lo'),
      detail: r.code === 0 ? `${ifaces.join(', ')} only` : 'could not probe',
    });
    const s = await execNode(web, [
      '-e',
      "process.exit(require('fs').existsSync('/run/lxs/agent')?10:0)",
    ]);
    add({
      name: 'agent socket',
      target: 'ds-web',
      passed: s.code === 0,
      detail: s.code === 0 ? 'ABSENT' : s.code === 10 ? 'PRESENT' : 'could not probe',
    });
  }

  /* ssh: outbound probes must all fail */
  const endpoint = readEndpoint(opts.cwd);
  const platformHost = (() => {
    try {
      if (!endpoint) return null;
      const u = new URL(endpoint);
      return { host: u.hostname, port: Number(u.port || (u.protocol === 'https:' ? 443 : 80)) };
    } catch {
      return null;
    }
  })();
  for (const d of sshDecoys) {
    const svc = `ds-${d.id}`;
    const id = ids.get(svc);
    if (!id) continue;
    const gw = await run('docker', [
      'inspect',
      '-f',
      '{{range .NetworkSettings.Networks}}{{.Gateway}}{{end}}',
      id,
    ]);
    const probes: Array<[string, string, number]> = [
      ['1.1.1.1:443', '1.1.1.1', 443],
      [`host ${gw.stdout.trim() || 'gateway'}:22`, gw.stdout.trim() || '172.31.250.1', 22],
      ['169.254.169.254:80', '169.254.169.254', 80],
      [`${manifest.service}:3000 (no route, no DNS)`, manifest.service, 3000],
    ];
    if (platformHost)
      probes.push([
        `platform ${platformHost.host}:${platformHost.port}`,
        platformHost.host,
        platformHost.port,
      ]);
    for (const [label, host, port] of probes) {
      const r = await exec(id, ['python3', '-c', PROBE_PY, host, String(port)]);
      if (r.code !== 0) {
        // A probe that cannot run proves nothing: never count it as "blocked".
        add({
          name: `-> ${label}`,
          target: svc,
          passed: false,
          detail: 'could not probe (python3 missing or exec failed)',
        });
        continue;
      }
      const blocked = r.stdout.includes('BLOCKED');
      add({
        name: `-> ${label}`,
        target: svc,
        passed: blocked,
        detail: blocked ? 'BLOCKED' : 'OPEN',
      });
    }
  }

  /* host firewall (Linux only; needs privileges) */
  if (sshDecoys.length > 0) {
    if (process.platform !== 'linux') {
      add({
        name: 'DOCKER-USER + INPUT rules',
        target: 'host',
        passed: true,
        skipped: true,
        detail:
          'skipped: Docker Desktop runs in a VM, host firewall rules cannot be applied or checked here',
      });
    } else {
      const a = await run('iptables', [
        '-C',
        'DOCKER-USER',
        '-i',
        'br-ds-trap',
        '-m',
        'conntrack',
        '--ctstate',
        'NEW',
        '-j',
        'DROP',
      ]);
      const b = await run('iptables', [
        '-C',
        'INPUT',
        '-i',
        'br-ds-trap',
        '-m',
        'conntrack',
        '--ctstate',
        'NEW',
        '-j',
        'DROP',
      ]);
      const denied =
        /permission denied|you must be root|not permitted/i.test(a.stderr + b.stderr) ||
        a.code === 127;
      add({
        name: 'DOCKER-USER + INPUT rules',
        target: 'host',
        passed: denied ? true : a.code === 0 && b.code === 0,
        skipped: denied,
        detail: denied
          ? 'skipped: run with sudo to check (infra/victim/ds-firewall.sh installs them)'
          : a.code === 0 && b.code === 0
            ? 'PRESENT'
            : 'MISSING',
      });
    }
  }

  /* agent -> platform is the one expected egress path */
  const agent = ids.get('ds-agent');
  if (agent && platformHost) {
    const r = await execNode(agent, [
      '-e',
      "fetch(process.env.LXS_ENDPOINT+'/healthz',{signal:AbortSignal.timeout(5000)}).then(r=>process.exit(r.ok?0:1),()=>process.exit(2))",
    ]);
    add({
      name: '-> platform /healthz (expected)',
      target: 'ds-agent',
      passed: true,
      skipped: r.code !== 0,
      detail: r.code === 0 ? 'ALLOWED' : 'unreachable (not a containment failure)',
    });
  }

  /* print */
  const counted = checks.filter((c) => !c.skipped);
  const passedCount = counted.filter((c) => c.passed).length;
  const allPassed = counted.length > 0 && passedCount === counted.length;
  const w = Math.max(...checks.map((c) => c.target.length + 2), 8);
  const w2 = Math.max(...checks.map((c) => c.name.length), 8);
  for (const c of checks) {
    const mark = c.skipped ? '-' : c.passed ? '✔' : '✘';
    log(`${`[${c.target}]`.padEnd(w + 2)} ${c.name.padEnd(w2)}  ${c.detail}  ${mark}`);
  }
  log(`Containment: ${allPassed ? 'PASS' : 'FAIL'} (${passedCount}/${counted.length})`);

  if (opts.report) {
    if (!agent) {
      log('report not sent: ds-agent is not running');
    } else {
      const payload = JSON.stringify({
        passed: allPassed,
        checks: counted.map((c) => ({
          name: `${c.target}: ${c.name}`,
          passed: c.passed,
          detail: c.detail,
        })),
      });
      const r = await execNode(agent, ['-e', REPORT_JS, payload]);
      log(
        r.code === 0
          ? 'report sent: yes (via ds-agent, which holds the key)'
          : 'report sent: no (agent unreachable)',
      );
    }
  }
  return { passed: allPassed, checks };
}
