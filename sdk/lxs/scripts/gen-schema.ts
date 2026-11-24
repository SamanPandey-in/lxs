// Regenerates schema/lxs.schema.json from the zod schema (src/file-schema.ts). Run: pnpm --filter lxs schema
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lxsJsonSchema } from '../src/file-schema.js';

const out = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'schema',
  'lxs.schema.json',
);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, `${JSON.stringify(lxsJsonSchema(), null, 2)}\n`);
console.log(`wrote ${path.relative(process.cwd(), out)}`);
