## What and why

<!-- What changes, and what problem it solves. Link the issue. -->

Closes #

## Checklist

- [ ] **Changeset added** (`npx changeset`) — or this change is not user-visible
- [ ] Tests cover the change; `npm test` passes locally
- [ ] No credentials in code, tests, fixtures or comments
- [ ] `docs/DESIGN.md` updated if behaviour now differs from it

## Invariants

Confirm this change does not break any of these (CLAUDE.md):

- [ ] One event per HTTP request; no interior newlines in the body
- [ ] `send()` never throws or rejects; `flush()` stays bounded
- [ ] Queue stays bounded and drops on overflow — never blocks the caller
- [ ] No runtime dependencies added
- [ ] No `node:*` import reachable from the core or the edge entry point
- [ ] Nothing new can reach a browser bundle
