#!/usr/bin/env node
// Reprovision the local prototype analyst and attach the Acme Shop project.
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const result = spawnSync('pnpm', ['--filter', '@lxs/api', 'db:seed:saman'], {
  cwd: root,
  stdio: 'inherit',
});
process.exit(result.status ?? 1);
