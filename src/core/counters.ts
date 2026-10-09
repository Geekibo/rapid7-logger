import type { InternalErrorHandler, SendOutcome } from './types.js';

// The counters (DESIGN §7.4) and the one place that keeps their books, shared by the queue
// (Node, batching) and the immediate dispatcher (Edge): a send that resolves `void` or
// `{ delivered: true }` is `sent`; one that resolves `{ delivered: false }`, rejects or throws
// is `failed` with `lastError`; `retries` are summed. One writer per field.

/** Mutable counters. One object is shared by a logger and every child it spawns. */
export interface Counters {
  queued: number;
  sent: number;
  dropped: number;
  failed: number;
  retried: number;
  lastError?: string;
}

export function newCounters(): Counters {
  return { queued: 0, sent: 0, dropped: 0, failed: 0, retried: 0 };
}

export function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

// Function-typed properties, not methods: callers destructure them.
export interface Accounting {
  /** Record a settled send. */
  readonly settle: (outcome: void | SendOutcome) => void;
  /** Record a send or flush that threw or rejected. */
  readonly fail: (what: string, cause: unknown) => void;
  /** Report without letting a throwing reporter break the caller. */
  readonly safeReport: (error: Error) => void;
}

export function createAccounting(counters: Counters, report: InternalErrorHandler): Accounting {
  function safeReport(error: Error): void {
    try {
      report(error);
    } catch {
      // The reporter is not allowed to break the dispatcher.
    }
  }
  return {
    safeReport,
    settle(outcome) {
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
    },
    fail(what, cause) {
      counters.failed += 1;
      counters.lastError = errorMessage(cause);
      safeReport(new Error(`${what}: ${errorMessage(cause)}`, { cause }));
    },
  };
}
