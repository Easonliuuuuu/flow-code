import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.integration.test.ts'],
    // Real network calls to a hosted model API run slower than unit tests.
    // Measured on GitHub Actions: a test that takes ~24s locally took ~115s
    // there (roughly 5x) — likely NVIDIA's free tier deprioritizing cloud CI
    // IP ranges. 120s still timed out the 3-round-trip test; give real
    // margin rather than inching the cap up run by run.
    testTimeout: 240000,
  },
});
