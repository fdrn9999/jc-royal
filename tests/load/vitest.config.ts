import { defineConfig } from 'vitest/config';

/** Local load scenario (`pnpm test:load`). Kept out of the integration suite: it is slow and measures, not gates. */
export default defineConfig({
  test: {
    include: ['tests/load/**/*.load.ts'],
    globalSetup: ['tests/load/setup.ts'],
    testTimeout: 20 * 60_000,
    hookTimeout: 180_000,
    fileParallelism: false,
  },
});
