import { afterAll, describe, expect, test } from "bun:test"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { scratchEnv } from "../../../scratch-env"
import { SCRIPT as RUN_SLOT, machine as slotMachine } from "../run-slot-fake"

const root = join(import.meta.dir, "..", "..", "..", "..")
const script = await Bun.file(join(root, "scripts", "ops", "dashboard", "supervisor.sh")).text()
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "supervisor-urls-")))
afterAll(() => rmSync(scratch, { force: true, recursive: true }))

// This process's env with no PORTLESS* key, as install.test.ts's gitEnv drops them, so a test's portless reads only the folders it made.
const noPortless = () =>
  Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("PORTLESS")))

const fn = (name: string) => script.match(new RegExp(`^${name}\\(\\) \\{.*\\}$`, "m"))?.[0]

// A stand-in for bunx that answers `portless get <name>` from a file, as portless 0.15 names a URL from whatever proxy runs when it is asked; STATE in the file reads as the PORTLESS_STATE_DIR it was asked under.
const bunx = join(scratch, "bunx")
const answer = join(scratch, "answer")
await Bun.write(
  bunx,
  `#!/bin/sh\n[ "$1 $2" = "portless get" ] && sed "s/NAME/$3/; s|STATE|$PORTLESS_STATE_DIR|" "${answer}"\n`,
)
chmodSync(bunx, 0o755)

const run = (body: string, env: Record<string, string | undefined> = process.env) =>
  Bun.spawn(["bash", "-c", body], {
    env: {
      ...env,
      D: join(root, "scripts", "ops", "dashboard"),
      PATH: `${scratch}:${process.env.PATH}`,
    },
    stdout: "pipe",
  })

describe("the supervisor's roll holds", () => {
  const due = async (gap: string, idle: string, db = "up") =>
    Bun.spawn([
      "bash",
      "-c",
      `ROLL_GAP=1800 OWNER_IDLE=300\n${fn("roll_due")}\nroll_due "${gap}" "${idle}" "${db}"`,
    ]).exited

  test("roll once the gap has passed and the owner is idle, and hold while either is short", async () => {
    expect(await due("1800", "300")).toBe(0)
    expect(await due("1799", "9999")).toBe(1)
    expect(await due("9999", "299")).toBe(1)
    expect(await due("1800", "300", "down")).toBe(0)
  })

  test("roll after the gap alone when the owner's idle cannot be read while the dashboard's Postgres runs (#1253)", async () => {
    expect(await due("1800", "")).toBe(0)
    expect(await due("1799", "")).toBe(1)
  })

  test("hold when the idle cannot be read because the dashboard's Postgres is down, since the roll would fail its database proof", async () => {
    expect(await due("9999", "", "down")).toBe(1)
  })

  test("are the loop's own test, its unread roll logged without a result line, so ops-dashboard keeps reading ok", () => {
    expect(script).toContain('[ -n "$idle" ] || db=$(dashboard_db)')
    expect(script).toContain('if roll_due "$gap" "$idle" "$db"; then')
    expect(script).toContain('[ -n "$idle" ] || say "owner idle unread')
  })
})

// A stand-in for docker running one container, named other than playground-dashboard-db, that publishes port 55432 on loopback; its exec records its arguments and answers 42.
const dashboardDb = join(scratch, "dashboard-db")
const docker = join(dashboardDb, "bin", "docker")
const execs = join(dashboardDb, "execs")
const checkout = join(dashboardDb, "checkout")
await Bun.write(
  docker,
  `#!/bin/sh\ncase "$1" in\n  ps) echo c0ffee ;;\n  inspect) echo '[{"Id":"c0ffee","Name":"/playground-dispatcher-db","Config":{"Image":"postgres:alpine"},"NetworkSettings":{"Ports":{"5432/tcp":[{"HostIp":"127.0.0.1","HostPort":"55432"}]}}}]' ;;\n  exec) echo "$*" >> "${execs}"; echo 42 ;;\n  *) exit 9 ;;\nesac\n`,
)
chmodSync(docker, 0o755)
const { POSTGRES_URL: _, ...outside } = process.env

// Runs supervisor functions in a dashboard checkout whose .env names the port, as the supervisor runs them in its own; prints their output and the name handed to procs.sh.
const inDashboard = async (env: string, body: string) => {
  rmSync(execs, { force: true })
  rmSync(join(dashboardDb, "state"), { force: true, recursive: true })
  await Bun.write(join(checkout, ".env"), env)
  await Bun.write(join(dashboardDb, "state", "supervisor.log"), "")
  const proc = Bun.spawn(
    [
      "bash",
      "-c",
      `${fn("say")}\n${fn("dashboard_container")}\n${fn("quiet_for")}\n${fn("dashboard_db")}\n${body}`,
    ],
    {
      cwd: checkout,
      env: {
        ...outside,
        LOG: join(dashboardDb, "state", "supervisor.log"),
        PATH: `${join(dashboardDb, "bin")}:${process.env.PATH}`,
        S: join(dashboardDb, "state"),
        WT: root,
      },
      stdout: "pipe",
    },
  )
  const out = (await new Response(proc.stdout).text()).trim()
  const handed = await Bun.file(join(dashboardDb, "state", "dashboard-db"))
    .text()
    .catch(() => null)
  const ran = await Bun.file(execs)
    .text()
    .catch(() => "")
  const log = await Bun.file(join(dashboardDb, "state", "supervisor.log")).text()
  return { handed: handed?.trim(), log, out, ran }
}

const published = "POSTGRES_URL=postgres://postgres:pw@127.0.0.1:55432/postgres\n"

describe("the supervisor's dashboard database (#1335)", () => {
  test("is the container publishing POSTGRES_URL's port on loopback, whatever its name", async () => {
    const { handed, out, ran } = await inDashboard(published, "dashboard_db; quiet_for")
    expect(out).toBe("up\n42")
    expect(ran).toContain("exec playground-dispatcher-db psql -U postgres -tAc select coalesce(")
    expect(handed).toBe("playground-dispatcher-db")
  }, 15_000)

  test("reads as down, with no exec and an empty name for procs.sh, when no container publishes the port", async () => {
    const { handed, log, out, ran } = await inDashboard(
      "POSTGRES_URL=postgres://postgres:pw@127.0.0.1:55433/postgres\n",
      "dashboard_db; quiet_for",
    )
    expect(out).toBe("down")
    expect(ran).toBe("")
    expect(handed).toBe("")
    expect(log).toContain("no single running Docker container publishes port 55433")
  }, 15_000)

  test("reads as down when the dashboard checkout's .env names no POSTGRES_URL", async () => {
    const { handed, out, ran } = await inDashboard("NODE_ENV=local\n", "dashboard_db; quiet_for")
    expect(out).toBe("down")
    expect(ran).toBe("")
    expect(handed).toBe("")
  }, 15_000)

  test("logs the reason a lookup fails once, not on every tick, while it keeps failing", async () => {
    const { log } = await inDashboard(
      "POSTGRES_URL=postgres://postgres:pw@127.0.0.1:55433/postgres\n",
      "dashboard_db; dashboard_db; dashboard_db",
    )
    expect(log.match(/publishes port 55433/g)).toHaveLength(1)
  }, 15_000)

  test("is found again before every stop, so procs.sh drains the database the dashboard runs on now", () => {
    expect(script).toContain("stop_all() {\n  dashboard_container > /dev/null\n")
    expect(script).not.toContain("playground-dashboard-db")
  })
})

describe("the supervisor's dashboard URLs", () => {
  test("come from portless get, so the move to https on 443 needs no edit here", async () => {
    await Bun.write(answer, "https://desk.NAME.localhost\n")
    const proc = run(`${fn("dashboard_urls")}\ndashboard_urls && echo "$WEB $API"`)
    expect(await proc.exited).toBe(0)
    expect((await new Response(proc.stdout).text()).trim()).toBe(
      "https://desk.playground.localhost https://desk.api.playground.localhost",
    )
  })

  // on Linux no portless service runs on 443, so the stack's API starts the 1355 proxy in ~/.portless/fallback with TLS on, and an idle ~/.portless names http (#2299)
  test("are read from the folder portlessDir() picks, the 1355 fallback proxy's while only it serves", async () => {
    const home = join(scratch, "urls-home")
    const fallback = join(home, ".portless", "fallback")
    mkdirSync(fallback, { recursive: true })
    await Bun.write(join(home, ".portless", "routes.json"), "[]")
    await Bun.write(join(fallback, "proxy.pid"), String(process.pid))
    await Bun.write(answer, "STATE NAME\n")
    const env = noPortless()
    const proc = run(`${fn("dashboard_urls")}\ndashboard_urls && echo "$WEB|$API"`, {
      ...env,
      HOME: home,
    })
    expect(await proc.exited).toBe(0)
    expect((await new Response(proc.stdout).text()).trim()).toBe(
      `${fallback} playground|${fallback} api.playground`,
    )
  })

  test("are read again on every try while the dashboard comes up, so a proxy that starts with the stack is found", async () => {
    // portless's guess before its proxy runs: a port nothing answers on
    await Bun.write(answer, "http://127.0.0.1:1/NAME\n")
    const server = Bun.serve({ fetch: () => new Response("ok"), hostname: "127.0.0.1", port: 0 })
    const proc = run(
      `${fn("dashboard_urls")}\n${fn("wait_dashboard")}\nwait_dashboard && echo "$API"`,
    )
    try {
      setTimeout(() => Bun.write(answer, `http://127.0.0.1:${server.port}/NAME\n`), 1500)
      expect(await proc.exited).toBe(0)
      expect((await new Response(proc.stdout).text()).trim()).toBe(
        `http://127.0.0.1:${server.port}/api.playground`,
      )
    } finally {
      proc.kill()
      server.stop(true)
    }
  }, 15_000)

  test("are read before check_dev's first request and before each verify", () => {
    const check = script.slice(script.indexOf("check_dev() {"))
    expect(check.indexOf("wait_dashboard")).toBeGreaterThan(-1)
    expect(check.indexOf("wait_dashboard")).toBeLessThan(check.indexOf("$API"))
    const verify = script.slice(
      script.indexOf("verify_dashboard() {"),
      script.indexOf("check_dev() {"),
    )
    expect(verify.indexOf("dashboard_urls")).toBeGreaterThan(-1)
    expect(verify.indexOf("dashboard_urls")).toBeLessThan(verify.indexOf("$WEB"))
  })

  test("name no fixed proxy port", () => {
    expect(script).not.toMatch(/localhost:1355/)
  })
})

// A stand-in for bun whose dashboard-ingest status exits with the code in a file (status exits 0 while any importer holds the lock), sleeps past the wait, or sleeps past it in a child of its own, as a wedged docker under dashboard-ingest's spawnSync does.
const bin = join(scratch, "follower-bin")
const statusCode = join(scratch, "status-code")
const childPid = join(scratch, "child-pid")
await Bun.write(
  join(bin, "bun"),
  `#!/bin/sh\n[ "$1 $2" = "api/hono/src/bin/dashboard-ingest.ts status" ] || exit 9\ncode=$(cat "${statusCode}")\n[ "$code" = sleep ] && exec sleep 30\n[ "$code" = child ] && { sleep 30 & echo $! > "${childPid}"; wait; }\nexit $code\n`,
)
chmodSync(join(bin, "bun"), 0o755)

const followerHeld = async (exit: string) => {
  await Bun.write(statusCode, exit)
  const proc = Bun.spawn(["bash", "-c", `set -m\n${fn("follower_held")}\nfollower_held`], {
    // HELD_WAIT sits at 5: past the load flake's 2, whose status answer took longer at load 20, under the 10s bounds the timeout cases assert
    env: { ...process.env, HELD_WAIT: "5", PATH: `${bin}:${process.env.PATH}` },
  })
  return proc.exited
}

describe("the supervisor's follower check", () => {
  test("reads a follower another importer holds as held, so the loop starts no second one (#1255)", async () => {
    expect(await followerHeld("0")).toBe(0)
    expect(await followerHeld("1")).toBe(1)
  })

  test("reads a status read that outlives its wait as holder unknown, and stops it, so a wedged database never freezes the loop", async () => {
    const started = Date.now()
    expect(await followerHeld("sleep")).toBe(2)
    expect(Date.now() - started).toBeLessThan(10_000)
  })

  test("stops the whole status read past its wait, a child it started included, so a wedged docker never piles up a process each tick", async () => {
    expect(await followerHeld("child")).toBe(2)
    const pid = Number(await Bun.file(childPid).text())
    const gone = async () => {
      for (let i = 0; i < 20; i++) {
        try {
          process.kill(pid, 0)
        } catch {
          return true
        }
        await Bun.sleep(100)
      }
      return false
    }
    expect(await gone()).toBe(true)
  })

  test("leaves a held follower running, named once, and restarts the follower only when its own process is gone and no importer holds the lock", () => {
    expect(script).toContain(
      "elif ! alive dashboard-ingest && { follower_held; held=$?; [ $held -ne 1 ]; }; then",
    )
    expect(script).toContain("gave no answer in ${HELD_WAIT:-20}s; not restarting it")
    expect(script).toContain('say "follower: another importer holds the lock')
    expect(script).toContain("  elif ! alive dashboard-ingest; then\n    held_said_f=")
    expect(script).toContain("  else\n    held_said_f=\n  fi\n")
  })
})

const block = (name: string) => {
  const at = script.indexOf(`\n${name}() {\n`) + 1
  return script.slice(at, script.indexOf("\n}\n", at) + 2)
}
const git = (cwd: string, ...args: string[]) =>
  Bun.spawnSync(
    ["git", "-c", "core.hooksPath=/dev/null", "-c", "user.name=t", "-c", "user.email=t@t", ...args],
    { cwd, stdout: "pipe" },
  )
    .stdout.toString()
    .trim()

// A dashboard checkout: c0, then c1 changes scripts/ops/dashboard/, then c2 changes only the README; a stand-in redeploy-pull.sh resets it, and fails for the sha pull-fails names, printing its other lines, or before its reset for the sha pull-stops names; for the sha pull-prints names it prints its other lines and succeeds
const wt = join(scratch, "wt")
const dashboardDir = join(wt, "scripts", "ops", "dashboard")
const state = join(scratch, "state")
const calls = join(scratch, "calls")
const pullFails = join(state, "pull-fails")
const pullPrints = join(state, "pull-prints")
const pullStops = join(state, "pull-stops")
await Bun.write(
  join(dashboardDir, "redeploy-pull.sh"),
  `#!/bin/sh\nif [ "$1" = "$(cat ${pullStops} 2>/dev/null)" ]; then exit 128; fi\ngit reset -q --hard "$1"\nif [ "$1" = "$(head -1 ${pullPrints} 2>/dev/null)" ]; then sed 1d ${pullPrints}; fi\nif [ "$1" = "$(head -1 ${pullFails} 2>/dev/null)" ]; then sed 1d ${pullFails}; exit 1; fi\n`,
)
await Bun.write(join(dashboardDir, "procs.sh"), "#!/bin/sh\n")
await Bun.write(
  join(dashboardDir, "net-git.sh"),
  Bun.file(join(root, "scripts", "ops", "dashboard", "net-git.sh")),
)
chmodSync(join(dashboardDir, "net-git.sh"), 0o755)
await Bun.write(join(dashboardDir, "x"), "0\n")
await Bun.write(join(state, ".keep"), "")
await Bun.write(join(scratch, "ops", "notify.sh"), "#!/bin/sh\n")
chmodSync(join(dashboardDir, "redeploy-pull.sh"), 0o755)
chmodSync(join(dashboardDir, "procs.sh"), 0o755)
chmodSync(join(scratch, "ops", "notify.sh"), 0o755)
git(wt, "init", "-q")
git(wt, "add", ".")
git(wt, "commit", "-qm", "c0")
const c0 = git(wt, "rev-parse", "HEAD")
await Bun.write(join(dashboardDir, "x"), "1\n")
git(wt, "commit", "-qam", "c1")
const c1 = git(wt, "rev-parse", "HEAD")
await Bun.write(join(wt, "README"), "r\n")
git(wt, "add", "README")
git(wt, "commit", "-qm", "c2")
const c2 = git(wt, "rev-parse", "HEAD")
// c3 adds a migration, so a roll to it keeps today's build after the stop
await Bun.write(join(wt, "packages", "db", "drizzle", "0001_x.sql"), "create table x (id int);\n")
git(wt, "add", "packages")
git(wt, "commit", "-qm", "c3")
const c3 = git(wt, "rev-parse", "HEAD")

// roll_up passes START and FALLBACK and fails every roll, so finish_roll falls back; result records each line results.log would get
const stubs = `S=${state} WT=${wt} OPS=${scratch}/ops BAD=${state}/bad-builds LOG=${state}/supervisor.log DEVLOG=${state}/dev.log
say() { :; }; result() { echo "result $*" >> ${calls}; }; stop_all() { :; }; tell_dispatcher() { echo "tell $1" >> ${calls}; }
prebuild() { :; }
roll_up() { echo "roll_up $1" >> ${calls}; [ "$1" = START ] || [ "$1" = FALLBACK ]; }
UPSTREAM=canary
${fn("upstream_head")}
${fn("behind")}
${block("dev_reason")}
${block("reload_if")}
${fn("take_reload")}
${block("pull_to")}
${block("finish_roll")}
${block("fall_back")}
${block("boot")}
${block("roll_to")}
`
const sup = async (body: string, at: string, d = dashboardDir) => {
  git(wt, "reset", "-q", "--hard", at)
  const proc = Bun.spawn(["bash", "-c", `D=${d}\n${stubs}\n${body}`], { cwd: wt, stdout: "pipe" })
  const code = await proc.exited
  return { code, out: (await new Response(proc.stdout).text()).trim() }
}
const reloadFile = () => Bun.file(join(state, "reload"))
const origin = join(scratch, "origin.git")
const canaryAt = (sha: string) => {
  Bun.spawnSync(["git", "init", "-q", "--bare", origin])
  git(wt, "remote", "add", "origin", origin)
  git(wt, "push", "-q", "-f", origin, `${sha}:refs/heads/canary`)
}
const clean = () => rmSync(join(state, "reload"), { force: true })

describe("the supervisor's reload (#1330)", () => {
  test("goes on as today when the roll left scripts/ops/dashboard/ alone", async () => {
    clean()
    expect((await sup(`reload_if ${c1} "ROLL canary"`, c2)).code).toBe(0)
    expect(await reloadFile().exists()).toBe(false)
  })

  test("hands the roll on with 75 when the roll changed scripts/ops/dashboard/", async () => {
    clean()
    expect(
      (await sup(`reload_if ${c0} "ROLL canary (install )" ${c2} ${c0} migrate`, c2)).code,
    ).toBe(75)
    expect(await reloadFile().text()).toBe(`${c2}\nROLL canary (install )\n${c2}\n${c0}\nmigrate\n`)
  })

  test("hands on once from a copy outside the checkout, as ops-dashboard's first start from the main checkout does", async () => {
    clean()
    const outside = join(scratch, "main-copy")
    await Bun.write(join(outside, ".keep"), "")
    expect((await sup(`reload_if ${c2} START`, c2, outside)).code).toBe(75)
    expect(await reloadFile().text()).toBe(`${c2}\nSTART\n\n\n\n`)
  })

  test("reads the checkout's own copy through a symlink as itself, so it never reloads forever", async () => {
    clean()
    const link = join(scratch, "dashboard-link")
    symlinkSync(dashboardDir, link)
    expect((await sup(`reload_if ${c2} START`, c2, link)).code).toBe(0)
  })

  test("takes the handed-on roll once, and drops one written at another head", async () => {
    await Bun.write(join(state, "reload"), `${c2}\nROLL canary\n${c2}\n${c0}\n\n`)
    const taken = await sup(`take_reload && echo "$r_tag|$r_target|$r_prev|$r_mig"`, c2)
    expect(taken.out).toBe(`ROLL canary|${c2}|${c0}|`)
    expect(await reloadFile().exists()).toBe(false)
    await Bun.write(join(state, "reload"), `${c0}\nROLL canary\n${c2}\n${c0}\n\n`)
    expect((await sup("take_reload", c2)).code).toBe(1)
    expect(await reloadFile().exists()).toBe(false)
  })

  test("a failed roll lists its head in bad-builds, falls back and hands the fallback on; the next start stays on the head before", async () => {
    clean()
    rmSync(calls, { force: true })
    rmSync(join(state, "bad-builds"), { force: true })
    // the supervisor the roll reloaded into runs c1's code, fails, and falls back to c0, whose scripts/ops/dashboard/ differs
    expect((await sup(`finish_roll "ROLL canary" ${c1} ${c0} ""`, c1)).code).toBe(75)
    expect(await Bun.file(join(state, "bad-builds")).text()).toBe(`${c1}\n`)
    expect(git(wt, "rev-parse", "HEAD")).toBe(c0)
    expect(await reloadFile().text()).toBe(`${c0}\nFALLBACK\n${c1}\n${c0}\n\n`)
    // c0's supervisor goes on with the fallback, on c0
    const back = await sup(`boot; git rev-parse HEAD`, c0)
    expect(back.out).toBe(c0)
    expect(await Bun.file(calls).text()).toBe(
      `roll_up ROLL canary\nroll_up FALLBACK\ntell Dashboard roll to ${c1.slice(0, 7)} FAILED; fell back to ${c0.slice(0, 7)}\n`,
    )
  })

  test("a start from a copy outside the checkout hands a pending roll on again, untouched, rather than finishing it on the outside code", async () => {
    rmSync(calls, { force: true })
    const pending = `${c2}\nROLL canary\n${c2}\n${c0}\n\n`
    await Bun.write(join(state, "reload"), pending)
    const outside = join(scratch, "main-copy")
    await Bun.write(join(outside, ".keep"), "")
    expect((await sup("boot", c2, outside)).code).toBe(75)
    expect(await reloadFile().text()).toBe(pending)
    expect(await Bun.file(calls).exists()).toBe(false)
  })

  test("a start that takes a handed-on roll finishes it once, and leaves a roll that failed after a migration on its head with no fallback", async () => {
    rmSync(calls, { force: true })
    rmSync(join(state, "bad-builds"), { force: true })
    await Bun.write(join(state, "reload"), `${c2}\nROLL canary\n${c2}\n${c1}\n\n`)
    const passing = `roll_up() { echo "roll_up $1" >> ${calls}; }`
    expect(await sup(`${passing}; boot; git rev-parse HEAD`, c2)).toEqual({ code: 0, out: c2 })
    expect(await Bun.file(calls).text()).toBe("roll_up ROLL canary\n")
    expect(await reloadFile().exists()).toBe(false)
    rmSync(calls, { force: true })
    await Bun.write(join(state, "reload"), `${c2}\nROLL canary\n${c2}\n${c1}\nmigrate\n`)
    expect(await sup("boot; git rev-parse HEAD", c2)).toEqual({ code: 0, out: c2 })
    expect(await Bun.file(calls).text()).toBe(
      `roll_up ROLL canary\ntell Dashboard roll to ${c2.slice(0, 7)} FAILED after a migration; left on it for ops (see ops/dashboard/supervisor.log)\n`,
    )
    expect(await Bun.file(join(state, "bad-builds")).exists()).toBe(false)
    expect(await reloadFile().exists()).toBe(false)
  })

  test("a start with no handed-on roll keeps off canary's head while bad-builds lists it, as a supervisor from before #1330 does", async () => {
    clean()
    rmSync(calls, { force: true })
    await Bun.write(join(state, "bad-builds"), `${c1}\n`)
    canaryAt(c1)
    const started = await sup(`boot; git rev-parse HEAD`, c0)
    expect(started.out).toBe(c0)
    expect(await Bun.file(calls).text()).toBe("roll_up START\n")
  })

  test("a start whose upstream head is behind the running head holds there, with no pull and no bad-builds entry, as main behind a checkout rolled on canary", async () => {
    clean()
    rmSync(calls, { force: true })
    rmSync(join(state, "bad-builds"), { force: true })
    canaryAt(c1)
    const started = await sup(`say() { echo "say $*" >> ${calls}; }; boot; git rev-parse HEAD`, c2)
    expect(started.out).toBe(c2)
    expect(await Bun.file(calls).text()).toBe(
      `say canary ${c1.slice(0, 7)} is behind the running head ${c2.slice(0, 7)}; waiting\nroll_up START\n`,
    )
    expect(await Bun.file(join(state, "bad-builds")).exists()).toBe(false)
  })

  test("a roll from the loop hands on with 75 when it changed scripts/ops/dashboard/, before it starts the new head, and finishes in place when it did not", async () => {
    clean()
    rmSync(calls, { force: true })
    expect((await sup(`running=${c0}; roll_to ${c1} canary`, c0)).code).toBe(75)
    expect(await reloadFile().text()).toBe(`${c1}\nROLL canary\n${c1}\n${c0}\n\n`)
    expect(await Bun.file(calls).exists()).toBe(false)
    clean()
    const rolled = await sup(
      `roll_up() { echo "roll_up $1" >> ${calls}; }; running=${c1}; roll_to ${c2} canary; echo "$running"`,
      c1,
    )
    expect(rolled).toEqual({ code: 0, out: c2 })
    expect(await reloadFile().exists()).toBe(false)
    expect(await Bun.file(calls).text()).toBe("roll_up ROLL canary\n")
  })

  test("a roll whose pull fails skips starting the head, lists it in bad-builds and falls back (#1392)", async () => {
    clean()
    rmSync(calls, { force: true })
    rmSync(join(state, "bad-builds"), { force: true })
    await Bun.write(pullFails, `${c2}\nbuild\n`)
    const passing = `roll_up() { echo "roll_up $1" >> ${calls}; }`
    const rolled = await sup(`${passing}; running=${c1}; roll_to ${c2} canary; echo "$running"`, c1)
    rmSync(pullFails, { force: true })
    expect(rolled).toEqual({ code: 0, out: c1 })
    expect(await Bun.file(join(state, "bad-builds")).text()).toBe(`${c2}\n`)
    expect(await Bun.file(calls).text()).toBe(
      `result ROLL canary (build ) ${c2.slice(0, 7)} FAIL pull exited 1\nroll_up FALLBACK\ntell Dashboard roll to ${c2.slice(0, 7)} FAILED; fell back to ${c1.slice(0, 7)}\n`,
    )
  })

  test("a roll whose pull prints migrate hands it on as the reload's fifth line (#1366)", async () => {
    clean()
    rmSync(calls, { force: true })
    await Bun.write(pullPrints, `${c1}\nmigrate\n`)
    expect((await sup(`running=${c0}; roll_to ${c1} canary`, c0)).code).toBe(75)
    rmSync(pullPrints, { force: true })
    expect(await reloadFile().text()).toBe(`${c1}\nROLL canary (migrate )\n${c1}\n${c0}\nmigrate\n`)
  })

  test("a roll whose pull fails after a migration stays on its head and falls back to nothing (#1392)", async () => {
    clean()
    rmSync(calls, { force: true })
    rmSync(join(state, "bad-builds"), { force: true })
    await Bun.write(pullFails, `${c2}\nmigrate\n`)
    const passing = `roll_up() { echo "roll_up $1" >> ${calls}; }`
    const rolled = await sup(`${passing}; running=${c1}; roll_to ${c2} canary; echo "$running"`, c1)
    rmSync(pullFails, { force: true })
    expect(rolled).toEqual({ code: 0, out: c2 })
    expect(await Bun.file(join(state, "bad-builds")).exists()).toBe(false)
    expect(await Bun.file(calls).text()).toBe(
      `result ROLL canary (migrate ) ${c2.slice(0, 7)} FAIL pull exited 1\ntell Dashboard roll to ${c2.slice(0, 7)} FAILED after a migration; left on it for ops (see ops/dashboard/supervisor.log)\n`,
    )
  })

  test("a roll whose pull fails before its reset reports it, restarts the head it was on, and leaves bad-builds alone even when that restart fails, so the next roll tries again (#1392)", async () => {
    const anomaly = `result ANOMALY pull to ${c2.slice(0, 7)} failed before it moved (exit 128); staying on ${c1.slice(0, 7)}\n`
    for (const [roll, restart] of [
      [`roll_up() { echo "roll_up $1" >> ${calls}; }`, "passing"],
      [":", "failing"],
    ]) {
      clean()
      rmSync(calls, { force: true })
      rmSync(join(state, "bad-builds"), { force: true })
      await Bun.write(pullStops, c2)
      const rolled = await sup(`${roll}; running=${c1}; roll_to ${c2} canary; echo "$running"`, c1)
      rmSync(pullStops, { force: true })
      expect({ restart, ...rolled }).toEqual({ restart, code: 0, out: c1 })
      expect(await Bun.file(join(state, "bad-builds")).exists()).toBe(false)
      expect(await Bun.file(calls).text()).toBe(`${anomaly}roll_up RESTART\n`)
    }
  })

  test("a roll whose pull fails on a head that changed scripts/ops/dashboard/ falls back on the running code, with no reload (#1392)", async () => {
    clean()
    rmSync(calls, { force: true })
    rmSync(join(state, "bad-builds"), { force: true })
    await Bun.write(pullFails, `${c1}\nbuild\n`)
    const rolled = await sup(`running=${c0}; roll_to ${c1} canary; echo "$running"`, c0)
    rmSync(pullFails, { force: true })
    expect(rolled).toEqual({ code: 0, out: c0 })
    expect(await reloadFile().exists()).toBe(false)
    expect(await Bun.file(join(state, "bad-builds")).text()).toBe(`${c1}\n`)
    expect(await Bun.file(calls).text()).toBe(
      `result ROLL canary (build ) ${c1.slice(0, 7)} FAIL pull exited 1\nroll_up FALLBACK\ntell Dashboard roll to ${c1.slice(0, 7)} FAILED; fell back to ${c0.slice(0, 7)}\n`,
    )
  })

  test("a start that pulls canary's head lists it in bad-builds and falls back when the pull fails after its reset, and starts again when it fails before (#1392)", async () => {
    clean()
    rmSync(calls, { force: true })
    rmSync(join(state, "bad-builds"), { force: true })
    canaryAt(c2)
    await Bun.write(pullFails, `${c2}\nbuild\n`)
    const failed = await sup(`boot; git rev-parse HEAD`, c1)
    rmSync(pullFails, { force: true })
    expect(failed).toEqual({ code: 0, out: c1 })
    expect(await Bun.file(join(state, "bad-builds")).text()).toBe(`${c2}\n`)
    expect(await Bun.file(calls).text()).toBe(
      `result START ${c2.slice(0, 7)} FAIL pull exited 1\nroll_up FALLBACK\ntell Dashboard roll to ${c2.slice(0, 7)} FAILED; fell back to ${c1.slice(0, 7)}\n`,
    )
    rmSync(calls, { force: true })
    rmSync(join(state, "bad-builds"), { force: true })
    await Bun.write(pullStops, c2)
    const stopped = await sup(`boot; git rev-parse HEAD`, c1)
    rmSync(pullStops, { force: true })
    expect(stopped).toEqual({ code: 0, out: c1 })
    expect(await Bun.file(join(state, "bad-builds")).exists()).toBe(false)
    expect(await Bun.file(calls).text()).toBe(
      `result ANOMALY pull to ${c2.slice(0, 7)} failed before it moved (exit 128); staying on ${c1.slice(0, 7)}\nroll_up START\n`,
    )
  })

  test("boots once it is armed", () => {
    expect(script).toContain('say "supervisor armed at $(git rev-parse --short HEAD)"\nboot\n')
  })
})

// A roll that dev refused to start, its dev log as roll_up left it, fails over from c2 to c1; returns the rolled head and the files the roll touched
describe("the supervisor's refused roll (#1357)", () => {
  const devlog = join(state, "dev.log")
  const bad = join(state, "bad-builds")
  const refusedLog = join(state, "refused")
  const refusing = (reason: string) =>
    `$ bun run dev --ui stream\ndev: cmux would not answer this stack (Error: ERROR: Access denied)\ndev: refusing to start: ${reason}\nerror: script "dev" exited with code 1\n`
  const fresh = () => {
    clean()
    for (const path of [bad, calls, devlog, refusedLog]) rmSync(path, { force: true })
  }
  const roll = async (log: string, mig = "") => {
    rmSync(calls, { force: true })
    await Bun.write(devlog, log)
    const rolled = await sup(
      `finish_roll "ROLL canary" ${c2} ${c1} "${mig}"; git rev-parse HEAD`,
      c2,
    )
    const listed = await Bun.file(bad)
      .text()
      .catch(() => "")
    return { ...rolled, bad: listed, calls: await Bun.file(calls).text() }
  }
  const own = "the API's settings could not be read: BETTER_AUTH_SECRET is required"
  const sha = c2.slice(0, 7)

  test("falls back to the head before, with a result line of its own and a tell that says a refusal is no bad build", async () => {
    fresh()
    const rolled = await roll(refusing(own))
    expect(rolled.out).toBe(c1)
    expect(rolled.bad).toBe("")
    expect(rolled.calls).toBe(
      `roll_up ROLL canary\nresult ROLL canary ${sha} FAIL dev refusing: ${own} (refusal 1 of 3, no bad build)\nroll_up FALLBACK\ntell Dashboard roll to ${sha} refused to start, which is no bad build; fell back to ${c1.slice(0, 7)}\n`,
    )
  })

  test("lists the head in bad-builds on its third refusal, counted by head in the state folder, so a refusal the head causes stops retrying", async () => {
    fresh()
    await Bun.write(refusedLog, `${c1}\n${c1}\n`)
    expect((await roll(refusing(own))).bad).toBe("")
    expect((await roll(refusing(own))).bad).toBe("")
    const third = await roll(refusing(own))
    expect(third.bad).toBe(`${c2}\n`)
    expect(third.calls).toContain(
      `result ROLL canary ${sha} FAIL dev refusing: ${own} (refusal 3 of 3, so it joins bad-builds)\n`,
    )
    expect(third.calls).toContain(
      `tell Dashboard roll to ${sha} FAILED; fell back to ${c1.slice(0, 7)}\n`,
    )
  })

  test("never counts a refusal of the machine's or the checkout's, so a fourth roll after those still runs and none joins bad-builds", async () => {
    const machine = [
      "this process does not descend from a cmux terminal, so cmux would refuse the stack's API every read (turbo passes it no capability token)",
      "the database at 127.0.0.1:55432 did not answer: connect ECONNREFUSED",
      "a stack already runs in this checkout (pid 4242); stop it from the terminal or task that started it, or with `bun run dev:stop`",
      "another start claimed /x/.dev-record at the same moment; try again",
      "portless's proxy is not running, and starting it on port 443 needs sudo, which a stack cannot ask for",
    ]
    fresh()
    for (const reason of machine) {
      for (let i = 0; i < 4; i++) {
        const rolled = await roll(refusing(reason))
        expect({ reason, bad: rolled.bad, out: rolled.out }).toEqual({ reason, bad: "", out: c1 })
        expect(rolled.calls).toContain(
          `result ROLL canary ${sha} FAIL dev refusing: ${reason} (not the head's, no bad build)\n`,
        )
      }
    }
    expect(await Bun.file(refusedLog).exists()).toBe(false)
  })

  test("counts only the refusal whose message opens, in launch.ts, with the supervisor's counted prefix, so a rewording there goes red", async () => {
    const prefix = script.match(/grep -q "\^([^"]+)"; then/)?.[1]
    if (!prefix) throw new Error("finish_roll's counted refusal prefix is gone from supervisor.sh")
    expect(prefix).toBe("the API's settings could not be read")
    const launch = await Bun.file(
      join(root, "api", "hono", "src", "lib", "dev", "launch.ts"),
    ).text()
    expect(launch).toContain(`refuse(\`${prefix}: `)
  })

  test("leaves a refusal after a migration on its head for ops, with no fallback and nothing counted", async () => {
    fresh()
    const rolled = await roll(refusing(own), "migrate")
    expect(rolled.out).toBe(c2)
    expect(rolled.bad).toBe("")
    expect(rolled.calls).toBe(
      `roll_up ROLL canary\ntell Dashboard roll to ${sha} FAILED after a migration; left on it for ops (see ops/dashboard/supervisor.log)\n`,
    )
    expect(await Bun.file(refusedLog).exists()).toBe(false)
  })

  test("still lists a head in bad-builds when dev died of a port in use, an ERROR or a SyntaxError, or its pull failed over an old refusal", async () => {
    for (const line of [
      "@api/hono:dev: listen EADDRINUSE: address already in use 127.0.0.1:4000",
      "@web/next:dev: ERROR run failed",
      "@api/hono:dev: SyntaxError: Export named 'factoryRoleOf' not found",
    ]) {
      fresh()
      const rolled = await roll(
        `$ bun run dev --ui stream\n${line}\ndev: refusing to start: ${own}\n`,
      )
      expect({ line, bad: rolled.bad }).toEqual({ line, bad: `${c2}\n` })
      expect(rolled.calls).not.toContain("dev refusing")
    }
    fresh()
    await Bun.write(devlog, refusing(own))
    await Bun.write(pullFails, `${c2}\nbuild\n`)
    const pulled = await sup(`running=${c1}; roll_to ${c2} canary; echo "$running"`, c1)
    rmSync(pullFails, { force: true })
    expect(pulled.out).toBe(c1)
    expect(await Bun.file(bad).text()).toBe(`${c2}\n`)
  })
})

describe("the supervisor's dev=DOWN reason (#1393)", () => {
  const devlog = join(scratch, "dev.log")
  const reason = async (line: string, before = "") => {
    await Bun.write(
      devlog,
      `$ bun run dev --ui stream\n${before}@web/next:dev: ready\n${line}\nexit 1\n`,
    )
    const proc = Bun.spawn(
      [
        "bash",
        "-c",
        `DEVLOG=${devlog}\nwait_dashboard() { :; }; alive() { return 1; }\n${block("dev_reason")}\n${block("check_dev")}\ncheck_dev`,
      ],
      { stdout: "pipe" },
    )
    expect(await proc.exited).toBe(1)
    return (await new Response(proc.stdout).text()).trim()
  }

  test("names a SyntaxError, as a stale dist throws", async () => {
    const line = `@api/hono:dev: SyntaxError: Export named 'factoryRoleOf' not found in module '/Users/someone/code/dispatcher/.claude/worktrees/live-dashboard/packages/config/dist/kinds.mjs'.`
    expect(await reason(line)).toBe(`dev=DOWN (${line.slice(0, 140)})`)
  })

  test("passes over the launcher's own notes, as cmux's refusal that names an ERROR, to the line that stopped the stack", async () => {
    const note =
      "dev: cmux would not answer this stack (Error: ERROR: Access denied) and holds no live factory session, so the dashboard reads herdr alone\n"
    const line = "@api/hono:dev: SyntaxError: Export named 'factoryRoleOf' not found"
    expect(await reason(line, note)).toBe(`dev=DOWN (${line})`)
  })

  test("names a line holding error:", async () => {
    const line = "@api/hono:dev: error: Cannot find module '@packages/env'"
    expect(await reason(line)).toBe(`dev=DOWN (${line})`)
  })

  test("still names a refusal, a port in use and an ERROR line", async () => {
    for (const line of [
      "dev: refusing to start: another stack holds this checkout",
      "@api/hono:dev: listen EADDRINUSE: address already in use 127.0.0.1:4000",
      "@web/next:dev: ERROR run failed",
    ])
      expect(await reason(line)).toBe(`dev=DOWN (${line})`)
  })
})

// The loop's own DOWN dev line: the echoed bun command spent its cut before the refusal showed, so the reason never reached ops-dashboard.jsonl.
describe("the loop's DOWN dev reason (#1356)", () => {
  const devlog = join(scratch, "dev-down.log")
  const down = async (devlogBody: string) => {
    await Bun.write(devlog, devlogBody)
    const inner = script.match(/result "DOWN dev: \$\(([^\n]+)\)"/)?.[1]
    if (!inner) throw new Error("the loop's DOWN dev line is gone from supervisor.sh")
    const proc = Bun.spawn(
      [
        "bash",
        "-c",
        `DEVLOG=${devlog}\n${block("dev_reason")}\n${block("dev_down")}\ndown=$(${inner})\nprintf '%s' "$down"`,
      ],
      { stdout: "pipe" },
    )
    expect(await proc.exited).toBe(0)
    return await new Response(proc.stdout).text()
  }
  const echo =
    "$ bun --no-env-file api/hono/src/bin/dev-running.ts start && bun --no-env-file packages/scripts/src/verify/prebuild.ts api && bun --no-env-file api/hono/src/bin/dev.ts --ui stream"
  const bunLine = 'error: script "dev" exited with code 1'

  test("keeps the refusal whole, past the echoed command and bun's own exit line", async () => {
    const refusal =
      "dev: refusing to start: this process does not descend from a cmux terminal, so cmux would refuse the stack's API every read (turbo passes it)"
    expect(await down(`${echo}\n@web/next:dev: ready\n${refusal}\n${bunLine}\n`)).toBe(refusal)
  })

  test("names a crash that is no refusal, past bun's own exit line", async () => {
    const crash =
      "@api/hono:dev: TypeError: Cannot read properties of undefined (reading 'factoryRoleOf')"
    expect(await down(`${echo}\n${crash}\n${bunLine}\n`)).toBe(crash)
  })

  test("names nothing on an empty log", async () => {
    expect(await down("")).toBe("")
  })

  test("names nothing on a missing log", async () => {
    const proc = Bun.spawn(
      [
        "bash",
        "-c",
        `DEVLOG=${join(scratch, "absent-dev.log")}\n${block("dev_reason")}\n${block("dev_down")}\nprintf '%s' "$(dev_down)"`,
      ],
      { stdout: "pipe" },
    )
    expect(await proc.exited).toBe(0)
    expect(await new Response(proc.stdout).text()).toBe("")
  })
})

// verify_dashboard with stand-ins for bun and git, run in a checkout whose .env holds the given AGENT_SIGNIN_ENABLED line: the checks it runs, in order
const verifyChecks = async (signIn: string) => {
  const dir = join(scratch, `verify-${signIn || "blank"}`)
  const calls = join(dir, "calls")
  await Bun.write(join(dir, ".env"), `NODE_ENV=local\nAGENT_SIGNIN_ENABLED=${signIn}\n`)
  await Bun.write(join(dir, "bin", "bun"), `#!/bin/sh\necho "$3" >> ${calls}\n`)
  await Bun.write(join(dir, "bin", "git"), "#!/bin/sh\necho abc123\n")
  chmodSync(join(dir, "bin", "bun"), 0o755)
  chmodSync(join(dir, "bin", "git"), 0o755)
  const body = `dashboard_urls() { WEB=https://web.test API=https://api.test; }\n${block("verify_dashboard")}\nverify_dashboard`
  const proc = Bun.spawn(["bash", "-c", body], {
    cwd: dir,
    env: { ...process.env, PATH: `${join(dir, "bin")}:${process.env.PATH}` },
  })
  expect(await proc.exited).toBe(0)
  return (await Bun.file(calls).text()).trim().split("\n")
}

describe("the supervisor's verify", () => {
  test("leaves out the signed-in checks on a checkout with agent sign-in off, as a person's .env starts it", async () => {
    expect(await verifyChecks("")).toEqual(["health", "map"])
  })

  test("runs every check where agent sign-in is on", async () => {
    expect(await verifyChecks("true")).toEqual(["health", "signin", "ws", "system", "map"])
  })
})

// upstream_head as the supervisor runs it, in a clone of an origin whose main and canary hold different heads
describe("the supervisor's roll target", () => {
  test("is the head of the branch upstream.sh names on origin, never canary's alone", async () => {
    const origin = join(scratch, "roll-origin")
    git(scratch, "init", "-q", "-b", "main", origin)
    git(origin, "commit", "-q", "--allow-empty", "-m", "main")
    git(origin, "checkout", "-q", "-b", "canary")
    git(origin, "commit", "-q", "--allow-empty", "-m", "canary")
    const head = (ref: string) => git(origin, "rev-parse", ref)
    const clone = join(scratch, "roll-clone")
    git(scratch, "clone", "-q", origin, clone)
    expect(script).not.toContain("refs/heads/canary")
    for (const branch of ["main", "canary"]) {
      const proc = Bun.spawn(
        [
          "bash",
          "-c",
          `D=${join(root, "scripts", "ops", "dashboard")} LOG=${join(scratch, "roll.log")} UPSTREAM=${branch}\n${fn("upstream_head")}\nupstream_head`,
        ],
        {
          cwd: clone,
          stdout: "pipe",
        },
      )
      expect(await proc.exited).toBe(0)
      expect((await new Response(proc.stdout).text()).trim()).toBe(head(branch))
    }
  })

  test("is empty within the limit when git never answers, the line logged and the hung git stopped by its own process group", async () => {
    const dir = join(scratch, "hung-git")
    const pid = join(dir, "pid")
    await Bun.write(join(dir, "bin", "git"), `#!/bin/sh\necho $$ > ${pid}\nsleep 600\n`)
    chmodSync(join(dir, "bin", "git"), 0o755)
    const log = join(dir, "supervisor.log")
    const started = Date.now()
    const proc = Bun.spawn(
      [
        "bash",
        "-c",
        `D=${join(root, "scripts", "ops", "dashboard")} LOG=${log} UPSTREAM=main\n${fn("upstream_head")}\nupstream_head`,
      ],
      {
        env: {
          ...process.env,
          NET_GIT_LIMIT: "1",
          PATH: `${join(dir, "bin")}:${process.env.PATH}`,
        },
        stdout: "pipe",
      },
    )
    expect(await proc.exited).toBe(0)
    expect(Date.now() - started).toBeLessThan(10_000)
    expect((await new Response(proc.stdout).text()).trim()).toBe("")
    expect(await Bun.file(log).text()).toBe(
      "net-git: git ls-remote gave no answer in 1s, so it was stopped\n",
    )
    const stub = Number((await Bun.file(pid).text()).trim())
    expect(() => process.kill(stub, 0)).toThrow()
  }, 15_000)
})

// The production build: roll_up builds the head into $S/builds/<sha> once, serves that build, and a fallback serves the head before's kept build without building it again
const upto = (name: string) => {
  const at = script.indexOf(`\n${name}() {`) + 1
  return script.slice(at, script.indexOf("\n}\n", at) + 2)
}
const kept = join(scratch, "kept")
const keptCalls = join(kept, "calls")
const builds = join(kept, "builds")
const WEB = "https://playground.localhost"
const API = "https://api.playground.localhost"
// bun stands in for bun run build (writing next's standalone server and its static files, or failing for a head build-fails lists) and for the stack's start, recording which build it serves; check_dev waits for that start by its pid file and fails for a head verify-fails lists, never by a bare wait, which inside roll_up's $(check_dev) waits on a job that is not its child and looped without end on GitHub's runner
const keptStubs = `S=${kept} WT=${wt} OPS=${scratch}/ops BAD=${kept}/bad-builds LOG=${kept}/supervisor.log DEVLOG=${kept}/dev.log
say() { echo "say $*" >> ${keptCalls}; }; result() { echo "result $*" >> ${keptCalls}; }; stop_all() { :; }; tell_dispatcher() { :; }
dashboard_urls() { WEB=${WEB}; API=${API}; }
listed() { grep -qx "$(git rev-parse HEAD)" "${kept}/$1" 2>/dev/null; }
bun() {
  case "$1 $2" in
    "run build") echo "build $(git rev-parse --short HEAD)" >> ${keptCalls}
      echo "envs \${HONO_APP_URL:-} \${HONO_TRUSTED_ORIGINS:-} \${NEXT_PUBLIC_API_URL:-} \${NEXT_PUBLIC_APP_URL:-} \${NODE_ENV:-} \${SKIP_ENV_VALIDATION_SERVER:-}" >> ${keptCalls}
      listed build-fails && { echo "Error: next build failed"; return 1; }
      mkdir -p web/next/.next/standalone/web/next web/next/.next/static
      git rev-parse HEAD > web/next/.next/standalone/web/next/server.js ;;
    "run serve") echo "serve $(basename "\${PLAYGROUND_BUILD:-none}")" >> ${keptCalls} ;;
    "install --frozen-lockfile") echo "NODE_ENV=\${NODE_ENV:-} SKIP_ENV_VALIDATION=\${SKIP_ENV_VALIDATION:-}" >> ${kept}/installs
      ! listed install-fails ;;
    "run dev") echo "dev" >> ${keptCalls} ;;
    "build packages/scripts/src/portless.ts") echo "launcher $(git rev-parse --short HEAD)" > "\${4#--outfile=}" ;;
    "--no-env-file "*/trash-build.ts) echo "trash $(basename "$3")" >> ${keptCalls}; [ ! -e ${kept}/trash-refuses ] || return 1; mkdir -p ${kept}/trashed; mv "$3" ${kept}/trashed/ ;;
  esac
}
alive() { kill -0 "$(cat "$S/$1.pid" 2>/dev/null)" 2>/dev/null; }
web_up() { echo "web $1 $(echo "$2" | cut -c1-7)" >> ${keptCalls}
  grep -qx "$2" "${kept}/web-fails" 2>/dev/null && { web_why="the web exited"; return 1; }
  grep -qx "$2" "${kept}/web-silent" 2>/dev/null && { web_why="the web was still silent at 60s"; return 2; }
  local port=$(( $(cat "$S/ports" 2>/dev/null || echo 5000) + 1 )); echo $port > "$S/ports"; echo $port > "$S/$1.port"; echo $$ > "$S/$1.pid"; echo "$2" > "$S/$1.sha"; }
web_route() { echo "route $1" >> ${keptCalls}; [ ! -e "${kept}/route-refused" ] || { web_why="the web's route was refused"; return 2; }; }
web_stop() { [ ! -e "$S/$1.pid" ] || echo "web-stop $1 $(cut -c1-7 "$S/$1.sha" 2>/dev/null)" >> ${keptCalls}; rm -f "$S/$1.pid" "$S/$1.sha"; }
ROUTE_SETTLE=0
check_dev() { local p i; p=$(cat "$S/dashboard-dev.pid"); for i in $(seq 1 100); do kill -0 "$p" 2>/dev/null || break; sleep 0.05; done; listed verify-fails && { echo "verify=FAIL"; return 1; }; echo "verify=PASS"; }
start_follower() { :; }; check_follower() { echo "follower=running"; }; setup_pending() { return 1; }
${fn("behind")}
${fn("trash_build")}
${fn("set_aside")}
${block("dev_reason")}
${block("reload_if")}
${block("finish_roll")}
${block("fall_back")}
${upto("build_head")}
${upto("keep_builds")}
${upto("start_dev")}
${fn("serving_web")}
${fn("stop_web")}
${block("ensure_web")}
${block("swap_web")}
${upto("roll_up")}
`
const keptRun = async (body: string, at: string) => {
  git(wt, "reset", "-q", "--hard", at)
  const proc = Bun.spawn(["bash", "-c", `D=${dashboardDir}\n${keptStubs}\n${body}`], {
    cwd: wt,
    stdout: "pipe",
  })
  const code = await proc.exited
  return { code, out: (await new Response(proc.stdout).text()).trim() }
}
const keptLines = async (want: RegExp) =>
  (await Bun.file(keptCalls).exists())
    ? (await Bun.file(keptCalls).text()).split("\n").filter((line) => want.test(line))
    : []
const fresh = () => {
  rmSync(kept, { force: true, recursive: true })
  Bun.spawnSync(["mkdir", "-p", kept])
}
const short = (sha: string) => sha.slice(0, 7)

describe("the supervisor's production build", () => {
  test("a start builds the head into its own folder and serves that build, never dev", async () => {
    fresh()
    expect((await keptRun("roll_up START", c2)).code).toBe(0)
    expect(await keptLines(/^(build|serve|dev)/)).toEqual([`build ${short(c2)}`, `serve ${c2}`])
    expect(await Bun.file(join(builds, c2, "urls")).text()).toBe(`${WEB} ${API}\n`)
    expect(await Bun.file(join(builds, c2, "web", "web", "next", "server.js")).text()).toBe(
      `${c2}\n`,
    )
    expect(existsSync(join(builds, c2, "api"))).toBe(false)
    expect(await keptLines(/^result /)).toEqual([
      `result START ${short(c2)} PASS verify=PASS follower=running`,
    ])
  })

  test("a build keeps its head's own web launcher beside it, bundled into one file", async () => {
    fresh()
    expect((await keptRun("roll_up START", c2)).code).toBe(0)
    expect(await Bun.file(join(builds, c2, "launcher.js")).text()).toBe(`launcher ${short(c2)}\n`)
  })

  test("a build reads the Dashboard's URLs and needs no server secret, since a first run's .env holds none yet", async () => {
    fresh()
    expect((await keptRun("roll_up START", c2)).code).toBe(0)
    expect(await keptLines(/^envs /)).toEqual([`envs ${API} ${WEB} ${API} ${WEB} production true`])
  })

  test("a failed build fails the roll, lists the head in bad-builds and serves the head before's kept build, building nothing more", async () => {
    fresh()
    expect((await keptRun("roll_up START", c1)).code).toBe(0)
    await Bun.write(join(kept, "build-fails"), `${c2}\n`)
    rmSync(keptCalls)
    expect((await keptRun(`finish_roll "ROLL canary" ${c2} ${c1} ""`, c2)).code).toBe(0)
    expect(git(wt, "rev-parse", "HEAD")).toBe(c1)
    expect(await keptLines(/^(build|serve|dev)/)).toEqual([`build ${short(c2)}`, `serve ${c1}`])
    expect(await keptLines(/^result /)).toEqual([
      `result ROLL canary ${short(c2)} FAIL build: Error: next build failed`,
      `result FALLBACK ${short(c1)} PASS verify=PASS follower=running`,
    ])
    expect(await Bun.file(join(kept, "bad-builds")).text()).toBe(`${c2}\n`)
  })

  test("a verify that fails after a roll falls back to the head before's kept build without building it again", async () => {
    fresh()
    expect((await keptRun("roll_up START", c1)).code).toBe(0)
    await Bun.write(join(kept, "verify-fails"), `${c2}\n`)
    rmSync(keptCalls)
    expect((await keptRun(`finish_roll "ROLL canary" ${c2} ${c1} ""`, c2)).code).toBe(0)
    expect(await keptLines(/^(build|serve|dev)/)).toEqual([
      `build ${short(c2)}`,
      `serve ${c2}`,
      `serve ${c1}`,
    ])
    expect(await keptLines(/^result /)).toEqual([
      `result ROLL canary ${short(c2)} FAIL verify=FAIL follower=running`,
      `result FALLBACK ${short(c1)} PASS verify=PASS follower=running`,
    ])
  })

  test("a kept build made for other URLs is built again, with one line naming both, since next bakes them into its client", async () => {
    fresh()
    expect((await keptRun("roll_up START", c1)).code).toBe(0)
    await Bun.write(
      join(builds, c1, "urls"),
      "http://playground.localhost:1355 http://api.playground.localhost:1355\n",
    )
    rmSync(keptCalls)
    expect((await keptRun("roll_up START", c1)).code).toBe(0)
    expect(await keptLines(/^say rebuilding/)).toEqual([
      `say rebuilding ${short(c1)}: its build was for http://playground.localhost:1355 http://api.playground.localhost:1355, the Dashboard is now on ${WEB} ${API}`,
    ])
    expect(await keptLines(/^(build|serve)/)).toEqual([`build ${short(c1)}`, `serve ${c1}`])
    expect(await keptLines(/^trash /)).toEqual([
      expect.stringMatching(new RegExp(`^trash ${c1}\\.aside-\\d+$`)),
    ])
  })

  test("a rebuild whose old folder the trash refuses still serves, keeps the head out of bad-builds, and leaves the old folder aside for keep_builds", async () => {
    fresh()
    expect((await keptRun("roll_up START", c1)).code).toBe(0)
    await Bun.write(join(builds, c1, "urls"), "http://elsewhere http://elsewhere\n")
    await Bun.write(join(kept, "trash-refuses"), "")
    rmSync(keptCalls)
    expect((await keptRun("roll_up START", c1)).code).toBe(0)
    rmSync(join(kept, "trash-refuses"))
    expect(await keptLines(/^(build|serve)/)).toEqual([`build ${short(c1)}`, `serve ${c1}`])
    expect(await Bun.file(join(builds, c1, "urls")).text()).toBe(`${WEB} ${API}\n`)
    const aside = readdirSync(builds).filter((name) => name.startsWith(`${c1}.aside-`))
    expect(aside).toHaveLength(1)
    const bad = join(kept, "bad-builds")
    expect(existsSync(bad) ? readFileSync(bad, "utf8") : "").not.toContain(c1)
    expect((await keptRun(`keep_builds ${c1}`, c1)).code).toBe(0)
    expect(readdirSync(builds).filter((name) => name.startsWith(`${c1}.aside-`))).toEqual([])
  })

  test("a pass keeps its own build and the last one that passed before it, and moves the rest to the trash, a stray aside included", async () => {
    fresh()
    for (const name of ["a", "b", "c", "c.aside-1"])
      Bun.spawnSync(["mkdir", "-p", join(builds, name)])
    await Bun.write(join(builds, "passed"), "b\n")
    expect((await keptRun("keep_builds c", c2)).code).toBe(0)
    expect(Bun.spawnSync(["ls", builds]).stdout.toString().trim().split("\n")).toEqual([
      "b",
      "c",
      "passed",
    ])
    expect(await keptLines(/^trash /)).toEqual(["trash a", "trash c.aside-1"])
    expect(await Bun.file(join(builds, "passed")).text()).toBe("c\n")
  })
})

// A roll builds its target before it stops anything: prebuild builds the target from a detached staging worktree into $S/builds/<sha> while the old stack serves, and roll_up then finds that build kept
// a block the script may not hold yet, as none, so a red-first row reads the script before its change
const has = (name: string) => (script.includes(`\n${name}() {\n`) ? block(name) : "")
const prebuilt = `${keptStubs}
stop_all() { echo stop >> ${keptCalls}; }
${block("pull_to")}
${has("slot_step")}
${has("skip_roll")}
${block("prebuild")}
${block("roll_to")}
`
const prebuiltRun = async (body: string, at: string) => {
  git(wt, "reset", "-q", "--hard", at)
  git(wt, "worktree", "prune")
  const proc = Bun.spawn(["bash", "-c", `D=${dashboardDir}\n${prebuilt}\n${body}`], {
    cwd: wt,
    stdout: "pipe",
  })
  const code = await proc.exited
  return { code, out: (await new Response(proc.stdout).text()).trim() }
}
const worktrees = () => git(wt, "worktree", "list").split("\n").length

describe("the supervisor's build before the stop (#122)", () => {
  test("a roll builds its target from a staging worktree before it stops anything, then serves that build without building again", async () => {
    fresh()
    const rolled = await prebuiltRun(`running=${c1}; roll_to ${c2} canary; echo "$running"`, c1)
    expect(rolled).toEqual({ code: 0, out: c2 })
    expect(await keptLines(/^(build|stop|serve)/)).toEqual([
      `build ${short(c2)}`,
      "stop",
      `serve ${c2}`,
    ])
    expect(await keptLines(/^envs /)).toEqual([`envs ${API} ${WEB} ${API} ${WEB} production true`])
    expect(await keptLines(/^result /)).toEqual([
      `result ROLL canary ${short(c2)} PASS verify=PASS follower=running`,
    ])
    expect(existsSync(join(kept, "staging"))).toBe(false)
    expect(worktrees()).toBe(1)
  })

  test("the target's build keeps the target's own web launcher, bundled in the staging worktree while the checkout is still on the head before", async () => {
    fresh()
    const rolled = await prebuiltRun(`running=${c1}; roll_to ${c2} canary; echo "$running"`, c1)
    expect(rolled).toEqual({ code: 0, out: c2 })
    expect(await Bun.file(join(builds, c2, "launcher.js")).text()).toBe(`launcher ${short(c2)}\n`)
  })

  test("the staging install runs without the supervisor's NODE_ENV, so bun installs the dev dependencies the build needs", async () => {
    fresh()
    rmSync(join(kept, "installs"), { force: true })
    const rolled = await prebuiltRun(
      `export NODE_ENV=production SKIP_ENV_VALIDATION=true; running=${c1}; roll_to ${c2} canary; echo "$running"`,
      c1,
    )
    expect(rolled).toEqual({ code: 0, out: c2 })
    expect((await Bun.file(join(kept, "installs")).text()).split("\n")[0]).toBe(
      "NODE_ENV= SKIP_ENV_VALIDATION=",
    )
  })

  test("a failed build lists the target in bad-builds and stops nothing, the staging worktree removed", async () => {
    fresh()
    await Bun.write(join(kept, "build-fails"), `${c2}\n`)
    const rolled = await prebuiltRun(`running=${c1}; roll_to ${c2} canary; echo "$running"`, c1)
    expect(rolled).toEqual({ code: 0, out: c1 })
    expect(git(wt, "rev-parse", "HEAD")).toBe(c1)
    expect(await keptLines(/^(build|stop|serve)/)).toEqual([`build ${short(c2)}`])
    expect(await keptLines(/^result /)).toEqual([
      `result ROLL canary ${short(c2)} FAIL build before the stop: Error: next build failed; still serving ${short(c1)}`,
    ])
    expect(await Bun.file(join(kept, "bad-builds")).text()).toBe(`${c2}\n`)
    expect(existsSync(join(kept, "staging"))).toBe(false)
    expect(worktrees()).toBe(1)
  })

  test("a target that migrates skips the build before the stop and builds after it, as before", async () => {
    fresh()
    const rolled = await prebuiltRun(`running=${c2}; roll_to ${c3} canary; echo "$running"`, c2)
    expect(rolled).toEqual({ code: 0, out: c3 })
    expect(await keptLines(/^(build|stop|serve)/)).toEqual([
      "stop",
      `build ${short(c3)}`,
      `serve ${c3}`,
    ])
    expect(worktrees()).toBe(1)
  })

  test("an install that fails in the staging worktree is the machine's fault, so the roll builds after the stop and no bad-builds entry is made", async () => {
    fresh()
    await Bun.write(join(kept, "install-fails"), `${c2}\n`)
    const rolled = await prebuiltRun(`running=${c1}; roll_to ${c2} canary; echo "$running"`, c1)
    expect(rolled).toEqual({ code: 0, out: c2 })
    expect(await keptLines(/^(build|stop|serve)/)).toEqual([
      "stop",
      `build ${short(c2)}`,
      `serve ${c2}`,
    ])
    expect(await keptLines(/^say .*building after the stop/)).toEqual([
      `say the staging worktree's install for ${short(c2)} failed; building after the stop`,
    ])
    expect(existsSync(join(kept, "bad-builds"))).toBe(false)
    expect(existsSync(join(kept, "staging"))).toBe(false)
    expect(worktrees()).toBe(1)
  })

  test("a roll that reloads the supervisor finishes on the build made before the stop", async () => {
    fresh()
    clean()
    expect((await prebuiltRun(`running=${c0}; roll_to ${c1} canary`, c0)).code).toBe(75)
    expect(await keptLines(/^(build|stop)/)).toEqual([`build ${short(c1)}`, "stop"])
    expect(existsSync(join(kept, "staging"))).toBe(false)
    expect(worktrees()).toBe(1)
    expect((await keptRun(`finish_roll "ROLL canary" ${c1} ${c0} ""`, c1)).code).toBe(0)
    expect(await keptLines(/^(build|stop|serve)/)).toEqual([
      `build ${short(c1)}`,
      "stop",
      `serve ${c1}`,
    ])
    clean()
  })
})

// A roll's build before the stop queues in run-slot (#1099): a stand-in run-slot.sh logs each step it is given, refuses one with the exit slot-refuses names or holds one for the seconds slot-slow names (a TERM there logs and exits 143, as run-slot's trap does), then logs its start in runs.log and runs it, the clone as a plain folder; a sleep stands in for the serving stack, its pid the API's and the web's
const slotted = async () => {
  await Bun.write(
    join(kept, "stubs.sh"),
    `listed() { grep -qx "$(git rev-parse HEAD)" "${kept}/$1" 2>/dev/null; }
bun() {
  case "$1 $2" in
    "run build") echo "build $(git rev-parse --short HEAD)" >> ${keptCalls}
      echo "envs \${HONO_APP_URL:-} \${HONO_TRUSTED_ORIGINS:-} \${NEXT_PUBLIC_API_URL:-} \${NEXT_PUBLIC_APP_URL:-} \${NODE_ENV:-} \${SKIP_ENV_VALIDATION_SERVER:-}" >> ${keptCalls}
      listed build-fails && { echo "Error: next build failed"; return 1; }
      listed build-exits-2 && { echo "Error: next build failed"; return 2; }
      mkdir -p web/next/.next/standalone/web/next web/next/.next/static
      git rev-parse HEAD > web/next/.next/standalone/web/next/server.js ;;
    "install --frozen-lockfile") echo "NODE_ENV=\${NODE_ENV:-} SKIP_ENV_VALIDATION=\${SKIP_ENV_VALIDATION:-}" >> ${kept}/installs
      ! listed install-fails ;;
  esac
}
`,
  )
  await Bun.write(
    join(kept, "run-slot.sh"),
    `#!/bin/bash
echo "$(date -u +%FT%TZ) ask $1 $$ $*" >> ${kept}/runs.log
shift 2
case "$1 $2" in "cp "*) step=clone ;; "bun install") step=install ;; *) step=build ;; esac
echo "slot $*" >> ${keptCalls}
code=$(sed -n "s/^$step //p" ${kept}/slot-refuses 2>/dev/null)
[ -z "$code" ] || { echo "run-slot.sh: refusing the $step" >&2; exit "$code"; }
trap 'kill $! 2>/dev/null; echo "slot stopped $step" >> ${keptCalls}; exit 143' TERM
slow=$(sed -n "s/^$step //p" ${kept}/slot-slow 2>/dev/null)
[ -z "$slow" ] || { sleep "$slow" & wait $!; }
echo "$(date -u +%FT%TZ) start ops-dashboard $$ run-slot waited=7s" >> ${kept}/runs.log
[ "$step" != clone ] || { mkdir -p "\${@: -1}node_modules"; exit 0; }
. ${kept}/stubs.sh
"$@"
`,
  )
  chmodSync(join(kept, "run-slot.sh"), 0o755)
  await Bun.write(join(kept, "ops", "notify.sh"), `#!/bin/sh\necho "notify $*" >> ${keptCalls}\n`)
  chmodSync(join(kept, "ops", "notify.sh"), 0o755)
  Bun.spawnSync(["mkdir", "-p", join(wt, "node_modules")])
}
const slotRun = async (body: string, at: string) => {
  git(wt, "reset", "-q", "--hard", at)
  git(wt, "worktree", "prune")
  const proc = Bun.spawn(
    [
      "bash",
      "-c",
      `D=${dashboardDir}\n${prebuilt}\nOPS=${kept}/ops RS=${kept}/run-slot.sh RUNS=${kept}/runs.log PREBUILD_SLOW=1200 PREBUILD_POLL=0.2\nsleep 300 & stack=$!; echo $stack > ${kept}/dashboard-dev.pid; echo $stack > ${kept}/dashboard-web.pid\n${body}\nrc=$?; kill $stack 2>/dev/null; exit $rc`,
    ],
    { cwd: wt, stdout: "pipe" },
  )
  const code = await proc.exited
  rmSync(join(wt, "node_modules"), { force: true, recursive: true })
  return { code, out: (await new Response(proc.stdout).text()).trim() }
}
const stage = join(kept, "staging")
const cloneFlags = (system: string) => (system === "Darwin" ? "-cR" : "-R --reflink=auto")
const steps = [
  `slot cp ${cloneFlags(process.platform === "darwin" ? "Darwin" : "Linux")} node_modules ${stage}/`,
  "slot bun install --frozen-lockfile --ignore-scripts",
  "slot bun run build",
]

describe("the supervisor's build before the stop queues in run-slot (#1099)", () => {
  test("the clone, the install and the build each queue in run-slot as ops-dashboard, in that order, and nothing stops before the build returns", async () => {
    fresh()
    await slotted()
    const rolled = await slotRun(
      `export NODE_ENV=production SKIP_ENV_VALIDATION=true; running=${c1}; roll_to ${c2} canary; echo "$running"`,
      c1,
    )
    expect(rolled).toEqual({ code: 0, out: c2 })
    expect(await keptLines(/^(slot|build|stop|serve)/)).toEqual([
      ...steps,
      `build ${short(c2)}`,
      "stop",
      `serve ${c2}`,
    ])
    expect(await keptLines(/^envs /)).toEqual([`envs ${API} ${WEB} ${API} ${WEB} production true`])
    expect((await Bun.file(join(kept, "installs")).text()).split("\n")[0]).toBe(
      "NODE_ENV= SKIP_ENV_VALIDATION=",
    )
    expect(await keptLines(/^say prebuild /)).toEqual([
      "say prebuild clone queued 7s",
      "say prebuild install queued 7s",
      "say prebuild build queued 7s",
    ])
    expect(existsSync(stage)).toBe(false)
  })

  // GNU cp has no -c, so the macOS clone flag failed the clone on Linux (#2334); uname is a shell function here, which the prebuild's command substitution sees
  for (const system of ["Darwin", "Linux"]) {
    test(`on ${system} the clone runs cp ${cloneFlags(system)}`, async () => {
      fresh()
      await slotted()
      const rolled = await slotRun(
        `uname() { echo ${system}; }\nrunning=${c1}; roll_to ${c2} canary; echo "$running"`,
        c1,
      )
      expect(rolled).toEqual({ code: 0, out: c2 })
      expect((await keptLines(/^slot cp /))[0]).toBe(
        `slot cp ${cloneFlags(system)} node_modules ${stage}/`,
      )
    })
  }

  // the stand-in takes every argv, so the head's run-slot reads the lane each one takes, on a data folder of its own with no runs.log history to steer quick
  test("the head's run-slot sends the clone to the clone lane, the install to the quick lane and the build to the queue", async () => {
    const m = slotMachine()
    const kind = async (line: string) => {
      const p = Bun.spawn(
        ["bash", RUN_SLOT, "kind", "--", ...line.replace(/^slot /, "").split(" ")],
        {
          cwd: m.root,
          env: m.env(),
          stdout: "pipe",
        },
      )
      expect(await p.exited).toBe(0)
      return (await new Response(p.stdout).text()).trim()
    }
    expect([await kind(steps[0]), await kind(steps[1]), await kind(steps[2])]).toEqual([
      "clone",
      "quick",
      "",
    ])
  })

  test("a step queued past PREBUILD_SLOW logs once that it still waits, and keeps waiting rather than building bare", async () => {
    fresh()
    await slotted()
    await Bun.write(join(kept, "slot-slow"), "install 2\n")
    const rolled = await slotRun(
      `PREBUILD_SLOW=1; running=${c1}; roll_to ${c2} canary; echo "$running"`,
      c1,
    )
    expect(rolled).toEqual({ code: 0, out: c2 })
    expect(await keptLines(/^say prebuild install still queued/)).toEqual([
      expect.stringMatching(/^say prebuild install still queued after \d+s; it keeps waiting$/),
    ])
    expect(await keptLines(/^(slot|build|stop)/)).toEqual([...steps, `build ${short(c2)}`, "stop"])
  })

  test("a stack that goes down while the clone queues stops the clone by its pid within a poll, and the roll is skipped, nothing stopped", async () => {
    fresh()
    await slotted()
    await Bun.write(join(kept, "slot-slow"), "clone 60\n")
    const t0 = Date.now()
    const rolled = await slotRun(
      `(sleep 1; kill $stack) & running=${c1}; roll_to ${c2} canary; echo "$running"`,
      c1,
    )
    expect(Date.now() - t0).toBeLessThan(15_000)
    expect(rolled).toEqual({ code: 0, out: c1 })
    expect(await keptLines(/^(slot|build|stop|serve)/)).toEqual([steps[0], "slot stopped clone"])
    expect(await keptLines(/^say roll to/)).toEqual([
      `say roll to ${short(c2)} skipped: the stack went down during prebuild's clone, so the supervisor stopped it; trying again at the next tick`,
    ])
    expect(existsSync(join(kept, "bad-builds"))).toBe(false)
    expect(existsSync(join(kept, "prebuild.pid"))).toBe(false)
    expect(existsSync(stage)).toBe(false)
  })

  // the clone waits as a job of the supervisor's own shell, in a group of its own that run.sh's group stop misses, so the supervisor's trap stops it by its recorded pid
  test("the supervisor's own stop stops a clone waiting in run-slot by its pid, then the stack, and builds nothing", async () => {
    fresh()
    await slotted()
    await Bun.write(join(kept, "slot-slow"), "clone 60\n")
    const trap = script.match(/^trap 'say "supervisor stopping".*$/m)?.[0]
    if (!trap) throw new Error("the supervisor's stop trap is gone from supervisor.sh")
    const rolled = await slotRun(
      `${trap}\nstop_all() { sleep 0.5; echo stop >> ${keptCalls}; kill $stack 2>/dev/null; }\n(sleep 1; kill -TERM $$) & running=${c1}; roll_to ${c2} canary`,
      c1,
    )
    expect(rolled.code).toBe(0)
    expect(await keptLines(/^(slot|build|stop|serve)/)).toEqual([
      steps[0],
      "slot stopped clone",
      "stop",
    ])
    expect(await keptLines(/^say supervisor stopping/)).toHaveLength(1)
  })

  test("a roll skipped for a stack that went down rolls on a later try once the stack serves again", async () => {
    fresh()
    await slotted()
    await Bun.write(join(kept, "slot-slow"), "clone 60\n")
    const rolled = await slotRun(
      `(sleep 1; kill $stack) & running=${c1}; roll_to ${c2} canary
rm ${kept}/slot-slow; sleep 300 & stack=$!; echo $stack > ${kept}/dashboard-dev.pid; echo $stack > ${kept}/dashboard-web.pid
roll_to ${c2} canary; echo "$running"`,
      c1,
    )
    expect(rolled).toEqual({ code: 0, out: c2 })
    expect(await keptLines(/^say roll to/)).toHaveLength(1)
    expect(await keptLines(/^(slot|build|stop|serve)/)).toEqual([
      steps[0],
      "slot stopped clone",
      ...steps,
      `build ${short(c2)}`,
      "stop",
      `serve ${c2}`,
    ])
  })

  test("the loop checks the stack right after a roll, in the same tick, so a skipped roll's dead stack restarts then", () => {
    const loop = script.slice(script.indexOf("\nwhile true; do\n"))
    const roll = loop.indexOf('roll_to "$target" "$why"; held_said=')
    const down = loop.indexOf("  if ! alive dashboard-dev; then")
    expect(roll).toBeGreaterThan(0)
    expect(down).toBeGreaterThan(roll)
    expect(loop.slice(roll, down)).not.toContain("sleep")
  })

  test("a step run-slot refuses skips the roll with one line naming its exit: nothing stops, no bad-builds entry, the staging worktree removed", async () => {
    fresh()
    await slotted()
    await Bun.write(join(kept, "slot-refuses"), "build 2\n")
    const rolled = await slotRun(`running=${c1}; roll_to ${c2} canary; echo "$running"`, c1)
    expect(rolled).toEqual({ code: 0, out: c1 })
    expect(git(wt, "rev-parse", "HEAD")).toBe(c1)
    expect(await keptLines(/^(slot|build|stop|serve)/)).toEqual(steps)
    expect(await keptLines(/^say roll to/)).toEqual([
      `say roll to ${short(c2)} skipped: run-slot exited 2 before prebuild's build ran; trying again at the next tick`,
    ])
    expect(await keptLines(/^(result|notify) /)).toEqual([])
    expect(existsSync(join(kept, "bad-builds"))).toBe(false)
    expect(existsSync(stage)).toBe(false)
    expect(worktrees()).toBe(1)
  })

  test("a clone whose wait run-slot stops at 143 skips the roll too, before the install", async () => {
    fresh()
    await slotted()
    await Bun.write(join(kept, "slot-refuses"), "clone 143\n")
    const rolled = await slotRun(`running=${c1}; roll_to ${c2} canary; echo "$running"`, c1)
    expect(rolled).toEqual({ code: 0, out: c1 })
    expect(await keptLines(/^(slot|build|stop)/)).toEqual([steps[0]])
    expect(await keptLines(/^say roll to/)).toEqual([
      `say roll to ${short(c2)} skipped: run-slot exited 143 before prebuild's clone ran; trying again at the next tick`,
    ])
    expect(existsSync(join(kept, "bad-builds"))).toBe(false)
  })

  test("the same target skipped 3 rolls in a row tells ops once, and a new target starts its count again", async () => {
    fresh()
    await slotted()
    await Bun.write(join(kept, "slot-refuses"), "install 2\n")
    const rolled = await slotRun(
      `running=${c1}; for i in 1 2 3 4; do roll_to ${c2} canary; done; roll_to ${c0} canary; echo "$running"`,
      c1,
    )
    expect(rolled).toEqual({ code: 0, out: c1 })
    expect(await keptLines(/^say roll to/)).toHaveLength(5)
    expect(await keptLines(/^notify /)).toEqual([
      `notify dashboard dashboard roll to ${short(c2)} skipped 3 times: run-slot exited 2 before prebuild's install ran`,
    ])
    expect(await Bun.file(join(kept, "skips")).text()).toBe(`${c0}\n`)
  })

  test("a build that fails after run-slot starts it is the head's own failure, so it joins bad-builds as before", async () => {
    fresh()
    await slotted()
    await Bun.write(join(kept, "build-fails"), `${c2}\n`)
    const rolled = await slotRun(`running=${c1}; roll_to ${c2} canary; echo "$running"`, c1)
    expect(rolled).toEqual({ code: 0, out: c1 })
    expect(await keptLines(/^result /)).toEqual([
      `result ROLL canary ${short(c2)} FAIL build before the stop: Error: next build failed; still serving ${short(c1)}`,
    ])
    expect(await Bun.file(join(kept, "bad-builds")).text()).toBe(`${c2}\n`)
    expect(await keptLines(/^say roll to/)).toEqual([])
  })

  test("a build that exits 2 after run-slot starts it is the head's own failure, not a skip, since its start line is there", async () => {
    fresh()
    await slotted()
    await Bun.write(join(kept, "build-exits-2"), `${c2}\n`)
    const rolled = await slotRun(`running=${c1}; roll_to ${c2} canary; echo "$running"`, c1)
    expect(rolled).toEqual({ code: 0, out: c1 })
    expect(await keptLines(/^result /)).toEqual([
      `result ROLL canary ${short(c2)} FAIL build before the stop: Error: next build failed; still serving ${short(c1)}`,
    ])
    expect(await Bun.file(join(kept, "bad-builds")).text()).toBe(`${c2}\n`)
    expect(await keptLines(/^say roll to/)).toEqual([])
  })

  test("an install that fails after run-slot starts it builds after the stop, as before", async () => {
    fresh()
    await slotted()
    await Bun.write(join(kept, "install-fails"), `${c2}\n`)
    const rolled = await slotRun(`running=${c1}; roll_to ${c2} canary; echo "$running"`, c1)
    expect(rolled).toEqual({ code: 0, out: c2 })
    expect(await keptLines(/^say .*building after the stop/)).toEqual([
      `say the staging worktree's install for ${short(c2)} failed; building after the stop`,
    ])
    expect(await keptLines(/^(build|stop|serve)/)).toEqual([
      "stop",
      `build ${short(c2)}`,
      `serve ${c2}`,
    ])
  })

  test("the build after the stop, a migrating target's, runs bare, since the dashboard is down then", async () => {
    fresh()
    await slotted()
    const rolled = await slotRun(`running=${c2}; roll_to ${c3} canary; echo "$running"`, c2)
    expect(rolled).toEqual({ code: 0, out: c3 })
    expect(await keptLines(/^(slot|build|stop|serve)/)).toEqual([
      "stop",
      `build ${short(c3)}`,
      `serve ${c3}`,
    ])
  })

  test("with no executable run-slot.sh in the data folder every step runs bare, as on a fork", async () => {
    fresh()
    await slotted()
    rmSync(join(wt, "node_modules"), { force: true, recursive: true })
    const rolled = await slotRun(
      `RS=${kept}/absent.sh; running=${c1}; roll_to ${c2} canary; echo "$running"`,
      c1,
    )
    expect(rolled).toEqual({ code: 0, out: c2 })
    expect(await keptLines(/^(slot|build|stop|serve)/)).toEqual([
      `build ${short(c2)}`,
      "stop",
      `serve ${c2}`,
    ])
  })
})

// A roll with no migration swaps the web with no gap: the target's web starts beside the serving one from the kept build, the route moves to it, and the old one stops before the API restarts alone
describe("the supervisor's web swap (#122)", () => {
  const WEBS = /^(build|web|route|stop|serve)/
  const started = (at: string) => `roll_up START > /dev/null; rm -f ${keptCalls}; running=${at}`

  test("a roll starts the target's web beside the serving one, moves the route, stops the old web, and only then stops the API", async () => {
    fresh()
    const rolled = await prebuiltRun(`${started(c1)}; roll_to ${c2} canary; echo "$running"`, c1)
    expect(rolled).toEqual({ code: 0, out: c2 })
    expect(await keptLines(WEBS)).toEqual([
      `build ${short(c2)}`,
      `web dashboard-web-next ${short(c2)}`,
      "route 5002",
      `web-stop dashboard-web ${short(c1)}`,
      "stop",
      "route 5002",
      `serve ${c2}`,
    ])
    expect(await keptLines(/^say web swapped/)).toEqual([
      `say web swapped to ${short(c2)} on :5002 with no stop`,
    ])
    expect(await Bun.file(join(kept, "dashboard-web.sha")).text()).toBe(`${c2}\n`)
    expect(existsSync(join(kept, "dashboard-web-next.pid"))).toBe(false)
  })

  test("a target that migrates stops the web with the rest before it moves, as before", async () => {
    fresh()
    const rolled = await prebuiltRun(`${started(c2)}; roll_to ${c3} canary; echo "$running"`, c2)
    expect(rolled).toEqual({ code: 0, out: c3 })
    expect(await keptLines(WEBS)).toEqual([
      "stop",
      `build ${short(c3)}`,
      `web-stop dashboard-web ${short(c2)}`,
      `web dashboard-web ${short(c3)}`,
      "route 5002",
      `serve ${c3}`,
    ])
  })

  test("a target's web that never answers leaves the old one serving until the stop, which then runs as before", async () => {
    fresh()
    await Bun.write(join(kept, "web-fails"), `${c2}\n`)
    await prebuiltRun(`${started(c1)}; roll_to ${c2} canary; echo "$running"`, c1)
    const lines = await keptLines(/^(web|stop|say web)/)
    expect(lines.slice(0, 4)).toEqual([
      `web dashboard-web-next ${short(c2)}`,
      `say web ${short(c2)} did not take over (the web exited); stopping both as before`,
      "stop",
      `web-stop dashboard-web ${short(c1)}`,
    ])
  })

  test("a web the head broke fails the roll as a bad build, and the fallback serves the head before's web", async () => {
    fresh()
    expect((await keptRun("roll_up START", c1)).code).toBe(0)
    await Bun.write(join(kept, "web-fails"), `${c2}\n`)
    rmSync(keptCalls)
    expect((await keptRun(`finish_roll "ROLL canary" ${c2} ${c1} ""`, c2)).code).toBe(0)
    expect(await keptLines(/^result /)).toEqual([
      `result ROLL canary ${short(c2)} FAIL web: the web exited`,
      `result FALLBACK ${short(c1)} PASS verify=PASS follower=running`,
    ])
    expect(await Bun.file(join(kept, "bad-builds")).text()).toBe(`${c2}\n`)
  })

  test("a web the machine kept from starting is a refusal, no bad build, so the head is tried again", async () => {
    fresh()
    expect((await keptRun("roll_up START", c1)).code).toBe(0)
    await Bun.write(join(kept, "web-silent"), `${c2}\n`)
    rmSync(keptCalls)
    expect((await keptRun(`finish_roll "ROLL canary" ${c2} ${c1} ""`, c2)).code).toBe(0)
    expect(await keptLines(/^result /)).toEqual([
      `result ROLL canary ${short(c2)} FAIL web: the web was still silent at 60s`,
      `result ROLL canary ${short(c2)} FAIL dev refusing: the web was still silent at 60s (not the head's, no bad build)`,
      `result FALLBACK ${short(c1)} PASS verify=PASS follower=running`,
    ])
    expect(existsSync(join(kept, "bad-builds"))).toBe(false)
  })

  test("a refused route keeps the old web serving, and the start that meets it is a refusal too", async () => {
    fresh()
    await prebuiltRun(
      `${started(c1)}; touch ${join(kept, "route-refused")}; roll_to ${c2} canary; echo "$running"`,
      c1,
    )
    expect(await keptLines(/^say web .*did not take over/)).toEqual([
      `say web ${short(c2)} did not take over (the web's route was refused); stopping both as before`,
    ])
    expect(existsSync(join(kept, "dashboard-web-next.pid"))).toBe(false)
    expect(existsSync(join(kept, "bad-builds"))).toBe(false)
  })

  test("the API serves alone, since the web runs on its own", () => {
    expect(script).toContain("bun run serve --filter=@api/hono --ui stream")
  })
})

// The real web_up and swap_web: a stand-in bun on PATH records the launcher the new web is exec'd through, and curl answers 200 at once
describe("the web a swap starts runs the target head's launcher", () => {
  const swapped = async (withLauncher: boolean) => {
    fresh()
    const bin = join(kept, "bin")
    const cwd = join(kept, "checkout")
    Bun.spawnSync(["mkdir", "-p", bin, join(cwd, "web", "next"), join(builds, c2)])
    await Bun.write(join(bin, "bun"), `#!/bin/sh\necho "launch $1" >> ${keptCalls}\n`)
    chmodSync(join(bin, "bun"), 0o755)
    if (withLauncher) await Bun.write(join(builds, c2, "launcher.js"), "")
    await Bun.write(join(kept, "dashboard-web.pid"), `${process.pid}\n`)
    const proc = Bun.spawn(
      [
        "bash",
        "-c",
        `D=${dashboardDir} S=${kept} LOG=${kept}/supervisor.log WEB=${WEB} ROUTE_SETTLE=0
say() { echo "say $*" >> ${keptCalls}; }; bun() { echo 5101; }; curl() { echo 200; }
alive() { [ "$1" = dashboard-web ]; }; web_route() { :; }; web_stop() { :; }
${upto("launcher")}
${upto("web_up")}
${block("swap_web")}
swap_web ${c2}`,
      ],
      { cwd, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, stdout: "pipe" },
    )
    expect(await proc.exited).toBe(0)
    for (let i = 0; i < 200 && (await keptLines(/^launch /)).length === 0; i++) await Bun.sleep(25)
    return keptLines(/^(launch|say the build)/)
  }

  test("through the launcher kept with the target's build", async () => {
    expect(await swapped(true)).toEqual([`launch ${join(builds, c2, "launcher.js")}`])
  })

  test("through the checkout's portless.ts, with a line saying why, for a build that keeps none", async () => {
    expect(await swapped(false)).toEqual([
      `say the build of ${short(c2)} keeps no launcher; its web starts through the checkout's portless.ts`,
      "launch ../../packages/scripts/src/portless.ts",
    ])
  })
})

// First run's setup writes POSTGRES_URL into the checkout's .env; until then the follower, which validates it at once, would exit on every tick (#31).
describe("the follower before first run's setup (#31)", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "supervisor-setup-")))
  afterAll(() => rmSync(dir, { force: true, recursive: true }))
  const calls = join(dir, "calls")
  const env = join(dir, ".env")
  const loop = script.slice(
    script.indexOf("  if ! alive dashboard-dev; then\n"),
    script.indexOf("\ndone\n", script.indexOf("  if ! alive dashboard-dev; then\n")),
  )
  const stubs = `WT=${dir} S=${dir}
say() { echo "say $*" >> ${calls}; }; result() { echo "result $*" >> ${calls}; }
start_dev() { :; }; check_dev() { echo dev=up; }; stop_all() { :; }; dev_down() { :; }
start_follower() { echo start_follower >> ${calls}; }; check_follower() { echo follower=running; }
follower_held() { return 1; }; alive() { [ "$1" = dashboard-dev ] || [ "$1" = dashboard-web ]; }; build_head() { :; }; keep_builds() { :; }; check_aliases() { :; }; check_proxy() { :; }
dashboard_urls() { :; }; ensure_web() { :; }
${fn("setup_pending") ?? ""}
${script.slice(script.indexOf("\nroll_up() {") + 1, script.indexOf("\n}\n", script.indexOf("\nroll_up() {")) + 2)}
`
  const sup = async (body: string, dotenv: string) => {
    rmSync(calls, { force: true })
    await Bun.write(env, dotenv)
    const { POSTGRES_URL: _, ...rest } = process.env
    const proc = Bun.spawn(["bash", "-c", `${stubs}\n${body}`], {
      cwd: wt,
      env: rest,
      stdout: "pipe",
    })
    expect(await proc.exited).toBe(0)
    return (
      await Bun.file(calls)
        .text()
        .catch(() => "")
    )
      .trim()
      .split("\n")
  }
  const URL_LINE = "POSTGRES_URL=postgresql://postgres:pw@127.0.0.1:1/playground\n"

  test("a roll leaves the follower stopped and passes, saying it waits, while the .env names no POSTGRES_URL", async () => {
    const lines = await sup("roll_up START", 'NODE_ENV=local\nPOSTGRES_URL=""\n')
    expect(lines).not.toContain("start_follower")
    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatch(/^say follower: waiting for first run's setup/)
    expect(lines[1]).toMatch(
      /^result START \w+ PASS dev=up follower=waiting for first run's setup$/,
    )
  })

  test("the loop waits with one line and no DOWN or FAIL, then starts the follower on the first tick after setup writes the URL", async () => {
    const lines = await sup(
      `for tick in 1 2 3 4; do\n[ $tick = 3 ] && echo "${URL_LINE.trim()}" >> ${env}\n[ $tick = 4 ] && alive() { :; }\n${loop}\ndone`,
      "NODE_ENV=local\n",
    )
    expect(lines.filter((line) => /DOWN|FAIL/.test(line))).toEqual([])
    expect(lines).toEqual([
      expect.stringMatching(/^say follower: waiting for first run's setup/),
      "say follower: first run's setup wrote POSTGRES_URL; starting it",
      "start_follower",
      "result START follower follower=running",
    ])
  })

  test("a web that died is a DOWN of its own, and the stack starts again", async () => {
    const lines = await sup(`alive() { [ "$1" != dashboard-web ]; }\n${loop}`, URL_LINE)
    expect(lines[0]).toMatch(/^result DOWN web: /)
    expect(lines.at(-1)).toMatch(/^result RESTART \w+ PASS dev=up follower=running$/)
  })

  test("with POSTGRES_URL set, a roll starts the follower as before", async () => {
    const lines = await sup("roll_up START", URL_LINE)
    expect(lines[0]).toBe("start_follower")
    expect(lines[1]).toMatch(/^result START \w+ PASS dev=up follower=running$/)
  })
})

// A route file of portless's shape in the test's own folder, never the real ~/.portless: each host and its port.
const routesDir = join(scratch, "portless")
const routesFile = join(routesDir, "routes.json")
const routes = (pairs: [string, number][]) =>
  Bun.write(
    routesFile,
    JSON.stringify(pairs.map(([hostname, port]) => ({ hostname, pid: 0, port }))),
  )
const LIVE_ROUTES: [string, number][] = [
  ["desk.playground.localhost", 4842],
  ["playground.localhost", 4842],
  ["desk.api.playground.localhost", 4843],
  ["api.playground.localhost", 4843],
]
describe("the supervisor's alias check", () => {
  const state = join(scratch, "alias-state")
  const ops = join(scratch, "alias-ops")
  const right = join(scratch, "right.json")
  // Runs check_aliases as the supervisor's loop does, in one shell, with a stand-in notify.sh; the route file starts with playground.localhost on the wrong port, and body says when it is put right. Returns the results and the alerts.
  const ticks = async (body: string, confirm: number) => {
    rmSync(state, { force: true, recursive: true })
    rmSync(join(ops, "sent"), { force: true })
    await Bun.write(join(ops, "notify.sh"), `#!/bin/sh\necho "$1 $2" >> "${join(ops, "sent")}"\n`)
    chmodSync(join(ops, "notify.sh"), 0o755)
    await Bun.write(join(state, "results.log"), "")
    await Bun.write(answer, "https://desk.NAME.localhost\n")
    await routes(LIVE_ROUTES)
    await Bun.write(right, Bun.file(routesFile))
    await routes(
      LIVE_ROUTES.map(([host, port]) => [host, host === "playground.localhost" ? 4851 : port]),
    )
    const proc = run(
      `D=${join(root, "scripts", "ops", "dashboard")} OPS=${ops} RESULTS=${join(state, "results.log")} LOG=${join(state, "supervisor.log")} ALIAS_CONFIRM=${confirm} FIX="cp ${right} ${routesFile}"\nexport PORTLESS_STATE_DIR=${routesDir}\n${fn("say")}\n${fn("result")}\n${fn("dashboard_urls")}\n${fn("read_aliases")}\n${fn("check_aliases")}\n${body}\ntrue`,
    )
    expect(await proc.exited).toBe(0)
    const results = (await Bun.file(join(state, "results.log")).text()).trim()
    const sent = await Bun.file(join(ops, "sent"))
      .text()
      .catch(() => "")
    return { results: results ? results.split("\n") : [], sent: sent.trim() }
  }

  test("writes one ALIAS FAIL result when an alias stays wrong, none while it stays so, an ALIAS PASS once it is right, and no alert of its own", async () => {
    const { results, sent } = await ticks(
      "check_aliases; check_aliases; $FIX; check_aliases; check_aliases",
      0,
    )
    expect(results).toHaveLength(2)
    expect(results[0]).toContain(
      "ALIAS FAIL playground.localhost points at port 4851, but the live stack's desk.playground.localhost is on 4842",
    )
    expect(results[1]).toContain(
      "ALIAS PASS playground.localhost and api.playground.localhost hold the live stack's ports 4842 and 4843",
    )
    // run.sh's notify_new alerts each new FAIL line, so the check sends none itself
    expect(sent).toBe("")
  })

  // on v0.0.18's roll the old launcher's web route went with its stop, so moveRoute left playground.localhost on the old web's port for about 3 s until the launcher's 2 s sync moved it, as that sync moves api.playground.localhost after the API restarts, so a check landing then alerted on a roll
  test("reads a mismatch again after ALIAS_CONFIRM seconds and stays quiet when the launcher's sync has put the alias right meanwhile", async () => {
    const { results, sent } = await ticks("(sleep 0.5; $FIX) & check_aliases; wait", 2)
    expect(results).toEqual([])
    expect(sent).toBe("")
  })

  test("reads a missing route file once, with no wait, and names it", async () => {
    const started = Date.now()
    const { results } = await ticks(`rm -f ${routesFile}; check_aliases`, 5)
    expect(Date.now() - started).toBeLessThan(4000)
    expect(results).toHaveLength(1)
    expect(results[0]).toContain(`ALIAS FAIL no route file at ${routesFile}`)
  })

  // on a first start web_route wrote the web's route into an idle ~/.portless 2 s before the stack's API started the 1355 proxy in ~/.portless/fallback, so the proxy never learned the web's names (#2300)
  test("writes a web route that landed before the proxy started into the folder the proxy serves, and passes once the launcher's sync gives it its alias", async () => {
    const home = join(scratch, "first-start-home")
    const own = join(home, ".portless")
    const fallback = join(own, "fallback")
    const live = join(scratch, "first-start-state")
    rmSync(home, { force: true, recursive: true })
    rmSync(live, { force: true, recursive: true })
    mkdirSync(fallback, { recursive: true })
    mkdirSync(live, { recursive: true })
    const route = (hostname: string, port: number, pid = process.pid) => ({ hostname, pid, port })
    await Bun.write(
      join(own, "routes.json"),
      JSON.stringify([route("desk.playground.localhost", 4842)]),
    )
    // a stand-in for the 1355 proxy's state: the test's own pid, and the API's route and alias its launcher wrote
    await Bun.write(join(fallback, "proxy.pid"), String(process.pid))
    await Bun.write(
      join(fallback, "routes.json"),
      JSON.stringify([
        route("desk.api.playground.localhost", 4843),
        route("api.playground.localhost", 4843, 0),
      ]),
    )
    await Bun.write(join(live, "dashboard-web.port"), "4842\n")
    await Bun.write(join(live, "results.log"), "")
    await Bun.write(answer, "https://desk.NAME.localhost\n")
    // the API launcher's 2 s alias sync, run every 300 ms on the fallback folder until the check ends
    const sync = `bun -e "const l = await import('${join(root, "api", "hono", "src", "lib", "dev", "launch.ts")}'); setInterval(() => l.syncAliases(l.dashboardAliasPairs('desk'), '${fallback}'), 300)" & SYNC=$!`
    const env = noPortless()
    const proc = Bun.spawn(
      [
        "bash",
        "-c",
        `D=${join(root, "scripts", "ops", "dashboard")} WT=${root} S=${live} RESULTS=${join(live, "results.log")} LOG=${join(live, "supervisor.log")} ALIAS_CONFIRM=3\n${fn("say")}\n${fn("result")}\n${fn("web_route")}\nalive() { [ "$1" = dashboard-web ]; }\n${fn("dashboard_urls")}\n${fn("read_aliases")}\n${fn("check_aliases")}\n${sync}\ncheck_aliases; kill $SYNC; read_aliases`,
      ],
      { env: { ...env, HOME: home, PATH: `${scratch}:${process.env.PATH}` }, stdout: "pipe" },
    )
    expect(await proc.exited).toBe(0)
    expect((await new Response(proc.stdout).text()).trim()).toBe(
      "playground.localhost and api.playground.localhost hold the live stack's ports 4842 and 4843",
    )
    expect(await Bun.file(join(live, "results.log")).text()).toBe("")
    expect(await Bun.file(join(live, "supervisor.log")).text()).toContain(
      `the web's route was missing (no route for desk.playground.localhost in ${join(fallback, "routes.json")}), so web_route wrote it again`,
    )
  }, 20_000)

  test("runs on every tick of the loop, and only reads the route file", async () => {
    const loop = script.slice(script.indexOf("while true; do"))
    expect(loop).toContain("check_aliases")
    const reader = await Bun.file(join(root, "scripts", "ops", "dashboard", "alias.ts")).text()
    expect(reader).not.toMatch(/Bun\.write|writeFile|\.kill\(|process\.kill|spawn/)
  })
})

// trash_build through the real trash-build.ts, on a HOME of the test's own: a folder in its builds folder goes to that HOME's trash under the dashboard-supervisor carve-out, and the staging folder beside it is refused, stays, and is named in the log and to the dispatcher's outbox
describe("trash_build", () => {
  const home = join(scratch, "trash-home")
  const state = join(home, ".playground", "ops", "dashboard")
  const trashRun = async (path: string) => {
    const proc = Bun.spawn(
      [
        "bash",
        "-c",
        `D=${join(root, "scripts", "ops", "dashboard")} LOG=${state}/supervisor.log\n${fn("say")}\n${fn("trash_build")}\ntrash_build "${path}" "a test"`,
      ],
      {
        env: scratchEnv(home, { PLAYGROUND_DATA_DIR: join(home, ".playground") }),
        stderr: "pipe",
        stdout: "pipe",
      },
    )
    return proc.exited
  }

  test("moves a build folder to the trash as dashboard-supervisor, and refuses the staging folder beside it", async () => {
    const build = join(state, "builds", "abc")
    const staging = join(state, "staging")
    for (const dir of [join(build, "web"), staging]) Bun.spawnSync(["mkdir", "-p", dir])
    await Bun.write(join(build, "urls"), "x\n")
    await Bun.write(join(staging, "file"), "x\n")
    expect(await trashRun(build)).toBe(0)
    expect(existsSync(build)).toBe(false)
    const trash = join(home, ".playground", "trash")
    const [batch] = Bun.spawnSync(["ls", trash]).stdout.toString().trim().split("\n")
    expect(batch).toMatch(/-dashboard-supervisor$/)
    expect(await Bun.file(join(trash, batch!, "1", "abc", "urls")).text()).toBe("x\n")
    expect(await Bun.file(join(trash, batch!, "manifest.jsonl")).text()).toContain(
      '"carveOut":"dashboard-supervisor"',
    )
    expect(await trashRun(staging)).toBe(1)
    expect(existsSync(join(staging, "file"))).toBe(true)
    expect(await Bun.file(join(state, "supervisor.log")).text()).toContain(
      `the trash refused ${staging}, so it stays`,
    )
    expect(
      await Bun.file(join(home, ".playground", "ops", "outbox", "ops-safe-delete.jsonl")).text(),
    ).toContain(`dashboard-supervisor: ${staging} is not directly in ${join(state, "builds")}`)
  }, 30_000)
})

describe("the supervisor's owner idle", () => {
  test("reads an Inbox answer's mtime in GNU stat's form or BSD's, so a fresh answer counts on Linux too", async () => {
    const asks = join(scratch, "asks")
    mkdirSync(asks, { recursive: true })
    const owner = script.match(/^owner_idle\(\) \{\n[\s\S]*?\n\}$/m)?.[0]
    expect(owner).toBeDefined()
    const proc = Bun.spawn(
      ["bash", "-c", `quiet_for() { echo 999999; }\n${owner}\ntouch "$ASKS/a.json"\nowner_idle`],
      { env: { ...process.env, ASKS: asks }, stdout: "pipe" },
    )
    const idle = (await new Response(proc.stdout).text()).trim()
    expect(idle).toMatch(/^\d+$/)
    expect(Number(idle)).toBeLessThan(60)
  })
})

// check_proxy as the loop runs it, each call a tick: the owner's address is up or down by the file `up`, and a stand-in portless in WT's node_modules records each start and, while `comes-back` exists, brings the address back; results and dispatcher alerts land in `calls`
describe("the supervisor's proxy check (#2380)", () => {
  const proxy = join(scratch, "proxy")
  const proxyWt = join(proxy, "wt")
  const fallback = join(proxy, ".portless", "fallback")
  const own = join(proxy, ".portless")
  const up = join(proxy, "up")
  const comesBack = join(proxy, "comes-back")
  const proxyCalls = join(proxy, "calls")
  mkdirSync(join(proxyWt, "node_modules", ".bin"), { recursive: true })
  mkdirSync(fallback, { recursive: true })
  const portless = join(proxyWt, "node_modules", ".bin", "portless")
  writeFileSync(
    portless,
    `#!/bin/sh\necho "start $* in $PORTLESS_STATE_DIR" >> ${proxyCalls}\n[ -e ${comesBack} ] && echo up > ${up}\nprintf '\\033[31mport 1355 is taken\\033[0m\\n'\n`,
    { mode: 0o755 },
  )

  const ticks = async (dir: string, body: string) => {
    rmSync(proxyCalls, { force: true })
    const proc = Bun.spawn(
      [
        "bash",
        "-c",
        `S=${proxy} WT=${proxyWt} PROXY_EVERY=0 PROXY_WAIT=1
result() { echo "result $*" >> ${proxyCalls}; }; tell_dispatcher() { echo "tell $1" >> ${proxyCalls}; }
owner_url() { PDIR=$([ "$(cat ${up})" = up ] && echo ${dir} || echo ${own}); OWNER=https://playground.localhost:1355; }
answers() { [ "$(cat ${up})" = up ]; }
${block("check_proxy")}
${body}`,
      ],
      { stdout: "pipe" },
    )
    await proc.exited
    return (
      await Bun.file(proxyCalls)
        .text()
        .catch(() => "")
    )
      .trim()
      .split("\n")
      .filter(Boolean)
  }
  const down =
    "DOWN proxy: https://playground.localhost:1355 answered nothing at 2 checks 0 s apart"

  test("starts the fallback proxy once on its address's port after two misses, and tells the dispatcher once", async () => {
    await Bun.write(comesBack, "")
    const calls = await ticks(
      fallback,
      `echo up > ${up}; check_proxy; echo down > ${up}; check_proxy; check_proxy; check_proxy; check_proxy`,
    )
    expect(calls).toEqual([
      `result ${down}`,
      `tell ${down}; starting it again on 1355`,
      `start proxy start -p 1355 --skip-trust in ${fallback}`,
      "result RESTART proxy PASS on 1355: https://playground.localhost:1355 answers",
    ])
  })

  test("tells the dispatcher a second time when the start fails, then nothing more until the address answers", async () => {
    rmSync(comesBack, { force: true })
    const calls = await ticks(
      fallback,
      `echo up > ${up}; check_proxy; echo down > ${up}; for i in 1 2 3 4 5 6; do check_proxy; done; echo up > ${up}; check_proxy; check_proxy`,
    )
    expect(calls).toEqual([
      `result ${down}`,
      `tell ${down}; starting it again on 1355`,
      `start proxy start -p 1355 --skip-trust in ${fallback}`,
      "result RESTART proxy FAIL on 1355: port 1355 is taken",
      "tell The Dashboard's proxy did not come back on 1355: port 1355 is taken (ops/dashboard/proxy-start.log)",
      "result UP proxy PASS https://playground.localhost:1355 answers again",
    ])
  })

  test("leaves a service's proxy to the owner: it alerts once and starts nothing", async () => {
    await Bun.write(comesBack, "")
    const calls = await ticks(
      own,
      `echo up > ${up}; check_proxy; echo down > ${up}; check_proxy; check_proxy; check_proxy`,
    )
    expect(calls).toEqual([
      `result ${down}`,
      `tell ${down}; not restarting it, since a service owns the proxy in ${own}`,
    ])
  })

  test("starts nothing when the supervisor never saw the address answer, since nothing names its port", async () => {
    await Bun.write(comesBack, "")
    const calls = await ticks(fallback, `echo down > ${up}; check_proxy; check_proxy; check_proxy`)
    const unseen = "DOWN proxy: the Dashboard address answered nothing at 2 checks 0 s apart"
    expect(calls).toEqual([
      `result ${unseen}`,
      `tell ${unseen}; not restarting it, since this supervisor never saw it answer and nothing names its port`,
    ])
  })

  test("holds the aliases while the proxy misses, and checks no more often than PROXY_EVERY", async () => {
    expect(script).toContain("  check_proxy && check_aliases\ndone")
    const calls = await ticks(
      fallback,
      `echo up > ${up}; PROXY_EVERY=60; check_proxy; echo down > ${up}; check_proxy && echo not-due >> ${proxyCalls}; PROXY_EVERY=0; check_proxy || echo missed >> ${proxyCalls}; PROXY_EVERY=60; check_proxy || echo held >> ${proxyCalls}`,
    )
    expect(calls).toEqual(["not-due", "missed", "held"])
  })

  test("counts any HTTP answer, a 502 included, as the proxy up, and a refused connection as a miss", async () => {
    const server = Bun.serve({
      fetch: () => new Response("bad gateway", { status: 502 }),
      hostname: "127.0.0.1",
      port: 0,
    })
    try {
      const proc = Bun.spawn(
        [
          "bash",
          "-c",
          `${fn("answers")}\nanswers http://127.0.0.1:${server.port}/ ${proxy}; echo "a=$?"; answers http://127.0.0.1:1/ ${proxy}; echo "b=$?"`,
        ],
        { stdout: "pipe" },
      )
      const out = (await new Response(proc.stdout).text()).trim().split("\n")
      expect(out[0]).toBe("a=0")
      expect(out[1]).not.toBe("b=0")
    } finally {
      server.stop(true)
    }
  })
})

// An install made before the loopback rule: the roll moves its database onto loopback before the API starts, and the follower's guard refusal of a database's publish is the machine's, never a bad build.
describe("the supervisor's database move", () => {
  test("moves the database before the API starts, and only once first run's setup has written it", () => {
    expect(script).toContain("\n  setup_pending || move_database\n  start_dev; dev=$(check_dev)")
  })

  test("leaves a database on loopback alone: nothing printed, logged or written", async () => {
    const { log, out, ran } = await inDashboard(
      published,
      `${fn("move_database")}\nmoved_note=; move_failure=; move_database; echo "note=$moved_note failure=$move_failure"`,
    )
    expect(out).toBe("note= failure=")
    expect(log).toBe("")
    expect(ran).toBe("")
  }, 15_000)

  test("reports a move that cannot run with its reason and no password", async () => {
    const exposed = join(scratch, "exposed-bin")
    await Bun.write(
      join(exposed, "docker"),
      `#!/bin/sh\ncase "$1" in\n  ps) echo c0ffee ;;\n  inspect) echo '[{"Id":"c0ffee","Name":"/playground-db-Ab12","Config":{"Image":"postgres:alpine"},"NetworkSettings":{"Ports":{"5432/tcp":[{"HostIp":"0.0.0.0","HostPort":"55432"}]}}}]' ;;\n  *) echo "$*" >> "${execs}"; exit 9 ;;\nesac\n`,
    )
    chmodSync(join(exposed, "docker"), 0o755)
    const { log, out, ran } = await inDashboard(
      published,
      `PATH=${exposed}:$PATH\n${fn("move_database")}\nmove_failure=; move_database; echo "failure=$move_failure"`,
    )
    expect(out).toBe(
      "failure=dashboard-db: playground-db-Ab12-old already exists, so playground-db-Ab12 cannot move aside; playground-db-Ab12 is untouched",
    )
    expect(log).toContain("database: dashboard-db: playground-db-Ab12-old already exists")
    expect(`${out}${log}`).not.toContain(":pw@")
    expect(ran).toBe("")
  }, 15_000)

  const inglog = join(state, "ingest.log")
  const reason = async (lines: string) => {
    await Bun.write(inglog, lines)
    const proc = Bun.spawn(
      ["bash", "-c", `INGLOG=${inglog}\n${fn("guard_reason")}\nguard_reason`],
      {
        stdout: "pipe",
      },
    )
    return (await new Response(proc.stdout).text()).trim()
  }

  test("reads the follower's guard refusal of the database's publish, and nothing else", async () => {
    expect(
      await reason(
        "x\nrefusing to write: playground-db publishes port 55432 beyond loopback (0.0.0.0); keep its data\n",
      ),
    ).toBe("refusing to write: playground-db publishes port 55432 beyond loopback")
    expect(
      await reason("refusing to write: no single running Docker container publishes port 55432\n"),
    ).toBe("refusing to write: no single running Docker container publishes port 55432")
    expect(await reason("TypeError: undefined is not a function\n")).toBe("")
    expect(await reason("refusing to write: the server at 127.0.0.1:1 is not x's Postgres\n")).toBe(
      "",
    )
  })

  const failing = (refusal: string) =>
    `roll_up() { echo "roll_up $1" >> ${calls}; [ "$1" = FALLBACK ] && return 0; guard_refusal="${refusal}"; return 1; }\nfinish_roll "ROLL canary" ${c2} ${c1} ""`

  test("keeps a head whose follower the guard refused out of bad-builds, naming the refusal", async () => {
    clean()
    for (const path of [calls, join(state, "bad-builds"), join(state, "dev.log")]) {
      rmSync(path, { force: true })
    }
    const refusal = "refusing to write: playground-db publishes port 55432 beyond loopback"
    await sup(failing(refusal), c2)
    expect(await Bun.file(join(state, "bad-builds")).exists()).toBe(false)
    expect(await Bun.file(calls).text()).toContain(
      `result ROLL canary ${c2.slice(0, 7)} FAIL dev refusing: ${refusal} (not the head's, no bad build)\n`,
    )
  })

  test("puts a failed move's reason first in the line playground update prints, and keeps the head out of bad-builds", async () => {
    clean()
    for (const path of [calls, join(state, "bad-builds"), join(state, "dev.log")]) {
      rmSync(path, { force: true })
    }
    const why =
      "dashboard-db: the move failed (docker run failed: no); playground-db is started again as it was"
    const refusal = "refusing to write: playground-db publishes port 55432 beyond loopback"
    await sup(
      `roll_up() { echo "roll_up $1" >> ${calls}; [ "$1" = FALLBACK ] && return 0; move_failure="${why}"; guard_refusal="${refusal}"; return 1; }\nfinish_roll "ROLL canary" ${c2} ${c1} ""`,
      c2,
    )
    expect(await Bun.file(join(state, "bad-builds")).exists()).toBe(false)
    expect(await Bun.file(calls).text()).toContain(
      `FAIL dev refusing: database move: ${why}; ${refusal} (not the head's, no bad build)\n`,
    )
  })

  test("names a move on the roll's PASS or FAIL line, which playground update prints", () => {
    expect(script).toContain('result "$tag $sha PASS $dev $fol${moved_note:+ $moved_note}"')
    expect(script).toContain(
      'result "$tag $sha FAIL $dev $fol${move_failure:+ database move: $move_failure}${moved_note:+ $moved_note}"',
    )
  })

  test("joins a move's lines with a semicolon, so the two read apart", async () => {
    const moving = join(scratch, "moving-bin")
    await Bun.write(
      join(moving, "bun"),
      `#!/bin/sh\nprintf 'Moved the database x onto 127.0.0.1:1 alone, keeping its data\\nx-old is stopped and kept; remove it with: docker rm -v x-old\\n'\n`,
    )
    chmodSync(join(moving, "bun"), 0o755)
    const proc = Bun.spawn(
      ["bash", "-c", `say() { :; }\n${fn("move_database")}\nmove_database; echo "$moved_note"`],
      { env: { ...process.env, PATH: `${moving}:${process.env.PATH}`, WT: root }, stdout: "pipe" },
    )
    expect((await new Response(proc.stdout).text()).trim()).toBe(
      "database: Moved the database x onto 127.0.0.1:1 alone, keeping its data; x-old is stopped and kept; remove it with: docker rm -v x-old",
    )
  })

  test("still lists a head in bad-builds when its follower failed for any other reason", async () => {
    clean()
    for (const path of [calls, join(state, "bad-builds"), join(state, "dev.log")]) {
      rmSync(path, { force: true })
    }
    await sup(failing(""), c2)
    expect(await Bun.file(join(state, "bad-builds")).text()).toBe(`${c2}\n`)
  })
})
