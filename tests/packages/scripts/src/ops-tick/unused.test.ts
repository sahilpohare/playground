import { afterAll, expect, test } from "bun:test"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  truncateSync,
  utimesSync,
  writeFileSync,
} from "node:fs"
import { hostname, tmpdir } from "node:os"
import { dirname, join } from "node:path"

import {
  aged,
  linesOf,
  measured,
  measureUnused,
  peerUnusedArgv,
  shardSets,
  type Unused,
  unusedEverywhere,
  unusedImages,
} from "../../../../../packages/scripts/src/ops-tick/unused"

const HERE = hostname().split(".")[0]!
const NOW = Date.parse("2026-11-18T03:00:00Z")
const DAY = 86_400_000
const MB = 1024 ** 2
const GB = 1024 ** 3
const homes: string[] = []
afterAll(() => {
  for (const home of homes) rmSync(home, { force: true, recursive: true })
})

// A sparse file of the given size, so a test lists a 200 MB weights file with no disk spent.
const sized = (path: string, bytes: number, at = NOW) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, "")
  truncateSync(path, bytes)
  utimesSync(path, at / 1000, at / 1000)
}

// The docker this machine answers with: postgres:alpine and postgres:18-alpine one image a container uses by one tag, one pulled yesterday, redis:alpine and the one a serve.sh names, one old and unused, and one pulled with no tag time.
const IMAGES = [
  "sha256:aaa\told:1",
  "sha256:bbb\tpostgres:18-alpine",
  "sha256:bbb\tpostgres:alpine",
  "sha256:ccc\tfresh:1",
  "sha256:ddd\tredis:alpine",
  "sha256:eee\tvllm/vllm-openai:v0.32.0",
  "sha256:fff\tpulled:1",
].join("\n")
const INSPECT = [
  `sha256:aaa\t${300 * MB}\t"2026-11-01T00:00:00Z"`,
  `sha256:bbb\t${300 * MB}\t"0001-01-01T00:00:00Z"`,
  `sha256:ccc\t${300 * MB}\t"2026-11-17T00:00:00Z"`,
  `sha256:ddd\t${50 * MB}\t"0001-01-01T00:00:00Z"`,
  `sha256:eee\t${24_000 * MB}\t"0001-01-01T00:00:00Z"`,
  `sha256:fff\t${250 * MB}\t"0001-01-01T00:00:00Z"`,
].join("\n")

// A scratch home: a data folder whose record holds ~/.bun, the clone and ~/probe-local-model/gguf, ~/models with a kept and a dropped hf repo, one old test row and one fresh, Ops' rehearse142, and a clone whose .env names one peer; every argv its run is handed is kept.
const setUp = (dashboard = false) => {
  const home = mkdtempSync(join(tmpdir(), "unused-"))
  homes.push(home)
  const data = join(home, ".playground")
  const repo = join(home, "code", "playground")
  const models = join(home, "models")
  const at = (rel: string) => join(home, rel)
  const desk = join(home, "code", "desk")
  for (const dir of [repo, desk]) mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dashboard ? desk : repo, ".env"),
    "PLAYGROUND_PEERS=spark-test=me@spark-test\nPLAYGROUND_PEER_KEY=/k/playground_spark\n",
  )
  const entry = (path: string) => ({
    added: "2026-11-17",
    by: "ops",
    kind: "folder",
    path,
    undo: "rm",
    why: "seed",
  })
  mkdirSync(data, { recursive: true })
  writeFileSync(
    join(data, "machine-record.json"),
    JSON.stringify({
      baseline: [],
      entries: [entry(at(".bun")), entry(repo), entry(at("probe-local-model/gguf"))],
    }),
  )
  sized(at(".bun/install/cache/big.tgz"), 900 * MB)
  sized(join(repo, "weights-like.gguf.txt"), 900 * MB)
  mkdirSync(join(models, "ornith"), { recursive: true })
  writeFileSync(join(models, "ornith/model.env"), "REPO=ornith-ai/Ornith-35B\n")
  writeFileSync(join(models, "ornith/serve.sh"), "docker run vllm/vllm-openai:v0.32.0\n")
  sized(join(models, "hf/hub/models--ornith-ai--Ornith-35B/blobs/a"), 2000 * MB)
  sized(join(models, "hf/hub/models--nvidia--Qwen-27B/blobs/b"), 1500 * MB)
  sized(at("probe-local-model/gguf/GLM-Flash.gguf"), 700 * MB)
  sized(at("probe-local-model/gguf/tiny.gguf"), 2 * MB)
  sized(join(models, "kit/runs/MB-old/pr0001/file.ts"), 200 * MB, NOW - 3 * DAY)
  sized(join(models, "kit/runs/MB-old/pr0001.grade.log"), 1 * MB, NOW - 2 * DAY)
  sized(join(models, "kit/runs/MB-new/pr0002/file.ts"), 200 * MB)
  sized(join(models, "kit/runs/MB-new/pr0002.grade.log"), 1 * MB, NOW - 3_600_000)
  sized(join(data, "scratchpad/ops/rehearse142/clone/a"), 150 * MB)
  sized(join(data, "scratchpad/ops/rehearse-template/a"), 150 * MB)
  const runs: string[][] = []
  const run = async (argv: string[]) => {
    runs.push(argv)
    const verb = argv.slice(0, 3).join(" ")
    if (verb === "docker image ls") return { code: 0, out: IMAGES }
    if (verb === "docker ps -a") return { code: 0, out: "postgres:alpine\n" }
    if (verb === "docker image inspect") return { code: 0, out: INSPECT }
    return { code: 127, out: "" }
  }
  const checkout = () => (dashboard ? desk : null)
  return { at, checkout, data, home, models, places: { data, home, now: NOW, run }, repo, runs }
}

test("this machine's unused space: an old unused image, one of unknown age, the dropped repo, the recorded gguf, the old row's worktree and the rehearsal, largest first", async () => {
  const { at, data, models, places } = setUp()
  const { items } = await measureUnused(places)
  expect(items.map(({ bytes: _, ...rest }) => rest)).toEqual([
    { kind: "weights", path: join(models, "hf/hub/models--nvidia--Qwen-27B"), recorded: false },
    { kind: "weights", path: at("probe-local-model/gguf/GLM-Flash.gguf"), recorded: true },
    { id: "sha256:aaa", kind: "image", path: "docker image old:1", recorded: false },
    {
      id: "sha256:fff",
      kind: "image",
      path: "docker image pulled:1",
      recorded: false,
      unknownAge: true,
    },
    { kind: "run", path: join(models, "kit/runs/MB-old/pr0001"), recorded: false },
    { kind: "rehearsal", path: join(data, "scratchpad/ops/rehearse142"), recorded: false },
    { kind: "weights", path: at("probe-local-model/gguf/tiny.gguf"), recorded: true },
  ])
  expect(items[0]!.bytes).toBe(1500 * MB)
})

test("an image's tags are one image: a container using postgres:alpine keeps postgres:18-alpine, its other tag, off the list", () => {
  const listed = "sha256:bbb\tpostgres:18-alpine\nsha256:bbb\tpostgres:alpine\nsha256:aaa\told:1"
  const inspect = `sha256:bbb\t1\t"2026-01-01T00:00:00Z"\nsha256:aaa\t2\t"2026-01-01T00:00:00Z"`
  expect(unusedImages(listed, "postgres:alpine\n", inspect, "", NOW)).toEqual([
    { bytes: 2, id: "sha256:aaa", path: "docker image old:1" },
  ])
  expect(unusedImages(listed, "", inspect, "", NOW)).toEqual([
    { bytes: 1, id: "sha256:bbb", path: "docker image postgres:18-alpine" },
    { bytes: 2, id: "sha256:aaa", path: "docker image old:1" },
  ])
})

test("an image with no tag time, as a pull leaves it, has an unknown age: nightly lists it only 7 days after it first read it unused, and forgets it once used", () => {
  const item = {
    bytes: 250 * MB,
    kind: "image" as const,
    path: "docker image pulled:1",
    recorded: false,
  }
  const night = (
    seen: Record<string, string>,
    at: number,
    items = [{ ...item, unknownAge: true as const }],
  ) =>
    aged(
      [
        { items, machine: "m" },
        { machine: "peer", why: "exit 255" },
      ],
      seen,
      at,
    )
  const first = night({ "peer docker image x:1": "2026-11-01T00:00:00.000Z" }, NOW)
  expect(first.found[0]).toEqual({ items: [], machine: "m" })
  expect(first.seen).toEqual({
    "m docker image pulled:1": "2026-11-18T03:00:00.000Z",
    "peer docker image x:1": "2026-11-01T00:00:00.000Z",
  })
  expect(night(first.seen, NOW + 6 * DAY).found[0]).toEqual({ items: [], machine: "m" })
  expect(night(first.seen, NOW + 7 * DAY).found[0]).toEqual({ items: [item], machine: "m" })
  expect(night(first.seen, NOW + 8 * DAY, []).seen).toEqual({
    "peer docker image x:1": "2026-11-01T00:00:00.000Z",
  })
})

test("a night that cannot read an image's first night keeps it: docker not answering and a peer not read keep their keys, and a value no date reads starts tonight", async () => {
  const { places } = setUp()
  const down = await measureUnused({
    ...places,
    run: async (argv) =>
      argv[0] === "docker"
        ? { code: 1, out: "Cannot connect to the Docker daemon" }
        : { code: 127, out: "" },
  })
  expect(down.imagesUnread).toBe(true)
  expect(down.items.some((i) => i.kind === "image")).toBe(false)
  const gone = await measureUnused({ ...places, run: async () => ({ code: 127, out: "" }) })
  expect(gone.imagesUnread).toBeUndefined()
  const seen = {
    "m docker image a:1": "2026-11-01T00:00:00.000Z",
    "n docker image b:1": "not a date",
    "peer docker image c:1": "2026-11-02T00:00:00.000Z",
  }
  const night = aged(
    [
      { imagesUnread: true, items: [], machine: "m" },
      {
        items: [
          { bytes: MB, kind: "image", path: "docker image b:1", recorded: false, unknownAge: true },
        ],
        machine: "n",
      },
      { machine: "peer", why: "exit 255" },
    ],
    seen,
    NOW,
  )
  expect(night.seen).toEqual({ ...seen, "n docker image b:1": new Date(NOW).toISOString() })
  expect(night.found[1]).toEqual({ items: [], machine: "n" })
})

test("a path removed between its listing and its measure, as by a delete running at once, is skipped and counted nowhere", () => {
  const { at, models } = setUp()
  const gone = join(models, "hf/hub/models--gone--Model")
  const kept = at("probe-local-model/gguf/GLM-Flash.gguf")
  expect(
    measured(
      [
        { kind: "weights", path: gone },
        { kind: "weights", path: kept },
        { bytes: 300 * MB, kind: "image", path: "docker image postgres:18-alpine" },
      ],
      [],
    ),
  ).toEqual([
    { bytes: 700 * MB, kind: "weights", path: kept, recorded: false },
    { bytes: 300 * MB, kind: "image", path: "docker image postgres:18-alpine", recorded: false },
  ])
  expect(
    linesOf({ items: measured([{ kind: "weights", path: gone }], []), machine: "m" }, "/x"),
  ).toEqual({ item: null, total: "m unused 0.0 GB" })
})

test("the record guards and lists nothing itself: ~/.bun and the clone, both recorded, give no line", async () => {
  const { at, places, repo } = setUp()
  const paths = (await measureUnused(places)).items.map((i) => i.path)
  expect(paths.filter((p) => p.startsWith(at(".bun")) || p.startsWith(repo))).toEqual([])
})

test("a dry run removes nothing: every file stays, and docker is only read", async () => {
  const { at, models, places, runs } = setUp()
  await measureUnused(places)
  for (const path of [
    join(models, "hf/hub/models--nvidia--Qwen-27B/blobs/b"),
    at("probe-local-model/gguf/GLM-Flash.gguf"),
    join(models, "kit/runs/MB-old/pr0001/file.ts"),
  ])
    expect(existsSync(path)).toBe(true)
  expect(runs.map((argv) => argv.slice(0, 3).join(" "))).toEqual([
    "docker image ls",
    "docker ps -a",
    "docker image inspect",
  ])
})

test.each([
  ["the clone's own .env", false],
  ["the Dashboard checkout's .env, the main checkout keeping none", true],
])(
  "the peer %s names is read through one fixed, read-only ssh into the main checkout's clone, and its items join this machine's",
  async (_, dashboard) => {
    const { checkout, home, places, repo } = setUp(dashboard)
    const peer: Unused[] = [
      {
        bytes: 159 * 1024 ** 3,
        kind: "weights",
        path: "/home/me/probe-local-model/gguf/x.gguf",
        recorded: true,
      },
    ]
    const ssh: string[][] = []
    const found = await unusedEverywhere(
      { ...places, home },
      repo,
      async (argv) => {
        ssh.push(argv)
        return { code: 0, out: JSON.stringify(peer) }
      },
      checkout,
    )
    expect(ssh).toEqual([
      [
        "ssh",
        "-F",
        "none",
        "-i",
        "/k/playground_spark",
        "-o",
        "IdentitiesOnly=yes",
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=10",
        "me@spark-test",
        'cd ~/code/playground && PATH="$HOME/.bun/bin:$PATH" exec bun --no-env-file packages/scripts/src/ops-tick/unused.ts --json',
      ],
    ])
    expect(ssh[0]).toEqual(
      peerUnusedArgv("/k/playground_spark", "me@spark-test", "~/code/playground"),
    )
    expect(found.map((m) => m.machine)).toEqual([HERE, "spark-test"])
    expect(found[1]).toEqual({ items: peer, machine: "spark-test" })
  },
)

test.each([
  ["an object with no items", '{"x":1}'],
  ["null", "null"],
])("a peer whose --json prints %s is not read", async (_, out) => {
  const { checkout, home, places, repo } = setUp()
  const found = await unusedEverywhere(
    { ...places, home },
    repo,
    async () => ({ code: 0, out }),
    checkout,
  )
  expect(found[1]).toEqual({ machine: "spark-test", why: out })
})

test("a peer's --json gives its items and whether its images were read", async () => {
  const { checkout, home, places, repo } = setUp()
  const out = JSON.stringify({ imagesUnread: true, items: [] })
  const found = await unusedEverywhere(
    { ...places, home },
    repo,
    async () => ({ code: 0, out }),
    checkout,
  )
  expect(found[1]).toEqual({ imagesUnread: true, items: [], machine: "spark-test" })
})

test("a peer that does not answer is named with its first line", async () => {
  const { checkout, home, places, repo } = setUp()
  const found = await unusedEverywhere(
    { ...places, home },
    repo,
    async () => ({ code: 255, out: "ssh: connect to host spark-test port 22: No route to host\n" }),
    checkout,
  )
  expect(found[1]).toEqual({
    machine: "spark-test",
    why: "ssh: connect to host spark-test port 22: No route to host",
  })
  expect(linesOf(found[1]!, home).item).toBe(
    "spark-test: not read: ssh: connect to host spark-test port 22: No route to host",
  )
})

test("a machine's lines: the log's totals by kind, the outbox's items with recorded marked, the small ones folded", () => {
  const home = "/home/me"
  const items: Unused[] = [
    {
      bytes: 38 * 1024 ** 3,
      kind: "weights",
      path: "/home/me/probe-local-model/gguf/x.gguf",
      recorded: true,
    },
    { bytes: 300 * MB, kind: "image", path: "docker image postgres:18-alpine", recorded: false },
    { bytes: 33 * MB, kind: "run", path: "/home/me/models/kit/runs/A/pr1", recorded: false },
    {
      bytes: 12 * MB,
      kind: "weights",
      path: "/home/me/models/hf/hub/models--a--b",
      recorded: false,
    },
  ]
  expect(linesOf({ items, machine: "spark-9dfb" }, home)).toEqual({
    item: "spark-9dfb unused: weights ~/probe-local-model/gguf/x.gguf 38.0 GB recorded; image docker image postgres:18-alpine 0.3 GB; small leftovers 2 at 45 MB",
    total: "spark-9dfb unused 38.3 GB (image 0.3 GB, weights 38.0 GB, small leftovers 2 at 45 MB)",
  })
  expect(linesOf({ items: [], machine: "spark-a566" }, home)).toEqual({
    item: null,
    total: "spark-a566 unused 0.0 GB",
  })
})

test("shardSets: four shards of one model merge into one item, sized as the total, carrying every shard path", () => {
  const stem = "/me/models/loose/models--nvidia--Qwen"
  const shards = [
    {
      bytes: 10.4 * MB,
      kind: "weights" as const,
      path: `${stem}-00001-of-00004.gguf`,
      recorded: false,
    },
    {
      bytes: 4 * GB,
      kind: "weights" as const,
      path: `${stem}-00002-of-00004.gguf`,
      recorded: false,
    },
    {
      bytes: 4 * GB,
      kind: "weights" as const,
      path: `${stem}-00003-of-00004.gguf`,
      recorded: false,
    },
    {
      bytes: 4 * GB,
      kind: "weights" as const,
      path: `${stem}-00004-of-00004.gguf`,
      recorded: false,
    },
  ]
  const merged = shardSets(shards)
  expect(merged).toEqual([
    {
      bytes: 10.4 * MB + 4 * GB + 4 * GB + 4 * GB,
      kind: "weights",
      path: `${stem}-00001-of-00004.gguf`,
      recorded: false,
      shards: [
        `${stem}-00001-of-00004.gguf`,
        `${stem}-00002-of-00004.gguf`,
        `${stem}-00003-of-00004.gguf`,
        `${stem}-00004-of-00004.gguf`,
      ],
    },
  ])
})

test("shardSets: a lone shard of a set is still one item, carrying that one shard", () => {
  const stem = "/me/models/loose/models--nvidia--Qwen"
  const merged = shardSets([
    {
      bytes: 4 * GB,
      kind: "weights" as const,
      path: `${stem}-00002-of-00004.gguf`,
      recorded: false,
    },
  ])
  expect(merged).toEqual([
    {
      bytes: 4 * GB,
      kind: "weights",
      path: `${stem}-00002-of-00004.gguf`,
      recorded: false,
      shards: [`${stem}-00002-of-00004.gguf`],
    },
  ])
})

test("shardSets: sets in one folder stay apart by stem, total and extension", () => {
  const folder = "/me/models/loose"
  const shard = (name: string, bytes: number) => ({
    bytes,
    kind: "weights" as const,
    path: `${folder}/${name}`,
    recorded: false,
  })
  const merged = shardSets([
    shard("a-00001-of-00002.gguf", 1 * GB),
    shard("a-00002-of-00002.gguf", 1 * GB),
    shard("b-00001-of-00002.gguf", 2 * GB),
    shard("b-00002-of-00002.gguf", 2 * GB),
    shard("a-00001-of-00003.gguf", 5 * GB),
    shard("a-00001-of-00002.safetensors", 3 * GB),
  ])
  expect(merged.map((i) => [i.bytes, i.shards])).toEqual([
    [5 * GB, [`${folder}/a-00001-of-00003.gguf`]],
    [4 * GB, [`${folder}/b-00001-of-00002.gguf`, `${folder}/b-00002-of-00002.gguf`]],
    [3 * GB, [`${folder}/a-00001-of-00002.safetensors`]],
    [2 * GB, [`${folder}/a-00001-of-00002.gguf`, `${folder}/a-00002-of-00002.gguf`]],
  ])
})

test("shardSets: an unsharded gguf and an image pass through unchanged, largest first", () => {
  const stem = "/me/models/loose/models--nvidia--Qwen"
  const merged = shardSets([
    { bytes: 4 * GB, kind: "weights" as const, path: `${stem}/separate.gguf`, recorded: false },
    {
      bytes: 5 * GB,
      id: "sha256:aaa",
      kind: "image" as const,
      path: "docker image x:1",
      recorded: false,
    },
  ])
  expect(merged).toEqual([
    { bytes: 5 * GB, id: "sha256:aaa", kind: "image", path: "docker image x:1", recorded: false },
    { bytes: 4 * GB, kind: "weights", path: `${stem}/separate.gguf`, recorded: false },
  ])
})

test("a sharded model's four loose shards under models/ are one item end to end: measureUnused reads the whole set at its total, each shard path carried", async () => {
  const { models, places } = setUp()
  const stem = join(models, "models--nvidia--Qwen-27B-shards")
  const shards = ["00001", "00002", "00003", "00004"].map((n) => `${stem}-${n}-of-00004.gguf`)
  // One shard under 100 MiB by its stated size, the rest 200 MiB, so the set reads at its whole total.
  sized(shards[0]!, 10 * MB)
  shards.slice(1).forEach((p) => sized(p, 200 * MB))
  const { items } = await measureUnused(places)
  const sharded = items.find((i) => i.kind === "weights" && Array.isArray(i.shards))
  expect(sharded).toEqual({
    bytes: shards.reduce((sum, p) => sum + statSync(p).size, 0),
    kind: "weights",
    path: shards[0]!,
    recorded: false,
    shards,
  })
})
