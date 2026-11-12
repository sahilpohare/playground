import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const {
  containerName,
  DOCKER_DOWN,
  parseLaunch,
  PGLAUNCH,
  setupName,
  startLocal,
  startPgliteDatabase,
  withDatabase,
} = await import("../../../../../../api/hono/src/lib/setup/container")
const { livePair } = await import("../../../../../../api/hono/src/lib/dev/live-dashboard")
const { othersLiveDashboard } = await import("../../../../../../api/hono/src/lib/dev/launch")
const { locate } = await import("../../../../../../api/hono/src/lib/sessions/guard")
type Run = import("../../../../../../api/hono/src/lib/setup/container").Run
type Docker = import("../../../../../../api/hono/src/lib/sessions/guard").Docker

const LIVE = livePair()

const dir = mkdtempSync(join(tmpdir(), "setup-container-"))
afterAll(() => rmSync(dir, { force: true, recursive: true }))

type Answer = Partial<{ code: number; stderr: string; stdout: string }>

// A command as a script: each call's argv is recorded, and answers come from the first rule whose first argument matches, else success with no output.
const fake = (answers: Record<string, Answer> = {}) => {
  const calls: string[][] = []
  const run: Run = async (args) => {
    calls.push(args)
    return { code: 0, stderr: "", stdout: "", ...answers[args[0]!] }
  }
  return { calls, run }
}

// pglaunch 5.5.7's own words, its URL line coloured as it prints it.
const URL = "postgres://postgres:postgres@localhost:54123/postgres"
const STARTED = `- A container with name "playground-a-db-x9Kq :54123" started successfully.\n\n  \u001b[34mPOSTGRES_URL=${URL}\u001b[39m\n`
const RUNNING = `- A container by similar name "playground-a-db-Ab12" running at port 54123.\n\n  \u001b[32mPOSTGRES_URL=${URL}\u001b[39m\n`
const COLLIDED = "  Error:\n  - Specify a different name with the `-n` flag, e.g. -n my-project.\n"

// pglaunch answering in turn: each call takes the next answer.
const pglaunch = (...answers: Answer[]) => {
  const calls: string[][] = []
  const run: Run = async (args) => {
    calls.push(args)
    return { code: 0, stderr: "", stdout: "", ...answers[calls.length - 1] }
  }
  return { calls, run }
}

const envFile = (name: string, text = "BETTER_AUTH_SECRET=x\nPOSTGRES_URL=\n") => {
  const file = join(dir, name)
  writeFileSync(file, text)
  return file
}

const go = (
  docker: Run,
  bunx: Run,
  file: string,
  more: Partial<Parameters<typeof startLocal>[0]> = {},
) =>
  startLocal({
    bunx,
    docker,
    envFile: file,
    migrate: async () => {},
    name: "playground-a-db",
    onStep: () => {},
    prove: async () => "proved",
    wait: async () => {},
    ...more,
  })

describe("containerName", () => {
  test("is playground-db in a checkout of its own, and the worktree's own under .claude/worktrees/", () => {
    expect(containerName("/home/me/dispatcher")).toBe("playground-db")
    expect(containerName("/home/me/dispatcher/.claude/worktrees/pg-939-first-run")).toBe(
      "playground-pg-939-first-run-db",
    )
  })
})

describe("withDatabase", () => {
  test("replaces the POSTGRES_URL line, or adds one", () => {
    expect(withDatabase("A=1\nPOSTGRES_URL=\nB=2\n", "postgres://x")).toBe(
      "A=1\nPOSTGRES_URL=postgres://x\nB=2\n",
    )
    expect(withDatabase("A=1", "postgres://x")).toBe("A=1\nPOSTGRES_URL=postgres://x\n")
    expect(withDatabase("", "postgres://x")).toBe("POSTGRES_URL=postgres://x\n")
  })
})

describe("parseLaunch", () => {
  test("reads the URL and the container pglaunch started, or the running one it found by name", () => {
    expect(parseLaunch(STARTED)).toEqual({ container: "playground-a-db-x9Kq", url: URL })
    expect(parseLaunch(RUNNING + COLLIDED)).toEqual({ container: "playground-a-db-Ab12", url: URL })
  })

  test("is null when pglaunch printed no URL", () => {
    expect(parseLaunch("- Docker is installed but not running.\n")).toBeNull()
  })
})

describe("startLocal", () => {
  test("starts Postgres with the pinned pglaunch, waits for it, proves, migrates and saves .env as 0600", async () => {
    const docker = fake()
    const bunx = pglaunch({ stdout: STARTED })
    const steps: string[] = []
    const proved: string[] = []
    const migrated: string[] = []
    const file = envFile("ok.env")
    const url = await go(docker.run, bunx.run, file, {
      migrate: async (u) => void migrated.push(u),
      onStep: (s) => steps.push(s),
      prove: async (u) => {
        proved.push(u)
        return "proved"
      },
    })
    expect(PGLAUNCH).toBe("pglaunch@5.5.7")
    expect(url).toBe(URL)
    expect(bunx.calls).toEqual([["--bun", "pglaunch@5.5.7", "-k", "-n", "playground-a-db"]])
    expect(docker.calls).toEqual([
      ["info"],
      ["exec", "playground-a-db-x9Kq", "pg_isready", "-U", "postgres"],
    ])
    expect(proved).toEqual([URL])
    expect(migrated).toEqual([URL])
    expect(readFileSync(file, "utf8")).toBe(`BETTER_AUTH_SECRET=x\nPOSTGRES_URL=${URL}\n`)
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(steps).toEqual([
      "Checking Docker",
      "Starting Postgres",
      "Waiting for Postgres",
      "Checking the database is on this Mac",
      "Creating the tables",
      "Saving the database address",
    ])
  })

  test("a .env made from .env.example, its POSTGRES_URL empty above other keys, starts and is saved", async () => {
    const example = readFileSync(join(import.meta.dir, "../../../../../../.env.example"), "utf8")
    expect(example).toMatch(/^POSTGRES_URL=\n/m)
    const file = envFile("example.env", example)
    expect(await go(fake().run, pglaunch({ stdout: STARTED }).run, file)).toBe(URL)
    expect(readFileSync(file, "utf8").match(/^POSTGRES_URL=.*$/gm)).toEqual([`POSTGRES_URL=${URL}`])
  })

  test("a name already running is reused from the URL pglaunch prints as it exits 1", async () => {
    const docker = fake()
    const bunx = pglaunch({ code: 1, stderr: COLLIDED, stdout: RUNNING })
    expect(await go(docker.run, bunx.run, envFile("reuse.env"))).toBe(URL)
    expect(bunx.calls).toHaveLength(1)
    expect(docker.calls[1]).toEqual([
      "exec",
      "playground-a-db-Ab12",
      "pg_isready",
      "-U",
      "postgres",
    ])
  })

  test("with no URL printed, runs pglaunch once more with -c, then says what it printed", async () => {
    const twice = pglaunch({ code: 1, stderr: "boom" }, { stdout: STARTED })
    expect(await go(fake().run, twice.run, envFile("again.env"))).toBe(URL)
    expect(twice.calls[1]).toEqual(["--bun", "pglaunch@5.5.7", "-k", "-n", "playground-a-db", "-c"])
    const never = pglaunch(
      { code: 1, stderr: "no space left" },
      { code: 1, stderr: "no space left" },
    )
    await expect(go(fake().run, never.run, envFile("never.env", "A=1\n"))).rejects.toThrow(
      "pglaunch printed no database address: no space left",
    )
  })

  test("with Docker down, says how to start it and runs nothing else", async () => {
    const docker = fake({ info: { code: 1, stderr: "Cannot connect" } })
    const bunx = pglaunch()
    await expect(go(docker.run, bunx.run, envFile("down.env"))).rejects.toThrow(DOCKER_DOWN)
    expect(docker.calls.map((c) => c[0])).toEqual(["info"])
    expect(bunx.calls).toEqual([])
  })

  test("a step that fails leaves .env as it was and removes no container", async () => {
    const cases: [Run, Partial<Parameters<typeof startLocal>[0]>, string][] = [
      [fake({ exec: { code: 2 } }).run, {}, "did not start in 30 seconds"],
      [fake().run, { prove: async () => Promise.reject(new Error("no proof")) }, "no proof"],
      [
        fake().run,
        { migrate: async () => Promise.reject(new Error("relation exists")) },
        "relation exists",
      ],
    ]
    for (const [docker, more, words] of cases) {
      const calls: string[][] = []
      const watched: Run = async (args) => (calls.push(args), docker(args))
      const file = envFile("failed.env", "A=1\n")
      await expect(go(watched, pglaunch({ stdout: STARTED }).run, file, more)).rejects.toThrow(
        words,
      )
      expect(calls.some((c) => c[0] === "rm")).toBe(false)
      expect(readFileSync(file, "utf8")).toBe("A=1\n")
    }
  })

  test("a .env that already names a database is kept, and nothing starts", async () => {
    const docker = fake()
    const bunx = pglaunch({ stdout: STARTED })
    const file = envFile("set.env", "POSTGRES_URL=postgres://postgres:pw@127.0.0.1:5999/postgres\n")
    const refused = await go(docker.run, bunx.run, file).then(
      () => "",
      (error: Error) => error.message,
    )
    expect(refused).toContain(
      ".env already names a database (POSTGRES_URL), so Playground uses it on its next start",
    )
    expect(refused).not.toContain("bun run dev")
    expect([docker.calls, bunx.calls]).toEqual([[], []])
    expect(readFileSync(file, "utf8")).toBe(
      "POSTGRES_URL=postgres://postgres:pw@127.0.0.1:5999/postgres\n",
    )
  })

  test("refuses the live dashboard's database by name off the live dashboard's branch", async () => {
    for (const branch of [null, "feat/a"]) {
      const docker = fake()
      await expect(
        go(docker.run, pglaunch().run, envFile("live.env"), {
          branch,
          name: LIVE.database,
        }),
      ).rejects.toThrow("the Playground you run every day")
      expect(docker.calls).toEqual([])
    }
  })

  test("starts the live dashboard's database on its own branch, a fresh install's first run, set to start again after a restart", async () => {
    const bunx = pglaunch({ stdout: STARTED.replace("playground-a-db", LIVE.database) })
    const docker = fake()
    const migrated: string[] = []
    const steps: string[] = []
    const url = await go(docker.run, bunx.run, envFile("live-fresh.env"), {
      branch: LIVE.branch,
      migrate: async (u) => void migrated.push(u),
      name: LIVE.database,
      onStep: (s) => steps.push(s),
    })
    expect(url).toBe(URL)
    expect(bunx.calls).toEqual([["--bun", PGLAUNCH, "-k", "-n", LIVE.database]])
    expect(docker.calls).toContainEqual([
      "update",
      "--restart",
      "unless-stopped",
      `${LIVE.database}-x9Kq`,
    ])
    expect(steps).toContain("Keeping Postgres running after a restart")
    expect(migrated).toEqual([URL])
  })

  test("a live dashboard's database Docker cannot set to restart stops setup with Docker's words", async () => {
    const docker = fake({ update: { code: 1, stderr: "no such container" } })
    const migrated: string[] = []
    await expect(
      go(
        docker.run,
        pglaunch({ stdout: STARTED.replace("playground-a-db", LIVE.database) }).run,
        envFile("live-policy.env"),
        {
          branch: LIVE.branch,
          migrate: async (u) => void migrated.push(u),
          name: LIVE.database,
        },
      ),
    ).rejects.toThrow("docker update --restart unless-stopped")
    expect(migrated).toEqual([])
  })

  // Docker can come up between the launcher's check and the click, and pglaunch reuses only a running container it named, so setup asks Docker itself before it starts one.
  test("on the live dashboard's branch, refuses while its database exists where pglaunch cannot reuse it, or when Docker cannot list them", async () => {
    for (const listed of [
      `other-db\trunning\n${LIVE.database}\trunning\n`,
      `${LIVE.database}-x9Kq\texited\n`,
    ]) {
      const docker = fake({ ps: { stdout: listed } })
      const bunx = pglaunch()
      await expect(
        go(docker.run, bunx.run, envFile("live-held.env"), {
          branch: LIVE.branch,
          name: LIVE.database,
        }),
      ).rejects.toThrow("holds the live dashboard's database")
      expect(docker.calls).toEqual([["info"], ["ps", "-a", "--format", "{{.Names}}\t{{.State}}"]])
      expect(bunx.calls).toEqual([])
    }
    const failed = pglaunch()
    await expect(
      go(fake({ ps: { code: 1 } }).run, failed.run, envFile("live-unlisted.env"), {
        branch: LIVE.branch,
        name: LIVE.database,
      }),
    ).rejects.toThrow("could not list")
    expect(failed.calls).toEqual([])
  })

  test("on the live dashboard's branch, Try again after a failed migrate reuses the running container it started", async () => {
    const file = envFile("live-retry.env")
    const started = STARTED.replace("playground-a-db", LIVE.database)
    await expect(
      go(fake().run, pglaunch({ stdout: started }).run, file, {
        branch: LIVE.branch,
        migrate: async () => {
          throw new Error("migrate failed")
        },
        name: LIVE.database,
      }),
    ).rejects.toThrow("migrate failed")
    const reused = RUNNING.replace("playground-a-db", LIVE.database)
    const bunx = pglaunch({ code: 1, stdout: reused })
    const migrated: string[] = []
    // Docker answers in the format asked for, so a list that reads names alone sees the running container too.
    const docker: Run = async (args) => ({
      code: 0,
      stderr: "",
      stdout:
        args[0] !== "ps"
          ? ""
          : `${LIVE.database}-Ab12${args.at(-1)?.includes("State") ? "\trunning" : ""}\n`,
    })
    const url = await go(docker, bunx.run, file, {
      branch: LIVE.branch,
      migrate: async (u) => void migrated.push(u),
      name: LIVE.database,
    })
    expect(url).toBe(URL)
    expect(bunx.calls).toEqual([["--bun", PGLAUNCH, "-k", "-n", LIVE.database]])
    expect(migrated).toEqual([URL])
  })
})

describe("startPgliteDatabase", () => {
  const LITE = "postgres://postgres@127.0.0.1:54200/postgres?prepare=false"

  test("starts the checkout's PGlite, proves it, migrates it and saves its URL, with no Docker", async () => {
    const file = envFile("pglite.env")
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
    const started: string[] = []
    const run = startPgliteDatabase({
      envFile: envFile("pglite-set.env", `POSTGRES_URL=${LITE}\n`),
      name: "playground-a-db",
      onStep: () => {},
      start: async (name) => (started.push(name), LITE),
    })
    await expect(run).rejects.toThrow("already names a database")
    expect(started).toEqual([])
  })
})

describe("setupName", () => {
  test("is the live dashboard's database on its branch, and the checkout's own anywhere else", () => {
    const root = "/home/me/dispatcher/.claude/worktrees/desk"
    expect(setupName(root, LIVE.branch, LIVE)).toBe(LIVE.database)
    expect(setupName(root, "feat/a", LIVE)).toBe("playground-desk-db")
    expect(setupName(root, null, LIVE)).toBe("playground-desk-db")
  })

  // pglaunch publishes on every interface and suffixes the name, so the container a fresh live checkout's setup starts must pass the exposure guard's first-run exception and still be the live dashboard's database to every other branch.
  test("the container pglaunch starts under it passes both the exposure guard and the live guard", () => {
    const started = `${setupName("/home/me/dispatcher/.claude/worktrees/desk", LIVE.branch, LIVE)}-x9Kq`
    const run: Docker = (args) =>
      args[0] === "ps"
        ? "c1\n"
        : JSON.stringify([
            {
              Config: { Image: "postgres:17-alpine" },
              Id: "c1",
              Name: `/${started}`,
              NetworkSettings: {
                Ports: { "5432/tcp": [{ HostIp: "0.0.0.0", HostPort: "54123" }] },
              },
            },
          ])
    const { owner } = locate(URL, run)
    expect(owner.name).toBe(started)
    expect(othersLiveDashboard(owner.name, LIVE.branch, LIVE)).toBe(false)
    expect(othersLiveDashboard(owner.name, "feat/a", LIVE)).toBe(true)
  })
})
