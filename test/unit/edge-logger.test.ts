import { afterEach, describe, expect, it, vi } from 'vitest';
import * as edge from '../../src/edge.js';
import type { Logger } from '../../src/core/types.js';
import { MemoryTransport } from '../../src/transports/memory.js';

const TOKEN = 'deadbeef-dead-4bad-8bad-feedfacecafe';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('the Edge createLogger (§6.3)', () => {
  it('delivers to the transport synchronously, no flush needed', async () => {
    const transport = new MemoryTransport();
    const log = edge.createLogger({ transport, service: 'edge' });
    log.info('now', { a: 1 });
    expect(transport.events).toHaveLength(1); // handed over inside the level call
    expect(transport.lines()[0]).toMatch(/INF\] now service=edge a=1$/);
    expect(log.stats().queued).toBe(0);
    await log.flush(100); // `sent` is counted when the send settles
    expect(log.stats()).toMatchObject({ queued: 0, sent: 1 });
  });

  it('posts through the webhook at once; await flush() to know it settled', async () => {
    const calls: string[] = [];
    const fetchImpl = ((url: string) => {
      calls.push(url);
      return Promise.resolve(new Response(null, { status: 204 }));
    }) as unknown as typeof fetch;
    const log = edge.createLogger({ token: TOKEN, fetch: fetchImpl });
    log.info('edge');
    expect(calls).toHaveLength(1); // the fetch started inside the level call
    await log.flush(1000);
    expect(log.stats()).toMatchObject({ sent: 1, failed: 0 });
  });

  it('never throws and counts failures: fetch throws, 500, 401, hangs (invariant 3)', async () => {
    vi.useFakeTimers();
    const onInternalError = vi.fn();
    const cases: [string, typeof fetch][] = [
      [
        'throws',
        () => {
          throw new Error('sync');
        },
      ],
      ['500', () => Promise.resolve(new Response('x', { status: 500 }))],
      ['401', () => Promise.resolve(new Response(null, { status: 401 }))],
    ];
    for (const [, fetchImpl] of cases) {
      const log = edge.createLogger({ token: TOKEN, fetch: fetchImpl, onInternalError });
      expect(() => log.error('x')).not.toThrow();
      const flushed = log.flush(5000);
      await vi.runAllTimersAsync();
      await flushed;
      expect(log.stats().failed).toBe(1);
    }
    const hanging = edge.createLogger({
      token: TOKEN,
      fetch: (() => new Promise<Response>(() => {})) as unknown as typeof fetch,
      onInternalError,
    });
    hanging.warn('stuck');
    let resolved = false;
    void hanging.flush(100).then(() => (resolved = true));
    await vi.advanceTimersByTimeAsync(100);
    expect(resolved).toBe(true); // invariant 4 at the logger level
  });

  it('children share the dispatcher; queueLimit bounds in-flight sends; a bad token degrades to the console', () => {
    const transport = { send: () => new Promise<void>(() => {}), flush: () => Promise.resolve() };
    const onInternalError = vi.fn();
    const log = edge.createLogger({ transport, queueLimit: 1, onInternalError });
    log.child({ a: 1 }).info('one');
    log.info('two');
    expect(log.stats()).toMatchObject({ dropped: 1 });

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const fallback: Logger = edge.createLogger({ token: 'not-a-guid' });
    fallback.info('console');
    expect(warn).toHaveBeenCalledOnce();
    expect(info).toHaveBeenCalledOnce();
  });
});
