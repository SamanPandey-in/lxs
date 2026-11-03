import { defineConfig } from 'tsup';

// One self-contained file for the distroless image.
export default defineConfig({
  entry: { main: 'src/main.ts' },
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  clean: true,
  splitting: false,
  minify: false,
  sourcemap: false,
  noExternal: [/.*/],
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
});
