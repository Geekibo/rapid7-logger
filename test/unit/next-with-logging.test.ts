/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/only-throw-error -- async fns without await model Server Actions, and throwing non-Errors is a case under test */
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { createLogger } from '../../src/core/logger.js';
import type { Logger } from '../../src/core/types.js';
import {
  withLogging,
  type AfterScheduler,
  type WithLoggingOptions,
} from '../../src/next/with-logging.js';
import { MemoryTransport } from '../../src/transports/memory.js';

// `next/server` is genuinely absent here: the default `after` path resolves to the inline
// fallback. The mocked path is in next-with-logging.after.test.ts.

const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';

function setup(options?: WithLoggingOptions) {
  const transport = new MemoryTransport();
  const log = createLogger({ transport, level: 'debug' });
  return {
    transport,
    log,
    wrap: <A extends unknown[], R>(fn: (log: Logger, ...a: A) => R) =>
      withLogging(log, 'op', fn, options),
  };
}

/**
 * A real logger whose children flush through a spy. Spreading a CoreLogger would copy only its
 * level methods (own arrow properties), not child/flush/stats (prototype methods).
 */
function loggerWithFlushSpy(flush = vi.fn((_t?: number) => Promise.resolve())) {
  const transport = new MemoryTransport();
  const bound = (l: Logger): Logger => ({
    trace: l.trace,
    debug: l.debug,
    info: l.info,
    warn: l.warn,
    error: l.error,
    fatal: l.fatal,
    child: (c) => bound(l.child(c)),
    flush,
    stats: () => l.stats(),
  });
  return { log: bound(createLogger({ transport })), flush, transport };
}

/** A capturing `after`: records tasks instead of running them. */
function fakeAfter() {
  const tasks: (() => Promise<void> | void)[] = [];
  const after: AfterScheduler = (task) => void tasks.push(task);
  return { after, tasks };
}

afterEach(() => vi.useRealTimers());

describe('withLogging (§6.2)', () => {
  it('preserves the function shape and passes a child logger first', async () => {
    const { wrap } = setup({ flushMode: 'none' });
    const wrapped = wrap(
      async (log, id: number, flag: boolean) => `${id}-${String(flag)}-${typeof log.info}`,
    );
    expectTypeOf(wrapped).toEqualTypeOf<(id: number, flag: boolean) => Promise<string>>();
    await expect(wrapped(42, true)).resolves.toBe('42-true-function');
    const sync = wrap((_log, n: number) => n * 2);
    expectTypeOf(sync).toEqualTypeOf<(n: number) => number>();
    expect(sync(21)).toBe(42);
  });

  it("Next's after is assignable to AfterScheduler", () => {
    type NextAfter = (task: (() => Promise<unknown>) | Promise<unknown> | (() => void)) => void;
    const nextAfter: NextAfter = () => {};
    const scheduler: AfterScheduler = nextAfter;
    expect(scheduler).toBe(nextAfter);
  });

  it('rethrows the identical error, sync and async, Error or not (done when)', async () => {
    const { wrap } = setup({ flushMode: 'none' });
    const err = new Error('boom');
    const asyncThrow = wrap(async () => {
      throw err;
    });
    await expect(asyncThrow()).rejects.toBe(err);
    try {
      await asyncThrow();
    } catch (caught) {
      expect(caught).toBe(err);
      expect((caught as Error).stack).toBe(err.stack);
    }
    const syncThrow = wrap(() => {
      throw err;
    });
    expect(() => syncThrow()).toThrow(err);
    const weird = wrap(async () => {
      throw 'a string';
    });
    await expect(weird()).rejects.toBe('a string');
  });

  it('logs start, completion with duration, and failure with the error', async () => {
    const { transport, wrap } = setup({ flushMode: 'sync' });
    await wrap(async () => 'ok')();
    await wrap(async () => {
      throw new RangeError('bad');
    })().catch(() => undefined);
    const events = transport.events.map((e) => [
      e.level,
      e.message,
      e.context.operation,
      typeof e.context.durationMs,
      e.error?.name,
    ]);
    expect(events).toEqual([
      ['debug', 'op started', 'op', 'undefined', undefined],
      ['info', 'op completed', 'op', 'number', undefined],
      ['debug', 'op started', 'op', 'undefined', undefined],
      ['error', 'op failed', 'op', 'number', 'RangeError'],
    ]);
    expect(transport.events.every((e) => typeof e.context.traceId === 'string')).toBe(true);
    expect(transport.lines()[1]).toMatch(
      /^\[\d\d:\d\d:\d\d INF\] [0-9a-f]{32}: _ op completed operation=op durationMs=\d+$/,
    );
  });

  it('schedules the flush through after() rather than awaiting it (done when)', async () => {
    const { after, tasks } = fakeAfter();
    const flush = vi.fn((_t?: number) => new Promise<void>(() => {})); // never resolves
    const { log } = loggerWithFlushSpy(flush);
    const wrapped = withLogging(log, 'op', async () => 'done', { after });
    await expect(wrapped()).resolves.toBe('done'); // did not wait for the flush
    expect(flush).not.toHaveBeenCalled();
    expect(tasks).toHaveLength(1);
    void tasks[0]!();
    expect(flush).toHaveBeenCalledExactlyOnceWith(1500);
  });

  it('passes the bound to the scheduled flush, defaulting to 1500', () => {
    const { log, flush } = loggerWithFlushSpy();
    const { after, tasks } = fakeAfter();
    withLogging(log, 'a', () => 1, { after })();
    withLogging(log, 'b', () => 1, { after, flushTimeoutMs: 250 })();
    withLogging(log, 'c', () => 1, { after, flushTimeoutMs: NaN })();
    for (const task of tasks) void task();
    expect(flush.mock.calls.map((c) => c[0])).toEqual([1500, 250, 1500]);
  });

  it('falls back to an inline flush when after() throws or is absent', async () => {
    const throwing: AfterScheduler = () => {
      throw new Error('after() called outside a request scope');
    };
    for (const options of [{ after: throwing }, {}] as WithLoggingOptions[]) {
      const transport = new MemoryTransport();
      const log = createLogger({ transport });
      const wrapped = withLogging(log, 'op', async () => 'x', options);
      await wrapped();
      // Delivered by the time the wrapper resolved: the flush was awaited inline.
      expect(transport.events.map((e) => e.message)).toEqual(['op completed']);
    }
  });

  it('flushMode sync awaits delivery before resolving or rejecting; none never flushes', async () => {
    const sync = setup({ flushMode: 'sync' });
    await sync.wrap(async () => 1)();
    expect(sync.transport.events.map((e) => e.message)).toContain('op completed');
    await sync
      .wrap(async () => {
        throw new Error('x');
      })()
      .catch(() => undefined);
    expect(sync.transport.events.map((e) => e.message)).toContain('op failed');

    const { log, flush } = loggerWithFlushSpy();
    await withLogging(log, 'op', async () => 1, { flushMode: 'none' })();
    expect(flush).not.toHaveBeenCalled();
  });

  it('inherits the trace from a Request-like first argument, never from a form field', async () => {
    const { transport, wrap } = setup({ flushMode: 'sync' });
    const header = `00-${TRACE}-00f067aa0ba902b7-01`;
    await wrap(async (_log, _req: { headers: Headers }) => 1)({
      headers: new Headers({ traceparent: header }),
    });
    await wrap(async (_log, _req: { headers: Record<string, string> }) => 1)({
      headers: { TraceParent: header },
    });
    await wrap(async (_log, _req: { headers: Record<string, string> }) => 1)({
      headers: { traceparent: 'garbage' },
    });
    const form = new FormData();
    form.set('traceparent', header);
    await wrap(async (_log, _form: FormData) => 1)(form);
    const ids = transport.events
      .filter((e) => e.message === 'op completed')
      .map((e) => e.context.traceId);
    expect(ids[0]).toBe(TRACE);
    expect(ids[1]).toBe(TRACE);
    expect(ids[2]).toMatch(/^[0-9a-f]{32}$/);
    expect(ids[2]).not.toBe(TRACE);
    expect(ids[3]).toMatch(/^[0-9a-f]{32}$/);
    expect(ids[3]).not.toBe(TRACE);
    expect(ids[2]).not.toBe(ids[3]);
  });

  it('an ambient trace (Node withTrace) wins over the generated bound id', async () => {
    const transport = new MemoryTransport();
    const log = createLogger({ transport, contextProvider: () => ({ traceId: 'ambient' }) });
    await withLogging(log, 'op', async () => 1, { flushMode: 'sync' })();
    expect(transport.events.every((e) => e.context.traceId === 'ambient')).toBe(true);
  });

  it("logs Next's control-flow throws as completed, with the digest, and rethrows them", async () => {
    const { transport, wrap } = setup({ flushMode: 'sync' });
    const redirect = Object.assign(new Error('NEXT_REDIRECT'), {
      digest: 'NEXT_REDIRECT;push;/x;307;',
    });
    await expect(
      wrap(async () => {
        throw redirect;
      })(),
    ).rejects.toBe(redirect);
    const bailout = Object.assign(new Error('bail'), { digest: 'DYNAMIC_SERVER_USAGE' });
    await expect(
      wrap(async () => {
        throw bailout;
      })(),
    ).rejects.toBe(bailout);
    const real = Object.assign(new Error('real'), { digest: 'abc123' });
    await expect(
      wrap(async () => {
        throw real;
      })(),
    ).rejects.toBe(real);
    const outcomes = transport.events
      .filter((e) => e.message !== 'op started')
      .map((e) => [e.level, e.context.digest]);
    expect(outcomes).toEqual([
      ['info', 'NEXT_REDIRECT;push;/x;307;'],
      ['info', 'DYNAMIC_SERVER_USAGE'],
      ['error', undefined],
    ]);
  });

  it('a broken logger never replaces the result or the error', async () => {
    const broken: Logger = {
      ...createLogger({ transport: new MemoryTransport() }),
      child: () => {
        throw new Error('child broke');
      },
    };
    // child() throwing happens before fn runs; the wrapper must still run fn.
    const safeChild: Logger = { ...createLogger({ transport: new MemoryTransport() }) };
    const throwingMethods: Logger = {
      ...safeChild,
      debug: () => {
        throw new Error('debug broke');
      },
      info: () => {
        throw new Error('info broke');
      },
      error: () => {
        throw new Error('error broke');
      },
      flush: () => Promise.reject(new Error('flush broke')),
    };
    safeChild.child = () => throwingMethods;
    await expect(withLogging(safeChild, 'op', async () => 'ok')()).resolves.toBe('ok');
    const err = new Error('mine');
    await expect(
      withLogging(safeChild, 'op', async () => {
        throw err;
      })(),
    ).rejects.toBe(err);
    expect(() => withLogging(broken, 'op', () => 1)).not.toThrow();
  });

  it('is bounded by flushTimeoutMs when the transport hangs (sync mode)', async () => {
    vi.useFakeTimers();
    const log = createLogger({
      transport: { send: () => new Promise(() => {}), flush: () => new Promise(() => {}) },
    });
    const wrapped = withLogging(log, 'op', async () => 1, {
      flushMode: 'sync',
      flushTimeoutMs: 100,
    });
    let resolved = false;
    void wrapped().then(() => (resolved = true));
    await vi.advanceTimersByTimeAsync(99);
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(resolved).toBe(true);
  });
});
