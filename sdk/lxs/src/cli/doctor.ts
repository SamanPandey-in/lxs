import { execFile } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { LXSConfigError } from '../errors.js';
import { COMPOSE_FILE } from '../generate/index.js';
import type { ResolvedConfig } from '../types.js';
import { findConfig, loadShield, runBuild } from './build.js';
import { ENV_FILE, isPlaceholderKey, KEY_PATTERN, parseEnvFile } from './init.js';

/**
 * `lxs doctor`: everything that has to be true before `docker compose up` produces a first
 * catch, checked in the order a newcomer hits it. One line per check, one fix per failure.
 * Every side effect goes through DoctorDeps so the checks are unit-tested without Docker.
 */

export type CheckStatus = 'ok' | 'fail' | 'warn';

export interface CheckResult {
  id: string;
  title: string;
  status: CheckStatus;
  detail?: string;
  fix?: string;
}

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}
export type CommandRunner = (cmd: string, args: string[]) => Promise<CommandResult>;

export interface HttpResult {
  status: number;
  body: unknown;
}
export type HttpClient = (
  url: string,
  init?: { headers?: Record<string, string> },
) => Promise<HttpResult>;

export interface DoctorDeps {
  cwd: string;
  env: NodeJS.ProcessEnv;
  run: CommandRunner;
  http: HttpClient;
  /** true when nothing listens on the TCP port. */
  portFree: (port: number) => Promise<boolean>;
  readFile: (file: string) => string | null;
  loadConfig: (cwd: string) => Promise<ResolvedConfig>;
  /** `lxs build --check` without printing: fresh, or the list of stale files. */
  buildCheck: (cwd: string) => Promise<{ fresh: boolean; detail: string }>;
}

export interface DoctorOptions {
  cwd: string;
  json?: boolean;
  log?: (msg: string) => void;
  deps?: Partial<DoctorDeps>;
}

/* ─────────────────────────── default (real) dependencies ─────────────────────────── */

const COMMAND_TIMEOUT_MS = 90_000;

export const runCommand: CommandRunner = (cmd, args) =>
  new Promise((resolve) => {
    // Docker Desktop can take tens of seconds to answer on a busy machine; a slow daemon is not a dead one.
    execFile(
      cmd,
      args,
      { timeout: COMMAND_TIMEOUT_MS, windowsHide: true },
      (err, stdout, stderr) => {
        const e = err as (Error & { code?: unknown; killed?: boolean }) | null;
        if (e?.killed) {
          resolve({
            code: 124,
            stdout: '',
            stderr: `timed out after ${COMMAND_TIMEOUT_MS / 1000}s`,
          });
          return;
        }
        const code = e == null ? 0 : typeof e.code === 'number' ? e.code : 127;
        resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
      },
    );
  });

export const fetchJson: HttpClient = async (url, init) => {
  const r = await fetch(url, { headers: init?.headers, signal: AbortSignal.timeout(8_000) });
  let body: unknown = null;
  try {
    body = await r.json();
  } catch {
    /* not JSON */
  }
  return { status: r.status, body };
};

export const probePort = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen({ port, host: '0.0.0.0', exclusive: true }, () => srv.close(() => resolve(true)));
  });

/** The error text without the hint LXSConfigError appends (the hint becomes the fix line). */
function errorDetail(e: unknown): { detail: string; hint?: string } {
  const err = e as Error;
  const hint = e instanceof LXSConfigError ? e.hint : undefined;
  return { detail: hint ? err.message.replace(` ${hint}`, '') : err.message, hint };
}

const readFileOrNull = (file: string): string | null => {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
};

const loadConfigDefault = async (cwd: string): Promise<ResolvedConfig> =>
  (await loadShield(findConfig(cwd))).resolve();

const buildCheckDefault = async (cwd: string): Promise<{ fresh: boolean; detail: string }> => {
  const lines: string[] = [];
  const code = await runBuild({ cwd, check: true, log: (m) => lines.push(m) });
  const stale = lines
    .filter((l) => /^\s{4}\S/.test(l))
    .map((l) => l.trim())
    .join(', ');
  return { fresh: code === 0, detail: code === 0 ? (lines[0] ?? '').replace(/^✔\s*/, '') : stale };
};

/* ──────────────────────────────────── helpers ──────────────────────────────────── */

const ok = (id: string, title: string, detail?: string): CheckResult => ({
  id,
  title,
  status: 'ok',
  ...(detail ? { detail } : {}),
});
const fail = (id: string, title: string, detail: string, fix: string): CheckResult => ({
  id,
  title,
  status: 'fail',
  detail,
  fix,
});
const warn = (id: string, title: string, detail: string, fix?: string): CheckResult => ({
  id,
  title,
  status: 'warn',
  detail,
  ...(fix ? { fix } : {}),
});

/** Image references in the generated compose, with `${VAR:-default}` resolved from env. */
export function composeImages(compose: string, env: NodeJS.ProcessEnv): string[] {
  const out = new Set<string>();
  for (const m of compose.matchAll(/^\s*image:\s*(\S+)\s*$/gm)) {
    const ref = (m[1] as string).replace(/^["']|["']$/g, '');
    const resolved = ref.replace(
      /\$\{(\w+)(?::?-([^}]*))?\}/g,
      (_, name: string, def?: string) => env[name] || def || '',
    );
    if (resolved) out.add(resolved);
  }
  return [...out];
}

export function networkPorts(cfg: ResolvedConfig): { port: number; label: string }[] {
  return cfg.decoys.flatMap((d) =>
    d.type === 'ssh' || d.type === 'redis' || d.type === 'postgres'
      ? [{ port: d.port, label: d.type === 'ssh' ? `ssh ${d.hostname}` : d.type }]
      : [],
  );
}

/* ───────────────────────────────────── checks ───────────────────────────────────── */

export async function checkDocker(d: DoctorDeps): Promise<CheckResult> {
  const r = await d.run('docker', ['--version']);
  if (r.code !== 0)
    return fail(
      'docker',
      'Docker installed',
      'the docker command was not found',
      'Install Docker: https://docs.docker.com/get-docker/',
    );
  const v = /version ([\w.+-]+)/i.exec(r.stdout)?.[1];
  return ok('docker', 'Docker installed', v);
}

export async function checkDaemon(d: DoctorDeps, dockerOk: boolean): Promise<CheckResult> {
  if (!dockerOk) return warn('daemon', 'Docker daemon running', 'skipped: Docker is not installed');
  const r = await d.run('docker', ['version', '--format', '{{.Server.Version}}']);
  if (r.code !== 0 || !r.stdout.trim())
    return fail(
      'daemon',
      'Docker daemon running',
      (r.stderr.trim().split('\n')[0] ?? '') || 'the daemon did not answer',
      'Start Docker Desktop, or on Linux: sudo systemctl start docker',
    );
  return ok('daemon', 'Docker daemon running', `server ${r.stdout.trim()}`);
}

export async function checkCompose(d: DoctorDeps, dockerOk: boolean): Promise<CheckResult> {
  if (!dockerOk) return warn('compose', 'Docker Compose v2', 'skipped: Docker is not installed');
  const r = await d.run('docker', ['compose', 'version', '--short']);
  const v = r.stdout.trim().replace(/^v/, '');
  const major = Number.parseInt(v.split('.')[0] ?? '', 10);
  if (r.code !== 0 || !Number.isFinite(major))
    return fail(
      'compose',
      'Docker Compose v2',
      '`docker compose` is not available',
      'Install the Compose v2 plugin (`docker compose`, not the old `docker-compose`): https://docs.docker.com/compose/install/',
    );
  if (major < 2)
    return fail(
      'compose',
      'Docker Compose v2',
      `found ${v}`,
      'Upgrade Docker Compose to v2 or later',
    );
  return ok('compose', 'Docker Compose v2', v);
}

export async function checkConfig(
  d: DoctorDeps,
): Promise<{ result: CheckResult; cfg: ResolvedConfig | null }> {
  try {
    const cfg = await d.loadConfig(d.cwd);
    return {
      result: ok(
        'config',
        'decoy.config.ts parses',
        `${cfg.decoys.length} decoys, service '${cfg.options.service}'`,
      ),
      cfg,
    };
  } catch (e) {
    const { detail, hint } = errorDetail(e);
    const missing = e instanceof LXSConfigError && e.code === 'E_CONFIG_NOT_FOUND';
    return {
      result: fail(
        'config',
        'decoy.config.ts parses',
        detail,
        missing
          ? 'Run  npx lxs init --preset shop  (or saas-api / wordpress)'
          : (hint ?? 'Fix the error above in decoy.config.ts'),
      ),
      cfg: null,
    };
  }
}

export async function checkPorts(
  d: DoctorDeps,
  cfg: ResolvedConfig | null,
  dockerOk: boolean,
): Promise<CheckResult> {
  if (!cfg) return warn('ports', 'Host ports free', 'skipped: the config did not load');
  const ports = networkPorts(cfg);
  if (ports.length === 0) return ok('ports', 'Host ports free', 'no network decoys');
  const busy: { port: number; label: string }[] = [];
  for (const p of ports) if (!(await d.portFree(p.port))) busy.push(p);
  if (busy.length === 0) return ok('ports', 'Host ports free', ports.map((p) => p.port).join(', '));

  // A port held by our own running decoy is fine (the stack is already up).
  let ours = new Set<number>();
  if (dockerOk) {
    const r = await d.run('docker', ['ps', '--format', '{{.Names}}\t{{.Ports}}']);
    if (r.code === 0)
      ours = new Set(
        r.stdout
          .split('\n')
          .filter((l) => /(^|[-_])ds-/.test(l.split('\t')[0] ?? ''))
          .flatMap((l) => [...l.matchAll(/:(\d+)->/g)].map((m) => Number(m[1]))),
      );
  }
  const foreign = busy.filter((b) => !ours.has(b.port));
  if (foreign.length === 0)
    return ok(
      'ports',
      'Host ports free',
      `${busy.map((b) => b.port).join(', ')} held by the running decoys`,
    );
  const first = foreign[0]!;
  return fail(
    'ports',
    'Host ports free',
    `in use by another process: ${foreign.map((b) => `${b.port} (${b.label})`).join(', ')}`,
    `Stop whatever listens on ${first.port}, or give the ${first.label} decoy another port in decoy.config.ts and rerun lxs build`,
  );
}

export function readEnv(d: DoctorDeps): { result: CheckResult; endpoint?: string; key?: string } {
  const text = d.readFile(path.join(d.cwd, ENV_FILE));
  if (text === null)
    return {
      result: fail(
        'env',
        `${ENV_FILE} has LXS_ENDPOINT and LXS_INGEST_KEY`,
        `${ENV_FILE} not found`,
        'Run  npx lxs init  (it writes the endpoint and asks for the key)',
      ),
    };
  const vars = parseEnvFile(text);
  const endpoint = vars.get('LXS_ENDPOINT')?.replace(/\/+$/, '');
  const key = vars.get('LXS_INGEST_KEY');
  const title = `${ENV_FILE} has LXS_ENDPOINT and LXS_INGEST_KEY`;
  if (!endpoint)
    return {
      result: fail(
        'env',
        title,
        'LXS_ENDPOINT is missing',
        'Run  npx lxs init  to set it, or add LXS_ENDPOINT=https://... yourself',
      ),
      key,
    };
  try {
    new URL(endpoint);
  } catch {
    return {
      result: fail(
        'env',
        title,
        `LXS_ENDPOINT '${endpoint}' is not a URL`,
        'Set LXS_ENDPOINT to the platform URL, e.g. https://api.lxs.dev',
      ),
      key,
    };
  }
  if (isPlaceholderKey(key))
    return {
      result: fail(
        'env',
        title,
        'LXS_INGEST_KEY is missing or still the placeholder',
        'Create a key in the dashboard (Settings → Ingest keys), then run  npx lxs init --key <key>',
      ),
      endpoint,
    };
  if (!KEY_PATTERN.test(key as string))
    return {
      result: fail(
        'env',
        title,
        'LXS_INGEST_KEY is not in the ds_live_... format',
        'Copy the key again from the dashboard; it starts with ds_live_',
      ),
      endpoint,
    };
  return { result: ok('env', title, endpoint), endpoint, key };
}

export async function checkEndpoint(d: DoctorDeps, endpoint?: string): Promise<CheckResult> {
  const title = 'Platform endpoint reachable';
  if (!endpoint) return warn('endpoint', title, `skipped: no LXS_ENDPOINT in ${ENV_FILE}`);
  try {
    const r = await d.http(`${endpoint}/healthz`);
    if (r.status >= 200 && r.status < 300) return ok('endpoint', title, `${endpoint}/healthz`);
    return fail(
      'endpoint',
      title,
      `${endpoint}/healthz answered HTTP ${r.status}`,
      'Check LXS_ENDPOINT points at the LXS API (not the dashboard URL)',
    );
  } catch (e) {
    return fail(
      'endpoint',
      title,
      `${endpoint}: ${(e as Error).message}`,
      'Check LXS_ENDPOINT and that this host can reach it (DNS, firewall, HTTPS proxy)',
    );
  }
}

export async function checkKey(
  d: DoctorDeps,
  endpoint?: string,
  key?: string,
): Promise<CheckResult> {
  const title = 'Ingest key accepted';
  if (!endpoint || !key) return warn('key', title, 'skipped: no endpoint or key to test');
  const headers = { authorization: `Bearer ${key}` };
  try {
    let r = await d.http(`${endpoint}/v1/agent/whoami`, { headers });
    // Older servers have no whoami; policy is the other read-only key-authenticated route.
    if (r.status === 404) r = await d.http(`${endpoint}/v1/agent/policy`, { headers });
    if (r.status >= 200 && r.status < 300) {
      const name = (r.body as { project?: { name?: string } } | null)?.project?.name;
      return ok('key', title, name ? `project '${name}'` : undefined);
    }
    const code = (r.body as { error?: { code?: string } } | null)?.error?.code;
    if (r.status === 429) return warn('key', title, 'rate limited; try again in a minute');
    if (code === 'key_revoked')
      return fail(
        'key',
        title,
        'the key has been revoked',
        'Create a new key in the dashboard and run  npx lxs init --key <key>',
      );
    if (code === 'project_archived')
      return fail(
        'key',
        title,
        'the key belongs to an archived project',
        'Create a key in an active project',
      );
    if (r.status === 401 || r.status === 403)
      return fail(
        'key',
        title,
        `rejected (HTTP ${r.status}${code ? `, ${code}` : ''})`,
        'The key does not belong to this endpoint. Copy it again from the dashboard (Settings → Ingest keys)',
      );
    return fail(
      'key',
      title,
      `HTTP ${r.status}`,
      'Retry; if it persists, check the platform status',
    );
  } catch (e) {
    return fail('key', title, (e as Error).message, 'Check the endpoint is reachable first');
  }
}

export async function checkImages(d: DoctorDeps, dockerOk: boolean): Promise<CheckResult> {
  const title = 'Decoy images present or pullable';
  if (!dockerOk) return warn('images', title, 'skipped: Docker is not running');
  const compose = d.readFile(path.join(d.cwd, COMPOSE_FILE));
  if (compose === null)
    return warn('images', title, `skipped: no ${COMPOSE_FILE} yet`, 'Run  npx lxs build');
  const images = composeImages(compose, d.env);
  const missing: string[] = [];
  let local = 0;
  for (const img of images) {
    if ((await d.run('docker', ['image', 'inspect', img])).code === 0) {
      local++;
      continue;
    }
    if ((await d.run('docker', ['manifest', 'inspect', img])).code !== 0) missing.push(img);
  }
  if (missing.length > 0)
    return fail(
      'images',
      title,
      `cannot pull ${missing.join(', ')}`,
      'Run  docker login ghcr.io  if the registry needs it, or point LXS_AGENT_IMAGE / LXS_WEB_IMAGE / LXS_COWRIE_IMAGE at images you can pull',
    );
  return ok(
    'images',
    title,
    `${images.length} images (${local} local, ${images.length - local} pullable)`,
  );
}

export async function checkBuild(d: DoctorDeps, configOk: boolean): Promise<CheckResult> {
  const title = 'Build output up to date';
  if (!configOk) return warn('build', title, 'skipped: the config did not load');
  try {
    const r = await d.buildCheck(d.cwd);
    if (r.fresh) return ok('build', title, r.detail || undefined);
    return fail(
      'build',
      title,
      `stale: ${r.detail || COMPOSE_FILE}`,
      'Run  npx lxs build  (and commit the result)',
    );
  } catch (e) {
    const { detail, hint } = errorDetail(e);
    return fail('build', title, detail, hint ?? 'Run  npx lxs build  and fix what it reports');
  }
}

/* ─────────────────────────────────── orchestration ─────────────────────────────────── */

export function resolveDeps(cwd: string, partial: Partial<DoctorDeps> = {}): DoctorDeps {
  return {
    cwd,
    env: process.env,
    run: runCommand,
    http: fetchJson,
    portFree: probePort,
    readFile: readFileOrNull,
    loadConfig: loadConfigDefault,
    buildCheck: buildCheckDefault,
    ...partial,
  };
}

export async function runChecks(d: DoctorDeps): Promise<CheckResult[]> {
  const docker = await checkDocker(d);
  const daemon = await checkDaemon(d, docker.status === 'ok');
  const compose = await checkCompose(d, docker.status === 'ok');
  const dockerUp = daemon.status === 'ok';
  const { result: config, cfg } = await checkConfig(d);
  const ports = await checkPorts(d, cfg, dockerUp);
  const env = readEnv(d);
  const endpoint = await checkEndpoint(d, env.endpoint);
  const key = await checkKey(d, endpoint.status === 'ok' ? env.endpoint : undefined, env.key);
  const images = await checkImages(d, dockerUp);
  const build = await checkBuild(d, config.status === 'ok');
  return [docker, daemon, compose, config, ports, env.result, endpoint, key, images, build];
}

const MARK: Record<CheckStatus, string> = { ok: '✓', fail: '✗', warn: '!' };

export function formatResults(results: CheckResult[]): string[] {
  const lines: string[] = [];
  for (const r of results) {
    lines.push(`${MARK[r.status]} ${r.title}${r.detail ? ` (${r.detail})` : ''}`);
    if (r.fix && r.status !== 'ok') lines.push(`    fix: ${r.fix}`);
  }
  const failed = results.filter((r) => r.status === 'fail').length;
  const warned = results.filter((r) => r.status === 'warn').length;
  lines.push('');
  lines.push(
    failed === 0
      ? `All set${warned ? ` (${warned} warning${warned > 1 ? 's' : ''})` : ''}. Start the stack:  docker compose -f docker-compose.yml -f ${COMPOSE_FILE} up -d`
      : `${failed} check${failed > 1 ? 's' : ''} failed. Fix the first one and run  npx lxs doctor  again.`,
  );
  return lines;
}

export async function runDoctor(opts: DoctorOptions): Promise<number> {
  const log = opts.log ?? console.log;
  const results = await runChecks(resolveDeps(opts.cwd, opts.deps));
  const okAll = results.every((r) => r.status !== 'fail');
  if (opts.json) log(JSON.stringify({ ok: okAll, checks: results }, null, 2));
  else for (const l of formatResults(results)) log(l);
  return okAll ? 0 : 1;
}
