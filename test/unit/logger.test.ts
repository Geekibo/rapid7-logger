import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLogger } from '../../src/core/logger.js';
import type { LogEvent, Transport } from '../../src/core/types.js';

// A transport that records what it is given. The real MemoryTransport arrives in #10.
function recording(): Transport & { events: LogEvent[]; flushedWith: number[] } {
  const events: LogEvent[] = [];
  const flushedWith: number[] = [];
  return {
    events,
    flushedWith,
    send(event) {
      events.push(event);
      return Promise.resolve();
    },
    flush(timeoutMs) {
      flushedWith.push(timeoutMs ?? -1);
      return Promise.resolve();
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('level filtering', () => {
  it('drops events below the threshold and passes the rest', () => {
    const transport = recording();
    const log = createLogger({ transport, level: 'warn' });
    log.trace('t');
    log.debug('d');
    log.info('i');
    log.warn('w');
    log.error('e');
    log.fatal('f');
    expect(transport.events.map((e) => e.level)).toEqual(['warn', 'error', 'fatal']);
  });

  it('defaults to info and accepts the loose string form', () => {
    const transport = recording();
    createLogger({ transport }).debug('hidden');
    createLogger({ transport }).info('shown');
    createLogger({ transport, level: 'DEBUG' }).debug('shown too');
    expect(transport.events.map((e) => e.message)).toEqual(['shown', 'shown too']);
  });
});

describe('event shape', () => {
  it('stamps a current Date, an empty context and no error key by default', () => {
    const transport = recording();
    createLogger({ transport }).info('hello');
    const [event] = transport.events;
    expect(event?.timestamp).toBeInstanceOf(Date);
    expect(Math.abs(Date.now() - (event?.timestamp.getTime() ?? 0))).toBeLessThan(1000);
    expect(event?.context).toEqual({});
    expect(event).not.toHaveProperty('error');
  });
});

describe('context merging', () => {
  it('stamps service and env on every event', () => {
    const transport = recording();
    createLogger({ transport, service: 'svc', env: 'test' }).info('x');
    expect(transport.events[0]?.context).toEqual({ service: 'svc', env: 'test' });
  });

  it('merges root → child → grandchild → call, later wins', () => {
    const transport = recording();
    const root = createLogger({ transport, service: 'svc' });
    const child = root.child({ traceId: 't1', userId: 'u1' });
    const grandchild = child.child({ userId: 'u2' });
    grandchild.info('x', { userId: 'u3', extra: true });
    expect(transport.events[0]?.context).toEqual({
      service: 'svc',
      traceId: 't1',
      userId: 'u3',
      extra: true,
    });
  });

  it('does not alter the parent or the caller object', () => {
    const transport = recording();
    const root = createLogger({ transport });
    root.child({ traceId: 't1' });
    const ctx = { a: 1 };
    root.info('x', ctx);
    expect(transport.events[0]?.context).toEqual({ a: 1 });
    expect(transport.events[0]?.context).not.toBe(ctx);
    expect(ctx).toEqual({ a: 1 });
  });
});

describe('the Error argument', () => {
  it('normalises an Error to name, message and stack', () => {
    const transport = recording();
    const err = new RangeError('boom');
    createLogger({ transport }).error('failed', err);
    expect(transport.events[0]?.error).toEqual({
      name: 'RangeError',
      message: 'boom',
      stack: err.stack,
    });
  });

  it('copies a Next.js digest when present', () => {
    const transport = recording();
    const err = Object.assign(new Error('x'), { digest: 'abc123' });
    createLogger({ transport }).error('failed', err);
    expect(transport.events[0]?.error?.digest).toBe('abc123');
  });

  it('takes both an error and context', () => {
    const transport = recording();
    createLogger({ transport }).error('failed', new Error('x'), { surveyId: 42 });
    expect(transport.events[0]?.error?.message).toBe('x');
    expect(transport.events[0]?.context).toEqual({ surveyId: 42 });
  });

  it('treats a plain object second argument as context, and an error-like one as the error', () => {
    const transport = recording();
    const log = createLogger({ transport });
    log.error('a', { code: 500 });
    log.error('b', { name: 'HttpError', message: 'nope' });
    log.error('c', { message: 'has a stack', stack: 'Error: has a stack\n  at x' });
    expect(transport.events[0]?.context).toEqual({ code: 500 });
    expect(transport.events[0]).not.toHaveProperty('error');
    expect(transport.events[1]?.error).toEqual({ name: 'HttpError', message: 'nope' });
    expect(transport.events[2]?.error).toMatchObject({ name: 'Error', message: 'has a stack' });
  });

  it('with three arguments, anything in the second slot is the error', () => {
    const transport = recording();
    createLogger({ transport }).error('failed', 'just a string', { id: 1 });
    expect(transport.events[0]?.error).toEqual({ name: 'Error', message: 'just a string' });
    expect(transport.events[0]?.context).toEqual({ id: 1 });
  });
});

describe('a transport that breaks its contract', () => {
  it('a send that throws does not reach the caller; it is counted and reported', () => {
    const onInternalError = vi.fn();
    const log = createLogger({
      onInternalError,
      transport: {
        send: () => {
          throw new Error('kaboom');
        },
        flush: () => Promise.resolve(),
      },
    });
    expect(() => log.info('x')).not.toThrow();
    expect(log.stats()).toMatchObject({ failed: 1, lastError: 'kaboom' });
    expect(onInternalError).toHaveBeenCalledOnce();
    expect(onInternalError.mock.calls[0]?.[0]).toBeInstanceOf(Error);
    expect((onInternalError.mock.calls[0]?.[0] as Error).cause).toBeInstanceOf(Error);
  });

  it('a send that rejects is counted and reported too', async () => {
    const onInternalError = vi.fn();
    const log = createLogger({
      onInternalError,
      transport: { send: () => Promise.reject(new Error('later')), flush: () => Promise.resolve() },
    });
    log.info('x');
    await Promise.resolve();
    await Promise.resolve();
    expect(log.stats()).toMatchObject({ failed: 1, lastError: 'later' });
    expect(onInternalError).toHaveBeenCalledOnce();
  });
});

describe('stats', () => {
  it('starts at zero, returns a copy, and is shared across the child tree', () => {
    const log = createLogger({
      transport: {
        send: () => {
          throw new Error('x');
        },
        flush: () => Promise.resolve(),
      },
      onInternalError: () => {},
    });
    expect(log.stats()).toEqual({ queued: 0, sent: 0, dropped: 0, failed: 0, retried: 0 });
    const snapshot = log.stats();
    log.child({ a: 1 }).warn('x');
    expect(snapshot.failed).toBe(0);
    expect(log.stats().failed).toBe(1);
  });
});

describe('flush', () => {
  it('passes the timeout through and defaults to 2000', async () => {
    const transport = recording();
    const log = createLogger({ transport });
    await log.flush(500);
    await log.flush();
    expect(transport.flushedWith).toEqual([500, 2000]);
  });

  it('is bounded even when the transport never resolves (invariant 4)', async () => {
    vi.useFakeTimers();
    const log = createLogger({
      transport: { send: () => Promise.resolve(), flush: () => new Promise(() => {}) },
    });
    let resolved = false;
    void log.flush(100).then(() => (resolved = true));
    await vi.advanceTimersByTimeAsync(99);
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(resolved).toBe(true);
  });

  it('never rejects, whether the transport rejects or throws', async () => {
    const quiet = { onInternalError: () => {} };
    await expect(
      createLogger({
        ...quiet,
        transport: { send: () => Promise.resolve(), flush: () => Promise.reject(new Error('x')) },
      }).flush(50),
    ).resolves.toBeUndefined();
    await expect(
      createLogger({
        ...quiet,
        transport: {
          send: () => Promise.resolve(),
          flush: () => {
            throw new Error('x');
          },
        },
      }).flush(50),
    ).resolves.toBeUndefined();
  });
});
