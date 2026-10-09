import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { createLogger } from '../../src/core/logger.js';

const GUID = '12345678-abcd-4ef0-9876-0123456789ab';

// The console is both the fallback transport and the default warning channel, so every test
// here spies on it.
type ConsoleSpy = MockInstance<typeof console.warn>;
let warn: ConsoleSpy;
let info: ConsoleSpy;
let error: ConsoleSpy;
let debug: ConsoleSpy;

beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  info = vi.spyOn(console, 'info').mockImplementation(() => {});
  error = vi.spyOn(console, 'error').mockImplementation(() => {});
  debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('a missing token (§5.1)', () => {
  it('does not throw, warns exactly once, and logs to the console', () => {
    const log = createLogger();
    createLogger(undefined);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0]?.[0]).toMatch(/no token/);
    log.info('hello');
    expect(info).toHaveBeenCalledOnce();
    expect(info.mock.calls[0]?.[0]).toMatch(/^\[\d\d:\d\d:\d\d INF\] hello$/);
  });

  it('treats an empty or whitespace token as missing', () => {
    createLogger({ token: '' });
    createLogger({ token: '  ' });
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls.every((c) => /no token/.test(String(c[0])))).toBe(true);
  });
});

describe('an invalid configuration', () => {
  it('warns once about a malformed token without echoing it, and still logs', () => {
    const log = createLogger({ token: 'hunter2-not-a-guid' });
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toMatch(/GUID/);
    expect(warn.mock.calls[0]?.[0]).not.toContain('hunter2');
    log.error('x');
    expect(error).toHaveBeenCalledOnce();
  });

  it('warns once about an unknown region and falls back to the console', () => {
    createLogger({ token: GUID, region: 'mars' }).warn('x');
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0]?.[0]).toMatch(/region "mars"/);
  });

  it('warns once about an unknown level and uses info', () => {
    const log = createLogger({ token: GUID, level: 'loud' });
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toMatch(/level "loud"/);
    log.debug('hidden');
    log.info('shown');
    expect(debug).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledOnce();
  });
});

describe('a valid configuration', () => {
  it('does not warn (region defaults to eu)', () => {
    createLogger({ token: GUID });
    createLogger({ token: GUID, region: 'US' });
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('onInternalError', () => {
  it('replaces the console warning', () => {
    const onInternalError = vi.fn();
    createLogger({ onInternalError });
    expect(onInternalError).toHaveBeenCalledOnce();
    expect(onInternalError.mock.calls[0]?.[0]).toBeInstanceOf(Error);
    expect(warn).not.toHaveBeenCalled();
  });

  it('a throwing handler breaks nothing', () => {
    const log = createLogger({
      onInternalError: () => {
        throw new Error('handler broke');
      },
      transport: {
        send: () => {
          throw new Error('send broke');
        },
        flush: () => Promise.resolve(),
      },
    });
    expect(() => log.info('x')).not.toThrow();
  });

  it('the default warning is rate-limited to one per minute per logger', () => {
    vi.useFakeTimers();
    const log = createLogger({
      transport: {
        send: () => {
          throw new Error('x');
        },
        flush: () => Promise.resolve(),
      },
    });
    log.info('1');
    log.info('2');
    expect(warn).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(60_000);
    log.info('3');
    expect(warn).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });
});

describe('an explicit transport', () => {
  it('bypasses token validation and receives the events', () => {
    const send = vi.fn(() => Promise.resolve());
    createLogger({ transport: { send, flush: () => Promise.resolve() }, token: 'garbage' }).info(
      'x',
    );
    expect(warn).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledOnce();
  });
});

describe('the console fallback', () => {
  it('routes by level and passes context and the error as extra arguments', () => {
    const log = createLogger({ onInternalError: () => {} });
    log.trace('t');
    log.debug('d');
    log.info('i', { a: 1 });
    log.warn('w');
    log.error('e', new Error('boom'));
    log.fatal('f');
    expect(debug).toHaveBeenCalledTimes(0); // trace and debug are below the default threshold
    expect(info).toHaveBeenCalledOnce();
    expect(info.mock.calls[0]?.[1]).toEqual({ a: 1 });
    expect(warn).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledTimes(2);
    expect(error.mock.calls[0]?.[1]).toMatchObject({ name: 'Error', message: 'boom' });
  });

  it('survives a console method that throws', () => {
    info.mockImplementation(() => {
      throw new Error('console is broken');
    });
    const log = createLogger({ onInternalError: () => {} });
    expect(() => log.info('x')).not.toThrow();
    expect(log.stats().failed).toBe(0);
  });

  it('flushes immediately', async () => {
    await expect(createLogger({ onInternalError: () => {} }).flush(10)).resolves.toBeUndefined();
  });
});

describe('redaction reaches the console fallback', () => {
  it('prints [redacted], never the secret', () => {
    createLogger({ onInternalError: () => {} }).info('login', { password: 'hunter2' });
    expect(info.mock.calls[0]?.[1]).toEqual({ password: '[redacted]' });
    expect(JSON.stringify(info.mock.calls)).not.toContain('hunter2');
  });
});
