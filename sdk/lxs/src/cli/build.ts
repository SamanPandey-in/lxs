import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createJiti } from 'jiti';
import { parse as parseYaml } from 'yaml';
import { type DeclarativeConfig, defineConfig } from '../config.js';
import { isLXS, type LXS } from '../create.js';
import { LXSConfigError } from '../errors.js';
import { type HoneytokenFile, parseHoneytokenFile } from '../generate/honeytokens.js';
import { COMPOSE_FILE, generateAll } from '../generate/index.js';
import type { ResolvedConfig } from '../types.js';

export interface BuildOptions {
  cwd: string;
  config?: string;
  out?: string;
  check?: boolean;
  log?: (msg: string) => void;
}

const CONFIG_CANDIDATES = [
  'decoy.config.ts',
  'decoy.config.mts',
  'decoy.config.js',
  'decoy.config.mjs',
  'decoy.config.cjs',
];
const COMPOSE_CANDIDATES = [
  'docker-compose.yml',
  'docker-compose.yaml',
  'compose.yml',
  'compose.yaml',
];

export function findConfig(cwd: string, explicit?: string): string {
  if (explicit) {
    const p = path.resolve(cwd, explicit);
    if (!fs.existsSync(p))
      throw new LXSConfigError('E_CONFIG_NOT_FOUND', `${explicit} does not exist.`);
    return p;
  }
  for (const c of CONFIG_CANDIDATES) {
    const p = path.join(cwd, c);
    if (fs.existsSync(p)) return p;
  }
  throw new LXSConfigError(
    'E_CONFIG_NOT_FOUND',
    'no decoy.config.ts found.',
    'Run `npx lxs init` first.',
  );
}

/** Loads decoy.config.ts through jiti (no compile step for the user). Duck-typed: the config may use another copy of this package. */
export async function loadShield(file: string): Promise<LXS> {
  const jiti = createJiti(import.meta.url, {
    interopDefault: true,
    moduleCache: false,
    fsCache: false,
  });
  const mod = (await jiti.import(pathToFileURL(file).href)) as Record<string, unknown>;
  const exp = (mod && 'default' in mod ? mod.default : mod) as unknown;
  if (isLXS(exp)) return exp;
  if (exp && typeof exp === 'object' && ('decoys' in exp || 'service' in exp))
    return defineConfig(exp as DeclarativeConfig);
  throw new LXSConfigError(
    'E_CONFIG_EXPORT',
    `${path.basename(file)} must export default a LXS instance (or a defineConfig() result).`,
    'Add `export default t;` at the end of the file.',
  );
}

/** Looks for the ignore entry in .gitignore files from cwd up to the repository root. */
export function isGitIgnored(cwd: string, target: string): boolean {
  const bare = target.replace(/\/$/, '');
  const accepted = new Set([target, bare, `/${target}`, `/${bare}`, `${bare}*`, `${bare}/**`]);
  if (bare === '.env.lxs') {
    accepted.add('.env*');
    accepted.add('.env.*');
  }
  let dir = cwd;
  for (let i = 0; i < 8; i++) {
    const gi = path.join(dir, '.gitignore');
    if (fs.existsSync(gi)) {
      const lines = fs
        .readFileSync(gi, 'utf8')
        .split(/\r?\n/)
        .map((l) => l.trim());
      if (lines.some((l) => accepted.has(l))) return true;
    }
    if (fs.existsSync(path.join(dir, '.git'))) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return false;
}

export interface ProjectCheck {
  warnings: string[];
  composePath: string | null;
}

/** Validation that needs the filesystem (declaration-level checks already ran in create()). */
export function validateProject(
  cwd: string,
  cfg: ResolvedConfig,
  configFile: string,
): ProjectCheck {
  const warnings: string[] = [];
  if (cfg.decoys.length === 0) {
    throw new LXSConfigError(
      'E_NO_DECOYS',
      'no decoys declared.',
      "Add one, for example t.create('web-bait', '/.env').",
    );
  }
  for (const d of cfg.decoys) {
    if (d.type === 'redis') {
      throw new LXSConfigError(
        'E_UNSUPPORTED',
        `redis decoy '${d.id}' is not available in this release.`,
        'Remove it or wait for the optional redis sensor image.',
      );
    }
  }
  const sshCount = cfg.decoys.filter((d) => d.type === 'ssh').length;
  if (sshCount > 0 && process.platform === 'win32') {
    warnings.push(
      'Windows/Docker Desktop: containment of network decoys cannot be verified from the host (see `selftest`).',
    );
  }

  let composePath: string | null = null;
  for (const c of COMPOSE_CANDIDATES) {
    const p = path.join(cwd, c);
    if (fs.existsSync(p)) {
      composePath = p;
      break;
    }
  }
  if (composePath) {
    const text = fs.readFileSync(composePath, 'utf8');
    if (text.includes('ds_live_')) {
      throw new LXSConfigError(
        'E_KEY_IN_CONFIG',
        `${path.basename(composePath)} contains an ingest key (ds_live_...).`,
        'Keys belong only in .env.lxs.',
      );
    }
    let services: Record<string, unknown> = {};
    try {
      services = ((parseYaml(text) as { services?: Record<string, unknown> } | null)?.services ??
        {}) as Record<string, unknown>;
    } catch (e) {
      throw new LXSConfigError(
        'E_COMPOSE_INVALID',
        `${path.basename(composePath)} is not valid YAML: ${(e as Error).message}`,
      );
    }
    if (!(cfg.options.service in services)) {
      throw new LXSConfigError(
        'E_SERVICE_MISSING',
        `service '${cfg.options.service}' is not defined in ${path.basename(composePath)}.`,
        `Set service: to one of: ${Object.keys(services).join(', ') || '(none)'}.`,
      );
    }
  } else {
    warnings.push(
      `no docker-compose.yml found next to the config; could not verify service '${cfg.options.service}'.`,
    );
  }

  const cfgText = fs.readFileSync(configFile, 'utf8');
  if (cfgText.includes('ds_live_')) {
    throw new LXSConfigError(
      'E_KEY_IN_CONFIG',
      `${path.basename(configFile)} contains an ingest key (ds_live_...).`,
      'Keys belong only in .env.lxs.',
    );
  }
  for (const target of ['.env.lxs', '.lxs/secrets/']) {
    if (!isGitIgnored(cwd, target)) {
      throw new LXSConfigError(
        'E_NOT_GITIGNORED',
        `${target} is not git-ignored.`,
        `Add it to .gitignore (\`npx lxs init\` does this) before building.`,
      );
    }
  }
  return { warnings, composePath };
}

function describeDecoy(d: ResolvedConfig['decoys'][number]): string {
  if (d.type === 'ssh') return `ssh :${d.port} (${d.hostname})`;
  if (d.type === 'redis') return `redis :${d.port}`;
  return `${d.type} ${d.mount}`;
}

function readIfExists(p: string): string | null {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

export async function runBuild(opts: BuildOptions): Promise<number> {
  const log = opts.log ?? console.log;
  const cwd = opts.cwd;
  const configFile = findConfig(cwd, opts.config);
  const shield = await loadShield(configFile);
  const cfg = shield.resolve();
  const { warnings, composePath } = validateProject(cwd, cfg, configFile);

  const composeOut = opts.out ?? COMPOSE_FILE;
  const secretsFile = path.join(cwd, '.lxs/secrets/honeytokens.json');
  const existing: HoneytokenFile | null = (() => {
    const t = readIfExists(secretsFile);
    return t ? parseHoneytokenFile(t) : null;
  })();
  const gen = generateAll(cfg, { existingHoneytokens: existing, composeFile: composeOut });

  for (const [file, content] of gen.committed) {
    if (content.includes('ds_live_')) {
      throw new LXSConfigError('E_KEY_IN_CONFIG', `generated ${file} would contain an ingest key.`);
    }
  }

  if (opts.check) {
    const stale: string[] = [];
    for (const [file, content] of gen.committed) {
      const onDisk = readIfExists(path.join(cwd, file));
      if (onDisk === null) stale.push(`${file} (missing)`);
      else if (onDisk !== content) stale.push(`${file} (out of date)`);
    }
    if (stale.length > 0) {
      log('✘ lxs output is stale:');
      for (const s of stale) log(`    ${s}`);
      log('  Run `npx lxs build` and commit the result.');
      return 1;
    }
    log(`✔ lxs output is up to date (${gen.committed.size} files)`);
    return 0;
  }

  const write = (file: string, content: string, mode?: number): void => {
    const abs = path.join(cwd, file);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    if (readIfExists(abs) !== content) fs.writeFileSync(abs, content, mode ? { mode } : undefined);
  };
  for (const [file, content] of gen.committed) write(file, content);
  // Secrets: .gitignore first, so a crash mid-write never leaves unignored plaintext behind.
  const secretEntries = [...gen.secrets].sort(([a]) => (a.endsWith('/.gitignore') ? -1 : 1));
  for (const [file, content] of secretEntries) write(file, content, 0o644); // fake-by-design; containers run as non-root uids and must read them

  log(`  ✔ ${cfg.decoys.length} decoys: ${cfg.decoys.map(describeDecoy).join(' · ')}`);
  log(`  ✔ ${cfg.assets.length} assets, 1 honeytoken set generated (.lxs/secrets/, git-ignored)`);
  const mounts = cfg.decoys.flatMap((d) =>
    d.type === 'web-admin' || d.type === 'web-bait' ? [d.mount] : [],
  );
  if (mounts.length > 0) {
    log(`  ! decoy paths shadow any real route at the same path: ${mounts.join(', ')}`);
  }
  for (const w of warnings) log(`  ! ${w}`);
  const base = composePath ? path.basename(composePath) : 'docker-compose.yml';
  log(`  → docker compose -f ${base} -f ${composeOut} up -d`);
  return 0;
}
