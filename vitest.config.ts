import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // The end-to-end tests spawn the example app and write run directories.
    testTimeout: 30_000,
  },
});
