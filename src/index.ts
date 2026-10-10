// Node entry point (DESIGN §4.1): the core plus lifecycle flush (§7.3). Node-only code lives
// under src/node/; the Edge and Next entries import from the core, never from here.
export {
  createLogger,
  type LifecycleOptions,
  type NodeLogger,
  type NodeLoggerOptions,
} from './node/logger.js';
export {
  currentTrace,
  currentTraceId,
  currentTraceparent,
  outboundHeaders,
  withTrace,
} from './node/trace.js';
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
export {
  captureConsole,
  type ConsoleCaptureMethod,
  type ConsoleCaptureOptions,
  type ConsoleCaptureTarget,
  type RestoreConsole,
} from './core/console-capture.js';
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
