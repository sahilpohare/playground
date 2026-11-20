import { afterAll, expect, test } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  extensionsDir,
  mustGit,
  rootLocked,
  scopeDir,
  setRootLock,
  setSetting,
  type Who,
} from "../../../../packages/settings/src"
import {
  exportTo,
  importFrom,
  judgeItem,
  putItem,
  showItem,
} from "../../../../packages/settings/src/items"

process.env.PLAYGROUND_LOGIN = "made-up-me"
const ME = "made-up-me"

const scratch = mkdtempSync(join(tmpdir(), "items-"))
afterAll(() => rmSync(scratch, { force: true, recursive: true }))

const OWNER: Who = { actor: "cli", author: "owner", inboxRef: null, reason: "seeded" }
const WORKER: Who = { ...OWNER, author: "made-up-worker", reason: "a new version" }
const REVIEWER: Who = { ...OWNER, author: "made-up-reviewer", reason: "judged" }
const ref = { key: "relay", kind: "script" as const, scope: ME }
const files = (version: string) => ({
  attachments: [],
  body: null,
  files: { "cli.ts": `console.log("${version}")` },
  value: null,
})

const revOf = (outcome: ReturnType<typeof putItem>) => {
  if (!outcome.ok) throw new Error(outcome.message)
  return outcome.rev
}
const shown = (rev: string) => {
  const item = showItem(scratch, ref, rev)
  return item && { files: item.content.files, state: item.state }
}

test("show --rev prints the revision's own files and state, a proposal beside an accepted copy included", () => {
  setSetting(scratch, { key: "clock.ownerZone", scope: ME, value: "Europe/Lisbon" }, OWNER)
  const v1 = revOf(putItem(scratch, ref, files("v1"), OWNER, true))
  const v2 = revOf(putItem(scratch, ref, files("v2"), WORKER, false))
  expect(shown(v1)).toEqual({ files: files("v1").files, state: "accepted" })
  expect(shown(v2)).toEqual({ files: files("v2").files, state: "proposed" })

  const scored = revOf(judgeItem(scratch, ref, v2, { kind: "score", score: 3 }, REVIEWER))
  expect(shown(scored)).toEqual({ files: files("v2").files, state: "proposed" })
  const rejected = revOf(judgeItem(scratch, ref, v2, { kind: "reject" }, REVIEWER))
  expect(shown(rejected)).toEqual({ files: files("v2").files, state: "rejected" })

  const v3 = revOf(putItem(scratch, ref, files("v3"), WORKER, false))
  expect(shown(v3)).toEqual({ files: files("v3").files, state: "proposed" })
  const accepted = revOf(judgeItem(scratch, ref, v3, { kind: "score", score: 5 }, REVIEWER))
  expect(shown(accepted)).toEqual({ files: files("v3").files, state: "accepted" })

  expect(shown(v2.slice(0, 12))).toEqual({ files: files("v2").files, state: "proposed" })
  expect(showItem(scratch, { ...ref, key: "other" }, v2)).toBeNull()
})

// PG-1892: show reads the stored bytes whole, so a body's final newline survives --rev and plain alike
test("show keeps a body's final newline by --rev and plain alike", () => {
  const doc = { ...ref, key: "newline", kind: "doc" as const }
  const body = { attachments: [], body: "made-up line\n", files: null, value: null }
  setSetting(scratch, { key: "clock.ownerZone", scope: ME, value: "Europe/Lisbon" }, OWNER)
  const rev = revOf(putItem(scratch, doc, body, OWNER, true))
  expect(showItem(scratch, doc, rev)?.content.body).toBe("made-up line\n")
  expect(showItem(scratch, doc)?.content.body).toBe("made-up line\n")
})

// guards that a revision written for another item reads this item from that tree as it stood, its accepted copy first, never from the other item's trailers
test("show --rev of a revision that wrote another item prints this item as that revision's tree held it", () => {
  const mine = { ...ref, key: "mine" }
  const theirs = { ...ref, key: "theirs" }
  setSetting(scratch, { key: "clock.ownerZone", scope: ME, value: "Europe/Lisbon" }, OWNER)
  revOf(putItem(scratch, mine, files("mine accepted"), OWNER, true))
  revOf(putItem(scratch, mine, files("mine proposed"), WORKER, false))
  const other = revOf(putItem(scratch, theirs, files("theirs proposed"), WORKER, false))
  const item = showItem(scratch, mine, other)
  expect(item && { files: item.content.files, state: item.state }).toEqual({
    files: files("mine accepted").files,
    state: "accepted",
  })
})

// PG-1907: a proposal that has since landed reads accepted under --rev, the same state bare show reads, while a live proposal still reads proposed
test("show --rev reads a proposal that has since landed as accepted, a live proposal still as proposed", () => {
  const gate = { ...ref, key: "gate", kind: "rule" as const }
  const text = (body: string) => ({ attachments: [], body, files: null, value: null })
  setSetting(scratch, { key: "clock.ownerZone", scope: ME, value: "Europe/Lisbon" }, OWNER)
  const proposal = revOf(putItem(scratch, gate, text("Gate one.\n"), WORKER, false))
  expect(showItem(scratch, gate, proposal)?.state).toBe("proposed")
  const accepted = revOf(judgeItem(scratch, gate, proposal, { kind: "score", score: 5 }, REVIEWER))
  expect(showItem(scratch, gate, accepted)?.state).toBe("accepted")
  expect(showItem(scratch, gate, proposal)?.state).toBe("accepted")
  expect(showItem(scratch, gate)?.state).toBe("accepted")
  const newer = revOf(putItem(scratch, gate, text("Gate two.\n"), WORKER, false))
  expect(showItem(scratch, gate, newer)?.state).toBe("proposed")
  expect(showItem(scratch, gate, proposal)?.state).toBe("accepted")
})

// PG-1907: a proposal's state follows the commit that next changed proposed/, so an accept a later accept replaced still reads accepted, and a pending or rejected proposal keeps its state however its text compares
test("show --rev reads a proposal by the commit that next changed its proposed copy", () => {
  const walk = { ...ref, key: "walk", kind: "rule" as const }
  const text = (body: string) => ({ attachments: [], body, files: null, value: null })
  setSetting(scratch, { key: "clock.ownerZone", scope: ME, value: "Europe/Lisbon" }, OWNER)
  const p1 = revOf(putItem(scratch, walk, text("Walk one.\n"), WORKER, false))
  revOf(judgeItem(scratch, walk, p1, { kind: "score", score: 5 }, REVIEWER))
  const p2 = revOf(putItem(scratch, walk, text("Walk two.\n"), WORKER, false))
  revOf(judgeItem(scratch, walk, p2, { kind: "score", score: 5 }, REVIEWER))
  expect(showItem(scratch, walk, p1)?.state).toBe("accepted")
  expect(showItem(scratch, walk, p2)?.state).toBe("accepted")
  const pending = revOf(putItem(scratch, walk, text("Walk two.\n"), WORKER, false))
  expect(showItem(scratch, walk, pending)?.state).toBe("proposed")
  const doomed = { ...ref, key: "doomed", kind: "rule" as const }
  const rejected = revOf(putItem(scratch, doomed, text("Doomed.\n"), WORKER, false))
  revOf(judgeItem(scratch, doomed, rejected, { kind: "reject" }, REVIEWER))
  const landed = revOf(putItem(scratch, doomed, text("Doomed.\n"), WORKER, false))
  revOf(judgeItem(scratch, doomed, landed, { kind: "score", score: 5 }, REVIEWER))
  expect(showItem(scratch, doomed, rejected)?.state).toBe("proposed")
})

// PG-1377: put chmods each executable name, so a name the item does not hold, such as ../x, is refused before it reaches chmodSync
test("put refuses an executable name the item does not hold", () => {
  const refusal = {
    message: "executable names a file the item does not hold",
    ok: false,
    status: 400,
  } as const
  expect(
    putItem(
      scratch,
      { ...ref, key: "escape" },
      { ...files("v1"), executable: ["../x"] },
      OWNER,
      true,
    ),
  ).toEqual(refusal)
  expect(
    putItem(
      scratch,
      { ...ref, key: "one" },
      { attachments: [], body: "#!/bin/sh\n", executable: ["run.sh"], files: null, value: null },
      OWNER,
      true,
    ),
  ).toEqual(refusal)
})

// PG-1924: an import carries a source script's executable bit, and never strips a stored script's own
test("import stores a source folder's 755 script as 100755 and keeps the stored bit on a re-import", () => {
  const from = join(scratch, "import-src", "made-up-new")
  mkdirSync(join(from, "scripts"), { recursive: true })
  const source = join(from, "scripts", "run.sh")
  writeFileSync(source, "#!/bin/sh\necho made-up\n")
  writeFileSync(join(from, "readme.md"), "made-up note\n")
  chmodSync(source, 0o755)
  expect(importFrom(scratch, join(scratch, "import-src"), false, OWNER).ok).toBe(true)
  const dir = scopeDir(scratch, "made-up-new")
  const at = join(dir, "scripts", "run.sh")
  expect(mustGit(dir, ["ls-files", "-s", "scripts/run.sh"])).toContain("100755")
  expect(statSync(at).mode & 0o777).toBe(0o755)
  expect(mustGit(dir, ["ls-files", "-s", "readme.md"])).toContain("100644")
  chmodSync(source, 0o644)
  expect(importFrom(scratch, join(scratch, "import-src"), false, OWNER).ok).toBe(true)
  expect(mustGit(dir, ["ls-files", "-s", "scripts/run.sh"])).toContain("100755")
  expect(statSync(at).mode & 0o777).toBe(0o755)
})

// The root's file lock: an import's fetch runs under withLock, which lifts that scope's folder of a locked root for it, so an export that carries the scope's history on still fast-forwards.
test.skipIf(!Bun.which("chflags"))(
  "an import into a locked root fast-forwards a scope and leaves the root locked",
  () => {
    const data = join(scratch, "locked-import")
    revOf(putItem(data, ref, files("v1"), OWNER, true))
    const out = join(scratch, "locked-export")
    exportTo(data, out)
    writeFileSync(join(out, ME, "later.md"), "made-up later note\n")
    mustGit(join(out, ME), ["add", "-A"])
    mustGit(join(out, ME), [
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "commit",
      "-q",
      "-m",
      "later",
    ])
    setRootLock(data, true)
    try {
      const done = importFrom(data, out, false, OWNER)
      expect(done.ok && done.lines[0]).toBe(`~ ${ME}: fast-forward`)
      expect(mustGit(scopeDir(data, ME), ["rev-parse", "HEAD"])).toBe(
        mustGit(join(out, ME), ["rev-parse", "HEAD"]),
      )
      expect(rootLocked(extensionsDir(data))).toBe(true)
    } finally {
      setRootLock(data, false)
    }
  },
)
