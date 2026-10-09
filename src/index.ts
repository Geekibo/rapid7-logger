// Node entry point (DESIGN §4.1). Lifecycle flush and the webhook wiring land in #15.
export { createLogger } from './core/logger.js';
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
