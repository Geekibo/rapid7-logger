# @geekibo/rapid7-logger

Reliable **Rapid7 InsightOps** logging for **Node.js** and **Next.js**.

> ### ⚠️ Pre-release — not yet published
> This repository currently contains the **design** and the issue backlog. There is no
> publishable package yet, and `npm install @geekibo/rapid7-logger` will not work until `0.1.0`
> ships. Follow [the issues](https://github.com/Geekibo/rapid7-logger/issues) for progress.
> The full design lives in **[docs/DESIGN.md](docs/DESIGN.md)**.

---

## Why this exists

**There is no maintained JavaScript library for shipping logs to Rapid7 InsightOps.** Checked
against the npm registry on 2026-10-08:

| Package | Latest | Last publish | |
|---|---|---|---|
| `r7insight_node` | 3.3.1 | **2022-06-23** | Rapid7's own client — 4 years stale |
| `le_node` | 1.8.0 | **2018-10-25** | Logentries-era, abandoned |
| `winston-logentries` | 3.0.0 | **2016-11-14** | Marked **deprecated** by its author |
| `winston-r7insight` · `pino-insightops` | — | — | Do not exist |

Nothing targets Next.js. Nothing understands Server Components, Server Actions, the Edge
runtime, or the serverless freeze problem — all of which change what a correct logger has to do.

**And the incumbent transport loses data silently.** The existing clients push events over a
long-lived TCP socket, through a buffer that **drops isolated, low-frequency events**: a lone log
line sits in the socket buffer and is only flushed out by later traffic. The failure mode inverts
your intuition — logging looks healthy under load and fails precisely when a quiet service emits
the one error you needed to see.

This package uses the **HTTP webhook** instead, one event per request. A lone event arrives in
about a second.

## Design in one screen

```ts
import { createLogger } from '@geekibo/rapid7-logger';

export const log = createLogger({
  token:   process.env.RAPID7_TOKEN,   // absent ⇒ console-only, never throws
  region:  process.env.RAPID7_REGION ?? 'eu',
  service: 'my-app',
  env:     process.env.APP_ENV ?? 'local',
  level:   'info',
});

log.info('Survey published', { surveyId: 42 });
log.error('Export failed', err, { surveyId: 42 });   // Error is a first-class argument

const reqLog = log.child({ userId });                // bound context, inherited
await log.flush(2000);                                // bounded, explicit
```

### Next.js

```ts
// instrumentation.ts — runs under both NEXT_RUNTIME values
import type { Instrumentation } from 'next';
import { createLogger, createRequestErrorHandler } from '@geekibo/rapid7-logger/next';

const log = createLogger({ token: process.env.RAPID7_TOKEN, service: 'my-app' });

export const onRequestError: Instrumentation.onRequestError = createRequestErrorHandler(log);
```

One `error` line per escaped error, carrying the path, method, route type and — always — the
`digest` that correlates it with what the browser saw, then a bounded flush before the
runtime can freeze. It only sees errors that *escape*: it is a safety net, not a substitute for
using the logger at call sites. The `/next` entry imports nothing Node-specific, so it works on
the Edge runtime; its `createLogger` has no process lifecycle hooks and no ambient trace.

```ts
// a Server Action
'use server';
import { withLogging } from '@geekibo/rapid7-logger/next';

export const publishSurvey = withLogging('publishSurvey', async (log, id: number) => {
  log.info('publishing', { id });
  return api.publish(id);
});
```

## Correlation

One click in Rapid7 should show every line a request produced, across tiers. The logger uses
[W3C Trace Context](https://www.w3.org/TR/trace-context/) so the id it stamps is the one
Application Insights and OpenTelemetry already use.

```ts
import { createLogger, withTrace, outboundHeaders } from '@geekibo/rapid7-logger';

export const log = createLogger({ token: process.env.RAPID7_TOKEN, service: 'web' });

// 1. At the top of a request: read the inbound traceparent (or start a new trace).
export async function handle(req: Request) {
  return withTrace(req, async () => {
    log.info('request received');              // 2. every line, from any logger, is stamped
    const data = await loadFromApi();          //    … no plumbing, no child(), no arguments
    return Response.json(data);
  });
}

// 3. Outbound — the step people skip, and the one that makes the feature worth having.
async function loadFromApi() {
  const res = await fetch('https://api.internal/surveys', {
    headers: { ...outboundHeaders(), accept: 'application/json' },
  });
  return res.json();
}
```

Every line inside `withTrace` carries the stamp `<trace-id>: _ ` (it has to be exactly that;
see [§2.5](docs/DESIGN.md#25-the-clickable-correlation-trick)), so clicking the id in Rapid7
pivots to every entry from this tier — and from the API tier too, once it logs the same
`traceparent` it received. `outboundHeaders()` returns `{}` outside a trace, so spreading it
is always safe. `currentTraceId()` gives you the id for anything else (a response header, an
error page).

The trace lives in `AsyncLocalStorage`, which the Edge runtime lacks: there, pass it
explicitly — `log.child({ traceId })` or a per-call `{ traceId }` — or wire a `contextProvider`
of your own.

## The delivery contract

Stated up front, because vague guarantees are how people come to build alerting on a logger that
cannot support it.

| | |
|---|---|
| **Delivery** | **At-least-once.** Up to 3 attempts on `5xx`/`408`/`429` and network errors (including a per-attempt 10 s timeout), backing off 200 ms then 400 ms, or as long as a `Retry-After` asks (capped at 30 s). Other `4xx` are not retried. The endpoint has no dedup, so a lost acknowledgement **can produce a duplicate** — relevant if anything downstream counts events. |
| **Never throws** | `send()` never throws and never rejects. A logging failure must never fail a user's request. |
| **Bounded** | Queue of 10,000; overflow **drops** and increments a counter. It will never block your application. |
| **Bounded flush** | `flush(timeoutMs)` returns when the timeout elapses, drained or not. No hung shutdowns. |
| **`204` ≠ delivered** | A malformed token or unknown region is caught at startup and falls back to console-only. But the endpoint answers `204` even to a well-formed *wrong* token or the wrong region, and discards the events. Search for your first events after deploying. |
| **Not durable** | A hard crash loses whatever is buffered in memory. If you need durability you need a different architecture — stdout plus a cluster collector — and this README would rather say so than let you assume. |
| **Server-only** | No browser entry point. The ingestion token is a **write credential**; importing this from a Client Component is a build error. |

## What makes Next.js different

The problem no existing client handles: in a **freeze-after-response** environment the runtime
can suspend the instant you return, so a queued event with a pending 2-second batch timer is
**never delivered** — and nothing, anywhere, reports an error.

The answer is `after()` from `next/server` for post-response flushing, plus an eager flush at
`error` and above, plus `SIGTERM` hooks for containers. See
[§7.3](docs/DESIGN.md#73-flushing--the-nextjs-problem-the-net-package-never-had).

The Edge runtime gets a separate entry point (`/edge`) that sends immediately, because Edge has
no reliable background timer.

## Findings about the endpoint

[§2 of the design](docs/DESIGN.md#2-what-the-endpoint-actually-does) documents the InsightOps
webhook's actual behaviour, verified by posting to it. These are useful whatever language you
integrate from, and none of them appear in the vendor docs:

- **`/v1/noformat` does not accept a newline-delimited batch.** One event per HTTP request, and
  the body must contain no interior newlines, or your stack traces get truncated or shredded into
  unrelated entries.
- **A lone POST is ingested in ~1s** — which is what fixes the TCP drop bug above.
- **`204 No Content`** on success — and also for a **wrong token or the wrong region**. A
  well-formed but invalid token is accepted and silently discarded, so a `204` does not prove
  delivery. ([§2.6](docs/DESIGN.md#26-a-wrong-token-is-not-an-error))
- **Entries are capped at 32,767 bytes.** Up to 64 KiB the endpoint still answers `204` but
  silently splits the line into several separate entries, breaking any multi-byte character at
  the split; beyond that it answers `413`. None of this is documented, so truncate client-side,
  with a marker, before posting.
  ([§5.4](docs/DESIGN.md#54-defensive-truncation))
- Rapid7's viewer only renders a correlation ID as **clickable** when it parses as the *key* of a
  key/value pair — so the stamp has to be `<id>: _ `, with a literal underscore as the value.
  Every character is load-bearing; [§2.5](docs/DESIGN.md#25-the-clickable-correlation-trick)
  explains why.

## One honest caveat

Rapid7's own InsightOps documentation now carries a banner stating the product **"is no longer
sold."** Existing customers still run on it and the ingestion endpoint is live, but this is a
product in sustaining mode. That shapes the architecture rather than the decision: the wire
protocol sits behind a small `Transport` interface, so targeting a different backend later is an
additive change rather than a rewrite.

## Status and roadmap

Work is tracked as issues, phased. [§14](docs/DESIGN.md#14-suggested-phasing) has the detail.

| Phase | |
|---|---|
| 0 | Verify the endpoint contract from Node — **gates everything else** |
| 1–2 | Core (formatter, redaction, bounded queue) and the webhook transport |
| 3–5 | Node, Next.js and Edge entry points |
| 6–7 | Repo hardening, then `0.1.0` to npm |
| 8–9 | Real-world shakedown, then `1.0.0` |

Phase 0 exists because every surprising fact in §2 was found by posting to the endpoint and
looking, and none could have been deduced from the documentation. Measure the thing; don't reason
about the configuration.

## Contributing

Pull requests are welcome. `main` is protected: changes land by reviewed PR with green CI.
Unit tests run with no credentials; the live integration tests are **expected to skip** unless
you supply your own token. Releases are cut by a maintainer via Changesets and published by CI
through npm OIDC trusted publishing — there is no publish token in this repository to steal.

## Licence

[MIT](LICENSE)
