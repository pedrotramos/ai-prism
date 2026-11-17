# Changelog fragments

Every pull request adds **one file here** instead of editing `CHANGELOG.md`.
At release time the fragments are folded into `CHANGELOG.md` and deleted.

**Why:** with several PRs open at once, all of them editing the same
`## [Unreleased]` lines guaranteed a merge conflict on every rebase. A file per
PR keeps the "every change has a changelog entry" rule without that cost. The
CI gate still fails a PR that has neither a fragment nor a `CHANGELOG.md` edit.

## Adding a fragment

1. Create `changelog.d/<task-or-branch>.md`, for example `changelog.d/W0-5.md`
   or `changelog.d/fix-sidebar-scroll.md`. One file per PR; the name only has to be unique.
2. Use the same `### Section` headings as `CHANGELOG.md`, with bullets under them:

   ```markdown
   ### Added

   - **Short title**: what changed for the user or the operator, and why it matters.
     Mention the file or setting when that helps (`server/foo.js`, `FOO_ENABLED`).

   ### Fixed

   - ...
   ```

   Allowed sections: `Added`, `Changed`, `Deprecated`, `Removed`, `Fixed`,
   `Security`, `Performance`, `Deploy notes` (`Notas de deploy` is accepted as
   an alias). Write the entries in the language `CHANGELOG.md` uses today.
3. Check it locally:

   ```bash
   node scripts/changelog-fragments.mjs check --files changelog.d/<file>.md
   ```

A PR with no user- or operator-visible change can use the `skip-changelog`
label instead.

## Releasing

```bash
node scripts/changelog-fragments.mjs release 1.5.0 --dry-run   # preview the new CHANGELOG.md
node scripts/changelog-fragments.mjs release 1.5.0             # write it and delete the fragments
```

`release` merges whatever is already under `## [Unreleased]` with every
fragment, section by section, into `## [1.5.0] - <today>` (`--date YYYY-MM-DD`
to override). It also updates the compare links at the bottom and leaves
`## [Unreleased]` empty. Commit the result together with the version bump.

## The CI gate

The `Changelog (G-cl)` job runs
`node scripts/changelog-fragments.mjs check --base <base> --head <head>`. It
passes when the PR adds or edits a valid fragment, or edits `CHANGELOG.md`
directly (release PRs, hotfixes). An invalid fragment, such as an unknown or
empty section, fails with the file name.
