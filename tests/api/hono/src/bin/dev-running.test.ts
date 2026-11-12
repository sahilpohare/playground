import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  commitRefusal,
  formatRecord,
  pgidOf,
  startOf,
} from "../../../../../api/hono/src/lib/dev/stop"

// pre-commit's dev-stack step, run as lefthook runs it, from the checkout's root.
const ROOT = join(import.meta.dir, "../../../../..")
const SCRIPT = "api/hono/src/bin/dev-running.ts"
const DIR = mkdtempSync(join(tmpdir(), "dev-running-"))

afterAll(() => rmSync(DIR, { force: true, recursive: true }))

const step = async (record: string) => {
  const proc = Bun.spawn(["bun", "--no-env-file", SCRIPT], {
    cwd: ROOT,
    env: { ...process.env, DEV_RECORD: record },
    stderr: "pipe",
    stdin: "ignore",
    stdout: "ignore",
    timeout: 20_000,
  })
  const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited])
  return { code, stderr }
}

describe("pre-commit's dev-stack step", () => {
  // a fresh worktree has no packages/*/dist, and the step runs before the build that makes them; safe-delete's bun export is its own source, which imports node: built-ins and config's kinds, whose name its tsconfig maps to config's source, so both load unbuilt
  test("imports no workspace package but safe-delete and config's kinds, which resolves to source", async () => {
    expect(
      Bun.resolveSync("@packages/config/kinds", join(ROOT, "packages/safe-delete/src/index.ts")),
    ).toBe(join(ROOT, "packages/config/src/kinds.ts"))
    const reached: string[] = []
    const built = await Bun.build({
      entrypoints: [join(ROOT, SCRIPT)],
      plugins: [
        {
          name: "workspace-packages",
          setup(build) {
            build.onResolve(
              { filter: /^@packages\/(?!safe-delete$|config\/kinds$)/ },
              ({ path }) => {
                reached.push(path)
                return { external: true, path }
              },
            )
          },
        },
      ],
      target: "bun",
    })
    expect(built.success).toBe(true)
    expect(reached).toEqual([])
  }, 30_000)

  test("lets the commit through when no stack is recorded", async () => {
    expect(await step(join(DIR, "none.pgid"))).toEqual({ code: 0, stderr: "" })
  }, 30_000)

  test("refuses while the recorded launcher runs from this checkout", async () => {
    const proc = Bun.spawn(["sleep", "60"], { cwd: ROOT, stdin: "ignore" })
    try {
      const record = join(DIR, "running.pgid")
      writeFileSync(
        record,
        formatRecord({
          pgid: pgidOf(proc.pid) ?? 0,
          pid: proc.pid,
          started: startOf(proc.pid) ?? "",
        }),
      )
      const { code, stderr } = await step(record)
      expect(code).toBe(1)
      expect(stderr).toContain(`launcher pid ${proc.pid}`)
      expect(stderr).toContain("bun run dev:stop")
    } finally {
      proc.kill("SIGKILL")
      await proc.exited
    }
  }, 30_000)
})

// A fresh checkout has no .env, and the prebuild after this step builds packages that check one, so `bun run dev` failed there before its launcher could write it.
describe("bun run dev's first step on a fresh checkout", () => {
  const first = async (args: string[]) => {
    const root = mkdtempSync(join(DIR, "fresh-"))
    writeFileSync(join(root, ".env.example"), "BETTER_AUTH_SECRET=\nNODE_ENV=local\n")
    const proc = Bun.spawn(["bun", "--no-env-file", SCRIPT, ...args], {
      cwd: ROOT,
      env: { ...process.env, DEV_ENV_ROOT: root, DEV_RECORD: join(root, "none.pgid") },
      stderr: "pipe",
      stdin: "ignore",
      stdout: "ignore",
      timeout: 20_000,
    })
    const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited])
    return { code, env: join(root, ".env"), stderr }
  }

  test("writes .env from .env.example with a generated secret, before the prebuild runs", async () => {
    const { code, env, stderr } = await first(["start"])
    expect(code).toBe(0)
    expect(stderr).toBe(
      "dev: started .env from .env.example, with a generated BETTER_AUTH_SECRET\n",
    )
    expect(readFileSync(env, "utf8")).toMatch(/^BETTER_AUTH_SECRET=\S{40,}$/m)
    expect(statSync(env).mode & 0o777).toBe(0o600)
  }, 30_000)

  test("pre-commit's run of the same step writes nothing", async () => {
    const { code, env } = await first([])
    expect(code).toBe(0)
    expect(existsSync(env)).toBe(false)
  }, 30_000)
})

// A second start beside a running stack used to run the prebuild, whose build cleans the dist that stack imports, before the launcher's claim refused.
describe("bun run dev beside a running stack", () => {
  test("refuses before the launcher runs, by the running-stack check the dev script runs first", async () => {
    const proc = Bun.spawn(["sleep", "60"], { cwd: ROOT, stdin: "ignore" })
    try {
      const record = join(DIR, "second-start.pgid")
      writeFileSync(
        record,
        formatRecord({
          pgid: pgidOf(proc.pid) ?? 0,
          pid: proc.pid,
          started: startOf(proc.pid) ?? "",
        }),
      )
      // an exported NODE_ENV makes the launcher print `dev: ignoring …` before its claim, so its line shows whether the launcher ran
      const dev = Bun.spawn(["bun", "run", "dev"], {
        cwd: ROOT,
        env: { ...process.env, DEV_RECORD: record, NODE_ENV: "production" },
        killSignal: "SIGTERM",
        stderr: "pipe",
        stdin: "ignore",
        stdout: "ignore",
        timeout: 60_000,
      })
      const [stderr, code] = await Promise.all([new Response(dev.stderr).text(), dev.exited])
      expect(code).toBe(1)
      expect(stderr).toContain(
        `dev: refusing to start: a stack already runs in this checkout (launcher pid ${proc.pid}`,
      )
      expect(stderr).not.toContain("dev: ignoring")
      expect(stderr).not.toContain("building what")
    } finally {
      proc.kill("SIGKILL")
      await proc.exited
    }
  }, 90_000)
})

describe("commitRefusal", () => {
  test("points a running stack at dev:stop", () => {
    expect(commitRefusal({ gone: false, what: "launcher pid 4123, process group 4100" })).toContain(
      "`bun run dev:stop`",
    )
  })

  // dev:stop ends the task groups a gone launcher recorded, by the record
  test("sends what a gone launcher recorded to dev:stop", () => {
    const text = commitRefusal({
      byRecord: true,
      gone: true,
      what: "recorded groups still hold pid 4130 in this checkout",
    })
    expect(text).toContain("still hold pid 4130")
    expect(text).toContain("`bun run dev:stop` ends them by their record")
  })

  // what else a gone launcher left is no group dev:stop's record names, so the step does not offer it
  test("sends what else a gone launcher left to where it started, not to dev:stop", () => {
    const text = commitRefusal({
      gone: true,
      what: "launcher (pid 4123) has gone, but its process groups still hold pid 4130",
    })
    expect(text).toContain("still hold pid 4130")
    expect(text).toContain("report them to your lead")
    expect(text).not.toContain("dev:stop")
  })
})
