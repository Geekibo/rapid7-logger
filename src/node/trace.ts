import { AsyncLocalStorage } from 'node:async_hooks';
import {
  childOf,
  formatTraceparent,
  generateTraceContext,
  readTraceparent,
  type TraceContext,
  type TraceSource,
} from '../core/traceparent.js';
import type { LogContext } from '../core/types.js';

// Correlation on Node (DESIGN §6.4): the current trace lives in AsyncLocalStorage, so any
// logger — one created at module scope, its children, one made inside the request — stamps
// the ambient trace id with no plumbing. `child()` is not needed for correlation at all.

// One store per process, whichever of the ESM and CJS builds created it first.
const STORE_KEY = Symbol.for('@geekibo/rapid7-logger/trace');

function store(): AsyncLocalStorage<TraceContext> {
  const holder = globalThis as unknown as Record<
    symbol,
    AsyncLocalStorage<TraceContext> | undefined
  >;
  holder[STORE_KEY] ??= new AsyncLocalStorage<TraceContext>();
  return holder[STORE_KEY];
}

/** The trace in effect, or `undefined` outside `withTrace`. */
export function currentTrace(): TraceContext | undefined {
  return store().getStore();
}

export function currentTraceId(): string | undefined {
  return currentTrace()?.traceId;
}

export function currentTraceparent(): string | undefined {
  const trace = currentTrace();
  return trace ? formatTraceparent(trace) : undefined;
}

/**
 * Headers to attach to an outbound call so the next tier joins this trace (§6.4 step 3 — the
 * one people skip). `{}` outside a trace, so `{ ...outboundHeaders() }` is always safe:
 *
 *   await fetch(url, { headers: { ...outboundHeaders(), 'content-type': 'application/json' } });
 */
export function outboundHeaders(): Readonly<Record<string, string>> {
  const trace = currentTrace();
  if (!trace) return {};
  const headers: Record<string, string> = { traceparent: formatTraceparent(trace) };
  if (trace.tracestate) headers.tracestate = trace.tracestate;
  return headers;
}

/** The provider the Node `createLogger` wires by default: `{ traceId }` when a trace is active. */
export function ambientTraceContext(): LogContext | undefined {
  const traceId = currentTraceId();
  return traceId ? { traceId } : undefined;
}

function resolve(source: TraceSource): TraceContext {
  // An explicit, valid header always wins; this tier gets its own span within that trace.
  const inbound = readTraceparent(source);
  if (inbound) return childOf(inbound);
  // Nested with no usable header: a child span of the active trace.
  const active = currentTrace();
  if (active) return childOf(active);
  return generateTraceContext();
}

/**
 * Run `fn` inside a trace. Reads `traceparent` from `source` (a header string, a `Request`,
 * an `IncomingMessage`, a `Headers`, a plain headers object or a `TraceContext`), generating a
 * new trace when none is usable. Returns whatever `fn` returns, sync or async.
 */
export function withTrace<T>(fn: () => T): T;
export function withTrace<T>(source: TraceSource, fn: () => T): T;
export function withTrace<T>(sourceOrFn: TraceSource | (() => T), maybeFn?: () => T): T {
  const [source, fn] =
    typeof sourceOrFn === 'function' ? [undefined, sourceOrFn] : [sourceOrFn, maybeFn!];
  return store().run(resolve(source), fn);
}
