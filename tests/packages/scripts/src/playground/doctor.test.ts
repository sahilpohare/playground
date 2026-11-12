import { afterAll, describe, expect, test } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { proxyDown } from "../../../../../api/hono/src/lib/dev/proxy"
import {
  dataCheck,
  herdrCheck,
  jobChecks,
  launchdChecks,
  line,
  linkChecks,
  missing,
  proxyCheck,
  registryJobsText,
  toolChecks,
  versionCheck,
} from "../../../../../packages/scripts/src/playground/doctor"
import { writeRoot } from "../../../../../packages/settings/src/folder"
// registers the jobs.<name> settings policyJson resolves, as the store's writer has them
import "../../../../../packages/settings/src/jobs"
import { extensionsDir } from "../../../../../packages/settings/src/rendered"
import { policyJson } from "../../../../../packages/settings/src/settings-folder"

const DOCTOR = join(import.meta.dir, "../../../../../packages/scripts/src/playground/doctor.ts")
const scratch = mkdtempSync(join(tmpdir(), "playground-doctor-"))
afterAll(() => rmSync(scratch, { force: true, recursive: true }))

const REQUIRED = ["bun", "claude", "docker", "gh", "git", "node", "python3"]

describe("toolChecks", () => {
  test("every required tool present and gh logged in reads ok, and nothing is missing", () => {
    const checks = toolChecks(
      () => true,
      () => true,
    )
    expect(checks.filter((c) => c.status !== "ok")).toEqual([])
    expect(checks.map((c) => c.name)).toEqual([...REQUIRED, "uv", "gh login"])
    expect(missing(checks)).toBe(false)
  })

  test("a missing required tool is MISSING with its fix", () => {
    const checks = toolChecks(
      (cmd) => cmd !== "git",
      () => true,
    )
    const git = checks.find((c) => c.name === "git")!
    expect(git.status).toBe("MISSING")
    expect(git.detail).toStartWith("fix: ")
    expect(missing(checks)).toBe(true)
  })

  test("docker, uv and the gh login are optional, since PGlite needs no Docker", () => {
    const checks = toolChecks(
      (cmd) => cmd !== "uv" && cmd !== "docker",
      () => false,
    )
    expect(checks.find((c) => c.name === "docker")!.detail).toContain("PGlite needs none")
    expect(checks.find((c) => c.name === "docker")!.status).toBe("optional")
    expect(checks.find((c) => c.name === "uv")!.status).toBe("optional")
    expect(checks.find((c) => c.name === "gh login")).toEqual({
      detail: "sync is off; fix: gh auth login, then playground ext init",
      name: "gh login",
      status: "optional",
    })
    expect(missing(checks)).toBe(false)
  })

  test("a node older than the Dashboard's minimum is MISSING with its fix, and one at it reads ok", () => {
    const at = (version: string) =>
      toolChecks(
        () => true,
        () => true,
        () => version,
      ).find((c) => c.name === "node")!
    expect(at("v20.8.1").status).toBe("MISSING")
    expect(at("v20.8.1").detail).toContain("20.9")
    expect(at("v18.20.0").status).toBe("MISSING")
    expect(at("v20.9.0").status).toBe("ok")
    expect(at("v24.21.0").status).toBe("ok")
  })

  test("with no gh the login is not asked", () => {
    let asked = false
    toolChecks(
      (cmd) => cmd !== "gh",
      () => (asked = true),
    )
    expect(asked).toBe(false)
  })
})

describe("linkChecks", () => {
  test("no link into the checkout is MISSING, fixed by link-skills", () => {
    const [check] = linkChecks([], "/repo", () => true)
    expect(check!.status).toBe("MISSING")
    expect(check!.detail).toContain("link-skills.sh")
  })

  test("links whose targets exist read as one ok line", () => {
    const links = [
      { path: "/h/.claude/skills/a", target: "/repo/skills/a" },
      { path: "/h/.bun/bin/playground", target: "/repo/cli.ts" },
    ]
    expect(linkChecks(links, "/repo", () => true)).toEqual([
      { detail: "2 into /repo", name: "links", status: "ok" },
    ])
  })

  test("a link whose target is gone is MISSING by its path", () => {
    const links = [
      { path: "/h/.claude/skills/a", target: "/repo/skills/a" },
      { path: "/h/.claude/skills/gone", target: "/repo/skills/gone" },
    ]
    const checks = linkChecks(links, "/repo", (path) => !path.endsWith("gone"))
    expect(checks).toEqual([
      {
        detail:
          "fix: /repo/skills/gone is gone; run scripts/link-skills.sh, which removes the link",
        name: "link /h/.claude/skills/gone",
        status: "MISSING",
      },
    ])
  })
})

describe("dataCheck", () => {
  test("names the data folder it reads, so a fresh install shows which one is in use", () => {
    expect(dataCheck("/h/.playground", () => true)).toEqual({
      detail: "/h/.playground",
      name: "data folder",
      status: "ok",
    })
  })

  test("a data folder that is not there is MISSING, fixed by link-skills", () => {
    const check = dataCheck("/h/.playground", () => false)
    expect(check.status).toBe("MISSING")
    expect(check.detail).toContain("/h/.playground")
    expect(check.detail).toContain("link-skills.sh")
  })
})

// doctor reads portless's proxy by the stack's own rule, so a plist left by a service that never started reads optional, since the stack starts on 1355 meanwhile, and a proxy already up on its port reads ok with no plist.
describe("proxyCheck", () => {
  const portless = (name: string, port?: string) => {
    const dir = join(scratch, name)
    mkdirSync(dir, { recursive: true })
    if (port) writeFileSync(join(dir, "proxy.port"), `${port}\n`)
    return dir
  }
  const silent = async () => false
  const answers = async () => true

  test("a proxy answering on 443 is ok", async () => {
    const check = proxyCheck("/h/playground", await proxyDown({}, portless("up", "443"), answers))
    expect(check).toMatchObject({ name: "portless proxy", status: "ok" })
  })

  test("a proxy kept on a port of 1024 or above is ok, since it needs no sudo", async () => {
    const check = proxyCheck("/h/playground", await proxyDown({}, portless("high", "8443"), silent))
    expect(check.status).toBe("ok")
  })

  test("nothing answering on 443, as after a service install whose start failed, is optional, since the Dashboard runs on 1355 meanwhile; Settings' button or install.sh fixes it", async () => {
    const check = proxyCheck("/h/playground", await proxyDown({}, portless("down"), silent))
    expect(check.status).toBe("optional")
    expect(check.detail).toContain("runs on port 1355 meanwhile")
    expect(check.detail).toContain("Set up the web address")
    expect(check.detail).toContain("bash /h/playground/install.sh")
  })
})

describe("jobChecks", () => {
  const jobs = JSON.stringify({
    jobs: [
      { heartbeat: "ops-awake", launchd: "com.x.ops-awake", name: "ops-awake" },
      { disabled: true, launchd: "com.x.ops-off", name: "ops-off" },
      { heartbeat: "ops-tickless", name: "ops-tickless" },
    ],
  })

  test("each launchd job turned on is checked loaded, and one not loaded is MISSING", () => {
    expect(jobChecks(jobs, (label) => label === "com.x.ops-awake")).toEqual([
      { detail: "com.x.ops-awake loaded", name: "job ops-awake", status: "ok" },
    ])
    const [check] = jobChecks(jobs, () => false)
    expect(check!.status).toBe("MISSING")
    expect(check!.detail).toContain("launchctl bootstrap")
    expect(check!.detail).toContain("com.x.ops-awake.plist")
  })

  test("a turned-off job and one with no launchd label are left alone", () => {
    const labels: string[] = []
    jobChecks(jobs, (label) => (labels.push(label), true))
    expect(labels).toEqual(["com.x.ops-awake"])
  })

  test("no jobs.json, or one that does not read, has every job off", () => {
    for (const text of [null, "{", JSON.stringify({ jobs: [] })])
      expect(jobChecks(text, () => true)).toEqual([
        { detail: "every ops job is off", name: "jobs", status: "ok" },
      ])
  })
})

describe("the jobs check on a machine with a store", () => {
  const policy = JSON.stringify({
    values: {
      "jobs.opsFlow": { enabled: false, launchd: "com.x.ops-flow" },
      "jobs.opsTick": { enabled: true, launchd: "com.x.ops-tick" },
      "jobs.opsZaiUsage": { enabled: true, launchd: "com.x.ops-zai-usage" },
      "ui.theme": "dark",
    },
  })

  test("reads the registry's values: each launchd job turned on, by its job name", () => {
    expect(jobChecks(registryJobsText(policy), () => true)).toEqual([
      { detail: "com.x.ops-tick loaded", name: "job ops-tick", status: "ok" },
      { detail: "com.x.ops-zai-usage loaded", name: "job ops-zai-usage", status: "ok" },
    ])
    expect(jobChecks(registryJobsText("{}"), () => true)).toEqual([
      { detail: "every ops job is off", name: "jobs", status: "ok" },
    ])
  })

  test("a launchd job its row turns on by enabled alone reads its label from the registry (PG-1196)", () => {
    const rows = [{ key: "jobs.opsTick", scope: "made-up-me", value: { enabled: true } }]
    expect(jobChecks(registryJobsText(policyJson(rows, "made-up-me")), () => true)).toEqual([
      { detail: "com.playground.ops-tick loaded", name: "job ops-tick", status: "ok" },
    ])
  })

  test("takes the store's policy.json over jobs.json, and a store that lacks it reads jobs.json", async () => {
    const data = join(scratch, "store-data")
    mkdirSync(join(data, "ops"), { recursive: true })
    writeFileSync(
      join(data, "ops", "jobs.json"),
      JSON.stringify({ jobs: [{ launchd: "com.x.ops-old", name: "ops-old" }] }),
    )
    expect((await launchdChecks(data, () => true)).map((c) => c.name)).toEqual(["job ops-old"])
    writeRoot(extensionsDir(data), new Map([["policy.json", policy]]))
    expect((await launchdChecks(data, () => true)).map((c) => c.name)).toEqual([
      "job ops-tick",
      "job ops-zai-usage",
    ])
    writeRoot(extensionsDir(data), new Map([["policy.json", null]]))
    expect((await launchdChecks(data, () => true)).map((c) => c.name)).toEqual(["job ops-old"])
  })
})

test("line lays a check out as check.sh does", () => {
  expect(line({ detail: "every skill", name: "git", status: "ok" })).toBe(
    `ok       git                    every skill`,
  )
})

describe("doctor.ts --tools", () => {
  // a PATH of stubs holding only the tools given, and bun itself
  const run = (tools: string[], ...more: string[]) => {
    const bin = mkdtempSync(join(scratch, "bin-"))
    symlinkSync(process.execPath, join(bin, "bun"))
    for (const tool of tools) {
      writeFileSync(join(bin, tool), "#!/bin/sh\nexit 1\n")
      chmodSync(join(bin, tool), 0o755)
    }
    const home = join(bin, "home")
    mkdirSync(home)
    const proc = Bun.spawnSync([process.execPath, "--no-env-file", DOCTOR, "--tools", ...more], {
      env: { HOME: home, PATH: bin },
    })
    return { code: proc.exitCode, out: proc.stdout.toString() }
  }

  test("--json prints the same checks as one JSON list, so install.sh reads the doctor's own list", () => {
    const { code, out } = run(
      REQUIRED.filter((t) => t !== "bun" && t !== "claude"),
      "--json",
    )
    expect(code).toBe(1)
    const checks = JSON.parse(out) as { name: string; status: string }[]
    expect(checks.filter((c) => c.status !== "ok").map((c) => c.name)).toEqual([
      "claude",
      "uv",
      "gh login",
    ])
  })

  test("a word it does not take exits 2", () => {
    expect(run([], "--yaml").code).toBe(2)
  })

  test("every required tool on PATH exits 0, the gh login optional", () => {
    const { code, out } = run(REQUIRED.filter((t) => t !== "bun"))
    expect(code).toBe(0)
    expect(out).not.toContain("MISSING")
    expect(out).toMatch(/^optional +gh login/m)
  })

  test("a required tool missing exits 1 and names it", () => {
    const { code, out } = run(REQUIRED.filter((t) => t !== "bun" && t !== "claude"))
    expect(code).toBe(1)
    expect(out).toMatch(/^MISSING +claude +fix: /m)
  })
})

describe("herdrCheck", () => {
  const SUM = new Bun.CryptoHasher("sha256").update("a fake herdr").digest("hex")
  const path = join(scratch, "herdr-data", "bin", "herdr")

  test("a missing copy is MISSING, with playground herdr pin as its fix", () => {
    expect(herdrCheck(path, SUM, "0.9.5", null)).toEqual({
      detail: `fix: playground herdr pin (${path} is missing)`,
      name: "herdr",
      status: "MISSING",
    })
  })

  test("a changed copy is MISSING, with playground herdr pin as its fix", () => {
    mkdirSync(join(path, ".."), { recursive: true })
    writeFileSync(path, "a herdr someone updated")
    expect(herdrCheck(path, SUM, "0.9.5", null)).toEqual({
      detail: `fix: playground herdr pin (${path} is not the pinned 0.9.5)`,
      name: "herdr",
      status: "MISSING",
    })
  })

  test("the pinned copy reads ok, and a herdr of your own on PATH is named and left alone", () => {
    mkdirSync(join(path, ".."), { recursive: true })
    writeFileSync(path, "a fake herdr")
    expect(herdrCheck(path, SUM, "0.9.5", null)).toEqual({
      detail: `0.9.5 pinned at ${path}`,
      name: "herdr",
      status: "ok",
    })
    expect(herdrCheck(path, SUM, "0.9.5", "/opt/homebrew/bin/herdr").detail).toBe(
      `0.9.5 pinned at ${path}; your own herdr at /opt/homebrew/bin/herdr is left alone`,
    )
    expect(herdrCheck(path, SUM, "0.9.5", path).detail).toBe(`0.9.5 pinned at ${path}`)
  })
})

describe("versionCheck", () => {
  test("at main's head it names the release; behind it after update --to it reads held at its tag", () => {
    expect(versionCheck("v0.0.1", "v0.0.1", 0).detail).toBe("at v0.0.1")
    expect(versionCheck("v0.0.20", "v0.0.20", 12)).toEqual({
      detail: "held at v0.0.20, 12 commits behind origin/main: playground update moves it on",
      name: "version",
      status: "ok",
    })
    expect(versionCheck("v0.0.1-1-gabc1234", null, 1).detail).toBe(
      "at v0.0.1-1-gabc1234, 1 commit behind origin/main: playground update moves it on",
    )
  })
})
