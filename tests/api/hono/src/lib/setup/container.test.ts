import { afterAll, beforeEach, describe, expect, test, vi } from "bun:test"
import { randomUUID } from "node:crypto"
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"

import { livePair } from "../../../../../../api/hono/src/lib/dev/live-dashboard"
import {
  isNamedContainer,
  portFromPort,
  setupName,
  startArgv,
  startLocal,
  startPgliteDatabase,
  urlFor,
  withDatabase,
} from "../../../../../../api/hono/src/lib/setup/container"
import { stubs } from "../../../../../../packages/scripts/src/new-user-gate/stubs"

// A fresh temp folder per test, so no startLocal writes a real .env and no test leaves files behind.
const dir = mkdtempSync(join(tmpdir(), "setup-container-"))
const envFile = join(dir, ".env")
afterAll(() => rmSync(dir, { force: true, recursive: true }))

// The password every argv and URL in this suite uses, so startLocal's URL and run argv stay in step.
// It is read back from docker inspect on a reuse, so it is a random value this run chose, never a literal.
const PASSWORD = randomUUID()

const URL = `postgres://postgres:${PASSWORD}@localhost:54123/postgres`

// A fake Run: it logs each call, replies to the ones startLocal makes, and never touches Docker.
class FakeRun {
  calls: { args: string[]; when: string }[] = []
  constructor(public readonly when: string) {}
  run = async (args: string[]) => {
    this.calls.push({ args, when: this.when })
    return { code: 0, stderr: "", stdout: "" }
  }
}

// A fake that also answers docker ps and docker port, keyed on the first arg so startLocal's list reuses the running child.
class FakeDocker extends FakeRun {
  containers: string[]
  runningPort: number
  constructor(when: string, containers: string[] = [], runningPort: number = 54123) {
    super(when)
    this.containers = containers
    this.runningPort = runningPort
  }
  run = async (args: string[]) => {
    this.calls.push({ args, when: this.when })
    if (args[0] === "ps") {
      return {
        code: 0,
        stderr: "",
        stdout: this.containers.map((c) => (c.includes("\t") ? c : `${c}\trunning`)).join("\n"),
      }
    }
    if (args[0] === "port") {
      return { code: 0, stderr: "", stdout: `5432/tcp -> 127.0.0.1:${this.runningPort}\n` }
    }
    return { code: 0, stderr: "", stdout: "" }
  }
}

// Pure: the name an argv names, as `run --name <name> -d ...`, so a test derives the child's name from the run call.
const named = (argv: string[]): string => argv[argv.indexOf("--name") + 1]

// Pure: the password an argv binds, from the `POSTGRES_PASSWORD=<pw>` element, so a test can compare the URL's and the run's.
const passwordOfArgv = (argv: string[]): string =>
  argv.find((arg) => arg.startsWith("POSTGRES_PASSWORD="))?.slice("POSTGRES_PASSWORD=".length) ?? ""

describe("startArgv", () => {
  test("publishes the Postgres port on 127.0.0.1 alone, with the checkout's name, the postgres login and this run's password", () => {
    expect(startArgv("playground-db", PASSWORD)).toEqual([
      "run",
      "--name",
      "playground-db",
      "-d",
      "-p",
      "127.0.0.1::5432",
      "-e",
      "POSTGRES_USER=postgres",
      "-e",
      `POSTGRES_PASSWORD=${PASSWORD}`,
      "-e",
      "POSTGRES_DB=postgres",
      "postgres:alpine",
    ])
  })

  test("binds the host port to 127.0.0.1, so only this machine can reach it", () => {
    const argv = startArgv("playground-db", PASSWORD)
    expect(argv[argv.indexOf("-p") + 1]).toMatch(/^127\.0\.0\.1::5432$/)
  })

  test("binds this run's password to the postgres login, so the URL reads it back", () => {
    expect(passwordOfArgv(startArgv("playground-db", PASSWORD))).toBe(PASSWORD)
  })
})

describe("portFromPort and urlFor", () => {
  test("portFromPort reads the host port docker port prints, or is null", () => {
    expect(portFromPort("5432/tcp -> 127.0.0.1:54123\n")).toBe(54123)
    expect(portFromPort("5432/tcp -> 127.0.0.1:54123")).toBe(54123)
    expect(portFromPort("")).toBeNull()
  })

  test("urlFor names the postgres login, this run's password, on localhost and the port", () => {
    expect(urlFor(54123, PASSWORD)).toBe(URL)
  })
})

describe("isNamedContainer", () => {
  test("is a base dash four letters or digits, like a fresh start's child", () => {
    expect(isNamedContainer("playground-db", "playground-db-a1B2")).toBe(true)
    expect(isNamedContainer("playground-db", "playground-db-x9Kq")).toBe(true)
    expect(isNamedContainer("playground-db", "playground-db")).toBe(false)
    expect(isNamedContainer("playground-db", "playground-db-a1B2c")).toBe(false)
    expect(isNamedContainer("playground-db", "playground-db-12ab")).toBe(true)
  })
})

describe("withDatabase and setupName", () => {
  const live = { branch: "live/dashboard", database: "playground-dashboard-db" }
  test("withDatabase replaces the line or adds one, and setupName is the live database on its branch", () => {
    expect(withDatabase("", URL)).toContain(`POSTGRES_URL=${URL}\n`)
    expect(withDatabase("NODE_ENV=local\nPOSTGRES_URL=old\n", URL)).toBe(
      "NODE_ENV=local\nPOSTGRES_URL=" + URL + "\n",
    )
    expect(setupName("/repo/.claude/worktrees/pg-x-db", "feature", live)).toBe(
      "playground-pg-x-db-db",
    )
    expect(setupName("/repo", "live/dashboard", live)).toBe("playground-dashboard-db")
  })
})

// Spies, so no test waits, proves or migrates for real while the rest of startLocal is stubbed.
const noMigrate = vi.fn(async () => {})
const noProve = vi.fn(async () => "")
const noWait = vi.fn(async () => {})

// A fake startLocal: docker is fake, migrate/prove/wait are spies, and onStep logs.
const go = (
  docker: FakeDocker,
  fileText = "",
  more: Partial<Parameters<typeof startLocal>[0]> = {},
) =>
  startLocal({
    envFile,
    name: "playground-db",
    onStep: () => undefined,
    docker: docker.run,
    migrate: noMigrate,
    prove: noProve,
    wait: noWait,
    ...more,
  } as Parameters<typeof startLocal>[0])

beforeEach(async () => {
  await Bun.write(envFile, "")
  noMigrate.mockClear()
  noProve.mockClear()
  noWait.mockClear()
})

describe("startLocal", () => {
  test("starts the container published on 127.0.0.1 alone, waits, proves, migrates and saves .env", async () => {
    const docker = new FakeDocker("Starting", [], 54123)
    const url = await go(docker)

    // It lists, then runs the container on loopback alone, naming it, and reads the port back off that child. The run and the URL carry the same password this run chose.
    const runCall = docker.calls.find((c) => c.args[0] === "run")
    expect(runCall).toBeDefined()
    const child = named(runCall!.args)
    expect(runCall!.args).toEqual(startArgv(child, passwordOfArgv(runCall!.args)))
    expect(runCall!.args).toContain("127.0.0.1::5432")

    expect(docker.calls.find((c) => c.args[0] === "port")!.args).toEqual(["port", child])
    expect(url).toBe(urlFor(54123, passwordOfArgv(runCall!.args)))

    const execCall = docker.calls.find((c) => c.args[0] === "exec")
    expect(execCall!.args).toEqual(["exec", child, "pg_isready", "-U", "postgres"])
    expect(noProve).toHaveBeenCalledWith(url)
    expect(noMigrate).toHaveBeenCalledWith(url)

    expect(await Bun.file(envFile).text()).toContain(`POSTGRES_URL=${url}`)
  })

  test("the loopback argv names only this container and this run's password, nothing from a request", async () => {
    const docker = new FakeDocker("Starting", [], 54123)
    await go(docker)
    const argv = docker.calls.find((c) => c.args[0] === "run")!.args
    expect(argv[argv.indexOf("-p") + 1]).toBe("127.0.0.1::5432")
    expect(argv).toEqual(startArgv(named(argv), passwordOfArgv(argv)))
  })

  test("when docker reports no port, it says what docker printed and leaves the running container", async () => {
    const docker = new FakeDocker("Starting", ["playground-db-a1B2"], 54123)
    const origRun = docker.run
    docker.run = async (args) =>
      args[0] === "port" ? { code: 0, stderr: "", stdout: "" } : { ...(await origRun(args)) }
    await expect(go(docker)).rejects.toThrow("docker reported no port")
  })

  test("a name already running is reused, not started again, so no argv run is made", async () => {
    const docker = new FakeDocker("Starting", ["playground-db-x9Kq"], 54123)
    await go(docker)
    expect(docker.calls.find((c) => c.args[0] === "run")).toBeUndefined()
  })

  test("asked to move, a reused container moves onto loopback on its own port before the proof", async () => {
    const docker = new FakeDocker("Starting", ["playground-db-x9Kq"], 216)
    const moveTo = vi.fn(async () => ["Moved"])
    const steps: string[] = []
    const url = await go(docker, "", { move: true, moveTo, onStep: (step) => steps.push(step) })
    expect(moveTo).toHaveBeenCalledWith("playground-db-x9Kq", 216, docker.run, noWait)
    expect(steps.indexOf("Moved")).toBeLessThan(
      steps.indexOf("Checking the database is on this Mac"),
    )
    expect(noProve).toHaveBeenCalledWith(url)
    const again = new FakeDocker("Starting", ["playground-db-x9Kq"], 216)
    await Bun.write(envFile, "")
    await go(again, "", { moveTo })
    expect(moveTo).toHaveBeenCalledTimes(1)
  })

  test("a reused container's URL reads its password from docker inspect, not a fixed one", async () => {
    const docker = new FakeDocker("Starting", ["playground-db-x9Kq"], 216)
    const origRun = docker.run
    docker.run = async (args) =>
      args[0] === "inspect"
        ? {
            code: 0,
            stderr: "",
            stdout: JSON.stringify([{ Config: { Env: [`POSTGRES_PASSWORD=${PASSWORD}`] } }]),
          }
        : { ...(await origRun(args)) }
    const url = await go(docker)
    expect(docker.calls.find((c) => c.args[0] === "run")).toBeUndefined()
    expect(url).toBe(urlFor(216, PASSWORD))
    expect(noProve).toHaveBeenCalledWith(url)
  })

  test("a stopped container of the name is left as it is, and a new one is started beside it", async () => {
    const docker = new FakeDocker("Starting", ["playground-db-x9Kq\texited"], 54123)
    await go(docker)
    const run = docker.calls.find((c) => c.args[0] === "run")
    expect(run).toBeDefined()
    expect(named(run?.args ?? [])).not.toBe("playground-db-x9Kq")
  })

  test("with no name running, it starts one and, if the live dashboard's, keeps it running after a reboot", async () => {
    const docker = new FakeDocker("Starting", [], 54123)
    await go(docker, undefined, { name: "playground-dashboard-db", branch: "live/dashboard" })
    expect(docker.calls.find((c) => c.args[0] === "run")).toBeDefined()
    expect(docker.calls.find((c) => c.args[0] === "update")).toBeDefined()
  })

  test("with the live dashboard's own unsuffixed database, it refuses to start a second one beside it", async () => {
    const docker = new FakeDocker("Starting", ["playground-dashboard-db"], 54123)
    await expect(
      go(docker, undefined, { branch: "live", name: "playground-dashboard-db" }),
    ).rejects.toThrow("holds the")
  })

  test("when docker cannot list its containers, it says so and does not start one", async () => {
    const docker = new FakeDocker("Docker down", [], 54123)
    const origRun = docker.run
    docker.run = async (args) =>
      args[0] === "info" || args[0] === "ps"
        ? { code: 1, stderr: "docker down", stdout: "" }
        : { ...(await origRun(args)) }
    await expect(go(docker)).rejects.toThrow(/could not list|Docker is not running/)
  })

  test("when docker cannot start the container, it says what docker printed and leaves it unstarted", async () => {
    const docker = new FakeDocker("Starting", [], 54123)
    const origRun = docker.run
    docker.run = async (args) =>
      args[0] === "run"
        ? { code: 1, stderr: "cannot create network", stdout: "" }
        : { ...(await origRun(args)) }
    await expect(go(docker)).rejects.toThrow("docker run")
  })

  test("when Postgres does not come up, it waits, then says so and does not migrate or save .env", async () => {
    const docker = new FakeDocker("Starting", ["playground-db-a1B2"], 54123)
    const origRun = docker.run
    docker.run = async (args) =>
      args[0] === "exec" ? { code: 1, stderr: "", stdout: "" } : { ...(await origRun(args)) }
    await expect(go(docker)).rejects.toThrow("did not start")
    expect(noMigrate).not.toHaveBeenCalled()
    expect(await Bun.file(envFile).text()).not.toContain("POSTGRES_URL")
  })

  test("the container first run starts under it, published on 127.0.0.1 alone, passes the live guard", async () => {
    // A loopback-only container is the live dashboard's database; it is reused, and startArgv binds it to 127.0.0.1.
    const docker = new FakeDocker("Starting", ["playground-db-a1B2"], 54123)
    await go(docker, undefined, { branch: "live" })
    const runCall = docker.calls.find((c) => c.args[0] === "run")
    expect(runCall).toBeUndefined()
    // A fresh one would bind to loopback alone.
    expect(startArgv("playground-db", PASSWORD)).toContain("127.0.0.1::5432")
  })
})

// A new-user gate box whose stand-ins front a host docker (host-docker.ts) holding one decoy the box did not make: a running container named as first run reuses, on its own port, with the password the box would use.
const decoyBox = (nameOf: (dir: string) => string) => {
  const box = realpathSync(mkdtempSync(join(tmpdir(), "pg-gate-decoy-")))
  const host = join(box, "host")
  const stand = join(box, "stubs")
  const state = join(box, "docker.json")
  mkdirSync(host)
  mkdirSync(stand)
  writeFileSync(
    join(host, "docker"),
    `#!/bin/sh\nexec bun ${join(import.meta.dir, "host-docker.ts")} "$@"\n`,
  )
  chmodSync(join(host, "docker"), 0o755)
  for (const [name, text] of Object.entries(stubs(box, "", "", join(host, "docker")))) {
    writeFileSync(join(stand, name), text)
    chmodSync(join(stand, name), 0o755)
  }
  const name = nameOf(box)
  const decoy = {
    env: ["POSTGRES_PASSWORD=box-password"],
    id: "d".repeat(64),
    labels: {},
    name: `${name}-ab12`,
    port: 55001,
    state: "running",
  }
  writeFileSync(state, JSON.stringify([decoy]))
  const env = {
    DOCKER_STATE: state,
    PATH: `${stand}:${host}:${dirname(process.execPath)}:/usr/bin:/bin`,
  }
  const docker = async (args: string[]) => {
    const child = Bun.spawn([Bun.which("docker", { PATH: env.PATH })!, ...args], {
      env,
      stderr: "pipe",
      stdout: "pipe",
    })
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    return { code, stderr, stdout }
  }
  return { box, decoy: decoy.name, docker, name, state }
}

describe("first run in a new-user gate box", () => {
  const live = livePair()
  for (const [label, nameOf] of [
    ["with no live.container seed", () => live.database],
    ["with the box's own live.container seed", (box: string) => `${basename(box)}-db`],
  ] as const) {
    test(`on the live branch, never reaches a decoy the box did not make, ${label}`, async () => {
      const { box, decoy, docker, name, state } = decoyBox(nameOf)
      try {
        const url = await startLocal({
          branch: live.branch,
          docker,
          envFile: join(box, ".env"),
          migrate: async () => {},
          name,
          onStep: () => {},
          prove: async () => "",
          wait: async () => {},
        })
        expect(url).not.toContain(":55001/")
        expect(url).not.toContain("box-password")
        const touched = readFileSync(`${state}.log`, "utf8")
          .split("\n")
          .filter((line) => line.includes(decoy))
        expect(touched).toEqual([])
        expect((await docker(["inspect", decoy])).code).not.toBe(0)
        expect(readFileSync(join(box, "calls.log"), "utf8")).toContain(
          `docker refused inspect ${decoy}`,
        )
      } finally {
        rmSync(box, { force: true, recursive: true })
      }
    })
  }
})

describe("startPgliteDatabase", () => {
  const LITE = "postgres://postgres@127.0.0.1:54200/postgres?prepare=false"

  test("starts the checkout's PGlite, proves it, migrates it and saves its URL, with no Docker", async () => {
    const file = join(dir, "pglite.env")
    writeFileSync(file, "BETTER_AUTH_SECRET=x\n")
    const steps: string[] = []
    const order: string[] = []
    const url = await startPgliteDatabase({
      envFile: file,
      migrate: async (u) => void order.push(`migrate ${u}`),
      name: "playground-a-db",
      onStep: (step) => steps.push(step),
      prove: async (u) => (order.push(`prove ${u}`), "proved"),
      start: async (name) => (order.push(`start ${name}`), LITE),
    })
    expect(url).toBe(LITE)
    expect(order).toEqual(["start playground-a-db", `prove ${LITE}`, `migrate ${LITE}`])
    expect(steps).toEqual([
      "Starting PGlite",
      "Checking the database is on this Mac",
      "Creating the tables",
      "Saving the database address",
    ])
    expect(readFileSync(file, "utf8")).toBe(`BETTER_AUTH_SECRET=x\nPOSTGRES_URL=${LITE}\n`)
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  test("refuses a .env that already names a database, starting nothing", async () => {
    const file = join(dir, "pglite-set.env")
    writeFileSync(file, `POSTGRES_URL=${LITE}\n`)
    const started: string[] = []
    const run = startPgliteDatabase({
      envFile: file,
      name: "playground-a-db",
      onStep: () => {},
      start: async (name) => (started.push(name), LITE),
    })
    await expect(run).rejects.toThrow("already names a database")
    expect(started).toEqual([])
  })
})
