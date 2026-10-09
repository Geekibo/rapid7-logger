# Contributing

Thanks for looking. This is a small, deliberately scoped package, and the bar for a change is
that it keeps the promises in [docs/DESIGN.md](docs/DESIGN.md) — the source of truth for
architecture, the delivery contract and what the Rapid7 endpoint actually does. Read §2 and §7
before touching transport or queue code.

## Set up

```sh
npm ci            # never npm install in CI — a PR must not float a dependency
npm run build     # dist/ — the Node integration tests run against it
npm test
```

Node 20.9 or later. There is nothing else to install, and **no credentials are needed**: the
unit, contract and Node integration tests run against fakes and a local HTTP server.

## The test tiers

| | What | Credentials |
|---|---|---|
| `test/unit/` | Formatter, redaction, queue, retry, the Next helpers — fake `fetch` throughout | none |
| `test/contract/` | The `Transport` invariants every transport must pass | none |
| `test/node/` | Spawns `node` against the built `dist/` (lifecycle flush, the examples) | none |
| `test/live/` | Posts to a real InsightOps log and reads it back through the Query API | `RAPID7_LIVE_TOKEN` + a read key — **expected to skip** when unset |
| `test/next-build/`, `test/next-app/` | A real `next build` of a fixture and of `examples/nextjs-app` | none, but each needs its own `npm ci --prefix …` first |

A clone with no environment variables must have a fully green run, and fork pull requests get no
secrets — so the live suite skips, never fails. To run it yourself, copy `.env.example` to `.env`,
point it at a **dedicated** log, and use `node --env-file=.env node_modules/.bin/vitest run test/live`.
Never commit a token, in any form.

## Making a change

1. Fork and branch from `main`.
2. Make the change, with tests. The invariants in [CLAUDE.md](CLAUDE.md) are correctness, not
   style — one event per request, no interior newlines, `send()` never throws, `flush()` is
   bounded, the queue drops rather than blocks, zero runtime dependencies, server-only, no
   `node:*` in the core or the Edge/Next entries, never log a credential. CI checks several of
   them mechanically; the pull request template asks you to confirm the rest.
3. **Measure, don't reason.** If the change depends on how the endpoint behaves, post to it and
   look (`spike/webhook-contract.mjs` is the measurement script). If what you find differs from
   `docs/DESIGN.md`, update the design in the same PR and say what you measured.
4. **Add a changeset** (`npx changeset`) for any user-visible change. That is what versions the
   release; a PR without one is incomplete.
5. Run `npm run typecheck && npm run lint && npm run build && npm test`, then open the PR.
   `main` is protected: changes land by reviewed pull request with green CI.

## Releases

Maintainers cut releases. Merging a feature publishes nothing: Changesets opens a
"Version Packages" PR, and **merging that PR is the release decision**. `release.yml` then
pauses for the `release` environment reviewer and publishes through npm's OIDC trusted
publishing — there is deliberately no `NPM_TOKEN` in this repository, and one must not be
added.

Two things that look harmless and are not:

- **Renaming `.github/workflows/release.yml` breaks publishing** until npm's trusted-publisher
  configuration is updated to match — the filename is part of that configuration.
- **`pull_request_target`** must never be used in a workflow here. It runs untrusted code with
  this repository's secrets.
