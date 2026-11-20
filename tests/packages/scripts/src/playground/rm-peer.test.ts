import { afterAll, expect, test } from "bun:test"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { runRmPeer, type RmPeerDeps } from "../../../../../packages/scripts/src/playground/rm-peer"

const dirs: string[] = []
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { force: true, recursive: true })
})

// A made-up machine on its own mkdtemp: HOME with its main checkout and state folder, the ssh key the peer reads, and deps that read its record.
const machine = () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rm-peer-")))
  dirs.push(root)
  const home = join(root, "home")
  const main = join(home, "playground")
  const data = join(home, ".playground")
  mkdirSync(join(main, ".claude", "worktrees"), { recursive: true })
  for (const dir of [".config", ".ssh", ".gnupg", ".claude", "Library", "Music", ".playground"])
    mkdirSync(join(home, dir), { recursive: true })
  writeFileSync(join(home, ".ssh", "id_ed25519"), "key")
  writeFileSync(join(data, "roster.json"), JSON.stringify({ agents: [] }))
  const deps: RmPeerDeps = {
    data,
    home,
    main,
    session: async () => "j6rjgy-worker",
  }
  return { data, home, main, root, deps }
}

const file = (path: string, text = "x"): string => {
  mkdirSync(join(path, ".."), { recursive: true })
  writeFileSync(path, text)
  return path
}

const RECORD = (path: string) =>
  writeFileSync(
    join(deps.data, "machine-record.json"),
    JSON.stringify({
      baseline: [],
      entries: [{ added: "2026-11-17", by: "ops", kind: "folder", path, undo: "rm", why: "seed" }],
    }),
  )

let deps: RmPeerDeps

test("runRmPeer takes three words, and refuses a wrong byte count, card, or too few words", async () => {
  expect(await runRmPeer([], deps)).toBe(2)
  expect(await runRmPeer(["/m/x.gguf"], deps)).toBe(2)
  expect(
    await runRmPeer(["/m/x.gguf", "not-bytes", "11111111-2222-3333-4444-555555555555"], deps),
  ).toBe(2)
  expect(await runRmPeer(["/m/x.gguf", "1e3", "11111111-2222-3333-4444-555555555555"], deps)).toBe(
    2,
  )
  expect(await runRmPeer(["/m/x.gguf", "0x10", "11111111-2222-3333-4444-555555555555"], deps)).toBe(
    2,
  )
  expect(await runRmPeer(["/m/x.gguf", "7", "not-a-card"], deps)).toBe(2)
})

test("runRmPeer refuses a path not on the machine record, and leaves it", async () => {
  const m = machine()
  const path = file(join(m.home, "scratch", "off-record.gguf"), "0123456")
  deps = { ...m.deps, data: m.data, home: m.home, main: m.main }
  const { out, err } = await rmpTold(path, {
    bytes: 7,
    card: "11111111-2222-3333-4444-555555555555",
  })
  expect(out).toEqual([])
  expect(err.join("\n")).toContain("is not on the machine record")
  expect(existsSync(path)).toBe(true)
})

test("runRmPeer leaves a .gguf under a like-named record folder, so it stays", async () => {
  const m = machine()
  const folder = join(m.home, "gguf")
  const path = file(join(m.home, "gguf2", "model.gguf"), "0123456")
  deps = { ...m.deps, data: m.data, home: m.home, main: m.main }
  RECORD(folder)
  const { out, err } = await rmpTold(path, {
    bytes: 7,
    card: "11111111-2222-3333-4444-555555555555",
  })
  expect(out).toEqual([])
  expect(err.join("\n")).toContain("is not on the machine record, so it stays")
  expect(existsSync(path)).toBe(true)
})

test("runRmPeer refuses a non-weights path the record names, and leaves it", async () => {
  const m = machine()
  const path = file(join(m.home, "scratch", "note.txt"), "scratch")
  deps = { ...m.deps, data: m.data, home: m.home, main: m.main }
  RECORD(path)
  const { code, err } = await rmpTold(path, {
    bytes: 7,
    card: "11111111-2222-3333-4444-555555555555",
  })
  expect(code).toBe(1)
  expect(err.join("\n")).toContain("not model weights")
})

test("runRmPeer refuses a size other than the card approved, and leaves it", async () => {
  const m = machine()
  file(join(m.home, "models", "hf", "hub", "models--nvidia--Qwen-27B", "gguf"), "0123456")
  const folder = join(m.home, "models", "hf", "hub", "models--nvidia--Qwen-27B")
  deps = { ...m.deps, data: m.data, home: m.home, main: m.main }
  RECORD(folder)
  const { code, err } = await rmpTold(folder, {
    bytes: 6,
    card: "11111111-2222-3333-4444-555555555555",
  })
  expect(code).toBe(1)
  expect(err.join("\n")).toContain("its size changed")
})

test("runRmPeer refuses a protected path the record names, and leaves it", async () => {
  const m = machine()
  const path = file(join(m.home, ".ssh", "id_ed25519"), "test")
  deps = { ...m.deps, data: m.data, home: m.home, main: m.main }
  RECORD(path)
  const { code, err } = await rmpTold(path, {
    bytes: 4,
    card: "11111111-2222-3333-4444-555555555555",
  })
  expect(code).toBe(3)
  expect(err.join("\n")).toContain("protected")
})

test("runRmPeer deletes a recorded weights file at the card's exact size, logs it, and drops its record entry", async () => {
  const m = machine()
  file(join(m.home, "models", "hf", "hub", "models--nvidia--Qwen-27B", "gguf"), "0123456")
  const folder = join(m.home, "models", "hf", "hub", "models--nvidia--Qwen-27B")
  deps = { ...m.deps, data: m.data, home: m.home, main: m.main }
  RECORD(folder)
  const { code, out } = await rmpTold(folder, {
    bytes: 7,
    card: "11111111-2222-3333-4444-555555555555",
  })
  expect(code).toBe(0)
  expect(out.join("\n")).toContain(
    `Deleted ${folder} outright (7 bytes), as card 11111111-2222-3333-4444-555555555555 approved on the peer`,
  )
  expect(out.join("\n")).toContain("its machine record entry is dropped")
  expect(out).toHaveLength(1)
  expect(JSON.parse(readFileSync(join(deps.data, "machine-record.json"), "utf8")).entries).toEqual(
    [],
  )
})

test("runRmPeer deletes a .gguf directly under a recorded folder, logs it", async () => {
  const m = machine()
  const folder = join(m.home, "gguf")
  file(join(folder, "model.gguf"), "0123456")
  deps = { ...m.deps, data: m.data, home: m.home, main: m.main }
  RECORD(folder)
  const path = join(folder, "model.gguf")
  const { code, out } = await rmpTold(path, {
    bytes: 7,
    card: "11111111-2222-3333-4444-555555555555",
  })
  expect(code).toBe(0)
  expect(out.join("\n")).toContain(
    `Deleted ${path} outright (7 bytes), as card 11111111-2222-3333-4444-555555555555 approved on the peer`,
  )
  const paths = JSON.parse(
    readFileSync(join(deps.data, "machine-record.json"), "utf8"),
  ).entries.map((entry: { path: string }) => entry.path)
  expect(paths).toContain(folder)
})

test("runRmPeer deletes a .gguf a folder deeper under a recorded folder, logs it", async () => {
  const m = machine()
  const folder = join(m.home, "gguf")
  file(join(folder, "UD-Q3_K_XL", "model.gguf"), "0123456")
  deps = { ...m.deps, data: m.data, home: m.home, main: m.main }
  RECORD(folder)
  const path = join(folder, "UD-Q3_K_XL", "model.gguf")
  const { code, out } = await rmpTold(path, {
    bytes: 7,
    card: "11111111-2222-3333-4444-555555555555",
  })
  expect(code).toBe(0)
  expect(out.join("\n")).toContain(
    `Deleted ${path} outright (7 bytes), as card 11111111-2222-3333-4444-555555555555 approved on the peer`,
  )
  const paths = JSON.parse(
    readFileSync(join(deps.data, "machine-record.json"), "utf8"),
  ).entries.map((entry: { path: string }) => entry.path)
  expect(paths).toContain(folder)
})

// A made-up peer whose hf repo holds one approved sharded set: four .gguf shards, each at its own size and on the record, at the set's total. `symlinks` replaces a shard with a symlink, which the set reads as left out, and `folders` one with an empty folder, which the set takes in at 0 bytes.
const shardedFolder = (
  symlinks: number[] = [],
  folders: number[] = [],
): {
  folder: string
  shard: (i: number) => string
  size: number
  total: number
} => {
  const folder = join(deps.home, "models", "hf", "hub", "models--nvidia--Qwen-27B")
  mkdirSync(folder, { recursive: true })
  const shard = (i: number) => join(folder, `model-${String(i).padStart(5, "0")}-of-00004.gguf`)
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
    if (symlinks.includes(i)) {
      writeFileSync(join(folder, `target-${i}`), "real")
      symlinkSync(join(folder, `target-${i}`), here)
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
  writeFileSync(join(deps.data, "machine-record.json"), JSON.stringify({ baseline: [], entries }))
  return { folder, shard, size, total: size * 4 }
}

test("runRmPeer deletes an approved sharded set whole: every shard at the set's total, and every record entry dropped", async () => {
  const m = machine()
  deps = { ...m.deps, data: m.data, home: m.home, main: m.main }
  const { shard, total } = shardedFolder()
  const { code, out } = await rmpTold(shard(1), {
    bytes: total,
    card: "11111111-2222-3333-4444-555555555555",
  })
  expect(code).toBe(0)
  for (let i = 1; i <= 4; i++) expect(existsSync(shard(i))).toBe(false)
  expect(out.join("\n")).toContain(
    `Deleted the 4 shards outright (${total} bytes), as card 11111111-2222-3333-4444-555555555555 approved on the peer`,
  )
  expect(out.join("\n")).toContain("its machine record entries are dropped")
  expect(JSON.parse(readFileSync(join(deps.data, "machine-record.json"), "utf8")).entries).toEqual(
    [],
  )
})

test("runRmPeer refuses a sharded set whose total no longer matches, deleting none", async () => {
  const m = machine()
  deps = { ...m.deps, data: m.data, home: m.home, main: m.main }
  const { shard, total } = shardedFolder()
  const { code, err } = await rmpTold(shard(1), {
    bytes: total + 50,
    card: "11111111-2222-3333-4444-555555555555",
  })
  expect(code).toBe(1)
  expect(err.join("\n")).toContain("shard set holds 4 shards at 200 bytes")
  expect(err.join("\n")).toContain("approved it at 250")
  for (let i = 1; i <= 4; i++) expect(existsSync(shard(i))).toBe(true)
})

test("runRmPeer leaves a symlinked shard out of the set, so its total no longer matches, deleting none", async () => {
  const m = machine()
  deps = { ...m.deps, data: m.data, home: m.home, main: m.main }
  const { shard, total } = shardedFolder([4])
  const { code, err } = await rmpTold(shard(1), {
    bytes: total,
    card: "11111111-2222-3333-4444-555555555555",
  })
  expect(code).toBe(1)
  expect(err.join("\n")).toContain("shard set holds 3 shards at 150 bytes")
  expect(err.join("\n")).toContain("approved it at 200")
  for (let i = 1; i <= 4; i++) expect(existsSync(shard(i))).toBe(true)
})

test("runRmPeer refuses a sharded set whose one shard fails its own check, an empty folder, though the total matches, deleting none", async () => {
  const m = machine()
  deps = { ...m.deps, data: m.data, home: m.home, main: m.main }
  const { shard, size } = shardedFolder([], [4])
  const { code, err } = await rmpTold(shard(1), {
    bytes: size * 3,
    card: "11111111-2222-3333-4444-555555555555",
  })
  expect(code).toBe(1)
  expect(err.join("\n")).toContain(`${shard(4)} is not model weights the shard set holds`)
  for (let i = 1; i <= 4; i++) expect(existsSync(shard(i))).toBe(true)
})

// One runRmPeer over its words, catching what it logs or errors, with the card's approved byte count.
const rmpTold = async (
  path: string,
  approved: { bytes: number; card: string },
): Promise<{ code: number; err: string[]; out: string[] }> => {
  const err: string[] = []
  const out: string[] = []
  const oldErr = console.error
  const oldLog = console.log
  console.error = (line: string) => void err.push(line)
  console.log = (line: string) => void out.push(line)
  try {
    const code = await runRmPeer([path, String(approved.bytes), approved.card], deps)
    return { code, err, out }
  } finally {
    console.error = oldErr
    console.log = oldLog
  }
}
