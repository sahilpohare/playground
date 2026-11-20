import { afterAll, expect, test } from "bun:test"
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"

import { CARVE_OUTS, listTrash } from "../../../../../packages/safe-delete/src"
import { GH_HANGS } from "../../../../../packages/scripts/src/gh-read"
import { cardOf, type CardItem } from "../../../../../packages/scripts/src/ops-tick/unused-card"
import {
  clonesOf,
  processesOf,
  RM_USAGE,
  type PrState,
  prStateOf,
  removePath,
  type RmDeps,
  rmArgs,
  rmDeps,
  rmPeerCommand,
  runRm,
} from "../../../../../packages/scripts/src/playground/rm"

test("rm takes one path, or --worktree's with an optional --discard and --pr, with an optional reason", () => {
  expect(rmArgs(["old"])).toEqual({
    discard: false,
    path: "old",
    reason: "playground rm",
    worktree: false,
  })
  expect(rmArgs(["--worktree", "wt", "--reason", "merged"])).toEqual({
    discard: false,
    path: "wt",
    reason: "merged",
    worktree: true,
  })
  expect(rmArgs(["--worktree", "wt", "--discard"])).toEqual({
    discard: true,
    path: "wt",
    reason: "playground rm",
    worktree: true,
  })
  expect(rmArgs(["--worktree", "wt", "--pr", "https://github.com/o/r/pull/1"])).toEqual({
    discard: false,
    path: "wt",
    pr: "https://github.com/o/r/pull/1",
    reason: "playground rm",
    worktree: true,
  })
})

test("rm takes a path with --card <id>, the card that approved its removal, and an optional --peer <machine>", () => {
  expect(rmArgs(["/m/x.gguf", "--card", "c1", "--reason", "nightly-clean"])).toEqual({
    card: "c1",
    discard: false,
    path: "/m/x.gguf",
    reason: "nightly-clean",
    worktree: false,
  })
  expect(rmArgs(["/m/x.gguf", "--card", "c1", "--peer", "spark-b"])).toEqual({
    card: "c1",
    discard: false,
    path: "/m/x.gguf",
    peer: "spark-b",
    reason: "playground rm",
    worktree: false,
  })
})

test("rm takes --list or --restore <id> alone", () => {
  expect(rmArgs(["--list"])).toEqual({ list: true })
  expect(rmArgs(["--restore", "20261102T120000Z-s/1"])).toEqual({ restore: "20261102T120000Z-s/1" })
})

test.each([
  [[]],
  [["a", "b"]],
  [["--worktree"]],
  [["--force", "a"]],
  [["--list", "a"]],
  [["a", "--worktree", "b"]],
  [["a", "--discard"]],
  [["--worktree", "wt", "--discard", "--discard"]],
  [["--worktree", "wt", "--decision", "#i9"]],
  [["--worktree", "wt", "--discard", "--decision"]],
  [["--worktree", "wt", "--discard", "--decision", "#i9"]],
  [["a", "--pr", "https://github.com/o/r/pull/1"]],
  [["--worktree", "wt", "--pr"]],
  [["--worktree", "wt", "--card", "c1"]],
  [["a", "--card"]],
  [["a", "--peer", "spark-b"]],
  [["--worktree", "wt", "--card", "c1", "--peer", "spark-b"]],
])("rm refuses %j with its usage", (words) => {
  expect(rmArgs(words)).toEqual({ error: RM_USAGE })
})

test("rm refuses a --reason alongside a --peer, since a far-end removal is the peer's own card", () => {
  expect(
    rmArgs(["/m/x.gguf", "--card", "c1", "--peer", "spark-b", "--reason", "nightly-clean"]),
  ).toEqual({ error: RM_USAGE })
  expect(
    rmArgs(["/m/x.gguf", "--card", "c1", "--peer", "spark-b", "--reason", "playground rm"]),
  ).toEqual({ error: RM_USAGE })
})

const dirs: string[] = []
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { force: true, recursive: true })
})

const git = (cwd: string, ...args: string[]) => {
  const run = Bun.spawnSync(["git", "-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd })
  if (run.exitCode !== 0) throw new Error(run.stderr.toString())
  return run.stdout.toString().trim()
}

const file = (path: string, text = "x"): void => {
  mkdirSync(join(path, ".."), { recursive: true })
  writeFileSync(path, text)
}

// A mkdtemp machine: HOME with its main checkout and data folder, and deps that record each notify line.
const machine = () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rm-")))
  dirs.push(root)
  const home = join(root, "home")
  const main = join(home, "playground")
  const data = join(home, ".playground")
  mkdirSync(join(main, ".claude", "worktrees"), { recursive: true })
  mkdirSync(data, { recursive: true })
  writeFileSync(join(data, "roster.json"), JSON.stringify({ agents: [] }))
  const told: string[] = []
  const deps: RmDeps = {
    clones: () => [],
    procs: () => [],
    data,
    defaultBranch: () => null,
    home,
    liveBranch: () => "live/dashboard",
    main,
    merged: () => false,
    mergedHead: () => null,
    notify: (text) => void told.push(text),
    places: () => [],
    prState: async () => null,
    session: async () => "j6rjgy-worker",
  }
  return { deps, home, main, root, told }
}

// A mkdtemp machine for a card: a main whose ask prints one approved card to stdout, a data folder with the ops manager's roster and the saved card, and the card id with its one pick.
const cardMachine = () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rm-card-")))
  dirs.push(root)
  const home = join(root, "home")
  const main = join(home, "playground")
  const data = join(home, ".playground")
  mkdirSync(join(data, "ops", "tick"), { recursive: true })
  mkdirSync(main, { recursive: true })
  const cardId = "11111111-2222-3333-4444-555555555555"
  const item = {
    bytes: 300 * 1024 * 1024,
    id: "sha256:abc",
    kind: "image",
    machine: "here",
    path: "docker image img:1",
  } satisfies CardItem
  const pick = { bytes: item.bytes, machine: item.machine, path: item.path }
  writeFileSync(
    join(data, "roster.json"),
    JSON.stringify({ agents: [{ kind: "ops", name: "ops" }] }),
  )
  writeFileSync(
    join(data, "ops", "tick", "nightly-clean.json"),
    JSON.stringify({ card: { at: "2026-11-18T00:00:00.000Z", id: cardId, items: [item] } }),
  )
  const card = {
    answer: { at: "2026-11-18T01:00:00.000Z", choice: "approve", options: [0] },
    from: "ops",
    kind: "decision",
    preview: cardOf([item]).preview,
    status: "approved",
    updatedAt: "2026-11-18T00:00:00.000Z",
  }
  writeFileSync(join(main, "card.json"), `${JSON.stringify(card)}\n`)
  writeFileSync(
    join(main, "ask.sh"),
    `#!/bin/sh\nif [ "$1" = "get" ] && [ "$#" -eq 2 ]; then cat card.json; printf '%s\\n' 'ask: picked A: Remove' >&2; exit 0; fi\nexit 1\n`,
  )
  writeFileSync(
    join(main, "package.json"),
    JSON.stringify({ name: "fake", private: true, scripts: { ask: "sh ask.sh" } }),
  )
  const repo0 = process.env.PLAYGROUND_REPO
  const data0 = process.env.PLAYGROUND_DATA_DIR
  process.env.PLAYGROUND_REPO = main
  process.env.PLAYGROUND_DATA_DIR = data
  return {
    cardId,
    deps: rmDeps(main),
    pick,
    restore: () => {
      if (repo0 === undefined) delete process.env.PLAYGROUND_REPO
      else process.env.PLAYGROUND_REPO = repo0
      if (data0 === undefined) delete process.env.PLAYGROUND_DATA_DIR
      else process.env.PLAYGROUND_DATA_DIR = data0
    },
  }
}

test("rm --card reads ask's card from its stdout alone, so a picked line on stderr no longer breaks it", async () => {
  const { cardId, deps, pick, restore } = cardMachine()
  try {
    const picks = await deps.approvals!(cardId)
    expect(picks).toEqual([pick])
  } finally {
    restore()
  }
})

test("runRm moves a path, lists it and restores it, telling no one", async () => {
  const { deps, home, told } = machine()
  const path = join(home, "old.txt")
  writeFileSync(path, "x")
  expect(await runRm([path], deps)).toBe(0)
  expect(existsSync(path)).toBe(false)
  expect(await runRm(["--list"], deps)).toBe(0)
  const [batch] = readdirSync(join(deps.data, "trash"))
  expect(await runRm(["--restore", `${batch}/1`], deps)).toBe(0)
  expect(existsSync(path)).toBe(true)
  expect(told).toEqual([])
})

test("rm of a tree leaves its node_modules and web/next/.next out of the trash, keeps every other file, and the move and restore lines name the install", async () => {
  const { deps, home } = machine()
  const tree = join(home, "review-clone")
  file(join(tree, "node_modules", "left-pad", "index.js"))
  file(join(tree, "packages", "web", "node_modules", "react", "index.js"))
  file(join(tree, "web", "next", ".next", "build-manifest.json"))
  file(join(tree, "web", "next", ".next-cache", "y.js"))
  file(join(tree, "src", "index.ts"))
  const log = console.log
  const said: string[] = []
  console.log = (line: string) => void said.push(line)
  const code = await runRm([tree, "--reason", "scratch"], deps)
  expect(code).toBe(0)
  const trash = join(deps.data, "trash")
  const [batch] = readdirSync(trash)
  const item = join(trash, batch, "1", "review-clone")
  expect(existsSync(join(item, "node_modules"))).toBe(false)
  expect(existsSync(join(item, "packages", "web", "node_modules"))).toBe(false)
  expect(existsSync(join(item, "web", "next", ".next"))).toBe(false)
  expect(existsSync(join(item, "web", "next", ".next-cache", "y.js"))).toBe(true)
  expect(existsSync(join(item, "src", "index.ts"))).toBe(true)
  expect(said.join("\n")).toContain("bun install")
  expect(await runRm(["--restore", `${batch}/1`], deps)).toBe(0)
  console.log = log
  expect(existsSync(join(tree, "src", "index.ts"))).toBe(true)
  expect(existsSync(join(tree, "node_modules"))).toBe(false)
  expect(said.join("\n")).toContain("bun install")
})

test("a strip that stops partway still moves the tree, and the move line names it", async () => {
  const { deps, home } = machine()
  const tree = join(home, "review-clone")
  file(join(tree, "node_modules", "locked", "child.js"))
  file(join(tree, "node_modules", "ok", "child.js"))
  file(join(tree, "src", "index.ts"))
  chmodSync(join(tree, "node_modules", "locked"), 0o555)
  const log = console.log
  const said: string[] = []
  console.log = (line: string) => void said.push(line)
  expect(await runRm([tree, "--reason", "scratch"], deps)).toBe(0)
  console.log = log
  expect(said.join("\n")).toContain("the strip stopped")
  const trash = join(deps.data, "trash")
  const [batch] = readdirSync(trash)
  expect(existsSync(join(trash, batch, "1", "review-clone", "src", "index.ts"))).toBe(true)
  chmodSync(join(trash, batch, "1", "review-clone", "node_modules", "locked"), 0o755)
})

test("the restore of a batch the strip took rebuildables from names the install", async () => {
  const { deps, home } = machine()
  const trash = join(deps.data, "trash")
  const batch = "20261101T120000Z-xssrgq"
  file(join(trash, batch, "1", "review-clone", "node_modules", "left-pad", "index.js"))
  file(join(trash, batch, "1", "review-clone", "src", "index.ts"))
  writeFileSync(
    join(trash, batch, "manifest.jsonl"),
    `${JSON.stringify({
      at: "2026-11-01T12:00:00.000Z",
      files: 2,
      id: `${batch}/1`,
      path: join(home, "review-clone"),
      reason: "playground rm",
      session: "xssrgq",
      size: 20,
      stripped: 1,
    })}\n`,
  )
  const log = console.log
  const said: string[] = []
  console.log = (line: string) => void said.push(line)
  expect(await runRm(["--restore", `${batch}/1`], deps)).toBe(0)
  console.log = log
  expect(existsSync(join(home, "review-clone", "src", "index.ts"))).toBe(true)
  expect(said.join("\n")).toContain("bun install")
})

test("runRm tells the dispatcher once when a session hits the per-minute cap, however many tries it refuses", async () => {
  const { deps, home, told } = machine()
  const paths = Array.from({ length: 14 }, (_, i) => {
    const path = join(home, `old-${i}.txt`)
    writeFileSync(path, "x")
    return path
  })
  const codes: number[] = []
  for (const path of paths) codes.push(await runRm([path], deps))
  expect(codes).toEqual([0, 0, 0, ...Array(11).fill(1)])
  expect(told).toEqual([
    "j6rjgy-worker: refused a 4th removal: j6rjgy-worker moved 3 paths in the last minute, the most one session may",
  ])
})

test("an end clears its scratch folder of 4 subfolders and its scratchpad in one move each, under the per-minute cap", async () => {
  const { deps, home, told } = machine()
  const scratch = join(home, ".playground", "scratch", "j6rjgy-worker")
  const pad = join(home, ".playground", "scratchpad", "j6rjgy-worker")
  for (const sub of ["a", "b", "c", "d"]) {
    mkdirSync(join(scratch, sub), { recursive: true })
    writeFileSync(join(scratch, sub, "work.txt"), "x")
  }
  mkdirSync(pad, { recursive: true })
  writeFileSync(join(pad, "brief.md"), "x")
  expect([await runRm([scratch], deps), await runRm([pad], deps)]).toEqual([0, 0])
  expect(listTrash(join(deps.data, "trash")).map((entry) => entry.path)).toEqual([scratch, pad])
  expect(told).toEqual([])
})

test("runRm clears the caller's own scratch folder", async () => {
  const { deps, home } = machine()
  const scratch = join(home, ".playground", "scratch", "j6rjgy-worker")
  mkdirSync(join(scratch, "tmp"), { recursive: true })
  writeFileSync(join(scratch, "tmp", "work.txt"), "x")
  expect(await runRm([scratch], deps)).toBe(0)
  expect(existsSync(scratch)).toBe(false)
})

test("runRm refuses another live session's scratch folder", async () => {
  const { deps, home } = pads([{ name: "a4b5c6-worker", status: "working" }], "scratch")
  const other = join(home, ".playground", "scratch", "a4b5c6-worker")
  mkdirSync(other, { recursive: true })
  expect(await runRm([other], deps)).toBe(1)
  expect(existsSync(other)).toBe(true)
})

test("runRm refuses a .. escape out of the caller's own scratch folder into a live session's", async () => {
  const { deps, home } = pads([{ name: "a4b5c6-worker", status: "working" }], "scratch")
  const scratch = join(home, ".playground", "scratch", "j6rjgy-worker")
  const other = join(home, ".playground", "scratch", "a4b5c6-worker")
  mkdirSync(other, { recursive: true })
  expect(await runRm([`${scratch}/../a4b5c6-worker`], deps)).toBe(1)
  expect(existsSync(other)).toBe(true)
})

test("runRm refuses a symlink inside the caller's own scratch folder that points out of it", async () => {
  const { deps, home } = machine()
  const scratch = join(home, ".playground", "scratch", "j6rjgy-worker")
  mkdirSync(join(home, ".ssh"), { recursive: true })
  mkdirSync(scratch, { recursive: true })
  symlinkSync(join(home, ".ssh"), join(scratch, "keys"))
  expect(await runRm([join(scratch, "keys")], deps)).toBe(1)
  expect(existsSync(join(scratch, "keys"))).toBe(true)
})

// The machine's scratchpad, or its scratch folder, with a roster of the given rows.
const pads = (rows: { name: string; status: string }[], dir = "scratchpad") => {
  const m = machine()
  writeFileSync(join(m.deps.data, "roster.json"), JSON.stringify({ agents: rows }))
  return { ...m, pad: join(m.deps.data, dir) }
}

test("runRm clears a path in the caller's own scratchpad folder", async () => {
  const { deps, pad } = pads([{ name: "j6rjgy-worker", status: "working" }])
  mkdirSync(join(pad, "j6rjgy-worker", "1929"), { recursive: true })
  writeFileSync(join(pad, "j6rjgy-worker", "1929", "probe.log"), "x")
  expect(await runRm([join(pad, "j6rjgy-worker", "1929")], deps)).toBe(0)
  expect(existsSync(join(pad, "j6rjgy-worker", "1929"))).toBe(false)
  expect(existsSync(join(pad, "j6rjgy-worker"))).toBe(true)
})

test.each(["scratchpad", "scratch"])(
  "runRm clears the whole %s folder of a session the roster lists as finished, or lists not at all, and --restore brings it back",
  async (dir) => {
    const { deps, pad } = pads(
      [
        { name: "a4b5c6-reviewer", status: "ended" },
        { name: "d7e8f9-runner", status: "parked" },
      ],
      dir,
    )
    for (const name of ["a4b5c6-reviewer", "d7e8f9-runner", "q1w2e3"]) {
      mkdirSync(join(pad, name, "shots"), { recursive: true })
      writeFileSync(join(pad, name, "shots", "a.png"), "x")
      expect(await runRm([join(pad, name)], deps)).toBe(0)
      expect(existsSync(join(pad, name))).toBe(false)
    }
    expect(existsSync(pad)).toBe(true)
    const moved = listTrash(join(deps.data, "trash")).find(
      (entry) => entry.path === join(pad, "q1w2e3"),
    )!
    expect(await runRm(["--restore", moved.id], deps)).toBe(0)
    expect(existsSync(join(pad, "q1w2e3", "shots", "a.png"))).toBe(true)
  },
)

test.each(["scratchpad", "scratch"])(
  "runRm refuses a live session's %s folder, every path in it, and its bare id's folder while any of that id's rows is live, to any other session",
  async (dir) => {
    const { deps, pad, told } = pads(
      [
        { name: "j6rjgy-worker", status: "working" },
        { name: "a4b5c6-reviewer", status: "waiting" },
        { name: "h1j2k3-tester", status: "starting" },
        { name: "p4q5r6-worker", status: "ended" },
        { name: "p4q5r6-reviewer", status: "working" },
      ],
      dir,
    )
    for (const path of [
      join(pad, "a4b5c6-reviewer"),
      join(pad, "a4b5c6-reviewer", "r1.md"),
      join(pad, "h1j2k3-tester"),
      join(pad, "h1j2k3"),
      join(pad, "p4q5r6"),
    ]) {
      mkdirSync(join(pad, "a4b5c6-reviewer"), { recursive: true })
      mkdirSync(join(pad, "h1j2k3-tester"), { recursive: true })
      mkdirSync(join(pad, "h1j2k3"), { recursive: true })
      mkdirSync(join(pad, "p4q5r6"), { recursive: true })
      writeFileSync(join(pad, "a4b5c6-reviewer", "r1.md"), "x")
      expect(await runRm([path], deps)).toBe(1)
      expect(existsSync(path)).toBe(true)
    }
    expect(told.every((line) => line.includes("is inside the protected"))).toBe(true)
  },
)

// A folder of one file more than the tripwire's count, spread over subfolders.
const overCount = (dir: string) => {
  for (let i = 0; i <= 5000; i++) {
    const sub = join(dir, "clone", String(i % 50))
    if (i < 50) mkdirSync(sub, { recursive: true })
    writeFileSync(join(sub, String(i)), "x")
  }
}

test.each(["scratchpad", "scratch"])(
  "runRm clears an ended session's whole %s folder over the tripwire's file count, and --restore brings back every file",
  async (dir) => {
    const { deps, pad } = pads([{ name: "a4b5c6-worker", status: "ended" }], dir)
    const folder = join(pad, "a4b5c6-worker")
    overCount(folder)
    expect(await runRm([folder], deps)).toBe(0)
    expect(existsSync(folder)).toBe(false)
    const moved = listTrash(join(deps.data, "trash")).find((entry) => entry.path === folder)!
    expect(moved.files).toBe(5001)
    expect(await runRm(["--restore", moved.id], deps)).toBe(0)
    expect(
      readdirSync(folder, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()),
    ).toHaveLength(5001)
  },
)

// the file count does not apply to an ended session's whole folder, so its refusal names the byte cap alone
test.each(["scratchpad", "scratch"])(
  "runRm refuses an ended session's whole %s folder over 2 GB, naming the 2 GB cap alone",
  async (dir) => {
    const { deps, pad, told } = pads([{ name: "a4b5c6-worker", status: "ended" }], dir)
    const folder = join(pad, "a4b5c6-worker")
    mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, "big.bin"), "")
    truncateSync(join(folder, "big.bin"), 2 * 1024 ** 3 + 1)
    expect(await runRm([folder], deps)).toBe(1)
    expect(existsSync(join(folder, "big.bin"))).toBe(true)
    expect(told.filter((line) => line.includes("past the tripwire"))).toEqual([
      expect.stringContaining(" holds over 2 GB, past the tripwire"),
    ])
  },
)

test("runRm keeps the tripwire's file count and its alert for a path inside an ended folder and any other path", async () => {
  for (const at of [
    (pad: string) => join(pad, "a4b5c6-worker", "1938"),
    (pad: string) => join(pad, "..", "..", "big"),
  ]) {
    const { deps, pad, told } = pads([
      { name: "j6rjgy-worker", status: "working" },
      { name: "a4b5c6-worker", status: "ended" },
    ])
    const path = at(pad)
    overCount(path)
    expect(await runRm([path], deps)).toBe(1)
    expect(existsSync(join(path, "clone", "0", "0"))).toBe(true)
    expect(told.some((line) => line.includes("past the tripwire"))).toBe(true)
  }
})

// a ship rehearsal in the caller's own scratchpad folder holds two clones, past 5,000 files under 2 GB
test("runRm clears a folder inside the caller's own scratchpad folder past the tripwire's file count, refuses it past 2 GB, and refuses one inside another session's", async () => {
  const { deps, pad } = pads([
    { name: "j6rjgy-worker", status: "working" },
    { name: "a4b5c6-worker", status: "working" },
  ])
  const rehearsal = join(pad, "j6rjgy-worker", "ship-rehearsal")
  overCount(rehearsal)
  expect(await runRm([rehearsal], deps)).toBe(0)
  expect(existsSync(rehearsal)).toBe(false)
  expect(existsSync(join(pad, "j6rjgy-worker"))).toBe(true)
  expect(listTrash(join(deps.data, "trash")).find((entry) => entry.path === rehearsal)?.files).toBe(
    5001,
  )
  const huge = join(pad, "j6rjgy-worker", "huge")
  mkdirSync(huge, { recursive: true })
  writeFileSync(join(huge, "big.bin"), "")
  truncateSync(join(huge, "big.bin"), 2 * 1024 ** 3 + 1)
  expect(await runRm([huge], deps)).toBe(1)
  expect(existsSync(join(huge, "big.bin"))).toBe(true)
  const theirs = join(pad, "a4b5c6-worker", "ship-rehearsal")
  overCount(theirs)
  expect(await runRm([theirs], deps)).toBe(1)
  expect(existsSync(join(theirs, "clone", "0", "0"))).toBe(true)
})

test("an end leaves its own scratch or scratchpad folder over the tripwire in place, with no move and no alert, its refusal naming who clears it", async () => {
  for (const dir of ["scratch", "scratchpad"]) {
    const { deps, told } = pads([{ name: "j6rjgy-worker", status: "working" }])
    const folder = join(deps.data, dir, "j6rjgy-worker")
    overCount(folder)
    const errors: string[] = []
    const error = console.error
    console.error = (line: string) => void errors.push(line)
    try {
      expect(await runRm([folder], deps)).toBe(1)
    } finally {
      console.error = error
    }
    expect(existsSync(join(folder, "clone", "0", "0"))).toBe(true)
    expect(listTrash(join(deps.data, "trash"))).toEqual([])
    expect(told).toEqual([])
    expect(errors.join("\n")).toContain("leave it in place whole, never split")
  }
})

// The own folder's plain refusal reaches nothing else: each path here, over the tripwire, keeps its alert.
test("over the tripwire, another session's folder, a folder above the own one, the own folder as a symlink and that symlink's target still alert", async () => {
  const own = (data: string, dir: string) => join(data, dir, "j6rjgy-worker")
  const filled = (path: string, at = path) => {
    overCount(path)
    return at
  }
  const linked = (data: string, home: string, at: string) => {
    overCount(join(home, "big"))
    mkdirSync(join(data, "scratchpad"), { recursive: true })
    symlinkSync(join(home, "big"), own(data, "scratchpad"))
    return at
  }
  const cases: [string, (data: string, home: string) => string][] = [
    ["another session's scratch", (data) => filled(join(data, "scratch", "a4b5c6-worker"))],
    ["another session's scratchpad", (data) => filled(join(data, "scratchpad", "a4b5c6-worker"))],
    ["scratch/ itself", (data) => filled(own(data, "scratch"), join(data, "scratch"))],
    ["scratchpad/ itself", (data) => filled(own(data, "scratchpad"), join(data, "scratchpad"))],
    ["the own folder as a symlink", (data, home) => linked(data, home, own(data, "scratchpad"))],
    ["the own folder's symlink target", (data, home) => linked(data, home, join(home, "big"))],
  ]
  for (const [name, at] of cases) {
    const { deps, home, told } = pads([
      { name: "j6rjgy-worker", status: "working" },
      { name: "a4b5c6-worker", status: "working" },
    ])
    const path = at(deps.data, home)
    const error = console.error
    console.error = () => {}
    try {
      expect([name, await runRm([path], deps)]).toEqual([name, 1])
    } finally {
      console.error = error
    }
    expect([name, listTrash(join(deps.data, "trash"))]).toEqual([name, []])
    expect([name, told.length]).toEqual([name, 1])
  }
})

test("a symlink inside the own scratch folder to a folder over the tripwire moves alone, its target whole, with no alert", async () => {
  const { deps, home, told } = machine()
  const link = join(deps.data, "scratch", "j6rjgy-worker", "out")
  overCount(join(home, "big"))
  mkdirSync(dirname(link), { recursive: true })
  symlinkSync(join(home, "big"), link)
  expect(await runRm([link], deps)).toBe(0)
  expect(listTrash(join(deps.data, "trash")).map((entry) => entry.path)).toEqual([link])
  expect(existsSync(join(home, "big", "clone", "0", "0"))).toBe(true)
  expect(told).toEqual([])
})

test.each(["scratchpad", "scratch"])(
  "--restore refuses a path inside an ended %s folder while a symlink stands at that folder or at a folder between",
  async (dir) => {
    const { deps, home, pad } = pads([], dir)
    mkdirSync(join(home, "kept"), { recursive: true })
    for (const [moved, link] of [
      [join(pad, "q1w2e3", "shots"), join(pad, "q1w2e3")],
      [join(pad, "z9x8c7", "a", "shots"), join(pad, "z9x8c7", "a")],
    ] as const) {
      mkdirSync(moved, { recursive: true })
      writeFileSync(join(moved, "a.png"), "x")
      expect(await runRm([moved], deps)).toBe(0)
      const entry = listTrash(join(deps.data, "trash")).find((e) => e.path === moved)!
      rmSync(link, { recursive: true })
      symlinkSync(join(home, "kept"), link)
      expect(await runRm(["--restore", entry.id], deps)).toBe(1)
      expect(existsSync(join(home, "kept", "shots"))).toBe(false)
    }
  },
)

test.each(["scratchpad", "scratch"])(
  "runRm refuses the %s folder itself, every other path in the data folder, an ended session's folder that is a symlink, and any of them while the roster cannot be read",
  async (dir) => {
    const { deps, home, pad } = pads([{ name: "a4b5c6-reviewer", status: "ended" }], dir)
    mkdirSync(join(pad, "a4b5c6-reviewer"), { recursive: true })
    mkdirSync(join(deps.data, "briefs"), { recursive: true })
    mkdirSync(join(home, "kept"), { recursive: true })
    symlinkSync(join(deps.data, "briefs"), join(pad, "x9y8z7-worker"))
    symlinkSync(join(home, "kept"), join(pad, "m5n6b7-worker"))
    for (const path of [
      pad,
      join(deps.data, "roster.json"),
      join(deps.data, "briefs"),
      join(pad, "x9y8z7-worker"),
      join(pad, "m5n6b7-worker"),
    ]) {
      expect(await runRm([path], deps)).toBe(1)
      expect(existsSync(path)).toBe(true)
    }
    writeFileSync(join(deps.data, "roster.json"), "{")
    expect(await runRm([join(pad, "a4b5c6-reviewer")], deps)).toBe(1)
    expect(existsSync(join(pad, "a4b5c6-reviewer"))).toBe(true)
  },
)

// a data folder a merged PR retired, such as the runner host's old run folder, goes whole to the trash on any machine
test("runRm removes a retired data folder whole and --restore brings it back, and refuses an unlisted top-level folder and a retired name that is a symlink", async () => {
  const { deps, home } = machine()
  const ci = join(deps.data, "ci")
  mkdirSync(join(ci, ".claude", "worktrees"), { recursive: true })
  writeFileSync(join(ci, "suite.sh"), "x")
  expect(await runRm([ci], deps)).toBe(0)
  expect(existsSync(ci)).toBe(false)
  const moved = listTrash(join(deps.data, "trash")).find((entry) => entry.path === ci)!
  expect(await runRm(["--restore", moved.id], deps)).toBe(0)
  expect(readFileSync(join(ci, "suite.sh"), "utf8")).toBe("x")
  const ops = join(deps.data, "ops")
  mkdirSync(ops, { recursive: true })
  expect(await runRm([ops], deps)).toBe(1)
  expect(existsSync(ops)).toBe(true)
  expect(await runRm([join(ci, "suite.sh")], deps)).toBe(1)
  expect(existsSync(join(ci, "suite.sh"))).toBe(true)
  rmSync(ci, { recursive: true })
  mkdirSync(join(home, "kept"), { recursive: true })
  symlinkSync(join(home, "kept"), ci)
  expect(await runRm([ci], deps)).toBe(1)
  expect(lstatSync(ci).isSymbolicLink()).toBe(true)
  expect(existsSync(join(home, "kept"))).toBe(true)
})

test("runRm tells the dispatcher of a protected path, and not of a missing one", async () => {
  const { deps, home, told } = machine()
  expect(await runRm([home], deps)).toBe(1)
  expect(told).toEqual([`j6rjgy-worker: ${home} is protected`])
  expect(await runRm([join(home, "gone")], deps)).toBe(1)
  expect(told.length).toBe(1)
  expect(await runRm(["a", "b"], deps)).toBe(2)
})

// A carve-out is its own script's alone: playground rm names none, so an entry in each carve-out's folder stays protected and nothing moves.
test.each(Object.entries(CARVE_OUTS))(
  "runRm takes no carve-out: an entry in %s's folder stays protected",
  async (_, carve) => {
    const { deps, told } = machine()
    const entry = join(deps.data, carve.folder, "entry")
    mkdirSync(entry, { recursive: true })
    expect(await runRm([entry], deps)).toBe(1)
    expect(existsSync(entry)).toBe(true)
    expect(told).toEqual([`j6rjgy-worker: ${entry} is inside the protected ${deps.data}`])
  },
)

test("runRm --worktree checks the holders, moves the worktree and prunes it from git", async () => {
  const { deps, main, root } = machine()
  git(root, "init", "--bare", "-q", join(root, "remote.git"))
  git(main, "init", "-q", "-b", "canary")
  writeFileSync(join(main, "README.md"), "x")
  git(main, "add", ".")
  git(main, "commit", "-qm", "init")
  git(main, "remote", "add", "origin", join(root, "remote.git"))
  git(main, "push", "-q", "origin", "canary")
  const wt = join(main, ".claude", "worktrees", "pg-1")
  git(main, "worktree", "add", "-q", "-b", "PG-1-thing", wt)
  git(wt, "push", "-q", "origin", "PG-1-thing")
  const held = { command: "zsh", cwd: wt, pid: 7, sockets: [] }
  expect(await runRm(["--worktree", wt], { ...deps, procs: () => [held] })).toBe(1)
  expect(existsSync(wt)).toBe(true)
  const url = "https://github.com/o/r/pull/1"
  const merging = { name: "abc123-worker", pr: url, status: "working" }
  writeFileSync(join(deps.data, "roster.json"), JSON.stringify({ agents: [merging] }))
  expect(await runRm(["--worktree", wt], deps)).toBe(1)
  expect(await runRm(["--worktree", wt, "--pr", `${url}0`], deps)).toBe(1)
  expect(existsSync(wt)).toBe(true)
  expect(await runRm(["--worktree", wt, "--pr", url], deps)).toBe(0)
  expect(existsSync(wt)).toBe(false)
  expect(git(main, "worktree", "list")).not.toContain("pg-1")
})

// A main checkout whose origin/canary sits at its head, and its worktree on PG-1-thing, for the live-row hold's cases.
const canaryRepo = () => {
  const { deps, main, root } = machine()
  git(root, "init", "--bare", "-q", join(root, "remote.git"))
  git(main, "init", "-q", "-b", "canary")
  writeFileSync(join(main, "README.md"), "x")
  git(main, "add", ".")
  git(main, "commit", "-qm", "init")
  git(main, "remote", "add", "origin", join(root, "remote.git"))
  git(main, "push", "-q", "origin", "canary")
  const wt = join(main, ".claude", "worktrees", "pg-1")
  git(main, "worktree", "add", "-q", "-b", "PG-1-thing", wt)
  return { deps, main, wt }
}

// PG-2017: a live row holds a worktree no more when it sits clean, detached, at a commit origin/canary holds; each broken condition keeps the hold. The row holds by the folder's name, since a detached tree reads no branch, and each case runs under --discard, so only the row's hold refuses.
const detach = (wt: string) => git(wt, "checkout", "-q", "--detach", "origin/canary")
const withRow = (deps: RmDeps, name = "pg-1") =>
  writeFileSync(
    join(deps.data, "roster.json"),
    JSON.stringify({ agents: [{ name, status: "working" }] }),
  )
test.each([
  [
    "frees a clean detached checkout at a commit origin/canary holds",
    (wt: string) => detach(wt),
    0,
  ],
  [
    "refuses a dirty one",
    (wt: string) => {
      detach(wt)
      writeFileSync(join(wt, "README.md"), "dirty")
    },
    1,
  ],
  [
    "refuses one with an untracked file",
    (wt: string) => {
      detach(wt)
      writeFileSync(join(wt, "extra.txt"), "x")
    },
    1,
  ],
  ["refuses one on a branch", () => {}, 1],
  [
    "refuses a clean detached one at a commit origin/canary lacks",
    (wt: string) => {
      detach(wt)
      writeFileSync(join(wt, "README.md"), "past")
      git(wt, "add", ".")
      git(wt, "commit", "-qm", "past")
    },
    1,
  ],
])("runRm --worktree %s under a live row", async (_, arm, code) => {
  const { deps, main, wt } = canaryRepo()
  arm(wt)
  withRow(deps)
  expect(await runRm(["--worktree", wt, "--discard"], deps)).toBe(code)
  expect(existsSync(wt)).toBe(code !== 0)
  if (code === 0) expect(git(main, "worktree", "list")).not.toContain("pg-1")
})

// #1348: --discard needs no decision, and keeps the commits no remote holds in a bundle in the trash first
test("runRm --worktree refuses a worktree with uncommitted work, naming --discard, which passes with no decision, keeping its commit no remote holds in a bundle that brings it back", async () => {
  const { deps, main, root } = machine()
  git(root, "init", "--bare", "-q", join(root, "remote.git"))
  git(main, "init", "-q", "-b", "canary")
  writeFileSync(join(main, "README.md"), "x")
  git(main, "add", ".")
  git(main, "commit", "-qm", "init")
  git(main, "remote", "add", "origin", join(root, "remote.git"))
  git(main, "push", "-q", "origin", "canary")
  const wt = join(main, ".claude", "worktrees", "pg-1")
  git(main, "worktree", "add", "-q", "-b", "PG-1-thing", wt)
  writeFileSync(join(wt, "done.txt"), "x")
  git(wt, "add", ".")
  git(wt, "commit", "-qm", "work no remote holds")
  const head = git(wt, "rev-parse", "HEAD")
  writeFileSync(join(wt, "wip.txt"), "x")
  const said: string[] = []
  const [error, log] = [console.error, console.log]
  console.error = (line: string) => void said.push(line)
  console.log = (line: string) => void said.push(line)
  try {
    expect(await runRm(["--worktree", wt], deps)).toBe(1)
    expect(said).toEqual([
      `playground: ${wt} holds 1 uncommitted change (wip.txt): playground rm --worktree ${wt} --discard removes it anyway, its commits no remote holds kept first in a git bundle beside it in the trash`,
    ])
    expect(existsSync(wt)).toBe(true)
    said.length = 0
    expect(await runRm(["--worktree", wt, "--discard"], deps)).toBe(0)
  } finally {
    console.error = error
    console.log = log
  }
  expect(existsSync(wt)).toBe(false)
  const [entry] = listTrash(join(deps.data, "trash"))
  const bundle = entry!.bundle!
  expect(bundle).toBe(
    join(dirname(realpathSync(join(deps.data, "trash", entry!.id))), "pg-1.bundle"),
  )
  expect(said.at(-1)).toContain(
    `; its commits no remote holds are kept in ${bundle}, which git -C ${main} fetch ${bundle} HEAD brings back`,
  )
  expect(readFileSync(join(dirname(bundle), "pg-1.shas"), "utf8")).toBe(`${head} HEAD\n`)
  git(main, "worktree", "prune")
  git(main, "branch", "-D", "PG-1-thing")
  git(main, "fetch", "-q", bundle, "HEAD:refs/heads/PG-1-thing")
  expect(git(main, "rev-parse", "PG-1-thing")).toBe(head)
})

// A main checkout on canary with worktree pg-1 holding one uncommitted file.
const dirtyWorktree = (main: string) => {
  git(main, "init", "-q", "-b", "canary")
  writeFileSync(join(main, "README.md"), "x")
  git(main, "add", ".")
  git(main, "commit", "-qm", "init")
  const wt = join(main, ".claude", "worktrees", "pg-1")
  git(main, "worktree", "add", "-q", "-b", "PG-1-thing", wt)
  writeFileSync(join(wt, "wip.txt"), "x")
  return { wt }
}

// runRm's exit and what it printed to stderr.
const discardBy = async (wt: string, deps: RmDeps) => {
  const said: string[] = []
  const error = console.error
  console.error = (line: string) => void said.push(line)
  try {
    return { code: await runRm(["--worktree", wt, "--discard"], deps), said }
  } finally {
    console.error = error
  }
}

// A session's --discard with the worktree's PR state stubbed, and each (path, pr) it was asked for.
const statedSession = (deps: RmDeps, state: PrState | null) => {
  const asked: [string, string | undefined][] = []
  const session: RmDeps = {
    ...deps,
    prState: async (path, pr) => (
      asked.push([path, pr]),
      state === null ? null : { head: git(path, "rev-parse", "HEAD"), number: 1, state }
    ),
  }
  return { asked, session }
}

// PG-1165: a merged or closed PR's worktree goes to the trash with no Inbox delete decision
test("a session's --discard passes with no --decision on a worktree whose PR merged or closed", async () => {
  for (const state of ["MERGED", "CLOSED"] as const) {
    const { deps, main } = machine()
    const { wt } = dirtyWorktree(main)
    const { asked, session } = statedSession(deps, state)
    expect(await discardBy(wt, session)).toEqual({ code: 0, said: [] })
    expect(existsSync(wt)).toBe(false)
    expect(asked).toEqual([[wt, undefined]])
  }
  const { deps, main } = machine()
  const { wt } = dirtyWorktree(main)
  const { asked, session } = statedSession(deps, "MERGED")
  const url = "https://github.com/o/r/pull/1"
  expect(await runRm(["--worktree", wt, "--discard", "--pr", url], session)).toBe(0)
  expect(asked).toEqual([[wt, url]])
})

// #1348: an open or missing PR's worktree goes with no decision too, its work kept in the trash
test("a session's --discard on an OPEN PR's worktree, or one whose PR state reads as none (no PR, or GitHub unreadable), passes with no decision", async () => {
  for (const state of ["OPEN", null] as const) {
    const { deps, main } = machine()
    const { wt } = dirtyWorktree(main)
    const { asked, session } = statedSession(deps, state)
    expect(await discardBy(wt, session)).toEqual({ code: 0, said: [] })
    expect(asked).toEqual([[wt, undefined]])
    expect(existsSync(wt)).toBe(false)
  }
})

// runRm's exit and each line it printed, with the worktree's PR stubbed as #<number> in that state at <head> (its own HEAD unless given; none for null), and a live roster row given
const heldRun = async (
  deps: RmDeps,
  words: string[],
  state: PrState | null,
  row: Record<string, string>,
  number = 1,
  head = git(words[1]!, "rev-parse", "HEAD"),
) => {
  writeFileSync(join(deps.data, "roster.json"), JSON.stringify({ agents: [row] }))
  const prState = async () => (state === null ? null : { head, number, state })
  const out: string[] = []
  const [error, log] = [console.error, console.log]
  console.error = (line: string) => void out.push(line)
  console.log = (line: string) => void out.push(line)
  try {
    const session = { ...deps, prState }
    return { code: await runRm(words, session), out }
  } finally {
    console.error = error
    console.log = log
  }
}

// PG-1419: a working row that kept a finished PR's branch no longer holds that PR's worktree
test("a worktree whose PR merged or closed passes a working roster row naming its branch, and says which PR freed it", async () => {
  for (const state of ["MERGED", "CLOSED"] as const) {
    const { deps, main } = machine()
    const { wt } = dirtyWorktree(main)
    const row = { branch: "PG-1-thing", name: "abc123-worker", status: "working" }
    const words = ["--worktree", wt, "--discard"]
    const { code, out } = await heldRun(deps, words, state, row, 7)
    expect({ code, said: out[0] }).toEqual({
      code: 0,
      said: `playground: ${wt} is freed by #7, which reads ${state}, past abc123-worker's roster row (working)`,
    })
    expect(existsSync(wt)).toBe(false)
  }
})

// PG-2498: a row holding the worktree by its own merged PR's number alone is the freed check's, which names the PR that freed it, so the merged-head read asks gh nothing for it
test("a worktree freed by its own merged PR, held by a row naming that PR alone, says which PR freed it and asks gh for no merged head", async () => {
  const { deps, main } = machine()
  const { wt } = dirtyWorktree(main)
  const asked: string[] = []
  const head = git(wt, "rev-parse", "HEAD")
  const merged: RmDeps = { ...deps, mergedHead: (_, u) => (asked.push(u), head) }
  const row = { name: "abc123-worker", pr: "https://github.com/o/r/pull/7", status: "working" }
  const { code, out } = await heldRun(merged, ["--worktree", wt, "--discard"], "MERGED", row, 7)
  expect({ asked, code, said: out[0] }).toEqual({
    asked: [],
    code: 0,
    said: `playground: ${wt} is freed by #7, which reads MERGED, past abc123-worker's roster row (working)`,
  })
})

// PG-1419: the freed removal goes through the 7-day trash like any other, and --restore brings the worktree back, the work --discard let go with it
test("a freed worktree's removal is restorable: --restore brings it back on its branch, at its commit, listed, its discarded work back as untracked", async () => {
  const { deps, main } = machine()
  const { wt } = dirtyWorktree(main)
  const sha = git(wt, "rev-parse", "HEAD")
  const row = { branch: "PG-1-thing", name: "abc123-worker", status: "working" }
  const words = ["--worktree", wt, "--discard"]
  const { out } = await heldRun(deps, words, "MERGED", row, 7)
  const [batch] = readdirSync(join(deps.data, "trash"))
  const id = `${batch}/1`
  expect(out[1]).toContain(`playground rm --restore ${id} brings it back`)
  expect(await runRm(["--restore", id], deps)).toBe(0)
  expect(gitSees(main, wt)).toEqual({
    branch: "PG-1-thing",
    head: sha,
    listed: true,
    status: "?? wip.txt",
  })
})

// PG-1419: commits past the merged PR's head keep the row's hold, so --discard cannot take unmerged work, and the run names them
test("a worktree with a commit past its merged PR's head stays held by a working row naming its branch, its commit named", async () => {
  const { deps, main } = machine()
  const { wt } = dirtyWorktree(main)
  writeFileSync(join(wt, "more.txt"), "x")
  git(wt, "add", ".")
  git(wt, "commit", "-qm", "more")
  const past = git(wt, "rev-parse", "HEAD~1")
  const row = { branch: "PG-1-thing", name: "abc123-worker", status: "working" }
  const words = ["--worktree", wt, "--discard"]
  const { code, out } = await heldRun(deps, words, "MERGED", row, 7, past)
  expect({ code, said: out[0] }).toEqual({
    code: 1,
    said: `playground: ${wt} is held by abc123-worker, which the roster lists as working, and its commits past merged PR #7's head stay: ${git(wt, "rev-parse", "--short", "HEAD")}`,
  })
  expect(existsSync(wt)).toBe(true)
})

test("a working roster row naming the branch still holds a worktree whose PR is open or reads as none (no PR, or GitHub unreadable)", async () => {
  for (const state of ["OPEN", null] as const) {
    const { deps, main } = machine()
    const { wt } = dirtyWorktree(main)
    const row = { branch: "PG-1-thing", name: "abc123-worker", status: "working" }
    const words = ["--worktree", wt, "--discard"]
    expect(await heldRun(deps, words, state, row)).toEqual({
      code: 1,
      out: [`playground: ${wt} is held by abc123-worker, which the roster lists as working`],
    })
    expect(existsSync(wt)).toBe(true)
  }
})

test("a review clone at a merged PR's head stays held by a live row that names it by another PR, its next one, which is open", async () => {
  const { deps, main } = machine()
  dirtyWorktree(main)
  const clone = join(main, ".claude", "worktrees", "review-8")
  git(main, "worktree", "add", "-q", "--detach", clone)
  const row = { name: "abc123-reviewer", pr: "https://github.com/o/r/pull/8", status: "working" }
  const words = ["--worktree", clone, "--discard", "--pr", "https://github.com/o/r/pull/7"]
  expect(await heldRun(deps, words, "MERGED", row, 7)).toEqual({
    code: 1,
    out: [`playground: ${clone} is held by abc123-reviewer, which the roster lists as working`],
  })
  expect(existsSync(clone)).toBe(true)
})

test("a worktree's PR state counts only when exactly one PR answers, as a branch used twice finds two, that PR is the worktree's own by branch or head, and its head is HEAD or an ancestor of it", () => {
  const holds = (sha: string) => sha === "head" || sha === "older"
  const at = { branch: "PG-1-thing", head: "head" }
  const pr = (headRefOid: string, state: PrState, headRefName = "PG-1-thing") => ({
    headRefName,
    headRefOid,
    number: 1,
    state,
  })
  expect(prStateOf([pr("head", "MERGED")], at, holds)).toEqual({
    head: "head",
    number: 1,
    state: "MERGED",
  })
  expect(prStateOf([pr("older", "CLOSED")], at, holds)).toEqual({
    head: "older",
    number: 1,
    state: "CLOSED",
  })
  expect(prStateOf([pr("other", "MERGED")], at, holds)).toBeNull()
  expect(prStateOf([pr("head", "MERGED"), pr("older", "OPEN")], at, holds)).toBeNull()
  // #1962: gh's clean answer of no PR reads as none, apart from a read gh could not make
  expect(prStateOf([], at, holds)).toBe("none")
  expect(prStateOf(null, at, holds)).toBeNull()
  // a stacked child: its parent's PR is another branch's, whose head is only an ancestor of HEAD
  expect(prStateOf([pr("older", "MERGED", "PG-0-parent")], at, holds)).toBeNull()
  // a review clone on its own review-<n> branch, or detached, counts by the exact head alone
  expect(prStateOf([pr("head", "MERGED", "PG-0-parent")], at, holds)).toEqual({
    head: "head",
    number: 1,
    state: "MERGED",
  })
  const detached = { branch: null, head: "head" }
  expect(prStateOf([pr("head", "MERGED")], detached, holds)).toEqual({
    head: "head",
    number: 1,
    state: "MERGED",
  })
  expect(prStateOf([pr("older", "MERGED")], detached, holds)).toBeNull()
})

// PG-1066: a folder outside the worktrees folder takes plain playground rm, which no --discard gate guards
test("a session's --worktree --discard on a folder outside the worktrees folder is refused naming playground rm", async () => {
  const { deps, home } = machine()
  const outside = join(home, "scratch", "old-site")
  mkdirSync(outside, { recursive: true })
  writeFileSync(join(outside, "index.html"), "x")
  const worktrees = join(deps.main, ".claude", "worktrees")
  const said: string[] = []
  const error = console.error
  console.error = (line: string) => void said.push(line)
  try {
    expect(await runRm(["--worktree", outside, "--discard"], deps)).toBe(1)
  } finally {
    console.error = error
  }
  expect(said).toEqual([
    `playground: --worktree takes a folder in ${worktrees} or a git worktree in another repo's .claude/worktrees, not ${outside}: playground rm ${outside} moves a folder outside it to the trash, with no --worktree or --discard, up to 5,000 files or 2 GB; leave a bigger tree in place for your lead's cleanup`,
  ])
  expect(existsSync(outside)).toBe(true)
  expect(await runRm([outside], deps)).toBe(0)
  expect(existsSync(outside)).toBe(false)
})

// Another repo in HOME, on main with a remote whose origin/HEAD names main, and its worktree <repo>/.claude/worktrees/app-1 on APP-1-thing, holding one commit not pushed and an installed node_modules.
const otherRepo = (root: string, home: string) => {
  const repo = join(home, "code", "app")
  git(root, "init", "--bare", "-q", join(root, "app.git"))
  mkdirSync(repo, { recursive: true })
  git(repo, "init", "-q", "-b", "main")
  file(join(repo, ".gitignore"), "node_modules\n")
  git(repo, "add", ".")
  git(repo, "commit", "-qm", "init")
  git(repo, "remote", "add", "origin", join(root, "app.git"))
  git(repo, "push", "-q", "origin", "main")
  git(repo, "remote", "set-head", "origin", "main")
  const worktrees = join(repo, ".claude", "worktrees")
  const wt = join(worktrees, "app-1")
  git(repo, "worktree", "add", "-q", "-b", "APP-1-thing", wt)
  file(join(wt, "work.txt"))
  git(wt, "add", ".")
  git(wt, "commit", "-qm", "work")
  file(join(wt, "node_modules", "dep", "index.js"))
  return { repo, worktrees, wt }
}

// runRm's exit, and what it printed to stderr.
const rmSaid = async (words: string[], deps: RmDeps) => {
  const said: string[] = []
  const error = console.error
  console.error = (line: string) => void said.push(line)
  try {
    return { code: await runRm(words, deps), said }
  } finally {
    console.error = error
  }
}

// PG-1942: a finished worktree of another repo, in that repo's own .claude/worktrees, goes as one of this checkout's does
test("--worktree takes another repo's worktree once its PR merged or closed: git in its own repo forgets it, its node_modules stays out of the trash, and --restore brings it back there", async () => {
  for (const state of ["MERGED", "CLOSED"] as const) {
    const { deps, home, root } = machine()
    const { repo, wt } = otherRepo(root, home)
    const head = git(wt, "rev-parse", "HEAD")
    const asked: string[] = []
    const finished: RmDeps = {
      ...deps,
      merged: (sha, at) => (asked.push(`merged ${at}`), state === "MERGED" && sha === head),
      prState: async (path) => (asked.push(`pr ${path}`), { head, number: 7, state }),
    }
    expect(await rmSaid([wt], finished)).toEqual({
      code: 1,
      said: [`playground: ${wt} is a worktree: playground rm --worktree removes it`],
    })
    const words = state === "MERGED" ? ["--worktree", wt] : ["--worktree", wt, "--discard"]
    expect(await rmSaid(words, finished)).toEqual({ code: 0, said: [] })
    expect(existsSync(wt)).toBe(false)
    expect(asked.every((line) => line.endsWith(` ${wt}`))).toBe(true)
    expect(asked).toContain(`pr ${wt}`)
    expect(git(repo, "worktree", "list", "--porcelain")).not.toContain(wt)
    const [entry] = listTrash(join(deps.data, "trash"))
    expect(entry).toMatchObject({ path: wt, stripped: 1 })
    expect(existsSync(join(deps.data, "trash", entry!.id, "app-1", "work.txt"))).toBe(true)
    expect(existsSync(join(deps.data, "trash", entry!.id, "app-1", "node_modules"))).toBe(false)
    expect(await runRm(["--restore", entry!.id], finished)).toBe(0)
    expect(git(wt, "symbolic-ref", "--short", "HEAD")).toBe("APP-1-thing")
    expect(git(wt, "rev-parse", "HEAD")).toBe(head)
    expect(git(repo, "worktree", "list", "--porcelain")).toContain(`worktree ${wt}\n`)
  }
})

test("--worktree refuses another repo's worktree with unpushed commits and an open PR as it refuses one here, and --discard takes it with no decision, its commit kept in a bundle", async () => {
  const { deps: base, home, root } = machine()
  const { repo, wt } = otherRepo(root, home)
  const head = git(wt, "rev-parse", "HEAD")
  const deps: RmDeps = { ...base, prState: async () => ({ head, number: 7, state: "OPEN" }) }
  const discard = `playground rm --worktree ${wt} --discard removes it anyway, its commits no remote holds kept first in a git bundle beside it in the trash`
  expect(await rmSaid(["--worktree", wt], deps)).toEqual({
    code: 1,
    said: [
      `playground: ${wt}'s HEAD holds work not landed on origin/main or on any remote branch (fetch origin if it merged or was pushed since): ${discard}`,
    ],
  })
  expect(existsSync(wt)).toBe(true)
  expect(await rmSaid(["--worktree", wt, "--discard"], deps)).toEqual({ code: 0, said: [] })
  expect(existsSync(wt)).toBe(false)
  expect(git(repo, "worktree", "list", "--porcelain")).not.toContain(wt)
  const [entry] = listTrash(join(deps.data, "trash"))
  git(repo, "branch", "-D", "APP-1-thing")
  git(repo, "fetch", "-q", entry!.bundle!, "HEAD:refs/heads/APP-1-thing")
  expect(git(repo, "rev-parse", "APP-1-thing")).toBe(head)
})

// The folder playground rm archives another repo's worktree in, by its repo, its folder and its HEAD, and the commit each of its patches' From line names.
const archiveOf = (data: string, repo: string, wt: string) =>
  join(
    data,
    "scratchpad",
    "archive",
    basename(repo),
    `${basename(wt)}-${git(wt, "rev-parse", "HEAD").slice(0, 7)}`,
  )
const patchesIn = (dir: string) =>
  readdirSync(dir).map((f) => /^From ([0-9a-f]+) /.exec(readFileSync(join(dir, f), "utf8"))?.[1])
const unlanded = (wt: string) => git(wt, "rev-list", "HEAD", "--not", "--remotes").split("\n")
// rm's PR read of otherRepo's worktree as rmDeps reads it, through prStateOf, from what gh lists: [] for no PR, null for a list gh could not read
const readPrs =
  (prs: Parameters<typeof prStateOf>[0]): RmDeps["prState"] =>
  async () =>
    prStateOf(prs, { branch: "APP-1-thing", head: "h" }, () => false)

// #1962
test("--worktree archives another repo's worktree with no PR and commits no remote holds under the data folder's scratchpad/archive, then takes it with no decision", async () => {
  const { deps, home, root } = machine()
  const { repo, wt } = otherRepo(root, home)
  file(join(wt, "more.txt"))
  git(wt, "add", ".")
  git(wt, "commit", "-qm", "more")
  const shas = unlanded(wt)
  expect(shas).toHaveLength(2)
  const archive = archiveOf(deps.data, repo, wt)
  const session = { ...deps, prState: readPrs([]) }
  expect(await rmSaid(["--worktree", wt], session)).toEqual({ code: 0, said: [] })
  expect(existsSync(wt)).toBe(false)
  expect(patchesIn(archive).sort()).toEqual([...shas].sort())
  expect(git(repo, "worktree", "list", "--porcelain")).not.toContain(wt)
  expect(listTrash(join(deps.data, "trash"))).toMatchObject([{ path: wt }])
})

// #1962
test("--worktree keeps another repo's worktree with no PR whose archive holds patches other than its commits no remote holds, naming why, and writes over no archive already there", async () => {
  const { deps, home, root } = machine()
  const { repo, wt } = otherRepo(root, home)
  const archive = archiveOf(deps.data, repo, wt)
  mkdirSync(archive, { recursive: true })
  writeFileSync(
    join(archive, "0001-other.patch"),
    `From ${"0".repeat(40)} Mon Sep 17 00:00:00 2001\n`,
  )
  const discard = `playground rm --worktree ${wt} --discard removes it anyway, its commits no remote holds kept first in a git bundle beside it in the trash`
  expect(await rmSaid(["--worktree", wt], { ...deps, prState: readPrs([]) })).toEqual({
    code: 1,
    said: [
      `playground: ${wt}'s HEAD holds work not landed on origin/main or on any remote branch (fetch origin if it merged or was pushed since), and its archive at ${archive} holds 1 patch, 0 of its 1 commit no remote holds: ${discard}`,
    ],
  })
  expect(existsSync(wt)).toBe(true)
  expect(readdirSync(archive)).toEqual(["0001-other.patch"])
})

// #2139: a remote that cannot be read keeps another repo's no-PR worktree, with no patch written, since an archive past no tip covers its whole history; once it reads, only the commits no remote holds are archived
test("--worktree keeps another repo's worktree with no PR while its remote cannot be read, writing no archive, and archives only its commits no remote holds once it reads", async () => {
  const { deps, home, root } = machine()
  const { repo, wt } = otherRepo(root, home)
  const session = { ...deps, prState: readPrs([]) }
  const discard = `playground rm --worktree ${wt} --discard removes it anyway, its commits no remote holds kept first in a git bundle beside it in the trash`
  git(repo, "remote", "set-url", "origin", join(root, "gone.git"))
  expect(await rmSaid(["--worktree", wt], session)).toEqual({
    code: 1,
    said: [
      `playground: ${wt}'s HEAD holds work not landed on origin/main or on any remote branch (fetch origin if it merged or was pushed since), and its remote origin could not be read, so its work stays until it answers: ${discard}`,
    ],
  })
  expect(existsSync(wt)).toBe(true)
  expect(existsSync(join(deps.data, "scratchpad"))).toBe(false)
  git(repo, "remote", "set-url", "origin", join(root, "app.git"))
  const shas = unlanded(wt)
  expect(shas).toHaveLength(1)
  const archive = archiveOf(deps.data, repo, wt)
  expect(await rmSaid(["--worktree", wt], session)).toEqual({ code: 0, said: [] })
  expect(existsSync(wt)).toBe(false)
  expect(patchesIn(archive)).toEqual(shas)
})

// #2139's control: --discard with a remote that cannot be read still bundles every commit and removes the tree, writing no archive
test("--worktree --discard takes another repo's worktree with no PR while its remote cannot be read, its commits in a bundle and no archive written", async () => {
  const { deps, home, root } = machine()
  const { repo, wt } = otherRepo(root, home)
  const head = git(wt, "rev-parse", "HEAD")
  git(repo, "remote", "set-url", "origin", join(root, "gone.git"))
  expect(await rmSaid(["--worktree", wt, "--discard"], { ...deps, prState: readPrs([]) })).toEqual({
    code: 0,
    said: [],
  })
  expect(existsSync(wt)).toBe(false)
  expect(existsSync(join(deps.data, "scratchpad"))).toBe(false)
  const [entry] = listTrash(join(deps.data, "trash"))
  git(repo, "branch", "-D", "APP-1-thing")
  git(repo, "fetch", "-q", entry!.bundle!, "HEAD:refs/heads/APP-1-thing")
  expect(git(repo, "rev-parse", "APP-1-thing")).toBe(head)
})

// #1962: the archive route runs only on gh's clean answer of no PR; a read gh could not make, two PRs answering, or one that is not the worktree's own keep canary's refusal
test.each([
  ["a PR read gh could not make", null],
  [
    "two PRs answering",
    [
      { headRefName: "APP-1-thing", headRefOid: "a", number: 1, state: "OPEN" as const },
      { headRefName: "APP-1-thing", headRefOid: "b", number: 2, state: "CLOSED" as const },
    ],
  ],
  [
    "a PR whose head is not HEAD or an ancestor of it",
    [{ headRefName: "APP-1-thing", headRefOid: "f".repeat(40), number: 1, state: "OPEN" as const }],
  ],
])(
  "--worktree refuses another repo's worktree with commits no remote holds on %s, writing no archive",
  async (_, prs) => {
    const { deps, home, root } = machine()
    const { wt } = otherRepo(root, home)
    const discard = `playground rm --worktree ${wt} --discard removes it anyway, its commits no remote holds kept first in a git bundle beside it in the trash`
    expect(await rmSaid(["--worktree", wt], { ...deps, prState: readPrs(prs) })).toEqual({
      code: 1,
      said: [
        `playground: ${wt}'s HEAD holds work not landed on origin/main or on any remote branch (fetch origin if it merged or was pushed since): ${discard}`,
      ],
    })
    expect(existsSync(wt)).toBe(true)
    expect(existsSync(join(deps.data, "scratchpad"))).toBe(false)
  },
)

// #1962's controls: a live session's tree and one holding an untracked file, in another repo, and this checkout's own worktree, each with a commit no remote holds and no PR, are refused as before, with no archive written
test("--worktree refuses, with no PR and a commit no remote holds, a live session's tree and an untracked file's in another repo, and this checkout's own worktree, writing no archive", async () => {
  const { deps: base, home, main, root } = machine()
  const deps = { ...base, prState: readPrs([]) }
  const { repo, wt } = otherRepo(root, home)
  const held = { command: "zsh", cwd: wt, pid: 7, sockets: [] }
  expect(await rmSaid(["--worktree", wt], { ...deps, procs: () => [held] })).toEqual({
    code: 1,
    said: [`playground: ${wt} is held by pid 7 (zsh) working in ${wt}`],
  })
  file(join(wt, "wip.ts"))
  expect((await rmSaid(["--worktree", wt], deps)).said[0]).toStartWith(
    `playground: ${wt} holds 1 uncommitted change (wip.ts): `,
  )
  expect(existsSync(wt)).toBe(true)
  git(main, "init", "-q", "-b", "canary")
  file(join(main, "README.md"))
  git(main, "add", ".")
  git(main, "commit", "-qm", "init")
  const own = join(main, ".claude", "worktrees", "pg-1")
  git(main, "worktree", "add", "-q", "-b", "PG-1-thing", own)
  file(join(own, "work.txt"))
  git(own, "add", ".")
  git(own, "commit", "-qm", "work")
  expect((await rmSaid(["--worktree", own], deps)).said[0]).toStartWith(
    `playground: ${own}'s HEAD holds work not landed on origin/canary or on any remote branch (fetch origin if it merged or was pushed since): `,
  )
  expect(existsSync(own)).toBe(true)
  expect(existsSync(join(deps.data, "scratchpad"))).toBe(false)
  expect(repo).not.toBe(main)
})

// runRm's exit, and what it printed to stdout and to stderr.
const rmTold = async (words: string[], deps: RmDeps) => {
  const err: string[] = []
  const out: string[] = []
  const { error, log } = console
  console.error = (line: string) => void err.push(line)
  console.log = (line: string) => void out.push(line)
  try {
    return { code: await runRm(words, deps), err, out }
  } finally {
    console.error = error
    console.log = log
  }
}

// #2122: another repo's worktree is measured against its own default branch, and goes once a remote branch holds every commit HEAD holds, where this checkout's measure origin/canary alone
const openPr =
  (wt: string): RmDeps["prState"] =>
  async () => ({ head: git(wt, "rev-parse", "HEAD"), number: 7, state: "OPEN" })
// otherRepo's work squash-merged into its main and pushed, so the worktree's commit is on no remote while its files read the same on origin/main
const landOnMain = (repo: string) => {
  file(join(repo, "work.txt"))
  git(repo, "add", "work.txt")
  git(repo, "commit", "-qm", "work (#7)")
  git(repo, "push", "-q", "origin", "main")
}
// the lines of rm's own, not its move line
const notes = (out: string[]) => out.filter((line) => line.startsWith("playground: "))

test.each([
  [
    "whose HEAD sits on origin/main",
    (_repo: string, wt: string) => git(wt, "reset", "-q", "--hard", "origin/main"),
  ],
  ["whose commit's work landed on origin/main by a squash", (repo: string) => landOnMain(repo)],
])(
  "--worktree takes a clean worktree of another repo with no canary %s, with an open PR",
  async (_, setup) => {
    const { deps, home, root } = machine()
    const { repo, wt } = otherRepo(root, home)
    setup(repo, wt)
    const told = await rmTold(["--worktree", wt], { ...deps, prState: openPr(wt) })
    expect({ ...told, out: notes(told.out) }).toEqual({ code: 0, err: [], out: [] })
    expect(existsSync(wt)).toBe(false)
    expect(git(repo, "worktree", "list", "--porcelain")).not.toContain(wt)
  },
)

test("--worktree reads another repo's default branch from gh when origin/HEAD names none, and names the unread default branch when gh cannot either", async () => {
  const { deps, home, root } = machine()
  const { repo, wt } = otherRepo(root, home)
  git(repo, "remote", "set-head", "origin", "-d")
  landOnMain(repo)
  const asked: string[] = []
  const unread: RmDeps = {
    ...deps,
    defaultBranch: (at) => (asked.push(at), null),
    prState: openPr(wt),
  }
  const discard = `playground rm --worktree ${wt} --discard removes it anyway, its commits no remote holds kept first in a git bundle beside it in the trash`
  expect(await rmTold(["--worktree", wt], unread)).toEqual({
    code: 1,
    err: [
      `playground: ${wt}'s HEAD holds work not landed on its repo's default branch, which neither origin/HEAD nor gh names, or on any remote branch (fetch origin if it merged or was pushed since): ${discard}`,
    ],
    out: [],
  })
  expect(asked).toEqual([wt])
  const read: RmDeps = { ...deps, defaultBranch: () => "main", prState: openPr(wt) }
  const told = await rmTold(["--worktree", wt], read)
  expect({ ...told, out: notes(told.out) }).toEqual({ code: 0, err: [], out: [] })
  expect(existsSync(wt)).toBe(false)
})

test.each([
  ["an open PR", openPr],
  ["no PR", () => readPrs([])],
])(
  "--worktree takes another repo's worktree whose commits are all on a remote branch, with %s, and names that branch",
  async (_, pr) => {
    const { deps, home, root } = machine()
    const { repo, wt } = otherRepo(root, home)
    git(wt, "push", "-q", "origin", "APP-1-thing")
    const told = await rmTold(["--worktree", wt], { ...deps, prState: pr(wt) })
    expect({ ...told, out: notes(told.out) }).toEqual({
      code: 0,
      err: [],
      out: [
        `playground: ${wt}'s commits are all on origin/APP-1-thing, which the remote still holds, so no work is lost`,
      ],
    })
    expect(existsSync(wt)).toBe(false)
    expect(git(repo, "worktree", "list", "--porcelain")).not.toContain(wt)
    expect(existsSync(join(deps.data, "scratchpad"))).toBe(false)
  },
)

// a remote-tracking ref is the remote's branch as last fetched, so each is read again from the remote itself: a branch deleted or moved there since, a remote that cannot be read, and a commit past the pushed branch keep the refusal
test.each([
  [
    "a branch the remote has deleted since",
    (root: string) => git(root, "--git-dir", join(root, "app.git"), "branch", "-D", "APP-1-thing"),
  ],
  [
    "a branch the remote has moved off HEAD since",
    (root: string) =>
      git(root, "--git-dir", join(root, "app.git"), "update-ref", "refs/heads/APP-1-thing", "main"),
  ],
  [
    "a remote that cannot be read",
    (root: string, repo: string) =>
      git(repo, "remote", "set-url", "origin", join(root, "gone.git")),
  ],
  [
    "a commit past the pushed branch",
    (_root: string, _repo: string, wt: string) => {
      file(join(wt, "more.txt"))
      git(wt, "add", ".")
      git(wt, "commit", "-qm", "more")
    },
  ],
])(
  "--worktree refuses another repo's worktree whose remote-tracking branch holds its commits on %s, with an open PR",
  async (_, after) => {
    const { deps, home, root } = machine()
    const { repo, wt } = otherRepo(root, home)
    git(wt, "push", "-q", "origin", "APP-1-thing")
    after(root, repo, wt)
    expect(git(wt, "rev-parse", "--verify", "-q", "refs/remotes/origin/APP-1-thing")).not.toBe("")
    const discard = `playground rm --worktree ${wt} --discard removes it anyway, its commits no remote holds kept first in a git bundle beside it in the trash`
    expect(await rmTold(["--worktree", wt], { ...deps, prState: openPr(wt) })).toEqual({
      code: 1,
      err: [
        `playground: ${wt}'s HEAD holds work not landed on origin/main or on any remote branch (fetch origin if it merged or was pushed since): ${discard}`,
      ],
      out: [],
    })
    expect(existsSync(wt)).toBe(true)
  },
)

// #2344: this checkout's own worktree, its commit pushed as PG-1-thing to a bare origin and not on canary, as a stood-down PR's tree sits
const ownPushed = () => {
  const m = machine()
  git(m.root, "init", "--bare", "-q", join(m.root, "remote.git"))
  git(m.main, "init", "-q", "-b", "canary")
  file(join(m.main, "README.md"))
  git(m.main, "add", ".")
  git(m.main, "commit", "-qm", "init")
  git(m.main, "remote", "add", "origin", join(m.root, "remote.git"))
  git(m.main, "push", "-q", "origin", "canary")
  const own = join(m.main, ".claude", "worktrees", "pg-1")
  git(m.main, "worktree", "add", "-q", "-b", "PG-1-thing", own)
  file(join(own, "work.txt"))
  git(own, "add", ".")
  git(own, "commit", "-qm", "work")
  git(own, "push", "-q", "origin", "PG-1-thing")
  const discard = `playground rm --worktree ${own} --discard removes it anyway, its commits no remote holds kept first in a git bundle beside it in the trash`
  return { ...m, discard, own }
}

// #2498: #2484's review clone stayed "held by gkbbch-worker" after #2484 merged, since the worker's row still named it as its pr; a row's hold by a PR that reads merged no longer counts, as SESSIONS.md's End says, while one on an open PR still keeps the clone
test("--worktree takes a review clone a live row holds only by a PR that has merged, and keeps it while that PR is open", async () => {
  const { deps, main, own } = ownPushed()
  const clone = join(main, ".claude", "worktrees", "review-2484")
  git(main, "worktree", "add", "-q", "--detach", clone, git(own, "rev-parse", "HEAD"))
  writeFileSync(
    join(deps.data, "roster.json"),
    JSON.stringify({
      agents: [
        {
          branch: "PG-2475-other",
          name: "gkbbch-worker",
          pr: "https://github.com/o/r/pull/2484",
          status: "working",
        },
      ],
    }),
  )
  const held = {
    code: 1,
    err: [`playground: ${clone} is held by gkbbch-worker, which the roster lists as working`],
    out: [],
  }
  const asked: string[] = []
  const open: RmDeps = { ...deps, mergedHead: (_, u) => (asked.push(u), null) }
  expect(await rmTold(["--worktree", clone], open)).toEqual(held)
  expect(asked).toEqual(["https://github.com/o/r/pull/2484"])
  const absent: RmDeps = { ...deps, mergedHead: () => "0".repeat(40) }
  expect(await rmTold(["--worktree", clone], absent)).toEqual(held)
  const head = git(clone, "rev-parse", "HEAD")
  const merged: RmDeps = {
    ...deps,
    mergedHead: (_, u) => (u === "https://github.com/o/r/pull/2484" ? head : null),
  }
  const told = await rmTold(["--worktree", clone], merged)
  expect(told.err).toEqual([])
  expect(told.code).toBe(0)
  expect(existsSync(clone)).toBe(false)
})

// PG-2498: a merged PR's number still holds while HEAD has a commit past that PR's head, so --discard cannot take it, and a row naming the PR alongside its branch never asks gh
test("--worktree --discard keeps a clone with a commit past a merged PR's head, which the row holds by that PR alone", async () => {
  const { deps, main, own } = ownPushed()
  const clone = join(main, ".claude", "worktrees", "review-7")
  const merged = git(own, "rev-parse", "HEAD")
  git(main, "worktree", "add", "-q", "-b", "PG-7-review", clone, merged)
  writeFileSync(join(clone, "past.txt"), "past\n")
  git(clone, "add", "past.txt")
  git(clone, "commit", "-qm", "past the merged head")
  const row = { name: "abc123-worker", pr: "https://github.com/o/r/pull/7", status: "working" }
  writeFileSync(
    join(deps.data, "roster.json"),
    JSON.stringify({ agents: [{ ...row, branch: "PG-9-other" }] }),
  )
  const asked: string[] = []
  const past: RmDeps = { ...deps, mergedHead: (_, u) => (asked.push(u), merged) }
  expect(await rmTold(["--worktree", clone, "--discard"], past)).toEqual({
    code: 1,
    err: [`playground: ${clone} is held by abc123-worker, which the roster lists as working`],
    out: [],
  })
  expect(asked).toEqual(["https://github.com/o/r/pull/7"])
  expect(existsSync(join(clone, "past.txt"))).toBe(true)
  writeFileSync(
    join(deps.data, "roster.json"),
    JSON.stringify({ agents: [{ ...row, branch: "PG-7-review" }] }),
  )
  asked.length = 0
  expect((await rmTold(["--worktree", clone, "--discard"], past)).code).toBe(1)
  expect(asked).toEqual([])
})

test.each([
  ["an open PR", openPr],
  ["no PR", () => readPrs([])],
])(
  "--worktree takes this checkout's own worktree whose commits are all on an origin branch other than canary, with %s, and names that branch",
  async (_, pr) => {
    const { deps, main, own } = ownPushed()
    const told = await rmTold(["--worktree", own], { ...deps, prState: pr(own) })
    expect({ ...told, out: notes(told.out) }).toEqual({
      code: 0,
      err: [],
      out: [
        `playground: ${own}'s commits are all on origin/PG-1-thing, which the remote still holds, so no work is lost`,
      ],
    })
    expect(existsSync(own)).toBe(false)
    expect(git(main, "worktree", "list", "--porcelain")).not.toContain(own)
    expect(existsSync(join(deps.data, "scratchpad"))).toBe(false)
  },
)

test.each([
  [
    "its branch deleted on origin since, its remote-tracking ref still here",
    (root: string) =>
      git(root, "--git-dir", join(root, "remote.git"), "update-ref", "-d", "refs/heads/PG-1-thing"),
  ],
  [
    "a commit past the pushed branch",
    (_root: string, own: string) => {
      file(join(own, "more.txt"))
      git(own, "add", ".")
      git(own, "commit", "-qm", "more")
    },
  ],
])(
  "--worktree refuses this checkout's own worktree whose HEAD no origin branch holds: %s",
  async (_, after) => {
    const { deps, discard, own, root } = ownPushed()
    after(root, own)
    expect(git(own, "rev-parse", "--verify", "-q", "refs/remotes/origin/PG-1-thing")).not.toBe("")
    expect(await rmTold(["--worktree", own], { ...deps, prState: openPr(own) })).toEqual({
      code: 1,
      err: [
        `playground: ${own}'s HEAD holds work not landed on origin/canary or on any remote branch (fetch origin if it merged or was pushed since): ${discard}`,
      ],
      out: [],
    })
    expect(existsSync(own)).toBe(true)
  },
)

// #2344: the live Dashboard's checkout sits clean at origin/main's head, which an origin branch holds, so only its branch keeps it, with the Dashboard stopped (no process, no roster row) too
test("--worktree refuses the worktree on the live.branch branch, with the Dashboard stopped and under --discard, and refuses every worktree while the setting cannot be read, auto-end's removePath included", async () => {
  const { deps, main, root } = ownPushed()
  const desk = join(main, ".claude", "worktrees", "desk")
  git(main, "worktree", "add", "-q", "-b", "live/dashboard", desk, "canary")
  git(desk, "push", "-q", "origin", "live/dashboard")
  const refusal = `playground: ${desk} is the live Dashboard's checkout (branch live/dashboard); it moves only by .agents/dashboard/live.md's roll`
  for (const words of [
    ["--worktree", desk],
    ["--worktree", desk, "--discard"],
  ])
    expect(await rmTold(words, { ...deps, prState: async () => "none" })).toEqual({
      code: 1,
      err: [refusal],
      out: [],
    })
  expect(existsSync(desk)).toBe(true)
  const broken: RmDeps = {
    ...deps,
    liveBranch: () => {
      throw new Error("policy.json does not parse")
    },
  }
  expect(await rmTold(["--worktree", join(main, ".claude", "worktrees", "pg-1")], broken)).toEqual({
    code: 1,
    err: [
      "playground: the live.branch setting cannot be read (policy.json does not parse), so no worktree is removed",
    ],
    out: [],
  })
  const pg1 = join(main, ".claude", "worktrees", "pg-1")
  expect(
    await removePath(
      { discard: true, path: pg1, reason: "ended", worktree: true },
      "abc123-worker",
      broken,
      () => {},
    ),
  ).toEqual({
    line: "the live.branch setting cannot be read (policy.json does not parse), so no worktree is removed",
    ok: false,
  })
  expect(existsSync(pg1)).toBe(true)
  expect(root).not.toBe(main)
})

// #2344: a worker on two open PRs names the second only in prs, and its tree is named by its issue, not that PR's number, so the row holds it by the worktree's own PR as GitHub names it by its branch; the second PR's reviewer holds it the same way
test.each([
  [
    "a worker whose prs lists it beside its first PR",
    {
      branch: "PG-2307-other",
      name: "abc123-worker",
      pr: "https://github.com/o/r/pull/2408",
      prs: ["https://github.com/o/r/pull/2408", "https://github.com/o/r/pull/2435"],
      status: "working",
    },
  ],
  [
    "that PR's reviewer",
    { name: "def456-reviewer", pr: "https://github.com/o/r/pull/2435", status: "working" },
  ],
])(
  "--worktree refuses this checkout's own worktree an origin branch holds while its own open PR is on a live row: %s",
  async (_, agent) => {
    const { deps, own } = ownPushed()
    writeFileSync(join(deps.data, "roster.json"), JSON.stringify({ agents: [agent] }))
    const second: RmDeps["prState"] = async () => ({
      head: git(own, "rev-parse", "HEAD"),
      number: 2435,
      state: "OPEN",
    })
    expect(await rmTold(["--worktree", own], { ...deps, prState: second })).toEqual({
      code: 1,
      err: [`playground: ${own} is held by ${agent.name}, which the roster lists as working`],
      out: [],
    })
    expect(existsSync(own)).toBe(true)
    const told = await rmTold(["--worktree", own], { ...deps, prState: async () => "none" })
    expect(told.code).toBe(0)
    expect(existsSync(own)).toBe(false)
  },
)

test("--worktree still refuses this checkout's own worktree an origin branch holds while a process works in it", async () => {
  const { deps, own } = ownPushed()
  const held = { command: "bun run dev", cwd: own, pid: 9, sockets: [] }
  expect(
    await rmTold(["--worktree", own], { ...deps, procs: () => [held], prState: openPr(own) }),
  ).toEqual({
    code: 1,
    err: [`playground: ${own} is held by pid 9 (bun run dev) working in ${own}`],
    out: [],
  })
  expect(existsSync(own)).toBe(true)
})

test("--worktree still refuses this checkout's own worktree an origin branch holds while it has uncommitted work, or while a live roster row names its branch", async () => {
  const { deps, discard, own } = ownPushed()
  file(join(own, "wip.ts"))
  expect(await rmTold(["--worktree", own], { ...deps, prState: openPr(own) })).toEqual({
    code: 1,
    err: [`playground: ${own} holds 1 uncommitted change (wip.ts): ${discard}`],
    out: [],
  })
  git(own, "add", ".")
  git(own, "commit", "-qm", "wip")
  git(own, "push", "-q", "origin", "PG-1-thing")
  writeFileSync(
    join(deps.data, "roster.json"),
    JSON.stringify({
      agents: [{ branch: "PG-1-thing", name: "abc123-worker", status: "working" }],
    }),
  )
  expect(await rmTold(["--worktree", own], { ...deps, prState: async () => null })).toEqual({
    code: 1,
    err: [`playground: ${own} is held by abc123-worker, which the roster lists as working`],
    out: [],
  })
  expect(existsSync(own)).toBe(true)
})

// #2132: the live-row lift measures another repo's clean detached tree against that repo's own default branch, as the landed check does; each case runs under --discard, so only the row's hold refuses
test.each([
  ["frees one at a commit origin/main holds", "origin/main", 0],
  ["keeps one at a commit origin/main lacks", "APP-1-thing", 1],
])("runRm --worktree, under a live row, %s in another repo with no canary", async (_, at, code) => {
  const { deps, home, root } = machine()
  const { repo, wt } = otherRepo(root, home)
  git(wt, "checkout", "-q", "--detach", at)
  withRow(deps, "app-1")
  expect(await runRm(["--worktree", wt, "--discard"], deps)).toBe(code)
  expect(existsSync(wt)).toBe(code !== 0)
  if (code === 0) expect(git(repo, "worktree", "list")).not.toContain("app-1")
})

test("--worktree refuses, in another repo, a folder in its .claude/worktrees git does not list as its worktree, the repo's own checkout, and its worktree outside .claude/worktrees", async () => {
  const { deps, home, root } = machine()
  const { repo, worktrees, wt } = otherRepo(root, home)
  const plain = join(worktrees, "plain")
  file(join(plain, "index.html"))
  const clone = join(worktrees, "clone")
  mkdirSync(clone)
  git(clone, "init", "-q", "-b", "main")
  const forged = join(worktrees, "forged")
  mkdirSync(forged)
  writeFileSync(join(forged, ".git"), readFileSync(join(wt, ".git")))
  const third = join(home, "code", "third")
  mkdirSync(third, { recursive: true })
  git(third, "init", "-q", "-b", "main")
  file(join(third, "README.md"))
  git(third, "add", ".")
  git(third, "commit", "-qm", "init")
  const stranger = join(worktrees, "stranger")
  git(third, "worktree", "add", "-q", "-b", "other", stranger)
  const outside = join(home, "code", "app-wt")
  git(repo, "worktree", "add", "-q", "-b", "APP-2-thing", outside)
  const session = {
    ...deps,
    merged: () => true,
    prState: async () => ({ head: "x", number: 7, state: "MERGED" as const }),
  }
  const ours = join(deps.main, ".claude", "worktrees")
  for (const path of [plain, clone, forged, stranger, repo, outside])
    for (const words of [
      ["--worktree", path],
      ["--worktree", path, "--discard"],
    ]) {
      expect(await rmSaid(words, session)).toEqual({
        code: 1,
        said: [
          `playground: --worktree takes a folder in ${ours} or a git worktree in another repo's .claude/worktrees, not ${path}: playground rm ${path} moves a folder outside it to the trash, with no --worktree or --discard, up to 5,000 files or 2 GB; leave a bigger tree in place for your lead's cleanup`,
        ],
      })
      expect(existsSync(path)).toBe(true)
    }
  expect(git(repo, "worktree", "list", "--porcelain")).toContain(`worktree ${outside}\n`)
})

// run-slot's clone lane copies <source>/node_modules from its caller's folder, so only its holder record names the source (PG-699)
test("runRm --worktree refuses a worktree a running clone reads from, naming the clone, and moves it once the record is gone", async () => {
  const { deps, main, root } = machine()
  git(root, "init", "--bare", "-q", join(root, "remote.git"))
  git(main, "init", "-q", "-b", "canary")
  writeFileSync(join(main, "README.md"), "x")
  git(main, "add", ".")
  git(main, "commit", "-qm", "init")
  git(main, "remote", "add", "origin", join(root, "remote.git"))
  git(main, "push", "-q", "origin", "canary")
  const wt = join(main, ".claude", "worktrees", "pg-1")
  git(main, "worktree", "add", "-q", "-b", "PG-1-thing", wt)
  git(wt, "push", "-q", "origin", "PG-1-thing")
  const into = join(main, ".claude", "worktrees", "pg-2")
  const reading = { destination: into, pid: 4242, source: wt, who: "k3m9px-worker" }
  const said: string[] = []
  const error = console.error
  console.error = (line: string) => void said.push(line)
  try {
    expect(await runRm(["--worktree", wt], { ...deps, clones: () => [reading] })).toBe(1)
  } finally {
    console.error = error
  }
  expect(said).toEqual([
    `playground: ${wt} is held by k3m9px-worker's node_modules clone (pid 4242) from ${wt} into ${into}`,
  ])
  expect(existsSync(wt)).toBe(true)
  expect(await runRm(["--worktree", wt], deps)).toBe(0)
  expect(existsSync(wt)).toBe(false)
})

// A main checkout with a remote and a worktree on PG-1-thing holding one commit of its own, which the deps call merged, so rm --worktree moves it, after a step of the caller's own and with its extra words; and the trash id of the move.
const trashedWorktree = async (
  before = (_wt: string, _main: string) => {},
  words: string[] = [],
) => {
  const { deps, main, root } = machine()
  git(root, "init", "--bare", "-q", join(root, "remote.git"))
  git(main, "init", "-q", "-b", "canary")
  writeFileSync(join(main, "README.md"), "x")
  git(main, "add", ".")
  git(main, "commit", "-qm", "init")
  git(main, "remote", "add", "origin", join(root, "remote.git"))
  git(main, "push", "-q", "origin", "canary")
  const wt = join(main, ".claude", "worktrees", "pg-1")
  git(main, "worktree", "add", "-q", "-b", "PG-1-thing", wt)
  writeFileSync(join(wt, "work.txt"), "work")
  git(wt, "add", ".")
  git(wt, "commit", "-qm", "work")
  const sha = git(wt, "rev-parse", "HEAD")
  const merged = { ...deps, merged: () => true }
  before(wt, main)
  expect(await runRm(["--worktree", wt, ...words], merged)).toBe(0)
  expect(existsSync(wt)).toBe(false)
  const [batch] = readdirSync(join(deps.data, "trash"))
  return { deps: merged, id: `${batch}/1`, main, sha, wt }
}

// What git reads in a restored worktree: its status, its branch, its HEAD, and whether the main checkout lists it.
const gitSees = (main: string, wt: string) => ({
  branch: git(wt, "symbolic-ref", "--short", "HEAD"),
  head: git(wt, "log", "-1", "--format=%H"),
  listed: git(main, "worktree", "list", "--porcelain").includes(`worktree ${wt}\n`),
  status: git(wt, "status", "--porcelain"),
})

test("runRm --restore brings a worktree back as git reads it: on its branch, at the commit it held, listed", async () => {
  const { deps, id, main, sha, wt } = await trashedWorktree()
  expect(await runRm(["--restore", id], deps)).toBe(0)
  expect(gitSees(main, wt)).toEqual({ branch: "PG-1-thing", head: sha, listed: true, status: "" })
})

test("runRm --restore recreates the worktree's branch at the commit it held when the branch has gone", async () => {
  const { deps, id, main, sha, wt } = await trashedWorktree()
  git(main, "branch", "-D", "PG-1-thing")
  expect(await runRm(["--restore", id], deps)).toBe(0)
  expect(gitSees(main, wt)).toEqual({ branch: "PG-1-thing", head: sha, listed: true, status: "" })
  expect(git(main, "rev-parse", "PG-1-thing")).toBe(sha)
})

test("runRm --restore refuses a worktree whose branch and commit have both gone, naming the commit, and moves nothing", async () => {
  const { deps, id, main, sha, wt } = await trashedWorktree()
  git(main, "branch", "-D", "PG-1-thing")
  git(main, "reflog", "expire", "--expire=now", "--all")
  git(main, "gc", "-q", "--prune=now")
  const said: string[] = []
  const error = console.error
  console.error = (line: string) => void said.push(line)
  try {
    expect(await runRm(["--restore", id], deps)).toBe(1)
  } finally {
    console.error = error
  }
  expect(said).toHaveLength(1)
  expect(said[0]).toContain(sha)
  expect(said[0]).toContain(`git -C ${main} branch PG-1-thing ${sha}`)
  expect(existsSync(wt)).toBe(false)
  expect(readdirSync(join(deps.data, "trash", id))).toEqual(["pg-1"])
})

test("runRm --restore leaves a worktree's git record as it is when it is still there, so a staged change stays staged", async () => {
  let saved = ""
  const { deps, id, main, wt } = await trashedWorktree(
    (wt, main) => {
      writeFileSync(join(wt, "staged.txt"), "s")
      git(wt, "add", "staged.txt")
      saved = join(main, "..", "pg-1-record")
      cpSync(join(main, ".git", "worktrees", "pg-1"), saved, { recursive: true })
    },
    ["--discard"],
  )
  cpSync(saved, join(main, ".git", "worktrees", "pg-1"), { recursive: true })
  expect(await runRm(["--restore", id], deps)).toBe(0)
  expect(git(wt, "diff", "--cached", "--name-only")).toBe("staged.txt")
})

test("runRm --restore refuses a worktree whose branch now points at another commit, naming both, and moves nothing", async () => {
  const { deps, id, main, sha, wt } = await trashedWorktree()
  git(main, "branch", "-f", "PG-1-thing", "canary")
  const moved = git(main, "rev-parse", "canary")
  const said: string[] = []
  const error = console.error
  console.error = (line: string) => void said.push(line)
  try {
    expect(await runRm(["--restore", id], deps)).toBe(1)
  } finally {
    console.error = error
  }
  expect(said).toHaveLength(1)
  expect(said[0]).toContain(sha)
  expect(said[0]).toContain(moved)
  expect(said[0]).not.toContain("branch -f")
  expect(existsSync(wt)).toBe(false)
  expect(git(main, "rev-parse", "PG-1-thing")).toBe(moved)
})

test("runRm --restore brings a detached worktree back detached, at the commit it held", async () => {
  const { deps, id, main, sha, wt } = await trashedWorktree((wt) =>
    git(wt, "checkout", "-q", "--detach"),
  )
  expect(await runRm(["--restore", id], deps)).toBe(0)
  expect(readFileSync(join(main, ".git", "worktrees", "pg-1", "HEAD"), "utf8")).toBe(`${sha}\n`)
  expect(git(wt, "rev-parse", "HEAD")).toBe(sha)
  expect(git(wt, "status", "--porcelain")).toBe("")
  expect(git(main, "worktree", "list", "--porcelain")).toContain(`worktree ${wt}\n`)
})

test("runRm --restore refuses a detached worktree whose commit has gone, naming the commit and no branch", async () => {
  const { deps, id, main, sha, wt } = await trashedWorktree((wt) =>
    git(wt, "checkout", "-q", "--detach"),
  )
  git(main, "branch", "-D", "PG-1-thing")
  git(main, "reflog", "expire", "--expire=now", "--all")
  git(main, "gc", "-q", "--prune=now")
  const said: string[] = []
  const error = console.error
  console.error = (line: string) => void said.push(line)
  try {
    expect(await runRm(["--restore", id], deps)).toBe(1)
  } finally {
    console.error = error
  }
  expect(said).toHaveLength(1)
  expect(said[0]).toContain(sha)
  expect(said[0]).not.toContain("git -C")
  expect(existsSync(wt)).toBe(false)
})

test("runRm --restore exits 1 naming the step when git cannot recreate the branch after the move", async () => {
  const { deps, id, main, wt } = await trashedWorktree()
  git(main, "branch", "-D", "PG-1-thing")
  writeFileSync(join(main, ".git", "refs", "heads", "PG-1-thing.lock"), "")
  const said: string[] = []
  const error = console.error
  console.error = (line: string) => void said.push(line)
  try {
    expect(await runRm(["--restore", id], deps)).toBe(1)
  } finally {
    console.error = error
  }
  expect(said).toHaveLength(1)
  expect(said[0]).toStartWith(
    `playground: restored ${wt}, but git cannot read it yet: git branch PG-1-thing `,
  )
  expect(existsSync(wt)).toBe(true)
})

test("clonesOf reads run-slot's clone holder line while its pid lives, and a line with no source as none", () => {
  const line = "k3m9px-worker 4242 2026-11-03T05:21:53Z\t/a/src\t/a/dst\n"
  expect(clonesOf(line, () => true)).toEqual([
    { destination: "/a/dst", pid: 4242, source: "/a/src", who: "k3m9px-worker" },
  ])
  expect(clonesOf(line, () => false)).toEqual([])
  expect(clonesOf("k3m9px-worker 4242 2026-11-03T05:21:53Z\n", () => true)).toEqual([])
  expect(clonesOf("", () => true)).toEqual([])
})

test("rmDeps' notify queues a safe-delete line for the dispatcher through notify.sh", () => {
  const { root } = machine()
  const data = join(root, "data")
  const before = process.env.PLAYGROUND_DATA_DIR
  process.env.PLAYGROUND_DATA_DIR = data
  try {
    rmDeps(join(import.meta.dir, "..", "..", "..", "..", "..")).notify("s: /x is protected")
  } finally {
    if (before === undefined) delete process.env.PLAYGROUND_DATA_DIR
    else process.env.PLAYGROUND_DATA_DIR = before
  }
  const line = JSON.parse(
    readFileSync(join(data, "ops", "outbox", "ops-safe-delete.jsonl"), "utf8"),
  )
  expect(line).toMatchObject({ job: "safe-delete", text: "s: /x is protected" })
})

test("rmDeps' clones reads run-slot's clone holder line from the data folder's ops, and no line as no clone", () => {
  const { root } = machine()
  const data = join(root, "data")
  mkdirSync(join(data, "ops"), { recursive: true })
  const before = process.env.PLAYGROUND_DATA_DIR
  process.env.PLAYGROUND_DATA_DIR = data
  try {
    const deps = rmDeps(join(import.meta.dir, "..", "..", "..", "..", ".."))
    expect(deps.clones()).toEqual([])
    writeFileSync(
      join(data, "ops", "run-slot-clone.holder"),
      `k3m9px-worker ${process.pid} 2026-11-03T05:21:53Z\t/a/src\t/a/dst\n`,
    )
    expect(deps.clones()).toEqual([
      { destination: "/a/dst", pid: process.pid, source: "/a/src", who: "k3m9px-worker" },
    ])
  } finally {
    if (before === undefined) delete process.env.PLAYGROUND_DATA_DIR
    else process.env.PLAYGROUND_DATA_DIR = before
  }
})

test("processesOf joins lsof's working folders with ps's command lines and each process's sockets", () => {
  const cwds = "p41\nfcwd\nn/wt/api\np43\nfcwd\nn/wt\np50\nfcwd\n"
  const ps = "   41 bun run dev\n   43 /x/agent-browser-darwin-arm64\n   50 launchd\n"
  const sockets = "p43\nf6\nn->0xe55b\nf10\nn/h/.agent-browser/s1.sock\n"
  expect(processesOf(cwds, ps, sockets)).toEqual([
    { command: "bun run dev", cwd: "/wt/api", pid: 41, sockets: [] },
    {
      command: "/x/agent-browser-darwin-arm64",
      cwd: "/wt",
      pid: 43,
      sockets: ["/h/.agent-browser/s1.sock"],
    },
  ])
})

test("--pr naming a live reviewer's open PR lifts no hold under --discard, and its merged PR at that head frees the clone", async () => {
  const { deps, main } = machine()
  git(main, "init", "-q", "-b", "canary")
  writeFileSync(join(main, "README.md"), "x")
  git(main, "add", ".")
  git(main, "commit", "-qm", "init")
  const wt = join(main, ".claude", "worktrees", "review-1")
  git(main, "worktree", "add", "-q", "--detach", wt)
  writeFileSync(join(wt, "f.txt"), "x")
  git(wt, "add", ".")
  git(wt, "commit", "-qm", "the PR's own commit")
  const url = "https://github.com/o/r/pull/1"
  writeFileSync(
    join(deps.data, "roster.json"),
    JSON.stringify({ agents: [{ name: "xyz789-reviewer", pr: url, status: "working" }] }),
  )
  const at = (state: "MERGED" | "OPEN"): RmDeps => ({
    ...deps,
    prState: async (path) => ({ head: git(path, "rev-parse", "HEAD"), number: 1, state }),
  })
  expect(await runRm(["--worktree", wt, "--discard"], at("OPEN"))).toBe(1)
  expect(existsSync(wt)).toBe(true)
  expect(await runRm(["--worktree", wt, "--discard", "--pr", url], at("OPEN"))).toBe(1)
  expect(existsSync(wt)).toBe(true)
  expect(await runRm(["--worktree", wt, "--discard", "--pr", url], at("MERGED"))).toBe(0)
  expect(existsSync(wt)).toBe(false)
})

// #2407: auto-end moves an ended session's set charged to that session, so a worker's own rm right after its checker's end still has its whole minute.
test("removePath charges the name it is given: an ended checker's set spends its cap alone, and the worker's own rm right after still passes", async () => {
  const { deps, home, told } = machine()
  const checker = "k3m9px-reviewer"
  const set = [
    join(deps.data, "scratch", checker, "notes.md"),
    join(deps.data, "scratchpad", checker, "brief.md"),
    join(deps.data, `factory-settings-400k-memory-${checker}.json`),
  ]
  for (const path of set) file(path)
  const own = (path: string) => ({
    discard: false,
    path,
    reason: `${checker} ended`,
    worktree: false,
  })
  for (const path of [
    join(deps.data, "scratch", checker),
    join(deps.data, "scratchpad", checker),
    set[2]!,
  ])
    expect(await removePath(own(path), checker, deps, () => {})).toMatchObject({ ok: true })
  expect(set.filter((path) => existsSync(path))).toEqual([])
  const fourth = join(deps.data, "scratch", `${checker}-late.txt`)
  file(fourth)
  expect((await removePath(own(fourth), checker, deps, () => {})).line).toContain("refused a 4th")
  const path = join(home, "old.txt")
  writeFileSync(path, "x")
  expect(await runRm([path], deps)).toBe(0)
  expect(existsSync(path)).toBe(false)
  expect(told.filter((line) => !line.startsWith(`${checker}:`))).toEqual([])
})

// a removal once sat 308 s on gh's PR list against a locked keyring (#2526)
test("--worktree refuses while gh is unreachable, and keeps the worktree", async () => {
  const { deps, home, root } = machine()
  const { wt } = otherRepo(root, home)
  const session = { ...deps, prState: async () => ({ unreachable: GH_HANGS }) }
  expect(await rmSaid(["--worktree", wt], session)).toEqual({
    code: 1,
    said: [
      `playground: gh unreachable: can't check the branch's PR; retry once gh answers (${GH_HANGS})`,
    ],
  })
  expect(existsSync(wt)).toBe(true)
})

test("rmDeps' gh reads make no gh call while the gh-auth beat's fresh result reads failed", async () => {
  const { home, root } = machine()
  const { wt } = otherRepo(root, home)
  const bin = join(root, "bin")
  const called = join(root, "called")
  file(join(bin, "gh"), `#!/bin/sh\ntouch "${called}"\n`)
  chmodSync(join(bin, "gh"), 0o755)
  const data = join(root, "data")
  file(
    join(data, "ops", "tick", "gh-auth.json"),
    JSON.stringify({ at: new Date().toISOString(), ok: false, reason: "gh token invalid" }),
  )
  const saved = { data: process.env.PLAYGROUND_DATA_DIR, path: process.env.PATH }
  process.env.PATH = `${bin}:${process.env.PATH}`
  process.env.PLAYGROUND_DATA_DIR = data
  try {
    const deps = rmDeps(wt)
    expect(await deps.prState(wt)).toEqual({ unreachable: "gh token invalid" })
    expect(deps.merged("HEAD", wt)).toBeNull()
    expect(deps.defaultBranch(wt)).toBeNull()
    expect(deps.mergedHead(wt, "https://github.com/o/r/pull/2484")).toBeNull()
    expect(existsSync(called)).toBe(false)
  } finally {
    process.env.PATH = saved.path
    if (saved.data === undefined) delete process.env.PLAYGROUND_DATA_DIR
    else process.env.PLAYGROUND_DATA_DIR = saved.data
  }
})

const CARD = "11111111-2222-3333-4444-555555555555"

test("runRm --card takes only an Inbox card id, so no flag reaches ask get", async () => {
  const { deps, repo } = approvedMachine((path) => [{ bytes: 7, machine: "spark-a", path }])
  const { code, err } = await rmTold([repo, "--card", "--ack"], deps)
  expect(code).toBe(2)
  expect(err.join("\n")).toContain("--ack is not an Inbox card id")
  expect(existsSync(repo)).toBe(true)
})

// A machine whose ~/models holds one dropped hf repo the record names, and whose card approves it on spark-a at its size.
type Picks = (repo: string) => { bytes: number; machine: string; path: string }[] | string
const approvedMachine = (picks: Picks | null) => {
  const m = machine()
  const repo = join(m.home, "models", "hf", "hub", "models--nvidia--Qwen-27B")
  file(join(repo, "blobs", "b"), "weights")
  writeFileSync(
    join(m.deps.data, "machine-record.json"),
    JSON.stringify({
      baseline: [],
      entries: [
        { added: "2026-11-17", by: "ops", kind: "folder", path: repo, undo: "rm", why: "seed" },
      ],
    }),
  )
  const deps: RmDeps = {
    ...m.deps,
    ...(picks === null ? {} : { approvals: async () => picks(repo) }),
    machine: "spark-a",
  }
  return { ...m, deps, repo }
}

test("runRm --card deletes weights the owner approved on this machine at their size, and drops their record entry", async () => {
  const { deps, repo } = approvedMachine((path) => [{ bytes: 7, machine: "spark-a", path }])
  const { code, out } = await rmTold([repo, "--card", CARD, "--reason", "nightly-clean"], deps)
  expect(code).toBe(0)
  expect(out.join("\n")).toContain(`Deleted ${repo} outright (7 bytes), as card ${CARD} approved`)
  expect(out.join("\n")).toContain("its machine record entry is dropped")
  expect(existsSync(repo)).toBe(false)
  expect(JSON.parse(readFileSync(join(deps.data, "machine-record.json"), "utf8")).entries).toEqual(
    [],
  )
})

test.each<[string, Picks | null, string]>([
  ["no Remove answer on the card", () => [], "holds no Remove answer from the owner"],
  [
    "a Remove for another machine",
    (path) => [{ bytes: 7, machine: "spark-b", path }],
    "holds no Remove answer",
  ],
  [
    "a size other than the card's",
    (path) => [{ bytes: 6, machine: "spark-a", path }],
    "its size changed",
  ],
  ["a card that does not read", () => "ERR_POSTGRES_CONNECTION_REFUSED", "did not read"],
  ["no Inbox here", null, "no Inbox is read here"],
])("runRm --card refuses with %s, and the path stays", async (_, picks, said) => {
  const { deps, repo } = approvedMachine(picks)
  const { code, err } = await rmTold([repo, "--card", CARD], deps)
  expect(code).toBe(1)
  expect(err.join("\n")).toContain(said)
  expect(existsSync(repo)).toBe(true)
})

// A mkdtemp machine whose hf repo holds one approved sharded set: four .gguf shards, each at its own size and on the record, at the set's total. `symlinks` replaces a shard with a symlink, which the set reads as left out, and `folders` one with an empty folder, which the set takes in at 0 bytes.
type ShardState = {
  deps: RmDeps
  repo: string
  shard: (i: number) => string
  size: number
  total: number
}
const shardedMachine = (symlinks: number[] = [], folders: number[] = []): ShardState => {
  const m = machine()
  const repo = join(m.home, "models", "hf", "hub", "models--nvidia--Qwen-27B")
  const shard = (i: number) => join(repo, `model-${String(i).padStart(5, "0")}-of-00004.gguf`)
  const size = 50
  const entries: {
    added: string
    by: string
    kind: string
    path: string
    undo: string
    why: string
  }[] = []
  for (let i = 1; i <= 4; i++) {
    const here = shard(i)
    mkdirSync(dirname(here), { recursive: true })
    if (symlinks.includes(i)) {
      writeFileSync(join(repo, `target-${i}`), "real")
      symlinkSync(join(repo, `target-${i}`), here)
    } else if (folders.includes(i)) mkdirSync(here)
    else {
      writeFileSync(here, "")
      truncateSync(here, size)
    }
    entries.push({
      added: "2026-11-17",
      by: "ops",
      kind: "folder",
      path: here,
      undo: "rm",
      why: "seed",
    })
  }
  writeFileSync(join(m.deps.data, "machine-record.json"), JSON.stringify({ baseline: [], entries }))
  return {
    ...m,
    deps: {
      ...m.deps,
      machine: "spark-a",
      approvals: async () => [{ bytes: size * 4, machine: "spark-a", path: shard(1) }],
    },
    repo,
    shard,
    size,
    total: size * 4,
  }
}

test("runRm --card deletes an approved sharded set whole: every shard at the set's total, and every record entry dropped", async () => {
  const { deps, shard, total } = shardedMachine()
  const { code, out } = await rmTold([shard(1), "--card", CARD, "--reason", "nightly-clean"], deps)
  expect(code).toBe(0)
  for (let i = 1; i <= 4; i++) expect(existsSync(shard(i))).toBe(false)
  expect(out.join("\n")).toContain(
    `Deleted the 4 shards outright (${total} bytes), as card ${CARD} approved on this machine; ${join(deps.data, "trash", "deleted.jsonl")} logs it`,
  )
  expect(out.join("\n")).toContain("its machine record entries are dropped")
  expect(JSON.parse(readFileSync(join(deps.data, "machine-record.json"), "utf8")).entries).toEqual(
    [],
  )
})

test("runRm --card refuses a sharded set whose total no longer matches the pick, deleting none", async () => {
  const { deps, shard, total } = shardedMachine()
  const { code, err } = await rmTold([shard(1), "--card", CARD], {
    ...deps,
    approvals: async () => [{ bytes: total + 50, machine: "spark-a", path: shard(1) }],
  })
  expect(code).toBe(1)
  expect(err.join("\n")).toContain("shard set holds 4 shards at 200 bytes")
  expect(err.join("\n")).toContain("approved it at 250")
  for (let i = 1; i <= 4; i++) expect(existsSync(shard(i))).toBe(true)
})

test("runRm --card leaves a symlinked shard out of the set, so its total no longer matches the pick, deleting none", async () => {
  const { deps, shard } = shardedMachine([4])
  const { code, err } = await rmTold([shard(1), "--card", CARD], deps)
  expect(code).toBe(1)
  expect(err.join("\n")).toContain("shard set holds 3 shards at 150 bytes")
  expect(err.join("\n")).toContain("approved it at 200")
  for (let i = 1; i <= 4; i++) expect(existsSync(shard(i))).toBe(true)
})

test("runRm --card refuses a sharded set whose one shard fails its own check, an empty folder, though the total matches the pick, deleting none", async () => {
  const { deps, shard, size } = shardedMachine([], [4])
  const { code, err } = await rmTold([shard(1), "--card", CARD], {
    ...deps,
    approvals: async () => [{ bytes: size * 3, machine: "spark-a", path: shard(1) }],
  })
  expect(code).toBe(1)
  expect(err.join("\n")).toContain(`${shard(4)} is not model weights the shard set holds`)
  for (let i = 1; i <= 4; i++) expect(existsSync(shard(i))).toBe(true)
})

// A scratch hub repo whose snapshots/<rev>/ shards are links to its blobs, the record naming the repo folder (not a shard), and a card that approves it whole: shardSet returns null for the folder, so deleteWeights removes it, never removeSet, and a shard link there would be refused.
type HubRepoState = {
  deps: RmDeps
  repo: string
  shard: (i: number) => string
  blobs: string[]
  size: number
}
const hubRepoMachine = (rev = "abc123"): HubRepoState => {
  const m = machine()
  const repo = join(m.home, "models", "hf", "hub", "models--nvidia--Qwen-27B")
  const shard = (i: number) =>
    join(repo, "snapshots", rev, `model-${String(i).padStart(5, "0")}-of-00003.safetensors`)
  const size = 100
  const blobs: string[] = []
  for (let i = 1; i <= 3; i++) {
    const blob = join(repo, "blobs", `blob-${i}`)
    file(blob)
    truncateSync(blob, size)
    blobs.push(blob)
  }
  for (let i = 1; i <= 3; i++) {
    const here = shard(i)
    mkdirSync(dirname(here), { recursive: true })
    symlinkSync(blobs[i - 1]!, here)
  }
  writeFileSync(
    join(m.deps.data, "machine-record.json"),
    JSON.stringify({
      baseline: [],
      entries: [
        { added: "2026-11-17", by: "ops", kind: "folder", path: repo, undo: "rm", why: "seed" },
      ],
    }),
  )
  return {
    ...m,
    deps: {
      ...m.deps,
      machine: "spark-a",
      approvals: async () => [{ bytes: size * 3, machine: "spark-a", path: repo }],
    },
    blobs,
    repo,
    shard,
    size: size * 3,
  }
}

test("runRm --card deletes an approved hub repo whole, its shard links and blobs, and drops its record entry", async () => {
  const { deps, repo, blobs, size } = hubRepoMachine()
  const { code, out } = await rmTold([repo, "--card", CARD, "--reason", "nightly-clean"], deps)
  expect(code).toBe(0)
  expect(out.join("\n")).toContain(
    `Deleted ${repo} outright (${size} bytes), as card ${CARD} approved`,
  )
  expect(out.join("\n")).toContain("its machine record entry is dropped")
  expect(existsSync(repo)).toBe(false)
  for (const b of blobs) expect(existsSync(b)).toBe(false)
  expect(JSON.parse(readFileSync(join(deps.data, "machine-record.json"), "utf8")).entries).toEqual(
    [],
  )
})

// A peer's far end: run-slot's ssh, a closure a test injects so the stub records the command.
type PeerRun = { machine: string; command: string }
const peerRun = (out: { code: number; out: string }) => {
  const seen: PeerRun[] = []
  const peer: RmDeps["peer"] = async (machine, command) => {
    seen.push({ machine, command })
    return out
  }
  return { seen, peer }
}

test("runRm --peer sends one rm-peer command to the named peer and relays its line, leaving this machine's own copy at that path and its record entry", async () => {
  const { seen, peer } = peerRun({ code: 0, out: "Deleted the weights on the peer" })
  const { deps, repo } = approvedMachine((path) => [{ bytes: 7, machine: "spark-b", path }])
  const record = readFileSync(join(deps.data, "machine-record.json"), "utf8")
  const { code, out } = await rmTold([repo, "--card", CARD, "--peer", "spark-b"], {
    ...deps,
    peer,
  })
  expect(code).toBe(0)
  expect(seen).toEqual([
    {
      machine: "spark-b",
      command: `packages/scripts/src/playground/rm-peer.ts '${repo}' '7' '${CARD}'`,
    },
  ])
  expect(out.join("\n")).toContain("Deleted the weights on the peer")
  expect(existsSync(repo)).toBe(true)
  expect(readFileSync(join(deps.data, "machine-record.json"), "utf8")).toBe(record)
})

test("runRm --peer passes a path with a space or a quote to the peer as one word", () => {
  expect(rmPeerCommand("/h/models/a b's.gguf", 7, "c1")).toBe(
    `packages/scripts/src/playground/rm-peer.ts '/h/models/a b'\\''s.gguf' '7' 'c1'`,
  )
})

test("runRm --peer refuses a pick the card does not name on that peer, and sends no ssh", async () => {
  const { seen, peer } = peerRun({ code: 0, out: "ignored" })
  const { deps, repo } = approvedMachine((path) => [{ bytes: 7, machine: "spark-a", path }])
  const { code, err } = await rmTold([repo, "--card", CARD, "--peer", "spark-b"], {
    ...deps,
    peer,
  })
  expect(code).toBe(1)
  expect(err.join("\n")).toContain("holds no Remove answer")
  expect(seen).toEqual([])
  expect(existsSync(repo)).toBe(true)
})

test("runRm --peer relays a peer's plain refusal once and tells the dispatcher nothing, as a local one does", async () => {
  const { seen, peer } = peerRun({ code: 1, out: "playground: no such path" })
  const { deps, repo, told } = approvedMachine((path) => [{ bytes: 7, machine: "spark-b", path }])
  const { code, err } = await rmTold([repo, "--card", CARD, "--peer", "spark-b"], {
    ...deps,
    peer,
  })
  expect(code).toBe(1)
  expect(told).toEqual([])
  expect(err).toEqual(["playground: spark-b: no such path"])
  expect(seen).toEqual([
    {
      machine: "spark-b",
      command: `packages/scripts/src/playground/rm-peer.ts '${repo}' '7' '${CARD}'`,
    },
  ])
  expect(existsSync(repo)).toBe(true)
})

test("runRm --peer tells the dispatcher of a peer's protected refusal (exit 3), as a local one does", async () => {
  const { peer } = peerRun({ code: 3, out: "playground: /m/x.gguf is protected" })
  const { deps, repo, told } = approvedMachine((path) => [{ bytes: 7, machine: "spark-b", path }])
  const { code } = await rmTold([repo, "--card", CARD, "--peer", "spark-b"], { ...deps, peer })
  expect(code).toBe(1)
  expect(told).toEqual(["j6rjgy-worker: /m/x.gguf is protected"])
  expect(existsSync(repo)).toBe(true)
})

test("runRm --peer relays a peer's silence with the did-not-answer fallback", async () => {
  const { seen, peer } = peerRun({ code: 1, out: "" })
  const { deps, repo, told } = approvedMachine((path) => [{ bytes: 7, machine: "spark-b", path }])
  const { code, err } = await rmTold([repo, "--card", CARD, "--peer", "spark-b"], {
    ...deps,
    peer,
  })
  expect(code).toBe(1)
  expect(told).toEqual(["j6rjgy-worker: the peer did not answer"])
  expect(err.join("\n")).toContain("the peer did not answer")
  expect(seen).toEqual([
    {
      machine: "spark-b",
      command: `packages/scripts/src/playground/rm-peer.ts '${repo}' '7' '${CARD}'`,
    },
  ])
  expect(existsSync(repo)).toBe(true)
})

// A main checkout pushed to origin/canary with one replay worktree in a row of ~/models/kit/runs holding an untracked answer.
const replayMachine = () => {
  const m = machine()
  git(m.root, "init", "--bare", "-q", join(m.root, "remote.git"))
  git(m.main, "init", "-q", "-b", "canary")
  file(join(m.main, "README.md"))
  git(m.main, "add", "README.md")
  git(m.main, "commit", "-qm", "init")
  git(m.main, "remote", "add", "origin", join(m.root, "remote.git"))
  git(m.main, "push", "-q", "origin", "canary")
  const wt = join(m.home, "models", "kit", "runs", "MB-1", "pr0001")
  mkdirSync(dirname(wt), { recursive: true })
  git(m.main, "worktree", "add", "-q", "--detach", wt, "HEAD")
  file(join(wt, "answer.ts"), "export const a = 1\n")
  return { ...m, wt }
}

test("runRm --worktree keeps a replay worktree a model test is running in, and refuses --discard and --pr on one", async () => {
  const { deps, wt } = replayMachine()
  const running = {
    ...deps,
    procs: () => [{ command: "bun run kit replay", cwd: wt, pid: 4242, sockets: [] }],
  }
  const held = await rmTold(["--worktree", wt], running)
  expect(held.code).toBe(1)
  expect(held.err.join("\n")).toContain(
    `${wt} is held by pid 4242 (bun run kit replay) working in ${wt}`,
  )
  for (const words of [["--discard"], ["--pr", "https://github.com/o/r/pull/1"]]) {
    const flagged = await rmTold(["--worktree", wt, ...words], deps)
    expect(flagged.code).toBe(2)
    expect(flagged.err.join("\n")).toContain("takes neither --discard nor --pr")
  }
  expect(existsSync(wt)).toBe(true)
  expect(existsSync(`${wt}.diff`)).toBe(false)
})

test("runRm --worktree removes a replay worktree under ~/models/kit/runs through git, its work kept in <name>.diff", async () => {
  const { deps, wt } = replayMachine()
  const { code, out } = await rmTold(["--worktree", wt], deps)
  expect(code).toBe(0)
  expect(out.join("\n")).toContain(`its work is kept in ${wt}.diff`)
  expect(existsSync(wt)).toBe(false)
  expect(readFileSync(`${wt}.diff`, "utf8")).toContain("+export const a = 1")
})
