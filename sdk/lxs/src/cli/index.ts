import { LXSConfigError } from '../errors.js';
import { SDK_VERSION } from '../version.js';
import { runBuild } from './build.js';
import { runDoctor } from './doctor.js';
import { runInit } from './init.js';
import { runSelftest } from './selftest.js';

interface Parsed {
  command: string | undefined;
  flags: Map<string, string | true>;
  positionals: string[];
}

/** Tiny hand-rolled parser: `--flag`, `--flag value`, `--flag=value`. Keeps the dependency list short. */
export function parseArgs(argv: string[], valueFlags: ReadonlySet<string>): Parsed {
  const flags = new Map<string, string | true>();
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const name = (eq > 0 ? a.slice(2, eq) : a.slice(2)).trim();
      if (eq > 0) flags.set(name, a.slice(eq + 1));
      else if (valueFlags.has(name) && i + 1 < argv.length) flags.set(name, argv[++i] as string);
      else flags.set(name, true);
    } else positionals.push(a);
  }
  return { command: positionals.shift(), flags, positionals };
}

const HELP = `lxs ${SDK_VERSION} — honeypots as code

Usage:
  lxs init [--service <name>] [--preset shop|saas-api|wordpress] [--endpoint <url>] [--key <key>]
           [--no-input] [--force]              Scaffold decoy.config.ts, .env.lxs (endpoint + key), .gitignore
                                                       Prompts for the key (hidden) on a TTY; --key or env
                                                       LXS_INGEST_KEY for CI. The key only goes to .env.lxs
  lxs doctor [--json]                          Check Docker, compose, ports, config, .env.lxs, endpoint, key,
                                                       images and build freshness; one fix per failure
  lxs build [--config <file>] [--out <file>] [--check] [--reseed]
                                                       Compile decoy.config.ts or lxs.yaml into lxs.compose.yml + .lxs/
                                                       --check exits 1 if committed output is stale (for CI)
                                                       --reseed draws new per-build bait values (banners, keys, dates)
  lxs selftest [--report]                      Prove containment with docker inspect / docker exec probes
  lxs --version
`;

export async function main(argv: string[]): Promise<number> {
  const { command, flags } = parseArgs(
    argv,
    new Set(['service', 'config', 'out', 'preset', 'endpoint', 'key']),
  );
  const str = (k: string): string | undefined => {
    const v = flags.get(k);
    return typeof v === 'string' ? v : undefined;
  };
  try {
    switch (command) {
      case 'init':
        return await runInit({
          cwd: process.cwd(),
          service: str('service') ?? 'app',
          force: flags.has('force'),
          preset: str('preset'),
          endpoint: str('endpoint'),
          key: str('key'),
          ...(flags.has('no-input') ? { interactive: false } : {}),
        });
      case 'doctor':
        return await runDoctor({ cwd: process.cwd(), json: flags.has('json') });
      case 'build':
        return await runBuild({
          cwd: process.cwd(),
          config: str('config'),
          out: str('out'),
          check: flags.has('check'),
          reseed: flags.has('reseed'),
        });
      case 'selftest': {
        const r = await runSelftest({ cwd: process.cwd(), report: flags.has('report') });
        return r.passed ? 0 : 1;
      }
      case 'version':
      case undefined:
        if (command === undefined && !flags.has('version') && !flags.has('v')) {
          console.log(HELP);
          return flags.has('help') ? 0 : 1;
        }
        console.log(SDK_VERSION);
        return 0;
      case 'help':
        console.log(HELP);
        return 0;
      default:
        console.error(`unknown command '${command}'\n\n${HELP}`);
        return 1;
    }
  } catch (err) {
    if (err instanceof LXSConfigError) {
      console.error(`✘ ${err.message}`);
      return 1;
    }
    console.error(`✘ ${(err as Error).message}`);
    return 1;
  }
}

main(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
});
