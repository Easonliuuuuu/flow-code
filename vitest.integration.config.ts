import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.integration.test.ts'],
    // Real network calls to Claude are slower than unit tests. The previous
    // seven-test canary completed in about 115 seconds on CI; retain generous
    // headroom for provider variance because this suite is not latency-critical.
    testTimeout: 240000,
  },
});
