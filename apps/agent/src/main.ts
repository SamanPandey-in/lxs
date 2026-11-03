import fs from 'node:fs';
import path from 'node:path';
import type { DecoyEvent } from '@lxs/schema';
import { AGENT_VERSION, type AgentConfig, loadConfig } from './config.js';
import { createLocalApi } from './local-api.js';
import {
  AuthAggregator,
  createNormalizer,
  type HoneyRead,
  type LineNormalizer,
} from './normalize.js';
import { PlatformClient, type RegisterResponse } from './platform.js';
import { loadHoneytokenHashes, PolicyPoller, PolicyStore } from './policy.js';
import { Shipper } from './ship.js';
import { TailManager, type TailSource } from './tail.js';
import { Counters, createLogger, registerSecret } from './telemetry.js';

interface ManifestDecoy {
  id: string;
  type: string;
  mount: string | number;
  persona?: string;
}
interface Manifest {
  sdk_version?: string;
  decoys: ManifestDecoy[];
  assets?: unknown[];
  honeytokens?: Array<{ id: string; kind: string; planted_in?: string[] }>;
  posture?: Record<string, unknown>;
}

const readJson = <T>(file: string): T | null => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
};

const COMMON_FALLBACK = [
  'admin',
  'root',
  'password',
  '123456',
  'admin123',
  'ubuntu',
  'postgres',
  'backup',
  'toor',
  'test',
  'user',
  'guest',
  'changeme',
  '12345678',
  'qwerty',
].join('\n');

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main(): Promise<void> {
  const log = createLogger();
  const cfg: AgentConfig = loadConfig();
  registerSecret(cfg.key);
  const counters = new Counters();
  const manifest: Manifest = readJson<Manifest>(cfg.manifestPath) ?? { decoys: [] };
  const sdkVersion = manifest.sdk_version ?? AGENT_VERSION;
  const client = new PlatformClient(cfg.endpoint, cfg.key, sdkVersion);
  log.info('ds-agent starting', {
    version: AGENT_VERSION,
    endpoint: cfg.endpoint,
    decoys: manifest.decoys.length,
  });

  const hashes = loadHoneytokenHashes(cfg.honeytokensPath);
  const policy = new PolicyStore(hashes);
  let sensorId: string | undefined;
  let shipper: Shipper | undefined;
  let tail: TailManager | undefined;

  // Local API first: the SDK fails open until policy arrives, but signals must never bounce.
  const pending: DecoyEvent[] = [];
  const emit = (ev: DecoyEvent): void => {
    if (ev.is_decoy && ev.src_ip) policy.addLocalWatch(ev.src_ip); // watch the moment we see a decoy hit
    if (shipper) shipper.enqueue(ev);
    else if (pending.length < 5000) pending.push(ev);
  };
  const localApi = createLocalApi({
    runDir: cfg.runDir,
    policy,
    counters,
    simulated: cfg.markSimulated,
    onEvent: emit,
    onSelftest: async (report) => {
      if (!sensorId) return false;
      return (await client.selftestReport({ sensor_id: sensorId, ...report })) < 300;
    },
    log,
  });
  const sock = await localApi.start();
  log.info('local API listening', { socket: sock });

  // Register (retry until the platform is reachable: the agent must survive starting before it).
  const registerBody = {
    hostname: cfg.hostname,
    agent_version: AGENT_VERSION,
    sdk_version: sdkVersion,
    manifest: {
      decoys: manifest.decoys.map((d) => ({
        decoy_key: d.id,
        id: d.id,
        type: d.type,
        mount: String(d.mount),
        ...(d.persona ? { persona: d.persona } : {}),
        posture: (d.type === 'ssh' ? manifest.posture?.['ds-ssh'] : manifest.posture?.['ds-web']) as
          | Record<string, unknown>
          | undefined,
      })),
      assets: manifest.assets ?? [],
      honeytokens: (manifest.honeytokens ?? []).map((t) => ({
        ...t,
        sha256: Object.entries(hashes).find(([, id]) => id === t.id)?.[0],
      })),
      posture: manifest.posture ?? {},
    },
  };
  let reg: RegisterResponse | undefined;
  for (let attempt = 0; !reg; attempt++) {
    try {
      reg = await client.register(registerBody);
    } catch (e) {
      const wait = Math.min(60_000, 1000 * 2 ** Math.min(attempt, 6));
      log.warn('register failed; retrying', { error: (e as Error).message, retry_in_ms: wait });
      await delay(wait);
    }
  }
  sensorId = reg.sensor_id;
  const heartbeatMs = (reg.heartbeat_seconds ?? cfg.heartbeatSeconds) * 1000;
  log.info('registered', { sensor_id: sensorId, project: reg.project?.name });

  const poller = new PolicyPoller({
    client,
    store: policy,
    intervalSeconds: reg.policy_poll_seconds ?? cfg.policyPollSeconds,
    counters,
    log,
  });
  poller.start();

  const spoolDir = path.join(cfg.stateDir, 'spool');
  shipper = new Shipper({
    client,
    spoolDir,
    sensorId: () => sensorId,
    counters,
    log,
    batchSize: Math.min(reg.max_batch ?? cfg.maxBatch, 500),
    onIdle: () => tail?.commit(),
  });
  shipper.start();
  for (const ev of pending.splice(0)) shipper.enqueue(ev);

  // Normalisation.
  const sshPorts = new Map<string, number>();
  for (const d of manifest.decoys) if (d.type === 'ssh') sshPorts.set(d.id, Number(d.mount));
  const honeyReads: HoneyRead[] = [];
  for (const t of manifest.honeytokens ?? []) {
    for (const p of t.planted_in ?? []) {
      const i = p.indexOf(':');
      if (i > 0 && !p.startsWith('web:'))
        honeyReads.push({ decoyId: p.slice(0, i), path: p.slice(i + 1), tokenId: t.id });
    }
  }
  let commonText = COMMON_FALLBACK;
  try {
    commonText = fs.readFileSync(cfg.commonCredsPath, 'utf8');
  } catch {
    log.warn('common-credentials list not found; using the built-in minimal list');
  }
  const normalizer: LineNormalizer = await createNormalizer(
    {
      salt: reg.password_salt ?? '',
      commonCredsText: commonText,
      simulated: cfg.markSimulated,
      sshPorts,
      honeyReads,
    },
    log,
  );
  log.info('normalizer ready', { impl: normalizer.name });
  const aggregator = new AuthAggregator();

  const sources: TailSource[] = [];
  if (manifest.decoys.some((d) => d.type.startsWith('web'))) {
    sources.push({
      kind: 'web',
      dir: path.join(cfg.logDir, 'web'),
      match: /^ds-web\.jsonl$/,
      decoyId: 'ds-web',
    });
  }
  for (const d of manifest.decoys) {
    if (d.type === 'ssh')
      sources.push({
        kind: 'ssh',
        dir: path.join(cfg.logDir, d.id),
        match: /^cowrie\.json$/,
        decoyId: d.id,
      });
  }

  tail = new TailManager({
    sources,
    statePath: path.join(cfg.stateDir, 'offsets.json'),
    counters,
    log,
    onLine: (l) => {
      for (const ev of normalizer.normalize({
        source: l.source.kind,
        decoyId: l.source.decoyId,
        fileKey: path.basename(path.dirname(l.file)) + '/' + path.basename(l.file),
        offset: l.offset,
        text: l.text,
      })) {
        for (const out of aggregator.push(ev)) emit(out);
      }
    },
  });
  tail.start();
  const flushTimer = setInterval(() => {
    for (const ev of aggregator.flush()) emit(ev);
  }, 10_000);

  // Heartbeat.
  const decoyStatus = (): Array<{ decoy_key: string; status: string }> =>
    manifest.decoys.map((d) => {
      const file =
        d.type === 'ssh'
          ? path.join(cfg.logDir, d.id, 'cowrie.json')
          : path.join(cfg.logDir, 'web', 'ds-web.jsonl');
      return { decoy_key: d.id, status: fs.existsSync(file) ? 'healthy' : 'degraded' };
    });
  const beat = async (): Promise<void> => {
    const s = shipper?.stats();
    const status = await client.heartbeat({
      sensor_id: sensorId,
      applied_policy_version: policy.appliedVersion,
      stats: {
        ...counters.snapshot(),
        ...normalizer.stats(),
        queue_memory: s?.memory ?? 0,
        queue_spool_events: s?.spoolEvents ?? 0,
        tail_lag_bytes: tail?.lagBytes() ?? 0,
      },
      decoys: decoyStatus(),
    });
    if (status === 0 || status >= 400) counters.inc('heartbeat_failures');
  };
  const beatTimer = setInterval(() => void beat(), heartbeatMs);
  void beat();

  let stopping = false;
  const shutdown = async (sig: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    log.info('shutting down', { signal: sig });
    clearInterval(beatTimer);
    clearInterval(flushTimer);
    poller.stop();
    await tail?.stop();
    for (const ev of aggregator.flush(Date.now() + 120_000)) emit(ev);
    await shipper?.stop(5000);
    tail?.commit();
    await localApi.stop();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  process.stderr.write(`ds-agent: fatal: ${(err as Error).message}\n`);
  process.exit(1);
});
