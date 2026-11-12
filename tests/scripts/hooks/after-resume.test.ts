import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { WAITER } from "../../../scripts/hooks/after-compact"
import { check, lastEntry, rearm } from "../../../scripts/hooks/after-resume"

const input = JSON.stringify({
  hook_event_name: "SessionStart",
  session_id: "s-1",
  source: "resume",
})

const now = new Date("2026-10-25T21:58:50Z")

// A resumed transcript as measured on 2.1.309: entries out of time order, untimestamped records after the last turn, a message whose text quotes a timestamp, and a tool result carrying one of its own after now.
const transcript = () => {
  const path = join(mkdtempSync(join(tmpdir(), "after-resume-")), "s-1.jsonl")
  const lines = [
    { timestamp: "2026-10-25T21:42:12.731Z", type: "api-request" },
    { timestamp: "2026-10-25T21:42:12.676Z", type: "user" },
    {
      message: { content: '{"timestamp":"2026-10-25T21:50:00.000Z"}' },
      timestamp: "2026-10-25T21:42:13.300Z",
      type: "assistant",
    },
    { timestamp: "2026-10-25T21:42:13.304Z", type: "system" },
    {
      timestamp: "2026-10-25T21:42:13.100Z",
      toolUseResult: { timestamp: "2026-10-30T00:00:00.000Z" },
      type: "user",
    },
    { type: "last-prompt" },
    { type: "cost-state" },
  ]
  writeFileSync(path, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`)
  return path
}

describe("after a restart, a resumed factory session re-arms its watches and re-sends unanswered asks", () => {
  test.each(["dispatcher", "lead", "worker", "reviewer", "tester", "runner", "probe"])(
    "a %s gets the instruction as SessionStart context, a manager's with its alerts-wait line",
    async (role) => {
      const out = await check(input, { PLAYGROUND_ROLE: role }, now)
      const manager = role === "dispatcher" || role === "lead"
      expect(JSON.parse(out ?? "null")).toEqual({
        hookSpecificOutput: {
          additionalContext: manager ? `${rearm(undefined, now)} ${WAITER}` : rearm(undefined, now),
          hookEventName: "SessionStart",
        },
      })
    },
  )

  test("the 10 minutes end at the transcript's last entry before the restart, however long the session stayed down", async () => {
    const raw = JSON.stringify({ ...JSON.parse(input), transcript_path: transcript() })
    const out = JSON.parse((await check(raw, { PLAYGROUND_ROLE: "worker" }, now)) ?? "null")
    const text: string = out.hookSpecificOutput.additionalContext
    expect(text).toContain("resumed at 2026-10-25T21:58Z")
    expect(text).toContain(
      "10 minutes before 2026-10-25T21:42Z, your last entry before the restart",
    )
  })

  test("the last entry is the newest real timestamp, never one quoted inside a message nor one after now", async () => {
    expect(await lastEntry(transcript(), now)).toEqual(new Date("2026-10-25T21:42:13.304Z"))
  })

  test("with no transcript to read, the 10 minutes end at the resume", async () => {
    expect(await lastEntry(undefined)).toBeUndefined()
    const raw = JSON.stringify({
      ...JSON.parse(input),
      transcript_path: "/nonexistent-dir-for-test/s-1.jsonl",
    })
    const out = JSON.parse((await check(raw, { PLAYGROUND_ROLE: "worker" }, now)) ?? "null")
    expect(out.hookSpecificOutput.additionalContext).toContain(
      "10 minutes before 2026-10-25T21:58Z, the resume",
    )
  })

  describe("the edit lefthook set aside when a restart killed a commit", () => {
    const git = (cwd: string, ...args: string[]) => {
      const run = Bun.spawnSync(
        ["git", "-c", "user.email=t@example.com", "-c", "user.name=t", ...args],
        { cwd },
      )
      if (run.exitCode !== 0) throw new Error(run.stderr.toString())
    }
    // A main checkout and two worktrees, each holding the file the patch changes, whose folders are not their branches' names, since lefthook names its patch by the worktree's folder, the second's name starting with the first's.
    const scratch = () => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), "after-resume-git-")))
      const main = join(root, "main")
      mkdirSync(main)
      git(main, "init", "-q", "-b", "canary")
      writeFileSync(join(main, "f.txt"), "a\nb\nc\n")
      git(main, "add", "f.txt")
      git(main, "commit", "-q", "-m", "init")
      git(main, "worktree", "add", "-q", join(root, "wt-folder"), "-b", "PG-9-slug")
      git(main, "worktree", "add", "-q", join(root, "wt-folder-2"), "-b", "PG-10-slug")
      const info = join(main, ".git", "info")
      mkdirSync(info, { recursive: true })
      return {
        info,
        main,
        other: join(root, "wt-folder-2"),
        root,
        worktree: join(root, "wt-folder"),
      }
    }
    // A resume's cwd is the folder the session was started in, the main checkout for a worker, while the transcript names the worktree it worked in, as an entry's cwd or inside a command.
    const resumedIn = async (cwd: string, lines: object[] = []) => {
      const path = join(mkdtempSync(join(tmpdir(), "after-resume-")), "s-1.jsonl")
      writeFileSync(path, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`)
      const raw = JSON.stringify({ ...JSON.parse(input), cwd, transcript_path: path })
      const out = JSON.parse((await check(raw, { PLAYGROUND_ROLE: "worker" }, now)) ?? "null")
      return out.hookSpecificOutput.additionalContext as string
    }
    const patch = "diff --git a/f.txt b/f.txt\n--- a/f.txt\n+++ b/f.txt\n@@ -3 +3 @@ b\n-c\n+c2\n"

    test("a worktree's patch left behind is named, with the command that puts it back there before any commit", async () => {
      const { info, worktree } = scratch()
      const left = join(info, "lefthook-unstaged.wt-folder.patch")
      writeFileSync(left, patch)
      const text = await resumedIn(worktree)
      expect(text).toContain(`git -C ${worktree} apply --unidiff-zero ${left}`)
      expect(text).toContain("before any commit")
    })

    test("resumed in the main checkout, it finds the patch of the worktree the transcript's last entries ran in", async () => {
      const { info, main, worktree } = scratch()
      const left = join(info, "lefthook-unstaged.wt-folder.patch")
      writeFileSync(left, patch)
      const text = await resumedIn(main, [
        { cwd: worktree, timestamp: "2026-10-25T21:42:12.731Z", type: "assistant" },
      ])
      expect(text).toContain(`git -C ${worktree} apply --unidiff-zero ${left}`)
    })

    test("resumed in the main checkout, it finds the patch of the worktree a command named", async () => {
      const { info, main, worktree } = scratch()
      const left = join(info, "lefthook-unstaged.wt-folder.patch")
      writeFileSync(left, patch)
      const command = `git -C ${worktree} commit -m wip`
      const text = await resumedIn(main, [
        { cwd: main, message: { content: [{ input: { command }, type: "tool_use" }] } },
      ])
      expect(text).toContain(`git -C ${worktree} apply --unidiff-zero ${left}`)
    })

    test("a worktree named only in a message or a command other than a commit is not this session's", async () => {
      const { info, main, worktree } = scratch()
      writeFileSync(join(info, "lefthook-unstaged.wt-folder.patch"), patch)
      const text = await resumedIn(main, [
        { cwd: main, message: { content: [{ text: `works in ${worktree}`, type: "text" }] } },
        {
          cwd: main,
          message: {
            content: [{ input: { command: `git -C ${worktree} log` }, type: "tool_use" }],
          },
        },
      ])
      expect(text).not.toContain("lefthook")
    })

    test("a patch whose edit is back in the worktree is named no more", async () => {
      const { info, worktree } = scratch()
      writeFileSync(join(info, "lefthook-unstaged.wt-folder.patch"), patch)
      writeFileSync(join(worktree, "f.txt"), "a\nb\nc2\n")
      expect(await resumedIn(worktree)).not.toContain("lefthook")
    })

    test("a main checkout's patch has no worktree name", async () => {
      const { info, main } = scratch()
      const left = join(info, "lefthook-unstaged.patch")
      writeFileSync(left, patch)
      expect(await resumedIn(main)).toContain(`git -C ${main} apply --unidiff-zero ${left}`)
    })

    test("with no patch left behind, it says nothing of one", async () => {
      expect(await resumedIn(scratch().worktree)).not.toContain("lefthook")
    })

    test("another worktree's patch is not this session's to restore", async () => {
      const { info, main, root, worktree } = scratch()
      writeFileSync(join(info, "lefthook-unstaged.wt-folder-2.patch"), patch)
      writeFileSync(join(info, "lefthook-unstaged.gone-folder.patch"), patch)
      writeFileSync(join(info, "lefthook-unstaged-all.wt-folder.patch"), patch)
      const lines = [{ cwd: worktree, message: { content: `ls ${join(root, "gone-folder")}` } }]
      expect(await resumedIn(worktree, lines)).not.toContain("lefthook")
      expect(await resumedIn(main, lines)).not.toContain("lefthook")
    })
  })

  test("a session outside the factory, the owner's own, gets nothing", async () => {
    expect(await check(input, {}, now)).toBeUndefined()
  })

  test("input that does not read, or a registry that cannot be read, fails open to nothing", async () => {
    expect(await check("not json", {}, now)).toBeUndefined()
    expect(
      await check(input, { CLAUDE_CONFIG_DIR: "/nonexistent-dir-for-test" }, now),
    ).toBeUndefined()
  })
})
