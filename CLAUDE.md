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
   The Next entry point must `import 'server-only'` so a Client Component import is a *build*
   error (§6.5).
8. **The core imports no `node:*` modules.** It must run on Edge and in Workers. Node-specific
   code (`process.on`, `AsyncLocalStorage`) lives in the Node entry point only. Enforced three
   ways (§8.3): ESLint bans built-in imports in `src/core`, `src/transports` and `src/edge.ts`;
   a plugin in `tsup.config.ts` fails the Edge build on one; CI greps `dist/edge.js`. Keep
   `removeNodeProtocol: false` on the Edge build — tsup otherwise rewrites `node:fs` to `fs`.
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
config validation and `createLogger` (#6); `createLogger` delivers straight to a minimal
`ConsoleTransport` until the queue (#9) and the webhook transport (#11, wired by #15) land.
`src/next.ts` and `src/edge.ts` are still stubs. Work proceeds phase by phase (§14). The target layout is §8.1 and the
`exports` map is §4.2 — follow them rather than inventing a structure.

`spike/webhook-contract.mjs` is the phase 0 measurement script (#4). When a §2 fact is in doubt,
re-run its probe (`node --env-file=.env spike/webhook-contract.mjs <probe>`) rather than
reasoning about it. It is not shipped and nothing in `src/` may import it.

CI (`.github/workflows/ci.yml`) runs these scripts by name; a rename breaks CI:

```sh
npm run typecheck   # tsc --noEmit
npm run lint        # eslint . && prettier --check .   (npm run format to fix)
npm test            # vitest run — live tests skip without RAPID7_LIVE_TOKEN
npm run build       # tsup → dist/{index,next}.{js,cjs,d.ts,d.cts}, dist/edge.{js,d.ts} (ESM-only)
```

`release.yml` also calls `npm run version` and `npm run release`; those arrive with Changesets
in #25. Until then, reject any `release` run waiting on the `release` environment.

Single test: `npx vitest run test/unit/package.test.ts -t "zero runtime dependencies"`.
CI runs on Node 22; the package's `engines` floor is Node 20.9 (DESIGN §8.2). TypeScript is
pinned to `~5.9`: `typescript-eslint` 8 does not yet accept TypeScript 6+.
Prettier skips `*.md`, `.github/` and `spike/` — don't reformat those.

### Testing

- `test/unit/` — fake `fetch`; formatter, redaction, retry policy, queue bounds. Runs anywhere,
  no credentials.
- `test/contract/` — the `Transport` invariants above, especially #3 and #4.
- `test/live/` — **skipped by default** via `describe.skipIf(!process.env.RAPID7_LIVE_TOKEN)`.
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
