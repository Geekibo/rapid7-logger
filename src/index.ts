// Node entry point (DESIGN §4.1). Lifecycle flush and the webhook wiring land in #15.
export { createLogger } from './core/logger.js';
export { formatEvent } from './core/formatter.js';
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
  Transport,
} from './core/types.js';
