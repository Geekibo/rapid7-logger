import { ConsoleTransport } from '../transports/console.js';
import { resolveConfig, resolveLevel } from './config.js';
import { createRedactor, type Redactor } from './redact.js';
import { isEnabled } from './levels.js';
import type {
  InternalErrorHandler,
  Level,
  LogContext,
  LogErrorInfo,
  LogEvent,
  Logger,
  LoggerOptions,
  LoggerStats,
  LogMethod,
  Transport,
} from './types.js';

const DEFAULT_FLUSH_TIMEOUT_MS = 2000;
const WARN_INTERVAL_MS = 60_000;

/** Mutable counters shared by a logger and every child it spawns (§7.4). */
interface Counters {
  queued: number;
  sent: number;
  dropped: number;
  failed: number;
  retried: number;
  lastError?: string;
}

/** Everything a child shares with its parent. Only the bound context differs between them. */
interface Shared {
  readonly transport: Transport;
  readonly threshold: Level;
  readonly counters: Counters;
  readonly report: InternalErrorHandler;
  readonly redact: Redactor;
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

// The default handler is one rate-limited console.warn, so a persistently broken transport is
// visible somewhere without spamming stdout (§7.4). Construction warnings bypass the limiter:
// they happen once by construction.
function makeReporter(handler: InternalErrorHandler | undefined): InternalErrorHandler {
  if (handler) {
    return (error) => {
      try {
        handler(error);
      } catch {
        // The user's handler is not allowed to break logging either.
      }
    };
  }
  let lastWarnedAt = -Infinity;
  return (error) => {
    const now = Date.now();
    if (now - lastWarnedAt < WARN_INTERVAL_MS) return;
    lastWarnedAt = now;
    try {
      console.warn(`[rapid7-logger] ${error.message}`);
    } catch {
      // Nothing left to report to.
    }
  };
}

function isErrorLike(
  value: unknown,
): value is { name?: unknown; message: unknown; stack?: unknown } {
  if (value instanceof Error) return true;
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.message === 'string' &&
    (typeof candidate.name === 'string' || typeof candidate.stack === 'string')
  );
}

/**
 * Normalise the positional error (§5.2). `Error`'s fields are non-enumerable, so this is the
 * only place that reads them explicitly; anything downstream sees a plain object.
 */
export function normaliseError(value: unknown): LogErrorInfo {
  if (isErrorLike(value)) {
    const candidate = value as {
      name?: unknown;
      message: unknown;
      stack?: unknown;
      digest?: unknown;
    };
    const info: { -readonly [K in keyof LogErrorInfo]: LogErrorInfo[K] } = {
      name: typeof candidate.name === 'string' ? candidate.name : 'Error',
      message: String(candidate.message),
    };
    if (typeof candidate.stack === 'string') info.stack = candidate.stack;
    if (typeof candidate.digest === 'string') info.digest = candidate.digest;
    return info;
  }
  return { name: 'Error', message: errorMessage(value) };
}

/** Resolve the `LogMethod` overloads. `args` is everything after the message. */
function splitArgs(args: readonly unknown[]): { error?: LogErrorInfo; context: LogContext } {
  const [second, third] = args;
  if (args.length >= 2 || (args.length === 1 && isErrorLike(second))) {
    return {
      error: normaliseError(second),
      context: (third as LogContext | undefined) ?? {},
    };
  }
  return { context: (second as LogContext | undefined) ?? {} };
}

function bounded(work: Promise<void>, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    work.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      () => {
        clearTimeout(timer);
        resolve();
      },
    );
  });
}

class CoreLogger implements Logger {
  readonly trace: LogMethod;
  readonly debug: LogMethod;
  readonly info: LogMethod;
  readonly warn: LogMethod;
  readonly error: LogMethod;
  readonly fatal: LogMethod;

  constructor(
    private readonly shared: Shared,
    private readonly context: LogContext,
  ) {
    this.trace = (message: string, ...rest: unknown[]) => this.emit('trace', message, rest);
    this.debug = (message: string, ...rest: unknown[]) => this.emit('debug', message, rest);
    this.info = (message: string, ...rest: unknown[]) => this.emit('info', message, rest);
    this.warn = (message: string, ...rest: unknown[]) => this.emit('warn', message, rest);
    this.error = (message: string, ...rest: unknown[]) => this.emit('error', message, rest);
    this.fatal = (message: string, ...rest: unknown[]) => this.emit('fatal', message, rest);
  }

  child(context: LogContext): Logger {
    return new CoreLogger(this.shared, { ...this.context, ...context });
  }

  flush(timeoutMs: number = DEFAULT_FLUSH_TIMEOUT_MS): Promise<void> {
    let work: Promise<void>;
    try {
      work = this.shared.transport.flush(timeoutMs);
    } catch (cause) {
      this.fail('flush threw', cause);
      return Promise.resolve();
    }
    return bounded(work, timeoutMs);
  }

  stats(): LoggerStats {
    return { ...this.shared.counters };
  }

  private emit(level: Level, message: string, rest: readonly unknown[]): void {
    if (!isEnabled(level, this.shared.threshold)) return;
    const { error, context } = splitArgs(rest);
    const event: LogEvent = {
      timestamp: new Date(),
      level,
      message,
      context: { ...this.context, ...context },
      ...(error ? { error } : {}),
    };
    // Redaction runs here, before anything can buffer, format or print the event (invariant
    // 9). The redactor is total; if it ever throws anyway, the event is dropped, not leaked.
    let redacted: LogEvent;
    try {
      redacted = this.shared.redact(event);
    } catch (cause) {
      this.fail('redaction threw; event dropped', cause);
      return;
    }
    // Direct delivery for now; #9 replaces this with the bounded queue. A transport that
    // violates its never-throw contract must still not reach the caller (invariant 3).
    try {
      this.shared.transport.send(redacted).catch((cause: unknown) => {
        this.fail('transport.send rejected', cause);
      });
    } catch (cause) {
      this.fail('transport.send threw', cause);
    }
  }

  private fail(what: string, cause: unknown): void {
    this.shared.counters.failed += 1;
    this.shared.counters.lastError = errorMessage(cause);
    this.shared.report(new Error(`${what}: ${errorMessage(cause)}`, { cause }));
  }
}

function resolveTransport(options: LoggerOptions, report: InternalErrorHandler): Transport {
  if (options.transport) return options.transport;
  const config = resolveConfig(options.token, options.region);
  if (!config.ok) {
    report(new Error(config.problem));
    return new ConsoleTransport();
  }
  // A valid token and region. The webhook transport (#11) is wired in here by #15; until then
  // a configured logger also prints to the console, without a warning.
  return new ConsoleTransport();
}

const identity: Redactor = (event) => event;

function rootContext(options: LoggerOptions): LogContext {
  const context: Record<string, unknown> = {};
  if (options.service !== undefined) context.service = options.service;
  if (options.env !== undefined) context.env = options.env;
  return context;
}

/** Create a logger (§5.1). Never throws: a bad configuration degrades to console-only. */
export function createLogger(options: LoggerOptions = {}): Logger {
  const report = makeReporter(options.onInternalError);
  const counters: Counters = { queued: 0, sent: 0, dropped: 0, failed: 0, retried: 0 };
  try {
    const { level, problem } = resolveLevel(options.level);
    if (problem) report(new Error(problem));
    const transport = resolveTransport(options, report);
    const redact = options.redact === false ? identity : createRedactor(options.redact ?? {});
    return new CoreLogger(
      { transport, threshold: level, counters, report, redact },
      rootContext(options),
    );
  } catch (cause) {
    report(
      new Error(`createLogger failed; logging to the console only: ${errorMessage(cause)}`, {
        cause,
      }),
    );
    return new CoreLogger(
      {
        transport: new ConsoleTransport(),
        threshold: 'info',
        counters,
        report,
        redact: createRedactor(),
      },
      {},
    );
  }
}
