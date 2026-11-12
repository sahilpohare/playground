import { describe, expect, test } from "bun:test"
import { join } from "node:path"

import { StatusIcon } from "../../../../../web/next/src/components/dashboard/worker-light"
import {
  checkedOf,
  DOWN_ICON,
  iconTone,
  lightOf,
  NO_PROGRESS_MS,
  PR_TONES,
  PROVIDER_ICONS,
  prTone,
  stateWords,
  STATES,
  STATUS_TONES,
  statusIcon,
  effortIcon,
  taskIcon,
  type LightFacts,
} from "../../../../../web/next/src/lib/status-icons"

// React and the icons resolve from web/next, which carries them; the tests folder does not.
type Node = unknown
const web = join(import.meta.dir, "../../../../../web/next")
const { createElement } = (await import(Bun.resolveSync("react", web))) as {
  createElement: (type: unknown, props?: unknown) => Node
}
const { renderToStaticMarkup } = (await import(Bun.resolveSync("react-dom/server", web))) as {
  renderToStaticMarkup: (node: Node) => string
}
const icons = (await import(Bun.resolveSync("@remixicon/react", web))) as Record<
  string,
  ReturnType<typeof statusIcon>["Icon"]
>

// Worker Lights, most urgent first: each state's icon, its colour token, its words, and whether it spins.
const SET = [
  ["stuck", "RiAlarmWarningLine", "text-destructive", "Stuck", false],
  ["usage-limit", "RiPauseLine", "text-inactive", "Paused · usage limit", false],
  ["merged", "RiCheckboxCircleLine", "text-success", "Merged", false],
  ["down", "RiShutDownLine", "text-destructive", "Down", false],
  ["ended", "RiShutDownLine", "text-inactive", "Ended", false],
  ["failing", "RiErrorWarningLine", "text-destructive", "Failing", false],
  ["no-progress", "RiTimeLine", "text-destructive", "No progress", false],
  ["fixing", "RiLoader4Line", "text-caution", "Fixing", true],
  ["working", "RiLoader4Line", "text-info", "Working", true],
  ["waiting", "RiSearchEyeLine", "text-caution", "Waiting", false],
  ["approval", "RiUserLine", "text-caution", "Waiting on approvals", false],
  ["approvals", "RiGroupLine", "text-caution", "Waiting on approvals", false],
  ["ready", "RiZzzLine", "text-success", "Ready", false],
  ["parked", "RiPauseCircleLine", "text-inactive", "Parked", false],
  ["unknown", "RiQuestionLine", "text-inactive", "State unknown", false],
  ["idle", "RiCheckboxBlankCircleLine", "text-inactive", "Idle", false],
  ["done", "RiCheckboxCircleLine", "text-success", "Done", false],
] as const

describe("statusIcon", () => {
  test("the set in its order of urgency, each state's Remix icon, colour token, words and spin", () => {
    expect(STATES).toEqual(SET.map(([state]) => state))
    for (const [state, icon, tone, label, spins] of SET) {
      expect(statusIcon(state).Icon).toBe(icons[icon]!)
      expect(iconTone(state)).toBe(tone)
      expect(statusIcon(state).label).toBe(label)
      expect(statusIcon(state).spins).toBe(spins)
    }
  })

  test("every colour comes from the theme's tokens, one palette", () => {
    expect(STATES.map((state) => iconTone(state))).toEqual(
      STATES.map((state) => STATUS_TONES[statusIcon(state).tone]),
    )
    expect(Object.values(STATUS_TONES).every((c) => /^text-[a-z]+$/.test(c))).toBe(true)
  })

  test("Down and Ended share the power icon, behind one constant", () => {
    expect(statusIcon("down").Icon).toBe(DOWN_ICON)
    expect(statusIcon("ended").Icon).toBe(DOWN_ICON)
  })
})

type Agent = Parameters<typeof prTone>[0]
type Pull = NonNullable<Agent["pr"]>

const pull = (fields: Partial<Pull> = {}): Pull => ({
  approvals: 0,
  ci: "passing",
  draft: false,
  number: 97,
  queued: false,
  reviewed: false,
  round: null,
  score: null,
  state: "open",
  tester: null,
  title: "",
  updatedAt: null,
  url: "https://github.com/o/r/pull/97",
  verdict: null,
  ...fields,
})

const agent = (fields: Partial<Agent> = {}): Agent => ({
  branch: null,
  branchTicket: null,
  eta: null,
  kind: null,
  lastActivityAt: null,
  name: "worker-greed",
  parked: null,
  pr: pull(),
  pullProblem: null,
  report: null,
  role: "worker",
  schedule: null,
  sessionId: "s-greed",
  state: "working",
  status: null,
  task: null,
  ticket: null,
  title: null,
  worker: null,
  workspace: null,
  ...fields,
})

describe("lightOf", () => {
  const light = (facts: Partial<LightFacts>) => lightOf({ light: "idle", ...facts })

  // A Codex session writes no state record, so its idle is never known: it reads State unknown where it would read Idle, and every other light still shows over it.
  test("State unknown: a session whose state no record tells, where it would read Idle", () => {
    expect(light({ light: "unknown" })).toBe("unknown")
    expect(light({ light: "unknown", parked: "held" })).toBe("parked")
    expect(light({ light: "unknown", waits: ["inbox"] })).toBe("waiting")
    expect(light({ light: "unknown", pr: pull({ score: "5/5" }) })).toBe("ready")
    expect(light({ light: "unknown", pr: pull({ approvals: 1 }) })).toBe("approval")
    expect(light({ checked: true, light: "unknown" })).toBe("done")
    expect(light({ light: "unknown", pr: pull({ state: "merged" }) })).toBe("merged")
    expect(light({ failed: true, light: "unknown" })).toBe("failing")
    expect(stateWords("unknown", {})).toBe("State unknown")
  })

  test("Stuck: a prompt, picker, plan or blocking screen holds it, over everything else", () => {
    expect(light({ light: "needs-you" })).toBe("stuck")
    expect(light({ failed: true, light: "needs-you", pr: pull({ state: "merged" }) })).toBe("stuck")
  })

  // A usage limit is no emergency: it alone holds it, so it waits on the reset, not a person.
  test("Paused · usage limit: a session the usage limit alone holds is gray, not the red alarm", () => {
    const limit = { resets: "3am (Asia/Calcutta)", resetsAt: null }
    expect(light({ light: "needs-you", usageLimit: limit })).toBe("usage-limit")
    expect(light({ light: "needs-you", usageLimit: null })).toBe("stuck")
    expect(light({ light: "working", usageLimit: limit })).toBe("working")
  })

  test("Merged: its pull request merged, even once its session has gone", () => {
    expect(light({ pr: pull({ state: "merged" }) })).toBe("merged")
    expect(light({ light: "down", pr: pull({ state: "merged" }) })).toBe("merged")
  })

  test("Down: gone without being closed; Ended, gray, when the roster closed it on purpose; Parked, gray, when the roster parked it", () => {
    expect(light({ light: "down" })).toBe("down")
    expect(light({ ended: true, light: "down" })).toBe("ended")
    expect(light({ ended: true, light: "working" })).toBe("working")
    expect(light({ rosterParked: true, light: "down" })).toBe("parked")
  })

  test("Failing: its newest reply is an API error, whatever it was doing", () => {
    expect(light({ failed: true })).toBe("failing")
    expect(light({ failed: true, light: "working" })).toBe("failing")
  })

  test("No progress: busy with no transcript line for over 30 minutes", () => {
    expect(light({ idleFor: NO_PROGRESS_MS + 1, light: "working" })).toBe("no-progress")
    expect(light({ idleFor: NO_PROGRESS_MS, light: "working" })).toBe("working")
    expect(light({ idleFor: NO_PROGRESS_MS + 1 })).toBe("idle")
  })

  test("Fixing: at work on an open pull request whose CI fails or whose review is below 5/5", () => {
    expect(light({ light: "working", pr: pull({ ci: "failing" }) })).toBe("fixing")
    expect(light({ light: "working", pr: pull({ reviewed: true, score: "3/5" }) })).toBe("fixing")
    // a push leaves the score behind: the newest verdict, at an older head, still says below 5/5
    expect(
      light({ light: "working", pr: pull({ reviewed: true, score: null, verdict: "4/5" }) }),
    ).toBe("fixing")
    // a canary merge after a 5/5 is not a fix
    expect(
      light({ light: "working", pr: pull({ reviewed: true, score: null, verdict: "5/5" }) }),
    ).toBe("working")
    expect(light({ light: "working", pr: pull({ reviewed: true, score: "5/5" }) })).toBe("working")
    expect(light({ light: "working", pr: pull() })).toBe("working")
  })

  test("Working: the session is busy", () => {
    expect(light({ light: "working" })).toBe("working")
    expect(light({ light: "working", waits: ["checks"] })).toBe("working")
  })

  test("Waiting: idle with something still open", () => {
    for (const wait of ["checks", "ci", "queue", "helper", "job", "inbox"] as const)
      expect(light({ waits: [wait] })).toBe("waiting")
    expect(light({ pr: pull({ approvals: 2 }), waits: ["checks"] })).toBe("waiting")
  })

  test("Waiting on approvals: one person for one still needed, a group for two or more", () => {
    expect(light({ pr: pull({ approvals: 1, score: "5/5" }) })).toBe("approval")
    expect(light({ pr: pull({ approvals: 2 }) })).toBe("approvals")
  })

  test("Ready: idle at 5/5 on its head, CI green or none, no approval missing", () => {
    expect(light({ pr: pull({ score: "5/5" }) })).toBe("ready")
    expect(light({ pr: pull({ ci: "none", score: "5/5" }) })).toBe("ready")
    expect(light({ pr: pull({ ci: "failing", score: "5/5" }) })).toBe("idle")
    expect(light({ pr: pull({ score: "4/5" }) })).toBe("idle")
  })

  test("Parked: its pull request is on the held list", () => {
    expect(light({ parked: "held for the weekly reset" })).toBe("parked")
    expect(light({ parked: "held", pr: pull({ score: "5/5" }) })).toBe("ready")
  })

  test("Idle: nothing running and nothing waiting; a closed pull request is not work", () => {
    expect(light({})).toBe("idle")
    expect(light({ pr: pull({ state: "closed" }) })).toBe("idle")
  })

  test("a reviewer or tester idle after its verdict at the head is done", () => {
    expect(light({ checked: true })).toBe("done")
    expect(light({ checked: true, light: "working" })).toBe("working")
    expect(checkedOf(agent({ name: "reviewer-greed", pr: pull({ score: "5/5" }) }))).toBe(true)
    expect(checkedOf(agent({ name: "reviewer-greed", pr: pull({ score: "4/5" }) }))).toBe(false)
    expect(checkedOf(agent({ name: "tester-greed", pr: pull({ tester: "pass" }) }))).toBe(true)
    expect(checkedOf(agent({ name: "tester-greed", pr: pull({ tester: "fail" }) }))).toBe(false)
    expect(checkedOf(agent({ pr: pull({ score: "5/5" }) }))).toBe(false)
  })
})

describe("stateWords", () => {
  test("Playground's own Stuck is on you; any other session's reads Stuck", () => {
    expect(stateWords("stuck", { dispatcher: true })).toBe("Waiting on you")
    expect(stateWords("stuck", {})).toBe("Stuck")
  })

  test("Waiting names what it waits on first", () => {
    expect(stateWords("waiting", { waits: ["checks", "ci"] })).toBe("Waiting on checks")
    expect(stateWords("waiting", { waits: ["inbox"] })).toBe("Waiting on your inbox")
    expect(stateWords("approvals", {})).toBe("Waiting on approvals")
  })
})

describe("prTone", () => {
  const tone = (fields: Partial<Pull>) => prTone(agent({ pr: pull(fields) }))

  test("red while CI fails, whatever the score", () => {
    expect(tone({ ci: "failing" })).toBe("failing")
    expect(tone({ ci: "failing", score: "5/5" })).toBe("failing")
    expect(tone({ ci: "failing", draft: true })).toBe("failing")
  })

  test("orange in review, a draft under review included, and still after a push leaves its score behind", () => {
    expect(tone({})).toBe("review")
    expect(tone({ ci: "pending", reviewed: true, score: "3/5" })).toBe("review")
    expect(tone({ draft: true, reviewed: true, score: "4/5" })).toBe("review")
    expect(tone({ draft: true, reviewed: true, score: null })).toBe("review")
  })

  test("gray for a draft not reviewed yet", () => {
    expect(tone({ draft: true })).toBe("draft")
  })

  test("green when Ready at 5/5 on its head, and once merged", () => {
    expect(tone({ score: "5/5" })).toBe("ready")
    expect(tone({ draft: true, score: "5/5" })).toBe("ready")
    expect(tone({ ci: "failing", state: "merged" })).toBe("merged")
    expect(tone({ state: "closed" })).toBe("closed")
  })

  test("only a worker's own pull request colours it: none for no PR, a checker, a manager or a runner", () => {
    expect(prTone(agent({ pr: null }))).toBeNull()
    expect(prTone(agent({ name: "reviewer-greed" }))).toBeNull()
    expect(prTone(agent({ name: "tester-greed" }))).toBeNull()
    expect(prTone(agent({ name: "lead-a", role: "manager" }))).toBeNull()
    expect(prTone(agent({ name: "runner-greed", role: "runner" }))).toBeNull()
  })

  test("every colour is said in words, and green, orange, red and gray come from the theme's tokens", () => {
    expect(Object.fromEntries(Object.entries(PR_TONES).map(([k, v]) => [k, v.words]))).toEqual({
      closed: "PR closed",
      draft: "PR draft, not reviewed yet",
      failing: "PR CI failing",
      merged: "PR merged",
      ready: "PR ready: 5/5 at its head",
      review: "PR in review",
    })
    expect(PR_TONES.failing.className).toBe("text-destructive")
    expect(PR_TONES.review.className).toBe("text-caution")
    expect(PR_TONES.draft.className).toBe("text-inactive")
    expect(PR_TONES.ready.className).toBe("text-success")
    expect(PR_TONES.merged.className).toBe("text-success")
  })
})

const html = (type: unknown, props: unknown) => renderToStaticMarkup(createElement(type, props))

describe("StatusIcon, which the sidebar and the status table both draw", () => {
  test("every state, in its colour, out of the accessibility tree", () => {
    for (const [state, , tone] of SET) {
      const icon = html(StatusIcon, { state })
      expect(icon).toContain(tone)
      expect(icon).toContain('aria-hidden="true"')
    }
  })

  test("only Working and Fixing spin, and neither while the live feed is lost", () => {
    expect(html(StatusIcon, { state: "working" })).toContain("animate-spin")
    expect(html(StatusIcon, { state: "fixing" })).toContain("animate-spin")
    expect(html(StatusIcon, { state: "working", still: true })).not.toContain("animate-spin")
    expect(html(StatusIcon, { state: "fixing", still: true })).not.toContain("animate-spin")
    expect(html(StatusIcon, { state: "idle" })).not.toContain("animate-spin")
  })
})

// A row's icons: what a session does while it works, and how hard it thinks.
describe("taskIcon", () => {
  test("while the light works or fixes, a kind with a task draws its task icon", () => {
    for (const state of ["working", "fixing"] as const) {
      expect(taskIcon("worker", state)).toBe(icons.RiHammerFill!)
      expect(taskIcon("researcher", state)).toBe(icons.RiGlobalFill!)
      expect(taskIcon("reviewer", state)).toBe(icons.RiEyeFill!)
      expect(taskIcon("tester", state)).toBe(icons.RiTestTubeFill!)
    }
  })

  test("any other light, a kind with no task, or no kind keeps the light", () => {
    for (const state of STATES.filter((s) => s !== "working" && s !== "fixing"))
      expect(taskIcon("worker", state)).toBeNull()
    for (const kind of ["dispatcher", "planner", "runner", "probe", "ops"] as const)
      expect(taskIcon(kind, "working")).toBeNull()
    expect(taskIcon(null, "working")).toBeNull()
  })
})

describe("PROVIDER_ICONS", () => {
  test("Anthropic draws Remix's Anthropic mark, and Z.ai ZeroSDK's Z, not Zhipu's badge", () => {
    expect(PROVIDER_ICONS.anthropic).toBe(icons.RiAnthropicFill!)
    expect(PROVIDER_ICONS.zai).not.toBe(icons.RiZhipuAiFill!)
    const zai = html(PROVIDER_ICONS.zai, { className: "size-4" })
    expect(zai).toContain('viewBox="0 0 40 40"')
    expect(zai).toContain('d="M20.1312 7.50002L17.4088 11.1913H5.81625')
    expect(zai).toContain('class="size-4"')
  })
})

describe("effortIcon", () => {
  test("an effort, low to max, to its signal or skull, and none for any other", () => {
    expect(effortIcon("low")).toBe(icons.RiSignalCellular1Fill!)
    expect(effortIcon("medium")).toBe(icons.RiSignalCellular2Fill!)
    expect(effortIcon("high")).toBe(icons.RiSignalCellular3Fill!)
    expect(effortIcon("xhigh")).toBe(icons.RiSkullFill!)
    expect(effortIcon("max")).toBe(icons.RiSkull2Fill!)
    expect(effortIcon("ultra")).toBeNull()
    expect(effortIcon("toString")).toBeNull()
    expect(effortIcon(null)).toBeNull()
  })
})

describe("StatusIcon with a kind", () => {
  const pathOf = (name: string) => /<path d="([^"]+)"/.exec(html(icons[name], {}))?.[1] ?? ""

  test("a working worker draws the hammer in Working's tone, still, and an idle one its light", () => {
    const working = html(StatusIcon, { kind: "worker", state: "working" })
    expect(working).toContain(pathOf("RiHammerFill"))
    expect(working).toContain("text-info")
    expect(working).not.toContain("animate-spin")
    expect(working).toContain('aria-hidden="true"')
    expect(html(StatusIcon, { kind: "reviewer", state: "fixing" })).toContain("text-caution")
    expect(html(StatusIcon, { kind: "worker", state: "idle" })).toBe(
      html(StatusIcon, { state: "idle" }),
    )
    expect(html(StatusIcon, { kind: "runner", state: "working" })).toContain("animate-spin")
  })
})
