import type { ResolvedConfig, SshSpec } from '../types.js';
import { SDK_VERSION } from '../version.js';

/**
 * .lxs/web-decoys.json: the only input ds-web needs. No secrets: it carries brand names, mounts,
 * accepted *bait* credentials and breadcrumb targets. Honeytoken values arrive via the mounted secrets file.
 */
export function renderWebDecoys(cfg: ResolvedConfig): string {
  const ssh = cfg.decoys.find((d): d is SshSpec => d.type === 'ssh');
  const decoys = cfg.decoys.flatMap(
    (d): Array<Record<string, unknown> & { type: string; mount: string }> => {
      if (d.type === 'web-admin') {
        return [
          {
            id: d.id,
            type: d.type,
            mount: d.mount,
            brand: d.brand,
            acceptCredentials: d.acceptCredentials,
            ...(d.acceptAfter ? { acceptAfter: d.acceptAfter } : {}),
            panel: d.panel,
          },
        ];
      }
      if (d.type === 'web-bait') {
        return [
          {
            id: d.id,
            type: d.type,
            mount: d.mount,
            template: d.template,
            breadcrumbs: d.breadcrumbs,
          },
        ];
      }
      return [];
    },
  );
  const doc = {
    generated_by: `lxs ${SDK_VERSION}`,
    version: 1,
    service: cfg.options.service,
    decoys,
    breadcrumbs: {
      ssh: ssh ? { host: ssh.hostname, port: ssh.port, user: 'deploy' } : null,
      adminMount: decoys.find((d) => d.type === 'web-admin')?.mount ?? null,
    },
  };
  return `${JSON.stringify(doc, null, 2)}\n`;
}
