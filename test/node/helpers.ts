import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';

/** A local stand-in for the webhook: records every body; optionally never answers. */
export async function startServer(options: { hang?: boolean } = {}) {
  const lines: string[] = [];
  let requests = 0;
  let delayMs = 0;
  const server: Server = createServer((req, res) => {
    requests += 1;
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString()));
    req.on('end', () => {
      if (options.hang) return; // leave the request open
      const answer = () => {
        lines.push(body);
        res.writeHead(204).end();
      };
      if (delayMs > 0) setTimeout(answer, delayMs);
      else answer();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    lines,
    requests: () => requests,
    /** Hold every response this long: makes "flushed after the response" observable. */
    setDelay: (ms: number) => {
      delayMs = ms;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export const fixture = (name: string) =>
  fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

export interface Exit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly elapsedMs: number;
}

/** Spawn `node` on a fixture and resolve when it exits. */
export function run(args: string[]): {
  child: ChildProcess;
  exit: Promise<Exit>;
  ready: Promise<void>;
} {
  const startedAt = performance.now();
  const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'inherit'] });
  const ready = new Promise<void>((resolve) => {
    child.stdout?.on('data', (chunk: Buffer) => {
      if (chunk.toString().includes('ready')) resolve();
    });
  });
  const exit = new Promise<Exit>((resolve) => {
    child.on('exit', (code, signal) =>
      resolve({ code, signal, elapsedMs: performance.now() - startedAt }),
    );
  });
  return { child, exit, ready };
}
