import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Integration tests hit real external APIs (NVIDIA) and need a live
    // credential; they run separately via `npm run test:integration`.
    exclude: ['**/node_modules/**', '**/dist/**', 'test/**/*.integration.test.ts'],
    testTimeout: 30000,
  },
});
