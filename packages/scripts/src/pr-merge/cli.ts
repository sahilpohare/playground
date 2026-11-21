import { parseArgs } from "node:util"

import { type Gate } from "./gates"
import { holderText, prMerge } from "./merge"

const USAGE = `Usage: bun run pr:merge <n> [options]

Squash-merges PR <n> into canary at its current head, and refuses unless every gate passed
at that head and the head is up to date with canary:

  open, ready   the PR is open and not a draft, or the owner's draft whose every other gate
                passes, which pr:merge marks ready (gh pr ready) just before it merges
  author        the repo's owner opened it, or --outside-author names who did
  held          ~/.playground/ops/report/held-prs.json does not list it (or
                PLAYGROUND_HELD_PRS) at the gates or just before the merge call; a "*"
                line, until it lapses (bun run ship:freeze), or a file that does not read,
                holds every PR
  base          it merges into canary
  code          this checkout's pr-merge code, verdicts.ts and the new-user gate's paths.ts,
                uncommitted edits included, match origin/canary's, so a checkout behind
                canary never skips a gate canary has added; else run it from a checkout on
                origin/canary
  up to date    canary has no commit the head lacks, or the head merges with canary clean;
                a conflict needs canary merged in, then checks, a 5/5 and each PASS
                its diff calls for at the new head
  keeps canary  no merge of canary into the PR dropped a line canary added that git's own
                merge keeps and the squash still lacks, in a file that merges clean (a
                merge with -s ours drops them); blank lines, moves and rewrites pass, and
                it names each file and merge
  ci            every GitHub check on the head finished and passed, "Audit, Lint, and
                Build" and "test" among them; on factory.repo (the checkout's origin when unset) the head must carry a
                GitGuardian check, since a head it never started on ran no secret scan
  body          the PR body is the PR template the Changelog reads, and its Evidence names
                each changed *.md path by its full path
  review        ## ReviewBot · round <n>: 5/5 at <sha7>, at the head
  checks        a PR changing a check (CI's workflows or actions, the gate code, the
                refused-forms harness) or deleting a refused-forms line has that 5/5 name
                each such path: Reviewed check change: <path>
  tester        on a diff under web/next/: ## TesterBot · PASS at <sha7>, at the head
  new-user      on an installer or first-run diff (NEW_USER_PATHS): ## NewUserGate · PASS
                at <sha7>, at the head
  types         last, inside the merge lock: the tree the squash makes type-checks by CI's own
                type steps in the kept merge-types worktree, each through run-slot; skipped
                when the head already holds canary's tip, and a type error refuses with the
                first errors

A gate reads only comments the repo's owner wrote; the newest review at the head wins, so a
lower score after a 5/5 refuses.

Merge-on-ready (bun run pr:train ready) merges the first gated PR in queue order.

It merges under the factory's merge lock (~/.playground/merge.lock, or
PLAYGROUND_MERGE_LOCK_DIR): one merge into canary at a time, every gate read inside it, and
the lock let go however it ends; a lock another PR holds refuses, naming it.

Options
  --explain       print whether the head merges clean with canary now and as which tree
                  (or the files it conflicts in), then each gate and what it found at the
                  head, types as whether it would run or skip, and merge nothing
  --outside-author <login>
                  merge a PR that login opened, not the repo's owner: only on a lead's go,
                  once its read-only review and every gate have passed
  --repo <o/n>    the repo (default: the one gh sees from this checkout)
  -h, --help      this help`

const parse = () => {
  try {
    return parseArgs({
      allowPositionals: true,
      options: {
        explain: { type: "boolean" },
        help: { short: "h", type: "boolean" },
        "outside-author": { type: "string" },
        repo: { type: "string" },
      },
    })
  } catch (error) {
    console.error(`${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`)
    process.exit(1)
  }
}

const { positionals, values } = parse()
const n = Number(positionals[0])
if (values.help || positionals.length !== 1 || !Number.isInteger(n) || n <= 0) {
  console.log(USAGE)
  process.exit(values.help ? 0 : 1)
}

const print = (gates: Gate[]) => {
  for (const gate of gates) console.log(`${gate.ok ? "✓" : "✗"} ${gate.name}  ${gate.detail}`)
}

try {
  const outcome = await prMerge(n, {
    explain: values.explain,
    outsideAuthor: values["outside-author"],
    repo: values.repo,
  })
  if (outcome.kind === "explained") console.log(outcome.merge)
  print(outcome.gates)
  switch (outcome.kind) {
    case "explained":
      process.exit(outcome.gates.every((gate) => gate.ok) ? 0 : 1)
      break
    case "refused": {
      const missing = outcome.gates.filter((gate) => !gate.ok).map((gate) => gate.name)
      console.error(`Refused: #${n} has not passed ${missing.join(", ")} at its head`)
      process.exit(1)
      break
    }
    case "locked":
      console.error(
        `Refused: the merge lock is held by ${holderText(outcome.holder)}; try again in a minute, and tell your build lead if it is older than 10 minutes`,
      )
      process.exit(1)
      break
    case "failed":
      console.error(`Not merged: ${outcome.reason}`)
      process.exit(1)
      break
    case "merged":
      console.log(`Merged #${n} at ${outcome.sha}`)
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}
