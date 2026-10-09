import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QUEUE_DEFAULTS, type QueueOptions } from '../../src/core/config.js';
import { newCounters } from '../../src/core/counters.js';
import { createImmediateDispatcher } from '../../src/core/immediate.js';
import type { LogEvent, SendOutcome, Transport } from '../../src/core/types.js';

const AT = new Date(0);
const ev = (message: string): LogEvent => ({ timestamp: AT, level: 'info', message, context: {} });

/** A transport whose sends resolve only when the test says so. */
function controllable(flushBehaviour: 'resolve' | 'hang' | 'reject' | 'throw' = 'resolve') {
  const pending: { resolve: (o?: SendOutcome) => void; reject: (e: Error) => void }[] = [];
  const order: string[] = [];
  const flushedWith: number[] = [];
  const transport: Transport = {
    send(event) {
      order.push(event.message);
      return new Promise((resolve, reject) => pending.push({ resolve, reject }));
    },
    flush(timeoutMs) {
      flushedWith.push(timeoutMs ?? -1);
      if (flushBehaviour === 'hang') return new Promise(() => {});
      if (flushBehaviour === 'reject') return Promise.reject(new Error('flush rejected'));
      if (flushBehaviour === 'throw') throw new Error('flush threw');
      return Promise.resolve();
    },
  };
  return {
    transport,
    order,
    flushedWith,
    inFlight: () => pending.length,
    settle: (n = pending.length, outcome?: SendOutcome) => {
      for (const p of pending.splice(0, n)) p.resolve(outcome);
    },
    failNext: (n = 1) => {
      for (const p of pending.splice(0, n)) p.reject(new Error('send rejected'));
    },
  };
}

function make(
  options: Partial<QueueOptions> = {},
  flushBehaviour?: 'resolve' | 'hang' | 'reject' | 'throw',
) {
  const counters = newCounters();
  const report = vi.fn();
  const t = controllable(flushBehaviour);
  const dispatcher = createImmediateDispatcher({
    transport: t.transport,
    counters,
    report,
    options: { ...QUEUE_DEFAULTS, ...options },
  });
  return { dispatcher, counters, report, ...t };
}

const tick = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('the immediate dispatcher (§6.3)', () => {
  it('sends synchronously inside enqueue, in order, with no timer', () => {
    const { dispatcher, order, inFlight } = make();
    dispatcher.enqueue(ev('a'));
    dispatcher.enqueue(ev('b'));
    expect(order).toEqual(['a', 'b']);
    expect(inFlight()).toBe(2);
    expect(vi.getTimerCount()).toBe(0);
    expect(dispatcher.size()).toBe(0);
  });

  it('keeps the same books as the queue', async () => {
    const { dispatcher, settle, failNext, counters, report } = make();
    for (const m of ['a', 'b', 'c', 'd']) dispatcher.enqueue(ev(m));
    settle(1);
    settle(1, { delivered: true, retries: 2 });
    settle(1, { delivered: false, retries: 1, error: 'gave up' });
    failNext();
    await tick();
    expect(counters).toMatchObject({ queued: 0, sent: 2, failed: 2, retried: 3, dropped: 0 });
    expect(counters.lastError).toBe('send rejected');
    expect(report).toHaveBeenCalledTimes(2);
  });

  it('a send that throws is counted and does not break the next one', () => {
    const counters = newCounters();
    let calls = 0;
    const dispatcher = createImmediateDispatcher({
      transport: {
        send: () => {
          calls += 1;
          if (calls === 1) throw new Error('boom');
          return Promise.resolve();
        },
        flush: () => Promise.resolve(),
      },
      counters,
      report: () => {},
      options: QUEUE_DEFAULTS,
    });
    expect(() => dispatcher.enqueue(ev('a'))).not.toThrow();
    dispatcher.enqueue(ev('b'));
    expect(calls).toBe(2);
    expect(counters.failed).toBe(1);
  });

  it('flush waits for in-flight sends, including ones started meanwhile, then flushes the transport', async () => {
    const { dispatcher, settle, flushedWith } = make();
    dispatcher.enqueue(ev('a'));
    let resolved = false;
    void dispatcher.flush(1000).then(() => (resolved = true));
    await tick();
    expect(resolved).toBe(false);
    dispatcher.enqueue(ev('b')); // mid-flush
    settle(1);
    await tick();
    expect(resolved).toBe(false);
    settle(1);
    await tick();
    expect(resolved).toBe(true);
    expect(flushedWith).toEqual([1000]);
  });

  it('flush is bounded (invariant 4): resolves at the timeout with a hanging send or flush', async () => {
    const hangingSend = make();
    hangingSend.dispatcher.enqueue(ev('a'));
    let resolved = false;
    void hangingSend.dispatcher.flush(100).then(() => (resolved = true));
    await vi.advanceTimersByTimeAsync(99);
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(resolved).toBe(true);

    const hangingFlush = make({}, 'hang');
    let resolved2 = false;
    void hangingFlush.dispatcher.flush(50).then(() => (resolved2 = true));
    await vi.advanceTimersByTimeAsync(50);
    expect(resolved2).toBe(true);
  });

  it('flush never rejects: junk timeouts, a throwing or rejecting transport.flush', async () => {
    for (const t of [NaN, -1, 0]) await expect(make().dispatcher.flush(t)).resolves.toBeUndefined();
    await expect(make({}, 'reject').dispatcher.flush(10)).resolves.toBeUndefined();
    await expect(make({}, 'throw').dispatcher.flush(10)).resolves.toBeUndefined();
  });

  it('queueLimit bounds the sends in flight: drops, counts, reports once per episode', async () => {
    const { dispatcher, settle, counters, report, inFlight } = make({ queueLimit: 2 });
    for (const m of ['a', 'b', 'c', 'd']) dispatcher.enqueue(ev(m));
    expect(inFlight()).toBe(2);
    expect(counters.dropped).toBe(2);
    expect(report).toHaveBeenCalledOnce();
    settle();
    await tick();
    dispatcher.enqueue(ev('e'));
    dispatcher.enqueue(ev('f'));
    dispatcher.enqueue(ev('g'));
    expect(counters.dropped).toBe(3);
    expect(report).toHaveBeenCalledTimes(2);
  });

  it('a throwing reporter does not break it', () => {
    const counters = newCounters();
    const dispatcher = createImmediateDispatcher({
      transport: { send: () => Promise.reject(new Error('x')), flush: () => Promise.resolve() },
      counters,
      report: () => {
        throw new Error('reporter broke');
      },
      options: { ...QUEUE_DEFAULTS, queueLimit: 1 },
    });
    expect(() => {
      dispatcher.enqueue(ev('a'));
      dispatcher.enqueue(ev('b'));
    }).not.toThrow();
    expect(counters.dropped).toBe(1);
  });
});
