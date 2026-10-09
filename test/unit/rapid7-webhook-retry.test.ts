import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLogger } from '../../src/core/logger.js';
import type { LogEvent } from '../../src/core/types.js';
import {
  parseRetryAfter,
  Rapid7WebhookTransport,
  type Rapid7WebhookTransportOptions,
} from '../../src/transports/rapid7-webhook.js';

const TOKEN = 'deadbeef-dead-4bad-8bad-feedfacecafe';
const ev: LogEvent = { timestamp: new Date(0), level: 'error', message: 'x', context: {} };

type Step = number | { status: number; headers?: Record<string, string> } | Error | 'hang';

/** A fetch scripted per call: a status, a status with headers, an Error to reject with, or a hang. */
function scripted(steps: Step[]) {
  const times: number[] = [];
  let signal: AbortSignal | undefined;
  const fn = vi.fn((_url: string, init?: RequestInit) => {
    times.push(Date.now());
    const step = steps.shift();
    if (step === undefined) throw new Error('script exhausted');
    if (step instanceof Error) return Promise.reject(step);
    if (step === 'hang') {
      signal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    }
    const { status, headers } =
      typeof step === 'number' ? { status: step, headers: undefined } : step;
    return Promise.resolve(new Response(status === 204 ? null : 'body', { status, headers }));
  });
  return { fn: fn as unknown as typeof fetch, calls: fn, times };
}

function make(steps: Step[], options: Partial<Rapid7WebhookTransportOptions> = {}) {
  const script = scripted(steps);
  const transport = new Rapid7WebhookTransport({ token: TOKEN, fetch: script.fn, ...options });
  return { transport, ...script };
}

/** Run a send to completion under fake timers, advancing through every backoff. */
async function run(transport: Rapid7WebhookTransport) {
  const pending = transport.send(ev);
  await vi.runAllTimersAsync();
  return pending;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('the retry policy (§7.1, done when)', () => {
  it('500 then 204: delivered after one retry, 200 ms apart', async () => {
    const { transport, calls, times } = make([500, 204]);
    await expect(run(transport)).resolves.toEqual({ delivered: true, retries: 1 });
    expect(calls).toHaveBeenCalledTimes(2);
    expect((times[1] ?? 0) - (times[0] ?? 0)).toBe(200);
  });

  it('401: not retried', async () => {
    const { transport, calls } = make([401]);
    await expect(run(transport)).resolves.toEqual({
      delivered: false,
      retries: 0,
      error: 'HTTP 401',
    });
    expect(calls).toHaveBeenCalledTimes(1);
  });

  it('network throw then success: delivered after one retry', async () => {
    const { transport } = make([
      Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }),
      204,
    ]);
    await expect(run(transport)).resolves.toEqual({ delivered: true, retries: 1 });
  });

  it('three failures: dropped, retries 2, the last error reported, backoff 200 then 400', async () => {
    const { transport, calls, times } = make([500, 502, new Error('boom')]);
    await expect(run(transport)).resolves.toEqual({
      delivered: false,
      retries: 2,
      error: 'Error: boom',
    });
    expect(calls).toHaveBeenCalledTimes(3);
    expect((times[1] ?? 0) - (times[0] ?? 0)).toBe(200);
    expect((times[2] ?? 0) - (times[1] ?? 0)).toBe(400);
  });

  it('429 with Retry-After: waits what the server asked, not the backoff', async () => {
    const { transport, times } = make([{ status: 429, headers: { 'retry-after': '2' } }, 204]);
    await expect(run(transport)).resolves.toEqual({ delivered: true, retries: 1 });
    expect((times[1] ?? 0) - (times[0] ?? 0)).toBe(2000);
  });
});

describe('Retry-After details', () => {
  it('parses seconds and HTTP-dates, and rejects garbage', () => {
    const now = Date.parse('2026-10-08T14:22:07Z');
    expect(parseRetryAfter('5', now)).toBe(5000);
    expect(parseRetryAfter(' 0 ', now)).toBe(0);
    expect(parseRetryAfter('Thu, 08 Oct 2026 14:22:10 GMT', now)).toBe(3000);
    expect(parseRetryAfter('Thu, 08 Oct 2026 14:00:00 GMT', now)).toBe(0);
    expect(parseRetryAfter('soon', now)).toBeUndefined();
    expect(parseRetryAfter(null, now)).toBeUndefined();
    expect(parseRetryAfter('-3', now)).toBeUndefined();
  });

  it('is capped, and garbage falls back to the backoff', async () => {
    const capped = make([{ status: 429, headers: { 'retry-after': '3600' } }, 204], {
      retryAfterCapMs: 1000,
    });
    await expect(run(capped.transport)).resolves.toMatchObject({ delivered: true });
    expect((capped.times[1] ?? 0) - (capped.times[0] ?? 0)).toBe(1000);

    const garbage = make([{ status: 429, headers: { 'retry-after': 'later' } }, 204]);
    await expect(run(garbage.transport)).resolves.toMatchObject({ delivered: true });
    expect((garbage.times[1] ?? 0) - (garbage.times[0] ?? 0)).toBe(200);
  });

  it('is honoured on a 503 too', async () => {
    const { transport, times } = make([{ status: 503, headers: { 'retry-after': '1' } }, 204]);
    await expect(run(transport)).resolves.toMatchObject({ delivered: true });
    expect((times[1] ?? 0) - (times[0] ?? 0)).toBe(1000);
  });
});

describe('which failures retry', () => {
  it.each([408, 429, 500, 503])('%i is retried', async (status) => {
    const { transport, calls } = make([status, 204]);
    await expect(run(transport)).resolves.toMatchObject({ delivered: true, retries: 1 });
    expect(calls).toHaveBeenCalledTimes(2);
  });

  it.each([400, 403, 404, 413])('%i is not', async (status) => {
    const { transport, calls } = make([status]);
    await expect(run(transport)).resolves.toEqual({
      delivered: false,
      retries: 0,
      error: `HTTP ${status}`,
    });
    expect(calls).toHaveBeenCalledTimes(1);
  });

  it('a timeout is retried, with the timeout applied per attempt', async () => {
    const { transport, calls } = make(['hang', 204], { timeoutMs: 100 });
    await expect(run(transport)).resolves.toEqual({ delivered: true, retries: 1 });
    expect(calls).toHaveBeenCalledTimes(2);
  });

  it('maxAttempts 1 never retries; junk options fall back to the defaults', async () => {
    const one = make([500], { maxAttempts: 1 });
    await expect(run(one.transport)).resolves.toEqual({
      delivered: false,
      retries: 0,
      error: 'HTTP 500',
    });
    const junk = make([500, 500, 500], { maxAttempts: NaN, backoffMs: -1 });
    await expect(run(junk.transport)).resolves.toMatchObject({ retries: 2 });
    expect(junk.calls).toHaveBeenCalledTimes(3);
  });

  it('leaves no timer behind and never leaks the token', async () => {
    const leaky = make([
      new Error(`https://eu.webhook.logs.insight.rapid7.com/v1/noformat/${TOKEN} down`),
      500,
      500,
    ]);
    const outcome = await run(leaky.transport);
    expect(JSON.stringify(outcome)).not.toContain(TOKEN);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('through createLogger', () => {
  it('retried and failed are counted', async () => {
    const script = scripted([500, 204, 500, 500, 500]);
    const onInternalError = vi.fn();
    const log = createLogger({
      token: TOKEN,
      fetch: script.fn,
      maxConcurrency: 1,
      onInternalError,
    });
    log.error('first');
    log.error('second');
    const flushed = log.flush(60_000);
    await vi.runAllTimersAsync();
    await flushed;
    expect(log.stats()).toMatchObject({ sent: 1, failed: 1, retried: 3, lastError: 'HTTP 500' });
    expect(onInternalError).toHaveBeenCalledOnce();
  });
});
