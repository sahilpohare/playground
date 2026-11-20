import { afterAll, describe, expect, test } from "bun:test"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  truncateSync,
  utimesSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { hasManagerRole, ROSTER_KINDS } from "../../../../packages/config/src/kinds"
import {
  archiveUnlanded,
  bundleToTrash,
  bytesOf,
  CARVE_OUTS,
  type CarveOut,
  type Clone,
  deleteWeights,
  isProtected,
  isWeights,
  LIMITS,
  linkPlaces,
  listTrash,
  MARKER,
  makeScratch,
  movesLeft,
  type Proc,
  purgeTrash,
  quarantine,
  type Quarantined,
  removeReplay,
  removeScratch,
  removeStale,
  restore,
  type Roots,
  rowPullRequests,
  stripTrash,
  unpushed,
  worktreeRefusal,
} from "../../../../packages/safe-delete/src"

const dirs: string[] = []
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { force: true, recursive: true })
})

// A made-up process for the holder check: no process starts, the list is data.
const proc = (pid: number, command: string, cwd: string, sockets: string[] = []): Proc => ({
  command,
  cwd,
  pid,
  sockets,
})

// A fake machine on a mkdtemp root of its own: a HOME, a main checkout in it, and the trash in its state folder.
const machine = (): Roots & { root: string } => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "safe-delete-")))
  dirs.push(root)
  const home = join(root, "home")
  const main = join(home, "playground")
  mkdirSync(join(main, ".claude", "worktrees"), { recursive: true })
  for (const dir of [".config", ".ssh", ".gnupg", ".claude", "Library", "Music", ".playground"])
    mkdirSync(join(home, dir), { recursive: true })
  writeFileSync(join(home, ".ssh", "id_ed25519"), "key")
  return { home, main, root, trash: join(home, ".playground", "trash") }
}

const file = (path: string, text = "x"): string => {
  mkdirSync(join(path, ".."), { recursive: true })
  writeFileSync(path, text)
  return path
}

const NOW = new Date("2026-11-02T12:00:00Z")
const opts = { reason: "test", session: "j6rjgy-worker" }

describe("isProtected", () => {
  test.each([
    ["HOME", (r: Roots) => r.home],
    ["a folder that holds HOME", (r: Roots) => join(r.home, "..")],
    ["~/.config", (r: Roots) => join(r.home, ".config")],
    ["a key in ~/.ssh", (r: Roots) => join(r.home, ".ssh", "id_ed25519")],
    ["~/.gnupg", (r: Roots) => join(r.home, ".gnupg")],
    ["~/.claude", (r: Roots) => join(r.home, ".claude")],
    ["~/Library", (r: Roots) => join(r.home, "Library")],
    ["~/Music", (r: Roots) => join(r.home, "Music")],
    ["~/.playground", (r: Roots) => join(r.home, ".playground")],
    ["a file in ~/.playground", (r: Roots) => join(r.home, ".playground", "roster.json")],
    ["the trash root", (r: Roots) => r.trash],
    ["a path in the trash", (r: Roots) => join(r.trash, "20261102T120000Z-a", "1")],
    ["the main checkout", (r: Roots) => r.main],
    ["a file in the main checkout", (r: Roots) => join(r.main, "AGENTS.md")],
    ["the worktrees folder", (r: Roots) => join(r.main, ".claude", "worktrees")],
  ])("refuses %s", (_, pick) => {
    const roots = machine()
    expect(isProtected(pick(roots), roots)).toBeString()
  })

  test("refuses a symlink whose target is protected, and one inside a protected folder", () => {
    const roots = machine()
    const link = join(roots.root, "scratch", "keys")
    mkdirSync(join(roots.root, "scratch"))
    symlinkSync(join(roots.home, ".ssh"), link)
    expect(isProtected(link, roots)).toContain(".ssh")
    const inside = join(roots.home, ".config", "pointer")
    symlinkSync(join(roots.root, "scratch"), inside)
    expect(isProtected(inside, roots)).toContain(".config")
  })

  test("refuses ~/.playground and the trash root's parent when the trash sits elsewhere", () => {
    const roots = machine()
    const elsewhere = { ...roots, trash: join(roots.root, "data", "trash") }
    expect(isProtected(join(roots.home, ".playground", "x"), elsewhere)).toBeString()
    expect(isProtected(join(roots.root, "data", "notes.md"), elsewhere)).toBeString()
  })

  test("lets a session's scratch folder, a worktree and a file in a worktree go", () => {
    const roots = machine()
    expect(isProtected(join(roots.root, "scratch"), roots)).toBeNull()
    expect(isProtected(join(roots.home, "notes"), roots)).toBeNull()
    expect(isProtected(join(roots.main, ".claude", "worktrees", "wt"), roots)).toBeNull()
    expect(isProtected(join(roots.main, ".claude", "worktrees", "wt", ".next"), roots)).toBeNull()
  })

  test("lets the caller's own scratch and scratchpad folders go", () => {
    const roots = machine()
    const own = join(roots.home, ".playground", "scratch", opts.session)
    const pad = join(roots.home, ".playground", "scratchpad", opts.session)
    expect(isProtected(own, roots, opts.session)).toBeNull()
    expect(isProtected(join(own, "build"), roots, opts.session)).toBeNull()
    expect(isProtected(join(pad, "notes"), roots, opts.session)).toBeNull()
  })

  test("refuses another session's scratch folder and a .. escape out of the own one", () => {
    const roots = machine()
    const own = join(roots.home, ".playground", "scratch", opts.session)
    const other = join(roots.home, ".playground", "scratch", "a4b5c6-worker")
    expect(isProtected(other, roots, opts.session)).toBeString()
    expect(isProtected(`${own}/../a4b5c6-worker`, roots, opts.session)).toBeString()
  })

  test("holds the exemption closed for a session name no session may hold", () => {
    const roots = machine()
    const inside = join(roots.home, ".playground", "scratch", "a", "b")
    expect(isProtected(inside, roots, "a/b")).toBeString()
    expect(isProtected(inside, roots)).toBeString()
  })

  test("refuses a symlink inside the own scratch that points out of it", () => {
    const roots = machine()
    const own = join(roots.home, ".playground", "scratch", opts.session)
    mkdirSync(own, { recursive: true })
    symlinkSync(join(roots.home, ".ssh"), join(own, "keys"))
    expect(isProtected(join(own, "keys"), roots, opts.session)).toBeString()
  })

  // #2229: a loose regular file directly in scratch/ named after the session, then - or ., is that session's own, as the nightly clean already reads it.
  test("lets the caller's own loose scratch file go, and refuses another's, a link, a folder, a longer name and one in a subfolder", () => {
    const roots = machine()
    const scratch = join(roots.home, ".playground", "scratch")
    for (const name of [`${opts.session}-probe.txt`, `${opts.session}.tmp`]) {
      const path = file(join(scratch, name))
      expect(isProtected(path, roots, opts.session)).toBeNull()
      expect(isProtected(path, roots)).toBeString()
    }
    const link = join(scratch, `${opts.session}-link.txt`)
    symlinkSync(file(join(roots.root, "elsewhere.txt")), link)
    const folder = join(scratch, `${opts.session}-dir`)
    file(join(folder, "a"))
    for (const path of [
      file(join(scratch, "a4b5c6-worker-probe.txt")),
      link,
      folder,
      file(join(scratch, `${opts.session}x.txt`)),
      file(join(scratch, "sub", `${opts.session}-probe.txt`)),
    ])
      expect(isProtected(path, roots, opts.session)).toBeString()
  })

  // #2247's review: a scratch/ that is a symlink would carry the own loose file's exemption into the link's target, so it holds only while scratch/ is a real folder reached through no link from HOME.
  test.each([".ssh", ".playground/elsewhere"])(
    "refuses the caller's own loose file name through a scratch/ linked into %s, by either path",
    (target) => {
      const roots = machine()
      const into = join(roots.home, target)
      const kept = file(join(into, `${opts.session}-key`), "secret")
      symlinkSync(into, join(roots.home, ".playground", "scratch"))
      const linked = join(roots.home, ".playground", "scratch", `${opts.session}-key`)
      expect(isProtected(linked, roots, opts.session)).toBeString()
      expect(isProtected(kept, roots, opts.session)).toBeString()
      expect(quarantine(linked, opts, roots, { now: NOW })).toMatchObject({ kind: "protected" })
      expect(readFileSync(kept, "utf8")).toBe("secret")
    },
  )

  test("moves the caller's own loose scratch file to the trash, and restore puts it back", () => {
    const roots = machine()
    const path = file(
      join(roots.home, ".playground", "scratch", `${opts.session}-probe.txt`),
      "probe",
    )
    expect(quarantine(path, opts, roots, { now: NOW })).toMatchObject({ files: 1 })
    expect(existsSync(path)).toBe(false)
    const [entry] = listTrash(roots.trash)
    expect(restore(entry!.id, roots)).toEqual({ path })
    expect(readFileSync(path, "utf8")).toBe("probe")
  })

  // #2407: a worker's end takes the memory trial's settings file spawn.sh wrote for it, which sits in the protected data folder.
  test("lets the caller's own memory settings file go, and refuses another's, a link and the shared file", () => {
    const roots = machine()
    const data = join(roots.home, ".playground")
    const own = file(join(data, `factory-settings-400k-memory-${opts.session}.json`), "{}")
    expect(isProtected(own, roots, opts.session)).toBeNull()
    expect(isProtected(own, roots)).toBeString()
    expect(quarantine(own, opts, roots, { now: NOW })).toMatchObject({ files: 1 })
    expect(existsSync(own)).toBe(false)
    symlinkSync(file(join(roots.root, "elsewhere.json")), own)
    for (const path of [
      own,
      file(join(data, "factory-settings-400k-memory-a4b5c6-worker.json")),
      file(join(data, "factory-settings-400k.json")),
    ])
      expect(isProtected(path, roots, opts.session)).toBeString()
  })
})

describe("quarantine, listTrash and restore", () => {
  test("renames a path into the trash with a manifest line, lists it, and restores it", () => {
    const roots = machine()
    const doomed = join(roots.home, "work", "old")
    file(join(doomed, "a.txt"), "hello")
    file(join(doomed, "b", "c.txt"), "hi")
    const moved = quarantine(doomed, opts, roots, { now: NOW })
    if ("refused" in moved) throw new Error(moved.refused)
    expect(moved.id).toBe("20261102T120000Z-j6rjgy-worker/1")
    expect(moved).toMatchObject({ files: 2, size: 7 })
    expect(existsSync(doomed)).toBe(false)
    expect(readFileSync(join(roots.trash, moved.id, "old", "a.txt"), "utf8")).toBe("hello")
    const manifest = readFileSync(
      join(roots.trash, "20261102T120000Z-j6rjgy-worker", "manifest.jsonl"),
      "utf8",
    )
    expect(JSON.parse(manifest)).toMatchObject({
      files: 2,
      id: moved.id,
      path: doomed,
      reason: "test",
      session: "j6rjgy-worker",
      size: 7,
    })
    expect(listTrash(roots.trash).map((entry) => entry.id)).toEqual([moved.id])
    expect(restore(moved.id, roots)).toEqual({ path: doomed })
    expect(readFileSync(join(doomed, "b", "c.txt"), "utf8")).toBe("hi")
    expect(listTrash(roots.trash)).toEqual([])
  })

  test("numbers a second path of the same second and session 2", () => {
    const roots = machine()
    quarantine(file(join(roots.home, "one")), opts, roots, { now: NOW })
    const second = quarantine(file(join(roots.home, "two")), opts, roots, { now: NOW })
    expect(second).toMatchObject({ id: "20261102T120000Z-j6rjgy-worker/2" })
  })

  test("restore moves an own-scratch item back into the folder that owns it", () => {
    const roots = machine()
    const own = join(roots.home, ".playground", "scratch", opts.session)
    const path = file(join(own, "tmp", "work.txt"))
    const moved = quarantine(path, opts, roots)
    if (!("id" in moved)) throw new Error(moved.refused)
    expect(restore(moved.id, roots)).toEqual({ path })
    expect(existsSync(path)).toBe(true)
    expect(listTrash(roots.trash)).toEqual([])
  })

  test("restore refuses when something stands at the original path, or the id is unknown", () => {
    const roots = machine()
    const path = file(join(roots.home, "note"))
    const moved = quarantine(path, opts, roots, { now: NOW })
    if ("refused" in moved) throw new Error(moved.refused)
    file(path, "new")
    expect(restore(moved.id, roots)).toMatchObject({ refused: expect.stringContaining(path) })
    expect(restore("20261102T120000Z-j6rjgy-worker/9", roots)).toHaveProperty("refused")
    expect(restore("../../etc", roots)).toHaveProperty("refused")
  })

  test("restore refuses a manifest path that is protected", () => {
    const roots = machine()
    const moved = quarantine(file(join(roots.home, "note")), opts, roots, { now: NOW })
    if ("refused" in moved) throw new Error(moved.refused)
    const manifest = join(roots.trash, "20261102T120000Z-j6rjgy-worker", "manifest.jsonl")
    const edited = {
      ...JSON.parse(readFileSync(manifest, "utf8")),
      path: join(roots.home, ".ssh", "note"),
    }
    writeFileSync(manifest, `${JSON.stringify(edited)}\n`)
    expect(restore(moved.id, roots)).toMatchObject({ kind: "protected" })
    expect(existsSync(join(roots.home, ".ssh", "note"))).toBe(false)
  })

  test("refuses a protected path, a missing path and a bad session name", () => {
    const roots = machine()
    expect(quarantine(join(roots.home, ".ssh"), opts, roots)).toMatchObject({ kind: "protected" })
    expect(quarantine(join(roots.home, "gone"), opts, roots)).toMatchObject({ kind: "refused" })
    const path = file(join(roots.home, "x"))
    expect(quarantine(path, { ...opts, session: "a/b" }, roots)).toMatchObject({ kind: "refused" })
  })

  test("refuses a move that would cross volumes, and leaves the path in place", () => {
    const roots = machine()
    const path = file(join(roots.home, "elsewhere"))
    const dev = (p: string) => (p === path ? 1 : 2)
    expect(quarantine(path, opts, roots, { dev, now: NOW })).toMatchObject({
      kind: "refused",
      refused: expect.stringContaining("volume"),
    })
    expect(existsSync(path)).toBe(true)
  })

  test("refuses a worktree without --worktree, and --worktree on a plain folder", () => {
    const roots = machine()
    const wt = join(roots.main, ".claude", "worktrees", "wt")
    file(join(wt, "a"))
    expect(quarantine(wt, opts, roots)).toMatchObject({
      refused: expect.stringContaining("--worktree"),
    })
    const plain = file(join(roots.home, "plain"))
    const holders = {
      clones: () => [],
      discard: false,
      live: ["working"],
      merged: () => true,
      places: () => [],
      procs: [],
      roster: join(roots.root, "roster.json"),
    }
    expect(quarantine(plain, { ...opts, worktree: holders }, roots)).toHaveProperty("refused")
  })

  // PG-1066: the route the refusal names is the one a big tree still takes: the lead's cleanup, past what plain rm moves
  test("--worktree on a plain folder past the tripwire names its cap and the lead's cleanup, as plain rm then refuses it", () => {
    const roots = machine()
    const big = join(roots.home, "scratch", "big")
    mkdirSync(big, { recursive: true })
    for (let i = 0; i <= 5000; i++) writeFileSync(join(big, String(i)), "")
    const holders = {
      clones: () => [],
      discard: true,
      live: ["working"],
      merged: () => true,
      places: () => [],
      procs: [],
      roster: join(roots.root, "roster.json"),
    }
    const worktrees = join(roots.main, ".claude", "worktrees")
    expect(quarantine(big, { ...opts, worktree: holders }, roots, { now: NOW })).toEqual({
      kind: "refused",
      refused: `--worktree takes a folder in ${worktrees} or a git worktree in another repo's .claude/worktrees, not ${big}: playground rm ${big} moves a folder outside it to the trash, with no --worktree or --discard, up to 5,000 files or 2 GB; leave a bigger tree in place for your lead's cleanup`,
    })
    expect(quarantine(big, opts, roots, { now: NOW })).toMatchObject({ kind: "tripwire" })
    expect(existsSync(big)).toBe(true)
  })
})

describe("the tripwire", () => {
  test("refuses a path of more than 5,000 files", () => {
    const roots = machine()
    const big = join(roots.home, "big")
    mkdirSync(big)
    for (let i = 0; i <= 5000; i++) writeFileSync(join(big, String(i)), "")
    expect(quarantine(big, opts, roots, { now: NOW })).toMatchObject({ kind: "tripwire" })
    expect(existsSync(big)).toBe(true)
  })

  // #2407: an end moves the session's own temp folder, which hook test data fills past 5,000 files, whole under the 2 GB cap alone, and a refusal past the cap pages no one
  test("the session's own temp folder moves whole past 5,000 files, a plain refusal past 2 GB; another's and a longer name's keep the alert, and a link in its name moves alone", () => {
    const roots = machine()
    const tmp = join(roots.root, "tmp")
    const big = (name: string) => {
      mkdirSync(join(tmp, name, "deep"), { recursive: true })
      for (let i = 0; i <= 5000; i++) writeFileSync(join(tmp, name, "deep", String(i)), "")
      return join(tmp, name)
    }
    const own = big(`playground-${opts.session}.AbC123`)
    expect(quarantine(own, opts, roots, { now: NOW, tmp })).toMatchObject({ files: 5001 })
    expect(existsSync(own)).toBe(false)
    for (const name of ["playground-a4b5c6-worker.Q1", `playground-${opts.session}2.Q2`])
      expect(quarantine(big(name), opts, roots, { now: NOW, tmp })).toMatchObject({
        kind: "tripwire",
      })
    const target = big("elsewhere")
    const link = join(tmp, `playground-${opts.session}.L1`)
    symlinkSync(target, link)
    expect(quarantine(link, opts, roots, { now: NOW, tmp })).toMatchObject({ files: 1 })
    expect(readdirSync(join(target, "deep"))).toHaveLength(5001)
    const huge = join(tmp, `playground-${opts.session}.H1`)
    mkdirSync(huge)
    truncateSync(file(join(huge, "data.bin"), ""), 2 * 1024 ** 3 + 1)
    expect(quarantine(huge, opts, roots, { now: NOW, tmp })).toEqual({
      kind: "refused",
      refused: `${huge} holds over 2 GB, past the tripwire: it stays in place`,
    })
  })

  // #2088: the nightly clean's gone option moves an entry directly in scratch/ whole, a loose file included, under the 2 GB cap alone; without it a session's own scratch folder keeps the file count
  test("a gone session's entry directly in scratch/ moves whole past 5,000 files and comes back; without gone it is refused, and gone reaches nothing else", () => {
    const roots = machine()
    const dir = join(roots.home, ".playground", "scratch")
    const big = (name: string) => {
      mkdirSync(join(dir, name, "deep"), { recursive: true })
      for (let i = 0; i <= 5000; i++) writeFileSync(join(dir, name, "deep", String(i)), "")
      return join(dir, name)
    }
    const own = big("j6rjgy-worker")
    expect(quarantine(own, opts, roots, { now: NOW })).toMatchObject({ kind: "refused" })
    expect(existsSync(own)).toBe(true)
    const gone = { gone: true as const, reason: "test", session: "q1w2e3-worker" }
    const folder = big("q1w2e3-worker")
    expect(quarantine(folder, gone, roots, { now: NOW })).toHaveProperty("id")
    expect(existsSync(folder)).toBe(false)
    const loose = file(join(dir, "q1w2e3-page.html"))
    const moved = quarantine(loose, { ...gone, session: "q1w2e3-page-html" }, roots, { now: NOW })
    expect(existsSync(loose)).toBe(false)
    expect(restore((moved as Quarantined).id, roots)).toEqual({ path: loose })
    expect(existsSync(loose)).toBe(true)
    const huge = file(join(dir, "q1w2e3-huge.bin"), "")
    truncateSync(huge, 2 * 1024 ** 3 + 1)
    expect(
      quarantine(huge, { ...gone, session: "q1w2e3-huge" }, roots, { now: NOW }),
    ).toMatchObject({
      kind: "tripwire",
    })
    symlinkSync(join(roots.home, ".ssh"), join(dir, "q1w2e3-keys"))
    for (const path of [
      join(own, "deep", "1"),
      join(dir, "q1w2e3-keys"),
      file(join(roots.home, ".playground", "roster.json")),
      join(roots.home, ".ssh", "id_ed25519"),
    ])
      expect(
        quarantine(path, { ...gone, session: "q1w2e3-other" }, roots, { now: NOW }),
      ).toMatchObject({
        kind: "protected",
      })
  })

  test("refuses a path of more than 2 GB", () => {
    const roots = machine()
    const path = file(join(roots.home, "huge.bin"), "")
    truncateSync(path, 2 * 1024 ** 3 + 1)
    expect(quarantine(path, opts, roots, { now: NOW })).toMatchObject({ kind: "tripwire" })
  })

  test("counts a quarantine whose second-cut stamp sits just outside the minute", () => {
    const roots = machine()
    const at = new Date("2026-11-02T12:00:00.900Z")
    for (const name of ["a", "b", "c"])
      expect(quarantine(file(join(roots.home, name)), opts, roots, { now: at })).toHaveProperty(
        "id",
      )
    const later = new Date("2026-11-02T12:01:00.500Z")
    expect(quarantine(file(join(roots.home, "d")), opts, roots, { now: later })).toMatchObject({
      kind: "tripwire",
    })
  })

  test("a session at the cap alerts once a burst: its first refused try is a tripwire, every later one inside it a plain refusal, and the next burst alerts again", () => {
    const roots = machine()
    for (const name of ["a", "b", "c"])
      expect(quarantine(file(join(roots.home, name)), opts, roots, { now: NOW })).toHaveProperty(
        "id",
      )
    const kinds = Array.from({ length: 11 }, (_, i) => {
      const done = quarantine(file(join(roots.home, `x${i}`)), opts, roots, {
        now: new Date(NOW.getTime() + 2_000 + i * 2_500),
      })
      return "kind" in done ? done.kind : "moved"
    })
    expect(kinds).toEqual(["tripwire", ...Array(10).fill("refused")])
    const later = new Date(NOW.getTime() + 61_000)
    for (const name of ["d", "e", "f"])
      expect(quarantine(file(join(roots.home, name)), opts, roots, { now: later })).toHaveProperty(
        "id",
      )
    expect(
      quarantine(file(join(roots.home, "g")), opts, roots, {
        now: new Date(later.getTime() + 1_000),
      }),
    ).toMatchObject({ kind: "tripwire" })
    expect(listTrash(roots.trash)).toHaveLength(6)
  })

  test("a mark another try at the same instant made makes the second a plain refusal, so two tries at one instant cannot both alert", () => {
    const roots = machine()
    for (const name of ["a", "b", "c"])
      expect(quarantine(file(join(roots.home, name)), opts, roots, { now: NOW })).toHaveProperty(
        "id",
      )
    // the winner's mark, as a concurrent try at the same instant leaves it: a file named for the burst's key
    const key = listTrash(roots.trash)
      .map((entry) => entry.at)
      .sort()
      .at(-1)!
    mkdirSync(join(roots.trash, ".cap-told", opts.session), { recursive: true })
    writeFileSync(join(roots.trash, ".cap-told", opts.session, key), "")
    expect(quarantine(file(join(roots.home, "x")), opts, roots, { now: NOW })).toMatchObject({
      kind: "refused",
    })
  })

  test("a legacy told mark, a file where the session's folder goes, does not silence the session's next burst", () => {
    const roots = machine()
    for (const name of ["a", "b", "c"])
      expect(quarantine(file(join(roots.home, name)), opts, roots, { now: NOW })).toHaveProperty(
        "id",
      )
    // a mark of the old shape, as a pre-merge night left it: a content file at the session's own path
    mkdirSync(join(roots.trash, ".cap-told"), { recursive: true })
    writeFileSync(join(roots.trash, ".cap-told", opts.session), "2026-11-01T00:00:00.000Z")
    expect(quarantine(file(join(roots.home, "x")), opts, roots, { now: NOW })).toMatchObject({
      kind: "tripwire",
    })
  })

  test("a legacy mark whose clear is refused still alerts: the folder's make answers, not its EEXIST", () => {
    const roots = machine()
    for (const name of ["a", "b", "c"])
      expect(quarantine(file(join(roots.home, name)), opts, roots, { now: NOW })).toHaveProperty(
        "id",
      )
    const toldDir = join(roots.trash, ".cap-told")
    mkdirSync(toldDir, { recursive: true })
    writeFileSync(join(toldDir, opts.session), "2026-11-01T00:00:00.000Z")
    chmodSync(toldDir, 0o555)
    try {
      expect(quarantine(file(join(roots.home, "x")), opts, roots, { now: NOW })).toMatchObject({
        kind: "tripwire",
      })
    } finally {
      chmodSync(toldDir, 0o755)
    }
  })

  test("a .cap-told that is a file does not throw out of quarantine: the burst alerts", () => {
    const roots = machine()
    for (const name of ["a", "b", "c"])
      expect(quarantine(file(join(roots.home, name)), opts, roots, { now: NOW })).toHaveProperty(
        "id",
      )
    writeFileSync(join(roots.trash, ".cap-told"), "not a folder")
    expect(quarantine(file(join(roots.home, "x")), opts, roots, { now: NOW })).toMatchObject({
      kind: "tripwire",
    })
  })

  test("two processes refusing at the same instant alert once: the folder's recovery never removes a concurrent try's folder", async () => {
    const roots = machine()
    for (const name of ["a", "b", "c"])
      expect(quarantine(file(join(roots.home, name)), opts, roots, { now: NOW })).toHaveProperty(
        "id",
      )
    const src = join(import.meta.dir, "../../../../packages/safe-delete/src/index.ts")
    const driver = join(roots.root, "driver.ts")
    writeFileSync(
      driver,
      `import { quarantine } from ${JSON.stringify(src)}
const [home, main, trash, path] = process.argv.slice(2)
const done = quarantine(path, { reason: "test", session: "j6rjgy-worker" }, { home, main, trash }, { now: new Date("2026-11-02T12:00:00Z") })
console.log("kind" in done ? done.kind : "moved")`,
    )
    const paths = ["d", "e"].map((name) => file(join(roots.home, name)))
    const kids = paths.map((path) =>
      Bun.spawn(["bun", driver, roots.home, roots.main, roots.trash, path]),
    )
    const kinds = await Promise.all(
      kids.map(async (kid) => (await new Response(kid.stdout).text()).trim()),
    )
    await Promise.all(kids.map((kid) => kid.exited))
    expect([...kinds].sort()).toEqual(["refused", "tripwire"])
  })

  test("refuses a fourth quarantine within a minute from one session, and lets another go", () => {
    const roots = machine()
    for (const name of ["a", "b", "c"])
      expect(quarantine(file(join(roots.home, name)), opts, roots, { now: NOW })).toHaveProperty(
        "id",
      )
    const fourth = file(join(roots.home, "d"))
    const later = new Date(NOW.getTime() + 30_000)
    expect(quarantine(fourth, opts, roots, { now: later })).toMatchObject({ kind: "tripwire" })
    expect(quarantine(fourth, { ...opts, session: "other" }, roots, { now: later })).toHaveProperty(
      "id",
    )
    const fifth = file(join(roots.home, "e"))
    const minuteOn = new Date(NOW.getTime() + 61_000)
    expect(quarantine(fifth, opts, roots, { now: minuteOn })).toHaveProperty("id")
  })
})

const git = (cwd: string, ...args: string[]) => {
  const run = Bun.spawnSync(["git", "-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd })
  if (run.exitCode !== 0) throw new Error(run.stderr.toString())
  return run.stdout.toString().trim()
}

// A main checkout with a remote, and a worktree on branch PG-1-thing whose one commit is not pushed; its holders call that commit's PR merged, so a test of the holders meets no landed check.
const withWorktree = () => {
  const roots = machine()
  const remote = join(roots.root, "remote.git")
  git(roots.root, "init", "--bare", "-q", remote)
  git(roots.main, "init", "-q", "-b", "canary")
  file(join(roots.main, "README.md"))
  git(roots.main, "add", ".")
  git(roots.main, "commit", "-qm", "init")
  git(roots.main, "remote", "add", "origin", remote)
  git(roots.main, "push", "-q", "origin", "canary")
  const wt = join(roots.main, ".claude", "worktrees", "pg-1")
  git(roots.main, "worktree", "add", "-q", "-b", "PG-1-thing", wt)
  file(join(wt, "new.txt"))
  git(wt, "add", ".")
  git(wt, "commit", "-qm", "work")
  const roster = join(roots.root, "roster.json")
  writeFileSync(roster, JSON.stringify({ agents: [] }))
  const holders = {
    clones: (): Clone[] => [],
    discard: false,
    live: ["working"],
    merged: (_sha: string, _at: string): boolean | null => true,
    places: (): string[] => [],
    procs: [] as Proc[] | null,
    roster,
  }
  return { holders, roots, wt }
}

// A carve-out table for the mechanism's own cases: one script's builds folder, under a cap of 3 files and 100 bytes.
const TABLE: Record<string, CarveOut> = {
  builder: { bytes: 100, files: 3, folder: "ops/builds" },
  trashy: { bytes: 100, files: 3, folder: "." },
}
const carved = { ...opts, carveOut: "builder" }

describe("a carve-out", () => {
  test("lets an entry directly in its folder through, records it, and restore puts it back", () => {
    const roots = machine()
    const path = file(join(roots.home, ".playground", "ops", "builds", "abc", "web"))
    const moved = quarantine(join(path, ".."), carved, roots, { carveOuts: TABLE, now: NOW })
    expect(moved).toMatchObject({ files: 1 })
    expect(existsSync(path)).toBe(false)
    const [entry] = listTrash(roots.trash)
    expect(entry).toMatchObject({ carveOut: "builder", path: join(path, "..") })
    expect(restore(entry!.id, roots, TABLE)).toEqual({ path: join(path, "..") })
    expect(readFileSync(path, "utf8")).toBe("x")
  })

  test("without its name the same entry stays protected", () => {
    const roots = machine()
    const path = file(join(roots.home, ".playground", "ops", "builds", "abc"))
    expect(quarantine(path, opts, roots, { carveOuts: TABLE, now: NOW })).toMatchObject({
      kind: "protected",
    })
    expect(existsSync(path)).toBe(true)
  })

  test.each([
    ["its folder itself", (home: string) => join(home, ".playground", "ops", "builds")],
    ["its parent", (home: string) => join(home, ".playground", "ops")],
    [
      "a sibling folder's entry",
      (home: string) => join(home, ".playground", "ops", "other", "abc"),
    ],
    [
      "an entry deeper in its folder",
      (home: string) => join(home, ".playground", "ops", "builds", "abc", "web"),
    ],
  ])("refuses %s and moves nothing", (_, pathOf) => {
    const roots = machine()
    file(join(roots.home, ".playground", "ops", "builds", "abc", "web", "x"))
    file(join(roots.home, ".playground", "ops", "other", "abc", "x"))
    const path = pathOf(roots.home)
    expect(quarantine(path, carved, roots, { carveOuts: TABLE, now: NOW })).toMatchObject({
      kind: "protected",
    })
    expect(existsSync(path)).toBe(true)
    expect(listTrash(roots.trash)).toEqual([])
  })

  test.each([
    ["files", (dir: string) => ["a", "b", "c", "d"].forEach((name) => file(join(dir, name)))],
    ["bytes", (dir: string) => void file(join(dir, "big"), "x".repeat(101))],
  ])("refuses an entry over its cap in %s as a tripwire", (_, fill) => {
    const roots = machine()
    const dir = join(roots.home, ".playground", "ops", "builds", "abc")
    fill(dir)
    expect(quarantine(dir, carved, roots, { carveOuts: TABLE, now: NOW })).toMatchObject({
      kind: "tripwire",
      refused: expect.stringContaining("builder carve-out's cap"),
    })
    expect(existsSync(dir)).toBe(true)
  })

  test("follows a data folder outside HOME", () => {
    const roots = { ...machine(), trash: "" }
    roots.trash = join(roots.root, "data", "trash")
    const path = file(join(roots.root, "data", "ops", "builds", "abc"))
    expect(quarantine(path, carved, roots, { carveOuts: TABLE, now: NOW })).toMatchObject({
      files: 1,
    })
    const home = file(join(roots.home, ".playground", "ops", "builds", "abc"))
    expect(quarantine(home, carved, roots, { carveOuts: TABLE, now: NOW })).toMatchObject({
      kind: "protected",
    })
  })

  test("refuses a name no carve-out has, a link out of its folder, and the trash in its folder", () => {
    const roots = machine()
    const path = file(join(roots.home, ".playground", "ops", "builds", "abc"))
    expect(
      quarantine(path, { ...opts, carveOut: "nobody" }, roots, { carveOuts: TABLE, now: NOW }),
    ).toMatchObject({
      kind: "protected",
      refused: expect.stringContaining("no carve-out is named"),
    })
    const link = join(roots.home, ".playground", "ops", "builds", "ssh")
    symlinkSync(join(roots.home, ".ssh"), link)
    expect(quarantine(link, carved, roots, { carveOuts: TABLE, now: NOW })).toMatchObject({
      kind: "protected",
    })
    mkdirSync(roots.trash, { recursive: true })
    expect(
      quarantine(roots.trash, { ...opts, carveOut: "trashy" }, roots, {
        carveOuts: TABLE,
        now: NOW,
      }),
    ).toMatchObject({ kind: "protected" })
    expect(existsSync(join(roots.home, ".ssh", "id_ed25519"))).toBe(true)
    expect(existsSync(roots.trash)).toBe(true)
  })
})

// Every real carve-out: one exact folder in the data folder or HOME, a cap within the tripwire's, its own entry let through, and its parent, a sibling and an entry over its cap refused.
describe.each(Object.entries(CARVE_OUTS))("the %s carve-out", (name, carve) => {
  test("names one exact folder in the data folder or HOME, beside the trash, under a cap within the tripwire's", () => {
    const parts = carve.folder.split("/")
    expect(parts.every((part) => part && part !== "." && part !== "..")).toBe(true)
    expect(parts[0]).not.toBe("trash")
    expect(carve.files).toBeLessThanOrEqual(LIMITS.files)
    expect(carve.bytes).toBeLessThanOrEqual(LIMITS.bytes)
  })

  test("lets its own entry through and refuses its parent, a sibling and an entry over its cap", () => {
    const roots = machine()
    const folder = join(roots.home, carve.home ? "" : ".playground", carve.folder)
    // a named carve-out's own entry is the file its pattern takes: a Playground plist or unit, or a kept page
    const named = (stem: string) =>
      [`com.playground.${stem}.plist`, `com.playground.${stem}.service`, `${stem}.html`].find((n) =>
        carve.name!.test(n),
      )!
    const own = file(join(folder, carve.name ? named("own") : "own"))
    const sibling = file(join(folder, "..", "sibling-of-carve-out", "own"))
    const over = join(folder, carve.name ? named("over") : "over")
    if (carve.name) file(over, "x".repeat(carve.bytes + 1))
    else file(join(over, "big"), "x".repeat(Math.min(carve.bytes + 1, 4096)))
    if (!carve.name && carve.bytes >= 4096)
      for (let i = 0; i <= carve.files; i++) file(join(over, `f${i}`))
    const carved = { ...opts, carveOut: name }
    expect(quarantine(own, carved, roots, { now: NOW })).toMatchObject({ files: 1 })
    expect(quarantine(join(folder, ".."), carved, roots, { now: NOW })).toMatchObject({
      kind: "protected",
    })
    expect(quarantine(sibling, carved, roots, { now: NOW })).toMatchObject({ kind: "protected" })
    expect(quarantine(over, { ...carved, session: "over-cap" }, roots, { now: NOW })).toMatchObject(
      {
        kind: "tripwire",
      },
    )
  })

  // #2238: a carve-out whose folder is a symlink into a protected folder would move a file out of the link's target, so every carve-out takes its folder only as a real one, and its refusal names the link and where it leads.
  test.each([".ssh", ".config"])(
    "refuses its folder as a symlink into %s, and the target keeps its file",
    (target) => {
      const roots = machine()
      const folder = join(roots.home, carve.home ? "" : ".playground", carve.folder)
      const into = join(roots.home, target)
      const entry = carve.name
        ? [`com.playground.x.plist`, `com.playground.x.service`, `notes.html`].find((n) =>
            carve.name!.test(n),
          )!
        : "notes"
      const kept = file(join(into, entry), "secret")
      mkdirSync(dirname(folder), { recursive: true })
      symlinkSync(into, folder)
      const moved = quarantine(join(folder, entry), { ...opts, carveOut: name }, roots, {
        now: NOW,
      })
      expect(moved).toMatchObject({
        kind: "protected",
        refused: expect.stringContaining(
          `${folder}, the ${name} carve-out's folder, goes through the symlink ${folder} and leads to ${into}`,
        ),
      })
      expect(readFileSync(kept, "utf8")).toBe("secret")
    },
  )
})

// jobs.ts boots out a turned-off launchd job and moves its installed plist from HOME's LaunchAgents, which holds every other app's agents too.
test("the jobs-installed carve-out moves only a plain com.playground plist, and restore puts it back", () => {
  const roots = machine()
  const agents = join(roots.home, "Library", "LaunchAgents")
  const named = { ...opts, carveOut: "jobs-installed" }
  const ours = file(join(agents, "com.playground.ops-x.plist"), "ours")
  const theirs = file(join(agents, "com.other.agent.plist"), "theirs")
  const folder = join(agents, "com.playground.ops-dir.plist")
  file(join(folder, "a"))
  const link = join(agents, "com.playground.ops-link.plist")
  symlinkSync(theirs, link)
  for (const path of [theirs, folder, link])
    expect(quarantine(path, named, roots, { now: NOW })).toMatchObject({
      kind: "protected",
      refused: expect.stringContaining("not a file the jobs-installed carve-out names"),
    })
  expect(readFileSync(theirs, "utf8")).toBe("theirs")
  expect(existsSync(join(folder, "a"))).toBe(true)
  expect(quarantine(ours, named, roots, { now: NOW })).toMatchObject({ files: 1 })
  expect(existsSync(ours)).toBe(false)
  const [entry] = listTrash(roots.trash)
  expect(restore(entry!.id, roots)).toEqual({ path: ours })
  expect(readFileSync(ours, "utf8")).toBe("ours")
})

// #2238: on Linux ~/.config is often a dotfiles link. Into a protected folder the jobs-units refusal names the link on the way and where it leads, for Ops to act on; into a folder nothing protects, the unit moves as before.
test("the jobs-units carve-out names the link and its real path behind a linked parent, and a link to an unprotected folder still moves", () => {
  const roots = machine()
  const link = join(roots.home, ".config", "systemd")
  const folder = join(link, "user")
  const unit = "com.playground.x.service"
  const units = { ...opts, carveOut: "jobs-units" }
  const protectedDots = join(roots.home, ".playground", "dotfiles", "systemd")
  const kept = file(join(protectedDots, "user", unit), "unit")
  symlinkSync(protectedDots, link)
  expect(quarantine(join(folder, unit), units, roots, { now: NOW })).toMatchObject({
    kind: "protected",
    refused: expect.stringContaining(
      `${folder}, the jobs-units carve-out's folder, goes through the symlink ${link} and leads to ${join(protectedDots, "user")}`,
    ),
  })
  expect(readFileSync(kept, "utf8")).toBe("unit")
  const plainDots = join(roots.root, "dotfiles", "systemd")
  file(join(plainDots, "user", unit), "unit")
  rmSync(link)
  symlinkSync(plainDots, link)
  expect(quarantine(join(folder, unit), units, roots, { now: NOW })).toMatchObject({ files: 1 })
  expect(existsSync(join(plainDots, "user", unit))).toBe(false)
})

// #2203: on Linux jobs.ts disables a turned-off job and moves its unit from ~/.config/systemd/user, which holds every other user unit too.
test("the jobs-units carve-out moves only a plain com.playground unit, and restore puts it back", () => {
  const roots = machine()
  const units = join(roots.home, ".config", "systemd", "user")
  const named = { ...opts, carveOut: "jobs-units" }
  const ours = file(join(units, "com.playground.ops-x.service"), "ours")
  const theirs = file(join(units, "syncthing.service"), "theirs")
  const plist = file(join(units, "com.playground.ops-x.plist"), "plist")
  const folder = join(units, "com.playground.ops-dir.service")
  file(join(folder, "a"))
  const link = join(units, "com.playground.ops-link.service")
  symlinkSync(theirs, link)
  const deeper = file(join(units, "default.target.wants", "com.playground.ops-x.service"))
  for (const path of [theirs, plist, folder, link])
    expect(quarantine(path, named, roots, { now: NOW })).toMatchObject({
      kind: "protected",
      refused: expect.stringContaining("not a file the jobs-units carve-out names"),
    })
  expect(quarantine(deeper, named, roots, { now: NOW })).toMatchObject({ kind: "protected" })
  expect(readFileSync(theirs, "utf8")).toBe("theirs")
  expect(existsSync(join(folder, "a"))).toBe(true)
  expect(existsSync(deeper)).toBe(true)
  expect(quarantine(ours, named, roots, { now: NOW })).toMatchObject({ files: 1 })
  expect(existsSync(ours)).toBe(false)
  const [entry] = listTrash(roots.trash)
  expect(restore(entry!.id, roots)).toEqual({ path: ours })
  expect(readFileSync(ours, "utf8")).toBe("ours")
})

test("linkPlaces lists each marked scratch folder in a temp folder, and each session's scratchpad with the folders directly in it", () => {
  const roots = machine()
  const tmp = join(roots.root, "tmp")
  mkdirSync(tmp)
  const marked = makeScratch("audit-base-", tmp)
  mkdirSync(join(tmp, "unmarked"))
  const pad = join(roots.root, "claude-501", "-Users-x-playground", "session-1", "scratchpad")
  mkdirSync(join(pad, "canary"), { recursive: true })
  file(join(pad, "notes.md"))
  mkdirSync(join(roots.root, "claude-501", "-Users-x-playground", "session-2"))
  expect(linkPlaces([tmp, tmp], join(roots.root, "claude-501"))).toEqual([
    marked,
    pad,
    join(pad, "canary"),
  ])
  expect(linkPlaces([join(roots.root, "none")], join(roots.root, "none"))).toEqual([])
})

describe("worktreeRefusal", () => {
  test("refuses when the roster cannot be read", () => {
    const { holders, roots, wt } = withWorktree()
    writeFileSync(holders.roster, "{not json")
    expect(worktreeRefusal(wt, roots, holders)).toContain("roster")
    expect(worktreeRefusal(wt, roots, { ...holders, roster: join(roots.root, "none") })).toContain(
      "roster",
    )
  })

  test("refuses a folder outside .claude/worktrees", () => {
    const { holders, roots } = withWorktree()
    expect(worktreeRefusal(join(roots.home, "x"), roots, holders)).toContain(".claude/worktrees")
  })

  // PG-1419: a merged or closed PR frees its worktree from a row naming its branch or that PR's own number, and says so
  test("a freed worktree passes a live row naming it by branch or by the freed PR, and a row by name or by another PR still holds it", () => {
    const { holders, roots, wt } = withWorktree()
    git(wt, "push", "-q", "origin", "PG-1-thing")
    const rosterOf = (agents: object[]) => writeFileSync(holders.roster, JSON.stringify({ agents }))
    const said: string[] = []
    const freedBy = (number: number, head = git(wt, "rev-parse", "HEAD")) => ({
      ...holders,
      freed: { head, number, state: "MERGED" as const },
      note: (line: string) => void said.push(line.slice(line.indexOf(" is freed"))),
    })
    rosterOf([{ branch: "PG-1-thing", name: "abc123-worker", status: "working" }])
    expect(worktreeRefusal(wt, roots, freedBy(1))).toBeNull()
    rosterOf([{ name: "x9y8z7-reviewer", pr: "https://github.com/o/r/pull/1", status: "working" }])
    expect(worktreeRefusal(wt, roots, freedBy(1))).toBeNull()
    expect(said).toEqual([
      " is freed by #1, which reads MERGED, past abc123-worker's roster row (working)",
      " is freed by #1, which reads MERGED, past x9y8z7-reviewer's roster row (working)",
    ])
    expect(worktreeRefusal(wt, roots, freedBy(2))).toContain("x9y8z7-reviewer")
    rosterOf([{ name: "pg-1", status: "working" }])
    expect(worktreeRefusal(wt, roots, freedBy(1))).toContain("pg-1")
  })

  // PG-1419: commits past the merged PR's head keep the row's hold, named with them, so a discard cannot take unmerged work
  test("a freed PR whose head the worktree has moved past keeps a row naming its branch, its commit named, and a row by name still holds it plainly", () => {
    const { holders, roots, wt } = withWorktree()
    git(wt, "push", "-q", "origin", "PG-1-thing")
    const freed = { head: git(wt, "rev-parse", "HEAD~1"), number: 1, state: "MERGED" as const }
    const rosterOf = (agents: object[]) => writeFileSync(holders.roster, JSON.stringify({ agents }))
    rosterOf([{ branch: "PG-1-thing", name: "abc123-worker", status: "working" }])
    expect(worktreeRefusal(wt, roots, { ...holders, freed })).toBe(
      `${wt} is held by abc123-worker, which the roster lists as working, and its commits past merged PR #1's head stay: ${git(wt, "rev-parse", "--short", "HEAD")}`,
    )
    rosterOf([{ name: "pg-1", status: "working" }])
    expect(worktreeRefusal(wt, roots, { ...holders, freed })).toBe(
      `${wt} is held by pg-1, which the roster lists as working`,
    )
  })

  // PG-2017: a clean detached checkout at a commit origin/canary holds is a reader of canary, not the row's work; each broken condition keeps the hold. The row holds by the folder's name, since a detached tree reads no branch.
  test("a clean detached checkout at a commit origin/canary holds passes a live row whole, and a dirty, untracked, branched or past-canary one keeps it", () => {
    const row = [{ name: "pg-1", status: "working" }]
    const withRow = () => {
      const w = withWorktree()
      writeFileSync(w.holders.roster, JSON.stringify({ agents: row }))
      return w
    }
    const clean = withRow()
    git(clean.wt, "checkout", "-q", "--detach", "origin/canary")
    expect(worktreeRefusal(clean.wt, clean.roots, clean.holders)).toBeNull()
    const dirty = withRow()
    git(dirty.wt, "checkout", "-q", "--detach", "origin/canary")
    file(join(dirty.wt, "README.md"), "dirty")
    expect(worktreeRefusal(dirty.wt, dirty.roots, dirty.holders)).toContain("is held by pg-1")
    const untracked = withRow()
    git(untracked.wt, "checkout", "-q", "--detach", "origin/canary")
    file(join(untracked.wt, "extra.txt"), "x")
    expect(worktreeRefusal(untracked.wt, untracked.roots, untracked.holders)).toContain(
      "is held by pg-1",
    )
    const branched = withRow()
    git(branched.wt, "checkout", "-q", "-B", "PG-1-thing", "origin/canary")
    expect(worktreeRefusal(branched.wt, branched.roots, branched.holders)).toContain(
      "is held by pg-1",
    )
    const past = withRow()
    git(past.wt, "checkout", "-q", "--detach", "PG-1-thing")
    expect(worktreeRefusal(past.wt, past.roots, past.holders)).toContain("is held by pg-1")
  })

  // status.showUntrackedFiles=no hides an untracked file from a plain git status --porcelain, so both clean-tree reads name every untracked file themselves.
  test("an untracked file counts under status.showUntrackedFiles=no: it keeps a live row's hold on a detached canary checkout, and is named as an uncommitted change", () => {
    const held = withWorktree()
    git(held.roots.main, "config", "status.showUntrackedFiles", "no")
    writeFileSync(
      held.holders.roster,
      JSON.stringify({ agents: [{ name: "pg-1", status: "working" }] }),
    )
    git(held.wt, "checkout", "-q", "--detach", "origin/canary")
    file(join(held.wt, "extra.txt"), "x")
    expect(worktreeRefusal(held.wt, held.roots, held.holders)).toContain("is held by pg-1")
    const changed = withWorktree()
    git(changed.roots.main, "config", "status.showUntrackedFiles", "no")
    file(join(changed.wt, "extra.txt"), "x")
    expect(worktreeRefusal(changed.wt, changed.roots, changed.holders)).toContain(
      "holds 1 uncommitted change (extra.txt)",
    )
  })

  test("refuses a worktree a live session holds by branch, by name, or by a process's folder", () => {
    const { holders, roots, wt } = withWorktree()
    git(wt, "push", "-q", "origin", "PG-1-thing")
    const rosterOf = (agents: object[]) => writeFileSync(holders.roster, JSON.stringify({ agents }))
    rosterOf([{ branch: "PG-1-thing", name: "abc123-worker", status: "working" }])
    expect(worktreeRefusal(wt, roots, holders)).toContain("abc123-worker")
    rosterOf([{ name: "pg-1", status: "working" }])
    expect(worktreeRefusal(wt, roots, holders)).toContain("pg-1")
    rosterOf([
      null,
      { name: "x9y8z7-reviewer", pr: "https://github.com/o/r/pull/1", status: "working" },
    ])
    expect(worktreeRefusal(wt, roots, holders)).toContain("x9y8z7-reviewer")
    rosterOf([{ name: "x9y8z7-reviewer", pr: "https://github.com/o/r/pull/11", status: "working" }])
    expect(worktreeRefusal(wt, roots, holders)).toBeNull()
    // the merging worker of the PR whose checker used the worktree holds it by that PR's number alone, which counts for any other PR
    rosterOf([{ name: "abc123-worker", pr: "https://github.com/o/r/pull/1", status: "working" }])
    const of = (pr: string) => worktreeRefusal(wt, roots, { ...holders, pr })
    expect(of("https://github.com/o/r/pull/1")).toBeNull()
    expect(of("https://github.com/o/r/pull/2")).toContain("abc123-worker")
    rosterOf([
      {
        branch: "PG-1-thing",
        name: "abc123-worker",
        pr: "https://github.com/o/r/pull/1",
        status: "working",
      },
    ])
    expect(of("https://github.com/o/r/pull/1")).toContain("abc123-worker")
    rosterOf([{ branch: "PG-1-thing", name: "abc123-worker", status: "ended" }])
    expect(worktreeRefusal(wt, roots, holders)).toBeNull()
    expect(
      worktreeRefusal(wt, roots, { ...holders, procs: [proc(7, "zsh", join(wt, "packages"))] }),
    ).toContain("pid 7")
    expect(worktreeRefusal(wt, roots, { ...holders, procs: null })).toContain("process")
  })

  // PG-2154: a checker serves every PR in its prs list, so a PR there holds the clone as its pr does, and --pr lifts it the same way
  test("a live row holds a worktree by a PR in its prs list, a row whose pr and prs leave it out does not, and --pr lifts a prs hold as it lifts a pr one", () => {
    const { holders, roots, wt } = withWorktree()
    git(wt, "push", "-q", "origin", "PG-1-thing")
    const rosterOf = (agents: object[]) => writeFileSync(holders.roster, JSON.stringify({ agents }))
    const url = (n: number) => `https://github.com/o/r/pull/${n}`
    rosterOf([{ name: "x9y8z7-reviewer", pr: url(11), prs: [url(11), url(1)], status: "working" }])
    expect(worktreeRefusal(wt, roots, holders)).toContain("x9y8z7-reviewer")
    rosterOf([{ name: "x9y8z7-reviewer", prs: [url(1)], status: "working" }])
    expect(worktreeRefusal(wt, roots, holders)).toContain("x9y8z7-reviewer")
    rosterOf([{ name: "x9y8z7-reviewer", pr: url(11), prs: [url(11), url(12)], status: "working" }])
    expect(worktreeRefusal(wt, roots, holders)).toBeNull()
    rosterOf([{ name: "abc123-worker", pr: url(11), prs: [url(11), url(1)], status: "working" }])
    const of = (pr: string) => worktreeRefusal(wt, roots, { ...holders, pr })
    expect(of(url(1))).toBeNull()
    expect(of(url(2))).toContain("abc123-worker")
    // the lift frees the one PR it names: another PR in the same prs list that names the folder still holds it
    const other = "https://github.com/o/other/pull/1"
    rosterOf([{ name: "abc123-worker", prs: [url(1), other], status: "working" }])
    expect(of(url(1))).toContain("abc123-worker")
    expect(of(other)).toContain("abc123-worker")
  })

  test("rowPullRequests reads a row's pr and every pull request in its prs once each, leaving out an issue's URL, an extension item and a non-string", () => {
    const url = (n: number) => `https://github.com/o/r/pull/${n}`
    expect(
      rowPullRequests({
        pr: url(1),
        prs: [url(1), url(2), "https://github.com/o/r/issues/3", "home/doc/plan-x", 4],
      }),
    ).toEqual([url(1), url(2)])
    expect(rowPullRequests({ prs: "not a list" })).toEqual([])
    expect(rowPullRequests({})).toEqual([])
  })

  test("a live session holds a folder by its name only when the slug after PG-<n>- is that name or starts with it and a dash", () => {
    const { holders, roots } = withWorktree()
    // [folder, branch, live session, held]
    const cases: [string, string, string, boolean][] = [
      ["PG-864-second-dispatcher", "PG-864-second-dispatcher", "dispatcher", false],
      ["PG-5-splint", "PG-5-splint", "lint", false],
      ["PG-6-lintdesk", "PG-6-lintdesk", "lint", false],
      ["PG-12-lint", "PG-12-lint", "lint", true],
      ["PG-13-lint-job", "PG-13-lint-job", "lint", true],
      ["PG-14-misc", "PG-14-lint-fix", "lint", true],
    ]
    const seen = cases.map(([folder, branch, name]) => {
      const at = join(roots.main, ".claude", "worktrees", folder)
      git(roots.main, "worktree", "add", "-q", "-b", branch, at)
      writeFileSync(holders.roster, JSON.stringify({ agents: [{ name, status: "working" }] }))
      const holds = `${at} is held by ${name}, which the roster lists as working`
      return [folder, worktreeRefusal(at, roots, holders) === holds]
    })
    expect(seen).toEqual(cases.map(([folder, , , held]) => [folder, held]))
  })

  // A manager seat names the work it routes, not a worktree, so its name holds none, while its branch or PR still does
  describe("a manager seat's name", () => {
    const seat = (folder: string, agent: object) => {
      const { holders, roots } = withWorktree()
      const at = join(roots.main, ".claude", "worktrees", folder)
      git(roots.main, "worktree", "add", "-q", "-b", folder, at)
      writeFileSync(holders.roster, JSON.stringify({ agents: [agent] }))
      return { at, holders, roots }
    }

    test.each(ROSTER_KINDS.filter(hasManagerRole))(
      "a live %s row holds no worktree by its name alone",
      (kind) => {
        const { at, holders, roots } = seat(`PG-9-${kind}-thing`, {
          kind,
          name: kind,
          status: "working",
        })
        const freed = { head: git(at, "rev-parse", "HEAD"), number: 9, state: "MERGED" as const }
        expect(worktreeRefusal(at, roots, { ...holders, freed })).toBeNull()
      },
    )

    test("a live ops row whose branch is the worktree's still holds it", () => {
      const { at, holders, roots } = seat("PG-9-ops-thing", {
        branch: "PG-9-ops-thing",
        kind: "ops",
        name: "ops",
        status: "working",
      })
      expect(worktreeRefusal(at, roots, holders)).toBe(
        `${at} is held by ops, which the roster lists as working`,
      )
    })

    test("a live worker row still holds a worktree by its name", () => {
      const { at, holders, roots } = seat("PG-9-ab12cd-worker-x", {
        kind: "worker",
        name: "ab12cd-worker",
        status: "working",
      })
      expect(worktreeRefusal(at, roots, holders)).toBe(
        `${at} is held by ab12cd-worker, which the roster lists as working`,
      )
    })
  })

  test("refuses a worktree a running node_modules clone reads from or copies into, naming the clone, and lets it go once the clone is gone", () => {
    const { holders, roots, wt } = withWorktree()
    git(wt, "push", "-q", "origin", "PG-1-thing")
    const other = join(roots.main, ".claude", "worktrees", "pg-2")
    const clone = (source: string, destination: string): Clone => ({
      destination,
      pid: 4242,
      source,
      who: "k3m9px-worker",
    })
    expect(worktreeRefusal(wt, roots, { ...holders, clones: () => [clone(wt, other)] })).toBe(
      `${wt} is held by k3m9px-worker's node_modules clone (pid 4242) from ${wt} into ${other}`,
    )
    expect(worktreeRefusal(wt, roots, { ...holders, clones: () => [clone(other, wt)] })).toContain(
      `from ${other} into ${wt}`,
    )
    expect(
      worktreeRefusal(wt, roots, { ...holders, clones: () => [clone(other, roots.main)] }),
    ).toBeNull()
    expect(worktreeRefusal(wt, roots, holders)).toBeNull()
  })

  test("names a holder's pid and command, and an agent-browser daemon's session and the close that frees it", () => {
    const { holders, roots, wt } = withWorktree()
    git(wt, "push", "-q", "origin", "PG-1-thing")
    const refusal = (...procs: Proc[]) => worktreeRefusal(wt, roots, { ...holders, procs })
    const away = proc(3, "zsh", roots.home)
    expect(refusal(away)).toBeNull()
    expect(refusal(away, proc(41, "bun run dev", join(wt, "api")))).toBe(
      `${wt} is held by pid 41 (bun run dev) working in ${join(wt, "api")}`,
    )
    const long = `/opt/chrome/Google Chrome for Testing --type=renderer ${"--flag ".repeat(30)}`
    expect(refusal(proc(42, long, wt))).toBe(
      `${wt} is held by pid 42 (${long.slice(0, 117)}...) working in ${wt}`,
    )
    const daemon = "/x/node_modules/agent-browser/bin/agent-browser-darwin-arm64"
    const bySocket = proc(43, daemon, wt, ["/h/.agent-browser/verify-1-shots.sock"])
    expect(refusal(proc(42, long, wt), bySocket)).toBe(
      `${wt} is held by pid 43 (${daemon}) working in ${wt}: agent-browser session verify-1-shots, which agent-browser --session verify-1-shots close frees`,
    )
    expect(refusal(proc(44, "agent-browser --session s2 open http://x", wt))).toContain(
      "agent-browser --session s2 close",
    )
    // a bare daemon with no --session and no .sock shows no name, so the line names none and has the reader close their own
    const bare = refusal(proc(45, daemon, wt))
    expect(bare).toBe(
      `${wt} is held by pid 45 (${daemon}) working in ${wt}: an agent-browser session whose name it does not show, so close your own by its name: agent-browser --session <your-name> close`,
    )
    expect(bare).not.toContain("default")
  })

  test("refuses a worktree another worktree's node_modules links into, naming the link", () => {
    const { holders, roots, wt } = withWorktree()
    mkdirSync(join(wt, "node_modules"))
    const sibling = join(roots.main, ".claude", "worktrees", "pg-2")
    mkdirSync(sibling)
    const link = join(sibling, "node_modules")
    symlinkSync(join(wt, "node_modules"), link)
    expect(worktreeRefusal(wt, roots, holders)).toBe(
      `${wt} is linked into by ${link} -> ${join(wt, "node_modules")}: repoint or remove each link first`,
    )
    expect(worktreeRefusal(wt, roots, { ...holders, discard: true })).toContain("is linked into by")
  })

  test("refuses a worktree a scratch folder's copy links into, one level down its node_modules", () => {
    const { holders, roots, wt } = withWorktree()
    mkdirSync(join(wt, "node_modules", "zod"), { recursive: true })
    const copy = join(roots.root, "scratch", "canary")
    mkdirSync(join(copy, "node_modules"), { recursive: true })
    const link = join(copy, "node_modules", "zod")
    symlinkSync(join(wt, "node_modules", "zod"), link)
    expect(worktreeRefusal(wt, roots, { ...holders, places: () => [copy] })).toBe(
      `${wt} is linked into by ${link} -> ${join(wt, "node_modules", "zod")}: repoint or remove each link first`,
    )
  })

  test("names the first three links and counts the rest", () => {
    const { holders, roots, wt } = withWorktree()
    const copy = join(roots.root, "scratch", "canary")
    mkdirSync(copy, { recursive: true })
    for (const n of [1, 2, 3, 4, 5]) symlinkSync(wt, join(copy, `l${n}`))
    const refusal = worktreeRefusal(wt, roots, { ...holders, places: () => [copy] })
    expect(refusal).toStartWith(`${wt} is linked into by ${join(copy, "l1")} -> ${wt}, `)
    expect(refusal).toEndWith(", and 2 more: repoint or remove each link first")
  })

  test("moves a worktree no link points into: a missing target, another worktree and its own links pass", () => {
    const { holders, roots, wt } = withWorktree()
    writeFileSync(join(roots.main, ".git", "info", "exclude"), "node_modules\n")
    mkdirSync(join(wt, "node_modules"))
    symlinkSync(join(wt, "README.md"), join(wt, "node_modules", "own"))
    const other = join(roots.main, ".claude", "worktrees", "pg-3")
    mkdirSync(join(other, "node_modules"), { recursive: true })
    const sibling = join(roots.main, ".claude", "worktrees", "pg-2")
    mkdirSync(sibling)
    symlinkSync(join(other, "node_modules"), join(sibling, "node_modules"))
    symlinkSync(join(wt, "gone"), join(sibling, "dangling"))
    const copy = join(roots.root, "scratch", "canary")
    mkdirSync(copy, { recursive: true })
    symlinkSync(join(roots.root, "remote.git"), join(copy, "remote"))
    const places = () => [copy, join(roots.root, "missing")]
    expect(worktreeRefusal(wt, roots, { ...holders, places })).toBeNull()
    expect(quarantine(wt, { ...opts, worktree: { ...holders, places } }, roots)).toHaveProperty(
      "id",
    )
  })

  test("quarantine runs the holder check itself, so a held worktree stays", () => {
    const { holders, roots, wt } = withWorktree()
    git(wt, "push", "-q", "origin", "PG-1-thing")
    writeFileSync(
      holders.roster,
      JSON.stringify({
        agents: [
          { name: "x9y8z7-reviewer", pr: "https://github.com/o/r/pull/1", status: "working" },
        ],
      }),
    )
    expect(quarantine(wt, { ...opts, worktree: holders }, roots, { now: NOW })).toMatchObject({
      refused: expect.stringContaining("x9y8z7-reviewer"),
    })
    expect(existsSync(wt)).toBe(true)
  })

  test("quarantine reads the clones again right before the move, so a clone that starts during the walk keeps the worktree", () => {
    const { holders, roots, wt } = withWorktree()
    git(wt, "push", "-q", "origin", "PG-1-thing")
    const other = join(roots.main, ".claude", "worktrees", "pg-2")
    const running: Clone[] = []
    const late = { ...holders, clones: () => running }
    // the volume check runs after the walk and before the move, so a clone registered there started inside the window
    const dev = () => {
      running.splice(0, running.length, {
        destination: other,
        pid: 4242,
        source: wt,
        who: "k3m9px-worker",
      })
      return 1
    }
    expect(quarantine(wt, { ...opts, worktree: late }, roots, { dev, now: NOW })).toEqual({
      kind: "refused",
      refused: `${wt} is held by k3m9px-worker's node_modules clone (pid 4242) from ${wt} into ${other}`,
    })
    expect(existsSync(wt)).toBe(true)
    const moved = quarantine(wt, { ...opts, worktree: holders }, roots, { dev: () => 1, now: NOW })
    expect("refused" in moved ? moved.refused : "moved").toBe("moved")
    const { files, size } = moved as Quarantined
    expect(files).toBeGreaterThan(1)
    expect(size).toBeGreaterThan(0)
    expect(listTrash(roots.trash).find((e) => e.path === wt)).toMatchObject({ files, size })
  })

  test("refuses a dirty worktree, naming its changes and --discard, and --discard lets it go", () => {
    const { holders, roots, wt } = withWorktree()
    file(join(wt, "wip.txt"))
    expect(worktreeRefusal(wt, roots, holders)).toBe(
      `${wt} holds 1 uncommitted change (wip.txt): playground rm --worktree ${wt} --discard removes it anyway, its commits no remote holds kept first in a git bundle beside it in the trash`,
    )
    for (const name of ["new.txt", "b", "c", "d"]) file(join(wt, name), "changed")
    expect(worktreeRefusal(wt, roots, holders)).toBe(
      `${wt} holds 5 uncommitted changes (new.txt, b, c, and 2 more): playground rm --worktree ${wt} --discard removes it anyway, its commits no remote holds kept first in a git bundle beside it in the trash`,
    )
    expect(worktreeRefusal(wt, roots, { ...holders, discard: true })).toBeNull()
    const moved = quarantine(wt, { ...opts, worktree: { ...holders, discard: true } }, roots, {
      now: NOW,
    })
    expect(moved).toHaveProperty("id")
    expect(existsSync(wt)).toBe(false)
  })

  test("refuses a worktree whose branch has not landed on canary or been pushed, and --discard lets it go", () => {
    const { holders, roots, wt } = withWorktree()
    const unmerged = { ...holders, merged: () => false }
    expect(worktreeRefusal(wt, roots, unmerged)).toBe(
      `${wt}'s HEAD holds work not landed on origin/canary or on any remote branch (fetch origin if it merged or was pushed since): playground rm --worktree ${wt} --discard removes it anyway, its commits no remote holds kept first in a git bundle beside it in the trash`,
    )
    expect(worktreeRefusal(wt, roots, { ...holders, merged: () => null })).toContain("not landed")
    expect(worktreeRefusal(wt, roots, { ...unmerged, discard: true })).toBeNull()
    expect(quarantine(wt, { ...opts, worktree: unmerged }, roots, { now: NOW })).toHaveProperty(
      "refused",
    )
    expect(existsSync(wt)).toBe(true)
  })

  // #1348
  test("--discard keeps a worktree's commits no remote holds in a bundle beside its move, named in its trash entry, which brings HEAD back at its sha", () => {
    const { holders, roots, wt } = withWorktree()
    const head = git(wt, "rev-parse", "HEAD")
    const discard = { ...holders, discard: true, merged: () => false }
    const moved = quarantine(wt, { ...opts, worktree: discard }, roots, { now: NOW }) as Quarantined
    const batch = dirname(dirname(moved.to))
    expect(moved.bundle).toBe(join(batch, "pg-1.bundle"))
    expect(readFileSync(join(batch, "pg-1.shas"), "utf8")).toBe(`${head} HEAD\n`)
    expect(listTrash(roots.trash).find((e) => e.path === wt)?.bundle).toBe(moved.bundle)
    git(roots.main, "worktree", "prune")
    git(roots.main, "branch", "-D", "PG-1-thing")
    git(roots.main, "fetch", "-q", moved.bundle!, "HEAD:refs/heads/back")
    expect(git(roots.main, "rev-parse", "back")).toBe(head)
  })

  test("--discard writes no bundle for a worktree whose every commit a remote holds", () => {
    const { holders, roots, wt } = withWorktree()
    git(wt, "push", "-q", "origin", "PG-1-thing")
    const discard = { ...holders, discard: true, merged: () => false }
    const moved = quarantine(wt, { ...opts, worktree: discard }, roots, { now: NOW }) as Quarantined
    expect(moved.id).toBeDefined()
    expect(moved.bundle).toBeUndefined()
    expect(readdirSync(dirname(dirname(moved.to))).filter((f) => f.endsWith(".bundle"))).toEqual([])
  })

  // #2132: a remote-tracking ref is the remote's branch as last fetched, so --discard reads the remote itself: a branch deleted there since, its tracking ref kept, and a remote that cannot be read each hold no commit
  test.each([
    [
      "whose remote branch was deleted since, its tracking ref kept",
      (roots: Roots) =>
        git(roots.root, "--git-dir", join(roots.root, "remote.git"), "branch", "-D", "PG-1-thing"),
    ],
    [
      "whose remote cannot be read",
      (roots: Roots & { root: string }) =>
        git(roots.main, "remote", "set-url", "origin", join(roots.root, "gone.git")),
    ],
  ])("--discard bundles the commits of a pushed worktree %s, which bring HEAD back", (_, arm) => {
    const { holders, roots, wt } = withWorktree()
    git(wt, "push", "-q", "origin", "PG-1-thing")
    arm(roots)
    expect(git(wt, "rev-parse", "--verify", "-q", "refs/remotes/origin/PG-1-thing")).not.toBe("")
    const head = git(wt, "rev-parse", "HEAD")
    const discard = { ...holders, discard: true, merged: () => false }
    const moved = quarantine(wt, { ...opts, worktree: discard }, roots, { now: NOW }) as Quarantined
    expect(existsSync(wt)).toBe(false)
    expect(moved.bundle).toBe(join(dirname(dirname(moved.to)), "pg-1.bundle"))
    git(roots.main, "worktree", "prune")
    git(roots.main, "branch", "-D", "PG-1-thing")
    git(roots.main, "fetch", "-q", moved.bundle!, "HEAD:refs/heads/back")
    expect(git(roots.main, "rev-parse", "back")).toBe(head)
  })

  // #2132: archiveUnlanded counts a commit as held only when the remote itself holds it now
  test("archiveUnlanded archives a commit whose remote branch was deleted since, its tracking ref kept, and leaves out one the remote holds", () => {
    const { roots, wt } = withWorktree()
    const archive = join(roots.root, "archive")
    const work = git(wt, "rev-parse", "HEAD")
    git(wt, "push", "-q", "origin", "PG-1-thing")
    expect(archiveUnlanded(wt, archive)).toEqual({
      refused: "it holds no commit past its remotes to archive",
    })
    git(roots.root, "--git-dir", join(roots.root, "remote.git"), "branch", "-D", "PG-1-thing")
    const path = join(archive, "playground", `pg-1-${work.slice(0, 7)}`)
    expect(archiveUnlanded(wt, archive)).toEqual({ count: 1, path })
    expect(
      readdirSync(path).map(
        (f) => /^From ([0-9a-f]+) /.exec(readFileSync(join(path, f), "utf8"))?.[1],
      ),
    ).toEqual([work])
  })

  // #2139: a remote that cannot be read gives no tip to archive past, so archiveUnlanded writes nothing and keeps the tree, then archives only what no remote holds once it reads
  test("archiveUnlanded refuses, writing no archive, while a remote cannot be read, then archives only the commits no remote holds once it reads", () => {
    const { roots, wt } = withWorktree()
    const archive = join(roots.root, "archive")
    git(wt, "push", "-q", "origin", "PG-1-thing")
    file(join(wt, "late.txt"))
    git(wt, "add", ".")
    git(wt, "commit", "-qm", "late")
    const late = git(wt, "rev-parse", "HEAD")
    const path = join(archive, "playground", `pg-1-${late.slice(0, 7)}`)
    git(roots.main, "remote", "set-url", "origin", join(roots.root, "gone.git"))
    expect(archiveUnlanded(wt, archive)).toEqual({
      refused: "its remote origin could not be read, so its work stays until it answers",
    })
    expect(existsSync(archive)).toBe(false)
    git(roots.main, "remote", "set-url", "origin", join(roots.root, "remote.git"))
    expect(archiveUnlanded(wt, archive)).toEqual({ count: 1, path })
    expect(
      readdirSync(path).map(
        (f) => /^From ([0-9a-f]+) /.exec(readFileSync(join(path, f), "utf8"))?.[1],
      ),
    ).toEqual([late])
  })

  // #2132: ssh's options go on the command git would run, so a configured core.sshCommand still reads the remote
  test("unpushed reads an ssh remote through core.sshCommand, with BatchMode and a connect limit added", () => {
    const { roots, wt } = withWorktree()
    const said = join(roots.root, "ssh-args")
    const ssh = file(join(roots.root, "fake-ssh"), `#!/bin/sh\necho "$@" > '${said}'\nexit 1\n`)
    chmodSync(ssh, 0o755)
    git(roots.main, "config", "core.sshCommand", ssh)
    // the test sandbox's git refuses ssh, so the repo allows it for this fake alone
    git(roots.main, "config", "protocol.ssh.allow", "always")
    git(roots.main, "remote", "set-url", "origin", "ssh://git@example.invalid/remote.git")
    expect(unpushed(wt)).toMatchObject({ unread: ["origin"] })
    expect(readFileSync(said, "utf8")).toStartWith("-o BatchMode=yes -o ConnectTimeout=10 ")
  })

  test("bundleToTrash holds each ref at its sha past the excluded ones, its sha list beside it, and leaves out a ref the exclusion holds", () => {
    const { roots, wt } = withWorktree()
    const head = git(wt, "rev-parse", "HEAD")
    const base = git(roots.main, "rev-parse", "canary")
    const made = bundleToTrash(
      roots.main,
      [
        { ref: "refs/heads/PG-1-thing", sha: head },
        { ref: "refs/heads/canary", sha: base },
      ],
      ["origin/canary"],
      { name: "branches", now: NOW, session: "nightly-clean", trash: roots.trash },
    )
    const path = join(roots.trash, "20261102T120000Z-nightly-clean", "branches.bundle")
    expect(made).toEqual({ held: ["refs/heads/PG-1-thing"], path })
    expect(readFileSync(join(dirname(path), "branches.shas"), "utf8")).toBe(
      `${head} refs/heads/PG-1-thing\n${base} refs/heads/canary\n`,
    )
    expect(
      bundleToTrash(roots.main, [{ ref: "refs/heads/PG-1-thing", sha: head }], ["origin/canary"], {
        name: "branches",
        now: NOW,
        session: "nightly-clean",
        trash: roots.trash,
      }),
    ).toEqual({ refused: `its bundle ${path} is taken or not a trash path` })
  })

  test("removes a clean worktree whose branch canary squash-merged, and asks for a merged PR once canary changes its files again", () => {
    const { holders, roots, wt } = withWorktree()
    const head = git(wt, "rev-parse", "HEAD")
    const asked: string[] = []
    const merged = (sha: string, at: string) => {
      asked.push(at)
      return sha === head
    }
    const unmerged = { ...holders, merged: () => false }
    file(join(roots.main, "new.txt"))
    git(roots.main, "add", ".")
    git(roots.main, "commit", "-qm", "the squash of PG-1-thing")
    git(roots.main, "push", "-q", "origin", "canary")
    expect(worktreeRefusal(wt, roots, unmerged)).toBeNull()
    file(join(roots.main, "new.txt"), "changed on canary since")
    git(roots.main, "commit", "-qam", "a later change")
    git(roots.main, "push", "-q", "origin", "canary")
    expect(worktreeRefusal(wt, roots, unmerged)).toContain("not landed")
    expect(worktreeRefusal(wt, roots, { ...holders, merged })).toBeNull()
    expect(asked).toEqual([wt])
    const moved = quarantine(wt, { ...opts, worktree: { ...holders, merged } }, roots, { now: NOW })
    expect(moved).toHaveProperty("id")
    expect(existsSync(wt)).toBe(false)
  })

  test("refuses unlanded work in a file whose name git quotes, and names a dirty one as it is", () => {
    const { holders, roots, wt } = withWorktree()
    const unmerged = { ...holders, merged: () => false }
    file(join(roots.main, "new.txt"))
    git(roots.main, "add", ".")
    git(roots.main, "commit", "-qm", "the squash of PG-1-thing")
    git(roots.main, "push", "-q", "origin", "canary")
    expect(worktreeRefusal(wt, roots, unmerged)).toBeNull()
    file(join(wt, "caf\u00e9.txt"))
    expect(worktreeRefusal(wt, roots, unmerged)).toContain("1 uncommitted change (caf\u00e9.txt)")
    git(wt, "add", ".")
    git(wt, "commit", "-qm", "more work")
    expect(worktreeRefusal(wt, roots, unmerged)).toContain("not landed")
  })

  test("removes a review clone detached at a merged PR's head, and a branch with no work of its own", () => {
    const { holders, roots, wt } = withWorktree()
    const unmerged = { ...holders, merged: () => false }
    git(wt, "checkout", "-q", "--detach")
    expect(worktreeRefusal(wt, roots, unmerged)).toContain("not landed")
    file(join(roots.main, "new.txt"))
    git(roots.main, "add", ".")
    git(roots.main, "commit", "-qm", "the squash of PG-1-thing")
    git(roots.main, "push", "-q", "origin", "canary")
    expect(worktreeRefusal(wt, roots, unmerged)).toBeNull()
    const fresh = join(roots.main, ".claude", "worktrees", "pg-2")
    git(roots.main, "worktree", "add", "-q", "-b", "PG-2-next", fresh, "HEAD~1")
    file(join(roots.main, "later.txt"))
    git(roots.main, "add", ".")
    git(roots.main, "commit", "-qm", "canary moves on")
    git(roots.main, "push", "-q", "origin", "canary")
    expect(worktreeRefusal(fresh, roots, unmerged)).toBeNull()
  })
})

describe("removeScratch", () => {
  test("removes a folder makeScratch made in the temp folder", () => {
    const { root } = machine()
    const tmp = join(root, "tmp")
    mkdirSync(tmp)
    const dir = makeScratch("job-", tmp)
    file(join(dir, "deep", "x"))
    expect(existsSync(join(dir, MARKER))).toBe(true)
    expect(removeScratch(dir, tmp)).toBeNull()
    expect(existsSync(dir)).toBe(false)
  })

  test("refuses a folder with no marker, one outside the temp folder, and a symlink", () => {
    const { home, root } = machine()
    const tmp = join(root, "tmp")
    mkdirSync(join(tmp, "plain"), { recursive: true })
    expect(removeScratch(join(tmp, "plain"), tmp)).toContain(MARKER)
    const away = join(home, "away")
    file(join(away, MARKER))
    expect(removeScratch(away, tmp)).toContain("temp folder")
    const made = makeScratch("job-", tmp)
    symlinkSync(made, join(tmp, "link"))
    expect(removeScratch(join(tmp, "link"), tmp)).toBeString()
    expect(existsSync(made)).toBe(true)
  })
})

describe("removeStale", () => {
  test("removes an old marked folder with the prefix, and keeps a young one, an unmarked one and a link to an old one", () => {
    const { root } = machine()
    const tmp = join(root, "tmp")
    mkdirSync(tmp)
    const now = new Date("2026-11-17T03:00:00Z")
    const at = (dir: string, h: number) => {
      const when = new Date(now.getTime() - h * 3_600_000)
      utimesSync(dir, when, when)
      return dir
    }
    const old = at(makeScratch("job-", tmp), 25)
    file(join(old, "deep", "x"))
    at(old, 25)
    const young = at(makeScratch("job-", tmp), 1)
    mkdirSync(join(tmp, "job-plain"))
    const plain = at(join(tmp, "job-plain"), 25)
    const away = join(root, "away")
    mkdirSync(away)
    const target = at(makeScratch("job-", away), 25)
    symlinkSync(target, join(tmp, "job-link"))
    expect(removeStale("job-", tmp, 86_400_000, now)).toEqual([{ bytes: 1, path: old }])
    expect(existsSync(old)).toBe(false)
    for (const dir of [young, plain, target]) expect(existsSync(dir)).toBe(true)
  })
})

describe("purgeTrash", () => {
  const DAY = 86_400_000
  const GB = 1e9
  const batchAt = (trash: string, at: Date, session = "s") => {
    const stamp = at.toISOString().replace(/[-:]|\.\d{3}/g, "")
    file(join(trash, `${stamp}-${session}`, "1", "item"))
    return `${stamp}-${session}`
  }

  test("removes batches over 7 days old and keeps the rest while space is plenty", () => {
    const { trash } = machine()
    const old = batchAt(trash, new Date(NOW.getTime() - 8 * DAY))
    const young = batchAt(trash, new Date(NOW.getTime() - 6 * DAY))
    const done = purgeTrash(trash, { free: () => 100 * GB, now: NOW })
    expect(done.removed).toEqual([old])
    expect(existsSync(join(trash, old))).toBe(false)
    expect(existsSync(join(trash, young))).toBe(true)
  })

  test("clears a told mark older than the cap's window and keeps a fresh one", () => {
    const { trash } = machine()
    const told = join(trash, ".cap-told", "j6rjgy-worker")
    mkdirSync(told, { recursive: true })
    const old = join(told, "2026-11-01T00:00:00.000Z")
    const fresh = join(told, "2026-11-02T12:00:00.000Z")
    writeFileSync(old, "")
    writeFileSync(fresh, "")
    utimesSync(old, new Date(NOW.getTime() - 61_000), new Date(NOW.getTime() - 61_000))
    utimesSync(fresh, new Date(NOW.getTime() - 30_000), new Date(NOW.getTime() - 30_000))
    purgeTrash(trash, { free: () => 100 * GB, now: NOW })
    expect(existsSync(old)).toBe(false)
    expect(existsSync(fresh)).toBe(true)
  })

  test("keeps a session's empty folder, which a concurrent try may be about to fill", () => {
    const { trash } = machine()
    const told = join(trash, ".cap-told", "j6rjgy-worker")
    mkdirSync(told, { recursive: true })
    purgeTrash(trash, { free: () => 100 * GB, now: NOW })
    expect(existsSync(told)).toBe(true)
  })

  test("carries on past a told mark it cannot remove", () => {
    const { trash } = machine()
    const toldDir = join(trash, ".cap-told", "j6rjgy-worker")
    mkdirSync(toldDir, { recursive: true })
    const old = join(toldDir, "2026-11-01T00:00:00.000Z")
    writeFileSync(old, "")
    utimesSync(old, new Date(NOW.getTime() - 61_000), new Date(NOW.getTime() - 61_000))
    chmodSync(toldDir, 0o555)
    try {
      const done = purgeTrash(trash, { free: () => 100 * GB, now: NOW })
      expect(done.removed).toEqual([])
    } finally {
      chmodSync(toldDir, 0o755)
    }
  })

  // a file flagged immutable (macOS chflags uchg), or on Linux a folder with no write bit, which rmSync cannot clear
  const lock = (item: string, on: boolean) =>
    process.platform === "darwin"
      ? Bun.spawnSync(["chflags", on ? "uchg" : "nouchg", item])
      : chmodSync(dirname(item), on ? 0o555 : 0o755)

  test("skips a batch it cannot remove, removes the rest, and names it once until it goes (#2918)", () => {
    const { trash } = machine()
    const stuck = batchAt(trash, new Date(NOW.getTime() - 9 * DAY), "x")
    const old = batchAt(trash, new Date(NOW.getTime() - 8 * DAY))
    const item = join(trash, stuck, "1", "item")
    lock(item, true)
    try {
      const first = purgeTrash(trash, { free: () => 100 * GB, now: NOW })
      expect(first.removed).toEqual([old])
      expect(first.stuck).toEqual([expect.stringMatching(new RegExp(`^${stuck} \\(E[A-Z]+\\)$`))])
      const second = purgeTrash(trash, { free: () => 100 * GB, now: NOW })
      expect(second).toEqual({ removed: [], skipped: [], stuck: [] })
      expect(existsSync(item)).toBe(true)
    } finally {
      lock(item, false)
    }
    expect(purgeTrash(trash, { free: () => 100 * GB, now: NOW }).removed).toEqual([stuck])
    expect(existsSync(join(trash, stuck))).toBe(false)
    expect(existsSync(join(trash, ".purge-stuck", stuck))).toBe(false)
  })

  test("removes the oldest batches early while free space is under 50 GB", () => {
    const { trash } = machine()
    const first = batchAt(trash, new Date(NOW.getTime() - 3 * DAY))
    const second = batchAt(trash, new Date(NOW.getTime() - 2 * DAY))
    const third = batchAt(trash, new Date(NOW.getTime() - DAY))
    const free = () => (existsSync(join(trash, second)) ? 40 * GB : 60 * GB)
    const done = purgeTrash(trash, { free, now: NOW })
    expect(done.removed).toEqual([first, second])
    expect(existsSync(join(trash, third))).toBe(true)
  })

  test("removes nothing outside the trash: a symlinked batch is skipped", () => {
    const { home, trash } = machine()
    const keep = join(home, "keep")
    file(join(keep, "x"))
    mkdirSync(trash, { recursive: true })
    symlinkSync(keep, join(trash, "20200101T000000Z-s"))
    const done = purgeTrash(trash, { free: () => 100 * GB, now: NOW })
    expect(done.removed).toEqual([])
    expect(done.skipped).toEqual(["20200101T000000Z-s"])
    expect(existsSync(join(keep, "x"))).toBe(true)
  })

  test("a missing trash folder purges nothing", () => {
    const { trash } = machine()
    expect(purgeTrash(trash, { free: () => 0, now: NOW }).removed).toEqual([])
  })

  // deleting the trash is cheap, so no load holds a batch, whatever the cap reads
  test("removes its batches at any load", () => {
    const { trash } = machine()
    const old = batchAt(trash, new Date(NOW.getTime() - 8 * DAY))
    const done = purgeTrash(trash, { free: () => 20 * GB, now: NOW })
    expect(done).toEqual({ removed: [old], skipped: [], stuck: [] })
    expect(existsSync(join(trash, old))).toBe(false)
  })
})

describe("stripTrash", () => {
  const DAY = 86_400_000
  const batchTree = (roots: Roots, at: Date, session: string) => {
    const stamp = at.toISOString().replace(/[-:]|\.\d{3}/g, "")
    const batch = `${stamp}-${session}`
    const tree = join(roots.trash, batch, "1", "review-clone")
    file(join(tree, "node_modules", "left-pad", "index.js"))
    file(join(tree, "packages", "web", "node_modules", "react", "index.js"))
    file(join(tree, "web", "next", ".next", "build-manifest.json"))
    file(join(tree, "src", "index.ts"))
    writeFileSync(
      join(roots.trash, batch, "manifest.jsonl"),
      `${JSON.stringify({
        at: at.toISOString(),
        files: 4,
        id: `${batch}/1`,
        path: join(roots.home, "review-clone"),
        reason: "playground rm",
        session,
        size: 40,
      })}\n`,
    )
    return batch
  }

  test("strips node_modules (root and a workspace's) and web/next/.next from a trashed batch, keeps the rest and the manifest, and a restore still works", async () => {
    const roots = machine()
    const old = batchTree(roots, new Date(NOW.getTime() - 2 * DAY), "s")
    const young = batchTree(roots, new Date(NOW.getTime() - DAY), "t")
    const slept: number[] = []
    const done = await stripTrash(roots.trash, { sleep: async (ms) => void slept.push(ms) })
    expect(done.batches).toEqual([old, young])
    expect(done.folders).toBe(6)
    expect(slept).toHaveLength(2)
    for (const batch of [old, young]) {
      const tree = join(roots.trash, batch, "1", "review-clone")
      expect(existsSync(join(tree, "node_modules"))).toBe(false)
      expect(existsSync(join(tree, "packages", "web", "node_modules"))).toBe(false)
      expect(existsSync(join(tree, "web", "next", ".next"))).toBe(false)
      expect(existsSync(join(tree, "src", "index.ts"))).toBe(true)
      const entry = JSON.parse(
        readFileSync(join(roots.trash, batch, "manifest.jsonl"), "utf8").trim(),
      ) as { stripped?: number }
      expect(entry.stripped).toBe(3)
    }
    expect(restore(`${old}/1`, roots)).toEqual({ path: join(roots.home, "review-clone") })
    expect(existsSync(join(roots.home, "review-clone", "src", "index.ts"))).toBe(true)
  })

  test("a manifest it cannot rewrite leaves the strip's folders gone and names the batch in failed", async () => {
    const roots = machine()
    const batch = batchTree(roots, new Date(NOW.getTime() - DAY), "s")
    chmodSync(join(roots.trash, batch), 0o555)
    const done = await stripTrash(roots.trash, { sleep: async () => {} })
    chmodSync(join(roots.trash, batch), 0o755)
    expect(done.failed).toEqual([batch])
    expect(done.folders).toBe(3)
    expect(existsSync(join(roots.trash, batch, "1", "review-clone", "node_modules"))).toBe(false)
  })

  test("a batch the strip cannot finish names itself in failed and holds no later batch back", async () => {
    const roots = machine()
    const bad = batchTree(roots, new Date(NOW.getTime() - 2 * DAY), "s")
    file(join(roots.trash, bad, "1", "review-clone", "node_modules", "locked", "child.js"))
    chmodSync(join(roots.trash, bad, "1", "review-clone", "node_modules", "locked"), 0o555)
    const good = batchTree(roots, new Date(NOW.getTime() - DAY), "t")
    const done = await stripTrash(roots.trash, { sleep: async () => {} })
    expect(done.batches).toEqual([good])
    expect(done.folders).toBe(3)
    expect(done.failed).toEqual([bad])
    expect(existsSync(join(roots.trash, bad, "1", "review-clone", "node_modules", "locked"))).toBe(
      true,
    )
    expect(existsSync(join(roots.trash, good, "1", "review-clone", "node_modules"))).toBe(false)
    const entry = JSON.parse(
      readFileSync(join(roots.trash, bad, "manifest.jsonl"), "utf8").trim(),
    ) as { stripped?: number }
    expect(entry.stripped).toBeUndefined()
    chmodSync(join(roots.trash, bad, "1", "review-clone", "node_modules", "locked"), 0o755)
  })

  test("a carve-out batch keeps its tree whole at the strip", async () => {
    const roots = machine()
    const batch = batchTree(roots, new Date(NOW.getTime() - DAY), "s")
    const manifest = JSON.parse(
      readFileSync(join(roots.trash, batch, "manifest.jsonl"), "utf8").trim(),
    ) as { carveOut?: string }
    manifest.carveOut = "dashboard-supervisor"
    writeFileSync(join(roots.trash, batch, "manifest.jsonl"), `${JSON.stringify(manifest)}\n`)
    const done = await stripTrash(roots.trash, { sleep: async () => {} })
    expect(done.batches).toEqual([])
    expect(done.folders).toBe(0)
    expect(existsSync(join(roots.trash, batch, "1", "review-clone", "node_modules"))).toBe(true)
  })

  test("the strip skips an item its entry marks stripped", async () => {
    const roots = machine()
    const batch = batchTree(roots, new Date(NOW.getTime() - DAY), "s")
    const manifest = JSON.parse(
      readFileSync(join(roots.trash, batch, "manifest.jsonl"), "utf8").trim(),
    ) as { stripped?: number }
    manifest.stripped = 3
    writeFileSync(join(roots.trash, batch, "manifest.jsonl"), `${JSON.stringify(manifest)}\n`)
    const done = await stripTrash(roots.trash, { sleep: async () => {} })
    expect(done.batches).toEqual([])
    expect(done.folders).toBe(0)
    expect(existsSync(join(roots.trash, batch, "1", "review-clone", "node_modules"))).toBe(true)
  })

  test("an rm refused at the tripwire leaves node_modules in place", () => {
    const roots = machine()
    const tree = join(roots.home, "review-clone")
    file(join(tree, "node_modules", "left-pad", "index.js"))
    for (let i = 0; i < LIMITS.files + 1; i++) file(join(tree, "src", `f${i}`))
    const done = quarantine(tree, opts, roots)
    expect("refused" in done && done.refused).toContain("tripwire")
    expect(existsSync(join(tree, "node_modules", "left-pad", "index.js"))).toBe(true)
  })

  test("a tree that passes the tripwire only because its node_modules is skipped still moves", () => {
    const roots = machine()
    const tree = join(roots.home, "review-clone")
    for (let i = 0; i < LIMITS.files - 1; i++) file(join(tree, "src", `f${i}`))
    for (let i = 0; i < 100; i++) file(join(tree, "node_modules", `f${i}`))
    const done = quarantine(tree, opts, roots)
    if (!("id" in done)) throw new Error(`quarantine refused: ${done.refused}`)
    const [batch] = done.id.split("/")
    expect(existsSync(join(roots.trash, batch, "1", "review-clone", "src", "f0"))).toBe(true)
  })

  test("a strip that throws leaves the item reachable, its entry unmarked, and names the failure", () => {
    const roots = machine()
    const tree = join(roots.home, "review-clone")
    file(join(tree, "node_modules", "locked", "child.js"))
    file(join(tree, "node_modules", "ok", "child.js"))
    file(join(tree, "src", "index.ts"))
    chmodSync(join(tree, "node_modules", "locked"), 0o555)
    const done = quarantine(tree, opts, roots)
    if (!("id" in done)) throw new Error(`quarantine refused: ${done.refused}`)
    expect(typeof done.stripFailed).toBe("string")
    expect("stripped" in done).toBe(false)
    const [batch] = done.id.split("/")
    const entry = JSON.parse(
      readFileSync(join(roots.trash, batch, "manifest.jsonl"), "utf8").trim(),
    ) as { stripped?: number }
    expect(entry.stripped).toBeUndefined()
    expect(existsSync(join(roots.trash, batch, "1", "review-clone", "src", "index.ts"))).toBe(true)
    expect(
      existsSync(join(roots.trash, batch, "1", "review-clone", "node_modules", "locked")),
    ).toBe(true)
    chmodSync(join(roots.trash, batch, "1", "review-clone", "node_modules", "locked"), 0o755)
  })
})

test("a path outside a tree's node_modules and web/next/.next is never removed outright", () => {
  const roots = machine()
  const tree = join(roots.home, "review-clone")
  file(join(tree, "node_modules", "left-pad", "index.js"))
  file(join(tree, "web", "next", ".next", "build-manifest.json"))
  file(join(tree, "web", "next", ".next-cache", "y.js"))
  file(join(tree, "packages", "app", ".next", "y.js"))
  file(join(tree, "src", "index.ts"))
  const done = quarantine(tree, opts, roots)
  if (!("id" in done)) throw new Error(`quarantine refused: ${done.refused}`)
  expect(restore(done.id, roots)).toEqual({ path: tree })
  expect(existsSync(join(tree, "web", "next", ".next-cache", "y.js"))).toBe(true)
  expect(existsSync(join(tree, "packages", "app", ".next", "y.js"))).toBe(true)
  expect(existsSync(join(tree, "src", "index.ts"))).toBe(true)
})

// #2191: playground page --remove moves one kept page's files out of the previews folder in the data folder, which holds pages.jsonl and every other preview beside them.
test("the page carve-out moves only a plain HTML, caption or PDF directly in previews, never pages.jsonl, and restore puts it back; with no carve-out each stays refused", () => {
  const roots = machine()
  const previews = join(roots.home, ".playground", "previews")
  const named = { ...opts, carveOut: "page" }
  const html = file(join(previews, "report.html"), "page")
  const caption = file(join(previews, "report.txt"), "caption")
  const pdf = file(join(previews, "report.pdf"), "pdf")
  const index = file(join(previews, "pages.jsonl"), "{}\n")
  const image = file(join(previews, "shot.png"), "png")
  const deeper = file(join(previews, "sub", "deep.html"))
  for (const path of [html, caption, pdf, index])
    expect(quarantine(path, opts, roots, { now: NOW })).toMatchObject({ kind: "protected" })
  for (const path of [index, image])
    expect(quarantine(path, named, roots, { now: NOW })).toMatchObject({
      kind: "protected",
      refused: expect.stringContaining("not a file the page carve-out names"),
    })
  expect(quarantine(deeper, named, roots, { now: NOW })).toMatchObject({
    kind: "protected",
    refused: expect.stringContaining("not directly in"),
  })
  for (const path of [html, caption, pdf])
    expect(quarantine(path, named, roots, { now: NOW })).toMatchObject({ files: 1 })
  expect(readdirSync(previews).sort()).toEqual(["pages.jsonl", "shot.png", "sub"])
  for (const entry of listTrash(roots.trash))
    expect(restore(entry.id, roots)).toEqual({ path: entry.path })
  expect(readFileSync(html, "utf8")).toBe("page")
  expect(readFileSync(caption, "utf8")).toBe("caption")
  expect(readFileSync(pdf, "utf8")).toBe("pdf")
})

// #2191: playground page --remove asks how many moves a session has left before it moves a page's first file, so the per-minute cap never stops a page partway.
test("movesLeft counts a session's own moves inside the minute and changes nothing", () => {
  const roots = machine()
  expect(movesLeft(roots.trash, opts.session, NOW)).toBe(LIMITS.perMinute)
  for (const name of ["a", "b"])
    expect(quarantine(file(join(roots.root, name)), opts, roots, { now: NOW })).toMatchObject({
      files: 1,
    })
  const before = readdirSync(roots.trash).sort()
  expect(movesLeft(roots.trash, opts.session, NOW)).toBe(LIMITS.perMinute - 2)
  expect(movesLeft(roots.trash, "other-worker", NOW)).toBe(LIMITS.perMinute)
  expect(movesLeft(roots.trash, opts.session, new Date(NOW.getTime() + 61_000))).toBe(
    LIMITS.perMinute,
  )
  expect(readdirSync(roots.trash).sort()).toEqual(before)
})

describe("an approved card's removal", () => {
  const card = "11111111-2222-3333-4444-555555555555"
  const weightsOf = () => {
    const roots = machine()
    const repo = join(roots.home, "models", "hf", "hub", "models--nvidia--Qwen-27B")
    file(join(repo, "blobs", "b"), "weights")
    symlinkSync(
      join(repo, "blobs", "b"),
      join(dirname(file(join(repo, "snapshots", "s", "x"))), "model.safetensors"),
    )
    const gguf = file(join(roots.home, "probe-local-model", "gguf", "GLM-Flash.gguf"), "gguf")
    return { gguf, repo, roots }
  }
  const at = (bytes: number) => ({ bytes, card })

  test("approved weights are deleted outright at the card's size, logged in deleted.jsonl, never trashed", () => {
    const { gguf, repo, roots } = weightsOf()
    expect(bytesOf(repo)).toBe(8)
    const folders = [dirname(gguf)]
    expect(
      deleteWeights(
        repo,
        { approved: at(8), folders, reason: "nightly-clean", session: "shell" },
        roots,
        NOW,
      ),
    ).toEqual({ size: 8 })
    expect(
      deleteWeights(
        gguf,
        { approved: at(4), folders, reason: "nightly-clean", session: "shell" },
        roots,
        NOW,
      ),
    ).toEqual({ size: 4 })
    expect(existsSync(repo) || existsSync(gguf)).toBe(false)
    const log = readFileSync(join(roots.trash, "deleted.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l))
    expect(log.map((l) => [l.path, l.bytes, l.card])).toEqual([
      [repo, 8, card],
      [gguf, 4, card],
    ])
    expect(listTrash(roots.trash)).toEqual([])
  })

  test("weights whose size changed since the card, a symlink, the models folder itself and a file outside the folders are refused, each left in place", () => {
    const { gguf, repo, roots } = weightsOf()
    const folders = [dirname(gguf)]
    const del = (path: string, bytes: number) =>
      deleteWeights(
        path,
        { approved: at(bytes), folders, reason: "t", session: "shell" },
        roots,
        NOW,
      )
    expect(del(repo, 7)).toMatchObject({ refused: expect.stringContaining("its size changed") })
    const link = join(roots.home, "models", "link.gguf")
    symlinkSync(gguf, link)
    expect(del(link, 4)).toMatchObject({ refused: expect.stringContaining("is a symlink") })
    const models = join(roots.home, "models")
    expect(del(models, bytesOf(models))).toMatchObject({
      refused: expect.stringContaining("is not model weights"),
    })
    const outside = file(join(roots.home, "Downloads", "x.gguf"), "abcd")
    expect(isWeights(outside, roots.home, folders)).toBe(false)
    expect(del(outside, 4)).toMatchObject({
      refused: expect.stringContaining("is not model weights"),
    })
    expect(del(`${dirname(gguf)}/../gguf/GLM-Flash.gguf`, 4)).toMatchObject({
      refused: expect.stringContaining("no .."),
    })
    for (const path of [repo, gguf, link, outside]) expect(existsSync(path)).toBe(true)
  })

  test("an approved rehearsal in Ops' scratchpad moves whole past the caps, and --restore puts it back; unapproved it stays protected", () => {
    const roots = machine()
    const rehearsal = join(roots.home, ".playground", "scratchpad", "ops", "rehearse142")
    for (let i = 0; i < LIMITS.files + 1; i++) file(join(rehearsal, "clone", String(i)), "")
    expect(quarantine(rehearsal, opts, roots, { now: NOW })).toMatchObject({ kind: "protected" })
    expect(quarantine(rehearsal, { ...opts, approved: at(1) }, roots, { now: NOW })).toMatchObject({
      refused: expect.stringContaining("its size changed"),
    })
    const moved = quarantine(rehearsal, { ...opts, approved: at(0) }, roots, {
      now: NOW,
    }) as Quarantined
    expect(moved.files).toBe(LIMITS.files + 1)
    expect(existsSync(rehearsal)).toBe(false)
    expect(listTrash(roots.trash)[0]).toMatchObject({ approved: card, path: rehearsal })
    expect(restore(moved.id, roots)).toEqual({ path: rehearsal })
    expect(existsSync(join(rehearsal, "clone", "0"))).toBe(true)
  })
})

describe("a model test's replay worktree", () => {
  // A main checkout pushed to origin/canary, with one replay worktree detached at canary's commit under ~/models/kit/runs, holding a tracked edit and an untracked file.
  const replay = () => {
    const roots = machine()
    const remote = join(roots.root, "remote.git")
    git(roots.root, "init", "--bare", "-q", remote)
    git(roots.main, "init", "-q", "-b", "canary")
    file(join(roots.main, "README.md"), "one\n")
    git(roots.main, "add", ".")
    git(roots.main, "commit", "-qm", "init")
    git(roots.main, "remote", "add", "origin", remote)
    git(roots.main, "push", "-q", "origin", "canary")
    const add = (wt: string) => {
      mkdirSync(dirname(wt), { recursive: true })
      git(roots.main, "worktree", "add", "-q", "--detach", wt, "HEAD")
      writeFileSync(join(wt, "README.md"), "two\n")
      file(join(wt, "answer.ts"), "export const a = 1\n")
      return wt
    }
    const wt = add(join(roots.home, "models", "kit", "runs", "MB-1", "pr0001"))
    return { add, roots, wt }
  }

  test("one under kit/runs at a canary commit goes through git worktree remove, its work written to <name>.diff first", () => {
    const { roots, wt } = replay()
    expect(removeReplay(wt, { folders: [], procs: [] }, roots)).toEqual({ diff: `${wt}.diff` })
    expect(existsSync(wt)).toBe(false)
    const diff = readFileSync(`${wt}.diff`, "utf8")
    expect(diff).toContain("+two")
    expect(diff).toContain("+export const a = 1")
    expect(git(roots.main, "worktree", "list")).not.toContain(wt)
  })

  test("the diff is written before the worktree goes: a remove git refuses leaves both, naming the diff", () => {
    const { roots, wt } = replay()
    git(roots.main, "worktree", "lock", wt)
    expect(removeReplay(wt, { folders: [], procs: [] }, roots)).toMatchObject({
      refused: expect.stringContaining(`its work is kept in ${wt}.diff`),
    })
    expect(existsSync(wt)).toBe(true)
    expect(readFileSync(`${wt}.diff`, "utf8")).toContain("+two")
  })

  test("a recorded folder outside kit/runs with a tracked edit, a commit canary lacks, and a folder no rule names are refused, each left in place", () => {
    const { add, roots, wt } = replay()
    const recorded = join(roots.home, "trials")
    const outside = add(join(recorded, "pr0002"))
    expect(removeReplay(outside, { folders: [recorded], procs: [] }, roots)).toMatchObject({
      refused: expect.stringContaining("has a tracked edit"),
    })
    git(wt, "commit", "-qam", "test output")
    expect(removeReplay(wt, { folders: [], procs: [] }, roots)).toMatchObject({
      refused: expect.stringContaining("a commit origin/canary does not hold"),
    })
    const loose = add(join(roots.home, "elsewhere", "pr0003"))
    expect(removeReplay(loose, { folders: [], procs: [] }, roots)).toMatchObject({
      refused: expect.stringContaining("is not a replay worktree's place"),
    })
    for (const path of [outside, wt, loose]) expect(existsSync(path)).toBe(true)
    expect(existsSync(`${outside}.diff`) || existsSync(`${wt}.diff`)).toBe(false)
  })

  test("a process working in it holds it, as one holds any worktree, and an unreadable process list keeps it", () => {
    const { roots, wt } = replay()
    const running = proc(4242, "bun run kit replay", join(wt, "src"))
    expect(removeReplay(wt, { folders: [], procs: [running] }, roots)).toMatchObject({
      refused: `${wt} is held by pid 4242 (bun run kit replay) working in ${join(wt, "src")}`,
    })
    expect(removeReplay(wt, { folders: [], procs: null }, roots)).toMatchObject({
      refused: expect.stringContaining("cannot be listed"),
    })
    expect(existsSync(wt) || existsSync(`${wt}.diff`)).toBe(true)
    expect(existsSync(`${wt}.diff`)).toBe(false)
  })

  test("a recorded folder outside kit/runs with no tracked edit goes too", () => {
    const { roots } = replay()
    const recorded = join(roots.home, "trials")
    mkdirSync(recorded, { recursive: true })
    git(roots.main, "worktree", "add", "-q", "--detach", join(recorded, "pr0004"), "HEAD")
    file(join(recorded, "pr0004", "out.log"), "graded\n")
    expect(
      removeReplay(join(recorded, "pr0004"), { folders: [recorded], procs: [] }, roots),
    ).toEqual({
      diff: join(recorded, "pr0004.diff"),
    })
  })
})
