---
name: audit
description: Run the dependency security audit, update every package to its latest version, and maintain docs/dependencies.md. Use when the canary pre-push audit hook fails, when `bun audit` flags a moderate or worse advisory, or when asked to update all packages to latest.
source: https://github.com/nrjdalal/zerostarter
---

# Dependency Audit

The audit runs in three places, and it is the one gate on a Next advisory, since Next's own agent-only build stop is off ([docs/dependencies.md](../../../docs/dependencies.md#next-its-agent-upgrade-stop-is-off-web)).
The first two run through `packages/scripts/src/audit.ts`, which tries again when npm's advisories endpoint hangs or answers 5xx, so a failure that names an advisory is a real one:

- **A PR**: GitHub's Audit step and local CI's `suite.sh` pass `--new-over`, so a PR fails only on an advisory its head adds over its merge base with `canary`, and prints `canary`'s own as a notice.
  Fix what it names in that PR.
- **`canary` itself**: the `audit-canary` workflow audits each push to `canary` and keeps one open issue, `canary audit: <ids>` labelled `audit`, adding new ids to it and closing it once the audit is clean.
  The audit alone decides the run: when GitHub refuses the issue, a clean audit passes with one warning line, and an advisory fails the run with each one printed on the job log.
  Clear that issue's advisories by the steps below, in a PR of their own.
- **A direct push to `canary`**: the pre-push hook runs `bun audit` itself (`lefthook.yml`), with no `--new-over` and no retry.
  It stays strict because only a direct push reaches it: `bun run pr:merge` lands a PR through GitHub's API, which runs no hook.
  In the Playground repo a factory session's direct push to `canary` is refused before it starts (`no-protected-push`, [scripts/hooks/README.md](../../../scripts/hooks/README.md#no-protected-push)), so only the owner's own push reaches it there.

`docs/dependencies.md` is the canonical record of every active override and ignore, and it stays in place even when there are none.

## Update every package to latest

When asked to update all packages to their latest versions, bump every range at once, then take the steps below as for an advisory:

```bash
bun update --latest --recursive
```

`--recursive` reaches the root `catalog` and every workspace, and `--latest` ignores their ranges, so it crosses majors: read each major's release notes before you accept it. The catalog entries keep their caret ([Catalog ranges](../../../docs/dependencies.md#catalog-ranges)). A version published minutes ago can fail to resolve (`No version matching`) while the registry's metadata catches up; run it again a few minutes later. Done when `package.json` and `bun.lock` hold the new versions; then run steps 1 to 4, where step 2's proof gates the whole update.

## 1. Run

```bash
bun audit --audit-level moderate
```

Every gate fails at this level. Done when the output is clean, or you have the list of advisories to clear.

## 2. Fix on the highest rung that works

Fix each advisory on the highest rung that lifts the whole tree; drop a rung only when the one above cannot:

1. **Update the vulnerable dependency** (best): bump its `catalog:` entry in the root `package.json`.
2. **Update the parent** that pins the vulnerable transitive dependency.
3. **Override** (last resort): pin the patched version in root `overrides`:

   ```json
   "overrides": { "<vulnerable-package>": "<patched-version>" }
   ```

4. **Ignore** (only when an override would cross a breaking range under its parents): add `--ignore <GHSA id>` to the four gates that `docs/dependencies.md`'s Ignored advisories names.

`bun audit fix` applies the first two rungs mechanically when a patched version exists within the ranges parents allow; `--dry-run` previews and `--latest` also crosses majors, so review what it picks before accepting. Read the advisory's affected ranges before reaching for a lower rung: the audit header lists every installed version of the package, not only the vulnerable ones. Follow with `bun dedupe` to collapse duplicate versions the tree accumulated.

Then `bun i` and prove nothing broke. Done when `bun run check-types && bun run build` pass and `bun audit --audit-level moderate` reports no advisory but the ignored ones.

## 3. Record every override and ignore

Every entry in root `overrides` needs a matching block in `docs/dependencies.md`, in the file's existing shape: one `### <package> → <version>` under `## Active overrides`, carrying **Advisory** (link, severity, affected range), **Why an override** (why an update or parent bump can't lift the tree), **Risk**, and **Exit criteria** (when to remove it). Delete a block when its override goes. Every `--ignore` needs a block under `## Ignored advisories` in the same shape, its **Why an ignore** in place of **Why an override**. Done when every override and ignore has a block and no block outlives its entry.

## 4. Ship

`package.json`, `bun.lock`, and `docs/dependencies.md` go through a normal PR.
