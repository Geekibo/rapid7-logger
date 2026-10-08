import { defineConfig } from 'vitest/config';

// No passWithNoTests: a broken include pattern must fail, not pass silently.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
