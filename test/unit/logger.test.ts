import { afterEach, describe, expect, it, vi } from 'vitest';
import { composeLogger, createLogger } from '../../src/core/logger.js';
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

// Delivery is a microtask away (the queue starts a pass on the next microtask, §7.2).
const drain = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('level filtering', () => {
  it('drops events below the threshold and passes the rest', async () => {
    const transport = recording();
    const log = createLogger({ transport, level: 'warn' });
    log.trace('t');
    log.debug('d');
    log.info('i');
    log.warn('w');
    log.error('e');
    log.fatal('f');
    await drain();
    expect(transport.events.map((e) => e.level)).toEqual(['warn', 'error', 'fatal']);
  });

  it('defaults to info and accepts the loose string form', async () => {
    const transport = recording();
    createLogger({ transport }).debug('hidden');
    createLogger({ transport }).info('shown');
    createLogger({ transport, level: 'DEBUG' }).debug('shown too');
    await drain();
    expect(transport.events.map((e) => e.message)).toEqual(['shown', 'shown too']);
  });
});

describe('event shape', () => {
  it('stamps a current Date, an empty context and no error key by default', async () => {
    const transport = recording();
    createLogger({ transport }).info('hello');
    await drain();
    const [event] = transport.events;
    expect(event?.timestamp).toBeInstanceOf(Date);
    expect(Math.abs(Date.now() - (event?.timestamp.getTime() ?? 0))).toBeLessThan(1000);
    expect(event?.context).toEqual({});
    expect(event).not.toHaveProperty('error');
  });
});

describe('context merging', () => {
  it('stamps service and env on every event', async () => {
    const transport = recording();
    createLogger({ transport, service: 'svc', env: 'test' }).info('x');
    await drain();
    expect(transport.events[0]?.context).toEqual({ service: 'svc', env: 'test' });
  });

  it('merges root → child → grandchild → call, later wins', async () => {
    const transport = recording();
    const root = createLogger({ transport, service: 'svc' });
    const child = root.child({ traceId: 't1', userId: 'u1' });
    const grandchild = child.child({ userId: 'u2' });
    grandchild.info('x', { userId: 'u3', extra: true });
    await drain();
    expect(transport.events[0]?.context).toEqual({
      service: 'svc',
      traceId: 't1',
      userId: 'u3',
      extra: true,
    });
  });

  it('does not alter the parent or the caller object', async () => {
    const transport = recording();
    const root = createLogger({ transport });
    root.child({ traceId: 't1' });
    const ctx = { a: 1 };
    root.info('x', ctx);
    await drain();
    expect(transport.events[0]?.context).toEqual({ a: 1 });
    await drain();
    expect(transport.events[0]?.context).not.toBe(ctx);
    expect(ctx).toEqual({ a: 1 });
  });
});

describe('the Error argument', () => {
  it('normalises an Error to name, message and stack', async () => {
    const transport = recording();
    const err = new RangeError('boom');
    createLogger({ transport }).error('failed', err);
    await drain();
    expect(transport.events[0]?.error).toEqual({
      name: 'RangeError',
      message: 'boom',
      stack: err.stack,
    });
  });

  it('copies a Next.js digest when present', async () => {
    const transport = recording();
    const err = Object.assign(new Error('x'), { digest: 'abc123' });
    createLogger({ transport }).error('failed', err);
    await drain();
    expect(transport.events[0]?.error?.digest).toBe('abc123');
  });

  it('takes both an error and context', async () => {
    const transport = recording();
    createLogger({ transport }).error('failed', new Error('x'), { surveyId: 42 });
    await drain();
    expect(transport.events[0]?.error?.message).toBe('x');
    await drain();
    expect(transport.events[0]?.context).toEqual({ surveyId: 42 });
  });

  it('treats a plain object second argument as context, and an error-like one as the error', async () => {
    const transport = recording();
    const log = createLogger({ transport });
    log.error('a', { code: 500 });
    log.error('b', { name: 'HttpError', message: 'nope' });
    log.error('c', { message: 'has a stack', stack: 'Error: has a stack\n  at x' });
    await drain();
    expect(transport.events[0]?.context).toEqual({ code: 500 });
    await drain();
    expect(transport.events[0]).not.toHaveProperty('error');
    await drain();
    expect(transport.events[1]?.error).toEqual({ name: 'HttpError', message: 'nope' });
    await drain();
    expect(transport.events[2]?.error).toMatchObject({ name: 'Error', message: 'has a stack' });
  });

  it('with three arguments, anything in the second slot is the error', async () => {
    const transport = recording();
    createLogger({ transport }).error('failed', 'just a string', { id: 1 });
    await drain();
    expect(transport.events[0]?.error).toEqual({ name: 'Error', message: 'just a string' });
    await drain();
    expect(transport.events[0]?.context).toEqual({ id: 1 });
  });
});

describe('a transport that breaks its contract', () => {
  it('a send that throws does not reach the caller; it is counted and reported', async () => {
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
    await drain();
    expect(log.stats()).toMatchObject({ failed: 1, lastError: 'kaboom' });
    await drain();
    expect(onInternalError).toHaveBeenCalledOnce();
    await drain();
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
  it('starts at zero, returns a copy, and is shared across the child tree', async () => {
    const log = createLogger({
      transport: {
        send: () => {
          throw new Error('x');
        },
        flush: () => Promise.resolve(),
      },
      onInternalError: () => {},
    });
    await drain();
    expect(log.stats()).toEqual({ queued: 0, sent: 0, dropped: 0, failed: 0, retried: 0 });
    const snapshot = log.stats();
    log.child({ a: 1 }).warn('x');
    expect(snapshot.failed).toBe(0);
    await drain();
    expect(log.stats().failed).toBe(1);
  });
});

describe('flush', () => {
  it('passes the timeout through and defaults to 2000', async () => {
    vi.useFakeTimers();
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

describe('redaction in the pipeline (§6.6)', () => {
  it('is on by default and covers bound and per-call context, keeping traceId', async () => {
    const transport = recording();
    const log = createLogger({ transport, service: 'svc' }).child({ traceId: 't', token: 'bound' });
    log.info('Bearer abc.def', { password: 'p', nested: { apiKey: 'k' } });
    await drain();
    expect(transport.events[0]?.message).toBe('Bearer [redacted]');
    await drain();
    expect(transport.events[0]?.context).toEqual({
      service: 'svc',
      traceId: 't',
      token: '[redacted]',
      password: '[redacted]',
      nested: { apiKey: '[redacted]' },
    });
  });

  it('redacts the positional error and can be disabled or extended', async () => {
    const transport = recording();
    createLogger({ transport }).error('x', new Error('Basic dXNlcg=='));
    createLogger({ transport, redact: false }).info('x', { password: 'kept' });
    createLogger({ transport, redact: { keys: ['email'], replacement: '***' } }).info('x', {
      email: 'e',
      password: 'p',
    });
    await drain();
    expect(transport.events[0]?.error?.message).toBe('Basic [redacted]');
    await drain();
    expect(transport.events[1]?.context).toEqual({ password: 'kept' });
    await drain();
    expect(transport.events[2]?.context).toEqual({ email: '***', password: '***' });
  });

  it('does not throw for junk redact options', async () => {
    const transport = recording();
    expect(() =>
      createLogger({ transport, redact: { keys: 'nope' as unknown as string[] } }).info('x'),
    ).not.toThrow();
    await drain();
    expect(transport.events).toHaveLength(1);
  });
});

describe('the queue in the pipeline (§7.2)', () => {
  it('counts a resolved send as sent and exposes queued as a gauge', async () => {
    const transport = recording();
    const log = createLogger({ transport });
    log.info('a');
    expect(log.stats().queued).toBe(1);
    await log.flush();
    expect(log.stats()).toMatchObject({ queued: 0, sent: 1, failed: 0 });
  });

  it('composeLogger lets an entry point substitute the dispatcher', () => {
    const seen: string[] = [];
    const log = composeLogger({ transport: recording() }, ({ transport }) => ({
      enqueue: (event) => {
        seen.push(event.message);
        void transport.send(event);
      },
      flush: () => Promise.resolve(),
      size: () => 0,
    }));
    log.info('direct');
    expect(seen).toEqual(['direct']);
  });
});

describe('contextProvider (§6.4)', () => {
  it('merges per-call > ambient > bound, and children inherit it', async () => {
    const transport = recording();
    const log = createLogger({
      transport,
      contextProvider: () => ({ traceId: 'ambient', a: 'amb' }),
    });
    const child = log.child({ traceId: 'bound', b: 'bound' });
    child.info('x', { a: 'call' });
    await drain();
    expect(transport.events[0]?.context).toEqual({ traceId: 'ambient', a: 'call', b: 'bound' });
  });

  it('a throwing or non-object provider is tolerated: the event ships without ambient keys', async () => {
    const onInternalError = vi.fn();
    const transport = recording();
    const log = createLogger({
      transport,
      onInternalError,
      contextProvider: () => {
        throw new Error('provider broke');
      },
    });
    expect(() => log.info('x', { a: 1 })).not.toThrow();
    createLogger({ transport, contextProvider: () => 'nope' as unknown as undefined }).info('y');
    await drain();
    expect(transport.events[0]?.context).toEqual({ a: 1 });
    expect(transport.events[1]?.context).toEqual({});
    expect(onInternalError).toHaveBeenCalledOnce();
    expect(log.stats().failed).toBe(0);
  });

  it('is not consulted below the threshold', () => {
    const provider = vi.fn(() => ({}));
    createLogger({ transport: recording(), contextProvider: provider, level: 'warn' }).info(
      'hidden',
    );
    expect(provider).not.toHaveBeenCalled();
  });
});
