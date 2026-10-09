import { renderValue } from '../core/formatter.js';
import { normaliseError } from '../core/logger.js';
import { readTraceparent } from '../core/traceparent.js';
import type { LogContext, LogErrorInfo, Logger } from '../core/types.js';

// The one-liner for instrumentation.ts (DESIGN §6.1): a function assignable to Next's
// `Instrumentation.onRequestError`. Runs under both NEXT_RUNTIME values, so it imports from the
// core only. Shapes below match next@15.0.0, 15.5.0 and 16.4.0 (verified from the shipped
// types): identical except `routeType`'s fourth member, 'middleware' (15) vs 'proxy' (16).

export type RouteType = 'render' | 'route' | 'action' | 'proxy' | 'middleware' | (string & {});

export interface RequestErrorRequest {
  readonly path: string;
  readonly method: string;
  /** A plain object on both runtimes (`req.headers` on Node; entries of a `Headers` on Edge). */
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
}

export interface RequestErrorContext {
  readonly routerKind: 'Pages Router' | 'App Router' | (string & {});
  readonly routePath: string;
  readonly routeType: RouteType;
  readonly renderSource?:
    | 'react-server-components'
    | 'react-server-components-payload'
    | 'server-rendering'
    | (string & {});
  /** Required in Next's type, but its value may be `undefined`. */
  readonly revalidateReason?: 'on-demand' | 'stale' | (string & {}) | undefined;
  /** Only in the Next docs sample, never in a shipped type; accepted in case it appears. */
  readonly renderType?: string;
}

/** What `createRequestErrorHandler` returns: assignable to `Instrumentation.onRequestError`. */
export type RequestErrorHandler = (
  error: unknown,
  request: RequestErrorRequest,
  context: RequestErrorContext,
) => Promise<void>;

export interface RequestErrorHandlerOptions {
  /** The line's message. Default `'Unhandled server error'`. */
  readonly message?: string;
  /**
   * Bound on the flush awaited before returning. Default 1500 ms: the runtime may freeze the
   * instant the hook returns (§7.3), and React's render path does not wait for it at all.
   */
  readonly flushTimeoutMs?: number;
}

export const DEFAULT_REQUEST_ERROR_MESSAGE = 'Unhandled server error';
export const DEFAULT_REQUEST_ERROR_FLUSH_MS = 1500;

/**
 * `error` is `unknown` (§6.1): narrow it. An Error, or anything error-shaped, keeps its
 * name/message/stack/digest. Any other object is rendered as JSON — and still carries its
 * digest when it has one, because the instance may not be the one thrown and the digest is
 * what correlates the server line to what the browser saw. A primitive has no digest.
 */
function describeError(error: unknown): LogErrorInfo {
  const info = normaliseError(error);
  if (error instanceof Error || typeof error !== 'object' || error === null) return info;
  const candidate = error as { message?: unknown; digest?: unknown };
  if (typeof candidate.message === 'string') return info;
  const described: { -readonly [K in keyof LogErrorInfo]: LogErrorInfo[K] } = {
    name: 'Error',
    message: renderValue(error) ?? '[unserializable]',
  };
  if (typeof candidate.digest === 'string') described.digest = candidate.digest;
  return described;
}

function stringField(source: unknown, key: string): string | undefined {
  if (typeof source !== 'object' || source === null) return undefined;
  const value = (source as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

function contextOf(request: unknown, context: unknown): LogContext {
  const out: Record<string, unknown> = {};
  const fields: [unknown, string][] = [
    [request, 'path'],
    [request, 'method'],
    [context, 'routePath'],
    [context, 'routeType'],
    [context, 'routerKind'],
    [context, 'renderSource'],
    [context, 'revalidateReason'],
    [context, 'renderType'],
  ];
  for (const [source, key] of fields) {
    const value = stringField(source, key);
    if (value !== undefined) out[key] = value;
  }
  // The inbound traceparent joins this line to the request's trace, on Edge too (§6.4). On
  // Node inside withTrace(req) it is the same trace, so per-call beating ambient changes nothing.
  const trace = readTraceparent(request as Parameters<typeof readTraceparent>[0]);
  if (trace) out.traceId = trace.traceId;
  return out;
}

function flushTimeout(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : DEFAULT_REQUEST_ERROR_FLUSH_MS;
}

/**
 * Build an `onRequestError` for instrumentation.ts (§6.1):
 *
 *   export const onRequestError = createRequestErrorHandler(log);
 *
 * Logs one `error` line with the path, method, route and the digest, then awaits a bounded
 * flush. Never throws or rejects — a hook running during error handling must not add one.
 *
 * Two gaps to know about: it only sees errors that *escape* (code that catches and rethrows a
 * sanitised error hands it the sanitised one), so it is a safety net, not a substitute for the
 * logger at call sites; and the error instance may not be the one thrown, which is why the
 * digest is always logged.
 */
export function createRequestErrorHandler(
  log: Logger,
  options: RequestErrorHandlerOptions = {},
): RequestErrorHandler {
  const message =
    typeof options.message === 'string' && options.message !== ''
      ? options.message
      : DEFAULT_REQUEST_ERROR_MESSAGE;
  const timeoutMs = flushTimeout(options.flushTimeoutMs);
  return async (error, request, context) => {
    try {
      log.error(message, describeError(error), contextOf(request, context));
    } catch {
      // Nothing to do: the logger is already the thing that reports failures.
    }
    try {
      await log.flush(timeoutMs);
    } catch {
      // flush never rejects by contract; this is belt and braces.
    }
  };
}
