import { afterAll, expect, test } from "bun:test"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { Refusal, Roots } from "../../../../../packages/safe-delete/src"
import { removeSet } from "../../../../../packages/scripts/src/playground/shards"

const dirs: string[] = []
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { force: true, recursive: true })
})

// removeSet's return: either its deletion result, or a refusal. The guard narrows the union, since only Refusal carries `refused`.
type RemoveSetResult = { paths: string[]; size: number } | Refusal
const isRefusal = (done: RemoveSetResult): done is Refusal => "refused" in done

// A mkdtemp machine with roots that removeSet reads for the protected and weights checks, and a hf repo holding four .gguf shards, each at its own 50 bytes, that the set names. `symlinks` replaces a shard with a symlink, which the set reads as left out.
const setup = (
  symlinks: number[] = [],
): {
  folder: string
  home: string
  main: string
  roots: Roots
  set: () => string[]
  shard: (i: number) => string
  size: number
  total: number
} => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "shards-")))
  dirs.push(root)
  const home = join(root, "home")
  const main = join(home, "playground")
  const data = join(home, ".playground")
  mkdirSync(join(main, ".claude", "worktrees"), { recursive: true })
  mkdirSync(data, { recursive: true })
  const folder = join(home, "models", "hf", "hub", "models--nvidia--Qwen-27B")
  mkdirSync(folder, { recursive: true })
  const size = 50
  const shard = (i: number) => join(folder, `model-${String(i).padStart(5, "0")}-of-00004.gguf`)
  for (let i = 1; i <= 4; i++) {
    if (symlinks.includes(i)) {
      writeFileSync(join(folder, `target-${i}`), "real")
      symlinkSync(join(folder, `target-${i}`), shard(i))
    } else {
      writeFileSync(shard(i), "")
      truncateSync(shard(i), size)
    }
  }
  const set = (): string[] => [shard(1), shard(2), shard(3), shard(4)]
  return {
    folder,
    home,
    main,
    roots: { home, main, trash: join(data, "trash") } as Roots,
    set,
    shard,
    size,
    total: size * 4,
  }
}

const approved = (total: number): { bytes: number; card: string } => ({
  bytes: total,
  card: "11111111-2222-3333-4444-555555555555",
})

test("removeSet checks every shard before any delete, then deletes the set whole at each shard's own size", () => {
  const s = setup()
  const done = removeSet(
    s.set(),
    approved(s.total),
    { folders: [], reason: "test", session: "j6rjgy-worker" },
    s.roots,
  )
  expect(isRefusal(done)).toBe(false)
  if (!isRefusal(done)) {
    expect(done.size).toBe(s.total)
    expect(done.paths).toEqual(s.set())
    for (let i = 1; i <= 4; i++) expect(existsSync(s.shard(i))).toBe(false)
  }
})

test("removeSet refuses a set whose total no longer matches, deleting none", () => {
  const s = setup()
  const done = removeSet(
    s.set(),
    approved(s.total + 50),
    { folders: [], reason: "test", session: "j6rjgy-worker" },
    s.roots,
  )
  expect(isRefusal(done)).toBe(true)
  if (isRefusal(done)) expect(done.refused).toContain("shard set holds 4 shards at 200 bytes")
  for (let i = 1; i <= 4; i++) expect(existsSync(s.shard(i))).toBe(true)
})

test("removeSet refuses a set whose one shard is a symlink, deleting none", () => {
  const s = setup([4])
  const done = removeSet(
    s.set(),
    approved(150),
    { folders: [], reason: "test", session: "j6rjgy-worker" },
    s.roots,
  )
  // The symlink shard reads as 0 bytes, so the set still sums at 150 and passes the size check, and the symlink fails its own per-shard pre-check.
  expect(isRefusal(done)).toBe(true)
  if (isRefusal(done)) expect(done.refused).toContain("is not a real file the shard set holds")
  for (let i = 1; i <= 4; i++) expect(existsSync(s.shard(i))).toBe(true)
})

test("removeSet checks every shard before any delete: a shard inside the main checkout is protected, so none is deleted", () => {
  const s = setup()
  // Shard 3, replaced by a real 50-byte file inside the main checkout, fails the per-shard pre-check as protected, while the set still sums at 200 bytes.
  const mainShard3 = join(s.main, "model-00003-of-00004.gguf")
  writeFileSync(mainShard3, "")
  truncateSync(mainShard3, s.size)
  const set = (): string[] => [s.shard(1), s.shard(2), mainShard3, s.shard(4)]
  const done = removeSet(
    set(),
    approved(s.total),
    { folders: [], reason: "test", session: "j6rjgy-worker" },
    s.roots,
  )
  expect(isRefusal(done)).toBe(true)
  if (isRefusal(done)) expect(done.refused).toContain("is inside the main checkout")
  for (let i = 1; i <= 4; i++) expect(existsSync(s.shard(i))).toBe(true)
  expect(existsSync(mainShard3)).toBe(true)
})
