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
  for (const d of cfg.decoys) {
    if (d.type !== 'postgres') continue;
    const db = d.seed === 'shop' ? 'shop_prod' : 'finance';
    committed.set(
      `.lxs/${d.id}/init.sql`,
      `-- Synthetic decoy data only. Never load customer data here.\nCREATE ROLE lxs_fake LOGIN PASSWORD 'lxs_fake_only' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;\nREVOKE CONNECT, TEMP ON DATABASE ${db} FROM PUBLIC;\nGRANT CONNECT ON DATABASE ${db} TO lxs_fake;\nREVOKE CREATE ON SCHEMA public FROM PUBLIC;\nCREATE TABLE IF NOT EXISTS public.users (id integer PRIMARY KEY, email text, password_hash text);\nCREATE TABLE IF NOT EXISTS public.payments (id integer PRIMARY KEY, amount_cents integer, status text);\nCREATE TABLE IF NOT EXISTS public.sessions (id integer PRIMARY KEY, user_id integer, session_key text);\nINSERT INTO public.users VALUES (1, 'alice@example.invalid', 'not-a-real-hash'), (2, 'bob@example.invalid', 'also-not-real') ON CONFLICT DO NOTHING;\nINSERT INTO public.payments VALUES (1, 1299, 'settled'), (2, 4900, 'pending') ON CONFLICT DO NOTHING;\nINSERT INTO public.sessions VALUES (1, 1, 'fake-session-01') ON CONFLICT DO NOTHING;\nGRANT USAGE ON SCHEMA public TO lxs_fake;\nGRANT SELECT ON ALL TABLES IN SCHEMA public TO lxs_fake;\nALTER ROLE lxs_fake SET temp_file_limit = '16MB';\nALTER ROLE lxs_fake SET statement_timeout = '10s';\nALTER ROLE postgres NOLOGIN;\n`,
    );
  }
  return { committed, secrets, honeytokens };
}
