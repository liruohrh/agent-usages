import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    reporters: 'default',
    // The CLI suite spawns real processes, and a few cases reach the lazy
    // pricing/rate update, whose fetch timeouts land right on the 5s default
    // when the network is unreachable. Give them room instead of flaking.
    testTimeout: 20_000,
  },
});
