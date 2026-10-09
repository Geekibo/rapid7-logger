import type { QueueOptions } from './config.js';
import type { InternalErrorHandler, LogEvent, SendOutcome, Transport } from './types.js';

// The bounded queue (DESIGN §7.2). The endpoint takes one event per request (§2.2), so there
// is no body batching here: a "pass" takes up to `batchSize` events off the queue and sends
// each one, keeping at most `maxConcurrency` in flight. Three promises hold regardless of what
// the transport does: `enqueue` is synchronous and never blocks (invariant 5), nothing here
// ever throws or rejects (invariant 3), and `flush` returns when its timeout elapses whether or
// not the queue drained (invariant 4).

/** Mutable counters (§7.4). One object is shared by a logger and every child it spawns. */
export interface Counters {
  queued: number;
  sent: number;
  dropped: number;
  failed: number;
  retried: number;
  lastError?: string;
}

/** The seam between the logger and delivery. Edge (#22) substitutes an immediate-send one. */
export interface Dispatcher {
  enqueue(event: LogEvent): void;
  flush(timeoutMs: number): Promise<void>;
  size(): number;
}

export interface QueueDeps {
  readonly transport: Transport;
  readonly counters: Counters;
  readonly report: InternalErrorHandler;
  readonly options: QueueOptions;
}

const EAGER_LEVELS = new Set(['error', 'fatal']);

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

export function createQueue({ transport, counters, report, options }: QueueDeps): Dispatcher {
  const { batchSize, flushIntervalMs, queueLimit, maxConcurrency } = options;

  // Array plus a head index: O(1) enqueue and dequeue without shifting.
  let items: LogEvent[] = [];
  let head = 0;
  let inFlight = 0;
  /** Events this pass may still start; 0 means no pass is running. */
  let passRemaining = 0;
  let waitTimer: ReturnType<typeof setTimeout> | undefined;
  let skipNextWait = false;
  let lastPassFull = false;
  let reportedOverflow = false;
  /** Resolvers waiting for "empty and nothing in flight". */
  let drainedWaiters: (() => void)[] = [];

  function size(): number {
    return items.length - head;
  }

  function dequeue(): LogEvent | undefined {
    if (head >= items.length) return undefined;
    const event = items[head];
    items[head] = undefined as unknown as LogEvent; // release the reference
    head += 1;
    if (head > 1024 && head * 2 >= items.length) {
      items = items.slice(head);
      head = 0;
    }
    counters.queued = size();
    return event;
  }

  function safeReport(error: Error): void {
    try {
      report(error);
    } catch {
      // The reporter is not allowed to break the pump.
    }
  }

  function settle(outcome: void | SendOutcome): void {
    if (outcome && outcome.delivered === false) {
      counters.failed += 1;
      if (outcome.error !== undefined) counters.lastError = outcome.error;
      safeReport(new Error(`event not delivered: ${outcome.error ?? 'transport gave up'}`));
    } else {
      counters.sent += 1;
    }
    if (outcome && typeof outcome.retries === 'number' && outcome.retries > 0) {
      counters.retried += outcome.retries;
    }
  }

  function fail(what: string, cause: unknown): void {
    counters.failed += 1;
    counters.lastError = errorMessage(cause);
    safeReport(new Error(`${what}: ${errorMessage(cause)}`, { cause }));
  }

  function afterSend(): void {
    inFlight -= 1;
    pump();
  }

  /** Start sends until the pass is exhausted or the concurrency cap is reached. */
  function pump(): void {
    while (passRemaining > 0 && inFlight < maxConcurrency && size() > 0) {
      const event = dequeue();
      if (!event) break;
      passRemaining -= 1;
      inFlight += 1;
      let result: Promise<void | SendOutcome>;
      try {
        result = transport.send(event);
      } catch (cause) {
        fail('transport.send threw', cause);
        inFlight -= 1;
        continue;
      }
      Promise.resolve(result).then(
        (outcome) => {
          settle(outcome);
          afterSend();
        },
        (cause: unknown) => {
          fail('transport.send rejected', cause);
          afterSend();
        },
      );
    }
    if (passRemaining > 0 && size() === 0) passRemaining = 0; // the pass ran out of events
    if (passRemaining === 0 && inFlight === 0) endPass();
  }

  function startPass(): void {
    if (passRemaining > 0 || inFlight > 0) return; // one pass at a time
    passRemaining = Math.min(size(), batchSize);
    lastPassFull = passRemaining === batchSize;
    if (passRemaining === 0) {
      endPass();
      return;
    }
    pump();
  }

  function endPass(): void {
    if (size() === 0) {
      reportedOverflow = false;
      skipNextWait = false;
      const waiters = drainedWaiters;
      drainedWaiters = [];
      for (const resolve of waiters) resolve();
      return;
    }
    // Events remain. A full pass means a backlog: go again at once. A partial pass waits out
    // the interval so a trickle coalesces — unless an error-level event asked us not to.
    if (skipNextWait || flushIntervalMs === 0 || lastPassFull) {
      skipNextWait = false;
      queueMicrotask(startPass);
      return;
    }
    waitTimer = setTimeout(() => {
      waitTimer = undefined;
      startPass();
    }, flushIntervalMs);
  }

  function cancelWait(): boolean {
    if (waitTimer === undefined) return false;
    clearTimeout(waitTimer);
    waitTimer = undefined;
    return true;
  }

  function enqueue(event: LogEvent): void {
    if (size() >= queueLimit) {
      counters.dropped += 1;
      if (!reportedOverflow) {
        reportedOverflow = true;
        safeReport(new Error(`queue full (${queueLimit} events); dropping until it drains`));
      }
      return;
    }
    const wasIdle =
      size() === 0 && passRemaining === 0 && inFlight === 0 && waitTimer === undefined;
    items.push(event);
    counters.queued = size();
    const eager = EAGER_LEVELS.has(event.level);
    if (eager) {
      skipNextWait = true;
      if (cancelWait()) {
        queueMicrotask(startPass);
        return;
      }
    }
    // Idle → non-empty: start a pass on the next microtask rather than waiting out the
    // interval. This is what delivers a quiet service's lone error in ~1 s (§1.2, §7.2).
    if (wasIdle) queueMicrotask(startPass);
  }

  function whenDrained(): Promise<void> {
    if (size() === 0 && inFlight === 0) return Promise.resolve();
    return new Promise((resolve) => drainedWaiters.push(resolve));
  }

  function flush(timeoutMs: number): Promise<void> {
    const budget = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 0;
    const startedAt = Date.now();
    return new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(finish, budget);
      skipNextWait = true;
      if (cancelWait()) queueMicrotask(startPass);
      else if (passRemaining === 0 && inFlight === 0 && size() > 0) queueMicrotask(startPass);
      whenDrained()
        .then(() => {
          if (done) return;
          const remaining = Math.max(0, budget - (Date.now() - startedAt));
          let flushed: Promise<void>;
          try {
            flushed = transport.flush(remaining);
          } catch (cause) {
            fail('transport.flush threw', cause);
            finish();
            return;
          }
          Promise.resolve(flushed).then(finish, (cause: unknown) => {
            fail('transport.flush rejected', cause);
            finish();
          });
        })
        .catch(finish);
    });
  }

  return { enqueue, flush, size };
}
