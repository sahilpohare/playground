import { afterAll, describe, expect, test } from "bun:test"
import {
  appendFileSync,
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { listTrash, quarantine, restore, type Roots } from "../../../../../packages/safe-delete/src"
import { keepPage, removePage } from "../../../../../packages/scripts/src/playground/page"

const CLI = join(import.meta.dir, "../../../../../packages/scripts/src/playground/cli.ts")
const dir = mkdtempSync(join(tmpdir(), "dispatcher-page-"))
afterAll(() => rmSync(dir, { force: true, recursive: true }))

// A scratch config folder whose roster lists two sessions, and an open that writes what it was given, so a call to open leaves a file the test checks for.
const setup = async () => {
  const root = mkdtempSync(join(dir, "run-"))
  const config = join(root, "claude")
  await Bun.write(
    join(config, "playground", "roster.json"),
    JSON.stringify({ agents: [{ name: "planner" }, { name: "vwrv7f-worker" }] }),
  )
  const bin = join(root, "bin")
  await Bun.write(join(bin, "open"), `#!/bin/sh\necho "$@" >> ${join(root, "opened")}\n`)
  chmodSync(join(bin, "open"), 0o755)
  const page = (...args: string[]) => {
    const run = Bun.spawnSync([process.execPath, "--no-env-file", CLI, "page", ...args], {
      env: {
        CLAUDE_CONFIG_DIR: config,
        PLAYGROUND_DATA_DIR: join(config, "playground"),
        HOME: root,
        PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
      },
      stderr: "pipe",
      stdout: "pipe",
    })
    return { code: run.exitCode, err: run.stderr.toString(), out: run.stdout.toString() }
  }
  return {
    opened: join(root, "opened"),
    page,
    previews: join(config, "playground", "previews"),
    root,
  }
}

describe("playground page (#1850)", () => {
  test("copies the page, writes its caption, appends its line, opens nothing, and takes a free name on a clash", async () => {
    const { opened, page, previews, root } = await setup()
    const file = join(root, "lookup.html")
    await Bun.write(file, "<!doctype html><title>Lookup</title>")
    const by = ["--title", "Property lookup", "--by", "vwrv7f-worker", "--for", "planner"]
    expect(page(file, ...by).code).toBe(0)
    expect(page(file, "--title", "Again", "--by", "planner").code).toBe(0)
    expect(readFileSync(join(previews, "lookup.html"), "utf8")).toBe(
      "<!doctype html><title>Lookup</title>",
    )
    expect(readFileSync(join(previews, "lookup.txt"), "utf8")).toBe("Property lookup\n")
    expect(readFileSync(join(previews, "lookup-2.txt"), "utf8")).toBe("Again\n")
    const lines = readFileSync(join(previews, "pages.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
    expect(lines.map(({ at: _, ...rest }) => rest)).toEqual([
      { by: "vwrv7f-worker", file: "lookup.html", for: "planner", title: "Property lookup" },
      { by: "planner", file: "lookup-2.html", for: null, title: "Again" },
    ])
    expect(Number.isNaN(Date.parse(lines[0].at))).toBe(false)
    expect(existsSync(opened)).toBe(false)
  })

  test("refuses a file that is not HTML and a --by or --for the roster does not list", async () => {
    const { page, previews, root } = await setup()
    const png = join(root, "shot.png")
    await Bun.write(png, new Uint8Array([0x89, 0x50, 0x4e, 0x47]))
    const binary = join(root, "binary.html")
    await Bun.write(binary, new Uint8Array([0xff, 0xfe, 0x00, 0x80]))
    const html = join(root, "ok.html")
    await Bun.write(html, "<p>ok</p>")
    const refusals = [
      page(png, "--title", "Shot", "--by", "planner"),
      page(binary, "--title", "Binary", "--by", "planner"),
      page(html, "--title", "Ok", "--by", "nobody-worker"),
      page(html, "--title", "Ok", "--by", "planner", "--for", "nobody"),
      page(html, "--by", "planner"),
    ]
    for (const refused of refusals) expect(refused.code).toBe(1)
    expect(refusals[0]!.err).toContain("not an HTML file")
    expect(refusals[1]!.err).toContain("not text")
    expect(refusals[2]!.err).toContain("no session named nobody-worker")
    expect(refusals[3]!.err).toContain("no session named nobody")
    expect(refusals[4]!.err).toContain("usage: playground page")
    expect(existsSync(previews)).toBe(false)
  })
})

// A fake machine for playground page --remove: a HOME whose data folder holds the roster, the previews folder and the trash, and a main checkout beside it; nothing reaches the real data folder.
const fakeMachine = () => {
  const root = realpathSync(mkdtempSync(join(dir, "remove-")))
  const home = join(root, "home")
  const data = join(home, ".playground")
  const roots: Roots = { home, main: join(root, "main"), trash: join(data, "trash") }
  mkdirSync(roots.main, { recursive: true })
  mkdirSync(join(data, "previews"), { recursive: true })
  writeFileSync(join(data, "roster.json"), JSON.stringify({ agents: [{ name: "planner" }] }))
  return { data, previews: join(data, "previews"), root, roots }
}

// Keeps a page as playground page does, with a PDF beside it when asked.
const keep = (data: string, root: string, name: string, pdf = false): string => {
  const source = join(root, "source", name)
  mkdirSync(dirname(source), { recursive: true })
  writeFileSync(source, `<p>${name}</p>`)
  const kept = keepPage({ by: "planner", file: source, for: null, title: name }, data)
  if ("error" in kept) throw new Error(kept.error)
  if (pdf) writeFileSync(kept.path.replace(/\.html$/, ".pdf"), "%PDF-1.7\n")
  return kept.path
}

// The previews folder's files and the index as they stand, so a refusal is shown to leave both as they were.
const snapshot = (previews: string) => ({
  files: readdirSync(previews).sort(),
  index: readFileSync(join(previews, "pages.jsonl"), "utf8"),
})

const NOW = new Date("2026-11-15T10:00:00Z")
const LATER = new Date("2026-11-15T10:05:00Z")

describe("playground page --remove (#2191)", () => {
  test("removes a listed page whole: its line drops from the index, its HTML, caption and PDF move to the trash, and restore brings each back", () => {
    const { data, previews, roots, root } = fakeMachine()
    keep(data, root, "report.html", true)
    keep(data, root, "other.html")
    const before = readFileSync(join(previews, "pages.jsonl"), "utf8")
    const removed = removePage("report.html", data, { now: NOW, roots, session: "tester" })
    if (!("moved" in removed)) throw new Error(removed.error)
    expect(removed.moved.map((m) => m.file).sort()).toEqual([
      "report.html",
      "report.pdf",
      "report.txt",
    ])
    expect(readdirSync(previews).sort()).toEqual(["other.html", "other.txt", "pages.jsonl"])
    const index = readFileSync(join(previews, "pages.jsonl"), "utf8")
    expect(index.startsWith(before)).toBe(true)
    expect(JSON.parse(index.slice(before.length))).toEqual({
      at: NOW.toISOString(),
      deleted: true,
      file: "report.html",
    })
    const trashed = listTrash(roots.trash)
    expect(trashed.map((entry) => entry.carveOut)).toEqual(["page", "page", "page"])
    for (const entry of trashed) expect(restore(entry.id, roots)).toEqual({ path: entry.path })
    expect(readFileSync(join(previews, "report.html"), "utf8")).toBe("<p>report.html</p>")
    expect(readFileSync(join(previews, "report.txt"), "utf8")).toBe("report.html\n")
    expect(readFileSync(join(previews, "report.pdf"), "utf8")).toBe("%PDF-1.7\n")
  })

  test("refuses a file the index does not list, a path outside the previews folder, a .. step, the index itself, a page over the cap, a hard link and a symlink, and leaves the index and every file as they were", () => {
    const { data, previews, roots, root } = fakeMachine()
    keep(data, root, "report.html")
    writeFileSync(join(previews, "unlisted.html"), "<p>unlisted</p>")
    const outside = join(root, "elsewhere", "report.html")
    mkdirSync(dirname(outside), { recursive: true })
    writeFileSync(outside, "<p>outside</p>")
    const big = keep(data, root, "big.html")
    writeFileSync(big, "x".repeat(20 * 1024 * 1024 + 1))
    const linked = keep(data, root, "linked.html")
    linkSync(linked, join(root, "elsewhere", "linked.html"))
    const target = join(root, "elsewhere", "target.html")
    writeFileSync(target, "<p>target</p>")
    const symlinked = keep(data, root, "symlinked.html")
    rmSync(symlinked)
    symlinkSync(target, symlinked)
    const before = snapshot(previews)
    const refusals: [string, string][] = [
      ["unlisted.html", "pages.jsonl lists no page"],
      [outside, "not in the previews folder"],
      [`${previews}/../previews/report.html`, "a .. step"],
      ["pages.jsonl", "not an HTML file"],
      ["big.html", "over 20 MiB"],
      ["linked.html", "not a regular file with one link"],
      ["symlinked.html", "not a regular file with one link"],
    ]
    for (const [target, why] of refusals) {
      const refused = removePage(target, data, { now: NOW, roots, session: "tester" })
      expect("error" in refused ? refused.error : "moved").toContain(why)
    }
    expect(snapshot(previews)).toEqual(before)
    expect(readFileSync(target, "utf8")).toBe("<p>target</p>")
    expect(listTrash(roots.trash)).toEqual([])
  })

  // #2237's review: an index that is only too big is refused for its size, never blamed on a link.
  test("refuses an index over 20 MiB by its size alone, and leaves every file as it was", () => {
    const { data, previews, roots, root } = fakeMachine()
    keep(data, root, "report.html")
    appendFileSync(join(previews, "pages.jsonl"), " ".repeat(20 * 1024 * 1024))
    const before = snapshot(previews)
    const refused = removePage("report.html", data, { now: NOW, roots, session: "tester" })
    const error = "error" in refused ? refused.error : "moved"
    expect(error).toContain("pages.jsonl is over 20 MiB")
    expect(error).not.toContain("link")
    expect(snapshot(previews)).toEqual(before)
    expect(listTrash(roots.trash)).toEqual([])
  })

  test("refuses a second removal inside the minute before any file moves, so the trash's per-minute cap never stops one partway", () => {
    const { data, previews, roots, root } = fakeMachine()
    keep(data, root, "first.html", true)
    keep(data, root, "second.html")
    expect("moved" in removePage("first.html", data, { now: NOW, roots, session: "tester" })).toBe(
      true,
    )
    const before = snapshot(previews)
    const refused = removePage("second.html", data, { now: NOW, roots, session: "tester" })
    expect("error" in refused ? refused.error : "moved").toContain("a minute")
    expect(snapshot(previews)).toEqual(before)
    expect(
      "moved" in removePage("second.html", data, { now: LATER, roots, session: "tester" }),
    ).toBe(true)
  })

  test("an index it cannot append to puts the HTML back from the trash, so the page stays listed with its file", () => {
    const { data, previews, roots, root } = fakeMachine()
    keep(data, root, "report.html")
    const before = snapshot(previews)
    chmodSync(join(previews, "pages.jsonl"), 0o444)
    const refused = removePage("report.html", data, { now: NOW, roots, session: "tester" })
    chmodSync(join(previews, "pages.jsonl"), 0o644)
    expect("error" in refused ? refused.error : "moved").toContain("put back")
    expect(snapshot(previews)).toEqual(before)
    expect(readFileSync(join(previews, "report.html"), "utf8")).toBe("<p>report.html</p>")
    expect(listTrash(roots.trash)).toEqual([])
  })

  test("a caption that does not move once the line is dropped stays as an unlisted file the error names", () => {
    const { data, previews, roots, root } = fakeMachine()
    keep(data, root, "report.html")
    const move: typeof quarantine = (path, opts, at, io) =>
      path.endsWith(".txt")
        ? { kind: "refused", refused: "the disk said no" }
        : quarantine(path, opts, at, io)
    const refused = removePage("report.html", data, { move, now: NOW, roots, session: "tester" })
    expect("error" in refused ? refused.error : "moved").toContain("report.txt")
    expect(readdirSync(previews).sort()).toEqual(["pages.jsonl", "report.txt"])
    expect(readFileSync(join(previews, "pages.jsonl"), "utf8")).toContain('"deleted":true')
  })

  test("the CLI removes a kept page by its kept path and prints each trash id, which playground rm --restore brings back", async () => {
    const { page, previews, root } = await setup()
    const file = join(root, "lookup.html")
    await Bun.write(file, "<p>lookup</p>")
    expect(page(file, "--title", "Lookup", "--by", "planner").code).toBe(0)
    const removed = page("--remove", join(previews, "lookup.html"))
    expect(removed.code).toBe(0)
    expect(existsSync(join(previews, "lookup.html"))).toBe(false)
    const ids = [...removed.out.matchAll(/\d{8}T\d{6}Z-[A-Za-z0-9-]+\/\d+/g)].map((m) => m[0])
    expect(ids.length).toBe(2)
    for (const id of ids) {
      const back = Bun.spawnSync([process.execPath, "--no-env-file", CLI, "rm", "--restore", id], {
        env: {
          CLAUDE_CONFIG_DIR: join(root, "claude"),
          PLAYGROUND_DATA_DIR: join(root, "claude", "playground"),
          HOME: root,
          PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
        },
        stderr: "pipe",
        stdout: "pipe",
      })
      expect(back.stderr.toString()).toBe("")
      expect(back.exitCode).toBe(0)
    }
    expect(readFileSync(join(previews, "lookup.html"), "utf8")).toBe("<p>lookup</p>")
    expect(readFileSync(join(previews, "lookup.txt"), "utf8")).toBe("Lookup\n")
  })
})

// #2237's review: a previews folder that is a symlink leads out of the data folder, so --remove refuses it, whatever the link points at.
test("playground page --remove refuses a previews folder that is a symlink, leaving the index and the link's target as they were", () => {
  for (const target of [".ssh", "Documents"]) {
    const { data, previews, roots, root } = fakeMachine()
    keep(data, root, "report.html")
    const elsewhere = join(roots.home, target)
    renameSync(previews, elsewhere)
    symlinkSync(elsewhere, previews)
    const before = snapshot(elsewhere)
    const refused = removePage("report.html", data, { now: NOW, roots, session: "tester" })
    expect("error" in refused ? refused.error : "moved").toContain("symlink")
    expect(snapshot(elsewhere)).toEqual(before)
    expect(listTrash(roots.trash)).toEqual([])
  }
})

// #2237's review: --remove reads pages.jsonl as the Previews app's readPages does, so a page the Pages tab never lists is never removed.
test("playground page --remove counts a page as listed only by a record the Pages tab reads, and drops one only by a tombstone of that exact shape", () => {
  const { data, previews, roots } = fakeMachine()
  for (const name of ["odd.html", "gone.html", "kept.html"])
    writeFileSync(join(previews, name), "<p>x</p>")
  const record = (file: string) => ({
    at: "2026-11-15T09:00:00.000Z",
    by: "planner",
    file,
    for: null,
    title: file,
  })
  const lines = [
    { file: "odd.html", title: "" },
    { file: "odd.html", title: "t" },
    { ...record("odd.html"), at: "yesterday" },
    record("gone.html"),
    { at: "2026-11-15T09:30:00.000Z", deleted: true, file: "gone.html" },
    record("kept.html"),
    { at: "2026-11-15T09:30:00.000Z", by: "planner", deleted: true, file: "kept.html" },
  ]
  writeFileSync(
    join(previews, "pages.jsonl"),
    lines.map((line) => `${JSON.stringify(line)}\n`).join(""),
  )
  const before = snapshot(previews)
  for (const name of ["odd.html", "gone.html"]) {
    const refused = removePage(name, data, { now: NOW, roots, session: "tester" })
    expect("error" in refused ? refused.error : "moved").toContain("pages.jsonl lists no page")
  }
  expect(snapshot(previews)).toEqual(before)
  expect("moved" in removePage("kept.html", data, { now: NOW, roots, session: "tester" })).toBe(
    true,
  )
})

// #2237's review, round 2: --remove reads and appends to pages.jsonl only as a regular file with one link, as readPages reads it, so no tombstone lands in a file outside the previews folder.
test("playground page --remove refuses a pages.jsonl that is a symlink or a hard link, before any move", () => {
  for (const kind of ["symlink", "hard link"]) {
    const { data, previews, roots, root } = fakeMachine()
    keep(data, root, "report.html")
    const outside = join(root, "outside.jsonl")
    renameSync(join(previews, "pages.jsonl"), outside)
    if (kind === "symlink") symlinkSync(outside, join(previews, "pages.jsonl"))
    else linkSync(outside, join(previews, "pages.jsonl"))
    const before = readFileSync(outside, "utf8")
    const files = readdirSync(previews).sort()
    const refused = removePage("report.html", data, { now: NOW, roots, session: "tester" })
    expect("error" in refused ? refused.error : "moved").toContain("one link")
    expect(readFileSync(outside, "utf8")).toBe(before)
    expect(readdirSync(previews).sort()).toEqual(files)
    expect(listTrash(roots.trash)).toEqual([])
  }
})
