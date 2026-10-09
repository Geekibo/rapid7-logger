import { spawn, type ChildProcess } from 'node:child_process';
import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer } from '../node/helpers.js';

// examples/nextjs-app, built and started for real (DESIGN §6, #21), with a local server standing
// in for the webhook. This is the evidence for #18's done-when: a Server Component render, a
// Route Handler and a Server Action each produce a line with routeType and, where Next assigns
// one, a digest. Needs the example installed (`npm ci --prefix examples/nextjs-app`) and the
// package built; the CI job `next-example` sets REQUIRE_NEXT_EXAMPLE so it can never skip.

const root = fileURLToPath(new URL('../../', import.meta.url));
const example = join(root, 'examples', 'nextjs-app');
const nextBin = join(example, 'node_modules', '.bin', 'next');
const installed = existsSync(join(example, 'node_modules', 'next', 'package.json'));
const hasDist = existsSync(join(root, 'dist', 'next.js'));
if (process.env.REQUIRE_NEXT_EXAMPLE && !(installed && hasDist)) {
  throw new Error(
    `next example cannot run: installed=${String(installed)}, dist built=${String(hasDist)}`,
  );
}

const TOKEN = 'deadbeef-dead-4bad-8bad-feedfacecafe';
const TRACE = '0af7651916cd43dd8448eb211c80319c';
const traceparent = `00-${TRACE}-b7ad6b7169203331-01`;
const BUILD_TIMEOUT = 240_000;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.next') continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(path);
  }
  return out;
}

describe('examples/nextjs-app source (invariant 7)', () => {
  it("no 'use client' file imports the logger, and nothing reads NEXT_PUBLIC_", () => {
    for (const file of walk(example)) {
      const text = readFileSync(file, 'utf8');
      expect(text, file).not.toMatch(/process\.env\.NEXT_PUBLIC_/);
      if (/^['"]use client['"]/m.test(text)) {
        expect(text, file).not.toMatch(/@geekibo\/rapid7-logger|@\/lib\/(log|edge-log)/);
      }
    }
  });
});

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

describe.skipIf(!installed || !hasDist)(
  'examples/nextjs-app, built and started',
  { timeout: 60_000 },
  () => {
    let server: Awaited<ReturnType<typeof startServer>>;
    let child: ChildProcess | undefined;
    let base = '';
    let output = '';
    const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
    /** Lines received since `from`, after letting delivery settle. */
    const linesSince = async (from: number) => {
      await sleep(2500);
      return server.lines.slice(from);
    };

    beforeAll(async () => {
      server = await startServer();
      const env = {
        ...process.env,
        RAPID7_TOKEN: TOKEN,
        RAPID7_LOG_SERVER_PORT: String(server.port),
        NEXT_TELEMETRY_DISABLED: '1',
        CI: '1',
      };
      await new Promise<void>((resolve, reject) => {
        execFile(
          nextBin,
          ['build'],
          { cwd: example, env, maxBuffer: 16 * 1024 * 1024 },
          (error, stdout, stderr) =>
            error ? reject(new Error(`next build failed:\n${stdout}\n${stderr}`)) : resolve(),
        );
      });
      const port = await freePort();
      base = `http://127.0.0.1:${port}`;
      child = spawn(nextBin, ['start', '-p', String(port), '-H', '127.0.0.1'], {
        cwd: example,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.stdout?.on('data', (c: Buffer) => (output += c.toString()));
      child.stderr?.on('data', (c: Buffer) => (output += c.toString()));
      for (let i = 0; i < 300; i++) {
        try {
          await fetch(`${base}/`);
          break;
        } catch {
          await sleep(200);
        }
      }
      server.lines.length = 0; // drop startup and warm-up lines
    }, BUILD_TIMEOUT);

    afterAll(async () => {
      if (child) {
        child.kill('SIGTERM');
        await new Promise<void>((resolve) => child?.on('exit', () => resolve()));
      }
      await server.close();
      rmSync(join(example, '.next'), { recursive: true, force: true });
    });

    it('a Server Component logs a line', async () => {
      const from = server.lines.length;
      expect((await fetch(`${base}/`)).status).toBe(200);
      const lines = await linesSince(from);
      expect(lines.some((l) => /INF\] home rendered service=nextjs-app/.test(l))).toBe(true);
    });

    it('a Route Handler via withLogging inherits the traceparent and reports duration', async () => {
      const from = server.lines.length;
      const res = await fetch(`${base}/api/surveys`, { headers: { traceparent } });
      expect(res.status).toBe(200);
      const lines = await linesSince(from);
      const completed = lines.find((l) => l.includes('listSurveys completed'));
      expect(completed).toMatch(
        new RegExp(`^\\[\\d\\d:\\d\\d:\\d\\d INF\\] ${TRACE}: _ listSurveys completed`),
      );
      expect(completed).toMatch(/operation=listSurveys durationMs=\d+/);
      expect(lines.some((l) => l.includes(`${TRACE}: _ listing`))).toBe(true);
    });

    it('a throwing Route Handler: withLogging failed + onRequestError with routeType=route (no digest: Next assigns none)', async () => {
      const from = server.lines.length;
      const res = await fetch(`${base}/api/surveys?fail=1`, { headers: { traceparent } });
      expect(res.status).toBe(500);
      const lines = await linesSince(from);
      expect(
        lines.some((l) => /ERR\] .*listSurveys failed .*boom: deliberate route error/.test(l)),
      ).toBe(true);
      const hook = lines.find((l) => l.includes('Unhandled server error'));
      expect(hook).toContain(`${TRACE}: _ Unhandled server error`);
      expect(hook).toContain('routeType=route');
      expect(hook).toContain('path="/api/surveys?fail=1"');
      expect(hook).toContain('method=GET');
    });

    it('a Server Component that throws: onRequestError with routeType=render and a digest', async () => {
      const from = server.lines.length;
      const res = await fetch(`${base}/boom`);
      expect(res.status).toBe(500);
      const lines = await linesSince(from);
      const hook = lines.find((l) => l.includes('Unhandled server error'));
      expect(hook).toContain('routeType=render');
      expect(hook).toMatch(/digest=\S+/);
      expect(hook).toContain('boom: deliberate render error');
    });

    it('a Server Action that throws: onRequestError with routeType=action and the digest the client sees', async () => {
      const page = await (await fetch(`${base}/action-boom`)).text();
      const ids = [...page.matchAll(/\$ACTION_ID_([0-9a-f]+)/g)].map((m) => m[1]);
      expect(ids.length).toBeGreaterThanOrEqual(2);
      const [okId, failId] = ids;
      const invoke = (id: string, fields: Record<string, string>) => {
        const body = new FormData();
        body.set('0', '["$K1"]');
        for (const [k, v] of Object.entries(fields)) body.set(`1_${k}`, v);
        return fetch(`${base}/action-boom`, {
          method: 'POST',
          redirect: 'manual',
          headers: { 'next-action': id, accept: 'text/x-component', origin: base, traceparent },
          body,
        });
      };

      let from = server.lines.length;
      expect((await invoke(okId!, { id: '42' })).status).toBe(200);
      let lines = await linesSince(from);
      expect(lines.some((l) => /publishSurvey completed .*durationMs=\d+/.test(l))).toBe(true);
      expect(lines.some((l) => l.includes('publishing') && l.includes('id=42'))).toBe(true);

      from = server.lines.length;
      const failRes = await invoke(failId!, {});
      const rsc = await failRes.text();
      const clientDigest = /"digest":"([^"]+)"/.exec(rsc)?.[1];
      expect(clientDigest).toBeDefined();
      lines = await linesSince(from);
      expect(
        lines.some((l) => /ERR\] .*failSurvey failed .*boom: deliberate action error/.test(l)),
      ).toBe(true);
      const hook = lines.find((l) => l.includes('Unhandled server error'));
      expect(hook).toContain('routeType=action');
      expect(hook).toContain(`digest=${clientDigest!}`);
    });

    it('withLogging flushes via after(): the response does not wait for a slow log endpoint', async () => {
      server.setDelay(1000);
      try {
        const from = server.lines.length;
        const started = performance.now();
        expect((await fetch(`${base}/api/surveys`)).status).toBe(200);
        const elapsed = performance.now() - started;
        expect(elapsed).toBeLessThan(700); // the flush runs after the response, not before it
        await sleep(3500);
        expect(server.lines.slice(from).some((l) => l.includes('listSurveys completed'))).toBe(
          true,
        );
      } finally {
        server.setDelay(0);
      }
    });

    it('an Edge route runs the /edge logger: register() on edge, the ping, trace inherited', async () => {
      const from = server.lines.length;
      const res = await fetch(`${base}/api/edge`, { headers: { traceparent } });
      expect(res.status).toBe(200);
      const lines = await linesSince(from);
      // register() runs on the first request to an Edge route, not at startup.
      expect(lines.some((l) => /server starting .*runtime=edge/.test(l))).toBe(true);
      expect(lines.some((l) => new RegExp(`${TRACE}: _ edge ping .*runtime=edge`).test(l))).toBe(
        true,
      );
      expect(
        lines.some((l) => new RegExp(`${TRACE}: _ edgePing completed .*durationMs=\\d+`).test(l)),
      ).toBe(true);
    });

    it('a throwing Edge route: withLogging failed + onRequestError with routeType=route', async () => {
      const from = server.lines.length;
      const res = await fetch(`${base}/api/edge?fail=1`);
      expect(res.status).toBe(500);
      const lines = await linesSince(from);
      expect(
        lines.some((l) => /ERR\] .*edgePing failed .*boom: deliberate edge error/.test(l)),
      ).toBe(true);
      const hook = lines.find(
        (l) => l.includes('Unhandled server error') && l.includes('/api/edge'),
      );
      // routerKind is not asserted: Next reports "Pages Router" for Edge app routes.
      expect(hook).toContain('routeType=route');
      expect(hook).toContain('path="/api/edge?fail=1"');
      expect(hook).toContain('method=GET');
    });

    it('on Edge too, withLogging flushes after the response', async () => {
      server.setDelay(1000);
      try {
        const from = server.lines.length;
        const started = performance.now();
        expect((await fetch(`${base}/api/edge`)).status).toBe(200);
        expect(performance.now() - started).toBeLessThan(700);
        await sleep(3500);
        expect(server.lines.slice(from).some((l) => l.includes('edgePing completed'))).toBe(true);
      } finally {
        server.setDelay(0);
      }
    });

    it('the client-error route logs what the browser posts', async () => {
      const from = server.lines.length;
      const res = await fetch(`${base}/api/client-error`, {
        method: 'POST',
        body: JSON.stringify({ message: 'from browser', digest: 'abc123' }),
      });
      expect(res.status).toBe(204);
      const lines = await linesSince(from);
      expect(
        lines.some((l) => /ERR\] .*Client error .*digest=abc123 ClientError: from browser/.test(l)),
      ).toBe(true);
    });

    it('nothing delivered contains a newline or the token, and the hook never failed', () => {
      for (const line of server.lines) {
        expect(line.endsWith('\n')).toBe(true);
        expect(line.slice(0, -1)).not.toMatch(/[\r\n]/);
        expect(line).not.toContain(TOKEN);
      }
      expect(output).not.toContain('Error in instrumentation.onRequestError');
      expect(output).toMatch(/Ready/);
    });
  },
);
