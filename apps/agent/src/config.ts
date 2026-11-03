import os from 'node:os';

export const AGENT_VERSION = '0.1.0';

export interface AgentConfig {
  /** The platform credential. Held in memory only; never logged, never written to disk, never forwarded. */
  key: string;
  endpoint: string;
  runDir: string;
  logDir: string;
  stateDir: string;
  manifestPath: string;
  honeytokensPath: string;
  commonCredsPath: string;
  hostname: string;
  markSimulated: boolean;
  /** Overrides from the platform's register response may replace these. */
  heartbeatSeconds: number;
  policyPollSeconds: number;
  maxBatch: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AgentConfig {
  const key = env.LXS_INGEST_KEY?.trim() ?? '';
  const endpoint = (env.LXS_ENDPOINT ?? '').trim().replace(/\/+$/, '');
  if (!key) throw new Error('LXS_INGEST_KEY is not set (put it in .env.lxs)');
  if (!endpoint) throw new Error('LXS_ENDPOINT is not set (put it in .env.lxs)');
  if (!/^https?:\/\//.test(endpoint))
    throw new Error('LXS_ENDPOINT must start with http:// or https://');
  return {
    key,
    endpoint,
    runDir: env.LXS_RUN_DIR ?? '/run/lxs',
    logDir: env.LXS_LOG_DIR ?? '/var/log/lxs',
    stateDir: env.LXS_STATE_DIR ?? '/var/lib/lxs',
    manifestPath: env.LXS_MANIFEST ?? '/etc/lxs/manifest.json',
    honeytokensPath: env.LXS_HONEYTOKENS ?? '/etc/lxs/honeytokens.json',
    commonCredsPath: env.LXS_COMMON_CREDS ?? '/etc/lxs/common-creds.txt',
    hostname: env.LXS_SENSOR_HOSTNAME ?? os.hostname(),
    markSimulated: env.LXS_MARK_SIMULATED === '1',
    heartbeatSeconds: 30,
    policyPollSeconds: 10,
    maxBatch: 500,
  };
}
