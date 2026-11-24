import { z } from 'zod';
import {
  AssetSchema,
  HoneytokenSchema,
  OptionsSchema,
  PostgresSchema,
  RedisSchema,
  SshSchema,
  WebAdminSchema,
  WebBaitSchema,
} from './config.js';

/**
 * The language-neutral config file (`lxs.yaml`): the same content as a `defineConfig({...})` object
 * in `decoy.config.ts`, built from the same zod schemas so the two can never drift. The committed
 * JSON Schema (`schema/lxs.schema.json`) is generated from this (`pnpm --filter lxs schema`).
 *
 * This only checks shape. The loaded object then goes through `defineConfig()`, which runs exactly
 * the validation a TypeScript config gets (mount paths, ports, duplicate ids, CIDRs, ...).
 */

const WebPath = z
  .string()
  .regex(/^\//, "web decoys mount on an absolute path starting with '/'")
  .max(200)
  .describe(
    "Path on your own domain, e.g. '/admin' or '/.env'. Exact match (web-admin also covers sub-paths).",
  );
const Port = z.number().int().min(1).max(65535).describe('Host port the network decoy listens on.');

const WebAdminDecoy = WebAdminSchema.extend({
  type: z.literal('web-admin'),
  path: WebPath,
}).strict();
const WebBaitDecoy = WebBaitSchema.extend({ type: z.literal('web-bait'), path: WebPath }).strict();
const SshDecoy = SshSchema.extend({ type: z.literal('ssh'), port: Port }).strict();
const RedisDecoy = RedisSchema.extend({ type: z.literal('redis'), port: Port }).strict();
const PostgresDecoy = PostgresSchema.extend({ type: z.literal('postgres'), port: Port }).strict();

export const DecoyFileSchema = z.discriminatedUnion('type', [
  WebAdminDecoy,
  WebBaitDecoy,
  SshDecoy,
  RedisDecoy,
  PostgresDecoy,
]);

export const AssetFileSchema = AssetSchema.extend({
  pattern: z
    .string()
    .regex(/^\//, 'asset patterns are absolute paths')
    .describe("Absolute path, optionally ending in '/*' for a subtree, e.g. '/api/payments/*'."),
}).strict();

export const LxsFileSchema = OptionsSchema.omit({ logger: true })
  .extend({
    $schema: z.string().optional().describe('Optional JSON Schema reference for editors.'),
    decoys: z.array(DecoyFileSchema).optional(),
    assets: z.array(AssetFileSchema).optional(),
    honeytokens: z.union([z.literal(true), HoneytokenSchema.strict()]).optional(),
  })
  .strict();

export type LxsFile = z.input<typeof LxsFileSchema>;

export const SCHEMA_ID = 'https://lxs.dev/schema/lxs.schema.json';

/** The JSON Schema for `lxs.yaml`, generated from {@link LxsFileSchema}. */
export function lxsJsonSchema(): Record<string, unknown> {
  const generated = z.toJSONSchema(LxsFileSchema, {
    io: 'input',
    target: 'draft-2020-12',
    unrepresentable: 'any',
  }) as Record<string, unknown>;
  const { $schema, ...rest } = generated;
  return {
    $schema,
    $id: SCHEMA_ID,
    title: 'lxs.yaml',
    description:
      'LXS honeypots-as-code config. Same content as a defineConfig({...}) object in decoy.config.ts.',
    ...rest,
  };
}
