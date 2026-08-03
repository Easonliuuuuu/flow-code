import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.integration.test.ts'],
    // Real network calls to a hosted model API run slower than unit tests,
    // and a multi-round-trip agent loop (several tool calls per test) adds
    // up. Kept generous rather than tuned tight — this suite runs nightly,
    // not on a latency-sensitive path — and can be measured down once real
    // Claude-backed CI runs establish a baseline.
    testTimeout: 240000,
  },
});
