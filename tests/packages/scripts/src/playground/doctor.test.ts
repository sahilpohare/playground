import { afterAll, describe, expect, test } from "bun:test"
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { proxyDown } from "../../../../../api/hono/src/lib/dev/proxy"
import {
  agentBrowserConfig,
  browserCheck,
  certificateCheck,
  dataCheck,
  herdrCheck,
  jobChecks,
  launchdChecks,
  line,
  lingerCheck,
  linkChecks,
  linuxChromium,
  missing,
  proxyCheck,
  registryJobsText,
  toolChecks,
  tunnelChecks,
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
    expect(checks.map((c) => c.name)).toEqual([
      "bun",
      "claude",
      "claude-codex",
      "docker",
      "gh",
      "git",
      "node",
      "python3",
      "uv",
      "whisper-cli",
      "gh login",
    ])
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

  test("docker, uv, whisper-cli, claude-codex and the gh login are optional, since PGlite needs no Docker", () => {
    const checks = toolChecks(
      (cmd) => cmd !== "uv" && cmd !== "docker" && cmd !== "whisper-cli" && cmd !== "claude-codex",
      () => false,
    )
    expect(checks.find((c) => c.name === "docker")!.detail).toContain("PGlite needs none")
    expect(checks.find((c) => c.name === "docker")!.status).toBe("optional")
    expect(checks.find((c) => c.name === "uv")!.status).toBe("optional")
    expect(checks.find((c) => c.name === "claude-codex")!.status).toBe("optional")
    expect(checks.find((c) => c.name === "whisper-cli")!.status).toBe("optional")
    expect(missing(checks)).toBe(false)
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

  test("on Linux no fix names brew, and uv's names uv's own installer; a Mac's keep brew's", () => {
    const fixes = (platform: NodeJS.Platform) =>
      toolChecks(
        () => false,
        () => true,
        () => null,
        platform,
      ).map((c) => `${c.name}: ${c.detail}`)
    expect(fixes("linux").filter((fix) => /brew/.test(fix))).toEqual([])
    expect(fixes("linux")).toContain(
      "uv: missing; fix: curl -LsSf https://astral.sh/uv/install.sh | sh (the skills' tests)",
    )
    expect(fixes("linux").find((fix) => fix.startsWith("whisper-cli: "))).toContain("whisper.cpp")
    expect(fixes("linux").find((fix) => fix.startsWith("node: "))).toContain("20.9 or newer")
    expect(fixes("darwin")).toContain("uv: missing; fix: brew install uv (the skills' tests)")
    expect(fixes("darwin").find((fix) => fix.startsWith("whisper-cli: "))).toContain(
      "brew install whisper-cpp ffmpeg",
    )
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
    expect(jobChecks(jobs, (label) => label === "com.x.ops-awake", "darwin")).toEqual([
      { detail: "com.x.ops-awake loaded", name: "job ops-awake", status: "ok" },
    ])
    const [check] = jobChecks(jobs, () => false, "darwin")
    expect(check!.status).toBe("MISSING")
    expect(check!.detail).toContain("launchctl bootstrap")
    expect(check!.detail).toContain("com.x.ops-awake.plist")
  })

  // #2203: on Linux each launchd job runs as a systemd user unit of the same label
  test("on Linux each job turned on is checked active as its systemd user unit, with systemctl's fix", () => {
    expect(jobChecks(jobs, () => true, "linux")).toEqual([
      { detail: "com.x.ops-awake.service active", name: "job ops-awake", status: "ok" },
    ])
    const [check] = jobChecks(jobs, () => false, "linux")
    expect(check!.status).toBe("MISSING")
    expect(check!.detail).toContain("systemctl --user enable --now com.x.ops-awake.service")
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

// #2203: a fake systemctl first on PATH answers is-active, exit 0 for the one unit it runs, so no real systemctl is called
describe("jobLoaded", () => {
  test("on Linux reads systemctl --user is-active --quiet for the label's unit", () => {
    const bin = mkdtempSync(join(scratch, "systemctl-"))
    const said = join(bin, "said")
    writeFileSync(
      join(bin, "systemctl"),
      `#!/bin/sh\necho "$*" >> "${said}"\n[ "$4" = com.x.ops-tick.service ]\n`,
    )
    chmodSync(join(bin, "systemctl"), 0o755)
    // a child of its own, since bun finds a program on the PATH it started with
    const child = Bun.spawnSync(
      [
        process.execPath,
        "--no-env-file",
        "-e",
        `const { jobLoaded } = await import(${JSON.stringify(DOCTOR)}); console.log(JSON.stringify(["com.x.ops-tick", "com.x.ops-off"].map(jobLoaded("linux"))))`,
      ],
      { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } },
    )
    expect(child.stderr.toString()).toBe("")
    expect(JSON.parse(child.stdout.toString())).toEqual([true, false])
    expect(readFileSync(said, "utf8")).toBe(
      "--user is-active --quiet com.x.ops-tick.service\n--user is-active --quiet com.x.ops-off.service\n",
    )
  })
})

// #2314: the linger row names the command that turns it on for this uid, and stays optional, so doctor still passes while it is off
test("lingerCheck is ok on yes, and otherwise optional, naming loginctl enable-linger for the uid", () => {
  expect(lingerCheck("yes", 1000).status).toBe("ok")
  for (const linger of ["no", null]) {
    const row = lingerCheck(linger, 1000)
    expect(row.status).toBe("optional")
    expect(row.detail).toContain("loginctl enable-linger 1000")
  }
})

// A Linux with no systemd: the probe reads the job as down, so doctor prints its MISSING line rather than crashing.
test("jobLoaded on Linux with no systemctl on PATH reads the job as not running", () => {
  const empty = mkdtempSync(join(scratch, "no-systemctl-"))
  const child = Bun.spawnSync(
    [
      process.execPath,
      "--no-env-file",
      "-e",
      `const { jobLoaded } = await import(${JSON.stringify(DOCTOR)}); console.log(JSON.stringify(jobLoaded("linux")("com.x.ops-tick")))`,
    ],
    { env: { ...process.env, PATH: empty } },
  )
  expect(child.stderr.toString()).toBe("")
  expect(JSON.parse(child.stdout.toString())).toBe(false)
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
    expect(jobChecks(registryJobsText(policy), () => true, "darwin")).toEqual([
      { detail: "com.x.ops-tick loaded", name: "job ops-tick", status: "ok" },
      { detail: "com.x.ops-zai-usage loaded", name: "job ops-zai-usage", status: "ok" },
    ])
    expect(jobChecks(registryJobsText("{}"), () => true)).toEqual([
      { detail: "every ops job is off", name: "jobs", status: "ok" },
    ])
  })

  test("a launchd job its row turns on by enabled alone reads its label from the registry (PG-1196)", () => {
    const rows = [{ key: "jobs.opsTick", scope: "made-up-me", value: { enabled: true } }]
    expect(
      jobChecks(registryJobsText(policyJson(rows, "made-up-me")), () => true, "darwin"),
    ).toEqual([{ detail: "com.playground.ops-tick loaded", name: "job ops-tick", status: "ok" }])
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
      "claude-codex",
      "uv",
      "whisper-cli",
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

describe("browserCheck", () => {
  const home = join(scratch, "browser-home")
  const chrome = linuxChromium(home)
  const config = agentBrowserConfig(home)
  const why = `agent-browser 0.43.0 on Playwright 1.65.1's Chromium, from ${config}`
  const installChromium = "npx -y playwright@1.65.1 install chromium"
  const writeConfig = `write ${config} as {"executablePath": "${chrome}", "args": "--no-sandbox"}`
  const runs = (argv: string[]) => Bun.spawnSync(argv, { stdout: "ignore" }).exitCode === 0

  test("a scratch cache with nothing in it is MISSING, naming every step", () => {
    const empty = join(scratch, "empty-home")
    const its = agentBrowserConfig(empty)
    expect(browserCheck(empty, () => false, runs)).toEqual({
      detail: `fix: bun add -g agent-browser@0.43.0, then ${installChromium}, then write ${its} as {"executablePath": "${linuxChromium(empty)}", "args": "--no-sandbox"} (agent-browser 0.43.0 on Playwright 1.65.1's Chromium, from ${its})`,
      name: "test browser",
      status: "MISSING",
    })
  })

  test("a Chromium whose install did not finish, or that does not run, is MISSING with its install", () => {
    mkdirSync(join(chrome, ".."), { recursive: true })
    writeFileSync(chrome, "#!/bin/sh\necho 'Google Chrome for Testing 159.0.8154.6'\n")
    chmodSync(chrome, 0o755)
    mkdirSync(join(config, ".."), { recursive: true })
    writeFileSync(config, JSON.stringify({ args: "--no-sandbox", executablePath: chrome }))
    expect(browserCheck(home, () => true, runs).detail).toBe(`fix: ${installChromium} (${why})`)
    writeFileSync(join(chrome, "..", "..", "INSTALLATION_COMPLETE"), "")
    writeFileSync(chrome, "#!/bin/sh\nexit 1\n")
    expect(browserCheck(home, () => true, runs).detail).toBe(`fix: ${installChromium} (${why})`)
  })

  test("a config that keeps the sandbox, or names another browser, is MISSING with the config to write", () => {
    writeFileSync(chrome, "#!/bin/sh\necho 'Google Chrome for Testing 159.0.8154.6'\n")
    writeFileSync(config, JSON.stringify({ executablePath: chrome }))
    expect(browserCheck(home, () => true, runs).detail).toBe(`fix: ${writeConfig} (${why})`)
    writeFileSync(config, JSON.stringify({ args: "--no-sandbox", executablePath: "/usr/bin/x" }))
    expect(browserCheck(home, () => true, runs).detail).toBe(`fix: ${writeConfig} (${why})`)
  })

  test("the pinned Chromium, run from agent-browser's config without the sandbox, reads ok", () => {
    writeFileSync(
      config,
      JSON.stringify({ args: "--mute-audio,--no-sandbox", executablePath: chrome }),
    )
    expect(browserCheck(home, () => true, runs)).toEqual({
      detail: why,
      name: "test browser",
      status: "ok",
    })
  })
})

describe("certificateCheck", () => {
  const CA = "/home/x/.portless/fallback/ca.pem"
  const PROFILE = "/home/x/snap/firefox/common/.mozilla/firefox/abc.default"
  const read = (over: Partial<Parameters<typeof certificateCheck>[0]>) => ({
    certutil: true,
    chromium: [],
    firefox: [PROFILE],
    policy: [],
    untrusted: [],
    ...over,
  })

  test("a Firefox profile that does not trust the CA is MISSING, naming the script, the button and the restart", () => {
    const check = certificateCheck(read({ untrusted: [PROFILE] }), CA, "/repo")
    expect(check.status).toBe("MISSING")
    expect(check.detail).toContain("run bun /repo/packages/scripts/src/playground/ca-trust.ts")
    expect(check.detail).toContain("Trust it in Firefox")
    expect(check.detail).toContain("restart Firefox")
    expect(check.detail).toContain(PROFILE)
    expect(check.detail).not.toContain("libnss3-tools")
  })

  test("with no certutil the step installs the distro's NSS tools first, and a Chromium browser's import follows", () => {
    const check = certificateCheck(
      read({ certutil: false, chromium: ["helium"], untrusted: [PROFILE] }),
      CA,
      "/repo",
    )
    expect(check.status).toBe("MISSING")
    expect(check.detail).toContain("libnss3-tools")
    expect(check.detail).toContain("In helium, open chrome://certificate-manager")
  })

  test("optional with a Chromium-family browser's own import once Firefox trusts it, else ok", () => {
    const chromium = certificateCheck(read({ chromium: ["google-chrome"] }), CA, "/repo")
    expect(chromium.status).toBe("optional")
    expect(chromium.detail).toContain(`Import ${CA}`)
    expect(certificateCheck(read({}), CA, "/repo")).toEqual({
      detail: `Firefox trusts ${CA}`,
      name: "browser certificate",
      status: "ok",
    })
    expect(certificateCheck(read({ firefox: [] }), CA, "/repo").detail).toBe("no browser found")
  })

  test("ok naming the browsers the chromium-ca policy covers (PG-2458)", () => {
    expect(certificateCheck(read({ firefox: [], policy: ["helium"] }), CA, "/repo")).toEqual({
      detail: `helium trusts ${CA} through the browser policy`,
      name: "browser certificate",
      status: "ok",
    })
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

describe("tunnelChecks (PG-2207)", () => {
  const NOW = new Date("2026-11-15T00:00:00Z")
  const on = JSON.stringify({ jobs: [{ config: { host: "spark-a" }, name: "ops-tunnel" }] })
  const beat = (lastResult: string, at = "2026-11-14T23:59:30.000Z") =>
    JSON.stringify({ cycleSeconds: 60, job: "ops-tunnel", lastBeatAt: at, lastResult, pid: 1 })

  test("a tunnel job turned off, or no jobs.json, adds no line", () => {
    const off = JSON.stringify({ jobs: [{ disabled: true, name: "ops-tunnel" }] })
    for (const jobs of [null, "{", off]) expect(tunnelChecks(jobs, null, NOW)).toEqual([])
  })

  test("a tunnel that is up reads ok with its link", () => {
    const up = "up: https://dashboard.playground.localhost:1355/dashboard through spark-a"
    expect(tunnelChecks(on, beat(up), NOW)).toEqual([{ detail: up, name: "tunnel", status: "ok" }])
  })

  test("a tunnel that cannot connect is MISSING and names why", () => {
    const [check] = tunnelChecks(
      on,
      beat("down: the Spark refused the key /h/.ssh/playground_spark"),
      NOW,
    )
    expect(check!.status).toBe("MISSING")
    expect(check!.detail).toContain("refused the key /h/.ssh/playground_spark")
  })

  test("a job turned on with no heartbeat, or one gone stale, is MISSING and says so", () => {
    expect(tunnelChecks(on, null, NOW)[0]!.detail).toContain("has not started")
    const stale = tunnelChecks(on, beat("up: x", "2026-11-14T23:40:00.000Z"), NOW)[0]!
    expect(stale.status).toBe("MISSING")
    expect(stale.detail).toContain("20m old")
  })
})
