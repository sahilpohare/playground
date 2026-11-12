import { afterEach, describe, expect, test } from "bun:test"

import {
  DEFAULT_SESSION_NAMES,
  dispatcherLabelOfName,
  dispatcherOf,
  factoryRoleOf,
  hasManagerRole,
  kindOf,
  kindOfName,
  managerKindOfName,
  managerOf,
  roleOfName,
  seatOf,
  setSessionNames,
  slotOfName,
} from "../../../../packages/config/src/kinds"
import { OLD } from "../../../session-names"
import { SEEDED_NAMES } from "../../../session-names"

const agent = (name: string, status: string, kind?: string) => ({ kind, name, status })

// The preload's machine past the switch, set again after a case that changes it.
afterEach(() => setSessionNames(SEEDED_NAMES))

describe("managerOf", () => {
  test("sessions.names' names stand while the roster has no entry of the kind", () => {
    expect(managerOf([], "builder")).toBe("builder")
    expect(managerOf([], "ops")).toBe("ops")
    expect(managerOf([], "planner")).toBe("planner")
    expect(managerOf([], "optimizer")).toBe("optimizer")
    expect(managerOf(undefined, "builder")).toBe("builder")
  })

  test("a name set in sessions.names is its kind's fallback", () => {
    setSessionNames({ ...SEEDED_NAMES, names: { ...SEEDED_NAMES.names, builder: "forge" } })
    expect(managerOf([], "builder")).toBe("forge")
    expect(managerKindOfName("forge")).toBe("builder")
  })

  test("an old manager's entry with no kind reads its name's kind", () => {
    expect(managerOf([agent(OLD.builder, "working")], "builder")).toBe(OLD.builder)
  })

  test("a builder of any name is the builder, the newest live one of two", () => {
    const agents = [agent(OLD.builder, "working"), agent("x7mh4d-builder", "working", "builder")]
    expect(managerOf(agents, "builder")).toBe("x7mh4d-builder")
    expect(managerOf(agents, "ops")).toBe("ops")
  })

  test("an ended or parked entry never holds the seat", () => {
    const agents = [
      agent("x7mh4d-builder", "ended", "builder"),
      agent("k3v9q2-builder", "parked", "builder"),
    ]
    expect(managerOf(agents, "builder")).toBe("builder")
  })

  test("a starting entry waits behind a live one, and holds the seat when none is", () => {
    const agents = [
      agent("x7mh4d-builder", "working", "builder"),
      agent("k3v9q2-builder", "starting", "builder"),
    ]
    expect(managerOf(agents, "builder")).toBe("x7mh4d-builder")
    expect(managerOf([agents[1]!, agent(OLD.builder, "ended")], "builder")).toBe("k3v9q2-builder")
  })

  test("an entry that does not read is passed by", () => {
    expect(
      managerOf(
        [null, 3, { kind: "builder" }, agent("x7mh4d-builder", "working", "builder")],
        "builder",
      ),
    ).toBe("x7mh4d-builder")
  })
})

describe("seatOf", () => {
  test("an orchestrator holds no seat, however many run, and a running Builder keeps its own", () => {
    const agents = [
      agent("builder", "working", "builder"),
      agent("c8m3nr-orchestrator", "working", "orchestrator"),
      agent("d9p4qs-orchestrator", "working"),
    ]
    expect(seatOf(agents, "orchestrator")).toBeUndefined()
    expect(seatOf(agents, "builder")).toBe("builder")
    expect(kindOfName("c8m3nr-orchestrator")).toBe("orchestrator")
    expect(factoryRoleOf("c8m3nr-orchestrator", "orchestrator")).toBe("lead")
  })
})

describe("the kind a name gives", () => {
  test.each([
    ["k3m9px-worker", "worker"],
    ["b7k2mq-reviewer", "reviewer"],
    ["k3m9px-planner", "planner"],
    ["worker-brave-otter", "worker"],
    ["reviewer-greed-97", "reviewer"],
    ["probe-sdk", "probe"],
    ["k3m9px-wizard", null],
    ["kemapx-worker", null],
    ["k3m9p-worker", null],
    [OLD.builder, null],
    ["notes", null],
  ])("%s gives %p", (name, kind) => {
    expect<string | null>(kindOfName(name)).toBe(kind)
  })
})

describe("kindOf", () => {
  test("the roster's kind first, else the name's", () => {
    expect(kindOf("b7k2mq-reviewer", "tester")).toBe("tester")
    expect(kindOf("b7k2mq-reviewer", undefined)).toBe("reviewer")
    expect(kindOf("worker-greed", "nonsense")).toBe("worker")
    expect(kindOf("merritt", null)).toBeNull()
  })
})

describe("hasManagerRole", () => {
  test("the roster's manager role, wider than the four seats", () => {
    expect(hasManagerRole("dispatcher")).toBe(true)
    expect(hasManagerRole("orchestrator")).toBe(true)
    expect(hasManagerRole("ops")).toBe(true)
    expect(hasManagerRole("runner")).toBe(false)
    expect(hasManagerRole("worker")).toBe(false)
  })
})

describe("factoryRoleOf", () => {
  test("the roster's kind for the name first, else the name, else no role", () => {
    expect(factoryRoleOf("x7mh4d-builder", "builder")).toBe("lead")
    expect(factoryRoleOf("worker-brave-otter", "reviewer")).toBe("reviewer")
    expect(factoryRoleOf("worker-brave-otter", undefined)).toBe("worker")
    expect(factoryRoleOf(`${OLD.dispatcher}-2`, "not a kind")).toBe("dispatcher")
    expect(factoryRoleOf(OLD.builder, undefined)).toBe("lead")
    expect(factoryRoleOf("fix the sidebar", undefined)).toBe("")
    expect(factoryRoleOf("", undefined)).toBe("")
  })

  test("an <id>-<kind> name with no roster kind takes its kind's role", () => {
    expect(factoryRoleOf("x7mh4d-builder", undefined)).toBe("lead")
    expect(factoryRoleOf("x7mh4d-dispatcher", undefined)).toBe("dispatcher")
    expect(factoryRoleOf("k3m9px-researcher", undefined)).toBe("worker")
    expect(factoryRoleOf("b7k2mq-reviewer", undefined)).toBe("reviewer")
  })
})

describe("a session places by its <id>-<kind> name, else its set name or alias (PG-1644)", () => {
  test.each([
    ["x7mh4d-builder", "builder"],
    ["x7mh4d-ops", "ops"],
    ["x7mh4d-planner", "planner"],
    ["x7mh4d-optimizer", "optimizer"],
    [OLD.builder, "builder"],
    [OLD.ops, "ops"],
    [OLD.planner, "planner"],
    ["optimizer", "optimizer"],
    ["builder", "builder"],
    ["ops", "ops"],
  ])("%s holds the %s seat with no roster row", (name, kind) => {
    expect<string | null>(managerKindOfName(name)).toBe(kind)
  })

  test("a name that only starts with a manager's kind is no manager", () => {
    for (const name of [
      "ops-dashboard",
      "ops-localci",
      "k3m9px-worker",
      OLD.dispatcher,
      "dispatcher",
    ])
      expect(managerKindOfName(name)).toBeNull()
  })

  test("a kindless <id>-<kind> entry holds its seat", () => {
    expect(managerOf([agent("x7mh4d-builder", "working")], "builder")).toBe("x7mh4d-builder")
    expect(managerOf([agent("k3v9q2-ops", "working")], "ops")).toBe("k3v9q2-ops")
  })

  test("a fresh install places the role words and no old name", () => {
    setSessionNames(DEFAULT_SESSION_NAMES)
    expect(managerKindOfName("builder")).toBe("builder")
    expect(managerKindOfName(OLD.builder)).toBeNull()
    expect(roleOfName("dispatcher")).toBe("dispatcher")
    expect(roleOfName("dispatcher-2")).toBe("dispatcher")
    expect(roleOfName(OLD.dispatcher)).toBe("")
  })

  test("each kind's role, by suffix and by alias", () => {
    for (const [name, role] of [
      ["x7mh4d-dispatcher", "dispatcher"],
      [OLD.dispatcher, "dispatcher"],
      [`${OLD.dispatcher}-2`, "dispatcher"],
      ["dispatcher", "dispatcher"],
      ["x7mh4d-ops", "lead"],
      [OLD.ops, "lead"],
      ["x7mh4d-optimizer", "lead"],
      ["optimizer", "lead"],
    ])
      expect(roleOfName(name!)).toBe(role!)
  })
})

describe("dispatcherOf: the dispatcher holding a slot", () => {
  test("sessions.names' dispatcher holds the first slot, with -2 the second, while the roster has none", () => {
    expect(dispatcherOf([], 1)).toBe("dispatcher")
    expect(dispatcherOf(undefined, 2)).toBe("dispatcher-2")
  })

  test("a dispatcher's set name or alias holds its slot by name, with -2 the second", () => {
    for (const [name, slot] of [
      ["dispatcher", 1],
      ["dispatcher-2", 2],
      [OLD.dispatcher, 1],
      [`${OLD.dispatcher}-2`, 2],
      ["q8r2tx-dispatcher", null],
      ["builder-2", null],
    ] as const)
      expect(slotOfName(name)).toBe(slot)
    expect(dispatcherLabelOfName(`${OLD.dispatcher}-2`)).toBe("Bravo")
    expect(dispatcherLabelOfName("dispatcher")).toBe("Alpha")
    expect(dispatcherLabelOfName(OLD.builder)).toBeUndefined()
  })

  test("an <id>-dispatcher takes the slot its entry names, the first by default", () => {
    const agents = [
      agent(OLD.dispatcher, "working", "dispatcher"),
      { ...agent("q8r2tx-dispatcher", "working", "dispatcher"), slot: 2 },
    ]
    expect(dispatcherOf(agents, 1)).toBe(OLD.dispatcher)
    expect(dispatcherOf(agents, 2)).toBe("q8r2tx-dispatcher")
    expect(dispatcherOf([agent("m4n7vw-dispatcher", "working")], 1)).toBe("m4n7vw-dispatcher")
    expect(dispatcherOf([agent("m4n7vw-dispatcher", "ended")], 1)).toBe("dispatcher")
  })
})
