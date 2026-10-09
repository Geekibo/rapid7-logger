import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatEvent } from '../../src/core/formatter.js';
import { createLogger } from '../../src/core/logger.js';
import type { LogEvent } from '../../src/core/types.js';
import {
  DEFAULT_REQUEST_TIMEOUT_MS,
  Rapid7WebhookTransport,
} from '../../src/transports/rapid7-webhook.js';

// Shape-valid and deliberately not a real token: the endpoint accepts any GUID (§2.6). It is a
// sentinel, so every failure mode can assert it never leaks (invariant 9).
const TOKEN = 'deadbeef-dead-4bad-8bad-feedfacecafe';
const AT = new Date('2026-10-08T14:22:07.123Z');
const ev = (overrides: Partial<LogEvent> = {}): LogEvent => ({
  timestamp: AT,
  level: 'info',
  message: 'hello',
  context: {},
  ...overrides,
});

type Call = { url: string; init: RequestInit };

/** A fake fetch that records the call and answers with `status`. */
function fakeFetch(status = 204, body = '') {
  const calls: Call[] = [];
  const fn = vi.fn((url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: url instanceof Request ? url.url : String(url), init: init ?? {} });
    // A 204 may not carry a body, not even an empty string.
    return Promise.resolve(new Response(body === '' ? null : body, { status }));
  });
  return { fn: fn as unknown as typeof fetch, calls };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('the request (§2.1)', () => {
  it('posts one event per request, text/plain, body = formatted line + \\n', async () => {
    const { fn, calls } = fakeFetch();
    const transport = new Rapid7WebhookTransport({ token: TOKEN, maxAttempts: 1, fetch: fn });
    const event = ev({ context: { traceId: 'abc', a: 1 } });
    await expect(transport.send(event)).resolves.toEqual({ delivered: true, retries: 0 });
    expect(calls).toHaveLength(1);
    const { url, init } = calls[0] as Call;
    expect(url).toBe(`https://eu.webhook.logs.insight.rapid7.com/v1/noformat/${TOKEN}`);
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({
      'content-type': 'text/plain',
      'user-agent': '@geekibo/rapid7-logger',
    });
    expect(init.body).toBe(`${formatEvent(event)}\n`);
    expect(init.body).toBe('[14:22:07 INF] abc: _ hello a=1\n');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it.each(['eu', 'us', 'au', 'ca', 'jp'])('targets the %s subdomain', async (region) => {
    const { fn, calls } = fakeFetch();
    await new Rapid7WebhookTransport({ token: TOKEN, maxAttempts: 1, region, fetch: fn }).send(
      ev(),
    );
    expect(calls[0]?.url.startsWith(`https://${region}.webhook.`)).toBe(true);
  });

  it('normalises the region and defaults to eu', async () => {
    const { fn, calls } = fakeFetch();
    await new Rapid7WebhookTransport({
      token: TOKEN,
      maxAttempts: 1,
      region: ' US ',
      fetch: fn,
    }).send(ev());
    await new Rapid7WebhookTransport({ token: TOKEN, maxAttempts: 1, fetch: fn }).send(ev());
    expect(calls.map((c) => c.url.slice(8, 10))).toEqual(['us', 'eu']);
  });

  it('never puts an interior newline in the body, and exactly one at the end (invariant 2)', async () => {
    const { fn, calls } = fakeFetch();
    const transport = new Rapid7WebhookTransport({ token: TOKEN, maxAttempts: 1, fetch: fn });
    await transport.send(
      ev({
        message: 'line1\nline2\r\nline3',
        context: { k: 'v\nw' },
        error: { name: 'Error', message: 'x', stack: 'Error: x\n    at a\n    at b' },
      }),
    );
    const body = calls[0]?.init.body as string;
    expect(body.endsWith('\n')).toBe(true);
    expect(body.slice(0, -1)).not.toMatch(/[\r\n]/);
  });

  it('relies on the formatter cap and does not re-truncate', async () => {
    const { fn, calls } = fakeFetch();
    await new Rapid7WebhookTransport({ token: TOKEN, maxAttempts: 1, fetch: fn }).send(
      ev({ message: 'x'.repeat(100_000) }),
    );
    const body = calls[0]?.init.body as string;
    expect(new TextEncoder().encode(body).length).toBeLessThanOrEqual(32_768);
    expect(body).toMatch(/ … \[truncated \d+ of \d+ bytes\]\n$/);
  });

  it('honours format and maxBytes', async () => {
    const { fn, calls } = fakeFetch();
    await new Rapid7WebhookTransport({
      token: TOKEN,
      maxAttempts: 1,
      fetch: fn,
      format: (e) => `custom ${e.message}`,
      maxBytes: 128,
    }).send(ev({ message: 'm'.repeat(500) }));
    const body = calls[0]?.init.body as string;
    expect(body.startsWith('custom mmm')).toBe(true);
    expect(new TextEncoder().encode(body).length).toBeLessThanOrEqual(129);
  });
});

describe('outcomes (single attempt; the retry policy is tested separately)', () => {
  it.each([200, 204])('treats %i as delivered', async (status) => {
    const { fn } = fakeFetch(status);
    await expect(
      new Rapid7WebhookTransport({ token: TOKEN, maxAttempts: 1, fetch: fn }).send(ev()),
    ).resolves.toEqual({
      delivered: true,
      retries: 0,
    });
  });

  it.each([401, 404, 413, 429, 500])('reports HTTP %i as not delivered', async (status) => {
    const { fn } = fakeFetch(status, 'some body');
    await expect(
      new Rapid7WebhookTransport({ token: TOKEN, maxAttempts: 1, fetch: fn }).send(ev()),
    ).resolves.toEqual({
      delivered: false,
      retries: 0,
      error: `HTTP ${status}`,
    });
  });

  it('drains the response body so the connection can be reused', async () => {
    const response = new Response('error details', { status: 500 });
    const fn = (() => Promise.resolve(response)) as unknown as typeof fetch;
    await new Rapid7WebhookTransport({ token: TOKEN, maxAttempts: 1, fetch: fn }).send(ev());
    expect(response.bodyUsed).toBe(true);
  });

  it('reports an undici-shaped network failure by its cause code', async () => {
    const fn = (() =>
      Promise.reject(
        Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }),
      )) as unknown as typeof fetch;
    await expect(
      new Rapid7WebhookTransport({ token: TOKEN, maxAttempts: 1, fetch: fn }).send(ev()),
    ).resolves.toEqual({
      delivered: false,
      retries: 0,
      error: 'ENOTFOUND',
    });
  });

  it('never throws or rejects: sync throw, missing fetch, malformed response, throwing text()', async () => {
    const throwing = (() => {
      throw new Error('sync boom');
    }) as unknown as typeof fetch;
    await expect(
      new Rapid7WebhookTransport({ token: TOKEN, maxAttempts: 1, fetch: throwing }).send(ev()),
    ).resolves.toEqual({
      delivered: false,
      retries: 0,
      error: 'Error: sync boom',
    });

    vi.stubGlobal('fetch', undefined);
    await expect(
      new Rapid7WebhookTransport({ token: TOKEN, maxAttempts: 1 }).send(ev()),
    ).resolves.toMatchObject({
      delivered: false,
      retries: 0,
      error: expect.stringMatching(/fetch is not available/) as string,
    });

    const malformed = (() => Promise.resolve({} as Response)) as unknown as typeof fetch;
    await expect(
      new Rapid7WebhookTransport({ token: TOKEN, maxAttempts: 1, fetch: malformed }).send(ev()),
    ).resolves.toMatchObject({
      delivered: false,
    });

    const badText = (() =>
      Promise.resolve({
        status: 204,
        text: () => Promise.reject(new Error('no body')),
      } as unknown as Response)) as unknown as typeof fetch;
    await expect(
      new Rapid7WebhookTransport({ token: TOKEN, maxAttempts: 1, fetch: badText }).send(ev()),
    ).resolves.toEqual({
      delivered: true,
      retries: 0,
    });
  });

  it('uses the global fetch when none is injected', async () => {
    const { fn, calls } = fakeFetch();
    vi.stubGlobal('fetch', fn);
    await new Rapid7WebhookTransport({ token: TOKEN, maxAttempts: 1 }).send(ev());
    expect(calls).toHaveLength(1);
  });

  it('flushes immediately', async () => {
    await expect(
      new Rapid7WebhookTransport({ token: TOKEN, maxAttempts: 1, fetch: fakeFetch().fn }).flush(10),
    ).resolves.toBeUndefined();
  });
});

describe('the timeout', () => {
  function hanging() {
    let signal: AbortSignal | undefined;
    const fn = ((_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        signal = init?.signal ?? undefined;
        signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      })) as unknown as typeof fetch;
    return { fn, signal: () => signal };
  }

  it('aborts after 10 s by default', async () => {
    vi.useFakeTimers();
    const { fn, signal } = hanging();
    const pending = new Rapid7WebhookTransport({ token: TOKEN, maxAttempts: 1, fetch: fn }).send(
      ev(),
    );
    await vi.advanceTimersByTimeAsync(DEFAULT_REQUEST_TIMEOUT_MS - 1);
    expect(signal()?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(signal()?.aborted).toBe(true);
    await expect(pending).resolves.toEqual({
      delivered: false,
      retries: 0,
      error: 'timeout after 10000ms',
    });
  });

  it('honours timeoutMs and leaves no timer behind after a successful send', async () => {
    vi.useFakeTimers();
    const { fn, signal } = hanging();
    const pending = new Rapid7WebhookTransport({
      token: TOKEN,
      maxAttempts: 1,
      fetch: fn,
      timeoutMs: 250,
    }).send(ev());
    await vi.advanceTimersByTimeAsync(250);
    expect(signal()?.aborted).toBe(true);
    await expect(pending).resolves.toEqual({
      delivered: false,
      retries: 0,
      error: 'timeout after 250ms',
    });

    await new Rapid7WebhookTransport({ token: TOKEN, maxAttempts: 1, fetch: fakeFetch().fn }).send(
      ev(),
    );
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('the credential never leaks (invariant 9)', () => {
  it('rejects an invalid token or region at construction without echoing them', () => {
    expect(() => new Rapid7WebhookTransport({ token: 'hunter2-not-a-guid' })).toThrow(TypeError);
    expect(() => new Rapid7WebhookTransport({ token: 'hunter2-not-a-guid' })).toThrow(/GUID/);
    expect(() => new Rapid7WebhookTransport({ token: 'hunter2-not-a-guid' })).not.toThrow(
      /hunter2/,
    );
    expect(
      () => new Rapid7WebhookTransport({ token: TOKEN, maxAttempts: 1, region: 'mars' }),
    ).toThrow(/region "mars"/);
  });

  it('does not appear in any outcome, even when fetch puts the URL in its error', async () => {
    const leaky = ((url: string) =>
      Promise.reject(new Error(`request to ${url} failed`))) as unknown as typeof fetch;
    const outcome = await new Rapid7WebhookTransport({
      token: TOKEN,
      maxAttempts: 1,
      fetch: leaky,
    }).send(ev());
    expect(JSON.stringify(outcome)).not.toContain(TOKEN);
    expect(outcome.error).toContain('<token>');
  });

  it('is not reachable through enumeration or serialisation', () => {
    const transport = new Rapid7WebhookTransport({
      token: TOKEN,
      maxAttempts: 1,
      fetch: fakeFetch().fn,
    });
    expect(JSON.stringify(transport)).not.toContain(TOKEN);
    expect(Object.keys(transport)).toEqual([]);
    expect(Object.getOwnPropertyNames(transport)).toEqual([]);
  });
});

describe('through createLogger', () => {
  it('a valid token posts the formatted line with no warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const { fn, calls } = fakeFetch();
    const log = createLogger({ token: TOKEN, region: 'US', service: 'svc', fetch: fn });
    log.info('posted', { a: 1 });
    await log.flush(1000);
    expect(calls[0]?.url.startsWith('https://us.webhook.')).toBe(true);
    expect(calls[0]?.init.body).toMatch(/^\[\d\d:\d\d:\d\d INF\] posted service=svc a=1\n$/);
    expect(warn).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
    expect(log.stats()).toMatchObject({ sent: 1, failed: 0 });
  });

  it('a failed post is counted and reported', async () => {
    const onInternalError = vi.fn();
    const log = createLogger({ token: TOKEN, fetch: fakeFetch(500).fn, onInternalError });
    log.error('x');
    await log.flush(1000);
    expect(log.stats()).toMatchObject({ sent: 0, failed: 1, lastError: 'HTTP 500' });
    expect(onInternalError).toHaveBeenCalledOnce();
    expect(JSON.stringify(onInternalError.mock.calls)).not.toContain(TOKEN);
  });

  it('fetch is ignored when a transport is given', async () => {
    const { fn, calls } = fakeFetch();
    const events: LogEvent[] = [];
    const log = createLogger({
      token: TOKEN,
      fetch: fn,
      transport: {
        send: (e) => {
          events.push(e);
          return Promise.resolve();
        },
        flush: () => Promise.resolve(),
      },
    });
    log.info('x');
    await log.flush(1000);
    expect(calls).toHaveLength(0);
    expect(events).toHaveLength(1);
  });
});
