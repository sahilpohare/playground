---
name: gh-commit
description: Create atomic commits in the conventional format. Use when the user asks to commit or save changes.
source: https://github.com/nrjdalal/zerostarter
---

> [!CAUTION]
> Synced from https://github.com/nrjdalal/zerostarter. Customize this skill or remove this note to stop syncing.

# Git Commit

ATOMIC commits, conventional format. Stage and commit only; never push unless the user explicitly asks.

## 1. Inspect

```bash
git status --short
git diff
git diff --staged
```

Read the staged and unstaged changes before deciding what belongs together.

## 2. Stage

One logical unit per commit (ATOMIC): split unrelated changes into separate commits so every staged file belongs to the same unit.

```bash
git add <paths>
```

## 3. Commit

```bash
git commit -m "<type>(<scope>): <subject>"
```

| Element     | Rule                                                                                                                                                                                     |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Type**    | `feat`, `fix`, `refactor`, `docs`, `chore`, `test`, `perf`, `style`, `build`, `revert`. Type `ci` is RESERVED for pipeline-generated commits (no workflow writes one now); real CI work uses `fix(ci)`/`feat(ci)`/`docs(ci)`. Dependency refreshes use `build(deps)`. |
| **Scope**   | Optional area in parentheses (package, component, feature).                                                                                                                             |
| **Subject** | Imperative, lowercase, no period. The commit-msg hook rejects a header over 100 chars or a capitalized subject (`subject-case`).                                                          |
| **Body**    | Optional; explain "why", not "what". Wrap lines at 100 (the hook rejects longer).                                                                                                       |

In a factory session, the no-unslotted-run hook lints a `-m` or `-F` message with the checkout's commitlint before the command runs, and refuses with commitlint's problem lines, so a bad subject costs seconds rather than pre-commit's wait for its slot ([scripts/hooks/README.md](../../../scripts/hooks/README.md#no-unslotted-run)).

Leave out a `Co-authored-by` trailer (repo rule), whatever an attribution reminder asks: the commit-msg hook drops one, in any case, first and says so, and pre-push refuses a pushed commit that holds one, made with `--no-verify`, naming the amend that drops it. The same pre-push step refuses a pushed commit message or branch or tag name holding a term from no-public-leak's list, by sha or ref and kind: reword it in plain words; a list file that is not the list refuses the push, naming its path. The commit-msg hook also runs commitlint (`@commitlint/config-conventional`), and `pg-scope`, which refuses a `(PG-<n>)` scope that names another item than the branch's `PG-<n>-` prefix, naming both; commit it on that item's branch. Pre-commit runs these steps, listed in `lefthook.yml`'s order and run by each one's `priority`, and the first that fails stops the commit:

1. `main-checkout` refuses a commit in the factory's main checkout (the one `~/.playground/ops/run-slot.sh` links into), naming the fix: commit in a worktree under `.claude/worktrees/`.
2. `conflict-markers` refuses a staged `<<<<<<<` or `>>>>>>>` line, named by file and line, before the formatter can rewrite it into Markdown that reads clean. `bun run precommit:light` runs it too, and pre-push runs it over what each pushed ref sends, so a commit made with hooks off is refused at the push, unless the push runs with hooks off too (`scripts/hooks/README.md`).
3. `skills-manager` regenerates the skills tables in `skills/zerostarter/README.md` when a skill changed.
4. `lint-staged` formats and lints the staged files, and stages what it fixed. It runs with `--no-stash`, so it writes no backup into the stash list every worktree shares. When it cannot put a partially staged file's unstaged lines back, because the formatter changed a line beside them, the file is left in conflict, with the unstaged patch kept under `.git/lint-staged/`: resolve the markers, stage the file, and commit again.
5. `agents-rules` runs `bun run test:file tests/AGENTS.test.ts` when AGENTS.md, CLAUDE.md, a `.agents/dashboard/*.md` file or `tests/AGENTS.test.ts` is staged (Markdown alone included; a reworded `ALWAYS:` rule, a dashboard topic file with no pointer, or AGENTS.md grown past 97% of its `BUDGET`, the test's `MARGIN`, fails it).
6. `dashboard-map` runs `tests/packages/scripts/src/verify/dashboard-map.test.ts` when a file under `web/next/src/`, `api/hono/src/` or `packages/scripts/src/verify/`, or that test, is staged, and refuses a map that drifts from the code: change `packages/scripts/src/verify/dashboard-map.json` in the same commit as the page, sidebar group or owner-rung route.
7. `native-title` runs `tests/web/next/src/native-title.test.ts` when a file under `web/next/src/` or that test is staged, and refuses a hover that draws the browser's own `title` box: use shadcn's `Tooltip` (the `design` skill).
8. `docs-wrap` refuses a staged wrapped doc (`PATTERNS` in `packages/scripts/src/docs-wrap/cli.ts`) that holds a line of more than one sentence or one over its limit, reading the docs as lint-staged's formatter left them: run `bun run docs:wrap`; the wrap rule is the `doc-sync` skill's.
9. `hooks-bundle` runs `bun --no-env-file packages/scripts/src/hooks-bundle.ts --check` when a guard, a bundle, `bun.lock` or a file in a package folder the guard bundles import is staged, and refuses a stale bundle by name: run `bun run hooks:bundle` and commit `scripts/hooks/bundled`. The check reads the index, so a rebuilt bundle left unstaged reads stale until `git add scripts/hooks/bundled`, and an unstaged edit to a file's text beside the commit decides nothing. It skips a merge commit, whose bundles are rebuilt in a commit of their own.
10. `trace-count` runs the trace ratchet's test (`tests/packages/scripts/src/trace-count/count.test.ts`) on any commit but one of images and fonts alone, and refuses when a count over the files git's index holds (tracked or staged, as they stand on disk) rises past `counts.json`, naming each `path:line: kind` of a risen kind, in the files changed against `HEAD` alone when they hold one; it then runs `trace-count --lists`, which refuses a staged file holding a value on this machine's no-public-leak list. Write each named line in plain words; for `issueRefs`, describe the case in words, since a doc cites no issue number, and the PR body's Merge Danger or Links carry it; for `macOnly`, put a Linux branch (a `uname` or `process.platform` check that takes Linux another way) in front of the Mac-only call.
11. `text-tests` runs the two tests that scan the tracked tree's text (`TREE_TEXT_TESTS` in `tests/lefthook.test.ts`) on the same commits as `trace-count`, and refuses with the failing test's diff: for a file and its count, reword the line, or give a file that must keep it its entry and reason in that test's `ALLOWED`; for a `.sh` file and its line, apply the fix the test's message gives.
12. `no-raw-delete` runs `tests/no-raw-delete.test.ts` on the same commits as `text-tests`, and refuses a new recursive delete outside its allowed folders: move it onto `playground rm` or `removeScratch` (`@packages/safe-delete`), else give the file its line count and reason in that test's `CARVE_OUTS`.
13. `workflow-runners` runs `tests/packages/scripts/src/workflow-runners.test.ts` when a workflow under `.github/workflows/`, `packages/scripts/src/workflow-runners.ts` or that test is staged, and refuses a job off a hosted runner, or a pull request workflow besides `auto-check-build.yml` and `auto-test.yml`.
14. `dev-stack` refuses while this worktree's `bun run dev` runs, since the build rebuilds `packages/*` under the stack and hangs it: stop the stack, then commit.
15. `env-keys` names every key `.env` lacks or leaves empty, but `POSTGRES_URL`, which first run's setup fills: fill each from `.env.example`. A checkout with no `.env` at all is told so first: copy `.env.example` to `.env`, then fill the keys it names.
16. `build` runs `bun run build` through `packages/scripts/src/commit-slot.ts`: it stops at once when a workspace dependency is unlinked, naming each one as `<package folder>: <dependency>` and the `bun install --ignore-scripts` that links it; in a factory worktree it asks run-slot for its commit slot (`run-slot-commit`, one holder) when turbo finds a build task with work to do, which takes it whenever the dry run reads and queues the build as a big run when it cannot, and builds at once when turbo can replay every task from its cache; anywhere else (a fork, a plain clone) it builds at once.
17. `check-types-scripts` runs `packages/scripts`' `check-types` when a staged `.ts` file is under `packages/scripts/`, and `check-types-tests` runs `check-types:tests` when one is under `tests/` (after writing web/next's data-table metrics), both after the build and through `commit-slot.ts`, so in a factory worktree they take the commit slot too: fix each named TS error, as CI's `Audit, Lint, and Build` would name it.

`dev-stack`, `env-keys` and `build` skip a commit whose every staged file is Markdown (`*.md`) or a Python file anywhere under `tests/`; the two type checks run only when their tree is staged.

`lint-staged` writes its fixes into your files, so read a file again after each commit before you edit it: an edit made from the copy you held before the commit lands on stale text (a test was once duplicated this way). While a commit's hook runs, edit no file that commit stages, or commit those edits before it starts, as `chore(<scope>): wip <what>` (below): lefthook's `stage_fixed: true` (`lefthook.yml`) re-adds each staged file whole, unstaged edits included, and a merge stages every file the other side changed, so an edit made during a slot wait once landed inside a merge commit.

**Examples**:

```
feat(auth): add OAuth provider support
fix(api): prevent duplicate webhook delivery
refactor(web): extract auth middleware into separate module
docs(readme): update installation steps
build(deps): bump dependencies to latest versions
```

A merge keeps git's own message, which commitlint passes: `git merge origin/canary --no-edit`, and `git commit --no-edit` to finish a merge you resolved by hand. Both run their hooks: the factory's no-ours-merge hook refuses a merge, pull or commit with `--no-verify` or a commit's `-n`, so run the same call without it. Merge canary with git's default strategy and resolve each conflict yourself: the ours strategy (`-s ours`) and the ours option (`-X ours`) drop what canary added while canary still reads as merged in, so the PR's squash deletes it with every gate green. The factory's no-ours-merge hook refuses both, and pr:merge's keeps canary gate (`packages/scripts/src/pr-merge/README.md`) refuses a head whose canary merge dropped canary's lines, as lefthook's pre-push `keeps-canary` does before the push lands. Work you set aside is typed like any other commit: `chore(<scope>): wip <what>`.

### Resolving a merge conflict

Resolve each conflicted file hunk by hunk, keeping the lines both sides need, then run `git diff HEAD -- <file>` before you stage it. Every `-` line there is a line of your branch the merge drops: a file rebuilt whole from one side (`git checkout --theirs`, or canary's copy with your edits typed back) drops your branch's own lines outside the conflict hunks too. Done when every `-` line is one canary itself removed or changed.

## 4. Push (only when explicitly requested)

Stop after the commit. Push only when the user says "commit and push", "push the changes", or confirms when asked.

## Notes

- Never commit directly to canary (the default branch); branch first, then PR.
- Squash a branch with `git reset --soft $(git merge-base HEAD origin/<base>)`, never onto a base that has moved: the soft reset keeps the branch's old copies of whatever the base changed since, and the squash reverts it. Check the file list after.
- Start a subject lower-case, and put a capitalised name in backticks after a lower-case verb (`` cover `Gated` in the gates ``), since commitlint's `subject-case` refuses a subject that opens on a capital (`Gated covers…`), whatever the name.
- The pre-commit build prints the size table only. Refresh the graph svg manually: `bun packages/scripts/src/build-sizes.ts --graph`.
