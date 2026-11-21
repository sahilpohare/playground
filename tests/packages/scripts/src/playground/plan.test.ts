import { describe, expect, test } from "bun:test"

import {
  addCommand,
  aliasFailure,
  extraWordRefusal,
  HELP,
  planStart,
  rollOutcome,
  rollTimedOut,
  runStart,
  runStatus,
  statusLines,
  usageOf,
  VIEW_HINT,
  dashboardBeatOf,
  startFailure,
  stepQueued,
  waitingLine,
  waitOutcome,
  wantsHelp,
  type DashboardBeat,
  type Probes,
} from "../../../../../packages/scripts/src/playground/plan"

const UP: Probes = {
  api: true,
  dispatchers: [{ backend: "claude", name: "dispatcher" }],
  follower: true,
  glm: true,
  web: true,
}

describe("planStart", () => {
  test("only opens the Dashboard when everything runs", () => {
    expect(planStart(UP)).toEqual(["open"])
  })

  test("starts the jobs and waits when the Dashboard's API is down", () => {
    expect(planStart({ ...UP, api: false })).toEqual(["jobs", "wait", "open"])
  })

  test("starts the dispatcher when no dispatcher session is live", () => {
    expect(planStart({ ...UP, dispatchers: [] })).toEqual(["dispatcher", "open"])
  })

  test("a second dispatcher alone does not count as the lead", () => {
    expect(
      planStart({
        ...UP,
        dispatchers: [{ backend: "glm", name: "dispatcher-2" }],
      }),
    ).toEqual(["dispatcher", "open"])
  })

  test("starts both on a machine with nothing running", () => {
    expect(
      planStart({
        ...UP,
        api: false,
        dispatchers: [],
        follower: false,
        web: false,
      }),
    ).toEqual(["jobs", "dispatcher", "wait", "open"])
  })

  test("a follower alone down starts nothing, since the dashboard's supervisor restarts it", () => {
    expect(planStart({ ...UP, follower: false })).toEqual(["open"])
  })
})

describe("runStart", () => {
  test("starts herdr before the Dashboard's steps, which stop with no live/desk checkout", async () => {
    const order: string[] = []
    const run = runStart(
      async () => {
        order.push("herdr")
        return 0
      },
      async () => {
        order.push("dashboard")
        throw new Error("no checkout of the repo is on branch live/desk")
      },
    )
    await expect(run).rejects.toThrow("live/desk")
    expect(order).toEqual(["herdr", "dashboard"])
  })

  test("runs the Dashboard's steps after a herdr start that failed, and exits 1 when either failed", async () => {
    const order: string[] = []
    const step = (name: string, code: number) => async () => {
      order.push(name)
      return code
    }
    expect(await runStart(step("herdr", 1), step("dashboard", 0))).toBe(1)
    expect(order).toEqual(["herdr", "dashboard"])
    expect(await runStart(step("herdr", 0), step("dashboard", 1))).toBe(1)
    expect(await runStart(step("herdr", 0), step("dashboard", 0))).toBe(0)
  })
})

describe("runStatus", () => {
  test("prints herdr's lines before the Dashboard's part, which stops with no live/desk checkout", async () => {
    const order: string[] = []
    const run = runStatus(
      async () => {
        order.push("herdr")
        return 0
      },
      async () => {
        order.push("dashboard")
        throw new Error("no checkout of the repo is on branch live/desk")
      },
    )
    await expect(run).rejects.toThrow("live/desk")
    expect(order).toEqual(["herdr", "dashboard"])
  })

  test("exits as herdr's status did, once the Dashboard's lines are printed", async () => {
    const order: string[] = []
    const code = await runStatus(
      async () => {
        order.push("herdr")
        return 1
      },
      async () => {
        order.push("dashboard")
      },
    )
    expect(code).toBe(1)
    expect(order).toEqual(["herdr", "dashboard"])
  })
})

describe("statusLines", () => {
  test("everything running", () => {
    expect(statusLines(UP)).toEqual([
      "Dashboard web: up",
      "Dashboard API: up",
      "Session follower: running",
      "Dispatcher on Claude: running",
      "GLM: set up",
    ])
  })

  test("everything down, with no GLM", () => {
    expect(
      statusLines({
        api: false,
        dispatchers: [],
        follower: false,
        glm: false,
        web: false,
      }),
    ).toEqual([
      "Dashboard web: down",
      "Dashboard API: down",
      "Session follower: stopped",
      "Dispatcher: not running",
      "GLM: not set up",
    ])
  })

  test("names each dispatcher by the model it runs, the lead first", () => {
    expect(
      statusLines({
        ...UP,
        dispatchers: [
          { backend: "glm", name: "dispatcher-2" },
          { backend: "claude", name: "dispatcher" },
        ],
      }).filter((line) => line.startsWith("Dispatcher")),
    ).toEqual(["Dispatcher on Claude: running", "Dispatcher on GLM: running"])
  })

  test("a second dispatcher with no lead still says the lead is not running", () => {
    expect(
      statusLines({ ...UP, dispatchers: [{ backend: null, name: "dispatcher-2" }] }).filter(
        (line) => line.startsWith("Dispatcher"),
      ),
    ).toEqual(["Dispatcher: not running", "Dispatcher on an unknown model: running"])
  })
})

describe("addCommand", () => {
  const all = () => true
  // The --model list models.claude sets, at its default.
  const MODELS = ["claude-opus-5-5", "claude-fable-5-1", "claude-sonnet-5-5", "claude-haiku-5-5"]
  const pick = (kind: string) => `${kind}-brave-otter`

  test("a worker- name is used as given, as a worker on the fixed new-worker brief", () => {
    expect(addCommand(["worker-brave-otter"], all, pick, MODELS)).toEqual({
      argv: ["worker", "worker-brave-otter", "handoffs/new-worker.md"],
      started: "Started worker-brave-otter",
    })
  })

  test("with no name, takes a worker's name from the picker", () => {
    expect(addCommand([], all, pick, MODELS)).toEqual({
      argv: ["worker", "worker-brave-otter", "handoffs/new-worker.md"],
      started: "Started worker-brave-otter",
    })
  })

  // spawn.sh refuses a worker with no title, so add passes the one it is given.
  test("passes --title to spawn.sh as given", () => {
    expect(
      addCommand(["--title", "Fix the CSV export", "worker-brave-otter"], all, pick, MODELS),
    ).toEqual({
      argv: [
        "worker",
        "worker-brave-otter",
        "handoffs/new-worker.md",
        "--title",
        "Fix the CSV export",
      ],
      started: "Started worker-brave-otter",
    })
  })

  // spawn.sh refuses a worker with no --account while usage.accounts lists a Claude row, so add passes the one it is given.
  test("passes --account to spawn.sh as given", () => {
    expect(
      addCommand(["--account", "blue@example.com", "worker-brave-otter"], all, pick, MODELS),
    ).toEqual({
      argv: [
        "worker",
        "worker-brave-otter",
        "handoffs/new-worker.md",
        "--account",
        "blue@example.com",
      ],
      started: "Started worker-brave-otter",
    })
  })

  test("--kind runner starts a runner, its name picked for that kind", () => {
    expect(addCommand(["--kind", "runner", "--brief", "b-x.md"], all, pick, MODELS)).toEqual({
      argv: ["runner", "runner-brave-otter", "b-x.md"],
      started: "Started runner-brave-otter",
    })
  })

  test("an <id>-<kind> name is used as given (#966)", () => {
    expect(addCommand(["k3m9px-worker"], all, pick, MODELS)).toEqual({
      argv: ["worker", "k3m9px-worker", "handoffs/new-worker.md"],
      started: "Started k3m9px-worker",
    })
  })

  test("--kind runner with a name uses the name as given", () => {
    expect(addCommand(["--kind", "runner", "runner-calm-owl"], all, pick, MODELS)).toEqual({
      argv: ["runner", "runner-calm-owl", "handoffs/new-worker.md"],
      started: "Started runner-calm-owl",
    })
  })

  test("a model models.claude adds is one --model takes, and one it lacks is refused", () => {
    const added = [...MODELS, "claude-opus-6"]
    expect(
      "argv" in addCommand(["worker-otter", "--model", "claude-opus-6"], all, pick, added),
    ).toBe(true)
    expect(
      addCommand(["worker-otter", "--model", "claude-opus-6"], all, pick, ["claude-opus-5-5"]),
    ).toEqual({
      error: "--model takes claude-opus-5-5, not claude-opus-6",
    })
  })

  test("passes --brief, --model and --backend as spawn.sh takes them", () => {
    expect(
      addCommand(
        [
          "worker-otter",
          "--brief",
          "b-920.md",
          "--model",
          "claude-fable-5-1",
          "--backend",
          "claude",
        ],
        all,
        pick,
        MODELS,
      ),
    ).toEqual({
      argv: [
        "worker",
        "worker-otter",
        "b-920.md",
        "--model",
        "claude-fable-5-1",
        "--backend",
        "claude",
      ],
      started: "Started worker-otter",
    })
  })

  test("--dispatcher starts sessions.names' dispatcher with -2 on GLM", () => {
    expect(addCommand(["--dispatcher", "--backend", "glm"], all, pick, MODELS)).toEqual({
      argv: ["manager", "dispatcher-2", "brief-dispatcher-2.md", "--backend", "glm"],
      started: "Started a second dispatcher on GLM",
    })
  })

  test.each([
    [["--manager", "builder"], "--manager is not ready yet"],
    [
      ["otter", "--model", "claude-opus-4"],
      "--model takes claude-opus-5-5, claude-fable-5-1, claude-sonnet-5-5 or claude-haiku-5-5, not claude-opus-4",
    ],
    [["otter", "--backend", "gpt"], "--backend takes claude, glm or local, not gpt"],
    [
      ["k3m9px-runner"],
      "k3m9px-runner reads as a runner, not a worker: bun run name worker gives one",
    ],
    [
      ["--kind", "runner", "worker-calm-owl"],
      "worker-calm-owl reads as a worker, not a runner: bun run name runner gives one",
    ],
    [["otter"], "otter gives no kind: bun run name worker gives one"],
    [["--kind", "runner", "calm-owl"], "calm-owl gives no kind: bun run name runner gives one"],
    [["Otter"], "a name is lowercase words joined by hyphens, not Otter"],
    [["otter", "extra"], "playground add takes one name, not extra"],
    [["otter", "--force"], "playground add takes no --force"],
    [["--dispatcher", "--brief", "x.md"], "--dispatcher takes --backend alone"],
    [["--kind", "researcher"], "--kind takes worker or runner, not researcher"],
    [["--dispatcher", "--kind", "runner"], "--dispatcher takes --backend alone"],
    [["--dispatcher", "--title", "Plain work"], "--dispatcher takes --backend alone"],
    [["--dispatcher", "--account", "zai"], "--dispatcher takes --backend alone"],
    [
      ["--dispatcher"],
      "a second dispatcher runs on --backend glm, since on Claude it needs a second account",
    ],
    [
      ["--dispatcher", "--backend", "claude"],
      "a second dispatcher runs on --backend glm, since on Claude it needs a second account",
    ],
    [["otter", "--brief"], "--brief needs a value"],
  ])("refuses %j", (args, error) => {
    expect(addCommand(args, all, pick, MODELS)).toEqual({ error })
  })

  test.each([
    "/Users/someone/.playground/handoffs/b-x.md",
    "~/.playground/handoffs/b-x.md",
    "/etc/hosts",
    "../x.md",
  ])("a given brief %s goes to spawn.sh as typed, for its one brief rule (#1546)", (brief) => {
    expect(addCommand(["worker-otter", "--brief", brief], () => false, pick, MODELS)).toEqual({
      argv: ["worker", "worker-otter", brief],
      started: "Started worker-otter",
    })
  })

  test("refuses a brief that is not a file", () => {
    expect(addCommand(["worker-otter"], () => false, pick, MODELS)).toEqual({
      error: "~/.playground/handoffs/new-worker.md is missing: run scripts/link-skills.sh",
    })
  })
})

describe("rollOutcome", () => {
  test("reads nothing yet as still building", () => {
    expect(rollOutcome([], [])).toEqual({ phase: "building" })
  })

  test("reads the roll's start as switching once its stack starts", () => {
    const rolling = "2026-10-18T02:00:00Z roll-now: rolling to abc1234 at once"
    expect(rollOutcome([rolling], [])).toEqual({ phase: "building" })
    expect(rollOutcome([rolling, "2026-10-18T02:00:09Z dev started, pid 4242"], [])).toEqual({
      phase: "switching",
    })
  })

  // the Dashboard is down for minutes while the supervisor builds the head, which is no failure and no stalled switch
  test("reads the head's build after the roll's start as building, never failing, and switching once it is built", () => {
    const log = [
      "2026-10-18T02:00:00Z roll-now: rolling to abc1234 at once",
      "2026-10-18T02:00:05Z building abc1234 for https://playground.localhost https://api.playground.localhost",
    ]
    expect(rollOutcome(log, [])).toEqual({ phase: "building" })
    expect(rollOutcome([...log, "2026-10-18T02:02:40Z built abc1234 in 155s, 96M"], [])).toEqual({
      phase: "switching",
    })
  })

  // an alias check's line can land between a roll-now and its roll, and is no verdict on the roll
  test("passes over the alias check's lines to the roll's own", () => {
    expect(
      rollOutcome(
        [],
        [
          "2026-10-31T21:00:00Z ALIAS FAIL playground.localhost points at port 4851, but the live stack's desk.playground.localhost is on 4842",
          "2026-10-31T21:00:30Z ROLL canary abc1234 abc1234 PASS version=0.0.18 verify=PASS",
        ],
      ),
    ).toEqual({ done: "Updated to abc1234", ok: true })
  })

  test("reads a passing roll as updated, with its sha", () => {
    expect(
      rollOutcome(
        [],
        [
          "2026-10-18T02:03:00Z ROLL canary abc1234 (roll-now) abc1234 PASS version=abc1234 verify=PASS approvals=blank follower=running",
        ],
      ),
    ).toEqual({ done: "Updated to abc1234", ok: true })
  })

  // #2787: a roll that moved the database onto loopback names the move and the old container's remove command on its PASS line
  test("reads a passing roll that moved the database as updated, naming the move and its remove command", () => {
    const moved =
      "Moved the database playground-db-Ab12 onto 127.0.0.1:55432 alone, keeping its data; playground-db-Ab12-old is stopped and kept; once the Dashboard reads its data, remove it with: docker rm -v playground-db-Ab12-old"
    expect(
      rollOutcome(
        [],
        [
          `2026-10-18T02:03:00Z ROLL canary abc1234 (roll-now) abc1234 PASS version=abc1234 verify=PASS follower=running database: ${moved}`,
        ],
      ),
    ).toEqual({ done: `Updated to abc1234; ${moved}`, ok: true })
  })

  test("keeps a move's note when the roll fails after it, so the old container and its remove command still reach the report", () => {
    const moved =
      "Moved the database playground-db-Ab12 onto 127.0.0.1:55432 alone, keeping its data; playground-db-Ab12-old is stopped and kept; once the Dashboard reads its data, remove it with: docker rm -v playground-db-Ab12-old"
    expect(
      rollOutcome(
        [],
        [
          `2026-10-18T02:03:00Z ROLL canary def5678 (roll-now) def5678 FAIL dev=DOWN (dev: refusing to start: x) follower=running database: ${moved}`,
          "2026-10-18T02:03:01Z ROLL canary def5678 (roll-now) def5678 FAIL dev refusing: x (not the head's, no bad build)",
          "2026-10-18T02:05:00Z FALLBACK abc1234 PASS version=abc1234 verify=PASS",
        ],
      ),
    ).toEqual({
      done: `Failed: dev refusing: x (not the head's, no bad build); back on abc1234; ${moved}`,
      ok: false,
    })
    expect(
      rollOutcome(
        [],
        [
          `2026-10-18T02:03:00Z ROLL canary def5678 (roll-now) def5678 FAIL dev=DOWN (dev: y) database: ${moved}`,
          "2026-10-18T02:05:00Z FALLBACK abc1234 PASS version=abc1234 verify=PASS",
        ],
      ),
    ).toEqual({ done: `Failed: dev=DOWN (dev: y); back on abc1234; ${moved}`, ok: false })
  })

  test("reads a failed move's reason first, from the refusing line playground update prints", () => {
    const why =
      "database move: dashboard-db: the move failed (docker run failed: no); playground-db is started again as it was"
    expect(
      rollOutcome(
        [],
        [
          `2026-10-18T02:03:00Z ROLL canary def5678 (roll-now) def5678 FAIL dev=up follower=FAIL x ${why}`,
          `2026-10-18T02:03:01Z ROLL canary def5678 (roll-now) def5678 FAIL dev refusing: ${why}; refusing to write: playground-db publishes port 55432 beyond loopback (not the head's, no bad build)`,
          "2026-10-18T02:05:00Z FALLBACK abc1234 PASS version=abc1234 verify=PASS",
        ],
      ),
    ).toEqual({
      done: `Failed: dev refusing: ${why}; refusing to write: playground-db publishes port 55432 beyond loopback (not the head's, no bad build); back on abc1234`,
      ok: false,
    })
  })

  const FAILED =
    "2026-10-18T02:03:00Z ROLL canary def5678 (roll-now) def5678 FAIL dev=DOWN (dev: refusing to start: x)"

  // a build that fails before the stop leaves the Dashboard as it was, so no fallback follows (#122)
  test("reads a build that failed before the stop as failed at once, still on the head it served", () => {
    expect(
      rollOutcome(
        [],
        [
          "2026-10-18T02:03:00Z ROLL canary def5678 (roll-now) def5678 FAIL build before the stop: Error: next build failed; still serving abc1234",
        ],
      ),
    ).toEqual({
      done: "Failed: build before the stop: Error: next build failed; still serving abc1234",
      ok: false,
    })
  })

  test("reads a failing roll as going back until the fallback's result lands", () => {
    expect(rollOutcome([], [FAILED])).toEqual({ phase: "going back" })
  })

  test("reads a failing roll and a passing fallback as failed, back on the build before", () => {
    expect(
      rollOutcome(
        [],
        [FAILED, "2026-10-18T02:05:00Z FALLBACK abc1234 PASS version=abc1234 verify=PASS"],
      ),
    ).toEqual({
      done: "Failed: dev=DOWN (dev: refusing to start: x); back on abc1234",
      ok: false,
    })
  })

  test("reads a refused roll by its own refusing line, which follows roll_up's FAIL, so its count reaches the report (#1357)", () => {
    expect(
      rollOutcome(
        [],
        [
          "2026-10-18T02:03:00Z ROLL canary def5678 (roll-now) def5678 FAIL dev=DOWN (dev: refusing to start: x) follower=running",
          "2026-10-18T02:03:01Z ROLL canary def5678 (roll-now) def5678 FAIL dev refusing: x (refusal 1 of 3, no bad build)",
          "2026-10-18T02:05:00Z FALLBACK abc1234 PASS version=abc1234 verify=PASS",
        ],
      ),
    ).toEqual({
      done: "Failed: dev refusing: x (refusal 1 of 3, no bad build); back on abc1234",
      ok: false,
    })
  })

  test("reads a failing fallback as failed twice", () => {
    expect(
      rollOutcome([], [FAILED, "2026-10-18T02:05:00Z FALLBACK abc1234 FAIL dev=DOWN (dev: y)"]),
    ).toEqual({
      done: "Failed: dev=DOWN (dev: refusing to start: x); going back to abc1234 failed too",
      ok: false,
    })
  })

  test("reads a failing roll after a migration as failed, left on the new build", () => {
    expect(
      rollOutcome(
        [],
        [
          "2026-10-18T02:03:00Z ROLL canary def5678 (roll-now) (install migrate ) def5678 FAIL dev=DOWN (dev: x)",
        ],
      ),
    ).toEqual({
      done: "Failed: dev=DOWN (dev: x); it changed the database, so the Dashboard stays on def5678",
      ok: false,
    })
  })

  test("reads a roll the supervisor would not start as failed", () => {
    expect(
      rollOutcome([], ["2026-10-18T02:01:00Z ANOMALY stop left processes alive; not rolling"]),
    ).toEqual({ done: "Failed: stop left processes alive; not rolling", ok: false })
  })

  test("reads nothing new to build as already up to date", () => {
    expect(rollOutcome([], ["2026-10-18T02:01:00Z CURRENT abc1234"])).toEqual({
      done: "Already up to date at abc1234",
      ok: true,
    })
  })

  test("reads a head whose roll failed before as failed", () => {
    expect(
      rollOutcome(
        [],
        ["2026-10-18T02:01:00Z SKIP def5678 FAIL def5678 failed its roll before (bad-builds)"],
      ),
    ).toEqual({ done: "Failed: def5678 failed its roll before (bad-builds)", ok: false })
  })

  test("ignores an unrelated result line", () => {
    expect(rollOutcome([], ["2026-10-18T02:01:00Z RESTART follower follower=running"])).toEqual({
      phase: "building",
    })
  })

  // #2644: v0.0.151's roll queued about 30 minutes for load5 to drop under its clone's line, and update printed a false "Failed"
  describe("a roll whose prebuild queues in run-slot", () => {
    const rolling = "2026-11-17T12:00:00Z roll-now: rolling to abc1234 at once"
    const held =
      "run-slot.sh: this clone waits for load5 under 16, the brake's 20 less 4 and never under half of it"

    test("reads as waiting with run-slot's reason, the supervisor's own queued line included, until run-slot lets it start", () => {
      const waiting = {
        phase: "waiting" as const,
        why: "this clone waits for load5 under 16, the brake's 20 less 4 and never under half of it",
      }
      expect(rollOutcome([rolling, held], [])).toEqual(waiting)
      expect(
        rollOutcome(
          [
            rolling,
            held,
            "2026-11-17T12:20:00Z prebuild clone still queued after 1200s; it keeps waiting",
            held,
          ],
          [],
        ),
      ).toEqual(waiting)
      expect(
        rollOutcome([rolling, held, "run-slot.sh: ops-dashboard holds run-slot-clone"], []),
      ).toEqual({ phase: "building" })
      expect(
        rollOutcome(
          [
            rolling,
            "run-slot.sh: waiting for a run slot (worker-a 4242 2026-11-17T12:00:01Z 2 medium)",
          ],
          [],
        ),
      ).toEqual({
        phase: "waiting",
        why: "waiting for a run slot (worker-a 4242 2026-11-17T12:00:01Z 2 medium)",
      })
      expect(rollOutcome([held], [])).toEqual({ phase: "building" })
    })

    test("prints the load it waits on, or run-slot's own reason", () => {
      expect(waitingLine("this clone waits for load5 under 16, the brake's 20 less 4", 18.24)).toBe(
        "Waiting for load: load5 is 18.2, and the roll goes on under 16",
      )
      expect(waitingLine("waiting for a run slot (worker-a 4242)", 3)).toBe(
        "Waiting for a run slot (worker-a 4242)",
      )
      expect(waitingLine("queued behind 2 waiter(s) ahead of it in the queue's order", 3)).toBe(
        "Waiting for a run slot: queued behind 2 waiter(s) ahead of it in the queue's order",
      )
    })

    // round 1 of #2648: the install's general-queue wait and the build's captured wait still read as Building, then a false Failed at 30 minutes
    test("an install queued behind other waiters reads as waiting until run-slot gives it a lane", () => {
      const log = [
        rolling,
        "run-slot.sh: ops-dashboard holds run-slot-clone",
        "run-slot.sh: queued behind 2 waiter(s) ahead of it in the queue's order",
      ]
      expect(rollOutcome(log, [])).toEqual({
        phase: "waiting",
        why: "queued behind 2 waiter(s) ahead of it in the queue's order",
      })
      expect(rollOutcome([...log, "run-slot.sh: ops-dashboard holds run-slot-2"], [])).toEqual({
        phase: "building",
      })
    })

    test("a build whose run-slot lines the supervisor captures reads as waiting once its own still-queued line lands", () => {
      const log = [
        rolling,
        "run-slot.sh: ops-dashboard holds run-slot-clone",
        "run-slot.sh: ops-dashboard holds run-slot",
        "2026-11-17T12:02:00Z building abc1234 before the stop, from /ops/dashboard/staging",
        "2026-11-17T12:22:00Z prebuild build still queued after 1200s; it keeps waiting",
      ]
      expect(rollOutcome(log, [])).toEqual({
        phase: "waiting",
        why: "prebuild build still queued after 1200s; it keeps waiting",
      })
      expect(rollTimedOut(rollOutcome(log, []), 18).ok).toBe(true)
    })

    test("still waiting at 30 minutes reads as waiting and passes, never Failed, since the roll goes on by itself", () => {
      const end = rollTimedOut({ phase: "waiting", why: held.replace("run-slot.sh: ", "") }, 18)
      expect(end).toEqual({
        done: "Waiting for load: load5 is 18.0, and the roll goes on under 16: still waiting after 30 minutes, and the roll goes on by itself; see ops/dashboard/supervisor.log",
        ok: true,
      })
      expect(end.done).not.toContain("Failed")
    })

    // round 2 of #2648: a build queued under 20 minutes logs no wait at all, since build_head captures its run-slot lines and slot_step says it still queues only at 1200 s
    test("at 30 minutes, a prebuild step whose run-slot has not started yet reads as waiting and passes", () => {
      expect(rollTimedOut({ phase: "building" }, 18, true)).toEqual({
        done: "Waiting for a run slot: the roll's next step is still queued in run-slot: still waiting after 30 minutes, and the roll goes on by itself; see ops/dashboard/supervisor.log",
        ok: true,
      })
    })

    test("a prebuild step queues while its run-slot pid lives and run-slot.runs.log holds no start line for it, as slot_step reads it", () => {
      const live = (pid: number) => pid === 4242
      const runs = [
        "2026-11-17T12:00:00Z ask ops-dashboard 4242 bun run build",
        "2026-11-17T12:00:01Z start worker-a 4243 run-slot waited=0s",
      ]
      expect(stepQueued("4242\n", live, runs)).toBe(true)
      expect(
        stepQueued("4242\n", live, [
          ...runs,
          "2026-11-17T12:16:00Z start ops-dashboard 4242 run-slot waited=959s",
        ]),
      ).toBe(false)
      expect(stepQueued("4243\n", live, runs)).toBe(false)
      expect(stepQueued(undefined, live, runs)).toBe(false)
      expect(stepQueued("", live, runs)).toBe(false)
    })

    test("a roll that gave no result and waits on nothing still reads Failed with its reason", () => {
      for (const phase of ["building", "switching", "going back"] as const)
        expect(rollTimedOut({ phase }, 18)).toEqual({
          done: "Failed: no roll result within 30 minutes; see ops/dashboard/supervisor.log",
          ok: false,
        })
      expect(
        rollOutcome(
          [rolling, held, "run-slot.sh: ops-dashboard holds run-slot-clone"],
          ["2026-11-17T12:40:00Z ROLL roll-now abc1234 FAIL build before the stop: tsc failed"],
        ),
      ).toEqual({ done: "Failed: build before the stop: tsc failed", ok: false })
    })
  })
})

describe("wantsHelp", () => {
  test("--help, -h or help as the command asks for the help", () => {
    for (const command of ["--help", "-h", "help"]) expect(wantsHelp([command])).toBe(true)
  })

  test("--help or -h after any command asks for the help, so update --help never rolls", () => {
    expect(wantsHelp(["update", "--help"])).toBe(true)
    expect(wantsHelp(["add", "worker-x", "-h"])).toBe(true)
    expect(wantsHelp(["status", "-h"])).toBe(true)
  })

  test("a plain command, or none, is not a help ask", () => {
    expect(wantsHelp([])).toBe(false)
    expect(wantsHelp(["update"])).toBe(false)
    expect(wantsHelp(["add", "worker-help"])).toBe(false)
  })
})

describe("playground view", () => {
  test("help names view, herdr in start and status, and the hint bare dispatcher ends with names it", () => {
    expect(HELP).toContain("playground view       open the playground herdr server")
    expect(HELP).toContain("start herdr's servers that are down and restore their sessions")
    expect(HELP).toContain("each herdr server")
    expect(HELP).toContain("start the Dashboard's stack and follower in herdr when down")
    expect(HELP).not.toContain("cmux")
    expect(VIEW_HINT).toContain("playground view")
  })

  test("view takes no word, with its usage line; add keeps its options; the rest take none", () => {
    expect(extraWordRefusal(["view"])).toBeNull()
    expect(extraWordRefusal(["view", "probes"])).toBe(
      "playground view takes no probes\nusage: playground view",
    )
    expect(extraWordRefusal(["add", "--kind", "runner"])).toBeNull()
    expect(extraWordRefusal(["status", "now"])).toBe(
      "playground status takes no now\nusage: playground status",
    )
    expect(extraWordRefusal([])).toBeNull()
  })

  // PG-1377: check-modes was missing from the CLI's ext lists, so a stray word ran it rather than being refused
  test("ext check-modes takes no word, and the help names it", () => {
    expect(extraWordRefusal(["ext", "check-modes"])).toBeNull()
    expect(extraWordRefusal(["ext", "check-modes", "x"])).toStartWith(
      "playground ext check-modes takes no x",
    )
    expect(HELP).toContain("| reject | check-modes")
  })

  test("update takes --to and a tag, or nothing", () => {
    expect(extraWordRefusal(["update", "--to", "v0.0.20"])).toBeNull()
    expect(extraWordRefusal(["update", "--to"])).toBe("usage: playground update [--to <tag>]")
    for (const words of [
      ["update", "now"],
      ["update", "--to", "v1", "now"],
    ])
      expect(extraWordRefusal(words)).toBe(
        "playground update takes no now\nusage: playground update [--to <tag>]",
      )
  })

  test("alerts-wait takes exactly one name, and picker takes its session, answer, key and reason", () => {
    expect(extraWordRefusal(["alerts-wait", "builder"])).toBeNull()
    expect(extraWordRefusal(["alerts-wait"])).toBe(
      "usage: playground alerts-wait <name> (your own session's name)",
    )
    expect(extraWordRefusal(["alerts-wait", "builder", "now"])).toBe(
      "playground alerts-wait takes no now\nusage: playground alerts-wait <name>",
    )
    expect(
      extraWordRefusal(["picker", "k3m9px-worker", "deny", "0a1b2c3d", "use", "mv"]),
    ).toBeNull()
  })

  test("yard post takes its words unquoted, as runYard joins them", () => {
    expect(extraWordRefusal(["yard", "post", "ops", "the", "suite", "is", "green"])).toBeNull()
    expect(extraWordRefusal(["yard", "read", "ops", "now"])).toBe(
      "playground yard read takes no now\n" + usageOf("yard"),
    )
  })

  test("sweep takes exactly its lead's name", () => {
    expect(extraWordRefusal(["sweep", "builder"])).toBeNull()
    expect(extraWordRefusal(["sweep"])).toBe("usage: playground sweep <lead> (builder or ops)")
    expect(extraWordRefusal(["sweep", "builder", "now"])).toBe(
      "playground sweep takes no now\nusage: playground sweep <lead>",
    )
  })
})

describe("managing the install", () => {
  test("help names doctor, version, uninstall and update with what each does", () => {
    for (const line of ["doctor ", "version ", "uninstall [--purge]\n", "update "])
      expect(HELP).toContain(`\nplayground ${line}`)
    expect(HELP).toContain("fast-forward this checkout onto origin/main")
  })

  test("update's help names its steps in the order update runs them: link-skills.sh before install, build and the restarts", () => {
    const update = HELP.slice(HELP.indexOf("\nplayground update "))
    const at = (step: string) => update.indexOf(step)
    const order = [
      "fast-forward",
      "link-skills.sh",
      "install when",
      "build packages",
      "restart the ops jobs",
      "roll the Dashboard",
    ]
    expect(order.map(at).every((index) => index >= 0)).toBe(true)
    expect([...order].sort((a, b) => at(a) - at(b))).toEqual(order)
  })

  test("help names herdr pin, which takes --check or --asset <file>", () => {
    expect(HELP).toContain("\nplayground herdr pin [--check | --asset <file>]\n")
    expect(extraWordRefusal(["herdr", "pin", "--asset", "/scratch/herdr"])).toBeNull()
  })

  test("uninstall takes --purge alone, and doctor and version take nothing", () => {
    expect(extraWordRefusal(["uninstall"])).toBeNull()
    expect(extraWordRefusal(["uninstall", "--purge"])).toBeNull()
    expect(extraWordRefusal(["uninstall", "--all"])).toBe("usage: playground uninstall [--purge]")
    for (const command of ["doctor", "uninstall --purge", "version"])
      expect(extraWordRefusal([...command.split(" "), "now"])).toStartWith(
        `playground ${command.split(" ")[0]} takes no now\nusage: playground ${command.split(" ")[0]}`,
      )
  })
})

describe("waitOutcome", () => {
  const RUNNING: DashboardBeat = { ageMs: 5_000, cycleSeconds: 60, running: true }
  const at = (
    now: number,
    beat: DashboardBeat | null = RUNNING,
    api = false,
    failure: string | null = null,
    upHolds = false,
  ) => waitOutcome({ api, beat, failure, now, upHolds }, { shownAt: 0, startedAt: 0 })

  test("ends at once when the API answers", () => {
    expect(at(42_000, RUNNING, true)).toEqual({
      done: "The Dashboard answered after 42s",
      ok: true,
    })
    expect(at(80_000, null, true)).toMatchObject({ ok: true })
  })

  test("ends at the next poll when the supervisor exits mid-wait, naming it and the command", () => {
    expect(at(80_000, { ...RUNNING, running: false })).toEqual({
      done: "ops-dashboard's supervisor is not running, so the Dashboard will not come up (waited 1m 20s); see ops/dashboard/supervisor.log, then run playground again",
      ok: false,
    })
    expect(at(80_000, null)).toMatchObject({ ok: false })
  })

  test("keeps the wait going past a missing beat while up.py holds the job, and names the supervisor down only after the grace", () => {
    // up.py has not had time to refresh the beat, so a hold keeps the wait going, not a "supervisor is not running"
    expect(at(80_000, { ...RUNNING, running: false }, false, null)).toEqual({
      done: "ops-dashboard's supervisor is not running, so the Dashboard will not come up (waited 1m 20s); see ops/dashboard/supervisor.log, then run playground again",
      ok: false,
    })
    expect(at(80_000, { ...RUNNING, running: false }, false, null, true)).not.toHaveProperty("done")
    expect(at(80_000, null, false, null, true)).not.toHaveProperty("done")
  })

  test("ends when ops-dashboard's heartbeat is older than three of its cycles, naming its age", () => {
    expect(at(200_000, { ...RUNNING, ageMs: 180_001 })).toEqual({
      done: "ops-dashboard's heartbeat is 3m 0s old, past three of its 60s cycles, so its supervisor has stopped; see ops/dashboard/supervisor.log, then run playground again",
      ok: false,
    })
    expect(at(200_000, { ...RUNNING, ageMs: 180_000 })).not.toHaveProperty("done")
  })

  test("gives the supervisor 30s to start before judging its heartbeat", () => {
    expect(at(29_000, null)).not.toHaveProperty("done")
    expect(at(29_000, { ...RUNNING, ageMs: 3_600_000, running: false })).not.toHaveProperty("done")
    expect(at(30_000, null)).toMatchObject({ ok: false })
  })

  test("prints what it waits on and the time spent, at most every 10s", () => {
    expect(at(10_000)).toEqual({ progress: "Waiting for the Dashboard's API to answer… 10s" })
    expect(
      waitOutcome(
        { api: false, beat: RUNNING, failure: null, now: 75_000 },
        { shownAt: 70_000, startedAt: 0 },
      ),
    ).toEqual({ progress: null })
    expect(
      waitOutcome(
        { api: false, beat: RUNNING, failure: null, now: 80_000 },
        { shownAt: 70_000, startedAt: 0 },
      ),
    ).toEqual({ progress: "Waiting for the Dashboard's API to answer… 1m 20s" })
  })

  test("ends with the supervisor's failed start in its words once the 30s grace has passed", () => {
    const why = "cmux is not running; open cmux, then run playground again"
    expect(at(29_000, RUNNING, false, why)).not.toHaveProperty("done")
    expect(at(30_000, RUNNING, false, why)).toEqual({
      done: `the Dashboard's stack could not start: ${why} (waited 30s); see ops/dashboard/supervisor.log, then run playground again`,
      ok: false,
    })
    expect(at(30_000, RUNNING, true, why)).toMatchObject({ ok: true })
  })

  test("a stale FAIL keeps the wait going, and the next roll's FAIL or answer ends it", () => {
    const T = "2026-11-02T18:00:00Z"
    const stale = `${T} RESTART abc1234 FAIL dev=DOWN (dev: refusing to start: no database) follower=running`
    const read = (results: string[], api = false) =>
      waitOutcome(
        { api, beat: RUNNING, failure: startFailure(results, []), now: 60_000 },
        { shownAt: 60_000, startedAt: 0 },
      )
    expect(read([stale])).toEqual({ progress: null })
    expect(read([stale, `${T} DOWN dev: x`, stale])).toMatchObject({ ok: false })
    expect(read([stale, `${T} DOWN dev: x`, `${T} RESTART abc1234 PASS v`], true)).toMatchObject({
      ok: true,
    })
  })

  // the supervisor's ALIAS FAIL from a first start's first minute once cost the full 15 minutes with no reason given (#2301)
  test("ends at the next poll past the grace on an ALIAS FAIL no PASS has followed, naming the missing route", () => {
    const T = "2026-11-16T06:42:16Z"
    const fail = `${T} ALIAS FAIL no route for dashboard.playground.localhost in /home/me/.portless/fallback/routes.json`
    const read = (results: string[], now = 62_000) =>
      waitOutcome(
        { alias: aliasFailure(results), api: false, beat: RUNNING, failure: null, now },
        { shownAt: now, startedAt: 0 },
      )
    expect(read([fail])).toEqual({
      done: "portless does not route the Dashboard's addresses to its stack: no route for dashboard.playground.localhost in /home/me/.portless/fallback/routes.json (waited 1m 2s); see ops/dashboard/supervisor.log, then run playground again",
      ok: false,
    })
    expect(read([fail], 29_000)).not.toHaveProperty("done")
    expect(
      read([
        fail,
        `${T} ALIAS PASS playground.localhost and api.playground.localhost hold the live stack's ports 1 and 2`,
      ]),
    ).toEqual({ progress: null })
    expect(read([`${T} START abc1234 PASS version=1`])).toEqual({ progress: null })
  })

  // on the 1355 proxy with TLS an http address answers 302 to https, which read as down for 15 minutes (#2301)
  test("ends past the grace on a health read that answers a redirect, naming the URL asked and where it was sent", () => {
    const redirect = {
      from: "http://dashboard.api.playground.localhost:1355/api/health",
      status: 302,
      to: "https://dashboard.api.playground.localhost:1355/api/health",
    }
    const read = (now: number) =>
      waitOutcome(
        { api: false, beat: RUNNING, failure: null, now, redirect },
        { shownAt: now, startedAt: 0 },
      )
    expect(read(29_000)).not.toHaveProperty("done")
    expect(read(30_000)).toEqual({
      done: "the Dashboard's API answered 302 at http://dashboard.api.playground.localhost:1355/api/health, a redirect to https://dashboard.api.playground.localhost:1355/api/health, so playground asks it at an address portless does not serve (waited 30s); see ops/dashboard/supervisor.log, then run playground again",
      ok: false,
    })
  })

  test("ends after 15 minutes, as before", () => {
    expect(at(15 * 60_000)).toEqual({
      done: "the Dashboard did not answer within 15 minutes; see ops/dashboard/supervisor.log, then run playground again",
      ok: false,
    })
  })
})

describe("startFailure", () => {
  const T = "2026-11-02T18:00:00Z"
  const FOLLOWER = "follower=running follower: running entries: 12"
  const ARMED = [`${T} supervisor armed at abc1234`]
  const REFUSED = `${T} RESTART abc1234 FAIL dev=DOWN (dev: refusing to start: no single running Docker container publishes port 50300) ${FOLLOWER}`
  const OPENED = `${T} DOWN dev: refusing to start`

  test("reads a refused dev's reason in plain words, from a roll begun after the mark", () => {
    expect(startFailure([OPENED, REFUSED], [])).toBe(
      "no single running Docker container publishes port 50300",
    )
    expect(startFailure([`${T} START abc1234 FAIL build: error: tsc exited 2`], ARMED)).toBe(
      "error: tsc exited 2",
    )
    expect(
      startFailure(
        [`${T} DOWN web: gone`, `${T} RESTART abc1234 FAIL web: next build exited 1`],
        [],
      ),
    ).toBe("next build exited 1")
  })

  test("skips a FAIL from a roll begun before the mark: a RESTART with no DOWN after it, a START with no supervisor armed after it", () => {
    expect(startFailure([REFUSED], [])).toBeNull()
    expect(startFailure([`${T} START abc1234 FAIL build: error`], [])).toBeNull()
    expect(startFailure([`${T} DOWN follower: lost the lock`, REFUSED], [])).toBeNull()
    expect(
      startFailure([REFUSED, OPENED, `${T} RESTART abc1234 PASS version=1 ${FOLLOWER}`], []),
    ).toBeNull()
    expect(startFailure([REFUSED, OPENED, REFUSED], [])).toBe(
      "no single running Docker container publishes port 50300",
    )
  })

  test("gives a dev that died with no reason in its log one, and is null for a newer PASS, a failure off the stack and DOWN or other lines alone", () => {
    expect(startFailure([OPENED, `${T} RESTART abc1234 FAIL dev=DOWN () ${FOLLOWER}`], [])).toBe(
      "its API exited with no reason in its log",
    )
    expect(
      startFailure(
        [OPENED, REFUSED, OPENED, `${T} RESTART abc1234 PASS version=1 verify=PASS ${FOLLOWER}`],
        [],
      ),
    ).toBeNull()
    expect(
      startFailure(
        [
          OPENED,
          REFUSED,
          OPENED,
          `${T} RESTART abc1234 FAIL version=1 verify=PASS follower=FAIL lost the lock`,
        ],
        [],
      ),
    ).toBeNull()
    expect(
      startFailure(
        [
          `${T} DOWN dev: refusing to start: gone`,
          `${T} RESTART follower follower=running`,
          `${T} ALIAS FAIL playground.localhost`,
        ],
        ARMED,
      ),
    ).toBeNull()
    expect(startFailure([], ARMED)).toBeNull()
  })
})

describe("dashboardBeatOf", () => {
  const NOW = Date.parse("2026-10-19T22:00:00Z")
  const alive = () => true
  const BEAT = { cycleSeconds: 60, lastBeatAt: "2026-10-19T21:59:50Z", lastResult: "ok", pid: 4242 }

  test("reads a heartbeat's age, cycle and running pid", () => {
    expect(dashboardBeatOf(BEAT, NOW, alive)).toEqual({
      ageMs: 10_000,
      cycleSeconds: 60,
      running: true,
    })
  })

  test("is null for a file that is not a heartbeat", () => {
    expect(dashboardBeatOf(null, NOW, alive)).toBeNull()
    expect(dashboardBeatOf([], NOW, alive)).toBeNull()
    expect(dashboardBeatOf({ ...BEAT, lastBeatAt: undefined }, NOW, alive)).toBeNull()
    expect(dashboardBeatOf({ ...BEAT, lastBeatAt: "soon" }, NOW, alive)).toBeNull()
    expect(dashboardBeatOf({ ...BEAT, cycleSeconds: 0 }, NOW, alive)).toBeNull()
    expect(dashboardBeatOf({ ...BEAT, cycleSeconds: "60" }, NOW, alive)).toBeNull()
  })

  test("takes a 60s cycle when the file names none", () => {
    expect(dashboardBeatOf({ ...BEAT, cycleSeconds: undefined }, NOW, alive)).toMatchObject({
      cycleSeconds: 60,
    })
  })

  test("is not running once its loop has exited or its pid is gone", () => {
    expect(
      dashboardBeatOf({ ...BEAT, lastResult: "supervisor exited: 1" }, NOW, alive),
    ).toMatchObject({
      running: false,
    })
    expect(dashboardBeatOf({ ...BEAT, lastResult: "loop exited" }, NOW, alive)).toMatchObject({
      running: false,
    })
    expect(dashboardBeatOf(BEAT, NOW, () => false)).toMatchObject({ running: false })
    expect(dashboardBeatOf({ ...BEAT, pid: undefined }, NOW, alive)).toMatchObject({
      running: false,
    })
  })
})
