# Upstream skills are vendored byte for byte

Sessions reached the upstream skills through inscope, as links into its cache of the upstream repository at `main`: unpinned, so an upstream change reached every session unreviewed, and a public copy of this repo could not show which skills it calls. The owner first decided, through an Inbox decision, that the repository carries every upstream skill as it is, under its own license; a later decision keeps only the skills in use, inside the core extension.

## Decision

Core keeps the upstream skills in use, each flat at `extensions/core/skills/<name>/`, upstream's files byte for byte plus a `CREDITS.md` of core's. Each upstream (`UPSTREAMS` in `packages/scripts/src/vendor-upstream/stage.ts`: mattpocock/skills, Graphify-Labs/graphify and pbakaus/impeccable, added on the owner's ask) has its own `extensions/core/upstream/<name>/`, holding its license files, `SOURCE` (the commit and the date it was taken) and `MANIFEST` (each kept file's git blob sha), and core's `NOTICE` names the skills and their source.

- `bun run vendor:upstream <name> [<sha or ref>]` is the only way those files change: it takes one upstream's kept skills and license files at the paths its `coreFor` maps them to, checks every file it writes against the tree's blob shas, leaves core as it was on any mismatch, and never commits.
- `tests/extensions/core/upstream/drift.test.ts` holds those files to each `MANIFEST` offline, with no extra file and every kept skill present.
- The writing-first hook leaves the upstream skills alone, since no session edits them by hand, and the formatter and the trace ratchet read past them, since their text is upstream's.

## Consequences

- An upstream change reaches the repo only as a re-vendor PR, whose diff and drift test a reviewer reads, which answers ADR 0009's worry that a copy drifts silently.
- `pr` is core's one changed copy, `extensions/core/skills/pr/`, upstream's text plus the blocks the gates and the Changelog read, held by its own drift test against a pinned upstream copy; upstream's `pr` is not taken.
- The upstream skills keep their licenses (MIT for mattpocock's, Apache-2.0 for graphify and impeccable) in `extensions/core/upstream/<name>/`; the root `NOTICE` covers only this repo's own code, and `tests/NOTICE.test.ts` fails on any `LICENSE` at the root.
