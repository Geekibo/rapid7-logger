import { generateTraceContext, readTraceparent } from '../core/traceparent.js';
import type { Logger } from '../core/types.js';
import { flushTimeout } from './flush-timeout.js';

// withLogging (DESIGN §6.2): correlation, timing and the post-response flush for Server Actions
// and Route Handlers — the places with no framework hook. Runs under both NEXT_RUNTIME values,
// so it imports from the core only and cannot use AsyncLocalStorage.

/** Schedules work to run after the response is sent. Next's `after` fits; so does `waitUntil`. */
export type AfterScheduler = (task: () => Promise<void> | void) => void;

/**
 * - `after` (default): schedule the flush with `after()` from `next/server`, falling back to
 *   `sync` when it is unavailable or throws (Next < 15.1, outside a request scope).
 * - `sync`: await delivery before returning (or rethrowing). Costs latency; never loses a line.
 * - `none`: no flush; the caller flushes.
 */
export type FlushMode = 'after' | 'sync' | 'none';

export interface WithLoggingOptions {
  readonly flushMode?: FlushMode;
  /** Bound on the flush. Default 1500 ms. */
  readonly flushTimeoutMs?: number;
  /** Replace the `after()` looked up from `next/server`; the test seam and the escape hatch. */
  readonly after?: AfterScheduler;
}

/** `fn` receives a child logger bound to the operation and its trace, then the original args. */
export type LoggedFunction<A extends unknown[], R> = (log: Logger, ...args: A) => R;

// `after()` is reached by a dynamic import so loading this entry never requires `next`, and
// so a missing or old Next degrades to the inline fallback rather than a link error. Kicked
// off once at module load; read synchronously at call time.
let cachedAfter: AfterScheduler | undefined;
let loading: Promise<void> | undefined;

function pickAfter(mod: unknown): AfterScheduler | undefined {
  const candidate = mod as { after?: unknown; unstable_after?: unknown } | null;
  const fn = candidate?.after ?? candidate?.unstable_after;
  return typeof fn === 'function' ? (fn as AfterScheduler) : undefined;
}

export function loadAfter(): Promise<void> {
  loading ??= import('next/server').then(
    (mod) => {
      cachedAfter = pickAfter(mod);
    },
    () => undefined,
  );
  return loading;
}

/** Exposed for tests only. */
export function resolvedAfter(): AfterScheduler | undefined {
  return cachedAfter;
}

/**
 * Next's own control flow is implemented with throws — `redirect()`, `notFound()`, dynamic
 * bailouts — and every redirecting Server Action would otherwise be a `failed` line with an
 * eager flush. They are logged as completed, with the digest, and rethrown unchanged.
 */
function isNextSignal(error: unknown): boolean {
  const digest = (error as { digest?: unknown } | null)?.digest;
  return (
    typeof digest === 'string' &&
    (digest.startsWith('NEXT_') ||
      digest === 'DYNAMIC_SERVER_USAGE' ||
      digest === 'BAILOUT_TO_CLIENT_SIDE_RENDERING')
  );
}

/** Inherit the trace from a Request-like first argument (Route Handlers), never from a form field. */
function traceIdFor(args: readonly unknown[]): string {
  const first = args[0];
  if (typeof first === 'object' && first !== null && 'headers' in first) {
    const inbound = readTraceparent(first);
    if (inbound) return inbound.traceId;
  }
  return generateTraceContext().traceId;
}

function guarded(work: () => void): void {
  try {
    work();
  } catch {
    // A broken logger must never replace the user's result or error.
  }
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return typeof (value as { then?: unknown } | null)?.then === 'function';
}

/**
 * Wrap a Server Action or Route Handler (§6.2):
 *
 *   export const publishSurvey = withLogging(log, 'publishSurvey', async (log, id: number) => {
 *     log.info('publishing', { id });
 *     return api.publish(id);
 *   });
 *
 * `fn` gets a child logger bound to `{ traceId, operation }`; the wrapper logs start, outcome
 * and `durationMs`, logs a thrown error and **rethrows it unchanged**, then flushes per
 * `flushMode`. The trace id is inherited from a Request-like first argument's `traceparent`,
 * otherwise generated; on Node inside `withTrace` the ambient id wins (same request).
 */
export function withLogging<A extends unknown[], R>(
  log: Logger,
  name: string,
  fn: LoggedFunction<A, R>,
  options: WithLoggingOptions = {},
): (...args: A) => R {
  const mode: FlushMode = options.flushMode ?? 'after';
  const timeoutMs = flushTimeout(options.flushTimeoutMs);
  if (mode === 'after' && !options.after) void loadAfter();

  const schedule = (child: Logger): Promise<void> | undefined => {
    if (mode === 'none') return undefined;
    const flush = () => child.flush(timeoutMs).then(undefined, () => undefined);
    if (mode === 'after') {
      const after = options.after ?? cachedAfter;
      if (after) {
        try {
          after(flush);
          return undefined;
        } catch {
          // Outside a request scope, or no waitUntil: fall back to the inline flush.
        }
      }
    }
    return flush();
  };

  return (...args: A): R => {
    const child = log.child({ traceId: traceIdFor(args), operation: name });
    const startedAt = performance.now();
    const durationMs = () => Math.round(performance.now() - startedAt);

    const succeeded = () =>
      guarded(() => child.info(`${name} completed`, { durationMs: durationMs() }));
    const failed = (error: unknown) =>
      guarded(() => {
        if (isNextSignal(error)) {
          const digest = (error as { digest: string }).digest;
          child.info(`${name} completed`, { durationMs: durationMs(), digest });
        } else {
          child.error(`${name} failed`, error, { durationMs: durationMs() });
        }
      });

    guarded(() => child.debug(`${name} started`));
    let result: R;
    try {
      result = fn(child, ...args);
    } catch (error) {
      failed(error);
      const pending = schedule(child);
      if (pending && mode === 'sync') {
        // A sync fn cannot await; the flush is fire-and-forget here (documented).
      }
      throw error;
    }
    if (!isPromiseLike(result)) {
      succeeded();
      void schedule(child);
      return result;
    }
    return Promise.resolve(result).then(
      async (value) => {
        succeeded();
        const pending = schedule(child);
        if (pending) await pending;
        return value;
      },
      async (error: unknown) => {
        failed(error);
        const pending = schedule(child);
        if (pending) await pending;
        throw error;
      },
    ) as unknown as R;
  };
}
