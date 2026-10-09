# nextjs-app

A Next.js App Router app wired to `@geekibo/rapid7-logger`: `instrumentation.ts`, a Server
Action, a Route Handler — and a deliberate error in each, so you can see what arrives in Rapid7.

## Run it

```sh
# from the repository root, once
npm ci && npm run build

cd examples/nextjs-app
npm install
RAPID7_TOKEN=<your token> npm run dev          # or: npm run build && RAPID7_TOKEN=<your token> npm start
```

| Variable | |
|---|---|
| `RAPID7_TOKEN` | The log's ingestion token. A **write credential**: a plain server variable, never `NEXT_PUBLIC_*` (Next would inline it into the browser bundle). |
| `RAPID7_REGION` | `eu` (default), `us`, `au`, `ca`, `jp`. |
| `APP_ENV` | Stamped as `env=` on every line. Default `local`. |
| `LOG_LEVEL` | Default `info`. |

With no `RAPID7_TOKEN`, everything goes to the console instead, and the build prints
`no token configured; logging to the console only` once per build worker — expected.

The one unusual line is in `next.config.ts`: `turbopack.root` points at the repository root
because the package is installed from `file:../..`, a symlink out of the app. An app installing
from npm does not need it.

## Where the logging is

| File | What |
|---|---|
| `lib/log.ts` | One logger for the app, from `@geekibo/rapid7-logger/next` — Edge-safe, no process hooks |
| `instrumentation.ts` | `onRequestError = createRequestErrorHandler(log)`: every escaped error, both runtimes |
| `app/api/surveys/route.ts` | A Route Handler wrapped in `withLogging`; `?fail=1` throws |
| `app/actions.ts` | Two Server Actions wrapped in `withLogging`; one throws |
| `app/boom/page.tsx` | A Server Component that throws while rendering |
| `app/error.tsx` + `app/api/client-error/route.ts` | The sanctioned client path: the browser posts `{ message, stack, digest }` to a Route Handler |
| `lib/edge-log.ts` + `app/api/edge/route.ts` | An **Edge** Route Handler (`runtime = 'edge'`) using the immediate-send logger from `/edge`, wrapped by `withLogging` from `/next` |

`error.tsx` is a Client Component, so it must not import the logger — that would fail the build.

## What arrives

Observed on 2026-10-09 with `next start` (Node runtime), lines shortened after the first stack
frame. Every line below is one entry in Rapid7; a 32-character id before the message is the
clickable trace id.

**Startup** (`register()` in `instrumentation.ts`):

```
[16:58:53 INF] server starting service=nextjs-app env=local runtime=nodejs
```

**`GET /api/surveys`** with a `traceparent` header — the Route Handler inherits the trace:

```
[16:58:58 INF] 0af7651916cd43dd8448eb211c80319c: _ listing service=nextjs-app env=local operation=listSurveys count=2
[16:58:58 INF] 0af7651916cd43dd8448eb211c80319c: _ listSurveys completed service=nextjs-app env=local operation=listSurveys durationMs=2
```

**`GET /api/surveys?fail=1`** — `withLogging` logs the failure and rethrows; `onRequestError`
sees it as `routeType=route`. Note: **Next assigns no digest to Route Handler errors**; the
shared trace id is what correlates the two lines.

```
[16:59:01 ERR] 0af7651916cd43dd8448eb211c80319c: _ listSurveys failed service=nextjs-app env=local operation=listSurveys durationMs=0 Error: boom: deliberate route error     at …
[16:59:01 ERR] 0af7651916cd43dd8448eb211c80319c: _ Unhandled server error service=nextjs-app env=local path="/api/surveys?fail=1" method=GET routePath=/api/surveys routeType=route routerKind="App Router" Error: boom: deliberate route error     at …
```

**`GET /boom`** — a Server Component throws while rendering: `routeType=render`, with the
digest the browser's error boundary also receives.

```
[16:59:03 ERR] Unhandled server error service=nextjs-app env=local path=/boom method=GET routePath=/boom routeType=render routerKind="App Router" renderSource=react-server-components digest=1241475305 Error: boom: deliberate render error     at …
```

**The Server Action** (submitted from the page with JavaScript, i.e. the normal case):
`routeType=action`, and the digest equals the one in the response the client gets.
`withLogging`'s own lines carry a trace id it generated; the hook line carries the request's.

```
[16:59:08 INF] c20a552ccc4f5ce06986fbdf8c6f074b: _ about to fail service=nextjs-app env=local operation=failSurvey
[16:59:08 ERR] 0af7651916cd43dd8448eb211c80319c: _ Unhandled server error service=nextjs-app env=local path=/action-boom method=POST routePath=/action-boom routeType=action routerKind="App Router" renderSource=react-server-components digest=… Error: boom: deliberate action error     at …
[16:59:08 ERR] c20a552ccc4f5ce06986fbdf8c6f074b: _ failSurvey failed service=nextjs-app env=local operation=failSurvey durationMs=2 Error: boom: deliberate action error     at …
```

Submitted **without JavaScript** (a plain form post), Next reports the same error as
`routeType=render` on `/action-boom/page` and without a digest.

**`POST /api/client-error`** from `error.tsx`:

```
[16:59:13 ERR] 00b109f8759ab80124460c373e9116dd: _ Client error service=nextjs-app env=local operation=clientError digest=abc ClientError: from browser
[16:59:13 INF] 00b109f8759ab80124460c373e9116dd: _ clientError completed service=nextjs-app env=local operation=clientError durationMs=2
```

## The `after()` flush

`withLogging` schedules the flush with `after()` from `next/server`, so the response is not
held for Rapid7. Measured with the log endpoint holding every POST for a second: the wrapped
route and action still answer in tens of milliseconds, and their lines arrive afterwards. If
`after()` is unavailable or throws (Next < 15.1, outside a request scope), the flush runs inline
instead, so nothing is lost either way. `flushMode: 'sync'` awaits delivery if you prefer.

`createRequestErrorHandler` is different on purpose: it awaits a bounded flush (1.5 s) before
returning, because the runtime may freeze the instant the hook returns. You can see it hold the
Route Handler's 500 for about a second; a render error's 500 is not held, since React calls the
hook without waiting.

## The Edge route

`/api/edge` runs on the Edge runtime. It uses `createLogger` from `@geekibo/rapid7-logger/edge`
— the immediate-send variant, because an Edge invocation can be torn down the moment the
response is returned and a batching window may never elapse — wrapped by `withLogging` from
`/next`, which works on both runtimes. `lib/edge-log.ts` starts with `import 'server-only'`
itself, because the `/edge` entry deliberately does not (outside Next that package throws at
load). What arrives, with `?fail=1`:

```
[17:30:12 INF] server starting service=nextjs-app env=local runtime=edge
[17:30:12 INF] 0af7651916cd43dd8448eb211c80319c: _ edge ping service=nextjs-app env=local operation=edgePing runtime=edge
[17:30:12 INF] 0af7651916cd43dd8448eb211c80319c: _ edgePing completed service=nextjs-app env=local operation=edgePing durationMs=1
```

`register()` runs on the first request to each Edge route, not at startup — hence the
`runtime=edge` line there. Next 16 prints "The Edge Runtime is deprecated" at build time; it
still builds and serves, and `onRequestError` reports Edge app routes with
`routerKind="Pages Router"` — Next's quirk, not the logger's.

## Not used here: `withTrace`

`withTrace` and the ambient trace come from the Node entry (`@geekibo/rapid7-logger`) and need
`AsyncLocalStorage`, which the Edge runtime lacks. This app imports from `/next` so it runs
under both runtimes; `withLogging` carries the trace instead. A Node-only app can use both.
