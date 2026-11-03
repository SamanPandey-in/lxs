import type { ResolvedConfig, SshSpec } from '../types.js';
import { COMPOSE_FILE, renderCompose } from './compose.js';
import { renderCowrieCfg, renderHoneyfs, renderUserdb } from './cowrie.js';
import { generateHoneytokens, type HoneytokenFile, SECRETS_GITIGNORE } from './honeytokens.js';
import { renderManifest } from './manifest.js';
import { renderWebDecoys } from './web.js';

export { COMPOSE_FILE };

export interface Generated {
  /** Safe to commit; `build --check` compares these with what is on disk. */
  committed: Map<string, string>;
  /** Git-ignored under .lxs/secrets/ (plaintext honeytokens, bait credentials, honeyfs). */
  secrets: Map<string, string>;
  honeytokens: HoneytokenFile;
}

export interface GenerateOptions {
  existingHoneytokens?: HoneytokenFile | null;
  /** Path of the compose file to emit, relative to the project root. */
  composeFile?: string;
}

/** Pure: config in, file contents out. Paths are relative to the project root. */
export function generateAll(cfg: ResolvedConfig, opts: GenerateOptions = {}): Generated {
  const honeytokens = generateHoneytokens(cfg, opts.existingHoneytokens ?? null);
  const committed = new Map<string, string>();
  const secrets = new Map<string, string>();

  committed.set(opts.composeFile ?? COMPOSE_FILE, renderCompose(cfg));
  committed.set('.lxs/manifest.json', renderManifest(cfg, honeytokens));
  if (cfg.decoys.some((d) => d.type === 'web-admin' || d.type === 'web-bait')) {
    committed.set('.lxs/web-decoys.json', renderWebDecoys(cfg));
  }

  secrets.set('.lxs/secrets/.gitignore', SECRETS_GITIGNORE);
  secrets.set('.lxs/secrets/honeytokens.json', `${JSON.stringify(honeytokens, null, 2)}\n`);

  for (const d of cfg.decoys) {
    if (d.type !== 'ssh') continue;
    const s: SshSpec = d;
    committed.set(`.lxs/${s.id}/cowrie.cfg`, renderCowrieCfg(s));
    secrets.set(`.lxs/secrets/${s.id}/userdb.txt`, renderUserdb(s, honeytokens));
    for (const [rel, content] of renderHoneyfs(s, honeytokens)) {
      secrets.set(`.lxs/secrets/${s.id}/honeyfs/${rel}`, content);
    }
  }
  return { committed, secrets, honeytokens };
}
