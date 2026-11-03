import type { ResolvedConfig } from '../types.js';
import { SDK_VERSION } from '../version.js';
import type { HoneytokenFile } from './honeytokens.js';

/** Declared containment posture, recorded so the platform can display (and `selftest` can verify) it. */
export const POSTURE = {
  'ds-web': {
    network: 'none',
    read_only: true,
    cap_drop: ['ALL'],
    no_new_privileges: true,
    user: '10002',
    mem_limit: '128m',
    pids_limit: 64,
  },
  'ds-ssh': {
    network: 'ds_trap',
    inbound_only: true,
    read_only: true,
    cap_drop: ['ALL'],
    no_new_privileges: true,
    mem_limit: '256m',
    pids_limit: 128,
  },
  'ds-agent': {
    network: 'ds_uplink',
    read_only: true,
    cap_drop: ['ALL'],
    no_new_privileges: true,
    user: '10001',
    mem_limit: '256m',
    pids_limit: 128,
  },
} as const;

/**
 * .lxs/manifest.json (committed). Honeytoken *hashes* are deliberately absent so the file is
 * deterministic across machines; the agent derives them from the mounted secrets file.
 */
export function renderManifest(cfg: ResolvedConfig, tokens: HoneytokenFile): string {
  const doc = {
    sdk_version: SDK_VERSION,
    service: cfg.options.service,
    mode: cfg.options.mode,
    decoys: cfg.decoys.map((d) => {
      if (d.type === 'web-admin' || d.type === 'web-bait') {
        return {
          id: d.id,
          type: d.type,
          mount: d.mount,
          ...(d.type === 'web-bait' ? { template: d.template } : {}),
        };
      }
      if (d.type === 'ssh') {
        return { id: d.id, type: d.type, mount: d.port, persona: d.persona, hostname: d.hostname };
      }
      return { id: d.id, type: d.type, mount: d.port };
    }),
    assets: cfg.assets.map((a) => ({
      pattern: a.pattern,
      name: a.name,
      criticality: a.criticality,
    })),
    honeytokens: tokens.tokens.map((t) => ({ id: t.id, kind: t.kind, planted_in: t.planted_in })),
    posture: POSTURE,
  };
  return `${JSON.stringify(doc, null, 2)}\n`;
}
