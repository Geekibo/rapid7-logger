// Edge entry point (DESIGN §6.3): the same core over an immediate-send dispatcher, because an
// Edge invocation can be torn down the moment the response is returned and a batching window
// may never elapse. Every level call posts at once; `await log.flush()` or hand it to
// `after()`/`waitUntil`. The trade is latency per line, not configurability.
//
// Imports from src/core and src/transports only — never src/index or src/node (invariant 8;
// ESLint, the tsup plugin and CI's grep all police dist/edge.js). ESM only (§4.2).
//
// Deliberately NO `import 'server-only'` here (§6.5): outside Next, that package throws at
// module evaluation — a Cloudflare Worker importing this entry would die on load. A Next app
// puts the import in its own server module (see examples/nextjs-app/lib/edge-log.ts).
import { createImmediateDispatcher } from './core/immediate.js';
import { composeLogger } from './core/logger.js';
import type { Logger, LoggerOptions } from './core/types.js';

/**
 * Create an immediate-send logger (§6.3). Level methods still return `void`; `flush()` awaits
 * every send started so far, bounded. `batchSize`, `flushIntervalMs` and `maxConcurrency` are
 * accepted and inert; `queueLimit` bounds the sends in flight.
 */
export function createLogger(options: LoggerOptions = {}): Logger {
  return composeLogger(options, createImmediateDispatcher);
}

export { formatEvent } from './core/formatter.js';
export {
  ConsoleTransport,
  type ConsoleTransportOptions,
  type ConsoleLike,
} from './transports/console.js';
export { MemoryTransport, type MemoryTransportOptions } from './transports/memory.js';
export {
  Rapid7WebhookTransport,
  type Rapid7WebhookTransportOptions,
} from './transports/rapid7-webhook.js';
export {
  createRedactor,
  DEFAULT_REDACT_KEYS,
  DEFAULT_REDACT_PATTERNS,
  type Redactor,
} from './core/redact.js';
export { LEVELS, LEVEL_MONIKERS } from './core/levels.js';
export { REGIONS } from './core/config.js';
export {
  childOf,
  formatTraceparent,
  generateTraceContext,
  generateTraceparent,
  parseTraceparent,
  readTraceparent,
  type TraceContext,
  type TraceSource,
} from './core/traceparent.js';
export type {
  FormatterOptions,
  InternalErrorHandler,
  Level,
  LineFormatter,
  LogContext,
  LogErrorInfo,
  LogEvent,
  Logger,
  LoggerOptions,
  LoggerStats,
  LogMethod,
  RedactOptions,
  Region,
  SendOutcome,
  Transport,
} from './core/types.js';
