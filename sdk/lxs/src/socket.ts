import { createHash } from 'node:crypto';

export const DEFAULT_RUN_DIR = '/run/lxs';

export function resolveRunDir(runDir?: string): string {
  return runDir ?? process.env.LXS_RUN_DIR ?? DEFAULT_RUN_DIR;
}

/** Windows named-pipe namespace prefix: two backslashes, a dot, a backslash, then "pipe" and a backslash. */
const PIPE_PREFIX = String.raw`\\.\pipe\lxs-`;

function pipe(runDir: string, name: string): string {
  const h = createHash('sha1').update(runDir).digest('hex').slice(0, 8);
  return `${PIPE_PREFIX}${h}-${name}`;
}

/** Unix socket in the ds_web_sock volume; a named pipe on Windows (local development only). */
export function webSocketPath(runDir: string): string {
  return process.platform === 'win32' ? pipe(runDir, 'web') : `${runDir}/web/web.sock`;
}

/** Unix socket in the ds_agent_sock volume (never mounted into ds-web). */
export function agentSocketPath(runDir: string): string {
  return process.platform === 'win32' ? pipe(runDir, 'agent') : `${runDir}/agent/agent.sock`;
}
