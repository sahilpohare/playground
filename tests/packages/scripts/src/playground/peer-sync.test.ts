import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { mainCheckout } from "../../../../../packages/scripts/src/main-checkout"
import {
  cloneOf,
  cloneState,
  type PeerRun,
  syncPeers,
} from "../../../../../packages/scripts/src/playground/peer-sync"

const SHA = "0123456789abcdef0123456789abcdef01234567"
const CLONE = "~/code/playground"
const dir = mkdtempSync(join(tmpdir(), "peer-sync-"))
afterAll(() => rmSync(dir, { force: true, recursive: true }))

const envFile = (text: string) => {
  const path = join(dir, `${crypto.randomUUID()}.env`)
  writeFileSync(path, text)
  return path
}

const ONE = envFile(
  "PLAYGROUND_PEERS=spark-b=you@10.0.0.2\nPLAYGROUND_PEER_KEY=/home/you/.ssh/cluster\n",
)
const SSH = [
  "ssh",
  "-i",
  "/home/you/.ssh/cluster",
  "-o",
  "IdentitiesOnly=yes",
  "-o",
  "BatchMode=yes",
  "-o",
  "ConnectTimeout=5",
]

// A stub ssh: answers each call by the first of its remote words the script names, and records every argv.
const stubSsh = (answers: Record<string, { code?: number; out?: string }> = {}) => {
  const calls: string[][] = []
  const script: typeof answers = {
    status: { out: "## main...origin/main\n" },
    worktree: {
      out: "worktree /home/you/code/playground\nHEAD 0123\nbranch refs/heads/main\n\n",
    },
    ...answers,
  }
  const run: PeerRun = async (argv) => {
    calls.push(argv)
    const hit = Object.entries(script).find(([word]) => argv.includes(word))
    return { code: hit?.[1].code ?? 0, out: hit?.[1].out ?? "" }
  }
  return { calls, run }
}

const sync = async (env: string, run: PeerRun, sha = SHA, clone: string | null = CLONE) => {
  const lines: string[] = []
  await syncPeers(env, sha, clone, run, (line) => lines.push(line))
  return lines
}

describe("cloneOf", () => {
  test("a peer's clone sits where this checkout sits under its home, as a ~ path; a checkout outside home or with a character a remote shell reads has none", () => {
    expect(cloneOf("/home/you/code/playground", "/home/you")).toBe("~/code/playground")
    expect(cloneOf("/home/you/playground", "/home/you")).toBe("~/playground")
    expect(cloneOf("/srv/playground", "/home/you")).toBeNull()
    expect(cloneOf("/home/you", "/home/you")).toBeNull()
    expect(cloneOf("/home/you/my code/playground", "/home/you")).toBeNull()
    expect(cloneOf("/home/you/code/$(x)", "/home/you")).toBeNull()
    expect(cloneOf("/home/you/code/playground/", "/home/you/")).toBe("~/code/playground")
    expect(cloneOf("/home/youth/playground", "/home/you")).toBeNull()
    expect(cloneOf("/home/you/../them/playground", "/home/you")).toBeNull()
    expect(cloneOf("/home/you/code//playground", "/home/you")).toBeNull()
  })

  test("from a worktree, such as the live Dashboard's, the clone is the main checkout's place under home, never the worktree's", () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "peer-home-")))
    const held = process.env.PLAYGROUND_REPO
    delete process.env.PLAYGROUND_REPO
    try {
      const main = join(home, "code", "playground")
      mkdirSync(join(main, "scripts"), { recursive: true })
      writeFileSync(join(main, "scripts", "spawn.sh"), "")
      const git = (cwd: string, ...args: string[]) =>
        expect(
          Bun.spawnSync(
            [
              "git",
              "-c",
              "core.hooksPath=/dev/null",
              "-c",
              "user.email=t@t",
              "-c",
              "user.name=t",
              ...args,
            ],
            { cwd },
          ).exitCode,
        ).toBe(0)
      git(main, "init", "-q", "-b", "main")
      git(main, "add", ".")
      git(main, "commit", "-q", "-m", "init")
      const desk = join(main, ".claude", "worktrees", "desk")
      git(main, "worktree", "add", "-q", "--detach", desk)
      expect(cloneOf(desk, home)).toBe("~/code/playground/.claude/worktrees/desk")
      expect(cloneOf(mainCheckout(desk), home)).toBe("~/code/playground")
    } finally {
      if (held !== undefined) process.env.PLAYGROUND_REPO = held
      rmSync(home, { force: true, recursive: true })
    }
  })
})

describe("cloneState", () => {
  test("reads the branch, a detached HEAD as null, and any line after the branch line as a change", () => {
    expect(cloneState("## main...origin/main\n")).toEqual({ branch: "main", changed: false })
    expect(cloneState("## main\n")).toEqual({ branch: "main", changed: false })
    expect(cloneState("## HEAD (no branch)\n")).toEqual({ branch: null, changed: false })
    expect(cloneState("## canary...origin/canary [behind 2]\n")).toEqual({
      branch: "canary",
      changed: false,
    })
    expect(cloneState("## main...origin/main\n M README.md\n")).toEqual({
      branch: "main",
      changed: true,
    })
    expect(cloneState("## HEAD (no branch)\n?? notes.txt\n")).toEqual({
      branch: null,
      changed: true,
    })
  })
})

describe("syncPeers", () => {
  test("a clean clone on main reads, then fetches, finds no commit of its own, checks out the sha detached and installs, each a fixed ssh argv, and prints at <sha7>", async () => {
    const { calls, run } = stubSsh()
    expect(await sync(ONE, run)).toEqual(["peer spark-b: at 0123456"])
    expect(calls).toEqual([
      [...SSH, "you@10.0.0.2", "git", "-C", CLONE, "status", "--porcelain", "--branch"],
      [...SSH, "you@10.0.0.2", "git", "-C", CLONE, "worktree", "list", "--porcelain"],
      [...SSH, "you@10.0.0.2", "git", "-C", CLONE, "fetch", "-q", "origin", "--tags"],
      [
        ...SSH,
        "you@10.0.0.2",
        "git",
        "-C",
        CLONE,
        "rev-list",
        "-n",
        "1",
        "HEAD",
        "--not",
        "--remotes",
      ],
      [...SSH, "you@10.0.0.2", "git", "-C", CLONE, "checkout", "-q", "--detach", SHA],
      [
        ...SSH,
        "you@10.0.0.2",
        "nice",
        "-n",
        "10",
        "~/.bun/bin/bun",
        "install",
        "--frozen-lockfile",
        "--ignore-scripts",
        "--cwd",
        CLONE,
      ],
    ])
  })

  test("a clone a sync left on a detached HEAD moves again", async () => {
    const { calls, run } = stubSsh({ status: { out: "## HEAD (no branch)\n" } })
    expect(await sync(ONE, run)).toEqual(["peer spark-b: at 0123456"])
    expect(calls).toHaveLength(6)
  })

  test("a clone with local changes is left as it is: the read alone, never a fetch, checkout or reset", async () => {
    const { calls, run } = stubSsh({
      status: { out: "## main...origin/main\n M packages/x.ts\n?? notes.txt\n" },
    })
    expect(await sync(ONE, run)).toEqual(["peer spark-b: local changes, left as it is"])
    expect(calls).toHaveLength(1)
    expect(calls.flat()).not.toContain("reset")
  })

  test("a detached clone holding a commit no remote branch holds is left as it is, which its clean status never shows: no checkout, no install", async () => {
    const { calls, run } = stubSsh({
      status: { out: "## HEAD (no branch)\n" },
      "rev-list": { out: "fedcba9876543210fedcba9876543210fedcba98\n" },
    })
    expect(await sync(ONE, run)).toEqual([
      "peer spark-b: commits of its own at fedcba9, left as it is",
    ])
    expect(calls).toHaveLength(4)
    expect(calls.flat()).not.toContain("checkout")
    expect(calls.flat()).not.toContain("install")
    const failed = stubSsh({ "rev-list": { code: 128, out: "fatal: bad revision 'HEAD'\n" } })
    expect(await sync(ONE, failed.run)).toEqual([
      "peer spark-b: commit read failed: fatal: bad revision 'HEAD'",
    ])
    expect(failed.calls).toHaveLength(4)
  })

  test("a clone on another branch is left as it is", async () => {
    const { calls, run } = stubSsh({ status: { out: "## canary...origin/canary\n" } })
    expect(await sync(ONE, run)).toEqual(["peer spark-b: on canary, not main, left as it is"])
    expect(calls).toHaveLength(1)
  })

  test("a clone other worktrees are cut from is left as it is, since their hooks read through its git dir; a list that fails moves nothing", async () => {
    const two = stubSsh({
      worktree: {
        out: "worktree /home/you/code/playground\nHEAD 0123\nbranch refs/heads/main\n\nworktree /home/you/replay/r1\nHEAD 0123\ndetached\n\nworktree /home/you/replay/r2\nHEAD 0123\ndetached\n\n",
      },
    })
    expect(await sync(ONE, two.run)).toEqual([
      "peer spark-b: 2 worktrees use the clone, left as it is",
    ])
    expect(two.calls).toHaveLength(2)
    const one = stubSsh({
      worktree: {
        out: "worktree /home/you/code/playground\n\nworktree /home/you/replay/r1\n\n",
      },
    })
    expect(await sync(ONE, one.run)).toEqual([
      "peer spark-b: 1 worktree uses the clone, left as it is",
    ])
    const failed = stubSsh({ worktree: { code: 129, out: "error: unknown option\n" } })
    expect(await sync(ONE, failed.run)).toEqual([
      "peer spark-b: worktree list failed: error: unknown option",
    ])
    expect(failed.calls).toHaveLength(2)
  })

  test("with no key, ssh takes its own default identity: no -i and no IdentitiesOnly", async () => {
    const { calls, run } = stubSsh()
    const env = envFile("PLAYGROUND_PEERS=spark-b=you@10.0.0.2\n")
    expect(await sync(env, run)).toEqual(["peer spark-b: at 0123456"])
    expect(calls[0]?.slice(0, 7)).toEqual([
      "ssh",
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=5",
      "you@10.0.0.2",
      "git",
    ])
  })

  test("a read git fails on the peer, such as a missing clone, says read failed, since ssh reached it", async () => {
    const { calls, run } = stubSsh({
      status: {
        code: 128,
        out: "fatal: cannot change to '/home/you/code/playground': No such file or directory\n",
      },
    })
    expect(await sync(ONE, run)).toEqual([
      "peer spark-b: read failed: fatal: cannot change to '/home/you/code/playground': No such file or directory",
    ])
    expect(calls).toHaveLength(1)
  })

  test("a worktree whose folder is gone, marked prunable, does not hold the clone", async () => {
    const { calls, run } = stubSsh({
      worktree: {
        out: "worktree /home/you/code/playground\nHEAD 0123\nbranch refs/heads/main\n\nworktree /home/you/replay/r1\nHEAD 0123\ndetached\nprunable gitdir file points to non-existent location\n\n",
      },
    })
    expect(await sync(ONE, run)).toEqual(["peer spark-b: at 0123456"])
    expect(calls).toHaveLength(6)
  })

  test("a peer ssh cannot reach prints why, and the next peer still moves", async () => {
    const env = envFile("PLAYGROUND_PEERS=spark-b=you@10.0.0.2,spark-c=me@10.0.0.3\n")
    const run: PeerRun = async (argv) =>
      argv.includes("you@10.0.0.2")
        ? { code: 255, out: "ssh: connect to host 10.0.0.2 port 22: Connection timed out\n" }
        : { code: 0, out: argv.includes("status") ? "## main\n" : "" }
    expect(await sync(env, run)).toEqual([
      "peer spark-b: not reached: ssh: connect to host 10.0.0.2 port 22: Connection timed out",
      "peer spark-c: at 0123456",
    ])
  })

  test("a step that fails stops that peer's move and names the step", async () => {
    const { calls, run } = stubSsh({
      fetch: { code: 128, out: "fatal: unable to access 'https://github.com/'\n" },
    })
    expect(await sync(ONE, run)).toEqual([
      "peer spark-b: fetch failed: fatal: unable to access 'https://github.com/'",
    ])
    expect(calls).toHaveLength(3)
  })

  test("a frozen lockfile that does not match fails as lockfile, with no plain install after it", async () => {
    const { calls, run } = stubSsh({
      install: { code: 1, out: "error: lockfile had changes, but lockfile is frozen\n" },
    })
    expect(await sync(ONE, run)).toEqual(["peer spark-b: install failed: lockfile"])
    expect(calls.filter((argv) => argv.includes("install"))).toHaveLength(1)
  })

  test("a run that throws is that peer's line, never the caller's error", async () => {
    const run: PeerRun = async () => {
      throw new Error("spawn ssh ENOENT")
    }
    expect(await sync(ONE, run)).toEqual(["peer spark-b: failed: spawn ssh ENOENT"])
  })

  test("a sha that is not 40 hex characters moves no peer and runs nothing", async () => {
    const { calls, run } = stubSsh()
    expect(await sync(ONE, run, "HEAD; rm -rf ~")).toEqual([
      "peer sync: HEAD; rm -rf ~ is not a commit sha, so no peer moved",
    ])
    expect(calls).toEqual([])
  })

  test("a checkout with no plain path under home moves no peer and runs nothing", async () => {
    const { calls, run } = stubSsh()
    expect(await sync(ONE, run, SHA, null)).toEqual([
      "peer sync: this checkout's path is not a plain path under the home folder, so no peer moved",
    ])
    expect(calls).toEqual([])
  })

  test("no peers, or no .env, prints nothing and runs nothing", async () => {
    const { calls, run } = stubSsh()
    expect(await sync(envFile("PLAYGROUND_PEERS=\n"), run)).toEqual([])
    expect(await sync(join(dir, "missing.env"), run)).toEqual([])
    expect(calls).toEqual([])
  })

  test("a PLAYGROUND_PEERS the schema refuses prints one line and runs nothing", async () => {
    const { calls, run } = stubSsh()
    const lines = await sync(envFile("PLAYGROUND_PEERS=spark-b=-oProxyCommand=x\n"), run)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain("PLAYGROUND_PEERS does not read, so no peer moved")
    expect(calls).toEqual([])
  })
})
