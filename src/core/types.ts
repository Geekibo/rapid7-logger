// The core's public types (DESIGN §4.3, §5.1, §5.2, §7.4). Runtime-agnostic: nothing here may
// reference a Node or browser type.

export type Level = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export type Region = 'eu' | 'us' | 'au' | 'ca' | 'jp';

export type LogContext = Readonly<Record<string, unknown>>;

/** The normalised form of the positional `Error` argument (§5.2). */
export interface LogErrorInfo {
  readonly name: string;
  readonly message: string;
  readonly stack?: string;
  /** Next.js attaches a digest to errors thrown from Server Components and Actions (§6.1). */
  readonly digest?: string;
}

// LogEvent and Transport are the seam between the core and any backend (§4.3). Keep them exactly
// as the design states them: a future transport must be additive, not a rewrite.

export interface LogEvent {
  readonly timestamp: Date;
  readonly level: Level;
  readonly message: string;
  readonly context: LogContext;
  readonly error?: LogErrorInfo;
}

/**
 * What a transport may report back from `send` (#9). Optional and additive: a transport that
 * resolves `void` is counted as delivered. A transport that gives up after retries (§7.1) must
 * still resolve, so this is how it says the event was not delivered.
 */
export interface SendOutcome {
  readonly delivered: boolean;
  /** Attempts beyond the first. */
  readonly retries?: number;
  readonly error?: string;
}

export interface Transport {
  /** Deliver one event. MUST NOT throw. MUST resolve even on permanent failure. */
  send(event: LogEvent): Promise<void | SendOutcome>;
  /** Best-effort drain of anything buffered inside the transport. */
  flush(timeoutMs?: number): Promise<void>;
}

/** What the logger can report about itself (§7.4). */
export interface LoggerStats {
  readonly queued: number;
  readonly sent: number;
  readonly dropped: number;
  readonly failed: number;
  readonly retried: number;
  readonly lastError?: string;
}

/** Turns an event into the single physical line a transport posts (§5.3). Never throws. */
export type LineFormatter = (event: LogEvent) => string;

export interface FormatterOptions {
  /**
   * Full line override (§5.3). Its output is still flattened and truncated — one event per
   * request and no interior newlines are correctness, not style. A throw or a non-string
   * return falls back to the default line.
   */
  readonly format?: (event: LogEvent) => string;
  /** Cap on the UTF-8 byte length of the line, marker included (§5.4). Default 32,767. */
  readonly maxBytes?: number;
  /** Context key whose string value becomes the clickable stamp (§2.5). Default `traceId`. */
  readonly correlationKey?: string;
}

/** Receives the logger's own failures. The default is one rate-limited `console.warn`. */
export type InternalErrorHandler = (error: Error) => void;

/**
 * Redaction options (§6.6). `keys` and `patterns` extend the defaults unless `defaults` is
 * `false`. A key matches case-insensitively as a substring once `-`, `_` and whitespace are
 * removed; a pattern is applied to every string in the event.
 */
export interface RedactOptions {
  readonly keys?: readonly string[];
  readonly patterns?: readonly RegExp[];
  /** Default `'[redacted]'`. */
  readonly replacement?: string;
  /** Set `false` to drop the built-in keys and patterns. Default `true`. */
  readonly defaults?: boolean;
}

// `Level | (string & {})` keeps autocomplete for the known values while accepting the plain
// string an environment variable gives you. Unknown values are validated at construction.
export interface LoggerOptions {
  /** The log's ingestion token. Absent, empty or malformed ⇒ console-only, one warning, no throw. */
  readonly token?: string;
  /** Default `eu`. Unknown ⇒ console-only, one warning. */
  readonly region?: Region | (string & {});
  /** Stamped on every event as `service=…`. */
  readonly service?: string;
  /** Stamped on every event as `env=…`. */
  readonly env?: string;
  /** Minimum level to emit. Default `info`. Unknown ⇒ `info`, one warning. */
  readonly level?: Level | (string & {});
  /** Bypass token resolution and deliver to this transport instead. */
  readonly transport?: Transport;
  /** The `fetch` the webhook transport uses. Defaults to the global one. Ignored with `transport`. */
  readonly fetch?: typeof fetch;
  /**
   * Ambient context read at log time (§6.4), merged between bound and per-call context:
   * per-call > ambient > bound. The Node entry wires this to the current trace by default;
   * on a runtime with no `AsyncLocalStorage` it is the hook for explicit passing. A throw is
   * reported and the event ships without ambient keys.
   */
  readonly contextProvider?: () => LogContext | undefined;
  readonly onInternalError?: InternalErrorHandler;
  /** Full line override (§5.3). Passed to the transport. */
  readonly format?: (event: LogEvent) => string;
  /** Line byte cap (§5.4). Passed to the transport. */
  readonly maxBytes?: number;
  /** On by default (§6.6). `false` disables redaction entirely. */
  readonly redact?: RedactOptions | false;
  // Queue options (§7.2). Invalid values fall back to the default with one warning. The Edge
  // entry (§6.3) sends immediately: there `queueLimit` bounds the sends in flight and the other
  // three are accepted and inert.
  /** Events one drain pass takes from the queue. Default 50. */
  readonly batchSize?: number;
  /** Wait after a partial pass before the next, in ms. Default 2000; `0` never waits. */
  readonly flushIntervalMs?: number;
  /** Queued events beyond which new ones are dropped. Default 10,000. */
  readonly queueLimit?: number;
  /** In-flight sends at once. Default 8. */
  readonly maxConcurrency?: number;
}

/**
 * `Error` is a positional second argument (§5.2): `log.error('Export failed', err, { id })`.
 * With two arguments, an `Error` (or anything error-shaped) is the error; anything else is
 * context.
 */
export interface LogMethod {
  (message: string, context?: LogContext): void;
  (message: string, error: unknown, context?: LogContext): void;
}

export interface Logger {
  readonly trace: LogMethod;
  readonly debug: LogMethod;
  readonly info: LogMethod;
  readonly warn: LogMethod;
  readonly error: LogMethod;
  readonly fatal: LogMethod;
  /** A new logger whose context is this one's merged with `context`. */
  child(context: LogContext): Logger;
  /** Bounded: resolves when drained or when `timeoutMs` (default 2000) elapses. Never rejects. */
  flush(timeoutMs?: number): Promise<void>;
  stats(): LoggerStats;
}
