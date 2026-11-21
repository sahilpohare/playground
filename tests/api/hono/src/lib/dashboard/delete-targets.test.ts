import { describe, expect, test } from "bun:test"

import {
  deleteRefusal,
  shortTargets,
  type TargetDeps,
} from "../../../../../../api/hono/src/lib/dashboard/delete-targets"

const WORKTREES = "/repo/.claude/worktrees"
// a made-up machine: the poster's folder, a home and the paths that are there
const deps = (there: string[]): TargetDeps => ({
  cwd: "/repo/.claude/worktrees/PG-1-mine",
  exists: (path) => there.includes(path),
  home: "/home/me",
  worktrees: WORKTREES,
})
const MACHINE = deps([
  "/repo/.claude",
  WORKTREES,
  `${WORKTREES}/PG-882-before`,
  "/repo/.claude/worktrees/PG-1-mine/scratch/old-copy",
  "/home/me/.cache/old",
])

const remove = (what: string) => ({
  from: "worker",
  kind: "decision",
  preview: { type: "delete", what, why: "made up" },
  title: "Delete it?",
})

describe("a delete names its targets by full path", () => {
  test("a worktree's bare folder name, a relative path and a ~ path are short, each with the full path to write", () => {
    expect(
      shortTargets("the worktree PG-882-before, `scratch/old-copy` and ~/.cache/old", MACHINE),
    ).toEqual([
      { full: `${WORKTREES}/PG-882-before`, word: "PG-882-before" },
      { full: "/repo/.claude/worktrees/PG-1-mine/scratch/old-copy", word: "scratch/old-copy" },
      { full: "/home/me/.cache/old", word: "~/.cache/old" },
    ])
  })

  test("a full path passes, and so does a short name its full path stands beside, as a branch named for its worktree", () => {
    expect(shortTargets(`${WORKTREES}/PG-882-before/`, MACHINE)).toEqual([])
    expect(
      shortTargets(`${WORKTREES}/PG-882-before and its branch PG-882-before`, MACHINE),
    ).toEqual([])
  })

  test("words that name nothing there pass: prose, a URL, a branch with no worktree, and/or, a stray ./", () => {
    expect(
      shortTargets(
        "the old branch PG-9-gone and/or https://github.com/acme/app/pull/1 for good, in ./ or ../",
        MACHINE,
      ),
    ).toEqual([])
  })

  test("outside a checkout a bare name is never read as a worktree", () => {
    expect(shortTargets("PG-882-before", { ...MACHINE, worktrees: null })).toEqual([])
  })

  test("the refusal reads a delete decision alone, naming each full path to write", () => {
    expect(deleteRefusal(remove("the worktree PG-882-before"), MACHINE)).toBe(
      `a delete names each target by its full path, so the owner approves the very path that goes: write ${WORKTREES}/PG-882-before for PG-882-before`,
    )
    expect(deleteRefusal(remove(`${WORKTREES}/PG-882-before`), MACHINE)).toBeNull()
    expect(
      deleteRefusal({ ...remove(""), preview: { text: "PG-882-before", type: "ask" } }, MACHINE),
    ).toBeNull()
    expect(deleteRefusal("not an item", MACHINE)).toBeNull()
  })
})
