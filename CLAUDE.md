# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# @geekibo/rapid7-logger

## Read this first

**[docs/DESIGN.md](docs/DESIGN.md) is the source of truth for this package** — architecture,
public API, the delivery contract, the endpoint findings, governance and phasing. It is ~1,080
lines and it is not background reading: issues reference its section numbers, and most "why is it
done this way" questions are answered there.

Before working on anything, read:

- **§2 — What the endpoint actually does.** Three non-obvious behaviours dictate the whole
  design, and none of them are in the vendor documentation. Do not write transport code without
  this.
- **§7 — Reliability semantics.** The delivery contract is a published promise, not an
  implementation detail.
- The section the issue you are working on cites.

## What this package is

A logger that ships events to the Rapid7 InsightOps HTTP webhook from Node.js and Next.js
(including the Edge runtime). It exists because no maintained JS client exists and the incumbent
TCP transport **silently drops isolated low-frequency events** (§1.2).

The design is a **port of a proven .NET implementation**, not an invention. When in doubt, the
behaviour described in §2 and §7 is the specification — prefer matching it over improving it,
and raise a question rather than quietly diverging.

## Non-negotiable invariants

These are correctness, not style. A change that breaks one of these is wrong even if tests pass.

1. **One event per HTTP request.** `/v1/noformat` does not split a newline-delimited body (§2.2).
2. **No interior newlines in the body — ever.** Flatten `\r\n` and `\n` to spaces before posting,
   or multi-line messages and stack traces are truncated or shredded into unrelated entries.
   This must not be configurable.
3. **`send()` never throws and never rejects.** A logging failure must never fail a user's
   request. Assert it against a transport whose `fetch` throws, returns 500, returns 401, and
   times out.
4. **`flush(timeoutMs)` is bounded.** It returns when the timeout elapses whether or not the
   queue drained. An unbounded flush on shutdown is a hung pod.
5. **The queue is bounded and drops on overflow.** Never block an application thread to log.
6. **Zero runtime dependencies.** A logger is infrastructure; every dependency is inherited by
   every consumer. `dependencies` stays `{}`.
7. **Server-only.** No browser entry point, no `window`, no `navigator`. The ingestion token is a
   **write credential** — if it reaches a client bundle, anyone can write into the log estate.
   The Next entry point starts with `import 'server-only'` so a Client Component import is a
   *build* error (§6.5); `sideEffects` lists the Next bundles so that import survives
   tree-shaking, and `test/next-build/` proves it with a real `next build` in its own CI job.
8. **The core imports no `node:*` modules.** It must run on Edge and in Workers. Node-specific
   code (`process.on`, `AsyncLocalStorage`) lives in the Node entry point only. The Next entry
   runs on Edge too, so it gets the same rules. Enforced three ways (§8.3): ESLint bans
   built-in imports in `src/core`, `src/transports`, `src/edge.ts`, `src/next.ts` and
   `src/next/`; a plugin in `tsup.config.ts` fails the Edge and Next builds on one; CI greps
   `dist/edge.js`, `dist/next.js` and `dist/next.cjs`. Keep `removeNodeProtocol: false` on
   those builds — tsup otherwise rewrites `node:fs` to `fs`.
9. **Never log a credential.** Redaction (§6.6) runs *before* the formatter and applies to nested
   objects.

## Architecture at a glance

```
entry points   index.ts (Node) · next.ts (Next.js) · edge.ts (Edge, immediate-send)
core           logger · formatter · redact · queue · levels · types     (runtime-agnostic)
transports     Rapid7WebhookTransport · ConsoleTransport · MemoryTransport
```

The `Transport` interface (§4.3) is the seam that keeps a future backend additive. Rapid7's
InsightOps is officially "no longer sold" (§1.4), so do not weld the core to the webhook — but
equally, do not ship a second transport speculatively.

## Working practices

- **TypeScript strict.** Types are a deliverable.
- **tsup** for dual ESM/CJS + `.d.ts`; **Vitest** for tests; ESLint + Prettier.
- **Changesets.** Every user-visible change needs a changeset in its PR — that is what versions
  the release, so a PR without one is incomplete.
- **`npm ci`, never `npm install`, in CI**, so a PR cannot quietly float a dependency.
- Match the surrounding code's naming, comment density and idiom.

### Current state and commands

Phase 0 (#4) is done and the toolchain is scaffolded (#5). `src/core/` has the types, levels,
config validation, `createLogger` (#6), the formatter (#7, `formatEvent`/`createFormatter`,
not yet called by a transport), redaction (#8, on by default, runs in `emit` before
delivery) and the bounded queue (#9, `src/core/queue.ts`, owns all six counters;
`Transport.send` may resolve a `SendOutcome`). `ConsoleTransport` and `MemoryTransport` (#10, `src/transports/`) render through the
formatter. `Rapid7WebhookTransport` (#11) is wired in: a valid token posts to Rapid7 with the §7.1
retry policy (#12), anything else degrades to the console. `composeLogger` is the internal
seam Edge (#22) uses to swap in immediate send. Tests that create a logger with a valid-shaped
token must stub `fetch`.
The Node entry (#15) wraps the core `createLogger` with lifecycle flush hooks under
`src/node/` and adds `close()`; correlation (#16) is a core `contextProvider` seam plus pure
W3C helpers in `src/core/traceparent.ts` and an `AsyncLocalStorage` store in
`src/node/trace.ts` (`withTrace`, `outboundHeaders`); `src/next.ts` (#18, #19) exports the core `createLogger`, `createRequestErrorHandler` and
`withLogging` (`src/next/`, structural Next types — `next` is not installed; `after()` is
reached by a dynamic `import('next/server')` that must stay dynamic, and
`src/next/next-server.d.ts` is an ambient stand-in that must never ship); `src/edge.ts` (#22)
is the same core over `src/core/immediate.ts` — every call sends at once, `flush()` awaits
them, level methods still return `void`, and it deliberately carries no `import 'server-only'`
(that would throw at load in a non-Next worker). Both must import from the core, never from `src/index.ts` or `src/node/`. Work proceeds phase by phase (§14).
The target layout is §8.1 and the `exports` map is §4.2 — follow them rather than inventing a
structure.

`spike/webhook-contract.mjs` is the phase 0 measurement script (#4). When a §2 fact is in doubt,
re-run its probe (`node --env-file=.env spike/webhook-contract.mjs <probe>`) rather than
reasoning about it. It is not shipped and nothing in `src/` may import it.

CI (`.github/workflows/ci.yml`) runs these scripts by name; a rename breaks CI:

```sh
npm run typecheck   # tsc --noEmit
npm run lint        # eslint . && prettier --check .   (npm run format to fix)
npm run build       # tsup → dist/{index,next}.{js,cjs,d.ts,d.cts}, dist/edge.{js,d.ts} (ESM-only)
npm test            # vitest run — after build; live tests skip without RAPID7_LIVE_TOKEN
npm run test:next-build   # the next build guard; needs npm ci --prefix test/next-build/fixture
npm run test:next-app     # builds, starts and drives examples/nextjs-app; needs npm ci --prefix examples/nextjs-app
```

`release.yml` (#25) is three jobs: `select-mode`, then `version` (pending changesets ⇒ opens or
updates the "Version Packages" PR, no approval) or `publish` (none pending ⇒ waits for the
`release` environment reviewer — that prompt means a publish is about to happen; approve it
only for a merged, reviewed Version Packages PR). The bot-opened PR needs "Approve workflows to
run" before `ci` runs on it. Never delete a changeset from `main`; `ci` fails a PR that
changes `src/` without one (`npx changeset --empty` if it is not user-visible). The Changesets
CLI needs Node ≥ 22 — write the file by hand on 20.
`0.1.0` was published by hand because npm cannot bind a trusted publisher to an unpublished
name (§10.3, "What the first publish actually looked like"). The trusted publisher is now
configured and validated: `0.1.1` and every later release go through `release.yml` with
provenance (#26).

Single test: `npx vitest run test/unit/package.test.ts -t "zero runtime dependencies"`.
CI runs on Node 22; the package's `engines` floor is Node 20.9 (DESIGN §8.2). TypeScript is
pinned to `~5.9`: `typescript-eslint` 8 does not yet accept TypeScript 6+.
Prettier skips `*.md`, `.github/` and `spike/` — don't reformat those.

### Testing

- `test/unit/` — fake `fetch`; formatter, redaction, retry policy, queue bounds. Runs anywhere,
  no credentials.
- `test/contract/` — the `Transport` invariants above, especially #3 and #4. `transport.contract.ts`
  is a `describe` factory; add a one-line `*.contract.test.ts` for any new transport.
- `examples/node-basic/` imports the package by name through a symlink the `test/node/` example
  test creates; it must stay consumer-shaped (no `../../dist` imports).
- `examples/nextjs-app/` installs the package with `file:../..` and a committed lockfile; its
  `next.config.ts` sets `turbopack.root` only because of that symlink.
- `test/next-build/` — a pinned Next fixture built with and without a `'use client'` misuse;
  skips locally unless the fixture is installed, fails in CI if it cannot run.
- `test/next-app/` — builds and starts `examples/nextjs-app` against a local log server and
  drives a render error, a Route Handler and a Server Action (invoked with the `Next-Action`
  header); same skip/fail rule. Its `error.tsx` is a Client Component and must never import
  the logger — the test asserts that at the source level.
- `test/node/` — lifecycle integration: spawns `node` on fixtures that import the **built**
  `dist/`, so run `npm run build` before `npm test` locally (CI builds before testing; the
  suite skips without `dist/` locally and fails without it when `CI` is set).
- `test/live/` — **skipped by default** via `describe.skipIf(!process.env.RAPID7_LIVE_TOKEN)`.
  To run it: copy `.env.example` to `.env`, point it at a dedicated log, then
  `node --env-file=.env node_modules/.bin/vitest run test/live`.
  A clone with no credentials must have a fully green test run, and fork PRs get no secrets, so
  these must *skip*, never fail.
- **Never commit a token.** Not in a test, not in a fixture, not in a comment. Credentials come
  from environment variables only.

### Measure, don't reason

Every surprising fact in §2 — the newline rule, the clickable-stamp form, the lone-event drop —
was found by posting to the endpoint and looking at what came back. None was deducible from the
documentation, and one widely-held assumption about the endpoint turned out to be wrong.

When a question is empirical, answer it empirically. If you find that reality differs from
docs/DESIGN.md, **update the design document in the same PR** and say what you measured. A design
doc that quietly drifts from the code is worse than none.

## Repository rules

- **`main` is protected.** All changes land by pull request with green CI. Do not attempt to push
  to `main`.
- **Never use `pull_request_target`** in a workflow. This is a public repo; that trigger runs
  untrusted code with the base repo's secrets, and it is the classic public-repo compromise.
- **Default workflow permissions are read-only.** Grant write scopes per job.
- **Releases publish via npm OIDC trusted publishing** — there is deliberately no `NPM_TOKEN` in
  this repository. Do not add one. Renaming `.github/workflows/release.yml` breaks publishing
  until npm's trusted-publisher config is updated to match (§10.3).

### Git commits are the maintainer's

**Do not run `git commit`.** Make changes freely — edits, builds, tests — then stop and report
what is ready to commit. This holds even when a commit looks like the obvious next step, and it
applies to subagents too: strip any commit step from a delegated prompt. The only exception is
the maintainer explicitly asking for a commit in the current turn.

### No AI attribution

Never add "Generated with Claude Code" or any equivalent attribution line to anything — commit
messages, PR descriptions, issue bodies, code comments, or documentation.
