import { execFile } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// The done-when of #20 (DESIGN §6.5): a real `next build` of a Client Component importing
// @geekibo/rapid7-logger/next must FAIL, and the same app without the misuse must build. Needs
// the fixture installed (`npm ci --prefix test/next-build/fixture`) and the package built; the
// CI job `next-client-import-guard` sets REQUIRE_NEXT_BUILD_GUARD so it can never skip silently.
//
// Measured (Next 16.4.0): Turbopack prints both
//   You're importing a module that depends on "server-only". … but you are using it in the Pages Router.
//   'server-only' cannot be imported from a Client Component module
// against dist/next.js, with the trace ending at app/bad/page.tsx; webpack prints the first.
// The "Pages Router" wording is Next's, and misleading — this is an App Router client import.

const root = fileURLToPath(new URL('../../', import.meta.url));
const fixture = join(root, 'test', 'next-build', 'fixture');
const link = join(fixture, 'node_modules', '@geekibo', 'rapid7-logger');
const nextBin = join(fixture, 'node_modules', '.bin', 'next');
const installed = existsSync(join(fixture, 'node_modules', 'next', 'package.json'));
const hasDist = existsSync(join(root, 'dist', 'next.js'));

if (process.env.REQUIRE_NEXT_BUILD_GUARD && !(installed && hasDist)) {
  throw new Error(
    `next-build guard cannot run: fixture installed=${String(installed)}, dist built=${String(hasDist)}`,
  );
}

const BUILD_TIMEOUT = 180_000;
const FAILURE = /depends on "server-only"|'server-only' cannot be imported from a Client Component/;

function build(args: string[]): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    execFile(
      nextBin,
      ['build', ...args],
      {
        cwd: fixture,
        env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1', CI: '1' },
        maxBuffer: 16 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        const code =
          error && 'code' in error && typeof error.code === 'number' ? error.code : error ? 1 : 0;
        resolve({ code, output: `${stdout}\n${stderr}` });
      },
    );
  });
}

const bundlers: [string, string[]][] = [
  ['turbopack', []],
  ['webpack', ['--webpack']],
];

describe.skipIf(!installed || !hasDist)('next build guard (invariant 7)', () => {
  beforeAll(() => {
    rmSync(dirname(link), { recursive: true, force: true });
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(root, link, 'dir');
    rmSync(join(fixture, 'app', 'bad'), { recursive: true, force: true });
  });
  afterAll(() => {
    rmSync(dirname(link), { recursive: true, force: true });
    rmSync(join(fixture, 'app', 'bad'), { recursive: true, force: true });
    rmSync(join(fixture, '.next'), { recursive: true, force: true });
  });

  it.each(bundlers)(
    'a Server Component importing /next builds (%s)',
    async (_name, args) => {
      const result = await build(args);
      expect(result.output).not.toMatch(/server-only/);
      expect(result.code).toBe(0);
    },
    BUILD_TIMEOUT,
  );

  it.each(bundlers)(
    'a Client Component importing /next fails to build (%s)',
    async (_name, args) => {
      mkdirSync(join(fixture, 'app', 'bad'), { recursive: true });
      copyFileSync(join(fixture, 'misuse', 'page.tsx'), join(fixture, 'app', 'bad', 'page.tsx'));
      try {
        const result = await build(args);
        expect(result.code).not.toBe(0);
        expect(result.output).toMatch(FAILURE);
        expect(result.output).toContain('dist/next.js');
        expect(result.output).toContain('app/bad/page.tsx');
      } finally {
        rmSync(join(fixture, 'app', 'bad'), { recursive: true, force: true });
      }
    },
    BUILD_TIMEOUT,
  );
});
