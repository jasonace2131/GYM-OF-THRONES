import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * Client unit tests. jsdom because lib/api.ts reads `fetch` and lib/deviceCache
 * reads localStorage; nothing here renders React yet.
 *
 * The aliases mirror client/tsconfig.json exactly. @got/shared MUST resolve to
 * the same source file the app resolves, or CivilDate's brand becomes a second,
 * incompatible `unique symbol` and the two runtimes stop agreeing.
 */
export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    globals: false,
  },
  resolve: {
    alias: {
      '@got/shared': fileURLToPath(new URL('../shared/src/index.ts', import.meta.url)),
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
});
