import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { fixture, run, startServer } from './helpers.js';

// Integration tests for DESIGN §7.3, against the BUILT Node entry (`npm run build` first; CI
// builds before testing). Locally they skip without dist/; in CI a missing build is a failure.
const hasDist = existsSync(new URL('../../dist/index.js', import.meta.url));
if (process.env.CI && !hasDist) {
  throw new Error('test/node needs dist/: run npm run build before npm test (see ci.yml)');
}

const TIMEOUT = 20_000;

describe.skipIf(!hasDist)('lifecycle (built Node entry)', () => {
  it(
    'a script that logs once and exits immediately still delivers the line',
    async () => {
      const server = await startServer();
      try {
        const { exit } = run([fixture('child.mjs'), 'once', String(server.port)]);
        const result = await exit;
        expect(result.code).toBe(0);
        expect(server.lines).toHaveLength(1);
        expect(server.lines[0]).toMatch(/ once and exit\n$/);
      } finally {
        await server.close();
      }
    },
    TIMEOUT,
  );

  it(
    'the CommonJS build does too',
    async () => {
      const server = await startServer();
      try {
        const result = await run([fixture('child.cjs'), String(server.port)]).exit;
        expect(result.code).toBe(0);
        expect(server.lines).toHaveLength(1);
      } finally {
        await server.close();
      }
    },
    TIMEOUT,
  );

  it(
    'SIGTERM during a burst flushes everything and exits by the signal',
    async () => {
      const server = await startServer();
      try {
        const { child, exit, ready } = run([
          fixture('child.mjs'),
          'burst',
          String(server.port),
          '4000',
        ]);
        await ready;
        child.kill('SIGTERM');
        const result = await exit;
        expect(result.signal).toBe('SIGTERM');
        expect(result.code).toBeNull();
        expect(server.lines).toHaveLength(200);
        expect(server.lines.every((l) => l.includes(' burst i='))).toBe(true);
      } finally {
        await server.close();
      }
    },
    TIMEOUT,
  );

  it(
    'SIGTERM against a hanging server exits within the bound, not when the queue drains',
    async () => {
      const server = await startServer({ hang: true });
      try {
        const { child, exit, ready } = run([
          fixture('child.mjs'),
          'burst',
          String(server.port),
          '500',
        ]);
        await ready;
        const signalledAt = performance.now();
        child.kill('SIGTERM');
        const result = await exit;
        const afterSignalMs = performance.now() - signalledAt;
        expect(result.signal).toBe('SIGTERM');
        expect(afterSignalMs).toBeGreaterThanOrEqual(450);
        expect(afterSignalMs).toBeLessThan(2500);
        expect(server.requests()).toBeLessThanOrEqual(8); // maxConcurrency, all stuck
      } finally {
        await server.close();
      }
    },
    TIMEOUT,
  );

  it(
    'with an application SIGTERM handler, the library flushes but never re-raises',
    async () => {
      const server = await startServer();
      try {
        const { child, exit, ready } = run([fixture('child.mjs'), 'handled', String(server.port)]);
        await ready;
        child.kill('SIGTERM');
        const result = await exit;
        expect(result.code).toBe(42);
        expect(result.signal).toBeNull();
        expect(server.lines).toHaveLength(200);
      } finally {
        await server.close();
      }
    },
    TIMEOUT,
  );
});
