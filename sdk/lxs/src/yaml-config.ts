import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { type DeclarativeConfig, defineConfig } from './config.js';
import type { LXS } from './create.js';
import { LXSConfigError } from './errors.js';
import { LxsFileSchema } from './file-schema.js';

/**
 * Parses and validates an lxs.yaml text into the same LXS instance the equivalent
 * `export default defineConfig({...})` would produce.
 */
export function loadYamlConfig(text: string, name = 'lxs.yaml'): LXS {
  let doc: unknown;
  try {
    doc = parseYaml(text, { prettyErrors: true });
  } catch (e) {
    throw new LXSConfigError(
      'E_CONFIG_INVALID',
      `${name} is not valid YAML: ${(e as Error).message}`,
    );
  }
  const r = LxsFileSchema.safeParse(doc ?? {});
  if (!r.success) {
    const msg = r.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    throw new LXSConfigError(
      'E_CONFIG_INVALID',
      `${name}: ${msg}.`,
      'See sdk/lxs/schema/lxs.schema.json (add `# yaml-language-server: $schema=...` for editor checks).',
    );
  }
  // Pass the user's values, not zod's defaults: defineConfig applies the same defaults itself.
  const { $schema: _s, ...config } = doc as Record<string, unknown>;
  return defineConfig(config as DeclarativeConfig);
}

/**
 * Reads an lxs.yaml file and returns the LXS instance to mount, e.g.
 * `app.use(loadLxsYaml('lxs.yaml').express())`.
 */
export function loadLxsYaml(file: string): LXS {
  return loadYamlConfig(fs.readFileSync(file, 'utf8'), path.basename(file));
}
