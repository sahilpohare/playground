import { describe, expect, test } from "bun:test"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

import { hidden, ROOT_TOOLS } from "../packages/scripts/src/sandbox"
import { scratchEnv } from "./scratch-env"

// The suite runs through packages/scripts/src/test-sandbox.ts, which puts a fake claude first on PATH and a scratch HOME and CLAUDE_CONFIG_DIR under TEST_SANDBOX_HOME before bun starts, so no test can start a real session or read the real config by accident. A bare bun test stops at tests/require-sandbox.ts before these load; they check the sandbox itself is built right.
describe("the test sandbox", () => {
  test("a claude on PATH is the fake, which refuses loudly", async () => {
    const proc = Bun.spawn(["claude", "--version"], { stderr: "pipe", stdout: "pipe" })
    const [err, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited])
    expect(code).toBe(99)
    expect(err).toContain("the test sandbox stopped a real claude call")
  })

  test("HOME and CLAUDE_CONFIG_DIR sit in the sandbox, not the real home", () => {
    const { CLAUDE_CONFIG_DIR, HOME, PATH, TEST_SANDBOX_HOME } = process.env
    if (typeof TEST_SANDBOX_HOME !== "string")
      throw new Error("run the suite through bun run test: the sandbox wraps it")
    if (
      typeof HOME !== "string" ||
      typeof CLAUDE_CONFIG_DIR !== "string" ||
      typeof PATH !== "string"
    )
      throw new Error("the sandbox sets HOME, CLAUDE_CONFIG_DIR and PATH")
    expect(homedir()).toBe(HOME)
    expect(HOME.startsWith(TEST_SANDBOX_HOME)).toBe(true)
    expect(CLAUDE_CONFIG_DIR.startsWith(TEST_SANDBOX_HOME)).toBe(true)
    expect(PATH.split(":")[0].endsWith("bin")).toBe(true)
  })
})

// On Linux the suite runs under bwrap (sandbox.ts's wrap), since a scratch HOME hides nothing a test names by its full path
describe.skipIf(process.platform !== "linux")("the test sandbox on Linux", () => {
  // the passwd entry's home, since os.userInfo().homedir follows the sandbox's HOME; read in each test, since a skipped describe's body still runs on macOS, which has no getent
  const uid = process.getuid!()
  const homeOfUid = () =>
    Bun.spawnSync(["getent", "passwd", String(uid)])
      .stdout.toString()
      .split(":")[5]!

  test("each live folder reads empty: the data folder, Claude's config, herdr's, portless's and the user's runtime folder", () => {
    for (const dir of hidden(homeOfUid(), uid, {}))
      if (existsSync(dir)) expect([dir, readdirSync(dir)]).toEqual([dir, []])
  })

  test("~/.ssh is mounted read-only", () => {
    const ssh = join(homeOfUid(), ".ssh")
    if (!existsSync(ssh)) return
    const mount = readFileSync("/proc/self/mountinfo", "utf8")
      .split("\n")
      .map((line) => line.split(" "))
      .findLast((fields) => fields[4] === ssh)
    expect(mount?.[5]?.split(",")).toContain("ro")
  })

  // fix.ts's web address setup finds pkexec on PATH and portless's stop calls sudo, where a fake first on PATH misses a full path
  test("pkexec and sudo by their full path are the sandbox's stand-in, which refuses", () => {
    for (const tool of ROOT_TOOLS.filter((path) => existsSync(path))) {
      // read before it runs, so a sandbox without the stand-in fails here and never calls the real tool
      expect([tool, readFileSync(tool, "utf8").startsWith("#!/bin/sh\n")]).toEqual([tool, true])
      const run = Bun.spawnSync([tool, "--version"], { stderr: "pipe", stdout: "ignore" })
      expect(run.exitCode).toBe(99)
      expect(run.stderr.toString()).toContain("the test sandbox stopped a real root call")
    }
  })

  // portless's stop finds the live proxy's pid by its port and signals it, so the suite runs in a pid view of its own
  test("a test cannot signal a process outside the suite", () => {
    const outer = Number(process.env.TEST_SANDBOX_OUTER_PID)
    expect(outer).toBeGreaterThan(0)
    let code: string | undefined
    try {
      process.kill(outer, 0)
    } catch (error) {
      code = (error as { code?: string }).code
    }
    expect(code).toBe("ESRCH")
  })

  // a test's own child (test-skills.test.ts's step) builds a sandbox again, which needs the box's proof, since the runner refuses a box inside one
  test("a child a test spawns at a scratch home still reads as inside the box", () => {
    const run = Bun.spawnSync(
      [
        "bun",
        "-e",
        `import { insideBox } from "${join(import.meta.dir, "..", "packages", "scripts", "src", "sandbox")}"; console.log(insideBox())`,
      ],
      { env: scratchEnv(join(process.env.TEST_SANDBOX_HOME!, "home")), stderr: "pipe" },
    )
    expect([run.stdout.toString().trim(), run.stderr.toString()]).toEqual(["true", ""])
  })

  // the dev launcher records its process group, which read as 0 while its leader was bwrap, outside the pid view
  test("a test's process group is one the pid view holds", () => {
    const ps = Bun.spawnSync(["ps", "-o", "pgid=", "-p", String(process.pid)])
    expect(Number(ps.stdout.toString().trim())).toBeGreaterThan(0)
  })
})
