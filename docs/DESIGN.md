# Design: a Rapid7 InsightOps logger for Node and Next.js

**Status:** phase 1 in progress — toolchain scaffolded (#5); endpoint re-verified from Node (phase 0) ·
**Last updated:** 2026-10-08

This is the design document and rationale for `@geekibo/rapid7-logger`. It is the **source of
truth** for the package's architecture, its delivery contract, and the endpoint findings the
implementation depends on. Issues in this repository reference its section numbers.

Read §2 before writing any transport code: the endpoint has several non-obvious behaviours that
dictate the design, and none of them are in the vendor documentation.

---

## 1. Why this package should exist

### 1.1 The gap is real and verified

There is no maintained JavaScript library for shipping logs to Rapid7 InsightOps. Checked
2026-10-08 against the npm registry:

| Package | Latest | Last publish | Verdict |
|---|---|---|---|
| `r7insight_node` | 3.3.1 | **2022-06-23** | Rapid7's own client. 4 years stale. TCP-based (see §1.2). |
| `le_node` | 1.8.0 | **2018-10-25** | Predecessor, Logentries-era. Abandoned. |
| `winston-logentries` | 3.0.0 | **2016-11-14** | Marked **Deprecated** by its author. |
| `winston-r7insight` | — | — | Does not exist. |
| `r7insight` | — | — | Does not exist. |
| `pino-insightops` | — | — | Does not exist. |

Nothing targets Next.js. Nothing is aware of Server Components, Server Actions, the Edge
runtime, or the serverless freeze problem (§7.3) — all of which change what a correct logger
has to do.

### 1.2 The incumbent transport has a silent data-loss bug

This is the substantive reason not to just wrap `r7insight_node`. Both it and the .NET
`Serilog.Sinks.InsightOps` sink push events through R7Insight's `AsyncLogger`, which buffers
over a long-lived TCP socket. That buffer **silently drops isolated, low-frequency events**: a
lone log line sits in the socket buffer and is only flushed out by subsequent traffic, so quiet
services lose logs entirely.

This is not a theory. It was reproduced and documented during a .NET migration in July 2026:
*"verified: a lone event never arrived; bursts did."* The failure mode is vicious because it
inverts your intuition — logging looks fine under load and fails exactly when a quiet service
emits the one error you needed to see.

The fix is to abandon TCP and use the **HTTP webhook**, one event per request. A lone event is
then ingested in under a second — re-measured from Node on 2026-10-08: five of five lone events
delivered to a quiet log, each stamped by Rapid7 ~0.5 s after it was sent.

### 1.3 Prior art worth copying, and prior art worth avoiding

**Worth copying.** This problem has already been solved properly once, in .NET, and that
implementation has production mileage across a fleet of services. Its endpoint research is what
§2 records, and porting it saves this package from repeating a month of discovery. The design
here is a port, not an invention.

**Worth avoiding.** The pattern below turns up repeatedly in the wild — it is what people write
when they reach for the webhook directly, and every flaw in it is instructive:

```ts
const INSIGHTOPS_TOKEN = "YOUR_LOG_TOKEN"; // Replace with your token
const INSIGHTOPS_URL = `https://webhook.logentries.com/noformat/logs/${INSIGHTOPS_TOKEN}`;

export function logToInsightOps(message: string, level = "info", meta?: object) {
  fetch(INSIGHTOPS_URL, { method: "POST", body: JSON.stringify({ /* ... */ }) })
    .catch((err) => console.error("InsightOps logging failed", err));
}
```

Three fatal flaws, each of which this package must make structurally impossible:

1. **The placeholder token never gets filled in.** It is the kind of line that ships to a
   default branch and sits there.
2. **Nothing imports it.** Dead code, and nobody notices — because a logger that is never
   called looks exactly like a logger that works.
3. **It runs in the browser.** A bare `fetch` from client code means the ingestion token is
   served to every visitor, who can then write anything they like into your log estate. This is
   the single most important thing to design out (§6.5).

### 1.4 One honest caveat before you build

Rapid7's own documentation pages for InsightOps now carry a banner stating the product **"is no
longer sold"** and that the pages may be out of date. Existing customers still run on it — the
ingestion endpoint is live and was verified working for this document — but you are building
against a product in sustaining mode.

**This shapes the architecture, not the decision.** Build it, because the need is immediate and
real; but put the wire protocol behind a small `Transport` interface (§4.3) so that targeting a
different log backend later is an additive change, not a rewrite. Do not ship a second transport
on day one — that is speculative generality. Just don't weld the core to the webhook.

---

## 2. What the endpoint actually does

Everything in this section is **verified**, either against the live endpoint during the .NET
work (dated below) or against Rapid7's current documentation fetched 2026-10-08. All of it was
then **re-measured from Node** (v20.20.0, undici 6.23.0) against the live EU endpoint on
2026-10-08 by `spike/webhook-contract.mjs` (#4); re-run that script rather than reasoning when a
fact here is in doubt. Treat anything not listed here as unknown rather than assuming it behaves
sensibly.

### 2.1 The wire protocol

```
POST https://{region}.webhook.logs.insight.rapid7.com/v1/noformat/{token}
Content-Type: text/plain

<one single-line log entry>\n
```

| Property | Value | Provenance |
|---|---|---|
| Regions | `eu`, `us`, `au`, `ca`, `jp` — the region is the subdomain | .NET impl; Rapid7 docs confirm `us`/`eu` |
| Token | The per-log ingestion token (GUID), in the **path** | Rapid7 docs |
| Success status | **`204 No Content`**, empty body | Rapid7 docs; measured from Node 2026-10-08 |
| Lone-event latency | ~1 s ingestion, ~2 s end-to-end delivery. From Node: stamped by Rapid7 **~0.5 s** after sending (5/5 delivered); **searchable via the Query API after ~10 s** (median 9.7 s, max 10.9 s) | Verified live 2026-07-16 (.NET); measured from Node 2026-10-08 |
| Wrong token | **`204`, silently discarded** — a well-formed but unknown GUID, or a valid token in the wrong region. A malformed token gets `404` (§2.6) | Measured from Node 2026-10-08 |
| Body size limit | **32,767 bytes per entry**, excluding the trailing `\n`. Longer bodies still get `204` and are **split into consecutive entries** of at most 32,767 bytes; `413` from 65,536 bytes. Counted in UTF-8 bytes (§5.4) | Measured from Node 2026-10-08; Rapid7 docs state no limit |
| Rate limit | **None observed** up to ~164 req/s (32 concurrent for 10 s, 2,969 of 2,969 stored). No `429` and no rate-limit headers seen, so `Retry-After` behaviour is still unobserved | Measured from Node 2026-10-08; Rapid7 docs state no limit |
| Idempotency / dedup | **None.** Retries can duplicate (§7.1) | .NET impl design note |

### 2.2 The newline rule — the single most important constraint

`/v1/noformat` **does not accept a newline-delimited batch.** You cannot post ten lines in one
request and get ten entries.

The endpoint **keeps only the first line** of a multi-line body and discards the rest. The .NET
implementation found this against the live EU endpoint (2026-07-16), and it was re-measured from
Node on 2026-10-08:

| Body | Stored |
|---|---|
| `A first\nB second\n` | One entry, `A first` — the rest discarded |
| `A first\r\nB second\r\n` | One entry, `A first` — the `\r` is dropped too |
| `A first\rB second\n` | One entry, **both lines kept**, with the raw `\r` inside it |
| `A only line` (no trailing `\n`) | Stored identically — the trailing `\n` in §2.1 is optional |

Rapid7's own JavaScript example strips line feeds with the comment *"strip line feeds or
they'll appear as individual entries."* That does not match current behaviour: nothing split
into separate entries. The consequence is the same either way, and the rule for an implementer
is identical and non-negotiable:

> **One event per HTTP request, and the body must contain no interior newlines.**

So a multi-line message or a stack trace must be **flattened** (interior `\r\n` and `\n`
collapsed to spaces) before posting, or it will be either truncated or shredded into unrelated
entries. This is an endpoint requirement, not a formatting preference — it must not be
configurable. Measured from Node: a real nested stack trace flattened this way was stored as
exactly one entry, byte-identical to what was sent.

A lone `\r` is not a correctness problem: it neither truncates nor splits, so the rule covers
`\r\n` and `\n`. The formatter (#7) replaces a stray `\r` with a space as well, for
readability; that is a formatting choice, not an endpoint requirement.

### 2.3 Consequences for throughput

One request per event has a cost that must be designed for rather than discovered in
production:

- 1,000 events/minute ≈ 17 requests/second. Fine, but it needs **connection reuse** (keep-alive)
  and a **concurrency cap**, or you will exhaust sockets under a burst.
- A bounded queue with **drop-on-overflow** is mandatory. The alternative — blocking the
  application to log — is strictly worse than losing log lines.

As implemented (#11), measured on Node 20.20 / undici 6.23 against a local server:

- Node's global `fetch` **pools connections by default** — six sequential POSTs alternated
  across two sockets and `connection: keep-alive` was sent unasked — so the transport uses
  `fetch` as-is and needs no `node:`/`undici` import for keep-alive. A `fetch` can be injected
  (`fetch` on `LoggerOptions` or the transport) for a tuned dispatcher or for tests.
- An **undrained non-empty error body costs a new socket per request**, and so does
  `response.body.cancel()`; `await response.text()` restores reuse. Every response is drained
  with `text()`.
- `keepalive: true` on `RequestInit` is the browser "survive page unload" semantic and changes
  nothing about pooling. It is not set.
- The concurrency cap is the queue's (§7.2); the transport itself is one request per `send`.

### 2.4 `noformat` means what it says

The path segment is `noformat`: the body is ingested unparsed. There is **no documented JSON or
key-value ingestion endpoint**. So if you want structured data queryable in Rapid7, you encode
it into the single line yourself. Rapid7's examples do post JSON bodies to `noformat`, but the
docs never state how (or whether) they are parsed or indexed — so treat JSON-in-body as "it will
be stored and full-text searchable", not as "it will be indexed into fields".

### 2.5 The clickable-correlation trick

This is a hard-won UI detail from the .NET work (verified against a live log 2026-08-21) that is
worth porting verbatim, because nobody would ever deduce it:

Rapid7's log viewer only renders a token as a **clickable** value — letting you pivot to every
entry sharing it — when the token parses as the **key of a key/value pair**. A bare correlation
ID in the line is not clickable.

The working form is the ID, a colon, then a literal underscore:

```
[14:22:07 ERR] 9f6f2b2b140b: _ Survey export failed for run 44
                            ^^^ load-bearing
```

- **The delimiter is required.** Without it the ID is not clickable in any form.
- **The underscore is the pair's value, and it is also required.** Without it, the *message*
  supplies the value — so a message that carries its own `Label: value` pairs chains onto the
  stamp and the line loses its click entirely.
- **Emit the ID in full.** Let consumers shorten it; a library must not choose a truncation.

Re-checked from Node on 2026-10-08 through the Query API instead of the UI: a line posted in this
form matches the key/value search `where(<id>=_)`, and does not match `where(<id>=nope)`. So
Rapid7 parses the ID as the key, which is the property this section depends on.

### 2.6 A wrong token is not an error

The endpoint does not reject a token in any way a client can see. Measured from Node on
2026-10-08:

| Token | Response | Stored anywhere visible? |
|---|---|---|
| A well-formed GUID that is not a token | **`204`** | No |
| The valid token, posted to the wrong region | **`204`** | No |
| A malformed string (not a GUID) | `404`, empty body | — |

So a mistyped, revoked or wrong-region token **looks exactly like success**. Nothing in the
response tells them apart, the retry policy (§7.1) files them under "done", and
`stats().failed` (§7.4) will not rise. Only a malformed token is detectable from the response.

The one reliable test is to look for the events, which is why the live test (§9.2) reads back
through the Query API rather than trusting the `204`. How, or whether, the package should help a
consumer catch a misconfigured token is settled in §13: validate the config shape at
construction, and document the rest.

---

## 3. Naming and scope

### 3.1 Package name

Recommendation: **`@geekibo/rapid7-logger`**.

| Candidate | Assessment |
|---|---|
| `@geekibo/rapid7-logger` | **Recommended.** Says what it does, findable by the search that fails today ("rapid7 node logger"), and scoped so the name is yours. |
| `@geekibo/insightops-logger` | Accurate but ties the name to a product brand that is being retired. |
| `@geekibo/logger` | Over-claims. Invites scope creep into a general logging framework. |
| `r7insight-next` | Unscoped names on public npm are a squatting and trust liability. |

### 3.2 In scope for v1

- Structured, levelled logging from **Node.js server processes**.
- First-class **Next.js** integration: `instrumentation.ts` error capture, Server Actions,
  Route Handlers, and correct flushing under serverless (§7.3).
- Reliable delivery semantics: bounded queue, bounded retry, never throws, flush on shutdown.
- Correlation ID propagation (§6.4) and redaction hooks (§6.6).
- TypeScript types, dual ESM/CJS, zero runtime dependencies.

### 3.3 Explicitly out of scope for v1

| Excluded | Why |
|---|---|
| **Browser / client-side logging** | Exposes the ingestion token to every visitor. If ever wanted, it must go via a server route handler, never direct. See §6.5. |
| Log *querying* | A separate concern and a separate credential. Belongs in a sibling tool, not the logger. |
| Winston / Pino transports | Plausible v1.1 additions once the core is proven. Not a reason to delay v1. |
| OpenTelemetry bridge | Large surface, different audience. Revisit only on demand. |
| Alternative backends | Keep the `Transport` seam (§4.3); ship one implementation. |

---

## 4. Architecture

### 4.1 Layering

```
┌──────────────────────────────────────────────────────────────┐
│ Entry points                                                 │
│   @geekibo/rapid7-logger         → createLogger()  (Node)    │
│   @geekibo/rapid7-logger/next    → Next.js helpers           │
│   @geekibo/rapid7-logger/edge    → immediate-send variant    │
└───────────────────────────┬──────────────────────────────────┘
                            │
┌───────────────────────────▼──────────────────────────────────┐
│ Core (runtime-agnostic, no Node built-ins)                   │
│   Logger      levels, child loggers, bound context           │
│   Formatter   LogEvent → one single physical line            │
│   Redactor    strip/mask before anything leaves the process  │
│   Queue       bounded buffer, drop-on-overflow, flush()      │
└───────────────────────────┬──────────────────────────────────┘
                            │ Transport interface
┌───────────────────────────▼──────────────────────────────────┐
│ Transports                                                   │
│   Rapid7WebhookTransport   fetch → /v1/noformat, retry       │
│   ConsoleTransport         local dev, tests                  │
│   MemoryTransport          assertions in unit tests          │
└──────────────────────────────────────────────────────────────┘
```

The core must use **only** `fetch`, `AbortController`, timers and standard JS — no `node:*`
imports — so the same core runs in Node, Edge and Workers.

The Node entry (`src/index.ts`, #15) re-exports a `createLogger` that wraps the core one and
registers lifecycle flush hooks (§7.3) through one process-level registry under `src/node/`;
it adds `close()` and a `lifecycle` option on Node-only types, leaving the core types
runtime-agnostic. The Edge and Next entries import from the core, never from the Node entry.

`Rapid7WebhookTransport` (#11) posts each event as its own request to `/v1/noformat/{token}`
with `content-type: text/plain` and the formatter's line plus a single trailing `\n`, with a
10 s per-request timeout (`AbortController` + a timer, cleared after every send so an idle
process holds no timer). It resolves `{ delivered: true }` on any 2xx — *accepted*, not seen
(§2.6) — and `{ delivered: false, error: 'HTTP <n>' | '<cause code>' | 'timeout after <n>ms' }`
otherwise; it never throws or rejects. The token is held in an ES private field so it cannot
be enumerated or serialised, and nothing it reports can contain it. Its constructor throws a
`TypeError` on an invalid token or region; `createLogger` validates first and degrades, so a
consumer only meets that by constructing the transport directly.

`ConsoleTransport` (#10) prints exactly the line the webhook transport would post — rendered by
the formatter, so flattened, stamped and capped — which makes local output identical to what
Rapid7 would store. `MemoryTransport` captures the (already redacted) events and can render
them as lines; it is unbounded test infrastructure, not a production sink. Both are exported
for use as `createLogger({ transport })`. Anything Node-specific
(`process.on('SIGTERM')`) lives in the Node entry point.

### 4.2 Package exports

```json
{
  "name": "@geekibo/rapid7-logger",
  "version": "0.0.0",
  "description": "Reliable Rapid7 InsightOps logging for Node.js and Next.js",
  "license": "MIT",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/Geekibo/rapid7-logger.git"
  },
  "type": "module",
  "sideEffects": false,
  "engines": { "node": ">=20.9.0" },
  "exports": {
    ".": {
      "import":  { "types": "./dist/index.d.ts",  "default": "./dist/index.js" },
      "require": { "types": "./dist/index.d.cts", "default": "./dist/index.cjs" }
    },
    "./next": {
      "import":  { "types": "./dist/next.d.ts",  "default": "./dist/next.js" },
      "require": { "types": "./dist/next.d.cts", "default": "./dist/next.cjs" }
    },
    "./edge": {
      "import":  { "types": "./dist/edge.d.ts", "default": "./dist/edge.js" }
    }
  },
  "files": ["dist", "README.md", "LICENSE"],
  "dependencies": {},
  "peerDependencies": { "next": ">=15.0.0" },
  "peerDependenciesMeta": { "next": { "optional": true } },
  "publishConfig": { "access": "public" }
}
```

Notes:

- **Zero runtime dependencies.** A logger is infrastructure; every dependency it carries is a
  supply-chain liability inherited by every consumer. Notably, the .NET implementation this
  design ports treats *shedding* a transitive `log4net` dependency as one of its headline
  features — same principle.
- **`next` is an optional peer**, so plain Node consumers never pull it in.
- **No `/edge` CJS build** — the Edge runtime is ESM-only.
- **Types are declared per condition.** In a `type: module` package a `.d.ts` is read as ESM
  types, so a single `types` entry would give CJS consumers (`moduleResolution: node16`) the
  "masquerading as ESM" error. The `require` branch points at `.d.cts`; `@arethetypeswrong/cli`
  passes for both.
- **`version` starts at `0.0.0`.** Changesets publishes the current version when no changesets
  are pending, so starting at `0.1.0` could publish it without the reviewed "Version Packages"
  PR (§10.4). The first `minor` changeset produces `0.1.0` (§10.5).
- **npm omits an empty `dependencies` object** on install, so the field is absent from the real
  file. `test/unit/package.test.ts` asserts there are no runtime dependencies either way.
- `engines.node >= 20.9` matches Next.js 16's floor and guarantees global `fetch`. Note the
  **release workflow** needs Node >= 22.14 for trusted publishing (§10.2) — that is a CI
  requirement, not a consumer one.
- **`repository.url` must exactly match the GitHub repository.** npm's trusted publishing
  rejects a mismatch at publish time (§10.3), and `publishConfig.access: public` means a scoped
  package never fails its first release for want of `--access public`.

### 4.3 The Transport seam

```ts
export interface LogEvent {
  readonly timestamp: Date;
  readonly level: Level;                  // 'trace'|'debug'|'info'|'warn'|'error'|'fatal'
  readonly message: string;
  readonly context: Readonly<Record<string, unknown>>;
  readonly error?: { name: string; message: string; stack?: string; digest?: string };
}

export interface SendOutcome {           // optional, additive (#9)
  readonly delivered: boolean;
  readonly retries?: number;             // attempts beyond the first
  readonly error?: string;
}

export interface Transport {
  /** Deliver one event. MUST NOT throw. MUST resolve even on permanent failure. */
  send(event: LogEvent): Promise<void | SendOutcome>;
  /** Best-effort drain of anything buffered inside the transport. */
  flush(timeoutMs?: number): Promise<void>;
}
```

`SendOutcome` was added in #9 and is additive: a transport that resolves `void` is counted as
delivered. It exists because `send` must *resolve* even after exhausting its retries (§7.1), so
without it the queue could not tell a delivered event from a dropped one when keeping the
counters (§7.4).

Two invariants, both of which must be enforced by tests:

1. **`send` never throws and never rejects.** A logging failure must never fail the user's
   request. This is the rule that the dead `logToInsightOps` got right and almost nothing else.
2. **`flush` is bounded.** It takes a timeout and returns when it elapses, whether or not the
   queue drained. An unbounded flush on shutdown is a hung pod.

---

## 5. The public API

### 5.1 Creating a logger

```ts
import { createLogger } from '@geekibo/rapid7-logger';

export const log = createLogger({
  token:   process.env.RAPID7_TOKEN,        // undefined ⇒ console-only, no throw
  region:  process.env.RAPID7_REGION ?? 'eu',
  service: 'my-app',                        // stamped on every event
  env:     process.env.APP_ENV ?? 'local',
  level:   process.env.LOG_LEVEL  ?? 'info',
});
```

**A missing token must not throw.** It degrades to the console transport and emits exactly one
warning. Rationale, learned the hard way on the .NET side: an unconditional sink that throws on
a missing token breaks every integration test and every local run, and the workaround people
reach for is a compile-time `#if DEBUG` guard that then diverges from production. Make the
graceful path the only path.

Options, as implemented (#6):

| Option | Behaviour |
|---|---|
| `token` | Trimmed. Absent, empty or not a GUID ⇒ console-only and **one** warning (§13). Never echoed in a message. A valid token posts through `Rapid7WebhookTransport` (#11). |
| `region` | Trimmed, case-insensitive; default `eu`. Unknown ⇒ console-only and one warning. |
| `level` | Trimmed, case-insensitive; default `info`. Unknown ⇒ `info` and one warning. Typed `Level \| (string & {})` so `process.env.LOG_LEVEL ?? 'info'` type-checks. |
| `service`, `env` | Become root bound context: `service=… env=…` on every line. |
| `transport` | Injects a `Transport` (§4.3) and bypasses token resolution — how the Console and Memory transports are used. |
| `fetch` | The `fetch` the webhook transport uses (default: the global one). Ignored with `transport`. |
| `contextProvider` | Ambient context read at log time, merged per-call > ambient > bound (§6.4). The Node entry wires the current trace by default. |
| `lifecycle` *(Node entry only)* | `false` to register no process hooks; `{ timeoutMs }` (default 2000) bounds the flush each hook runs (§7.3). |
| `close(timeoutMs?)` *(Node entry only)* | Unregisters the logger from the hooks and flushes it, bounded. Idempotent. |
| `onInternalError` | `(error: Error) => void`. Default: one `console.warn`, rate-limited to one per minute per logger. A throwing handler is swallowed. |
| `flush(timeoutMs = 2000)` | Bounded by a timer regardless of the transport. Never rejects. |
| `format` | Full line override (§5.3). Its output is still flattened and truncated. Forwarded to the transport by #15. |
| `maxBytes` | Line byte cap (§5.4). Default 32,767. Forwarded to the transport by #15. |
| `redact` | On by default (§6.6). `false` disables; `{ keys, patterns, replacement, defaults }` extends or replaces the built-ins. |
| `batchSize` | Events one drain pass takes from the queue (§7.2). Default 50. |
| `flushIntervalMs` | Wait after a partial pass before the next. Default 2000; `0` never waits. |
| `queueLimit` | Queued events beyond which new ones are dropped. Default 10,000. |
| `maxConcurrency` | In-flight sends at once. Default 8. |

Each queue option must be a finite number at or above its minimum (1, 0, 1, 1); anything else
falls back to the default with one warning. Construction warnings are not rate-limited — each
problem happens once — while runtime failures are (§7.4).

`createLogger` itself never throws: a failure inside construction also degrades to console-only.

### 5.2 Logging

```ts
log.info('Survey published', { surveyId: 42, runId: 44 });
log.warn('Material sync lock contended', { holder: 'pod-7' });
log.error('Export failed', err, { surveyId: 42 });   // Error is a first-class 2nd arg

const reqLog = log.child({ traceId, userId });        // bound context, inherited
reqLog.debug('cache miss', { key });

await log.flush(2000);                                 // bounded, explicit
```

Design choices worth stating:

- **`Error` is a positional argument**, not a context key. It is the thing people most often
  get wrong (`{ error: err }` serialises to `{}` because `Error` has non-enumerable fields), so
  the API should make the right thing the easy thing and normalise `stack` itself. The rule
  (#6): with three arguments the second is always the error; with two, it is the error if it is
  an `Error` or error-shaped (a string `message` plus a string `name` or `stack`), otherwise it
  is context. Normalised to `{ name, message, stack?, digest? }`; a primitive becomes
  `{ name: 'Error', message: String(value) }`.
- **Level methods return `void`.** Delivery is the queue's business (§7.2); to wait for it, call
  `flush()`. Widening to `Promise<void>` later would be non-breaking; the Edge entry (§6.3),
  which sends immediately, may type its methods that way.
- **`child()` returns a new logger with merged context.** This is how a correlation ID reaches
  every line without being threaded through every function signature.
- **Levels are a fixed set**, mapped to the three-letter monikers Rapid7 users already search
  for: `TRC DBG INF WRN ERR FTL`.

### 5.3 Line format

Default output, deliberately matching the shape existing Rapid7 saved searches and alerts
already target:

```
[HH:mm:ss LVL] <traceId>: _ message key=value key2=value2
```

- `[HH:mm:ss LVL] ` prefix — familiar, and the level is greppable. The time is **UTC**
  (`toISOString().slice(11, 19)`, no `Z`); an invalid `Date` prints `--:--:--`. The .NET
  original used local time; UTC is a deliberate divergence: production runs in UTC, Edge
  runtimes may lack ICU, and tests stay deterministic. Rapid7 stamps its own ingestion time
  anyway.
- The correlation stamp per §2.5, emitted **only when a correlation ID is present**. This
  conditionality is why it is built by the formatter rather than expressed as a user template:
  a plain template string cannot omit a field when it is absent. The id is read from the
  `traceId` context key (`correlationKey` on the formatter; #16 populates it) when its value
  is a string with non-whitespace content, and that key is then **omitted from the trailing
  pairs** — a `traceId=<id>` pair is not clickable on its value and costs ~45 bytes against
  the cap. Any other value is left as an ordinary pair and no stamp is emitted.
- Context as trailing `key=value` pairs — scannable, and each key is clickable in Rapid7 for
  free, since they already parse as key/value pairs. Values: a string is bare unless it is
  empty or contains whitespace, `=` or `"`, in which case it is JSON-quoted; numbers,
  booleans, `null` and bigints print as themselves; a `Date` as ISO; an `Error` as
  `"Name: message"`; an object or array as compact JSON (cycles become `"[Circular]"`);
  `undefined` is omitted; anything that throws while rendering becomes `[unserializable]`.
  Whether Rapid7 parses a quoted value as the pair's value is unmeasured (§9.1).
- The error last: an optional `digest=<digest>` pair (§6.1), then the flattened stack, or
  `Name: message` when there is none. Last because the stack is the longest, least structured
  part of the line, so truncation eats deep frames rather than context keys.
- **Then flattened to a single physical line, unconditionally** (§2.2), and truncated (§5.4).

Allow a full `format: (event) => string` override for people with existing parsers, but keep
one-event-per-request and newline-flattening outside the user's reach — they are correctness,
not style. The override's output is flattened and truncated like the default line; if it throws
or returns a non-string, the default line is emitted with a `formatError="…"` pair appended.
`formatEvent` is exported so an override can compose with the default. The formatter never
throws, so transports call it unguarded.

### 5.4 Defensive truncation

Rapid7 documents no body-size limit, which means there is one and you will find it at 3 a.m.
It was found on 2026-10-08 by bisection from Node (§2.1):

| Body (excluding the trailing `\n`) | Response | Stored |
|---|---|---|
| ≤ 32,767 bytes | `204` | One entry, intact |
| 32,768 – 65,535 bytes | `204` | **Split into consecutive entries**: the first 32,767 bytes, then the remainder, with identical timestamps. No marker, no error |
| ≥ 65,536 bytes | `413` | Nothing |

No bytes are lost — a 49,152-byte body came back as entries of 32,767 and 16,385 bytes — but the
line is **shredded into separate entries**, the same failure §2.2 describes for newlines. A
32,768-byte body became a full entry plus an entry holding just its last byte. A search for
anything spanning the split point, such as a correlation ID, misses it.

The limit counts **UTF-8 bytes, not characters**: an 11,326-character body of 33,792 bytes was
split. The split ignores character boundaries, so a multi-byte character straddling it is
replaced by `U+FFFD` (`�`) in **both** entries.

So the endpoint already "handles" oversized lines, badly. The client must truncate first, with a
visible marker, so the whole posted line, marker included, fits in **32,767 bytes**, cut on a
code-point boundary:

```
… [truncated 148231 of 180503 bytes]
```

`maxBytes` therefore defaults to **32,767**, not the 32 KiB (32,768) this section originally
guessed. That guess was one byte over the cap, so every maximum-length truncated line would have
had its last byte, the end of the marker, split off into an entry of its own. A value above
32,767 buys nothing, because the endpoint splits there regardless. The formatter (#7)
implements this.

A truncated line that says so is diagnosable. A silently cut line sends you looking for a bug
that is in your logger.

As implemented (#7): `N of M` means N bytes were removed from an M-byte line (M is the full
flattened line's UTF-8 length). The marker is reserved at its widest before cutting, so the
output never exceeds `maxBytes`; the cut walks code points, so a multi-byte character or a
surrogate pair is never split. `maxBytes` is validated: `Infinity` disables truncation, a
non-number, `NaN` or a non-positive value means the default, and anything under 128 is raised
to 128 (the marker alone needs ~40 bytes). The trailing `\n` the transport appends is not
counted; the endpoint's cap excludes it too.

---

## 6. Next.js integration

### 6.1 Error capture via `instrumentation.ts`

Next.js exposes a server-wide error hook. The signature below is from the Next.js 16.4 docs
(verified 2026-10-08) — note `error` is typed `unknown`, so it must be narrowed:

```ts
// instrumentation.ts  (project root, or src/)
import type { Instrumentation } from 'next';
import { log } from '@/lib/log';

export const onRequestError: Instrumentation.onRequestError = async (
  error,      // unknown — narrow before use
  request,    // { path, method, headers }
  context,    // { routerKind, routePath, routeType, renderSource, revalidateReason, renderType }
) => {
  log.error('Unhandled server error', error, {
    path:       request.path,
    method:     request.method,
    routePath:  context.routePath,
    routeType:  context.routeType,   // 'render' | 'route' | 'action' | 'proxy'
    routerKind: context.routerKind,
  });
  await log.flush(1500);   // bounded; the runtime may freeze the instant we return (§7.3)
};

export async function register() {
  // Runs once per server instance, before any request is served.
}
```

The package should ship a one-liner for this:

```ts
export const onRequestError = createRequestErrorHandler(log);
```

Two caveats to document prominently, because both cause silent gaps:

1. **`onRequestError` only sees errors that escape.** Code that catches, logs to `console.error`
   and rethrows a sanitised error gives this hook the *sanitised* error — the original cause
   never arrives. So this hook is a safety net, **not** a substitute for replacing
   `console.error` call sites with the logger.
2. **The error instance may not be the one thrown.** React can process errors during Server
   Component rendering; `error.digest` is what correlates the server line to what the browser
   saw. Always log the digest.

### 6.2 Server Actions and Route Handlers

No framework hook here — this is ordinary call-site logging, and it is where the real value is.
The recommended pattern is a thin wrapper that supplies correlation and timing:

```ts
'use server';
import { withLogging } from '@geekibo/rapid7-logger/next';

export const publishSurvey = withLogging('publishSurvey', async (log, id: number) => {
  log.info('publishing', { id });
  const res = await api.publish(id);
  log.info('published', { id, status: res.status });
  return res;
});
```

`withLogging` should: create a child logger with a fresh or inherited trace ID, log the start
and the outcome, log any thrown error **and rethrow it unchanged**, record duration, and
schedule the flush (§7.3). It must never swallow an exception — a logging wrapper that changes
control flow is a bug factory.

### 6.3 The Edge runtime

`instrumentation.ts` runs in both Node and Edge; `process.env.NEXT_RUNTIME` distinguishes them.
Edge is materially different:

- `fetch` exists; Node built-ins and `process.on` do not.
- There is **no reliable background timer** — an Edge invocation can be torn down the moment the
  response is returned, so a 2-second batching window may never elapse.

Therefore `/edge` exports an **immediate-send** logger: every call posts straight away and the
caller is expected to `await` or hand the promise to `after()`. Document the trade (added
latency per log line) rather than pretending the batching logger works there.

### 6.4 Correlation — the highest-value feature

A logger that produces unlinked lines is a modest upgrade on `console.error`. A logger that lets
you select a request and see every line it produced — across the web tier *and* the API tier —
is a different tool.

The mechanism should be W3C Trace Context, because it is the standard and it interoperates with
Application Insights and OpenTelemetry:

1. Read `traceparent` from the inbound request; generate one if absent.
2. Hold it in `AsyncLocalStorage` (Node) so `log.child()` picks it up with no plumbing.
3. **Propagate it outbound** — attach `traceparent` to every call your API client makes.
4. Stamp it on every line using the clickable form in §2.5.

Step 3 is the one people skip, and it is the one that makes the feature worth having. Pair it
with a matching enricher on the backend and one click pivots across both tiers.

Ship a small, documented helper rather than a framework:

```ts
import { withTrace, currentTraceId } from '@geekibo/rapid7-logger/next';
```

`AsyncLocalStorage` is unavailable on Edge; fall back to explicit passing there.

As implemented (#16):

- **A core seam, not a Node feature.** `LoggerOptions.contextProvider?: () => LogContext |
  undefined` is read at log time and merged **per-call > ambient > bound** — a request's id
  must beat a logger, or a child, built at module load. A throwing provider is reported and the
  event ships without ambient keys. This is what makes the Edge fallback and an OpenTelemetry
  bridge one-liners.
- **The pure half lives in the core** (`src/core/traceparent.ts`, no imports, global `crypto`):
  `parseTraceparent` (OpenTelemetry's rules: case-insensitive, `ff` invalid, `00` must have
  four fields, future versions may carry more, all-zero ids invalid), `formatTraceparent`,
  `generateTraceContext`/`generateTraceparent` (sampled, never all-zero), `childOf`, and
  `readTraceparent` over a raw string, a `Request`, an `IncomingMessage`, a `Headers`, a plain
  headers object or a `TraceContext`. Never throws.
- **The Node half** (`src/node/trace.ts`) holds the trace in one `AsyncLocalStorage` per
  process (cached on `globalThis` under a well-known symbol, for the dual ESM/CJS case) and
  exports `withTrace(source?, fn)`, `currentTrace`, `currentTraceId`, `currentTraceparent` and
  `outboundHeaders`. The Node `createLogger` wires the store as the default provider, so **any
  logger stamps the ambient trace id — `child()` is not needed for correlation**. An explicit
  valid header wins and this tier gets its own span (new parent-id, same trace-id and
  `tracestate`); nested with no usable header ⇒ a child span; neither ⇒ a new sampled trace.
- **What is stamped:** only `traceId`, in full; a `spanId` pair would not be clickable and
  costs ~24 bytes a line. The parent id is available from `currentTrace()`.
- **Outbound:** `outboundHeaders()` returns `{ traceparent, tracestate? }` carrying the current
  span, or `{}` outside a trace so `{ ...outboundHeaders() }` is always safe. It does not mint
  a span per call — a logger is not a tracer.
- **Edge:** explicit passing (`child({ traceId })` or per-call), or a user-supplied
  `contextProvider` on a runtime that has ALS. The pure helpers may be re-exported from the
  Edge entry (#22). The `from '@geekibo/rapid7-logger/next'` import above is #19's decision:
  the Next entry must also run on Edge.

### 6.5 Making browser misuse structurally impossible

Recall §1.3: the naive approach ships the ingestion token to every browser. Four defences,
layered, because documentation alone demonstrably does not work:

1. **`import 'server-only'`** at the top of the Next entry point. Importing it from a Client
   Component becomes a **build error**, not a runtime surprise.
2. **Read the token only from a non-`NEXT_PUBLIC_` variable**, so Next.js cannot inline it into
   the client bundle even if someone tries.
3. **No browser-ish fields in the core** — no `navigator`, no `window`.
4. **A README section stating the rule and the reason**, and pointing at the route-handler
   pattern as the sanctioned way to get client errors server-side.

### 6.6 Redaction

The package will be pointed at applications handling session data, account identifiers and
user-submitted content. Static analysis routinely flags exactly this pattern (clear-text
logging of sensitive information), so redaction belongs in the library, on by default:

```ts
createLogger({
  redact: {
    keys: ['password', 'token', 'authorization', 'cookie', 'secret', 'apiKey'],
    patterns: [/\b[\w.%+-]+@[\w.-]+\.[A-Za-z]{2,}\b/g],   // email
    replacement: '[redacted]',
  },
});
```

Defaults should cover the obvious credential-shaped keys and bearer tokens. Redaction must run
**before** the formatter, must apply to nested objects, and must be impossible to bypass by
logging an object instead of a string.

As implemented (#8), `createRedactor` runs in the logger once per event, after the level gate
and before the queue, so nothing unredacted can be buffered, formatted, handed to a `format`
override or printed by the console fallback:

- **Keys** match case-insensitively as a substring once `-`, `_` and whitespace are removed, so
  `dbPassword`, `refresh_token`, `x-api-key` and `set-cookie` all match. Defaults: `password`,
  `passwd`, `pwd`, `secret`, `token`, `apiKey`, `authorization`, `cookie`, `credential`,
  `privateKey`. Known false positives: `tokenCount`, `maxTokens`. Deliberately absent: `auth`
  (hits `author`), `session`, bare `key`, PII terms. A matched key's whole value becomes the
  replacement, whatever its type. Keys never apply to the message.
- **Patterns** apply to every string in the event — the message, every context string, and
  the error's name, message, stack and digest (a stack can embed a URL carrying a token).
  Defaults: `Bearer <token>` and `Basic <credentials>` (the scheme is kept), and bare JWTs.
- **Bypasses closed:** an object's `toJSON` is called during redaction and its result walked,
  so the formatter's `JSON.stringify` never sees one; functions become `[Function]`; `Map`
  becomes a plain object (keys matched) and `Set` an array; an `Error` in context keeps its
  shape (so §5.3 still renders `"Name: message"`) with its fields and own properties redacted.
- **Bounded and total:** cycles become `[Circular]`, depth is capped at 16 (`[MaxDepth]`) and
  nodes at 10,000 (`[MaxNodes]` for everything after — unwalked input never passes through);
  a value that throws while being read becomes `[unserializable]`; the redactor never throws,
  and if it somehow did the logger drops the event rather than leaking it.
- **Options:** `redact: false` disables it; `keys` and `patterns` extend the defaults;
  `defaults: false` drops the built-ins; `replacement` defaults to `[redacted]`.
- The redacted context is a fresh deep copy, so later mutation of a logged object cannot reach
  the queue (§7.2).

---

## 7. Reliability semantics

State these in the README as a contract. Vague delivery guarantees are how people build alerts
on top of a logger that cannot support them.

### 7.1 At-least-once, with a stated duplicate risk

Retry policy, ported from the proven implementation:

| Condition | Action |
|---|---|
| `204` (or any 2xx) | Done |
| `5xx`, `408`, `429` | Retry, up to **3 attempts** total, backoff `200ms × attempt` |
| Other `4xx` (measured: a malformed token → `404`; oversized → `413`) | **Do not retry** — a bad token will not become good |
| Network exception | Retry within the attempt budget |
| Attempts exhausted | **Drop silently.** Never throw |

**This table cannot catch most bad tokens.** A well-formed but wrong token, or the right token in
the wrong region, gets `204` (§2.6) and lands in the "done" row. The non-retryable `4xx` row
fires only for a malformed token, or for `413`, which cannot occur when §5.4's truncation runs
first.

Improvement over the .NET original: **honour `Retry-After`** on a `429` when present, capped,
rather than using the fixed backoff.

As implemented (#12): the loop lives in `Rapid7WebhookTransport.send()`. The 10 s timeout is
**per attempt**; a timeout is a transient failure and retries like a network error. The wait
before attempt *n* is `backoffMs × (n − 1)` (200 ms, then 400 ms). On a `429`, and on a `503`
since servers send it there too, a `Retry-After` header — integer seconds or an HTTP-date — is
honoured instead of the backoff, capped at 30 s (`retryAfterCapMs`); an unparseable value
falls back to the backoff. The outcome reports `retries = attempts − 1` and the **last**
error, so `stats()` shows `retried` and `failed` (§7.4). `maxAttempts`, `backoffMs` and
`retryAfterCapMs` are transport options, not `LoggerOptions`. No `429` has ever been observed
from the endpoint (§2.1), so the `Retry-After` path is unit-tested only. Because a well-formed
wrong token is accepted with `204` (§2.6), the "do not retry" row only ever fires for a
malformed token (`404`) or, in theory, an oversized body (`413`) that the formatter's cap
makes impossible. This path is defensive: no `429` has been observed from the
endpoint (§2.1, none up to ~164 req/s), so it is untested against the real thing.

The endpoint has no idempotency or dedup, so a POST that is ingested but whose acknowledgement
is lost **will be retried and will produce a duplicate**. That is the right trade — a rare
duplicate beats losing lines on a transient blip — but say so explicitly, because anything
downstream that *counts* events needs to know.

**This is not a durable sink.** A hard crash loses whatever is in memory. If you need durability,
you need a different architecture (sidecar, or stdout plus a cluster collector), and the README
should say that plainly rather than letting people assume.

### 7.2 Bounded queue, never block

- `batchSize` 50, `flushIntervalMs` 2000, `queueLimit` 10000 — the .NET defaults, which have
  production mileage.
- **Emit the first event eagerly** rather than waiting out the interval, so a quiet service's
  single error arrives in ~1 s instead of ~2 s. (This is the specific behaviour that fixes the
  bug in §1.2; do not lose it to a naive timer.)
- Overflow **drops**, and increments a counter exposed via `log.stats()`. It must never block an
  application thread.
- Cap in-flight requests (`maxConcurrency`, default 8) and reuse connections via a keep-alive
  dispatcher, per §2.3.

As implemented (#9), since the endpoint takes one event per request (§2.2) there is no body
batching; the queue's model is Serilog's:

- A **pass** takes up to `batchSize` events (fixed when the pass starts) and sends each as its
  own `transport.send`, with at most `maxConcurrency` in flight; as a send settles the next
  starts.
- A **full** pass means a backlog: the next pass starts at once. A **partial** pass that ends
  with events still queued waits `flushIntervalMs` once, then goes again, so a trickle
  coalesces. `flushIntervalMs: 0` never waits. The interval plays no throughput role.
- **Eager first event:** every idle → non-empty transition starts a pass on the next
  microtask, not after the interval. Not synchronous, so the first call of a burst still gets
  a full pass. An `error` or `fatal` event cancels a pending wait and skips the next one
  (§7.3's "flush eagerly on error and above", as the queue's default policy).
- **Overflow drops the newest** event: O(1), the port's behaviour, and it preserves causality
  (the early lines explain an incident; the newest in a flood are the noise). `dropped` rises
  and `onInternalError` is told once per episode — the first drop after the queue was last
  empty. A drop does not set `lastError`.
- **`flush(timeoutMs)`** cancels a pending wait, runs passes back to back until the queue is
  empty and nothing is in flight, then calls `transport.flush` with the remaining budget — all
  raced against one timer, and raced again by the logger as defence in depth. It never rejects.
  Events enqueued during a flush are included; after a timeout the queue keeps draining.
- **Timers:** only the inter-pass wait and the flush bound exist, and only while there is work.
  An idle logger holds no timer. There is no `unref`: an active queue keeping Node alive is
  what delivers "log once and exit"; the Node entry adds `beforeExit` ⇒ flush (#15, §7.3).
- The Edge entry (§6.3) substitutes an immediate-send dispatcher through the same composition
  root (`composeLogger`), so `LoggerOptions` is identical on every runtime.

### 7.3 Flushing — the Next.js problem the .NET package never had

This deserves its own treatment because it is the most likely source of "the logger works
locally and loses everything in production".

In a long-lived container, a 2-second background flush is fine. In a **serverless or
freeze-after-response** environment, the runtime may suspend the process the instant the
response is sent. A queued event with a pending 2-second timer is then **never delivered**, and
nothing anywhere reports an error.

Three mitigations, all of which the package should support:

1. **`after()`** (stable in Next.js 15.1+, imported from `next/server`) — schedule the flush as
   post-response work. This is the Next-native answer and should be what `withLogging` uses:

   ```ts
   import { after } from 'next/server';
   after(() => log.flush(1500));
   ```

2. **`flushMode: 'sync'`** — await delivery before returning. Correct, costs latency; the right
   default for `error`/`fatal` even when lower levels batch.
3. **Lifecycle hooks in the Node entry point** — flush on `SIGTERM`/`SIGINT`/`beforeExit`, with a
   bounded timeout, for containerised deploys (Kubernetes, which is the likely first consumer).

Recommended default: **batch everything, but flush eagerly on `error` and above.** You lose a
little efficiency on the lines that matter least and lose nothing on the lines that matter most.

As implemented for Node (#15), measured on Node 20.20 before the change: "log once and exit"
already delivered (57 ms; an in-flight `fetch` keeps the loop alive), but **`SIGTERM` during a
burst delivered 0 of 200 lines** — the default disposition kills the process in ~20 ms. The
Node `createLogger` therefore registers, once per process, handlers for `SIGTERM`, `SIGINT`
and `beforeExit`:

- **Signals.** Ownership is decided when the signal arrives: if every listener is ours, the
  library owns the exit; otherwise the application's handler does. In both cases every
  registered logger is flushed, each bounded by its `lifecycle.timeoutMs` (default 2 s). When
  we own the exit, our listener is then removed (restoring the default disposition) and the
  signal is re-raised with `process.kill(process.pid, signal)`, so the process dies the
  conventional way (`signalCode === 'SIGTERM'`, status 143 in a shell). When the application
  has a handler, nothing more is done: it decides how to exit, with a drained queue. A second
  signal during a flush re-raises at once. The library never calls `process.exit()`.
- **The dual-package case.** The package ships ESM and CJS; an app that loads both gets two
  registries. Listeners are tagged with `Symbol.for('@geekibo/rapid7-logger/lifecycle')` so
  each copy recognises the other as "ours", and only the copy that removes the last tagged
  listener re-raises — exactly one `kill`.
- **`beforeExit`** flushes only loggers with something queued and otherwise returns
  synchronously; that guard is what ends Node's re-fire cycle (flushing schedules async work,
  which makes `beforeExit` fire again).
- Hooks are installed on the first `createLogger` and removed when the last logger is
  `close()`d, so importing the package has no side effect (`sideEffects: false` stays honest).
- Caveats: an application handler that calls `process.exit()` synchronously wins — such
  handlers should `await log.flush()` or `await log.close()` first; `process.exit()` anywhere
  skips `beforeExit` and every hook, by Node's design. On Windows `SIGTERM` listeners never
  fire; `SIGINT` does.
- Measured after the change (integration tests against the built entry): the burst case
  delivers 200 of 200 and exits by the signal; against a server that never answers, the
  process exits within the bound rather than waiting for the queue.

### 7.4 Self-observability

A logger that fails silently is the problem being solved, so the package must be able to report
on itself:

```ts
log.stats();
// { queued: 3, sent: 1402, dropped: 0, failed: 2, retried: 5, lastError: '…' }
```

The counters are one object shared by a logger and every child it spawns; `stats()` returns a
copy. Who increments what:

| Field | Meaning | Written by |
|---|---|---|
| `queued` | A gauge: events waiting in the queue (not in flight) | The queue |
| `sent` | Sends that resolved `void` or `{ delivered: true }` | The queue |
| `failed` | Sends that threw, rejected or resolved `{ delivered: false }`; a `flush` that threw or rejected | The queue (and the logger for its own guards) |
| `retried` | The sum of `SendOutcome.retries` | The queue, from what the transport reports (#12) |
| `dropped` | Events refused at `queueLimit` | The queue |
| `lastError` | The message of the most recent failure. Not set by a drop | The queue |

One writer per field, so the transport seam (§4.3) carries no counters: a transport reports
through `SendOutcome` and the queue keeps the books.

Plus an `onInternalError` callback (default: one `console.warn`, rate-limited) so a persistently
broken token is visible somewhere without spamming stdout. Note the limit: only a *malformed*
token produces a failure the logger can see. A wrong but well-formed token, or the wrong region,
succeeds silently (§2.6).

---

## 8. Repository and tooling

### 8.1 Layout

```
rapid7-logger/
├── src/
│   ├── core/            logger.ts  formatter.ts  queue.ts  redact.ts  levels.ts  config.ts  traceparent.ts  types.ts
│   ├── transports/      rapid7-webhook.ts  console.ts  memory.ts
│   ├── node/            lifecycle.ts (process-level registry)  logger.ts (Node createLogger)  trace.ts (AsyncLocalStorage)
│   ├── index.ts         Node entry  (re-exports src/node + core; AsyncLocalStorage in #16)
│   ├── next.ts          Next entry  ('server-only', withLogging, onRequestError, after())
│   └── edge.ts          Edge entry  (immediate-send)
├── test/
│   ├── unit/            fake fetch; formatter, redaction, retry, queue bounds
│   ├── contract/        Transport invariants: never throws, flush is bounded
│   ├── node/            lifecycle integration: spawns node against dist/ (build first)
│   └── live/            gated integration test (§9.2)
├── spike/               phase 0 endpoint measurement script (#4) — not shipped
├── examples/
│   ├── node-basic/      plain Node script
│   ├── nextjs-app/      instrumentation.ts + a Server Action + a Route Handler
│   └── nextjs-edge/
├── .github/workflows/   ci.yml  release.yml
├── README.md  LICENSE  CONTRIBUTING.md  CODE_OF_CONDUCT.md  SECURITY.md  CHANGELOG.md
└── package.json  tsconfig.json  tsup.config.ts  vitest.config.ts  eslint.config.js  .prettierrc.json
```

### 8.2 Toolchain

| Concern | Choice | Why |
|---|---|---|
| Language | TypeScript, `strict` | Types are a deliverable, not a by-product |
| Build | **tsup** | Dual ESM+CJS plus `.d.ts` in one config; near-zero ceremony |
| Test | **Vitest** + **fast-check** | Native ESM, fast, good fake-timer support for the batching tests; property tests for "never contains a newline" and the byte cap |
| Lint/format | ESLint + Prettier | Conventional; keeps contributor friction low |
| Versioning | **Changesets** | PR-authored changelog entries; works cleanly with OSS contributions |
| CI | GitHub Actions | One job, `ci` (the required status check), on Node 22: typecheck, lint + Prettier, **build, then tests** (`test/node/` spawns node against `dist/`), edge-bundle check. `engines` declares a Node 20.9 floor that CI does not exercise; a matrix would rename the required check |

### 8.3 Things CI must actually assert

Beyond the usual, three project-specific gates:

1. **No `node:*` import reaches `dist/edge.js`.** Assert it by grepping the bundle — a
   regression here breaks Edge consumers at deploy time, not build time. The grep alone is not
   enough: measured while scaffolding (#5), tsup by default rewrites `node:fs` to a bare `fs`,
   which a `node:`-only grep misses. So it is enforced in three layers: an ESLint
   `no-restricted-imports` ban on every built-in (bare and `node:`) in `src/core`,
   `src/transports` and `src/edge.ts`; an esbuild plugin in `tsup.config.ts` that fails the
   Edge build on any built-in (with `removeNodeProtocol: false`, so the prefix survives to be
   seen); and the CI grep as a last check.
2. **The public API surface is snapshotted.** An accidental type-level breaking change in a
   logger is painful to discover downstream.
3. **`send()` never rejects**, asserted against a transport whose `fetch` throws, returns `500`,
   returns `401`, and times out. This is the headline guarantee; test it like one. Implemented
   (#13) as `test/contract/transport.contract.ts`, a suite parameterised over every transport:
   `send` never throws or rejects (hostile events for all; the `fetch` failure modes for the
   webhook), `flush` is bounded at both the transport and the logger level, a hanging transport
   never blocks the caller, and the caller's context is never mutated.

---

## 9. Verification

Unit tests prove the formatter and the retry logic. They cannot prove the thing that actually
matters — that a line posted from Node appears in Rapid7. That needs a live test.

### 9.1 What to verify against the live endpoint

| Claim | How |
|---|---|
| A lone event is delivered | Post one line with a fresh UUID; query for it |
| Delivery latency | Measure post → queryable. Expect the Rapid7 stamp ~0.5 s after sending, but **searchable via the Query API only after ~10 s**, so poll for ≥ 30 s |
| Multi-line is not shredded | Log an `Error` with a real stack; confirm **one** entry, intact |
| Success code is `204` | Assert the status |
| A bad token does not throw | Point at a **malformed** token (→ `404`); assert the app survives and `stats().failed` rises. A well-formed wrong token returns `204` (§2.6), so it cannot be asserted this way |
| The correlation stamp is clickable | Manual, once — check in the Rapid7 UI (§2.5) |
| Truncation marker appears | Post > `maxBytes`; confirm the marker |
| A quoted value is parsed as the pair's value | Post `key="two words"`; query `where(key="two words")` — unmeasured, the formatter (#7) assumes it |
| U+2028 / U+2029 do not split an entry | Post a line containing each; confirm one entry — unmeasured, the formatter leaves them alone |

### 9.2 Gated live test

```ts
// test/live/webhook.live.test.ts
const token = process.env.RAPID7_LIVE_TOKEN;
describe.skipIf(!token)('live webhook', () => { /* … */ });
```

Rules: **skipped by default**, so a clone with no credentials has a green test run; never runs
on pull requests from forks; credentials come from environment variables only — **no token or
API key is ever committed, and none appears in this document**.

Confirming arrival requires the Rapid7 **Query API**, which uses a *different* credential (a
read API key) from the ingestion token. Keep that client in `test/live/` only — it is test
infrastructure, not part of the shipped package (§3.3).

As implemented (#14): `test/live/webhook.live.test.ts` runs end to end through
`createLogger({ token, region })` and reads back through `test/live/query-api.ts`. It takes the
four variables the spike settled — `RAPID7_LIVE_TOKEN`, `RAPID7_LIVE_REGION`,
`RAPID7_LIVE_LOG_ID`, `RAPID7_QUERY_API_KEY` (see `.env.example`); with only the token set, the
read-back assertions skip and the post path still runs. It asserts a lone event is accepted
and found, that Rapid7's own stamp is within 5 s of the post (measured ~0.5 s) and the entry
is searchable within 60 s (measured ~10 s), and that a real nested stack trace is stored as
one entry identical to the formatter's line.

---

## 10. Publishing to npm

### 10.1 The decision

**Public repository in the Geekibo org; the package published to the public npm registry;
releases cut only by a maintainer from a reviewed, protected `main`.**

| | |
|---|---|
| **Source** | `github.com/geekibo/rapid7-logger` — public, readable and forkable by anyone |
| **Registry** | **npmjs.org only.** `npm install @geekibo/rapid7-logger` with no account, no token, no `.npmrc` |
| **Contribution** | Pull requests from anyone; **merge gated** by review + CI (§11) |
| **Release** | Maintainer-controlled, versioned deliberately, published by CI from `main` (§10.4) |

GitHub Packages is **dropped entirely**. It is not a mirror and not a fallback: it requires a
classic PAT to install *even for public packages*, so any consumer who reached for it would hit
auth friction that npmjs doesn't have. Publishing to both would mean documenting two install
paths, one of which is strictly worse. One registry, no caveats.

This separates the two things cleanly, which is exactly the model you want:

- **Reading and contributing is open.** Anyone can clone, fork, open a PR, audit the transport.
- **Shipping is closed.** Only a reviewed commit on `main` can become a version, and only a
  maintainer decides when that happens.

### 10.2 Publish with OIDC trusted publishing — no npm token at all

This supersedes the `NPM_TOKEN` secret I had sketched earlier. Verified against npm's official
documentation 2026-10-08:

> npm **trusted publishing** authenticates a GitHub Actions workflow to npm over OIDC. **No
> token is needed to publish**, and **provenance is generated automatically** for a public repo
> publishing a public package.

Why this matters more than convenience: a long-lived `NPM_TOKEN` in repository secrets is the
single most valuable thing an attacker can steal from a package repo, and the thing most npm
supply-chain compromises have turned on. Trusted publishing means **there is no such secret to
steal**. For a brand-new scope asking strangers to trust it, that plus automatic provenance —
a cryptographic link from the published tarball back to the exact commit and workflow that built
it — is a large part of the answer to "why should I install this".

**Requirements** (all from npm's docs, all satisfiable):

| Requirement | Value |
|---|---|
| npm CLI | **>= 11.5.1** |
| Node (in the release job) | **>= 22.14.0** |
| Runner | **GitHub-hosted only** — self-hosted is not supported |
| Workflow permission | `id-token: write` (plus `contents: read`) |
| Provenance | **Automatic.** The `--provenance` flag is unnecessary |
| Repo/package visibility | Public repo + public package — required for provenance |

### 10.3 Configuring the trusted publisher

On npmjs.com, under the package's **Settings → Trusted Publisher**, choose GitHub Actions and
enter:

| Field | Value |
|---|---|
| Organization or user | `geekibo` |
| Repository | `rapid7-logger` |
| Workflow filename | `release.yml` — **filename only**, must live in `.github/workflows/` |
| Environment | `release` — optional, but take it (§11.3) |
| Allowed actions | See the two-key option below |

Five sharp edges, each of which has burned someone:

1. **npm does not validate the configuration when you save it.** A typo surfaces only as a
   failed publish. Expect the first release to be the real test.
2. **`repository.url` in `package.json` must exactly match the GitHub repository.** Mismatch is
   rejected at publish time.
3. **A new configuration must complete a successful publish within 2 days or it expires.** Set
   it up when you are ready to release, not weeks ahead.
4. **Workflow *filename*, not path** — and renaming `release.yml` later silently breaks
   publishing until you update npm's side.
5. A package may have at most **10** trusted publishers.

**The two-key release option.** `npm stage publish` is always permitted; `npm publish` and
`npm dist-tag` are separately enablable. If you allow **only `npm stage publish`**, CI can
*stage* a version but cannot release it — a human must then approve the staged version
interactively (CLI or npmjs.com), which **requires 2FA**. CI alone can never publish.

That is the strongest configuration, and it fits "review, then version" precisely. The cost is a
manual approval per release. Recommendation: **start with `npm publish` allowed** while releases
are frequent and the package is `0.x`, and move to stage-only at `1.0.0`, when releases get rarer
and the consequence of a bad one gets larger.

Separately, under **Settings → Publishing access**, enable **require 2FA and disallow tokens**.
This does not affect trusted publishing (OIDC isn't a token) but it closes the side door — a
stolen credential cannot publish, because no credential is authorised to.

### 10.4 Release flow

Releases are **Changesets-driven**, so the version bump is a reviewed artefact rather than a
command someone runs from a laptop:

```
contributor PR  ──►  includes a changeset describing the change (patch/minor/major)
       │
       │  review + CI (§11)
       ▼
  merge to main  ──►  Changesets bot opens/updates a "Version Packages" PR
       │                 (bumps version, writes CHANGELOG.md)
       │
       │  maintainer reviews and merges THAT PR  ◄── this is the release decision
       ▼
 release.yml  ──►  environment approval (§11.3)  ──►  npm publish via OIDC
```

Nothing publishes as a side effect of merging a feature. The release is its own reviewed,
deliberate act — merging the Version Packages PR — and it is obvious in the history what was
released and why.

```yaml
# .github/workflows/release.yml
name: release
on:
  push:
    branches: [main]

permissions:
  contents: read

jobs:
  release:
    runs-on: ubuntu-latest
    environment: release          # must match the trusted publisher's environment
    permissions:
      contents: write             # tag + GitHub release
      id-token: write             # REQUIRED: mints the OIDC token
      pull-requests: write        # Changesets' Version Packages PR
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v5
        with:
          node-version: 22        # >= 22.14 for trusted publishing
      - run: npm install -g npm@latest     # >= 11.5.1
      - run: npm ci
      - run: npm run typecheck && npm run lint && npm test && npm run build
      - uses: changesets/action@v1
        with:
          publish: npm run release         # `changeset publish` — no NODE_AUTH_TOKEN
```

Note what is absent: **no `secrets.NPM_TOKEN`, and no `--provenance`.** Both are handled by
OIDC. If you see a token being added back, something is misconfigured.

### 10.5 Versioning

Publish **`0.1.0`** first — the package starts at `0.0.0` and the first `minor` changeset
produces `0.1.0` through the reviewed release PR (§4.2, §10.4) — and stay in `0.x` until the live verification in §9 has run against real
traffic for a sustained period. `1.0.0` is a promise that the delivery contract in §7 is stable —
don't make it on the strength of passing unit tests.

The two surfaces most likely to force a breaking change are the **`Transport` interface** and the
**`format` callback**. Design them last, mark them as the stability risk in the README, and
consider shipping `1.0.0` with `Transport` documented as internal-but-exported so that
refining it isn't a major bump.

---

## 11. Repository governance — open to read, gated to change

The goal: anyone can contribute, nobody can land anything unreviewed, and a fork cannot reach
your credentials. Everything below is a GitHub-native control.

### 11.1 Ruleset on `main`

Use a **repository ruleset** (the current mechanism; classic branch protection is legacy).
Rules to enable, all confirmed available:

| Rule | Setting | Why |
|---|---|---|
| **Require a pull request before merging** | on | No direct pushes to `main`, ever |
| └ Required approvals | **see §11.2** | The one setting with a solo-maintainer trap |
| └ Dismiss stale approvals | on | A re-push after approval must be re-reviewed |
| └ Require review from Code Owners | on | Pairs with `CODEOWNERS` (§11.4) |
| └ Require approval of most recent reviewable push | on | The last pusher can't be the approver |
| └ Require conversation resolution | on | No merging over unanswered review comments |
| **Require status checks to pass** | on, **strict** | Typecheck, lint, test, build must be green *and* the branch up to date |
| **Block force pushes** | on (default) | History on `main` is append-only |
| **Require linear history** | on | Squash merges; a clean, bisectable `main` |
| **Require signed commits** | optional | Strong, but note an unsigned commit on a PR head can block a squash merge — it adds contributor friction, so consider deferring |
| **Require deployments to succeed** | not needed | Release gating is handled by the environment (§11.3) |

### 11.2 The solo-maintainer trap — decide this consciously

**A PR author cannot approve their own pull request.** So if you set *required approvals* to 1
while you are the only maintainer, you block **your own** merges — including the Version Packages
PR that cuts every release.

Three ways out, in the order I'd take them:

1. **Required approvals = 0, everything else on.** You still get: no direct pushes, mandatory PR,
   mandatory green CI, mandatory conversation resolution, no force pushes. A drive-by PR still
   cannot merge itself, because only you can click merge. **This is the right starting point for
   a one-maintainer repo** — it keeps every protection that actually stops bad code and drops the
   one that only stops *you*.
2. **Required approvals = 1, with yourself as a bypass actor.** Rulesets let you name bypass
   actors (roles, teams, or GitHub Apps). Worth knowing: there is at least one community report
   of admin bypass behaving differently once a ruleset moves from *evaluate* to *active* mode, so
   if you take this route, **create the ruleset in evaluate mode first and confirm the bypass is
   recorded before activating it.**
3. **Required approvals = 1, no bypass** — the moment a second maintainer exists. This is the
   end state; don't adopt it early and then route around it, because a bypass you use daily is
   not a control.

Raise it to option 3 as soon as there is someone to review. Until then, option 1 is honest
protection rather than theatre.

### 11.3 Gating the release job with a GitHub Environment

Create an environment named **`release`** with **required reviewers** (you). Then:

- `release.yml` declares `environment: release`, so the publish job **pauses for approval**
  before it runs.
- npm's trusted publisher is configured with that same environment name, so a workflow run that
  is *not* in the `release` environment **cannot** mint a valid OIDC token — the registry itself
  enforces it, not just your YAML.

That is the second lock, and it's the one that makes "we review and then version the published
package" mechanically true: an approved merge is not a release until a human releases it.

### 11.4 Fork and Actions safety on a public repo

Public repos have specific hazards. These are the ones that matter:

- **Secrets are never exposed to `pull_request` runs from forks.** This is the default and it is
  correct — keep it. It also means the live tests in §9.2 *will* skip on fork PRs, which is why
  they are written to skip rather than fail.
- **Never use `pull_request_target`** for CI on untrusted code. It runs with the base repo's
  permissions and secrets against the fork's code — the classic public-repo compromise. If you
  think you need it, you don't.
- **Set default workflow permissions to read-only** at the repo level, and grant write scopes
  per job (as `release.yml` does). A workflow with blanket `write` is a lateral-movement path.
- **Require approval for all outside contributors' workflow runs**, so a first-time PR cannot
  execute CI until you've glanced at it.
- **Pin third-party actions**, ideally to a commit SHA. `actions/*` by major tag is a reasonable
  compromise; anything else, pin hard.
- **`npm ci`, never `npm install`, in CI**, so a PR cannot quietly float a dependency.
- Note the residual risk honestly: trusted publishing does **not** protect against malicious code
  inside the trusted workflow itself — a compromised dependency executing during `npm ci` in the
  release job runs with the ability to publish. Zero runtime dependencies (§4.2) and a small,
  reviewed devDependency set are the real mitigation.

### 11.5 Ownership and contribution

- **`CODEOWNERS`** — `* @<your-handle>`, with the ruleset requiring Code Owner review. Every PR
  routes to you automatically.
- **`CONTRIBUTING.md`** — state plainly: fork, branch, add a changeset, open a PR; unit tests run
  with no credentials; live tests are expected to skip; maintainers cut releases.
- **Issue and PR templates** — a bug template that asks for runtime (Node/Next/Edge), region, and
  `log.stats()` output will save most of the back-and-forth.
- **Enable Dependabot** (security + version updates) and **secret scanning with push protection** —
  both free on public repos, and push protection is what stops an ingestion token being committed
  in the first place, which given §1.3 is not hypothetical.

---

## 12. Open-source hygiene

- **LICENSE** — MIT. Permissive, expected for infrastructure, no adoption friction.
- **README** — the thing that determines whether anyone uses it. Lead with the problem (§1.1–1.2:
  the stale alternatives and the silent-drop bug), then a five-line quick start, then the Next.js
  section, then the delivery contract (§7). The endpoint findings in §2 are useful to anyone
  integrating Rapid7 from *any* language — publishing them is a genuine contribution and will do
  more for adoption than feature count.
- **SECURITY.md** — a reporting route (enable private vulnerability reporting), plus an explicit
  statement that the ingestion token is a **write credential** that must never reach a browser.
- **CODE_OF_CONDUCT.md** — Contributor Covenant.
- **Keywords** in `package.json`: `rapid7`, `insightops`, `logentries`, `logging`, `logger`,
  `nextjs`, `serverless`, `structured-logging`. These are the searches that currently return
  nothing maintained.
- **Repo metadata** — description, topics, and a link to the npm package. Cheap, and it is how
  people arrive.

---

## 13. Risks and open decisions

| # | Risk | Mitigation |
|---|---|---|
| R1 | InsightOps "no longer sold" (§1.4) — the backend may be sunset | `Transport` seam (§4.3) keeps a future backend additive. Accept and proceed. |
| R2 | Undocumented size/rate limits (§2.1) | Measured 2026-10-08: a 32,767-byte per-entry cap, with longer bodies silently split into several entries, and `413` from 65,536; no rate limit seen up to ~164 req/s. Client-side truncation under the cap (§5.4), concurrency cap, `Retry-After` handling kept as a defence. Re-check under real traffic (§14 phase 8). |
| R3 | One request per event limits throughput | Measure in §9. If it binds, the honest answer is stdout + a cluster collector, not a cleverer client. |
| R4 | Serverless freeze silently loses logs (§7.3) | `after()` by default in `withLogging`; eager flush on `error`+. Make the failure mode a documented, tested case. |
| R5 | Duplicates from at-least-once retry (§7.1) | Documented in the contract. Flagged for anything that counts events. |
| R6 | Token leaks to a browser bundle | Four layered defences (§6.5), including a build-time error. Plus secret scanning with push protection (§11.5). |
| R7 | Maintenance burden of a public package | Tight scope (§3.3); zero runtime dependencies means little routine upkeep. |
| R8 | **Trusted publisher misconfiguration** — not validated on save, expires if unused for 2 days (§10.3) | Configure it immediately before the first release, and treat that release as the test. |
| R9 | **Renaming `release.yml` silently breaks publishing** | Note it in `CONTRIBUTING.md`; the filename is part of npm-side config. |
| R10 | **Required approvals = 1 locks out a solo maintainer** (§11.2) | Start at 0 with every other rule on; raise when a second maintainer exists. |
| R11 | Compromised devDependency in the release job can publish (§11.4) | Zero runtime deps, small reviewed devDeps, `npm ci`, pinned actions; stage-only publishing at `1.0.0`. |
| R12 | **A wrong token or region fails silently** — the endpoint answers `204` (§2.6) | Documented in the contract. Only a malformed token surfaces as an error; confirming delivery needs a Query API read-back. Config shape validated at construction (§13, settled). |

**Decisions still open:**

1. **Exact org slug and repo name** — this document assumes `github.com/geekibo/rapid7-logger`
   and the npm scope `@geekibo`. Confirm both, and **claim the `@geekibo` scope on npmjs early** —
   scope squatting is real and the name is load-bearing in every example here.
2. **Default `flushMode`** — recommend batch, with eager flush at `error` and above (§7.3).
   The queue (#9) already drains eagerly on `error`+ by default. *Settled for the Node entry
   (#15):* no `flushMode: 'sync'` option — it would turn the level methods into promises
   (reversing the #6 decision), and `log.error(…); await log.flush()` already awaits delivery
   because the queue drains eagerly on `error`+. `withLogging` (#19) may still offer its own
   `flushMode`.
3. **Whether to ship `withLogging` in v1** or keep v1 to the primitive logger. It is the piece
   most likely to need redesign after real use; shipping it in `0.x` is fine, in `1.0` less so.
4. **Require signed commits?** (§11.1) Strong, but it adds real contributor friction and can
   block squash merges. Defer unless you want it from day one.

*Settled:* registry (npmjs only, §10.1), publish credential (OIDC trusted publishing, no token,
§10.2), release mechanism (Changesets + environment approval, §10.4), package name
(`@geekibo/rapid7-logger`, §3.1), and catching a misconfigured token (§2.6, settled 2026-10-08):

- **Validate the config shape at construction.** The token (trimmed; empty counts as absent)
  must be a GUID and the region (trimmed, case-insensitive) one of `eu`, `us`, `au`, `ca`,
  `jp`. A value that fails is treated like an absent token: the logger
  falls back to console-only and reports it once through `onInternalError`. It never throws.
  This catches malformed tokens and mistyped regions at startup rather than as runtime `404`s.
- **Document what it cannot catch.** The README contract states that a `204` means *accepted*,
  not *delivered*: a well-formed wrong token or the wrong region succeeds silently, so consumers
  should search for their first events after deploying. A periodic heartbeat with a Rapid7
  "absence" alert is suggested as optional consumer-side guidance.
- **Rejected:** a startup read-back through the Query API. It needs a second credential, adds
  ~10 s, and puts a Query API client in the shipped package, which §3.3 rules out.

---

## 14. Suggested phasing

| Phase | Deliverable | Done when |
|---|---|---|
| **0** | Spike: ~30 lines, post one line to the live endpoint from Node, confirm it appears | The endpoint behaves as §2 says — **verify before building on it** |
| **1** | Core: types, levels, formatter, redaction, bounded queue, `MemoryTransport` | Unit tests green; no Node built-ins in core |
| **2** | `Rapid7WebhookTransport`: fetch, retry, concurrency cap, keep-alive | Contract tests prove `send` never rejects; live test §9.2 passes |
| **3** | Node entry: `createLogger`, `child`, `AsyncLocalStorage` trace, lifecycle flush | `examples/node-basic` works end to end |
| **4** | Next entry: `onRequestError`, `withLogging`, `after()` flush, `server-only` | `examples/nextjs-app` works; a client import is a **build error** |
| **5** | Edge entry: immediate-send | Bundle contains no `node:*`; runs on Edge |
| **6** | **Repo hardening**: ruleset on `main`, `CODEOWNERS`, `release` environment, read-only default Actions permissions, Dependabot, secret scanning | A direct push to `main` is refused; a fork PR runs CI with no secrets |
| **7** | Docs, CI, Changesets, npm scope claimed, trusted publisher configured, **`0.1.0` published** | `npm install @geekibo/rapid7-logger` works on a clean machine with **no auth**, and the npm page shows a **provenance** badge |
| **8** | Real-world shakedown on one application; fold findings back into §2 and §7 | Logs arrive reliably over a week, **including from a quiet environment** (the §1.2 failure mode) |
| **9** | `1.0.0`; consider moving to stage-only publishing (§10.3) | The §7 delivery contract has held under real traffic |

Phase 0 exists because of the one lesson worth carrying into this: **measure the thing, don't
reason about the configuration.** Every surprising fact in §2 — the newline rule, the clickable
stamp, the lone-event drop — was found by posting to the endpoint and looking, and none of them
could have been deduced from the documentation.

Phase 6 deliberately precedes Phase 7. Harden the repository *before* the first publish, so the
protections are in place the moment the package becomes something worth attacking.

---

## Appendix A — Sources

**Verified against the live endpoint**

Everything in §2 — the endpoint URL and regions, one-event-per-request, the first-line-only
behaviour, the `204` response, the retry policy, the batching defaults and the clickable-stamp
finding — comes from a production **.NET** implementation of this same transport, whose authors
verified each behaviour by posting to the live endpoint and observing the result. Those
verifications are dated **2026-07-16** and **2026-08-21**.

None of it is deducible from the vendor documentation, which is precisely why it is written down
here. Phase 0 (§14, #4) re-verified it from Node (v20.20.0, undici 6.23.0) against the live EU
endpoint on **2026-10-08**, using `spike/webhook-contract.mjs`. The wrong-token, size-limit,
rate and Query API latency findings in §2 and §5.4 come from that run.

Publish dates in §1.1 were queried from the npm registry on 2026-10-08.

**External documentation, fetched 2026-10-08**

- [Rapid7 — InsightOps webhook](https://docs.rapid7.com/insightops/insightops-webhook/) — URL
  format, `204` response, newline guidance, absence of documented limits, "no longer sold" notice.
- [Rapid7 — JavaScript/HTML5](https://docs.rapid7.com/insightops/javascripthtml5) — region guidance.
- [Next.js — `instrumentation.ts`](https://nextjs.org/docs/app/api-reference/file-conventions/instrumentation)
  (16.4 copy) — `onRequestError` signature, `error: unknown`, `context` fields, digest caveat,
  `NEXT_RUNTIME`.
- [npm — Trusted publishers](https://docs.npmjs.com/trusted-publishers) — OIDC setup, no token
  required, npm >= 11.5.1 / Node >= 22.14, GitHub-hosted runners only, automatic provenance,
  `repository.url` matching, 2-day first-publish window, 10-publisher limit, `npm stage publish`
  and the 2FA interaction.
- [GitHub — Available rules for rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets)
  — the §11.1 rule list, sub-options, strict status checks, bypass actors.
- [GitHub — Working with the npm registry](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-npm-registry)
  — authentication required even for public packages; classic PAT only. The basis for dropping
  GitHub Packages in §10.1.
- [GitHub Community — ruleset bypass in evaluate vs active mode](https://github.com/orgs/community/discussions/153705)
  — the unresolved bypass-behaviour report referenced in §11.2.
