import type { ResolvedConfig, SshSpec } from '../types.js';
import { GENERATED_HEADER, IMAGE_TAG } from '../version.js';
import { COWRIE_BASE } from './cowrie.js';

export const COMPOSE_FILE = 'lxs.compose.yml';

const sanitize = (id: string): string => id.replace(/[^a-z0-9]+/g, '_');

export interface ComposeNames {
  sshLogs(spec: SshSpec): string;
  sshData(spec: SshSpec): string;
}

/** One SSH decoy keeps the short names from the worked example; several get per-decoy volumes. */
export function volumeNames(cfg: ResolvedConfig): ComposeNames {
  const single = cfg.decoys.filter((d) => d.type === 'ssh').length === 1;
  return {
    sshLogs: (s) => (single ? 'ds_ssh_logs' : `ds_${sanitize(s.id)}_logs`),
    sshData: (s) => (single ? 'ds_ssh_data' : `ds_${sanitize(s.id)}_data`),
  };
}

/** Rendered as text (not via a YAML library) so anchors, comments and key order match BREAKDOWN 5.4 exactly. */
export function renderCompose(cfg: ResolvedConfig): string {
  const ssh = cfg.decoys.filter((d): d is SshSpec => d.type === 'ssh');
  const hasWeb = cfg.decoys.some((d) => d.type === 'web-admin' || d.type === 'web-bait');
  const names = volumeNames(cfg);
  const L: string[] = [];
  const push = (...lines: string[]): void => {
    L.push(...lines);
  };

  push(
    '# lxs.compose.yml',
    GENERATED_HEADER,
    '#',
    '# Use:  docker compose -f docker-compose.yml -f lxs.compose.yml up -d',
    '# Images are tagged for this SDK version. For production, pin digests by exporting',
    '# LXS_AGENT_IMAGE / LXS_WEB_IMAGE / LXS_COWRIE_IMAGE as name:tag@sha256:<digest>.',
    '',
    'x-ds-hardened: &ds-hardened',
    '  read_only: true',
    '  cap_drop: [ALL]',
    '  security_opt: ["no-new-privileges:true"]',
    '  restart: unless-stopped',
    '  logging: { driver: local, options: { max-size: "10m", max-file: "3" } }',
    '',
    'services:',
    `  ${cfg.options.service}:                                     # merged into the customer's own service`,
    '    volumes:',
  );
  if (hasWeb) push('      - ds_web_sock:/run/lxs/web');
  push(
    '      - ds_agent_sock:/run/lxs/agent',
    '    environment:',
    '      LXS_RUN_DIR: /run/lxs',
    '',
    '  ds-agent:',
    '    <<: *ds-hardened',
    `    image: \${LXS_AGENT_IMAGE:-ghcr.io/lxs/agent:${IMAGE_TAG}}`,
    '    user: "10001:10001"',
    '    env_file: [.env.lxs]            # the only place the key exists',
    '    networks: [ds_uplink]',
    '    mem_limit: 256m',
    '    cpus: 0.5',
    '    pids_limit: 128',
    '    tmpfs: ["/tmp:size=16m,noexec,nosuid"]',
    '    volumes:',
    '      - ds_agent_sock:/run/lxs/agent',
    '      - ds_agent_state:/var/lib/lxs',
  );
  if (hasWeb) push('      - ds_web_logs:/var/log/lxs/web:ro');
  for (const s of ssh) push(`      - ${names.sshLogs(s)}:/var/log/lxs/${s.id}:ro`);
  push(
    '      - ./.lxs/manifest.json:/etc/lxs/manifest.json:ro',
    '      - ./.lxs/secrets/honeytokens.json:/etc/lxs/honeytokens.json:ro',
  );

  if (hasWeb) {
    push(
      '',
      '  ds-web:',
      '    <<: *ds-hardened',
      `    image: \${LXS_WEB_IMAGE:-ghcr.io/lxs/decoy-web:${IMAGE_TAG}}`,
      '    user: "10002:10002"',
      '    network_mode: none                      # no network interface at all',
      '    mem_limit: 128m',
      '    cpus: 0.25',
      '    pids_limit: 64',
      '    tmpfs: ["/tmp:size=8m,noexec,nosuid"]',
      '    volumes:',
      '      - ds_web_sock:/run/lxs/web',
      '      - ds_web_logs:/var/log/lxs',
      '      - ./.lxs/web-decoys.json:/etc/lxs/web-decoys.json:ro',
      '      - ./.lxs/secrets/honeytokens.json:/etc/lxs/honeytokens.json:ro',
    );
  }

  for (const s of ssh) {
    push(
      '',
      `  ds-${s.id}:`,
      '    <<: *ds-hardened',
      `    image: \${LXS_COWRIE_IMAGE:-ghcr.io/lxs/cowrie-personas:${IMAGE_TAG}}`,
      '    networks: [ds_trap]',
      `    ports: ["${s.port}:2222"]                      # host port configured in decoy.config.ts`,
      '    mem_limit: 256m',
      '    cpus: 0.5',
      '    pids_limit: 128',
      `    tmpfs: ["/tmp:size=16m,noexec,nosuid", "${COWRIE_BASE}/var/run:size=1m"]`,
      '    volumes:',
      `      - ${names.sshLogs(s)}:${COWRIE_BASE}/var/log/cowrie`,
      `      - ${names.sshData(s)}:${COWRIE_BASE}/var/lib/cowrie`,
      `      - ./.lxs/${s.id}/cowrie.cfg:${COWRIE_BASE}/etc/cowrie.cfg:ro`,
      `      - ./.lxs/secrets/${s.id}/userdb.txt:${COWRIE_BASE}/etc/userdb.txt:ro`,
      `      - ./.lxs/secrets/${s.id}/honeyfs:/cowrie/honeyfs-live:ro`,
      '    healthcheck:',
      `      test: ["CMD", "python3", "-c", "import socket; socket.create_connection(('127.0.0.1', 2222), 2)"]`,
      '      interval: 30s',
      '      timeout: 5s',
      '      retries: 3',
    );
  }

  push('', 'networks:');
  if (ssh.length > 0) {
    push(
      '  ds_trap:',
      '    driver: bridge',
      '    driver_opts:',
      '      com.docker.network.bridge.name: br-ds-trap',
      '      com.docker.network.bridge.enable_ip_masquerade: "false"',
      '      com.docker.network.bridge.enable_icc: "false"',
      '    ipam:',
      '      config: [{ subnet: 172.31.250.0/24 }]',
    );
  }
  push('  ds_uplink:', '    driver: bridge', '', 'volumes:');
  if (hasWeb) push('  ds_web_sock: {}');
  push('  ds_agent_sock: {}');
  if (hasWeb) push('  ds_web_logs: {}');
  for (const s of ssh) push(`  ${names.sshLogs(s)}: {}`, `  ${names.sshData(s)}: {}`);
  push('  ds_agent_state: {}', '');
  return L.join('\n');
}
