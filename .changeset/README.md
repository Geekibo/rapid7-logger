# Changesets

Every user-visible change needs a changeset in its pull request — that is what versions the
release (see `docs/DESIGN.md` §10.4). CI fails a pull request that touches `src/` without one.

Add one with `npx changeset` (the CLI needs Node 22 or later), or write the file by hand:

```md
---
"@geekibo/rapid7-logger": patch
---

One line describing the change as a user would read it in the changelog.
```

`patch` for a fix, `minor` for a feature or a new option, `major` for anything that breaks the
delivery contract or a type. A change that touches `src/` but is not user-visible (a refactor,
a comment) takes an empty changeset: `npx changeset --empty`.

Never delete a changeset from `main` by hand: the pending changesets are what keep the release
workflow on the "open a Version Packages pull request" path rather than the publish path.
