import { afterAll, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  extraWordRefusal,
  HELP,
  VERBS,
  verbArgv,
} from "../../../../../packages/scripts/src/playground/plan"

const ROOT = join(import.meta.dir, "../../../../..")
const scripts: Record<string, string> = JSON.parse(
  readFileSync(join(ROOT, "package.json"), "utf8"),
).scripts
const scratch = mkdtempSync(join(tmpdir(), "playground-verbs-"))
afterAll(() => rmSync(scratch, { force: true, recursive: true }))

test("the verbs are package scripts' plain names, A to Z", () => {
  expect(VERBS).toEqual(["ask", "changelog", "dm", "ingest", "queues", "thread", "wa"])
})

// the old desk: names are gone with the rename's code half, so no job or session names one
test("each verb is a package script, under no other name", () => {
  for (const verb of VERBS) {
    expect(scripts[verb]).toStartWith("bun ")
    expect(scripts[`desk:${verb}`]).toBeUndefined()
  }
})

// a scratch package whose verb scripts echo what they got, so the script and playground's argv are run for real
test("the script and playground <verb> run the same command with the same words", () => {
  const fake = Object.fromEntries(VERBS.map((verb) => [verb, `echo ran ${verb}`]))
  writeFileSync(join(scratch, "package.json"), JSON.stringify({ scripts: fake }))
  const run = (argv: string[]) =>
    Bun.spawnSync([process.execPath, ...argv], { cwd: scratch, env: { PATH: process.env.PATH } })
      .stdout.toString()
      .trim()
  for (const verb of VERBS) {
    const words = ["new", "--by", "x"]
    const expected = `ran ${verb} new --by x`
    expect(run(["run", verb, ...words])).toBe(expected)
    expect(run(verbArgv(verb, words))).toBe(expected)
  }
})

test("a verb takes any words, and help names each", () => {
  for (const verb of VERBS) {
    expect(extraWordRefusal([verb, "new", "--by", "x"])).toBeNull()
    expect(HELP).toContain(`\nplayground ${verb} `)
  }
})
