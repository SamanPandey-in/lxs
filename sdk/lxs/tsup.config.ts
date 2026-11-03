import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: { index: 'src/index.ts', testing: 'src/testing.ts' },
    format: ['esm', 'cjs'],
    dts: true,
    clean: true,
    sourcemap: true,
    target: 'node22',
    platform: 'node',
  },
  {
    // The CLI is ESM-only (jiti loads decoy.config.ts via import.meta.url).
    entry: { 'cli/index': 'src/cli/index.ts' },
    format: ['esm'],
    dts: false,
    clean: false,
    sourcemap: true,
    target: 'node22',
    platform: 'node',
    banner: { js: '#!/usr/bin/env node' },
  },
]);
