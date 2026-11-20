import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import {
  PEER_POLICY,
  PEER_RULE,
  ROOT_BASE,
  ROOT_CA,
  ROOT_DIR,
  ROOT_NAMES,
  ROOT_STEPS,
} from "../../../../../packages/config/src/inbox"
import {
  type RecordIo,
  runRecord,
  USAGE,
} from "../../../../../packages/scripts/src/machine-record/cli"
import {
  seedEntries,
  treePaths,
  undoOf,
} from "../../../../../packages/scripts/src/machine-record/notes"
import {
  addEntries,
  check,
  dropPaths,
  type Entry,
  peerRecordArgv,
  type Places,
  readRecord,
  recordPath,
  ROOT_FOLDERS,
  rootEntries,
  seed,
  TEMP_PREFIX,
  watchedFolders,
} from "../../../../../packages/scripts/src/machine-record/record"

let root: string
let home: string
let data: string
const NOW = new Date("2026-11-17T06:00:00Z")

const noDocker = async () => ({ code: 127, out: "" })
const places = (more: Partial<Places> = {}): Places => ({
  home,
  homes: [data, join(home, "code", "playground"), join(home, "models")],
  run: noDocker,
  system: [join(root, "usr-local-lib-playground")],
  ...more,
})
const entry = (path: string, more: Partial<Entry> = {}): Entry => ({
  added: NOW.toISOString(),
  by: "a test",
  kind: "folder",
  path,
  undo: `remove ${path}`,
  why: "a test made it",
  ...more,
})

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "machine-record-"))
  home = join(root, "home")
  data = join(home, ".playground")
  for (const dir of [
    data,
    join(home, ".cache"),
    join(home, ".config"),
    join(root, "usr-local-lib-playground"),
  ])
    mkdirSync(dir, { recursive: true })
})

afterEach(() => {
  rmSync(root, { force: true, recursive: true })
})

describe("the daily check (PG-2538)", () => {
  test("a path made by hand in ~/.cache shows in the next check, and add for it clears the finding", async () => {
    await seed(data, [], places())
    expect(await check(data, places())).toEqual([])
    const made = join(home, ".cache", "by-hand")
    mkdirSync(made)
    expect(await check(data, places())).toEqual([`misplaced: ${made}`])
    expect(await addEntries(data, [entry(made)])).toEqual([made])
    expect(await check(data, places())).toEqual([])
  })

  test("a new path inside the factory's homes reads unrecorded, outside them misplaced", async () => {
    await seed(data, [], places())
    mkdirSync(join(home, "models"))
    mkdirSync(join(home, "probe-local-model"))
    expect(await check(data, places())).toEqual([
      `unrecorded: ${join(home, "models")}`,
      `misplaced: ${join(home, "probe-local-model")}`,
    ])
  })

  test("what the seed's baseline holds is never new, and each watched place is read", async () => {
    const before = join(home, ".config", "owner-tool")
    mkdirSync(before)
    await seed(data, [], places())
    const after = [".bun/bin/socat", ".local/bin/uv", ".config/systemd/user/x.service"]
    for (const rel of after) {
      mkdirSync(dirname(join(home, rel)), { recursive: true })
      writeFileSync(join(home, rel), "")
    }
    writeFileSync(join(root, "usr-local-lib-playground", "new-step"), "")
    const found = await check(data, places())
    expect(found).not.toContain(`misplaced: ${before}`)
    for (const rel of after) expect(found).toContain(`misplaced: ${join(home, rel)}`)
    expect(found).toContain(`misplaced: ${join(root, "usr-local-lib-playground", "new-step")}`)
  })

  test("a recorded path that is gone reads gone", async () => {
    const made = join(home, ".cache", "kept")
    mkdirSync(made)
    await seed(data, [entry(made)], places())
    expect(await check(data, places())).toEqual([])
    rmSync(made, { recursive: true })
    expect(await check(data, places())).toEqual([`gone: ${made}`])
  })

  test("a place the check should read but cannot reads unreadable once a run, never gone or new, and a recorded path in it too", async () => {
    const shut = join(home, ".config", "systemd", "user")
    const inside = join(shut, "x.service")
    mkdirSync(shut, { recursive: true })
    writeFileSync(inside, "")
    await seed(data, [entry(inside, { kind: "file" })], places())
    chmodSync(shut, 0o000)
    try {
      expect(await check(data, places())).toEqual([`unreadable: ${shut}`, `unreadable: ${inside}`])
    } finally {
      chmodSync(shut, 0o755)
    }
  })

  test("a root-only watched folder the user cannot read reads known with its reason, and a recorded path in it reads nothing, never unreadable", async () => {
    const rootOnly = join(root, "usr-local-lib-playground")
    const rule = join(rootOnly, "49-playground-root.rules")
    writeFileSync(rule, "")
    await seed(data, [entry(rule, { kind: "file" })], places())
    chmodSync(rootOnly, 0o000)
    try {
      const lines = await check(data, places({ rootOnly: [rootOnly] }))
      expect(lines).toContain(
        `root-only: ${rootOnly}, no root helper on this machine, so its listing is skipped`,
      )
      expect(lines.filter((line) => line.startsWith("unreadable:"))).toEqual([])
    } finally {
      chmodSync(rootOnly, 0o755)
    }
  })

  test("a root-only watched folder the record holds no path in is left out, with no line", async () => {
    const rootOnly = join(root, "usr-local-lib-playground")
    await seed(data, [], places())
    chmodSync(rootOnly, 0o000)
    try {
      expect(await check(data, places({ rootOnly: [rootOnly] }))).toEqual([])
    } finally {
      chmodSync(rootOnly, 0o755)
    }
  })

  test("a root-only watched folder the user can list is watched as any other, so a new path in it reads misplaced", async () => {
    const rootOnly = join(root, "usr-local-lib-playground")
    await seed(data, [], places())
    writeFileSync(join(rootOnly, "by-hand.rules"), "")
    expect(await check(data, places({ rootOnly: [rootOnly] }))).toEqual([
      `misplaced: ${join(rootOnly, "by-hand.rules")}`,
    ])
  })

  test("a root-step folder the install leaves readable reads unreadable when the user cannot list it", async () => {
    const shut = join(root, "usr-local-lib-playground")
    await seed(data, [], places())
    chmodSync(shut, 0o000)
    try {
      const lines = await check(data, places())
      expect(lines).toContain(`unreadable: ${shut}`)
      expect(lines.some((line) => line.startsWith("root-only:"))).toBe(false)
    } finally {
      chmodSync(shut, 0o755)
    }
  })

  test("docker's images and containers are watched; one docker no longer holds is gone, and a docker that fails reads unreadable", async () => {
    let images = "vllm/vllm-openai:v0.32.0\n<none>:<none>\n"
    let up = true
    const docker = async (argv: string[]) =>
      !up
        ? { code: 1, out: "Cannot connect to the Docker daemon" }
        : argv[1] === "image"
          ? { code: 0, out: images }
          : { code: 0, out: "probe-vllm\n" }
    await seed(
      data,
      [entry("docker image vllm/vllm-openai:v0.32.0", { kind: "image" })],
      places({ run: docker }),
    )
    expect(await check(data, places({ run: docker }))).toEqual([])
    images += "postgres:18-alpine\n"
    expect(await check(data, places({ run: docker }))).toEqual([
      "unrecorded: docker image postgres:18-alpine",
    ])
    images = "postgres:18-alpine\n"
    await addEntries(data, [entry("docker image postgres:18-alpine", { kind: "image" })])
    expect(await check(data, places({ run: docker }))).toEqual([
      "gone: docker image vllm/vllm-openai:v0.32.0",
    ])
    up = false
    expect(await check(data, places({ run: docker }))).toEqual([
      "unreadable: docker images and containers",
      "unreadable: docker image postgres:18-alpine",
      "unreadable: docker image vllm/vllm-openai:v0.32.0",
    ])
  })
})

describe("the record's writes (PG-2538)", () => {
  test("add writes atomically, and adding a path it holds again writes nothing", async () => {
    const path = join(home, ".cache", "a")
    expect(await addEntries(data, [entry(`${path}/`)])).toEqual([path])
    const first = statSync(recordPath(data)).mtimeMs
    expect(await addEntries(data, [entry(path, { why: "again" })])).toEqual([])
    expect(statSync(recordPath(data)).mtimeMs).toBe(first)
    expect((await readRecord(data)).entries.map((e) => [e.path, e.why])).toEqual([
      [path, "a test made it"],
    ])
    expect(await dropPaths(data, [path])).toEqual([path])
    expect(await dropPaths(data, [path])).toEqual([])
    expect((await readRecord(data)).entries).toEqual([])
  })

  test("a record that does not read throws, so no write replaces it", async () => {
    writeFileSync(recordPath(data), "{ not json")
    await expect(addEntries(data, [entry("/x")])).rejects.toThrow()
    writeFileSync(recordPath(data), JSON.stringify({ baseline: [], entries: [{ path: "/x" }] }))
    await expect(readRecord(data)).rejects.toThrow("is not a machine record")
  })
})

describe("playground record (PG-2538)", () => {
  const io = (lines: string[], stdin = ""): RecordIo => ({
    data,
    err: (line) => lines.push(`err: ${line}`),
    home,
    machine: "spark-test",
    now: () => NOW,
    out: (line) => lines.push(line),
    places: () => places(),
    stdin: async () => stdin,
  })

  test("--help prints the usage and exits 0", async () => {
    const lines: string[] = []
    expect(await runRecord(["--help"], io(lines))).toBe(0)
    expect(lines).toEqual([USAGE])
  })

  test("add, drop and check by their words, and a usage error exits 2", async () => {
    const lines: string[] = []
    const path = join(home, ".cache", "tool")
    mkdirSync(path)
    const add = ["add", path, "--kind", "folder", "--why", "a test", "--undo", `remove ${path}`]
    expect(await runRecord(add, io(lines))).toBe(0)
    expect(await runRecord(add, io(lines))).toBe(0)
    expect(lines).toEqual([`recorded ${path}`, "already recorded"])
    expect((await readRecord(data)).entries[0]).toMatchObject({ by: "hand", kind: "folder", path })
    expect(await runRecord(["add", path, "--kind", "folder"], io([]))).toBe(2)
    expect(
      await runRecord(["add", "relative", "--kind", "file", "--why", "w", "--undo", "u"], io([])),
    ).toBe(2)
    expect(
      await runRecord(["add", path, "--kind", "rock", "--why", "w", "--undo", "u"], io([])),
    ).toBe(2)
    expect(await runRecord(["prune"], io([]))).toBe(2)
    const checked: string[] = []
    await seed(data, [], places())
    mkdirSync(join(home, ".cache", "new"))
    expect(await runRecord(["check"], io(checked))).toBe(1)
    expect(checked).toEqual([`misplaced: ${join(home, ".cache", "new")}`])
    expect(await runRecord(["drop", path], io([]))).toBe(0)
    expect(await runRecord(["drop", path], io([]))).toBe(1)
  })

  test("add --stdin takes a peer's JSON list, its ~/ paths read under this home", async () => {
    const lines: string[] = []
    const sent = JSON.stringify(rootEntries("install", { now: NOW, peer: true }))
    expect(await runRecord(["add", "--stdin"], io(lines, sent))).toBe(0)
    expect(lines).toContain(`recorded ${join(home, ".cache", "playground-root")}`)
    expect(lines).toContain(`recorded ${PEER_RULE}`)
    expect(await runRecord(["add", "--stdin"], io([], "{}"))).toBe(2)
  })

  test("seed takes this machine's paths from the notes, and the baseline", async () => {
    const notes = join(root, "bundles")
    mkdirSync(notes)
    writeFileSync(join(notes, "footprint.md"), FOOTPRINT)
    writeFileSync(join(notes, "spark-test-undo.md"), UNDO)
    const owner = join(home, ".config", "owner-tool")
    mkdirSync(owner)
    const run = join(home, "models", "kit", "runs", "MB-model-1s-2555")
    mkdirSync(run, { recursive: true })
    const lines: string[] = []
    expect(await runRecord(["seed", "--notes", notes], io(lines))).toBe(0)
    expect(lines).toEqual([
      `err: playground record: skipped ${home}/models/hf/ acme/Model-7B: not one plain path on this machine, so add it by hand`,
      "seeded 12 of 12 paths for spark-test, and the baseline",
    ])
    expect((await readRecord(data)).entries.map((e) => e.path)).toContain(run)
    const record = await readRecord(data)
    expect(record.baseline).toContain(owner)
    expect(
      record.entries.find((e) => e.path === join(home, ".local", "bin", "socat")),
    ).toMatchObject({
      by: "seed",
      undo: "Undo: on spark-test `rm ~/.local/bin/socat`.",
      why: "seeded from bundles/footprint.md: test only",
    })
    expect(await runRecord(["seed", "--notes", notes, "--machine", "elsewhere"], io([]))).toBe(1)
  })
})

const FOOTPRINT = `# The factory's footprint

\`\`\`
spark-test (bravo, 10.0.0.2)
├── /etc/apparmor.d/bwrap
├── docker: vllm/vllm-openai:v0.32.0 (no container now), probe-vllm, postgres:alpine (#2542's runs)
└── ~/
    ├── .ssh/playground_spark, playground_spark.pub        # 🔶
    ├── .local/bin/socat                                   # test only
    ├── .playground/
    └── models/
        ├── hf/ acme/Model-7B
        ├── kit/serve-mb.sh, kit/scratch/sh-before-wxzmmr/  # the bench kit
        └── kit/runs/MB-model-1s-<pr>/

spark-other (alpha, 10.0.0.1)
└── ~/
    └── .portless/
\`\`\`
`

const UNDO = `# undo

1. A key.
   - Undo: on spark-test \`rm ~/.ssh/playground_spark\`.

7. socat.
   - spark-test: ~/.local/bin/socat (mode 755).
   - Undo: on spark-test \`rm ~/.local/bin/socat\`.
`

describe("the seed's notes (PG-2538)", () => {
  test("reads one machine's tree: ~/ under home, a comma list sharing its folder, docker items by kind, the comment as why", () => {
    expect(treePaths(FOOTPRINT, "spark-test", "/h").paths).toEqual([
      { comment: "", folder: false, path: "/etc/apparmor.d/bwrap" },
      { comment: "", folder: false, path: "docker image vllm/vllm-openai:v0.32.0" },
      { comment: "", folder: false, path: "docker container probe-vllm" },
      { comment: "", folder: false, path: "docker image postgres:alpine" },
      { comment: "🔶", folder: false, path: "/h/.ssh/playground_spark" },
      { comment: "🔶", folder: false, path: "/h/.ssh/playground_spark.pub" },
      { comment: "test only", folder: false, path: "/h/.local/bin/socat" },
      { comment: "", folder: true, path: "/h/.playground" },
      { comment: "", folder: true, path: "/h/models" },
      { comment: "the bench kit", folder: false, path: "/h/models/kit/serve-mb.sh" },
      { comment: "the bench kit", folder: true, path: "/h/models/kit/scratch/sh-before-wxzmmr" },
      { comment: "", folder: true, path: "/h/models/kit/runs/MB-model-1s-*" },
    ])
    expect(treePaths(FOOTPRINT, "spark-other", "/h")).toEqual({
      paths: [{ comment: "", folder: true, path: "/h/.portless" }],
      skipped: [],
    })
  })

  test("reads a comma list's later item with a folder of its own from the first item's parent, as the usage's example says", () => {
    const tree = "spark-test\n└── ~/\n    └── kit/a.sh, b.sh, logs/c.sh\n"
    expect(treePaths(tree, "spark-test", "/h").paths.map((p) => p.path)).toEqual([
      "/h/kit/a.sh",
      "/h/kit/b.sh",
      "/h/logs/c.sh",
    ])
    expect(USAGE).toContain('"kit/a.sh, b.sh, logs/c.sh"')
  })

  test("an item the seed cannot take as written is skipped and named, never recorded: an aside, a space, a placeholder nothing matches", () => {
    expect(treePaths(FOOTPRINT, "spark-test", "/h").skipped).toEqual([
      "/h/models/hf/ acme/Model-7B",
    ])
    const { entries, skipped } = seedEntries(FOOTPRINT, UNDO, "spark-test", "/h", NOW)
    expect(skipped).toEqual(["/h/models/hf/ acme/Model-7B", "/h/models/kit/runs/MB-model-1s-*"])
    for (const { path } of entries) expect(path, path).toMatch(/^(?:docker \S+ \S+|\/[^\s*<>()]+)$/)
  })

  test("takes each path's undo from the first step that names it, else points at both notes", () => {
    expect(undoOf(UNDO, "/h/.ssh/playground_spark", "/h", "spark-test")).toBe(
      "Undo: on spark-test `rm ~/.ssh/playground_spark`.",
    )
    expect(undoOf(UNDO, "/h/.portless", "/h", "spark-test")).toBe(
      "see bundles/footprint.md and bundles/spark-test-undo.md",
    )
  })

  test("the seed's entries carry the data folder's own path too, which check never names", () => {
    const paths = seedEntries(FOOTPRINT, UNDO, "spark-test", "/h", NOW).entries.map((e) => e.path)
    expect(paths).toContain("/h/.playground")
  })
})

describe("what adds a path keeps it where the check looks (PG-2538)", () => {
  const HOME = "/home/someone"
  const DATA = `${HOME}/.playground`
  const watched = watchedFolders(HOME)
  // A target is held when it is a watched folder, sits directly in one, lies in the data folder, or is spawn.sh's temp folder.
  const held = (path: string) =>
    watched.includes(path) ||
    watched.includes(dirname(path)) ||
    path.startsWith(`${DATA}/`) ||
    path.startsWith(TEMP_PREFIX)

  test("every path a root card's install or step puts on a machine, here or on a peer, is held", () => {
    const paths = [
      ...rootEntries("install", { ca: true, now: NOW, peer: true }),
      ...ROOT_NAMES.flatMap((step) => rootEntries(step, { now: NOW, peer: false })),
    ].map((e) => e.path.replace(/^~\//, `${HOME}/`))
    expect(paths).toEqual(
      expect.arrayContaining([
        ROOT_BASE,
        ROOT_DIR,
        ROOT_CA,
        PEER_POLICY,
        PEER_RULE,
        ...Object.values(ROOT_STEPS).flatMap((s) => s.adds),
      ]),
    )
    for (const path of paths) expect(held(path), path).toBe(true)
    expect(ROOT_FOLDERS).toContain(dirname(PEER_RULE))
  })

  test("every link link-skills.sh makes outside the data folder is held, and each goes into the record", async () => {
    const script = await Bun.file(
      join(import.meta.dir, "../../../../../scripts/link-skills.sh"),
    ).text()
    const targets = [...script.matchAll(/^\s*(?:if .*then )?link_file "[^"]+" "([^"]+)"/gm)].map(
      (m) =>
        m[1]!
          .replace("$HOME", HOME)
          .replace("$DATA", DATA)
          .replace("$RUSH", `${DATA}/brief-rush.md`),
    )
    expect(targets).toEqual(
      expect.arrayContaining([`${HOME}/.bun/bin/playground`, `${HOME}/.bun/bin/security`]),
    )
    for (const target of targets) expect(held(target), target).toBe(true)
    expect(script).toMatch(
      /link_file\(\) \{[\s\S]*machine-record\/cli\.ts" add "\$target"[\s\S]*\n\}/,
    )
  })

  test("spawn.sh's --ssh probe folder on the peer is a temp folder the check skips", async () => {
    const spawn = await Bun.file(join(import.meta.dir, "../../../../../scripts/spawn.sh")).text()
    const remote =
      /^\[ -z "\$SSH_HOST" \] \|\| REMOTE=\$\{LINUX_TEMP:-\$\(mktemp -u "(\/tmp\/playground-)\$NAME\.XXXXXX"\)\}$/m.exec(
        spawn,
      )
    expect(remote?.[1]).toBe(TEMP_PREFIX)
    expect(spawn).toMatch(/LINUX_TEMP=\$\(mktemp -d "\/tmp\/playground-\$NAME\.XXXXXX"\)/)
    expect(watched.some((folder) => folder === "/tmp" || folder.startsWith("/tmp/"))).toBe(false)
  })

  test("ci.sh's run folder on the box is held, and every upload hands it to the record", async () => {
    const ci = await Bun.file(
      join(import.meta.dir, "../../../../../scripts/ops/runner-host/ci.sh"),
    ).text()
    const folder = /^BOX_CI_DIR=([A-Za-z0-9._/-]+)$/m.exec(ci)?.[1]
    expect(folder).toBeDefined()
    expect(held(`${HOME}/${folder}`), folder).toBe(true)
    expect(ci).toContain("CI=$BOXHOME/$BOX_CI_DIR")
    expect(ci).toMatch(/\/suite\.sh" \|\| exit 255\n {2}record\n {2}git -C "\$1" archive /)
  })

  test("every image suite.sh starts a container from on the box is an entry ci.sh's record hands the box", async () => {
    const [suite, ci] = await Promise.all(
      ["suite.sh", "ci.sh"].map((name) =>
        Bun.file(join(import.meta.dir, "../../../../../scripts/ops/runner-host", name)).text(),
      ),
    )
    const images = [...suite!.matchAll(/docker run -d [^\n]* ([a-z0-9./-]+:[a-z0-9.-]+) >/g)].map(
      (m) => m[1]!,
    )
    expect(images).toEqual(["postgres:alpine"])
    for (const image of images)
      expect(ci).toContain(`"kind":"image","path":"docker image ${image}"`)
  })

  test("a peer is reached by one fixed ssh: the key alone, no prompt, no user config, the record CLI in its clone", () => {
    expect(peerRecordArgv("/k", "me@spark", "~/code/playground", "check")).toEqual([
      "ssh",
      "-F",
      "none",
      "-i",
      "/k",
      "-o",
      "IdentitiesOnly=yes",
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=10",
      "me@spark",
      'cd ~/code/playground && PATH="$HOME/.bun/bin:$PATH" exec bun --no-env-file packages/scripts/src/machine-record/cli.ts check',
    ])
    expect(peerRecordArgv(undefined, "me@spark", "~/p", "add").at(-1)).toEndWith(
      "cli.ts add --stdin",
    )
  })
})
