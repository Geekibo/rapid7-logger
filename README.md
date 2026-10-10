# @geekibo/rapid7-logger

Reliable **Rapid7 InsightOps** logging for **Node.js** and **Next.js**, including the Edge
runtime.

```sh
npm install @geekibo/rapid7-logger
```

- Node 20.9 or later. **Zero runtime dependencies.** TypeScript types included.
- ESM and CommonJS for the Node and Next entry points; ESM only for `/edge`.
- Published from CI through npm trusted publishing, with provenance.

> **`0.x`:** the delivery contract below is the promise. `1.0.0` follows once it has held under
> real traffic for a sustained period. The `Transport` interface and the `format` callback are
> the surfaces most likely to change before then.

## Why this exists

**There is no maintained JavaScript client for Rapid7 InsightOps.** As of October 2026:

| Package | Latest | Last publish | |
|---|---|---|---|
| `r7insight_node` | 3.3.1 | 2022-06-23 | Rapid7's own client, four years stale |
| `le_node` | 1.8.0 | 2018-10-25 | Logentries-era, abandoned |
| `winston-logentries` | 3.0.0 | 2016-11-14 | Deprecated by its author |

None of them know about Next.js: Server Components, Server Actions, the Edge runtime, or
runtimes that freeze the instant a response is returned.

**And the existing transport loses data silently.** Those clients push events over a long-lived
TCP socket through a buffer that **drops isolated, low-frequency events**: a lone line sits in
the socket buffer and is only pushed out by later traffic. Logging looks healthy under load and
fails precisely when a quiet service emits the one error you needed to see.

This package uses the **HTTP webhook** instead, one event per request. A lone event arrives in
about a second.

## Quick start

```ts
import { createLogger } from '@geekibo/rapid7-logger';

export const log = createLogger({
  token: process.env.RAPID7_TOKEN, // absent ⇒ console-only, never throws
  region: process.env.RAPID7_REGION ?? 'eu',
  service: 'my-app',
  env: process.env.APP_ENV ?? 'local',
  level: 'info',
});

log.info('Order placed', { orderId: 42 });
log.error('Export failed', err, { orderId: 42 }); // an Error is a first-class argument

const reqLog = log.child({ userId }); // bound context, inherited by every line
await log.flush(2000); // bounded, explicit
```

The Node entry flushes on `SIGTERM`, `SIGINT` and `beforeExit`, and adds `close()` for an
explicit shutdown. Without a token, or with a malformed one, the logger writes to the console
and warns once; it never throws.

## Capturing console output

You don't have to replace every `console.error`. Opt in and the calls you already have get a
level, the trace stamp and redaction:

```ts
import { createLogger, captureConsole } from '@geekibo/rapid7-logger';

export const log = createLogger({ token: process.env.RAPID7_TOKEN, service: 'my-app' });
const restore = captureConsole(log); // warn → warn, error → error; restore() undoes it
```

By default only `console.warn` and `console.error` forward, and the original method still runs
so stdout and your platform's log viewer see the line as before. `levels: { log: 'info' }`
forwards `console.log` too; `passthrough: false` makes the logger the only output. A leading
string is the message (with `%s`/`%d`/`%j` interpolation), an `Error` argument becomes the
error, plain objects become context, so redaction applies to them. In Next, call it once in
`instrumentation.ts`'s `register()`. The console fallback and the logger's own warnings always
write through the original methods, so capturing with no token configured does not loop.

## Next.js

```ts
// instrumentation.ts — runs under both NEXT_RUNTIME values
import type { Instrumentation } from 'next';
import { createLogger, createRequestErrorHandler } from '@geekibo/rapid7-logger/next';

const log = createLogger({ token: process.env.RAPID7_TOKEN, service: 'my-app' });

export const onRequestError: Instrumentation.onRequestError = createRequestErrorHandler(log);
```

One `error` line per escaped error, carrying the path, method, route type and the `digest`
that correlates it with what the browser saw, then a bounded flush before the runtime can
freeze. It only sees errors that *escape*: it is a safety net, not a substitute for logging at
call sites. The `/next` entry imports nothing Node-specific, so it runs on the Edge runtime too.

```ts
// a Server Action
'use server';
import { withLogging } from '@geekibo/rapid7-logger/next';
import { log } from '@/lib/log';

export const placeOrder = withLogging(log, 'placeOrder', async (log, id: number) => {
  log.info('placing', { id });
  return api.place(id);
});
```

```ts
// a Route Handler: the trace id comes from the request's traceparent header
export const GET = withLogging(log, 'listOrders', async (log, req: Request) => {
  log.info('listing');
  return Response.json(await db.orders());
});
```

`withLogging` logs start, outcome and duration under one trace id, logs a thrown error and
rethrows it unchanged, then schedules the flush with `after()` from `next/server`, falling back
to an inline flush when `after()` is unavailable. Nothing is lost when the runtime freezes after
the response. `flushMode: 'sync'` awaits delivery instead; `flushMode: 'none'` leaves it to you.

A complete App Router app, with `instrumentation.ts`, a Server Action, a Route Handler and an
Edge route, each with a deliberate error and what it produces, is in
[`examples/nextjs-app`](examples/nextjs-app).

### Edge runtime

The Edge runtime has no reliable background timer, so `/edge` sends every line immediately and
`flush()` is the promise that settles when they have all been posted.

```ts
import { createLogger } from '@geekibo/rapid7-logger/edge'; // ESM only

const log = createLogger({ token: process.env.RAPID7_TOKEN, service: 'edge-fn' });

export default async function handler(req: Request, ctx: { waitUntil(p: Promise<unknown>): void }) {
  log.info('hit', { path: new URL(req.url).pathname }); // posted at once
  ctx.waitUntil(log.flush()); // or: await log.flush(); or Next's after()
  return new Response('ok');
}
```

The cost is latency per line: an awaited `flush()` holds the response for as long as the
slowest POST, while `after()` or `waitUntil` hides it. In a Next Edge route combine
`createLogger` from `/edge` with `withLogging` from `/next`. The `/edge` entry does not import
`server-only`, because that import throws at load outside Next; a Next app adds it in its own
server module.

## Correlation

One click in Rapid7 should show every line a request produced, across tiers. The logger uses
[W3C Trace Context](https://www.w3.org/TR/trace-context/), so the id it stamps is the one
Application Insights and OpenTelemetry already use.

```ts
import { createLogger, withTrace, outboundHeaders } from '@geekibo/rapid7-logger';

export const log = createLogger({ token: process.env.RAPID7_TOKEN, service: 'web' });

// 1. At the top of a request: read the inbound traceparent, or start a new trace.
export async function handle(req: Request) {
  return withTrace(req, async () => {
    log.info('request received'); // 2. every line, from any logger, is stamped
    const data = await loadFromApi(); //    no plumbing, no child(), no arguments
    return Response.json(data);
  });
}

// 3. Outbound: forward the trace so the next tier logs the same id.
async function loadFromApi() {
  const res = await fetch('https://api.internal/orders', {
    headers: { ...outboundHeaders(), accept: 'application/json' },
  });
  return res.json();
}
```

Every line inside `withTrace` carries the stamp `<trace-id>: _ `, which is the exact form
Rapid7's viewer renders as a clickable pivot. Clicking it shows every entry from this tier, and
from the API tier too once it logs the `traceparent` it received. `outboundHeaders()` returns
`{}` outside a trace, so spreading it is always safe. `currentTraceId()` gives you the id for a
response header or an error page.

The trace lives in `AsyncLocalStorage`, which the Edge runtime lacks. There, pass it
explicitly with `log.child({ traceId })` or a per-call `{ traceId }`, or supply a
`contextProvider`.

## The token never reaches the browser

The ingestion token is a **write credential**: anyone holding it can write anything into your
log estate. So the package is server-only, and that is enforced rather than documented:

- `@geekibo/rapid7-logger/next` begins with `import 'server-only'`. Importing it from a
  Client Component is a **build error** under both Turbopack and webpack.
- Pass the token from a plain server variable such as `RAPID7_TOKEN`. **Never** from a
  `NEXT_PUBLIC_*` variable, which Next inlines into the client bundle. The package itself reads
  no environment variables at all.
- Nothing in the package touches `window`, `document` or `navigator`.
- Keys that look like credentials (`password`, `secret`, `token`, `apiKey`, `authorization`,
  `cookie`, …), `Bearer`/`Basic` credentials and bare JWTs in values are **redacted by default**, in nested objects too, before anything
  is formatted or buffered. `redact: false` turns it off; `redact: { keys, patterns }` extends
  it.

The sanctioned way to get a browser error into Rapid7 is a **Route Handler**: the browser posts
`{ message, stack, digest }`, the handler logs it, and the token stays on the server.

```ts
// app/api/client-error/route.ts
import { withLogging } from '@geekibo/rapid7-logger/next';
import { log } from '@/lib/log';

export const POST = withLogging(log, 'clientError', async (log, req: Request) => {
  const { message, stack, digest } = (await req.json()) as { message?: string; stack?: string; digest?: string };
  log.error('Client error', { name: 'ClientError', message: String(message), stack, digest });
  return new Response(null, { status: 204 });
});
```

```ts
// app/error.tsx — a Client Component, so it must not import the logger
'use client';
export default function Error({ error }: { error: Error & { digest?: string } }) {
  void fetch('/api/client-error', {
    method: 'POST',
    body: JSON.stringify({ message: error.message, stack: error.stack, digest: error.digest }),
  });
  return <p>Something went wrong.</p>;
}
```

Outside Next, the `/next` entry's `server-only` import fails to resolve by design. Use
`@geekibo/rapid7-logger` there.

## The delivery contract

Stated up front, because vague guarantees are how people come to build alerting on a logger that
cannot support it.

| | |
|---|---|
| **Delivery** | **At-least-once.** Up to 3 attempts on `5xx`/`408`/`429` and network errors (including a 10 s per-attempt timeout), backing off 200 ms then 400 ms, or as long as `Retry-After` asks, capped at 30 s. Other `4xx` are not retried. The endpoint has no dedup, so a lost acknowledgement **can produce a duplicate**. |
| **Never throws** | `send()` never throws and never rejects. A logging failure never fails a user's request. |
| **Bounded** | Queue of 10,000 events; overflow **drops** and increments a counter. It never blocks your application. |
| **Bounded flush** | `flush(timeoutMs)` returns when the timeout elapses, drained or not. No hung shutdowns. |
| **`204` ≠ delivered** | A malformed token or an unknown region is caught at startup and falls back to console-only. But the endpoint answers `204` to a well-formed *wrong* token or the wrong region, and discards the events. Search for your first events after deploying. |
| **Not durable** | A hard crash loses whatever is buffered in memory. If you need durability you need a different architecture: stdout plus a cluster collector. |
| **Server-only** | No browser entry point. Importing the Next entry from a Client Component is a build error. |

## Configuration

Every option is optional. Invalid values fall back to the default with one warning.

| Option | Default | |
|---|---|---|
| `token` | | InsightOps ingestion token. Absent or malformed ⇒ console-only. |
| `region` | `'eu'` | `'eu'`, `'us'`, `'au'`, `'ca'` or `'jp'`. |
| `service`, `env` | | Stamped on every line as `service=…` and `env=…`. |
| `level` | `'info'` | Minimum level: `trace`, `debug`, `info`, `warn`, `error`, `fatal`. |
| `redact` | on | `false` to disable; `{ keys, patterns }` to extend. |
| `maxBytes` | `32767` | Line byte cap, matching the endpoint's; longer lines are truncated with a marker. |
| `format` | | `(event) => string` to replace the line format entirely. |
| `contextProvider` | | `() => LogContext` read at log time; the Node entry wires it to the current trace. |
| `onInternalError` | | Called when the logger itself fails. Default: a rate-limited `console.warn`. |
| `transport` | | Deliver to your own `Transport` instead of the webhook. |
| `fetch` | global | The `fetch` the webhook transport uses. |
| `batchSize` | `50` | Events one drain pass takes from the queue. |
| `flushIntervalMs` | `2000` | Wait after a partial pass before the next. |
| `queueLimit` | `10000` | Queued events beyond which new ones are dropped. |
| `maxConcurrency` | `8` | In-flight sends at once. |

The Node entry also accepts `lifecycle` to adjust or disable the signal hooks. The `/edge`
entry sends immediately, so the four queue options are inert there apart from `queueLimit`,
which bounds the sends in flight.

### Logger

| | |
|---|---|
| `log.trace/debug/info/warn/error/fatal(message, [error], [context])` | Return `void`; never throw. |
| `log.child(context)` | A logger with `context` merged into every line. |
| `log.flush(timeoutMs = 2000)` | Resolves when drained or when the timeout elapses. Never rejects. |
| `log.stats()` | `{ queued, sent, dropped, failed, retried, lastError? }`. Alert on `dropped` and `failed`. |
| `log.close(timeoutMs)` | Node entry only: flush, then detach the signal hooks. |

Each line is `[HH:mm:ss LVL] <trace-id>: _ message key=value …`, and never contains a newline:
`\r\n` and `\n` are flattened to spaces, because the endpoint truncates at the first newline
and shreds the rest into unrelated entries.

### Also exported

`Rapid7WebhookTransport`, `ConsoleTransport` and `MemoryTransport` (useful in tests),
`formatEvent`, `createRedactor`, the W3C helpers (`parseTraceparent`, `generateTraceparent`,
`childOf`, …), and the `LEVELS` and `REGIONS` constants. All types are exported.

## What the endpoint actually does

The InsightOps webhook's behaviour was established by posting to it, and none of it is in the
vendor documentation. It is useful whatever language you integrate from:

- **`/v1/noformat` does not accept a newline-delimited batch.** One event per request, with no
  interior newlines, or stack traces get truncated or shredded into unrelated entries.
- **A lone POST is ingested in about a second**, which is what fixes the TCP drop above.
- **`204 No Content`** on success, and also for a **wrong token or the wrong region**. A
  well-formed but invalid token is accepted and silently discarded.
- **Entries are capped at 32,767 bytes.** Up to 64 KiB the endpoint still answers `204` but
  splits the line into several entries, breaking any multi-byte character at the split; beyond
  that it answers `413`.
- The viewer only renders a correlation id as **clickable** when it parses as the *key* of a
  key/value pair, so the stamp has to be `<id>: _ `, with a literal underscore as the value.

[docs/DESIGN.md](docs/DESIGN.md) has the measurements behind each of these, and the full
design.

## A note on InsightOps

Rapid7's InsightOps documentation carries a banner stating the product "is no longer sold."
Existing customers still run on it and the ingestion endpoint is live, but it is a product in
sustaining mode. That shapes the architecture rather than the decision: the wire protocol sits
behind a small `Transport` interface, so targeting a different backend later is an additive
change, not a rewrite.

## Contributing

Pull requests are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md). The tests run without any
credentials, and a security problem goes through
[private vulnerability reporting](https://github.com/Geekibo/rapid7-logger/security/advisories/new),
not a public issue.

## Licence

[MIT](LICENSE)
