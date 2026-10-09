import { defineConfig } from 'vitest/config';

// No passWithNoTests: a broken include pattern must fail, not pass silently.
export default defineConfig({
  resolve: {
    // Next aliases 'server-only' itself; outside Next the real package throws at import. The
    // suite imports src/next.ts directly, so it gets an empty stand-in instead.
    alias: { 'server-only': new URL('./test/stubs/server-only.ts', import.meta.url).pathname },
  },
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['**/node_modules/**', 'test/next-build/fixture/**', 'examples/**'],
    environment: 'node',
  },
});
