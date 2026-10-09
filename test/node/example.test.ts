import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer } from './helpers.js';

// Runs examples/node-basic exactly as a consumer would, against the BUILT package: the example
// imports '@geekibo/rapid7-logger' by name, resolved through a symlink into the repo root, so
// the real exports map and dist/ are what it sees.
const root = fileURLToPath(new URL('../../', import.meta.url));
const example = join(root, 'examples', 'node-basic');
const link = join(example, 'node_modules', '@geekibo', 'rapid7-logger');
const hasDist = existsSync(join(root, 'dist', 'index.js'));
if (process.env.CI && !hasDist) {
  throw new Error('test/node needs dist/: run npm run build before npm test (see ci.yml)');
}

const run = promisify(execFile);
const TOKEN = 'deadbeef-dead-4bad-8bad-feedfacecafe';

describe.skipIf(!hasDist)('examples/node-basic', () => {
  beforeAll(() => {
    rmSync(dirname(link), { recursive: true, force: true });
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(root, link, 'dir');
  });
  afterAll(() => rmSync(join(example, 'node_modules'), { recursive: true, force: true }));

  it('runs on the console path with no token, and says so', async () => {
    const { stdout, stderr } = await run(process.execPath, ['index.mjs'], {
      cwd: example,
      env: { ...process.env, RAPID7_TOKEN: '', RAPID7_LOG_SERVER_PORT: '' },
    });
    expect(stderr).toMatch(/no token configured; logging to the console only/);
    expect(stdout).toMatch(
      /\[\d\d:\d\d:\d\d INF\] Survey published service=node-basic env=local surveyId=42 runId=44/,
    );
    expect(stderr).toMatch(/\[\d\d:\d\d:\d\d ERR\] Export failed .*SyntaxError/);
    expect(stdout).toMatch(/[0-9a-f]{32}: _ request received/);
    expect(stdout).toMatch(/no RAPID7_TOKEN set/);
  }, 20_000);

  it('posts every line through the real transport when a token is set', async () => {
    const server = await startServer();
    try {
      const { stdout } = await run(process.execPath, ['index.mjs'], {
        cwd: example,
        env: { ...process.env, RAPID7_TOKEN: TOKEN, RAPID7_LOG_SERVER_PORT: String(server.port) },
      });
      expect(server.lines).toHaveLength(9);
      expect(server.lines.every((l) => l.includes('service=node-basic'))).toBe(true);
      expect(server.lines.some((l) => /[0-9a-f]{32}: _ request received/.test(l))).toBe(true);
      expect(stdout).toMatch(/"sent":9/);
      expect(stdout).toMatch(/9 lines accepted by Rapid7/);
    } finally {
      await server.close();
    }
  }, 20_000);
});
