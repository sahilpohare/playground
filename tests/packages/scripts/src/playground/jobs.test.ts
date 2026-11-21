import { afterAll, expect, test } from "bun:test"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { jobsExit, renderJobsFile } from "../../../../../packages/scripts/src/playground/jobs"
import { extGit, writeFiles, writeRoot } from "../../../../../packages/settings/src/folder"
import { extensionsDir, scopeDir } from "../../../../../packages/settings/src/rendered"
import { liveBusLines } from "../../../../systemd-stand-ins"

const CHECKOUT = resolve(import.meta.dir, "../../../../..")
const scratch = mkdtempSync(join(tmpdir(), "jobs-render-"))
// a runtime folder of the scratch's own for each command-line render on Linux, so no systemd call finds the live bus, whatever the shell running the suite has set
const runtime = join(scratch, "run")
const SYSTEMD_ENV = {
  DBUS_SESSION_BUS_ADDRESS: `unix:path=${runtime}/bus`,
  XDG_RUNTIME_DIR: runtime,
}
afterAll(() => rmSync(scratch, { force: true, recursive: true }))

const fill = {
  bun: "/b/bun",
  checkout: "/c",
  dashboard: "/c/desk",
  data: "/d",
  path: "/usr/bin:/bin",
}
const tick = {
  callsModel: false,
  cwd: "{checkout}",
  description: "A made-up beat.",
  enabled: true,
  heartbeat: "ops-tick",
  launchd: "com.playground.ops-tick",
  program: ["{bun}", "{checkout}/packages/scripts/src/ops-tick/cli.ts"],
  schedule: { every: 60 },
}

// A data folder whose extensions root holds policy.json with the values given and the login tester, and any scope files given as <scope>/<path>.
const storeWith = (
  name: string,
  values: Record<string, unknown>,
  extra: [string, string][] = [],
) => {
  const data = join(scratch, name)
  writeRoot(
    extensionsDir(data),
    new Map([
      ["login", "tester\n"],
      ["policy.json", JSON.stringify({ orgs: {}, schemaVersion: 1, values })],
    ]),
  )
  for (const [path, text] of extra) {
    const [scope, ...rest] = path.split("/")
    writeFiles(data, scope!, new Map([[rest.join("/"), text]]), { author: "test", reason: "seed" })
  }
  return data
}

// A HOME of the test's own; each run's trash is in its data folder, whose ops/launch-agents takes the jobs carve-out as up.py's render writes it.
const home = join(scratch, "home")

const run = async (data: string, jobs: string, launchAgents?: string) => {
  const out: string[] = []
  const err: string[] = []
  const code = await renderJobsFile(
    { data, fill, jobs, launchAgents, roots: { home, main: CHECKOUT, trash: join(data, "trash") } },
    (l) => out.push(l),
    (l) => err.push(l),
  )
  return { code, err: err.join("\n"), out: out.join("\n") }
}

test("a machine with no store keeps its jobs.json untouched and exits 3", async () => {
  const jobs = join(scratch, "bare-jobs.json")
  writeFileSync(jobs, '{"jobs":[{"name":"ops-company"}]}\n')
  expect(await run(join(scratch, "no-store"), jobs)).toEqual({ code: 3, err: "", out: "" })
  expect(readFileSync(jobs, "utf8")).toBe('{"jobs":[{"name":"ops-company"}]}\n')
})

// The jobs on with no setting, on the platform this render runs on: the Dashboard's and the usage read, and keep-awake on a Mac alone.
const ON = [
  "ops-dashboard",
  ...(process.platform === "darwin" ? ["ops-keep-awake"] : []),
  "ops-usage",
]

test("a fresh machine, with no store and no jobs.json, gets the registry's defaults: the Dashboard's job and the usage read on, and keep-awake on a Mac", async () => {
  const jobs = join(scratch, "fresh", "ops", "jobs.json")
  const fresh = await run(join(scratch, "fresh"), jobs)
  expect(fresh).toEqual({ code: 0, err: "", out: "jobs: rendered jobs.json" })
  const rendered = JSON.parse(readFileSync(jobs, "utf8")).jobs as Record<string, unknown>[]
  expect(rendered.filter((job) => job.disabled !== true).map((job) => job.name)).toEqual(ON)
  expect((await run(join(scratch, "fresh"), jobs)).code).toBe(3)
})

test("a store renders jobs.json in the runner's shape, keeps a job it does not know, and writes the plist of each enabled launchd job", async () => {
  const data = storeWith("on", { "jobs.opsTick": tick })
  const jobs = join(scratch, "on-jobs.json")
  const agents = join(data, "ops", "launch-agents")
  mkdirSync(agents, { recursive: true })
  writeFileSync(join(agents, "com.playground.ops-flow.plist"), "stale")
  writeFileSync(join(agents, "com.other.keep.plist"), "theirs")
  writeFileSync(jobs, JSON.stringify({ jobs: [{ command: "~/x.sh", name: "ops-company" }] }))
  const first = await run(data, jobs, agents)
  expect(first.code).toBe(0)
  expect(first.out).toBe(
    "jobs: rendered jobs.json, com.playground.ops-tick, -com.playground.ops-flow.plist",
  )
  const rendered = JSON.parse(readFileSync(jobs, "utf8")).jobs as Record<string, unknown>[]
  expect(rendered.find((job) => job.name === "ops-company")).toEqual({
    command: "~/x.sh",
    name: "ops-company",
  })
  expect(rendered.find((job) => job.name === "ops-tick")!.disabled).toBeUndefined()
  expect(rendered.find((job) => job.name === "ops-sweep")!.disabled).toBe(true)
  expect(readFileSync(join(agents, "com.playground.ops-tick.plist"), "utf8")).toContain(
    "<string>/c/packages/scripts/src/ops-tick/cli.ts</string>",
  )
  expect(existsSync(join(agents, "com.playground.ops-flow.plist"))).toBe(false)
  const [batch] = readdirSync(join(data, "trash"))
  expect(batch).toMatch(/-jobs$/)
  expect(
    readFileSync(join(data, "trash", batch!, "1", "com.playground.ops-flow.plist"), "utf8"),
  ).toBe("stale")
  expect(readFileSync(join(agents, "com.other.keep.plist"), "utf8")).toBe("theirs")
  expect((await run(data, jobs, agents)).out).toBe("jobs: unchanged")
})

test("a dropped job's plist the trash refuses stays, is named, and the render exits 1", async () => {
  const data = storeWith("refused", { "jobs.opsTick": tick })
  const jobs = join(scratch, "refused-jobs.json")
  const agents = join(data, "ops", "launch-agents")
  const odd = join(agents, "com.playground.ops-odd.plist")
  mkdirSync(odd, { recursive: true })
  writeFileSync(join(odd, "a"), "x")
  writeFileSync(join(odd, "b"), "x")
  const done = await run(data, jobs, agents)
  expect(done.code).toBe(1)
  expect(done.err).toContain("jobs: kept com.playground.ops-odd.plist:")
  expect(done.err).toContain("past the jobs carve-out's cap")
  expect(existsSync(join(odd, "a"))).toBe(true)
})

// A render with install, in a HOME of the test's own whose LaunchAgents folder is the one launchd would load, every launchctl call recorded: print answers whether a label is loaded, bootstrap loads one and bootout unloads it (each refusing while refusals given remain), or ends the render as launchd ends a job that boots itself out (killed).
const installRun = async (
  name: string,
  values: Record<string, unknown>,
  launchd: { killed?: boolean; loaded?: string[]; refusals?: number } = {},
) => {
  const data = storeWith(name, values)
  const home = join(scratch, name, "home")
  const agents = join(home, "Library", "LaunchAgents")
  mkdirSync(agents, { recursive: true })
  const calls: string[][] = []
  const loaded = new Set(launchd.loaded ?? [])
  let refusals = launchd.refusals ?? 0
  const labelOf = (arg: string) =>
    arg
      .split("/")
      .at(-1)!
      .replace(/\.plist$/, "")
  const install = {
    agents,
    launchctl: async (args: string[]) => {
      calls.push(args)
      const label = labelOf(args.at(-1)!)
      if (args[0] === "print") return { code: loaded.has(label) ? 0 : 113, out: "" }
      if (refusals > 0) {
        refusals--
        return { code: 5, out: "nope" }
      }
      if (args[0] === "bootstrap") loaded.add(label)
      if (args[0] === "bootout" && launchd.killed) throw new Error("killed by its own bootout")
      if (args[0] === "bootout") loaded.delete(label)
      return { code: 0, out: "" }
    },
    uid: 501,
  }
  const options = {
    data,
    fill,
    install,
    jobs: join(data, "ops", "jobs.json"),
    roots: { home, main: CHECKOUT, trash: join(data, "trash") },
  }
  const render = async () => {
    const out: string[] = []
    const err: string[] = []
    const exit = await renderJobsFile(
      options,
      (l) => out.push(l),
      (l) => err.push(l),
    )
    return { code: exit, err: err.join("\n"), out: out.join("\n") }
  }
  const changes = () => calls.filter((args) => args[0] !== "print")
  return { agents, calls, changes, data, render }
}

test("a launchd job turned on is installed into LaunchAgents and bootstrapped once, and one already installed and loaded stays as it stands", async () => {
  const { agents, changes, render } = await installRun(
    "install-on",
    {
      "jobs.opsHerdr": {
        ...tick,
        heartbeat: "ops-herdr",
        launchd: "com.playground.ops-herdr",
        program: ["{bun}", "{checkout}/packages/scripts/src/ops-herdr/cli.ts"],
      },
      "jobs.opsTick": tick,
    },
    { loaded: ["com.playground.ops-herdr"] },
  )
  const herdr = join(agents, "com.playground.ops-herdr.plist")
  writeFileSync(herdr, "installed by hand")
  const first = await render()
  expect(first).toMatchObject({ code: 0, err: "" })
  expect(first.out).toContain("+com.playground.ops-tick")
  const tickPlist = join(agents, "com.playground.ops-tick.plist")
  expect(readFileSync(tickPlist, "utf8")).toContain(
    "<string>/c/packages/scripts/src/ops-tick/cli.ts</string>",
  )
  expect(changes()).toEqual([["bootstrap", "gui/501", tickPlist]])
  expect(readFileSync(herdr, "utf8")).toBe("installed by hand")
  expect((await render()).out).toBe("jobs: unchanged")
  expect(changes()).toHaveLength(1)
})

test("a launchd job turned off is booted out and its installed plist moved to the trash, another app's agent left alone", async () => {
  const { agents, changes, data, render } = await installRun(
    "install-off",
    { "jobs.opsTick": { ...tick, enabled: false } },
    { loaded: ["com.playground.ops-tick"] },
  )
  const tickPlist = join(agents, "com.playground.ops-tick.plist")
  writeFileSync(tickPlist, "installed")
  writeFileSync(join(agents, "com.other.agent.plist"), "theirs")
  const done = await render()
  expect(done).toMatchObject({ code: 0, err: "" })
  expect(done.out).toContain("-com.playground.ops-tick")
  expect(changes()).toEqual([["bootout", "gui/501/com.playground.ops-tick"]])
  expect(existsSync(tickPlist)).toBe(false)
  const [batch] = readdirSync(join(data, "trash"))
  expect(
    readFileSync(join(data, "trash", batch!, "1", "com.playground.ops-tick.plist"), "utf8"),
  ).toBe("installed")
  expect(readFileSync(join(agents, "com.other.agent.plist"), "utf8")).toBe("theirs")
  expect((await render()).out).toBe("jobs: unchanged")
  expect(changes()).toHaveLength(1)
})

// ops-tick runs the render through up.py, so turning ops-tick off boots out the job the render runs under, which ends the render inside that call.
test("a launchd job whose bootout ends the render has its plist in the trash already", async () => {
  const { agents, changes, data, render } = await installRun(
    "install-self",
    { "jobs.opsTick": { ...tick, enabled: false } },
    { killed: true, loaded: ["com.playground.ops-tick"] },
  )
  const tickPlist = join(agents, "com.playground.ops-tick.plist")
  writeFileSync(tickPlist, "installed")
  await expect(render()).rejects.toThrow("killed by its own bootout")
  expect(changes()).toEqual([["bootout", "gui/501/com.playground.ops-tick"]])
  expect(existsSync(tickPlist)).toBe(false)
  const [batch] = readdirSync(join(data, "trash"))
  expect(
    readFileSync(join(data, "trash", batch!, "1", "com.playground.ops-tick.plist"), "utf8"),
  ).toBe("installed")
})

test("a launchd job turned off that launchd still holds with no plist installed is booted out, and a refused bootout is named and tried again", async () => {
  const { changes, render } = await installRun(
    "install-off-loaded",
    { "jobs.opsTick": { ...tick, enabled: false } },
    { loaded: ["com.playground.ops-tick"], refusals: 1 },
  )
  const first = await render()
  expect(first.code).toBe(1)
  expect(first.err).toBe("jobs: refused bootout of com.playground.ops-tick, exit 5: nope")
  expect(await render()).toMatchObject({ code: 0, err: "" })
  expect(changes()).toEqual([
    ["bootout", "gui/501/com.playground.ops-tick"],
    ["bootout", "gui/501/com.playground.ops-tick"],
  ])
  expect((await render()).out).toBe("jobs: unchanged")
  expect(changes()).toHaveLength(2)
})

test("a bootstrap launchctl refuses is named on stderr, exits 1, and is tried again on the next pass", async () => {
  const { agents, changes, render } = await installRun(
    "install-refused",
    { "jobs.opsTick": tick },
    { refusals: 1 },
  )
  const tickPlist = join(agents, "com.playground.ops-tick.plist")
  const first = await render()
  expect(first.code).toBe(1)
  expect(first.err).toBe("jobs: refused bootstrap of com.playground.ops-tick, exit 5: nope")
  const second = await render()
  expect(second).toMatchObject({ code: 0, err: "", out: "jobs: rendered +com.playground.ops-tick" })
  expect(changes()).toEqual([
    ["bootstrap", "gui/501", tickPlist],
    ["bootstrap", "gui/501", tickPlist],
  ])
})

test("a launchd label that is not Playground's own gets no launchctl call and no write, on or off", async () => {
  const { agents, calls, data, render } = await installRun("install-foreign", {
    "jobs.opsTick": { ...tick, launchd: "com.example.tick" },
  })
  mkdirSync(join(data, "ops"), { recursive: true })
  writeFileSync(
    join(data, "ops", "jobs.json"),
    JSON.stringify({ jobs: [{ disabled: true, launchd: "com.example.sync", name: "my-sync" }] }),
  )
  const theirs = join(agents, "com.example.sync.plist")
  writeFileSync(theirs, "theirs")
  const done = await render()
  expect(done).toMatchObject({ code: 0, err: "" })
  expect(calls.filter((args) => args.at(-1)!.includes("com.example"))).toEqual([])
  expect(readFileSync(theirs, "utf8")).toBe("theirs")
  expect(existsSync(join(agents, "com.example.tick.plist"))).toBe(false)
})

test("each org's script folder is installed under ops beside the state its job keeps, and the login's own scripts are not", async () => {
  const data = storeWith("scripts", {}, [
    ["acme/scripts/watch/config.json", '{"places":[]}'],
    ["acme/scripts/watch/run.py", "print('watch')"],
    ["acme/scripts/watch/run.sh", "echo watch"],
    ["tester/scripts/backup.sh", "echo backup"],
  ])
  mkdirSync(join(data, "ops", "watch"), { recursive: true })
  writeFileSync(join(data, "ops", "watch", "state.json"), '{"seen":1}')
  const jobs = join(scratch, "scripts-jobs.json")
  const first = await run(data, jobs)
  expect(first.code).toBe(0)
  expect(first.out).toBe(
    "jobs: rendered jobs.json, watch/config.json, watch/run.py, watch/run.sh, watch/.revision",
  )
  expect(readFileSync(join(data, "ops", "watch", "run.py"), "utf8")).toBe("print('watch')")
  expect(statSync(join(data, "ops", "watch", "run.sh")).mode & 0o777).toBe(0o755)
  expect(readFileSync(join(data, "ops", "watch", "state.json"), "utf8")).toBe('{"seen":1}')
  expect(existsSync(join(data, "ops", "backup.sh"))).toBe(false)
  expect((await run(data, jobs)).out).toBe("jobs: unchanged")
})

test("an org's script folder carries the accepted revision that last wrote it, which only a change to that folder moves (#1880)", async () => {
  const data = storeWith("revision", {}, [["acme/scripts/ops-watch/cli.ts", "console.log('one')"]])
  const jobs = join(scratch, "revision-jobs.json")
  const revision = () =>
    extGit(scopeDir(data, "acme"), [
      "log",
      "-1",
      "--format=%h",
      "--",
      "scripts/ops-watch",
    ]).out.trim()
  const held = () => readFileSync(join(data, "ops", "ops-watch", ".revision"), "utf8")
  expect((await run(data, jobs)).code).toBe(0)
  const first = revision()
  expect(held()).toBe(`${first}\n`)
  // an item elsewhere in the scope leaves the folder's revision as it was
  writeFiles(data, "acme", new Map([["notes/elsewhere.md", "x"]]), {
    author: "test",
    reason: "seed",
  })
  expect((await run(data, jobs)).out).toBe("jobs: unchanged")
  expect(held()).toBe(`${first}\n`)
  writeFiles(data, "acme", new Map([["scripts/ops-watch/cli.ts", "console.log('two')"]]), {
    author: "test",
    reason: "accept",
  })
  const next = await run(data, jobs)
  expect(revision()).not.toBe(first)
  expect(held()).toBe(`${revision()}\n`)
  expect(next.out).toBe("jobs: rendered ops-watch/cli.ts, ops-watch/.revision")
})

test("an org's own job row renders from its installed script folder, and a row pointing elsewhere is refused on stderr, exit 1 (PG-1335)", async () => {
  const watch = {
    callsModel: false,
    command: "{bun} --no-env-file {data}/ops/ops-watch/cli.ts",
    config: { prefixes: ["INC"] },
    description: "Watches an org's own queue.",
    enabled: true,
    heartbeat: "ops-watch",
    schedule: { every: 60 },
  }
  const settings = {
    "jobs.opsStray": { ...watch, command: "{bun} {checkout}/x.ts", heartbeat: "ops-stray" },
    "jobs.opsWatch": watch,
  }
  const data = storeWith("org-job", {}, [
    ["acme/scripts/ops-watch/cli.ts", "console.log('watch')"],
    ["acme/settings.json", JSON.stringify(settings)],
  ])
  const jobs = join(scratch, "org-job-jobs.json")
  const result = await run(data, jobs)
  expect(result.code).toBe(1)
  expect(result.err).toContain("jobs: refused acme jobs.opsStray: ")
  const rendered = JSON.parse(readFileSync(jobs, "utf8")).jobs as Record<string, unknown>[]
  expect(rendered.find((job) => job.name === "ops-watch")).toMatchObject({
    command: `/b/bun --no-env-file ${fill.data}/ops/ops-watch/cli.ts`,
    config: { prefixes: ["INC"] },
    cwd: `${fill.data}/ops/ops-watch`,
    org: "acme",
  })
  expect(rendered.map((job) => job.name)).not.toContain("ops-stray")
  expect(readFileSync(join(data, "ops", "ops-watch", "cli.ts"), "utf8")).toBe(
    "console.log('watch')",
  )
  // a pass that cannot read the orgs (here, no login) keeps each org's job as the last jobs.json had it, and says so where up.py logs it
  rmSync(join(extensionsDir(data), "login"))
  const unread = await run(data, jobs)
  expect(unread.code).toBe(1)
  expect(unread.err).toContain("jobs: kept each org's job as jobs.json had it")
  const kept = JSON.parse(readFileSync(jobs, "utf8")).jobs as Record<string, unknown>[]
  expect(kept.find((job) => job.name === "ops-watch")).toEqual(
    rendered.find((job) => job.name === "ops-watch"),
  )
})

// ext init can stop after making the extensions root, before a first setting writes policy.json.
test("an extensions root that lacks policy.json gets the registry's defaults, as a fresh machine does", async () => {
  const data = join(scratch, "no-policy")
  writeRoot(extensionsDir(data), new Map([["hooks/a.json", "[]"]]))
  const jobs = join(scratch, "no-policy", "ops", "jobs.json")
  expect(await run(data, jobs)).toEqual({ code: 0, err: "", out: "jobs: rendered jobs.json" })
  const rendered = JSON.parse(readFileSync(jobs, "utf8")).jobs as Record<string, unknown>[]
  expect(rendered.filter((job) => job.disabled !== true).map((job) => job.name)).toEqual(ON)
})

test("a policy.json that does not parse is refused, exit 2, and jobs.json is kept", async () => {
  const data = join(scratch, "refused")
  writeRoot(extensionsDir(data), new Map([["policy.json", "{"]]))
  const jobs = join(scratch, "refused-jobs.json")
  writeFileSync(jobs, '{"jobs":[]}\n')
  const refused = await run(data, jobs)
  expect(refused.code).toBe(2)
  expect(refused.err).not.toBe("")
  expect(readFileSync(jobs, "utf8")).toBe('{"jobs":[]}\n')
})

test("the command line takes render and --jobs, and names its usage otherwise", async () => {
  const err: string[] = []
  expect(
    await jobsExit(
      ["draw"],
      {},
      () => {},
      (l) => err.push(l),
    ),
  ).toBe(2)
  expect(err.join("\n")).toContain("usage: bun packages/scripts/src/playground/jobs.ts render")
})

test("a render with no --data from a checkout that is not the live dashboard's writes nothing, exit 2", async () => {
  const err: string[] = []
  const jobs = join(scratch, "no-data-jobs.json")
  expect(
    await jobsExit(
      ["render", "--jobs", jobs],
      { CLAUDE_CONFIG_DIR: join(scratch, "no-data-config") },
      () => {},
      (l) => err.push(l),
    ),
  ).toBe(2)
  expect(err.join("\n")).toContain("writes nowhere until --data <folder> names where")
  expect(existsSync(jobs)).toBe(false)
  expect(existsSync(join(scratch, "no-data-config"))).toBe(false)
})

test("the command line's render runs the Dashboard's job from the Dashboard's checkout, which its supervisor rolls", async () => {
  const data = join(scratch, "cli-fresh")
  const jobs = join(data, "ops", "jobs.json")
  expect(
    await jobsExit(
      ["render", "--data", data, "--jobs", jobs],
      {},
      () => {},
      () => {},
    ),
  ).toBe(0)
  const rendered = JSON.parse(readFileSync(jobs, "utf8")).jobs as Record<string, unknown>[]
  const desk = join(CHECKOUT, ".claude", "worktrees", "desk")
  expect(rendered.find((job) => job.name === "ops-dashboard")).toMatchObject({
    command: `${desk}/scripts/ops/dashboard/run.sh`,
    cwd: desk,
  })
  expect(rendered.find((job) => job.name === "ops-sweep")!.cwd).toBe(CHECKOUT)
})

// #2203: on Linux the same render installs each launchd job as a systemd user unit, in a HOME of the test's own whose ~/.config/systemd/user is the folder systemd reads, every systemctl --user call recorded: is-active answers whether a unit runs, enable --now starts one, stop ends one (each refusing while refusals given remain), or ends the render as systemd ends a unit that stops itself (killed); loginctl answers the user's linger (on by default) and its enable-linger exits as lingerExit says, each call recorded too.
const unitRun = async (
  name: string,
  values: Record<string, unknown>,
  systemd: {
    active?: string[]
    killed?: boolean
    linger?: string
    lingerExit?: number
    refusals?: number
  } = {},
) => {
  const data = storeWith(name, values)
  const home = join(scratch, name, "home")
  const units = join(home, ".config", "systemd", "user")
  mkdirSync(units, { recursive: true })
  const calls: string[][] = []
  const active = new Set(systemd.active ?? [])
  let refusals = systemd.refusals ?? 0
  const logins: string[][] = []
  const install = {
    loginctl: async (args: string[]) => {
      logins.push(args)
      if (args[0] === "show-user") return { code: 0, out: `${systemd.linger ?? "yes"}\n` }
      return { code: systemd.lingerExit ?? 0, out: systemd.lingerExit ? "Access denied" : "" }
    },
    systemctl: async (args: string[]) => {
      calls.push(args)
      const unit = args.at(-1)!
      if (args[0] === "is-active") return { code: active.has(unit) ? 0 : 3, out: "" }
      if (refusals > 0) {
        refusals--
        return { code: 1, out: "nope" }
      }
      if (args[0] === "enable") active.add(unit)
      if (args[0] === "stop" && systemd.killed) throw new Error("killed by its own stop")
      if (args[0] === "stop") active.delete(unit)
      return { code: 0, out: "" }
    },
    uid: 1000,
    units,
  }
  // the logs go into the test's own data folder, which the install makes each log's folder in
  const options = {
    data,
    fill: { ...fill, data },
    install,
    jobs: join(data, "ops", "jobs.json"),
    roots: { home, main: CHECKOUT, trash: join(data, "trash") },
  }
  const render = async () => {
    const out: string[] = []
    const err: string[] = []
    const exit = await renderJobsFile(
      options,
      (l) => out.push(l),
      (l) => err.push(l),
    )
    return { code: exit, err: err.join("\n"), out: out.join("\n") }
  }
  const changes = () => calls.filter((args) => args[0] !== "is-active")
  return { calls, changes, data, logins, render, units }
}

test("on Linux a launchd job turned on is written as a user unit and enabled once, and one already there and active stays as it stands", async () => {
  const { changes, data, render, units } = await unitRun(
    "unit-on",
    {
      "jobs.opsHerdr": {
        ...tick,
        heartbeat: "ops-herdr",
        launchd: "com.playground.ops-herdr",
        program: ["{bun}", "{checkout}/packages/scripts/src/ops-herdr/cli.ts"],
      },
      "jobs.opsTick": tick,
    },
    { active: ["com.playground.ops-herdr.service"] },
  )
  const herdr = join(units, "com.playground.ops-herdr.service")
  writeFileSync(herdr, "installed by hand")
  const first = await render()
  expect(first).toMatchObject({ code: 0, err: "" })
  expect(first.out).toContain("+com.playground.ops-tick")
  const tickUnit = join(units, "com.playground.ops-tick.service")
  expect(readFileSync(tickUnit, "utf8")).toContain('"/c/packages/scripts/src/ops-tick/cli.ts"')
  expect(changes()).toEqual([["enable", "--now", "com.playground.ops-tick.service"]])
  expect(statSync(join(data, "ops", "tick")).isDirectory()).toBe(true)
  expect(readFileSync(herdr, "utf8")).toBe("installed by hand")
  expect((await render()).out).toBe("jobs: unchanged")
  expect(changes()).toHaveLength(1)
})

test("on Linux a launchd job turned off is disabled, its unit moved to the trash and systemd reloaded, then stopped, and another unit left alone", async () => {
  const { changes, data, render, units } = await unitRun(
    "unit-off",
    { "jobs.opsTick": { ...tick, enabled: false } },
    { active: ["com.playground.ops-tick.service"] },
  )
  const tickUnit = join(units, "com.playground.ops-tick.service")
  writeFileSync(tickUnit, "installed")
  writeFileSync(join(units, "other.service"), "theirs")
  const done = await render()
  expect(done).toMatchObject({ code: 0, err: "" })
  expect(done.out).toContain("-com.playground.ops-tick")
  expect(changes()).toEqual([
    ["disable", "com.playground.ops-tick.service"],
    ["daemon-reload"],
    ["stop", "com.playground.ops-tick.service"],
  ])
  expect(existsSync(tickUnit)).toBe(false)
  const [batch] = readdirSync(join(data, "trash"))
  expect(
    readFileSync(join(data, "trash", batch!, "1", "com.playground.ops-tick.service"), "utf8"),
  ).toBe("installed")
  expect(readFileSync(join(units, "other.service"), "utf8")).toBe("theirs")
  expect((await render()).out).toBe("jobs: unchanged")
  expect(changes()).toHaveLength(3)
})

// ops-tick runs the render through up.py inside its own unit, so stopping ops-tick ends the render inside that call.
test("on Linux a unit whose stop ends the render is disabled and in the trash already", async () => {
  const { changes, render, units } = await unitRun(
    "unit-self",
    { "jobs.opsTick": { ...tick, enabled: false } },
    { active: ["com.playground.ops-tick.service"], killed: true },
  )
  const tickUnit = join(units, "com.playground.ops-tick.service")
  writeFileSync(tickUnit, "installed")
  await expect(render()).rejects.toThrow("killed by its own stop")
  expect(changes()).toEqual([
    ["disable", "com.playground.ops-tick.service"],
    ["daemon-reload"],
    ["stop", "com.playground.ops-tick.service"],
  ])
  expect(existsSync(tickUnit)).toBe(false)
})

test("on Linux an enable systemctl refuses is named on stderr, exits 1, and is tried again on the next pass", async () => {
  const { changes, render } = await unitRun(
    "unit-refused",
    { "jobs.opsTick": tick },
    { refusals: 1 },
  )
  const first = await render()
  expect(first.code).toBe(1)
  expect(first.err).toBe("jobs: refused enable of com.playground.ops-tick.service, exit 1: nope")
  expect(await render()).toMatchObject({
    code: 0,
    err: "",
    out: "jobs: rendered +com.playground.ops-tick",
  })
  expect(changes()).toEqual([
    ["enable", "--now", "com.playground.ops-tick.service"],
    ["enable", "--now", "com.playground.ops-tick.service"],
  ])
})

// #2314: linger keeps the units running with no one logged in, so a pass that starts one turns it on once, never asking for a password, and names on stderr what it did or what refused it, leaving the pass's exit alone
test("on Linux a pass that starts a unit turns linger on once and says so, and a refused linger is named without failing the pass", async () => {
  const two = {
    "jobs.opsHerdr": { ...tick, heartbeat: "ops-herdr", launchd: "com.playground.ops-herdr" },
    "jobs.opsTick": tick,
  }
  const off = await unitRun("linger-off", two, { linger: "no" })
  expect(await off.render()).toMatchObject({ code: 0, err: "jobs: turned on linger for user 1000" })
  expect(off.logins).toEqual([
    ["show-user", "1000", "--property=Linger", "--value"],
    ["--no-ask-password", "enable-linger", "1000"],
  ])
  const refused = await unitRun(
    "linger-refused",
    { "jobs.opsTick": tick },
    { linger: "no", lingerExit: 1 },
  )
  expect(await refused.render()).toMatchObject({
    code: 0,
    err: "jobs: refused enable-linger of user 1000, exit 1: Access denied",
    out: "jobs: rendered jobs.json, +com.playground.ops-tick",
  })
  const on = await unitRun("linger-on", { "jobs.opsTick": tick })
  expect(await on.render()).toMatchObject({ code: 0, err: "" })
  expect(on.logins).toEqual([["show-user", "1000", "--property=Linger", "--value"]])
})

// The command line picks systemctl --user on Linux, through a fake systemctl first on PATH that records each call and finds no unit active.
test("on Linux the command line's render installs through systemctl --user, making the unit and its log's folder", async () => {
  const data = storeWith("cli-linux", { "jobs.opsTick": tick })
  const bin = join(scratch, "cli-linux", "bin")
  mkdirSync(bin, { recursive: true })
  const said = join(bin, "said")
  // each fake also logs the bus it was given, which must never be the user's live one
  const bus = join(bin, "bus")
  const logBus = `echo "XDG_RUNTIME_DIR=$XDG_RUNTIME_DIR DBUS_SESSION_BUS_ADDRESS=$DBUS_SESSION_BUS_ADDRESS" >> "${bus}"`
  writeFileSync(
    join(bin, "systemctl"),
    `#!/bin/sh\n${logBus}\necho "$*" >> "${said}"\n[ "$2" = is-active ] && exit 3\nexit 0\n`,
    { mode: 0o755 },
  )
  // a fake loginctl too, so the real one never turns linger on for whoever runs the suite
  writeFileSync(
    join(bin, "loginctl"),
    `#!/bin/sh\n${logBus}\necho "loginctl $*" >> "${said}"\necho yes\n`,
    { mode: 0o755 },
  )
  const units = join(scratch, "cli-linux", "home", ".config", "systemd", "user")
  const err: string[] = []
  const code = await jobsExit(
    ["render", "--data", data, "--jobs", join(data, "ops", "jobs.json"), "--install", units],
    {
      ...SYSTEMD_ENV,
      HOME: join(scratch, "cli-linux", "home"),
      PATH: `${bin}:${process.env.PATH}`,
    },
    () => {},
    (l) => err.push(l),
    "linux",
  )
  expect({ code, err: err.join("\n") }).toEqual({ code: 0, err: "" })
  const lines = readFileSync(said, "utf8").trim().split("\n")
  expect(lines).toContain("--user is-active --quiet com.playground.ops-tick.service")
  expect(lines.filter((line) => !line.startsWith("--user is-active "))).toEqual([
    `loginctl show-user ${process.getuid!()} --property=Linger --value`,
    "--user enable --now com.playground.ops-tick.service",
  ])
  expect(readFileSync(join(units, "com.playground.ops-tick.service"), "utf8")).toContain(
    `StandardOutput=append:${data}/ops/tick/launchd.log`,
  )
  expect(statSync(join(data, "ops", "tick")).isDirectory()).toBe(true)
  const buses = readFileSync(bus, "utf8")
  expect(buses).toContain(`XDG_RUNTIME_DIR=${runtime} `)
  expect(liveBusLines(buses)).toEqual([])
})

test("on Linux with no systemctl on PATH the command line's render names the refused enable and exits 1", async () => {
  const data = storeWith("cli-no-systemctl", { "jobs.opsTick": tick })
  const empty = join(scratch, "cli-no-systemctl", "empty")
  mkdirSync(empty, { recursive: true })
  const err: string[] = []
  const code = await jobsExit(
    [
      "render",
      "--data",
      data,
      "--jobs",
      join(data, "ops", "jobs.json"),
      "--install",
      join(scratch, "cli-no-systemctl", "home", ".config", "systemd", "user"),
    ],
    { ...SYSTEMD_ENV, HOME: join(scratch, "cli-no-systemctl", "home"), PATH: empty },
    () => {},
    (l) => err.push(l),
    "linux",
  )
  expect(code).toBe(1)
  expect(err.join("\n")).toContain(
    "jobs: refused enable of com.playground.ops-tick.service, exit 127",
  )
})
