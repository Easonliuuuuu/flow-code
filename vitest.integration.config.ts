import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.integration.test.ts'],
    // Real network calls to a hosted model API run slower than unit tests.
    testTimeout: 60000,
  },
});
