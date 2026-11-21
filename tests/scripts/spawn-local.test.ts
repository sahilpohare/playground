import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { hostname } from "node:os"
import { join } from "node:path"

import { SOURCES } from "../glm-refused-sources"
import { OLD } from "../session-names"
import {
  capacityLog,
  FACTORY_SETTINGS,
  launchAfterRm,
  lw,
  placing,
  root,
  script,
  spawn,
  type Spawned,
} from "./spawn-fake"

// Every case runs spawn.sh, which starts fake processes and waits on them; one took 19.9s on the loaded runner box, so each gets twice that.
setDefaultTimeout(40_000)

const ID = "a7e37f18-1fa1-4cb2-a26e-4ff414fd4b27"
// What each effort sets for the local model, whose template reads no effort: thinking off at low, a cap of 8192 thinking tokens at medium, and thinking uncapped from high.
const THINKING: Record<string, string> = {
  high: "thinking uncapped; ",
  low: `thinking off; CLAUDE_CODE_EXTRA_BODY='{"thinking":{"type":"disabled"}}' `,
  max: "thinking uncapped; ",
  medium:
    "thinking capped at 8192 tokens; CLAUDE_CODE_MODEL_CAPABILITIES=local=-adaptive_thinking MAX_THINKING_TOKENS=8192 ",
  xhigh: "thinking uncapped; ",
}
const env_ = (effort = "high", context = 122880) =>
  `: effort ${effort}, ${THINKING[effort]}ANTHROPIC_BASE_URL=http://127.0.0.1:8000 ANTHROPIC_AUTH_TOKEN=local ANTHROPIC_DEFAULT_OPUS_MODEL=local ANTHROPIC_DEFAULT_SONNET_MODEL=local ANTHROPIC_DEFAULT_HAIKU_MODEL=local CLAUDE_CODE_MAX_CONTEXT_TOKENS=${context} ENABLE_TOOL_SEARCH=true `
const command = launchAfterRm
const pinOf = (r: Spawned, name: string) =>
  readFileSync(lw(r.home, "backends", name), "utf8").toString()

// The model switch's state as it writes it (local-model/state.ts): this machine's servers by model folder, each with its port and the sessions it takes at once.
const HERE = hostname().split(".")[0]!
const sized = (maxSessions: number, machine = HERE, port = 8000) => ({
  machines: {
    [machine]: {
      servers: {
        "ornith-1.5-35b-a3b-nvfp4": {
          busyAt: null,
          container: "local-vllm",
          maxSessions,
          port,
          share: 1,
          startedAt: "2026-11-17T06:00:00Z",
        },
      },
    },
  },
})
const modelState =
  (state: object | string = sized(6)) =>
  (home: string) => {
    mkdirSync(lw(home, "models"), { recursive: true })
    writeFileSync(
      lw(home, "models", "state.json"),
      typeof state === "string" ? state : JSON.stringify(state),
    )
  }
const local = (
  args: string[],
  extra: Record<string, string> = {},
  setup: (home: string) => void = modelState(),
  pin?: { name: string; backend: string },
) => spawn(args, [], extra, script, pin, setup)

describe("--backend local runs the session on the local model through Claude Code", () => {
  test.each([
    ["worker", ["worker", "worker-brave-otter", "b.md", "--backend", "local"]],
    ["column", ["column", "probe", "probe-x", OLD.ops, "w1:p2", "r.md", "--backend", "local"]],
    ["resume", ["resume", "worker-brave-otter", root, ID, "--backend", "local"]],
    ["a flag before the mode", ["--backend", "local", "runner", "runner-calm-heron", "b.md"]],
  ])(
    "%s: the launch points Claude Code at the local model, on the served name, in a 120k window",
    async (_, args) => {
      const r = await local(args)
      expect(r.code, r.err).toBe(0)
      expect(command(r)).toStartWith(`(${env_()}env PLAYGROUND_ROLE=`)
      expect(command(r)).toContain(" --model local --effort high ")
      expect(command(r)).not.toContain("claude-opus")
      expect(command(r)).not.toContain("--backend")
      const sandbox = /PLAYGROUND_ROLE=probe /.test(command(r)) ? "sandbox-" : ""
      const built = join(r.home, ".playground", `factory-settings-local-${sandbox}120k.json`)
      expect(command(r)).toContain(` --settings ${built} --dangerously-skip-permissions`)
      const settings = JSON.parse(readFileSync(built, "utf8"))
      if (sandbox) delete settings.sandbox
      expect(settings).toEqual({
        ...FACTORY_SETTINGS,
        autoCompactWindow: 120000,
        enabledPlugins: { "ws-home@ws": false },
        env: {
          ...FACTORY_SETTINGS.env,
          CLAUDE_CODE_ENABLE_TELEMETRY: "0",
          OTEL_METRICS_EXPORTER: "none",
        },
      })
      expect(r.security).toBeUndefined()
      expect(r.curl).toEqual(["-sS --max-time 5 http://127.0.0.1:8000/v1/models"])
    },
  )

  test.each(["low", "medium", "high", "xhigh", "max"])(
    "--effort %s passes through, and the launch line sets and names its thinking",
    async (effort) => {
      const r = await local([
        "worker",
        "worker-brave-otter",
        "b.md",
        "--backend",
        "local",
        "--effort",
        effort,
      ])
      expect(r.code, r.err).toBe(0)
      expect(command(r)).toStartWith(`(${env_(effort)}env PLAYGROUND_ROLE=`)
      expect(command(r)).toContain(` --model local --effort ${effort} `)
    },
  )

  test.each(["low", "medium"])(
    "a Claude launch at --effort %s carries none of the local model's thinking variables",
    async (effort) => {
      const r = await spawn(["worker", "worker-brave-otter", "b.md", "--effort", effort], [])
      expect(r.code, r.err).toBe(0)
      expect(command(r)).not.toContain("MAX_THINKING_TOKENS")
      expect(command(r)).not.toContain("CLAUDE_CODE_MODEL_CAPABILITIES")
    },
  )

  test("a start records the pin claude-code local, which a resume runs on", async () => {
    const started = await local(["worker", "worker-brave-otter", "b.md", "--backend", "local"])
    expect(started.code, started.err).toBe(0)
    expect(pinOf(started, "worker-brave-otter")).toBe("claude-code local\n")
    const resumed = await local(["resume", "worker-brave-otter", root, ID], {}, modelState(), {
      backend: "claude-code local",
      name: "worker-brave-otter",
    })
    expect(resumed.code, resumed.err).toBe(0)
    expect(command(resumed)).toStartWith(`(${env_()}env PLAYGROUND_ROLE=`)
    expect(pinOf(resumed, "worker-brave-otter")).toBe("claude-code local\n")
  })

  test("a resume pinned on local takes no --backend", async () => {
    const r = await local(
      ["resume", "worker-brave-otter", root, ID, "--backend", "claude"],
      {},
      modelState(),
      { backend: "claude-code local", name: "worker-brave-otter" },
    )
    expect(r.code).toBe(1)
    expect(r.err).toContain("the pin decides how worker-brave-otter runs")
    expect(placing(r)).toEqual([])
  })

  test("a local start's prompt says its core tools are already loaded", async () => {
    const r = await local(["worker", "worker-brave-otter", "b.md", "--backend", "local"])
    expect(r.code, r.err).toBe(0)
    expect(command(r)).toContain(
      "read it in full and follow it. Skill, Read, Bash, Edit and Write are already loaded",
    )
  })

  test.each([
    [
      "column reviewer",
      ["column", "reviewer", "reviewer-x", "worker-x", "w1:p2", "r.md", "--pr", "1"],
      "a reviewer runs on Claude, so it takes no --backend local",
    ],
    [
      "column tester",
      ["column", "tester", "tester-x", "worker-x", "w1:p2", "t.md", "--pr", "1"],
      "a tester runs on Claude, so it takes no --backend local",
    ],
    [
      "resume reviewer-x",
      ["resume", "reviewer-x", root, ID, "--pr", "1"],
      "a reviewer runs on Claude, so it takes no --backend local",
    ],
    [
      "planner",
      ["manager", OLD.planner, "b.md"],
      "a planner plans on Claude, so it takes no --backend local",
    ],
    [
      "researcher",
      ["worker", "k7m2qd-worker", "b.md"],
      "a researcher researches on Claude, so it takes no --backend local",
    ],
  ])(
    "a %s stays on Claude: --backend local is refused before herdr runs",
    async (_, args, says) => {
      // the roster gives a researcher its kind, whatever its name
      const kinds = {
        agents: [
          { kind: "researcher", name: "k7m2qd-worker", role: "worker", status: "ended", task: "t" },
        ],
      }
      const r = await local([...args, "--backend", "local"], { ROSTER_JSON: JSON.stringify(kinds) })
      expect(r.code).toBe(1)
      expect(r.err).toContain(says)
      expect(placing(r)).toEqual([])
      expect(r.roster).toBeUndefined()
    },
  )

  test.each([
    ["--model", ["--model", "claude-sonnet-5-5"], "a session on a local model takes no --model"],
    ["--account", ["--account", "zai"], "a session on a local model takes no --account"],
  ])("%s beside --backend local is refused before herdr runs", async (_, extra, says) => {
    const r = await local(["worker", "worker-a", "b.md", "--backend", "local", ...extra])
    expect(r.code).toBe(1)
    expect(r.err).toContain(says)
    expect(placing(r)).toEqual([])
  })

  test("an --ssh probe is refused on local, since the model listens on this machine alone", async () => {
    const r = await local(
      [
        "probe",
        "probe-x",
        OLD.ops,
        "b.md",
        "--backend",
        "local",
        "--ssh",
        "pride@spark-bravo",
        "--key",
        "{home}/key",
      ],
      {},
      (home) => {
        modelState()(home)
        writeFileSync(join(home, "key"), "a made-up key\n", { mode: 0o600 })
      },
    )
    expect(r.code).toBe(1)
    expect(r.err).toContain(
      "the local model listens on this machine's loopback alone, so an --ssh probe takes no --backend local",
    )
    expect(placing(r)).toEqual([])
  })

  test("a session in a folder named for an org ext.links guards is refused on local", async () => {
    const r = await local(
      ["worker", "worker-a", "b.md", "--backend", "local", "--in", "{home}/code/acme/app"],
      { SETTINGS_JSON: JSON.stringify({ "ext.links": { acme: ["acme"] } }) },
      (home) => {
        modelState()(home)
        mkdirSync(join(home, "code", "acme", "app"), { recursive: true })
        writeFileSync(join(home, ".playground", "b.md"), "A made-up task.\n")
      },
    )
    expect(r.code).toBe(1)
    expect(r.err).toContain(
      "worker-a runs in a checkout of acme, an org ext.links guards, so it runs on Claude",
    )
    expect(placing(r)).toEqual([])
  })

  test("a brief naming a listed source is refused on local before herdr runs", async () => {
    const r = await local(["worker", "worker-a", "b.md", "--backend", "local"], {}, (home) => {
      modelState()(home)
      const ext = join(home, ".playground", "extensions")
      mkdirSync(join(ext, "hooks"), { recursive: true })
      writeFileSync(
        join(ext, "policy.json"),
        JSON.stringify({ orgs: {}, schemaVersion: 1, values: {} }),
      )
      writeFileSync(join(ext, "hooks", "glm-refused-sources.json"), JSON.stringify(SOURCES))
      writeFileSync(join(home, ".playground", "b.md"), "Read the Example team's Linear board.\n")
    })
    expect(r.code).toBe(1)
    expect(r.err).toContain(
      "b.md names linear, a source glm-refused-sources keeps off the local model, so it runs on Claude",
    )
    expect(placing(r)).toEqual([])
  })

  test.each([
    [
      "the model server does not answer",
      { FAKE_LOCAL_DOWN: "1" },
      "the local model at http://127.0.0.1:8000 did not answer in 5 s",
    ],
    [
      "the model server lists no served name",
      { FAKE_LOCAL_MODELS: '{"object":"list","data":[{"id":"other"}]}' },
      "the local model at http://127.0.0.1:8000 serves no model named local",
    ],
    [
      "the model server answers with no model list",
      { FAKE_LOCAL_MODELS: "<html>" },
      "serves no model named local",
    ],
  ])("%s: the start is refused before herdr runs", async (_, extra, says) => {
    const r = await local(["worker", "worker-a", "b.md", "--backend", "local"], extra)
    expect(r.code).toBe(1)
    expect(r.err).toContain(says)
    expect(placing(r)).toEqual([])
    expect(r.roster).toBeUndefined()
  })
})

describe("the local launch declares the model server's own window, so the session compacts inside it", () => {
  const card = (extra: string) => ({
    FAKE_LOCAL_MODELS: `{"object":"list","data":[{"id":"other","max_model_len":32768},{"id":"local"${extra}}]}`,
  })
  test.each([
    ["the served card's max_model_len, less 8192 for the reply", ',"max_model_len":262144', 253952],
    ["120000 for a card with no max_model_len", "", 120000],
    ["120000 for a max_model_len that is no number", ',"max_model_len":"131072"', 120000],
    ["120000 for a max_model_len the reply's room would empty", ',"max_model_len":16384', 120000],
  ])("PG-2592 %s", async (_, extra, context) => {
    const r = await local(["worker", "worker-a", "b.md", "--backend", "local"], card(extra))
    expect(r.code, r.err).toBe(0)
    expect(command(r)).toStartWith(`(${env_("high", context)}env PLAYGROUND_ROLE=`)
  })
})

describe("the local gate: at most the sessions this machine's model server takes at once", () => {
  const row = (name: string, status = "working") => ({ name, role: "worker", status, task: "t" })
  const pinned =
    (names: string[], state: object | string | null = sized(6)) =>
    (home: string) => {
      if (state !== null) modelState(state)(home)
      mkdirSync(lw(home, "backends"), { recursive: true })
      for (const name of names) writeFileSync(lw(home, "backends", name), "claude-code local\n")
    }
  const six = [
    "b2c3d4-worker",
    "c3d4f5-worker",
    "d4f5g6-worker",
    "f5g6h7-worker",
    "g6h7j8-worker",
    "h7j8k9-worker",
  ]
  const roster = (rows: object[]) => ({
    FAKE_CPU_IDLE: "80",
    ROSTER_JSON: JSON.stringify({ agents: rows }),
  })
  const start = ["worker", "t4n7vx-worker", "b.md", "--backend", "local"]

  test("a seventh local session is refused before herdr runs, naming the six and the state file", async () => {
    const r = await local(start, roster(six.map((n) => row(n))), pinned(six))
    expect(r.code).toBe(1)
    expect(r.err).toContain(
      `6 live local sessions (${six.join(", ")}), and the local model here serves 6 at once (models/state.json)`,
    )
    expect(placing(r)).toEqual([])
  })

  test("a sixth starts, and rows pinned elsewhere or ended count for none", async () => {
    const rows = [
      ...six.slice(0, 5).map((n) => row(n)),
      row(six[5]!, "ended"),
      row("j8k9m2-worker"),
    ]
    const r = await local(start, roster(rows), (home) => {
      pinned(six)(home)
      writeFileSync(lw(home, "backends", "j8k9m2-worker"), "claude-code glm\n")
    })
    expect(r.code, r.err).toBe(0)
  })

  test("the cap is the maxSessions the model switch gives this machine's server", async () => {
    const two = six.slice(0, 2)
    const r = await local(start, roster(two.map((n) => row(n))), pinned(two, sized(2)))
    expect(r.code).toBe(1)
    expect(r.err).toContain("2 live local sessions")
    expect(r.err).toContain("serves 2 at once (models/state.json)")
  })

  test.each([
    ["no state file", null],
    ["no entry for this machine", sized(2, "another-machine")],
    ["no server on the local port", sized(2, HERE, 8001)],
  ])("with %s the cap falls back to K's 6", async (_, state) => {
    const five = six.slice(0, 5)
    const passes = await local(start, roster(five.map((n) => row(n))), pinned(five, state))
    expect(passes.code, passes.err).toBe(0)
    const refused = await local(start, roster(six.map((n) => row(n))), pinned(six, state))
    expect(refused.code).toBe(1)
    expect(refused.err).toContain(
      "serves 6 at once (K's limit, as models/state.json sizes no server on 8000 here)",
    )
  })

  // the keep beat's speed on this machine's server, written now unless an age in minutes is given
  const reading = (
    speed: { decodeTps: number | null; ttftMean: number | null; waiting: number },
    minutesOld = 0,
  ) => {
    const state = sized(6) as { machines: Record<string, { servers: Record<string, object> }> }
    const servers = state.machines[HERE]!.servers
    const [model] = Object.keys(servers)
    const at = new Date(Date.now() - minutesOld * 60_000).toISOString()
    servers[model!] = { ...servers[model!], speed: { at, ...speed } }
    return state
  }
  const two = six.slice(0, 2)
  const quick = { decodeTps: 30, ttftMean: 3, waiting: 0 }

  test.each([
    ["a speed that clears both floors with one more", quick, 0, two],
    ["a window with no samples", { decodeTps: null, ttftMean: null, waiting: 0 }, 0, two],
    [
      "a slow reading older than 15 minutes, which counts as no samples",
      { decodeTps: 1, ttftMean: 60, waiting: 0 },
      20,
      two,
    ],
    [
      "a slow reading with no live local session, whose share it is not",
      { ...quick, decodeTps: 1 },
      0,
      [],
    ],
  ])("PG-2559 %s starts", async (_, speed, minutesOld, live) => {
    const r = await local(
      start,
      roster(live.map((n) => row(n))),
      pinned(live, reading(speed, minutesOld)),
    )
    expect(r.code, r.err).toBe(0)
  })

  test.each([
    [
      "a speed under the floor with one more",
      { ...quick, decodeTps: 20 },
      "each of the 2 live local sessions decodes 20.0 tokens a second, so one more would leave about 13.3, under the speed floor of 15 (localModels.minTps)",
      two,
    ],
    [
      "a request waiting",
      { ...quick, waiting: 1 },
      "the local model here has 1 request waiting, so one more session would queue behind them",
      two,
    ],
    [
      "a first token too slow",
      { ...quick, ttftMean: 12 },
      "the local model here takes 12.0 s on average to a first token, at or over the first-token floor of 10 s (localModels.maxFirstTokenSeconds)",
      two,
    ],
    [
      "a request waiting with no live local session",
      { ...quick, waiting: 1 },
      "the local model here has 1 request waiting, so one more session would queue behind them",
      [],
    ],
    [
      "a first token too slow with no live local session",
      { ...quick, ttftMean: 12 },
      "the local model here takes 12.0 s on average to a first token, at or over the first-token floor of 10 s (localModels.maxFirstTokenSeconds)",
      [],
    ],
  ])(
    "PG-2559 %s is refused before herdr runs, naming the reading",
    async (_, speed, says, live) => {
      const r = await local(start, roster(live.map((n) => row(n))), pinned(live, reading(speed)))
      expect(r.code).toBe(1)
      expect(r.err).toContain(says)
      expect(placing(r)).toEqual([])
    },
  )

  test("a resume of a live local row at the cap brings it back", async () => {
    const r = await local(
      ["resume", six[0]!, root, ID],
      roster(six.map((n) => row(n))),
      pinned(six),
    )
    expect(r.code, r.err).toBe(0)
  })

  test("a state file that does not read refuses a local start, naming the file", async () => {
    const r = await local(start, {}, modelState("{ not json"))
    expect(r.code).toBe(1)
    expect(r.err).toContain("state.json (does not read)")
    expect(placing(r)).toEqual([])
  })

  test("a Claude start reads no local model", async () => {
    const r = await spawn(
      ["worker", "t4n7vx-worker", "b.md"],
      [],
      {},
      script,
      undefined,
      modelState("{ not json"),
    )
    expect(r.code, r.err).toBe(0)
    expect(r.curl).toBeUndefined()
  })
})

describe("a local start reads swap-ins as the median of 3 one-second samples", () => {
  const start = ["worker", "t4n7vx-worker", "b.md", "--backend", "local"]

  test.each([
    ["lands on one second at 8403/s, the seconds after it at 5/s", "8403 5 5"],
    ["reads one second at 8403/s between seconds at 5/s", "5 8403 5"],
  ])("PG-2659 a start that %s passes, reading 5/s", async (_, swapins) => {
    const r = await local(start, { FAKE_SWAPINS: swapins })
    expect(r.code, r.err).toBe(0)
    expect(capacityLog(r).at(-1).readings.swapins).toBe(5)
  })

  test("PG-2659 swap-ins over 100/s in two of the three seconds still refuse", async () => {
    const r = await local(start, { FAKE_SWAPINS: "150 8403 120" })
    expect(r.code).toBe(1)
    expect(r.err).toContain(
      "the memory gate holds it: swap-ins are 150/s (vm_stat), and a local session starts under 100/s",
    )
    expect(placing(r)).toEqual([])
  })
})
