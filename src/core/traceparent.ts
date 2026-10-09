// W3C Trace Context (DESIGN §6.4), the pure half: parse, format and generate `traceparent`,
// and read one from whatever carries headers. No imports and only the global `crypto`, so the
// same code serves the Node entry and the Edge entry's explicit-passing fallback.
//
//   traceparent: 00-<32 hex trace-id>-<16 hex parent-id>-<2 hex flags>

export interface TraceContext {
  /** 32 lowercase hex characters; never all zeros. */
  readonly traceId: string;
  /** 16 lowercase hex characters; never all zeros. The span of the tier that logged. */
  readonly parentId: string;
  /** 2 lowercase hex characters. `01` = sampled. */
  readonly flags: string;
  /** Opaque vendor data, forwarded unchanged when present. */
  readonly tracestate?: string;
}

/** Anything a trace can be read from: a raw header, a context, headers, or something with headers. */
export type TraceSource =
  | string
  | TraceContext
  | { get(name: string): string | null | undefined }
  | { headers: unknown }
  | Readonly<Record<string, string | string[] | undefined>>
  | null
  | undefined;

const TRACEPARENT = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})(-.*)?$/;
const ZERO_TRACE = '0'.repeat(32);
const ZERO_PARENT = '0'.repeat(16);
export const SAMPLED = '01';

/**
 * Parse a `traceparent` the way OpenTelemetry's propagator does: case-insensitive, lower-cased
 * output, version `ff` invalid, version `00` must have exactly four fields, a higher version
 * may carry extra fields, and all-zero ids are invalid. `undefined` for anything else.
 */
export function parseTraceparent(header: unknown, tracestate?: unknown): TraceContext | undefined {
  if (typeof header !== 'string') return undefined;
  const match = TRACEPARENT.exec(header.trim().toLowerCase());
  if (!match) return undefined;
  const [, version, traceId, parentId, flags, extra] = match;
  if (version === 'ff') return undefined;
  if (version === '00' && extra !== undefined) return undefined;
  if (traceId === ZERO_TRACE || parentId === ZERO_PARENT) return undefined;
  const context: { -readonly [K in keyof TraceContext]: TraceContext[K] } = {
    traceId: traceId!,
    parentId: parentId!,
    flags: flags!,
  };
  if (typeof tracestate === 'string' && tracestate.trim() !== '') {
    context.tracestate = tracestate.trim();
  }
  return context;
}

export function formatTraceparent(context: TraceContext): string {
  return `00-${context.traceId}-${context.parentId}-${context.flags}`;
}

function randomHex(bytes: number): string {
  const buffer = new Uint8Array(bytes);
  const cryptoApi = (globalThis as { crypto?: { getRandomValues?(array: Uint8Array): Uint8Array } })
    .crypto;
  if (cryptoApi?.getRandomValues) {
    cryptoApi.getRandomValues(buffer);
  } else {
    for (let i = 0; i < bytes; i++) buffer[i] = Math.floor(Math.random() * 256);
  }
  let hex = '';
  for (const byte of buffer) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

function nonZeroHex(bytes: number): string {
  for (;;) {
    const hex = randomHex(bytes);
    if (!/^0+$/.test(hex)) return hex;
  }
}

/** A new root trace, sampled. */
export function generateTraceContext(): TraceContext {
  return { traceId: nonZeroHex(16), parentId: nonZeroHex(8), flags: SAMPLED };
}

export function generateTraceparent(): string {
  return formatTraceparent(generateTraceContext());
}

/** The same trace, a new span for this tier. */
export function childOf(parent: TraceContext): TraceContext {
  return { ...parent, parentId: nonZeroHex(8) };
}

function isHeadersLike(value: unknown): value is { get(name: string): string | null | undefined } {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { get?: unknown }).get === 'function'
  );
}

function isTraceContext(value: unknown): value is TraceContext {
  if (typeof value !== 'object' || value === null) return false;
  const c = value as Record<string, unknown>;
  return (
    typeof c.traceId === 'string' && typeof c.parentId === 'string' && typeof c.flags === 'string'
  );
}

function headerValue(source: object, name: string): unknown {
  if (isHeadersLike(source)) return source.get(name);
  const record = source as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key.toLowerCase() === name) {
      const value = record[key];
      return Array.isArray(value) ? value[0] : value;
    }
  }
  return undefined;
}

/** Read a valid trace from a source, or `undefined`. Never throws. */
export function readTraceparent(source: TraceSource): TraceContext | undefined {
  try {
    if (source === null || source === undefined) return undefined;
    if (typeof source === 'string') return parseTraceparent(source);
    if (isTraceContext(source))
      return parseTraceparent(formatTraceparent(source), source.tracestate);
    const carrier = 'headers' in source && !isHeadersLike(source) ? source.headers : source;
    if (typeof carrier !== 'object' || carrier === null) return undefined;
    return parseTraceparent(
      headerValue(carrier, 'traceparent'),
      headerValue(carrier, 'tracestate'),
    );
  } catch {
    return undefined;
  }
}
