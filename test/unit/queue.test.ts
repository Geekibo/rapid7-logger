import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QUEUE_DEFAULTS, type QueueOptions } from '../../src/core/config.js';
import { createQueue, type Counters } from '../../src/core/queue.js';
import type { LogEvent, SendOutcome, Transport } from '../../src/core/types.js';

const AT = new Date(0);
const ev = (message: string, level: LogEvent['level'] = 'info'): LogEvent => ({
  timestamp: AT,
  level,
  message,
  context: {},
});

/** A transport whose sends resolve only when the test says so. */
function controllable(flushBehaviour: 'resolve' | 'hang' | 'reject' | 'throw' = 'resolve') {
  const pending: {
    message: string;
    resolve: (o?: SendOutcome) => void;
    reject: (e: Error) => void;
  }[] = [];
  const order: string[] = [];
  const transport: Transport & {
    inFlight(): number;
    settle(n?: number, outcome?: SendOutcome): void;
    failNext(n?: number): void;
    flushedWith: number[];
  } = {
    flushedWith: [],
    send(event) {
      order.push(event.message);
      return new Promise((resolve, reject) =>
        pending.push({ message: event.message, resolve, reject }),
      );
    },
    flush(timeoutMs) {
      transport.flushedWith.push(timeoutMs ?? -1);
      if (flushBehaviour === 'hang') return new Promise(() => {});
      if (flushBehaviour === 'reject') return Promise.reject(new Error('flush rejected'));
      if (flushBehaviour === 'throw') throw new Error('flush threw');
      return Promise.resolve();
    },
    inFlight: () => pending.length,
    settle(n = pending.length, outcome) {
      for (const p of pending.splice(0, n)) p.resolve(outcome);
    },
    failNext(n = 1) {
      for (const p of pending.splice(0, n)) p.reject(new Error('send rejected'));
    },
  };
  return { transport, order };
}

function make(
  options: Partial<QueueOptions> = {},
  transportBehaviour?: 'resolve' | 'hang' | 'reject' | 'throw',
) {
  const counters: Counters = { queued: 0, sent: 0, dropped: 0, failed: 0, retried: 0 };
  const report = vi.fn();
  const { transport, order } = controllable(transportBehaviour);
  const queue = createQueue({
    transport,
    counters,
    report,
    options: { ...QUEUE_DEFAULTS, ...options },
  });
  return { queue, counters, report, transport, order };
}

const tick = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('eager first event (done when)', () => {
  it('sends the first event before the interval elapses, with no timer involved', async () => {
    const { queue, transport } = make();
    queue.enqueue(ev('a'));
    expect(transport.inFlight()).toBe(0); // not synchronous: a burst gets a full pass
    await tick();
    expect(transport.inFlight()).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does it again after the queue has drained', async () => {
    const { queue, transport, order } = make();
    queue.enqueue(ev('a'));
    await tick();
    transport.settle();
    await tick();
    expect(vi.getTimerCount()).toBe(0);
    queue.enqueue(ev('b'));
    await tick();
    expect(order).toEqual(['a', 'b']);
  });
});

describe('overflow (done when)', () => {
  it('never blocks the caller, drops the newest, counts, and reports once per episode', () => {
    const { queue, counters, report } = make({ queueLimit: 100 });
    for (let i = 0; i < 1000; i++) queue.enqueue(ev(`e${i}`)); // synchronous loop returns
    expect(queue.size()).toBeLessThanOrEqual(100);
    expect(counters.dropped).toBe(900);
    expect(counters.queued).toBe(100);
    expect(counters.lastError).toBeUndefined();
    expect(report).toHaveBeenCalledOnce();
    expect(String(report.mock.calls[0]?.[0])).toMatch(/queue full/);
  });

  it('reports again only after the queue has drained', async () => {
    const { queue, report, transport } = make({ queueLimit: 2, batchSize: 10 });
    queue.enqueue(ev('a'));
    queue.enqueue(ev('b'));
    queue.enqueue(ev('c'));
    queue.enqueue(ev('d'));
    expect(report).toHaveBeenCalledOnce();
    await tick();
    transport.settle();
    await tick();
    expect(queue.size()).toBe(0);
    queue.enqueue(ev('e'));
    queue.enqueue(ev('f'));
    queue.enqueue(ev('g'));
    expect(report).toHaveBeenCalledTimes(2);
  });
});

describe('flush is bounded (done when)', () => {
  it('returns at the timeout when a send hangs forever', async () => {
    const { queue } = make();
    queue.enqueue(ev('a'));
    let resolved = false;
    void queue.flush(100).then(() => (resolved = true));
    await vi.advanceTimersByTimeAsync(99);
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(resolved).toBe(true);
  });

  it('returns at the timeout when transport.flush hangs', async () => {
    const { queue } = make({}, 'hang');
    let resolved = false;
    void queue.flush(50).then(() => (resolved = true));
    await vi.advanceTimersByTimeAsync(50);
    expect(resolved).toBe(true);
  });

  it('never rejects when transport.flush rejects or throws', async () => {
    await expect(make({}, 'reject').queue.flush(10)).resolves.toBeUndefined();
    await expect(make({}, 'throw').queue.flush(10)).resolves.toBeUndefined();
  });
});

describe('concurrency and passes', () => {
  it('never exceeds maxConcurrency and starts the next send as one settles', async () => {
    const { queue, transport, order } = make({ maxConcurrency: 2, batchSize: 10 });
    for (const m of ['a', 'b', 'c', 'd']) queue.enqueue(ev(m));
    await tick();
    expect(transport.inFlight()).toBe(2);
    transport.settle(1);
    await tick();
    expect(transport.inFlight()).toBe(2);
    expect(order).toEqual(['a', 'b', 'c']);
    transport.settle();
    await tick();
    expect(order).toEqual(['a', 'b', 'c', 'd']);
  });

  it('takes batchSize per pass and goes straight into the next pass when the pass was full', async () => {
    const { queue, transport, order } = make({ batchSize: 5, maxConcurrency: 10 });
    for (let i = 0; i < 12; i++) queue.enqueue(ev(`e${i}`));
    await tick();
    expect(transport.inFlight()).toBe(5);
    transport.settle();
    await tick();
    expect(transport.inFlight()).toBe(5);
    expect(vi.getTimerCount()).toBe(0);
    transport.settle();
    await tick();
    expect(transport.inFlight()).toBe(2);
    expect(order).toHaveLength(12);
  });

  it('waits out the interval after a partial pass so a trickle coalesces', async () => {
    const { queue, transport, order } = make({ batchSize: 5 });
    queue.enqueue(ev('a'));
    await tick();
    queue.enqueue(ev('b')); // arrives while a is in flight: a partial pass is running
    transport.settle();
    await tick();
    expect(order).toEqual(['a']);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1999);
    expect(order).toEqual(['a']);
    await vi.advanceTimersByTimeAsync(1);
    expect(order).toEqual(['a', 'b']);
  });

  it('an error-level event cancels the wait', async () => {
    const { queue, transport, order } = make({ batchSize: 5 });
    queue.enqueue(ev('a'));
    await tick();
    queue.enqueue(ev('b'));
    transport.settle();
    await tick();
    expect(vi.getTimerCount()).toBe(1);
    queue.enqueue(ev('c', 'error'));
    await tick();
    expect(vi.getTimerCount()).toBe(0);
    expect(order).toEqual(['a', 'b', 'c']);
  });

  it('flushIntervalMs 0 never waits', async () => {
    const { queue, transport, order } = make({ batchSize: 1, flushIntervalMs: 0 });
    queue.enqueue(ev('a'));
    queue.enqueue(ev('b'));
    await tick();
    transport.settle();
    await tick();
    expect(vi.getTimerCount()).toBe(0);
    expect(order).toEqual(['a', 'b']);
  });

  it('is FIFO', async () => {
    const { queue, transport, order } = make({ maxConcurrency: 1, batchSize: 100 });
    for (let i = 0; i < 50; i++) queue.enqueue(ev(`e${i}`));
    for (let i = 0; i < 50; i++) {
      await tick();
      transport.settle();
    }
    expect(order).toEqual(Array.from({ length: 50 }, (_, i) => `e${i}`));
  });
});

describe('outcomes and counters (§7.4)', () => {
  it('counts void and delivered:true as sent, delivered:false as failed, and sums retries', async () => {
    const { queue, transport, counters, report } = make({ maxConcurrency: 10 });
    for (const m of ['a', 'b', 'c']) queue.enqueue(ev(m));
    await tick();
    transport.settle(1);
    transport.settle(1, { delivered: true, retries: 2 });
    transport.settle(1, { delivered: false, retries: 3, error: 'gave up' });
    await tick();
    expect(counters).toMatchObject({
      queued: 0,
      sent: 2,
      failed: 1,
      retried: 5,
      lastError: 'gave up',
    });
    expect(report).toHaveBeenCalledOnce();
  });

  it('a rejecting or throwing send is counted and does not stall the pass', async () => {
    const { queue, transport, counters, order } = make({ maxConcurrency: 1, batchSize: 10 });
    queue.enqueue(ev('a'));
    queue.enqueue(ev('b'));
    await tick();
    transport.failNext();
    await tick();
    expect(counters.failed).toBe(1);
    expect(counters.lastError).toBe('send rejected');
    expect(order).toEqual(['a', 'b']);

    const counters2: Counters = { queued: 0, sent: 0, dropped: 0, failed: 0, retried: 0 };
    const throwing = createQueue({
      transport: {
        send: () => {
          throw new Error('boom');
        },
        flush: () => Promise.resolve(),
      },
      counters: counters2,
      report: () => {},
      options: QUEUE_DEFAULTS,
    });
    throwing.enqueue(ev('x'));
    throwing.enqueue(ev('y'));
    await tick();
    expect(counters2).toMatchObject({ failed: 2, queued: 0 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('queued is a gauge of events waiting', async () => {
    const { queue, counters, transport } = make({ maxConcurrency: 1, batchSize: 10 });
    for (const m of ['a', 'b', 'c']) queue.enqueue(ev(m));
    expect(counters.queued).toBe(3);
    await tick();
    expect(counters.queued).toBe(2);
    transport.settle();
    await tick();
    transport.settle();
    await tick();
    transport.settle();
    await tick();
    expect(counters.queued).toBe(0);
  });
});

describe('flush semantics', () => {
  it('cancels a pending wait, awaits in-flight sends, then calls transport.flush with the remaining budget', async () => {
    const { queue, transport, order } = make({ batchSize: 5 });
    queue.enqueue(ev('a'));
    await tick();
    queue.enqueue(ev('b'));
    transport.settle();
    await tick();
    expect(vi.getTimerCount()).toBe(1);
    let resolved = false;
    void queue.flush(1000).then(() => (resolved = true));
    await vi.advanceTimersByTimeAsync(10);
    expect(order).toEqual(['a', 'b']);
    expect(resolved).toBe(false);
    transport.settle();
    await tick();
    expect(resolved).toBe(true);
    expect(transport.flushedWith).toEqual([990]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('includes events enqueued mid-flush and tolerates concurrent flushes', async () => {
    const { queue, transport, order } = make({ maxConcurrency: 1 });
    queue.enqueue(ev('a'));
    const f1 = queue.flush(1000);
    const f2 = queue.flush(1000);
    await tick();
    queue.enqueue(ev('b'));
    transport.settle();
    await tick();
    transport.settle();
    await tick();
    await Promise.all([f1, f2]);
    expect(order).toEqual(['a', 'b']);
  });

  it('resolves immediately when idle', async () => {
    const { queue, transport } = make();
    await queue.flush(100);
    expect(transport.flushedWith).toEqual([100]);
  });
});

describe('hygiene', () => {
  it('holds no timer when idle and tolerates re-entrant enqueue', async () => {
    const counters: Counters = { queued: 0, sent: 0, dropped: 0, failed: 0, retried: 0 };
    let reentered = false;
    const queue = createQueue({
      transport: {
        send: () => {
          if (!reentered) {
            reentered = true;
            queue.enqueue(ev('inner'));
          }
          return Promise.resolve();
        },
        flush: () => Promise.resolve(),
      },
      counters,
      report: () => {},
      options: QUEUE_DEFAULTS,
    });
    queue.enqueue(ev('outer'));
    await tick();
    await tick();
    await vi.advanceTimersByTimeAsync(2000);
    expect(counters.sent).toBe(2);
    expect(queue.size()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a throwing reporter does not break the pump', async () => {
    const counters: Counters = { queued: 0, sent: 0, dropped: 0, failed: 0, retried: 0 };
    const queue = createQueue({
      transport: { send: () => Promise.reject(new Error('x')), flush: () => Promise.resolve() },
      counters,
      report: () => {
        throw new Error('reporter broke');
      },
      options: { ...QUEUE_DEFAULTS, queueLimit: 1 },
    });
    queue.enqueue(ev('a'));
    queue.enqueue(ev('b'));
    await tick();
    await tick();
    expect(counters).toMatchObject({ failed: 1, dropped: 1 });
  });
});
