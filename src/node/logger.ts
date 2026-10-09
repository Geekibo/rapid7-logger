import { createLogger as createCoreLogger } from '../core/logger.js';
import type { Logger, LoggerOptions } from '../core/types.js';
import { processLifecycle, type Lifecycle } from './lifecycle.js';
import { ambientTraceContext } from './trace.js';

// The Node createLogger (DESIGN §4.1, §7.3): the core logger plus lifecycle flush. The core
// types stay runtime-agnostic; only the Node entry knows about `lifecycle` and `close()`.

export const DEFAULT_LIFECYCLE_TIMEOUT_MS = 2000;

export interface LifecycleOptions {
  /** Bound on the flush each hook runs, in ms. Default 2000, the same as `flush()`. */
  readonly timeoutMs?: number;
}

export interface NodeLoggerOptions extends LoggerOptions {
  /**
   * Flush on SIGTERM, SIGINT and beforeExit, bounded (§7.3). `false` registers nothing.
   * Default `{ timeoutMs: 2000 }`.
   */
  readonly lifecycle?: false | LifecycleOptions;
}

export interface NodeLogger extends Logger {
  /** Remove this logger from the lifecycle hooks and flush it, bounded. Idempotent. */
  close(timeoutMs?: number): Promise<void>;
}

function lifecycleTimeout(options: LifecycleOptions | undefined): number {
  const value = options?.timeoutMs;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : DEFAULT_LIFECYCLE_TIMEOUT_MS;
}

/** Build a Node logger against an explicit registry; tests inject a fake process. */
export function createNodeLogger(options: NodeLoggerOptions, lifecycle: Lifecycle): NodeLogger {
  const { lifecycle: lifecycleOptions, ...coreOptions } = options;
  // The current trace (§6.4) is the default ambient context; an explicit provider replaces it.
  const core = createCoreLogger({
    ...coreOptions,
    contextProvider: options.contextProvider ?? ambientTraceContext,
  });
  let unregister: () => void = () => {};
  if (lifecycleOptions !== false) {
    // createLogger never throws: a registry that fails degrades to "no hooks".
    try {
      unregister = lifecycle.register(core, lifecycleTimeout(lifecycleOptions));
    } catch (cause) {
      try {
        options.onInternalError?.(new Error('lifecycle hooks not installed', { cause }));
      } catch {
        // The user's handler is not allowed to break logging either.
      }
    }
  }
  // The level methods are own arrow properties on the core logger, so copying them is safe;
  // child(), flush() and stats() are forwarded. Children share the dispatcher, so flushing
  // the registered root flushes every child.
  return {
    trace: core.trace,
    debug: core.debug,
    info: core.info,
    warn: core.warn,
    error: core.error,
    fatal: core.fatal,
    child: (context) => core.child(context),
    flush: (timeoutMs) => core.flush(timeoutMs),
    stats: () => core.stats(),
    close(timeoutMs) {
      unregister();
      return core.flush(timeoutMs);
    },
  };
}

/** Create a logger (§5.1) with lifecycle flush on this process. Never throws. */
export function createLogger(options: NodeLoggerOptions = {}): NodeLogger {
  return createNodeLogger(options, processLifecycle());
}
