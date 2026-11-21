import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { FACTORY_SETTINGS, herdrPin, launchAfterRm, lw, root, spawn, unplugged } from "./spawn-fake"

// Every case runs spawn.sh, which starts fake processes and waits on them, so each gets the sandbox tests' allowance.
setDefaultTimeout(40_000)

const settingsOf = (r: { home: string }, file: string) => join(r.home, ".playground", file)
const builtOf = (r: { home: string }, file: string) =>
  JSON.parse(readFileSync(settingsOf(r, file), "utf8"))

// #1484: the auto-memory trial turns memory on for one launch alone, so the shared built file every other session reads stays as it is
describe("--memory <dir> turns auto-memory on for one launch (#1484)", () => {
  const SHARED = "factory-settings-sandbox-400k.json"
  const OWN = "factory-settings-sandbox-400k-memory-probe-x.json"

  test("without it, a probe's built file keeps the factory's memory off, as before", async () => {
    const r = await spawn(["probe", "probe-x", "ops", "p.md"], [])
    expect(r.code, r.err).toBe(0)
    expect(launchAfterRm(r)).toContain(` --settings ${settingsOf(r, SHARED)} `)
    const built = builtOf(r, SHARED)
    expect(built.autoMemoryEnabled).toBe(false)
    expect(built).not.toHaveProperty("autoMemoryDirectory")
    expect(existsSync(settingsOf(r, OWN))).toBe(false)
  })

  test("with it, the launch reads a built file of its own that sets autoMemoryEnabled and autoMemoryDirectory, and the shared one is not written", async () => {
    const dir = "/tmp/made-up-memory"
    const r = await spawn(["probe", "probe-x", "ops", "p.md", "--memory", dir], [])
    expect(r.code, r.err).toBe(0)
    expect(launchAfterRm(r)).toContain(` --settings ${settingsOf(r, OWN)} `)
    expect(builtOf(r, OWN)).toMatchObject({ autoMemoryDirectory: dir, autoMemoryEnabled: true })
    expect(existsSync(settingsOf(r, SHARED))).toBe(false)
  })

  test("it takes an absolute folder or off, once", async () => {
    const relative = await spawn(["probe", "probe-x", "ops", "p.md", "--memory", "made-up"], [])
    expect(relative.code).not.toBe(0)
    expect(relative.err).toContain("--memory takes an absolute folder")
    const twice = await spawn(
      ["probe", "probe-x", "ops", "p.md", "--memory", "/tmp/a", "--memory", "/tmp/b"],
      [],
    )
    expect(twice.code).not.toBe(0)
    expect(twice.err).toContain("--memory takes an absolute folder")
    const both = await spawn(
      ["probe", "probe-x", "ops", "p.md", "--memory", "off", "--memory", "/tmp/a"],
      [],
    )
    expect(both.code).not.toBe(0)
    expect(both.err).toContain("--memory takes an absolute folder or off, once")
    const close = await spawn(["close", "probe-x", "--memory", "/tmp/a"], [])
    expect(close.code).not.toBe(0)
    expect(close.err).toContain("close takes a session's name, and its session id to pick one")
  })
})

// #1484's trial: each start takes an arm by its role, its settings file naming the role's own memory folder, and the roster row records the arm, so the A/B reads it back
describe("each start takes the memory trial's arm by its role (#1484)", () => {
  const ID = "a1b2c3d4-0000-4000-8000-000000001484"
  const claude = (name: string) => ({ backend: "claude", name })
  const built = (r: { home: string }, name: string) =>
    builtOf(r, `factory-settings-400k-memory-${name}.json`)
  const turnWas = (turn: string) => (home: string) => {
    mkdirSync(lw(home, "memory"), { recursive: true })
    writeFileSync(lw(home, "memory", "worker-arm"), `${turn}\n`)
  }

  test.each([
    ["the dispatcher", ["manager", "dispatcher", "b.md"], "dispatcher", "dispatcher"],
    ["the builder", ["manager", "builder", "b.md"], "builder", "builder"],
    ["ops", ["manager", "ops", "b.md"], "ops", "ops"],
    ["the planner", ["manager", "planner", "b.md"], "planner", "planner"],
  ])("%s starts with memory on in its kind's folder", async (_, args, name, kind) => {
    const r = await spawn(args, [])
    expect(r.code, r.err).toBe(0)
    expect(built(r, name)).toMatchObject({
      autoMemoryDirectory: lw(r.home, "memory", kind),
      autoMemoryEnabled: true,
    })
    expect(r.roster).toContain("memory=on")
  })

  test("a worker after an A-arm start takes the B arm, in worker-b, and the turn moves on", async () => {
    const r = await spawn(
      ["worker", "worker-brave-otter", "b.md"],
      [],
      {},
      undefined,
      undefined,
      turnWas("off"),
    )
    expect(r.code, r.err).toBe(0)
    expect(built(r, "worker-brave-otter")).toMatchObject({
      autoMemoryDirectory: lw(r.home, "memory", "worker-b"),
      autoMemoryEnabled: true,
    })
    expect(r.roster).toContain("memory=on")
    expect(readFileSync(lw(r.home, "memory", "worker-arm"), "utf8")).toBe("on\n")
  })

  test.each([
    ["a first worker start", undefined],
    ["a worker after a B-arm start", "on"],
  ])("%s takes the A arm, off, and the turn moves on", async (_, turn) => {
    const r = await spawn(
      ["worker", "worker-brave-otter", "b.md"],
      [],
      {},
      undefined,
      undefined,
      turn ? turnWas(turn) : undefined,
    )
    expect(r.code, r.err).toBe(0)
    expect(launchAfterRm(r)).toContain(
      ` --settings ${settingsOf(r, "factory-settings-400k.json")} `,
    )
    expect(builtOf(r, "factory-settings-400k.json").autoMemoryEnabled).toBe(false)
    expect(r.roster).toContain("memory=off")
    expect(readFileSync(lw(r.home, "memory", "worker-arm"), "utf8")).toBe("off\n")
  })

  test("an A-arm start launches as it did before the trial: the shared file, its content and the flags unchanged, and memory=off its one roster addition", async () => {
    const r = await spawn(["worker", "worker-brave-otter", "b.md"], [])
    expect(r.code, r.err).toBe(0)
    expect(unplugged(launchAfterRm(r))).toBe(
      `(env PLAYGROUND_ROLE=worker claude -n worker-brave-otter --model claude-opus-5-5 --effort high --settings ${settingsOf(r, "factory-settings-400k.json")} --dangerously-skip-permissions "You are worker-brave-otter, a worker in the Playground factory; you report to builder. Load the playbook skill first. Your brief is in ~/.playground/b.md: read it in full and follow it. Report to builder with SendMessage (to: builder).")`,
    )
    expect(builtOf(r, "factory-settings-400k.json")).toEqual({
      ...FACTORY_SETTINGS,
      autoCompactWindow: 400000,
      enabledPlugins: { "ws-home@ws": false },
    })
    expect(readdirSync(lw(r.home)).filter((file) => file.includes("-memory-"))).toEqual([])
    expect(r.roster).toEqual([
      "set",
      "worker-brave-otter",
      "kind=worker",
      "reportsTo=builder",
      "surface=",
      "title=Plain test work",
      "task=b.md",
      "memory=off",
    ])
  })

  test.each([
    ["the dispatcher's start", ["manager", "dispatcher", "b.md", "--memory", "off"], undefined],
    ["a lead's resume", ["resume", "builder", root, ID, "--memory", "off"], "builder"],
    [
      "a B-arm worker's start",
      ["worker", "worker-brave-otter", "b.md", "--memory", "off"],
      undefined,
    ],
  ])(
    "--memory off keeps %s off, on the shared file, and leaves the workers' turn alone",
    async (_, args, pinned) => {
      const r = await spawn(
        args,
        [],
        {},
        undefined,
        pinned ? claude(pinned) : undefined,
        turnWas("off"),
      )
      expect(r.code, r.err).toBe(0)
      // a manager's shared file is its own, which denies it the Agent and Workflow tools (spawn-manager-deny.test.ts)
      const shared =
        args[0] === "worker" ? "factory-settings-400k.json" : "factory-settings-manager-400k.json"
      expect(launchAfterRm(r)).toContain(` --settings ${settingsOf(r, shared)} `)
      expect(builtOf(r, shared).autoMemoryEnabled).toBe(false)
      expect(readdirSync(lw(r.home)).filter((file) => file.includes("-memory-"))).toEqual([])
      expect(r.roster).toContain("memory=off")
      expect(readFileSync(lw(r.home, "memory", "worker-arm"), "utf8")).toBe("off\n")
    },
  )

  test("a worker start refused after the arm pick takes no turn", async () => {
    const r = await spawn(
      ["worker", "worker-brave-otter", "b.md", "--runtime", "herdr"],
      [],
      { FAKE_HERDR_RUN_FAIL: "1" },
      undefined,
      undefined,
      (home) => {
        herdrPin()(home)
        turnWas("off")(home)
      },
    )
    expect(r.code).toBe(1)
    expect(r.err).toContain("herdr opened no session for worker-brave-otter")
    expect(readFileSync(lw(r.home, "memory", "worker-arm"), "utf8")).toBe("off\n")
  })

  test.each([
    ["off", "off", "factory-settings-manager-400k.json"],
    ["on", "on", "factory-settings-400k-memory-builder.json"],
    [undefined, "on", "factory-settings-400k-memory-builder.json"],
  ])(
    "a lead's resume of a row whose memory is %p starts %p, so --memory off holds past one launch",
    async (row, arm, file) => {
      const env = {
        ROSTER_JSON: JSON.stringify({
          agents: [
            {
              kind: "builder",
              ...(row ? { memory: row } : {}),
              name: "builder",
              role: "manager",
              status: "working",
              task: "t",
            },
          ],
        }),
      }
      const r = await spawn(["resume", "builder", root, ID], [], env, undefined, claude("builder"))
      expect(r.code, r.err).toBe(0)
      expect(launchAfterRm(r)).toContain(` --settings ${settingsOf(r, file)} `)
      expect(r.roster).toContain(`memory=${arm}`)
    },
  )

  test("a resumed worker keeps its row's arm and leaves the turn as it is", async () => {
    const env = {
      ROSTER_JSON: JSON.stringify({
        agents: [
          {
            kind: "worker",
            memory: "on",
            name: "worker-brave-otter",
            role: "worker",
            status: "working",
            task: "t",
          },
        ],
      }),
    }
    const r = await spawn(
      ["resume", "worker-brave-otter", root, ID],
      [],
      env,
      undefined,
      claude("worker-brave-otter"),
      turnWas("on"),
    )
    expect(r.code, r.err).toBe(0)
    expect(built(r, "worker-brave-otter").autoMemoryDirectory).toBe(
      lw(r.home, "memory", "worker-b"),
    )
    expect(r.roster).toContain("memory=on")
    expect(readFileSync(lw(r.home, "memory", "worker-arm"), "utf8")).toBe("on\n")
  })

  test.each([
    ["a probe", ["probe", "probe-x", "ops", "p.md"], "factory-settings-sandbox-400k.json"],
    [
      "a GLM worker",
      ["worker", "worker-brave-otter", "b.md", "--backend", "glm"],
      "factory-settings-glm-400k.json",
    ],
    ["the optimizer", ["manager", "optimizer", "b.md"], "factory-settings-manager-400k.json"],
    ["a runner", ["runner", "runner-brave-otter", "b.md"], "factory-settings-400k.json"],
  ])("%s stays off and leaves the workers' turn alone", async (_, args, file) => {
    const r = await spawn(args, [])
    expect(r.code, r.err).toBe(0)
    expect(launchAfterRm(r)).toContain(` --settings ${settingsOf(r, file)} `)
    expect(builtOf(r, file).autoMemoryEnabled).toBe(false)
    expect(r.roster).toContain("memory=off")
    expect(existsSync(lw(r.home, "memory", "worker-arm"))).toBe(false)
  })
})
