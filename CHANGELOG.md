# @geekibo/rapid7-logger

## 0.1.1

### Patch Changes

- d3542e4: README rewritten for the npm page: a configuration and API reference, and the development roadmap removed.

## 0.1.0

### Minor Changes

- 1ca5532: Initial release.
  
  - Ships events to the Rapid7 InsightOps HTTP webhook, one event per request, with no interior newlines — the two endpoint rules that the incumbent clients get wrong.
  - A bounded queue that never blocks the caller and drops on overflow; `send()` never throws; `flush(timeoutMs)` is bounded.
  - At-least-once delivery: up to three attempts on `5xx`, `408`, `429` and network failures, honouring `Retry-After`.
  - Redaction of credential-shaped keys and bearer tokens, on by default, before anything is formatted or buffered.
  - A formatter that produces the `[HH:mm:ss LVL] <trace-id>: _ message key=value` line Rapid7 renders with a clickable trace id, truncated under the measured 32,767-byte cap.
  - Node, Next.js and Edge entry points: lifecycle flush on `SIGTERM`/`SIGINT`/`beforeExit`, `createRequestErrorHandler` for `instrumentation.ts`, `withLogging` for Server Actions and Route Handlers with an `after()` flush, and an immediate-send logger for the Edge runtime.
  - W3C Trace Context correlation: `withTrace`, `currentTraceId` and `outboundHeaders` on Node; pure `traceparent` helpers everywhere.
