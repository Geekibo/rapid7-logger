// Next.js entry point (DESIGN §6). Runs under both NEXT_RUNTIME values, so it imports from the
// core only — never from src/index or src/node (invariant 8; enforced by ESLint, the build and
// CI). `import 'server-only'` lands in #20. `withLogging` reaches `after()` through a dynamic
// `import('next/server')` — keep it dynamic, and keep `src/next/next-server.d.ts` out of dist.
//
// `createLogger` here is the core one: no process lifecycle hooks (there is no process to hook
// on Edge) and no ambient trace from AsyncLocalStorage. For a Node-only Next app that wants
// those, import from '@geekibo/rapid7-logger' instead.
export { createLogger } from './core/logger.js';
export {
  withLogging,
  type AfterScheduler,
  type FlushMode,
  type LoggedFunction,
  type WithLoggingOptions,
} from './next/with-logging.js';
export {
  createRequestErrorHandler,
  type RequestErrorContext,
  type RequestErrorHandler,
  type RequestErrorHandlerOptions,
  type RequestErrorRequest,
  type RouteType,
} from './next/request-error.js';
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
