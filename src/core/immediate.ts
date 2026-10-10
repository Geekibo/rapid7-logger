import { suppressingCapture } from './console-capture.js';
import { createAccounting } from './counters.js';
import type { Dispatcher, QueueDeps } from './queue.js';
import type { LogEvent, SendOutcome } from './types.js';

// The immediate-send dispatcher (DESIGN §6.3), for runtimes with no reliable background timer:
// an Edge invocation can be torn down the moment the response is returned, so a batching
// window may never elapse. Every level call hands its event to `transport.send` at once; the
// caller awaits `flush()` or hands it to `after()`. No batching, no timers of its own, no
// `maxConcurrency` (a holding list would be a queue); `queueLimit` bounds the sends in flight
// so the caller is never blocked and memory is bounded (invariant 5). Never throws (invariant
// 3); `flush` is bounded (invariant 4). `batchSize`, `flushIntervalMs` and `maxConcurrency`
// are accepted and inert.

export function createImmediateDispatcher({
  transport,
  counters,
  report,
  options,
}: QueueDeps): Dispatcher {
  const { settle, fail, safeReport } = createAccounting(counters, report);
  const inFlight = new Set<Promise<void>>();
  let reportedOverflow = false;

  function enqueue(event: LogEvent): void {
    if (inFlight.size >= options.queueLimit) {
      counters.dropped += 1;
      if (!reportedOverflow) {
        reportedOverflow = true;
        safeReport(new Error(`${options.queueLimit} sends in flight; dropping until they settle`));
      }
      return;
    }
    let result: Promise<void | SendOutcome>;
    try {
      result = suppressingCapture(() => transport.send(event));
    } catch (cause) {
      fail('transport.send threw', cause);
      return;
    }
    const tracked: Promise<void> = Promise.resolve(result)
      .then(settle, (cause: unknown) => fail('transport.send rejected', cause))
      .then(() => {
        inFlight.delete(tracked);
        if (inFlight.size === 0) reportedOverflow = false;
      });
    inFlight.add(tracked);
  }

  /** Resolves when nothing is in flight — including sends started while waiting. */
  async function drained(): Promise<void> {
    while (inFlight.size > 0) await Promise.all(inFlight);
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
      drained()
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

  return { enqueue, flush, size: () => 0 };
}
