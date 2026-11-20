import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  keptLocalModel,
  loadArgv,
  runStart,
  START_MS,
  startModel,
} from "../../../../../../api/hono/src/lib/dashboard/local-load"
import { MODEL_NAME } from "../../../../../../packages/scripts/src/local-model/model"

describe("loadArgv", () => {
  test("it runs the playground CLI's model use on the kept model's folder, by this bun and no shell", () => {
    expect(loadArgv("ornith-1.5-122b", "/repo", "/bin/bun")).toEqual([
      "/bin/bun",
      "/repo/packages/scripts/src/playground/cli.ts",
      "model",
      "use",
      "ornith-1.5-122b",
    ])
    expect(loadArgv("m", "/repo")[0]).toBe(process.execPath)
  })

  test("a name model use's MODEL_NAME refuses throws before any argv is built", () => {
    for (const name of ["", "-rf", "../m", "M", "a b", "m;ls", "m/n", "m\nn"]) {
      expect(MODEL_NAME.test(name)).toBe(false)
      expect(() => loadArgv(name, "/repo")).toThrow("is not a model folder name")
    }
  })
})

describe("runStart", () => {
  const bun = (script: string) => [process.execPath, "-e", script]

  test("a start that exits 0 gives back stdout's last line", async () => {
    expect(
      await runStart(
        bun("console.log('stopping K'); console.log('started M on 8000')"),
        "/",
        10_000,
      ),
    ).toEqual({ code: 0, line: "started M on 8000" })
  })

  test("a refused start gives back its exit code and stderr's last line", async () => {
    expect(
      await runStart(
        bun(
          "console.log('reading memory'); console.error('9 GiB free, under the 15 GiB floor'); process.exit(3)",
        ),
        "/",
        10_000,
      ),
    ).toEqual({ code: 3, line: "9 GiB free, under the 15 GiB floor" })
  })

  test("a start past its timeout is stopped by its own handle and says it ran too long", async () => {
    const begun = Date.now()
    const result = await runStart(bun("await Bun.sleep(30_000)"), "/", 300)
    expect(result.code).not.toBe(0)
    expect(result.line).toBe("playground model use ran too long and was stopped")
    expect(Date.now() - begun).toBeLessThan(10_000)
  })

  test("a start stopped by another signal before its timeout names that signal", async () => {
    const result = await runStart(bun("process.kill(process.pid, 'SIGKILL')"), "/", 10_000)
    expect(result.code).not.toBe(0)
    expect(result.line).toBe("playground model use was stopped by SIGKILL")
  })

  test("it runs in the cwd it is given", async () => {
    expect(process.cwd()).not.toBe("/")
    expect(await runStart(bun("console.log(process.cwd())"), "/", 10_000)).toEqual({
      code: 0,
      line: "/",
    })
  })
})

describe("startModel", () => {
  test("a fixture stack, which a test run reads, starts no model and reaches no machine", async () => {
    expect(await startModel("m-folder", "/no/such/checkout")).toEqual({
      code: 0,
      line: "a fixture stack starts no model",
    })
    expect(START_MS).toBe(20 * 60_000)
  })
})

describe("keptLocalModel", () => {
  const scratch = mkdtempSync(join(tmpdir(), "kept-"))
  afterAll(() => rmSync(scratch, { force: true, recursive: true }))

  test("it reads localModels.peerModel from the settings, and none when nothing sets it", () => {
    const set = join(scratch, "set")
    mkdirSync(join(set, "extensions"), { recursive: true })
    writeFileSync(
      join(set, "extensions", "policy.json"),
      JSON.stringify({ schemaVersion: 1, values: { "localModels.peerModel": "ornith-1.5-122b" } }),
    )
    expect(keptLocalModel(set)).toBe("ornith-1.5-122b")
    expect(keptLocalModel(join(scratch, "none"))).toBe("")
  })
})
