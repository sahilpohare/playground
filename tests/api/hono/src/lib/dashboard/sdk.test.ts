import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"

import type {
  Options,
  SDKMessage,
  SDKUserMessage,
} from "../../../../../../api/hono/node_modules/@anthropic-ai/claude-agent-sdk"
import type { Delivery } from "../../../../../../api/hono/src/lib/dashboard/deliver"
import type { FeedAnswer } from "../../../../../../api/hono/src/lib/dashboard/feed"
import {
  answerHosted,
  askOf,
  changeHostedMode,
  changeHostedSetting,
  hostedEnv,
  hostedSettings,
  hosts,
  resultOf,
  SDK_PROBE,
  SdkHost,
  sendToHosted,
  SESSION_FILE,
  startSdkProbe,
  TIMED_OUT,
  transcriptOf,
  type HostDeps,
  type HostedMode,
} from "../../../../../../api/hono/src/lib/dashboard/sdk"
import type { SessionSetting } from "../../../../../../api/hono/src/lib/dashboard/setting"
import {
  hostedNow,
  hostSessions,
  withHosted,
  type Live,
} from "../../../../../../api/hono/src/lib/dashboard/workers"
import { dataDir } from "../../../../../../api/hono/src/lib/sessions/paths"

const AT = "2026-10-08T12:00:00.000Z"
const actor = { email: "owner@local.host", id: "u-1" }
const owner = { role: "owner" }
const question = {
  questions: [
    {
      header: "Size",
      multiSelect: false,
      options: [
        { description: "Small", label: "S" },
        { description: "Large", label: "L" },
      ],
      question: "Which size?",
    },
  ],
}

// A stand-in for the SDK's query(): it records the options it was given, every message put on the input and every mode, model and effort set, and ends a turn for each message. A message `report:<mode>` has the session report that mode itself, as its status message does when it leaves plan mode, and `init:<model>` has it report its model as its init message does.
function fakeQuery({ refuseMode = false, refuseSetting = false } = {}) {
  const calls: { modes: string[]; options: Options; sent: string[]; settings: string[] }[] = []
  const run = ({
    options,
    prompt,
  }: {
    options: Options
    prompt: AsyncIterable<SDKUserMessage>
  }) => {
    const call = { modes: [] as string[], options, sent: [] as string[], settings: [] as string[] }
    calls.push(call)
    const stream = (async function* () {
      for await (const message of prompt) {
        const text = String(message.message.content)
        call.sent.push(text)
        if (text.startsWith("report:")) {
          const permissionMode = text.slice("report:".length)
          yield { permissionMode, status: null, subtype: "status", type: "system" } as SDKMessage
        }
        if (text.startsWith("init:")) {
          yield { model: text.slice("init:".length), subtype: "init", type: "system" } as SDKMessage
        }
        yield { type: "assistant" } as SDKMessage
        yield { type: "result" } as SDKMessage
      }
    })()
    return Object.assign(stream, {
      setPermissionMode: async (mode: string) => {
        if (refuseMode) throw new Error("the session refused the mode")
        call.modes.push(mode)
      },
      applyFlagSettings: async ({ effortLevel }: { effortLevel: string }) => {
        if (refuseSetting) throw new Error("the session refused the effort")
        call.settings.push(`effort ${effortLevel}`)
      },
      setModel: async (model: string) => {
        if (refuseSetting) throw new Error("the session refused the model")
        call.settings.push(`model ${model}`)
      },
    })
  }
  return { calls, query: run as unknown as HostDeps["query"] }
}

const CLAUDE = "/usr/local/bin/claude"

const deps = (query: HostDeps["query"], timeoutMs = 60_000, transcripts = true): HostDeps => ({
  exists: () => transcripts,
  now: () => new Date(AT),
  query,
  timeoutMs,
})

const scratch = () => mkdtempSync(join(tmpdir(), "dashboard-sdk-"))

const signal = () => new AbortController().signal

describe("askOf", () => {
  test("AskUserQuestion is a picker card, its options by label", () => {
    expect(askOf("AskUserQuestion", question, "r-1", AT)).toEqual({
      at: AT,
      kind: "question",
      questions: [
        {
          header: "Size",
          multiSelect: false,
          options: [
            { description: "Small", label: "S" },
            { description: "Large", label: "L" },
          ],
          prompt: "Which size?",
        },
      ],
      requestId: "r-1",
    })
  })

  test("ExitPlanMode is a plan card", () => {
    expect(askOf("ExitPlanMode", { plan: "1. Do it" }, "r-2", AT)).toMatchObject({
      kind: "plan",
      plan: "1. Do it",
      whole: true,
    })
  })

  test("any other tool is a permission card with the command it would run", () => {
    expect(askOf("Bash", { command: "ls -la", description: "List" }, "r-3", AT)).toMatchObject({
      description: "List",
      detail: "ls -la",
      kind: "permission",
      tool: "Bash",
      whole: true,
    })
  })
})

describe("resultOf", () => {
  const picker = askOf("AskUserQuestion", question, "r-1", AT)!
  const tool = askOf("Bash", { command: "ls" }, "r-2", AT)!
  const plan = askOf("ExitPlanMode", { plan: "p" }, "r-3", AT)!

  test("a picker is allowed with each answer by its question", () => {
    expect(
      resultOf(picker, question, { kind: "question", requestId: "r-1", selections: ["L"] }),
    ).toEqual({
      behavior: "allow",
      updatedInput: { ...question, answers: { "Which size?": "L" } },
    })
  })

  test("a tool runs once with its own input, or is denied", () => {
    expect(
      resultOf(tool, { command: "ls" }, { kind: "permission", mode: "once", requestId: "r-2" }),
    ).toEqual({
      behavior: "allow",
      updatedInput: { command: "ls" },
    })
    expect(
      resultOf(tool, { command: "ls" }, { kind: "permission", mode: "deny", requestId: "r-2" }),
    ).toMatchObject({
      behavior: "deny",
    })
  })

  test("a plan starts, or goes back with the note", () => {
    expect(
      resultOf(
        plan,
        { plan: "p" },
        { feedback: null, kind: "plan", mode: "manual", requestId: "r-3" },
      ),
    ).toEqual({ behavior: "allow", updatedInput: { plan: "p" } })
    expect(
      resultOf(
        plan,
        { plan: "p" },
        { feedback: "smaller", kind: "plan", mode: "deny", requestId: "r-3" },
      ),
    ).toEqual({ behavior: "deny", message: "smaller" })
  })
})

describe("the hosted session's start", () => {
  test("a first start names a new session and keeps its id; a restart resumes that id", () => {
    const dir = scratch()
    try {
      const first = fakeQuery()
      new SdkHost(deps(first.query)).start(dir, CLAUDE, "default")
      const id = readFileSync(join(dir, SESSION_FILE), "utf8").trim()
      expect(first.calls[0]?.options).toMatchObject({
        cwd: dir,
        extraArgs: { name: SDK_PROBE },
        includePartialMessages: true,
        pathToClaudeCodeExecutable: CLAUDE,
        permissionMode: "default",
        sessionId: id,
        settings: { crossSessionInbound: "accept" },
      })
      // the session gets the allowlist, never the API's whole environment, which the SDK would pass on when env is left out
      expect(first.calls[0]?.options.env).toEqual(hostedEnv())
      expect(first.calls[0]?.options.resume).toBeUndefined()
      const again = fakeQuery()
      new SdkHost(deps(again.query)).start(dir, CLAUDE, "default")
      expect(again.calls[0]?.options).toMatchObject({ resume: id })
      expect(again.calls[0]?.options.sessionId).toBeUndefined()
    } finally {
      rmSync(dir, { force: true, recursive: true })
    }
  })

  test("a restart before its first message starts the same id afresh, since a session with no transcript cannot be resumed", () => {
    const dir = scratch()
    try {
      new SdkHost(deps(fakeQuery().query, 60_000, false)).start(dir, CLAUDE, "default")
      const id = readFileSync(join(dir, SESSION_FILE), "utf8").trim()
      const again = fakeQuery()
      new SdkHost(deps(again.query, 60_000, false)).start(dir, CLAUDE, "default")
      expect(again.calls[0]?.options).toMatchObject({ sessionId: id })
      expect(again.calls[0]?.options.resume).toBeUndefined()
    } finally {
      rmSync(dir, { force: true, recursive: true })
    }
  })

  test("with no claude on PATH it starts nothing, rather than let the SDK run a copy of its own", () => {
    const dir = scratch()
    try {
      const { calls, query } = fakeQuery()
      startSdkProbe(dir, new SdkHost(deps(query)), null)
      expect(calls).toHaveLength(0)
    } finally {
      hostSessions(() => [])
      rmSync(dir, { force: true, recursive: true })
    }
  })

  test("it runs with the factory's settings and takes peers' messages", () => {
    const dir = scratch()
    try {
      const path = join(dir, "factory-settings.json")
      writeFileSync(path, JSON.stringify({ autoMemoryEnabled: false, hooks: { PreToolUse: [] } }))
      expect(hostedSettings(path)).toEqual({
        autoMemoryEnabled: false,
        crossSessionInbound: "accept",
        hooks: { PreToolUse: [] },
      })
      expect(hostedSettings(join(dir, "missing.json"))).toEqual({ crossSessionInbound: "accept" })
    } finally {
      rmSync(dir, { force: true, recursive: true })
    }
  })

  test("it runs on the login alone, and takes none of the API's .env, session or terminal", () => {
    const env = hostedEnv(
      {
        ANTHROPIC_API_KEY: "k",
        ANTHROPIC_AUTH_TOKEN: "t",
        BETTER_AUTH_SECRET: "s",
        CLAUDECODE: "1",
        CLAUDE_CODE_SESSION_ID: "s",
        CLAUDE_CONFIG_DIR: "/c",
        CMUX_SURFACE_ID: "x",
        PLAYGROUND_SDK_PROBE_DIR: "/p",
        HOME: "/h",
        NODE_ENV: "local",
        PATH: "/bin",
        PLAYGROUND_DATA_DIR: "/machine-data",
        POSTGRES_URL: "postgresql://dashboard",
      },
      "/stack-data",
    )
    expect(env).toEqual({
      CLAUDE_CONFIG_DIR: "/c",
      HOME: "/h",
      PLAYGROUND_DATA_DIR: "/stack-data",
      PLAYGROUND_ROLE: "probe",
      PATH: "/bin",
    })
  })

  // a fixture stack's hosted session kept the machine's real HOME and no data folder of its own, so the ops notify script it ran queued its line in the machine's own data folder, which the machine's own relay delivered (#1564)
  test("on a stack that does not read this machine, the session's data folder is the stack's own, never the machine's", () => {
    const own = dataDir()
    expect(own).not.toBe(join(homedir(), ".playground"))
    expect(hostedEnv({ HOME: homedir(), PATH: "/bin" }).PLAYGROUND_DATA_DIR).toBe(own)
  })

  test("a reload under bun --hot lists the running session again rather than starting another", () => {
    const dir = scratch()
    try {
      const { calls, query } = fakeQuery()
      const host = new SdkHost(deps(query))
      startSdkProbe(dir, host, CLAUDE)
      expect(hostedNow().map((h) => h.worker.name)).toEqual([SDK_PROBE])
      // a reload runs workers.ts again, whose list starts empty
      hostSessions(() => [])
      startSdkProbe(dir, host, CLAUDE)
      expect(hostedNow().map((h) => h.worker.name)).toEqual([SDK_PROBE])
      expect(calls).toHaveLength(1)
    } finally {
      hostSessions(() => [])
      rmSync(dir, { force: true, recursive: true })
    }
  })

  test("it starts in the mode it is given, with bypass allowed so the picker can switch to it, and its row says which", () => {
    const dir = scratch()
    try {
      const { calls, query } = fakeQuery()
      const host = new SdkHost(deps(query))
      host.start(dir, CLAUDE, "bypassPermissions")
      expect(calls[0]?.options).toMatchObject({
        allowDangerouslySkipPermissions: true,
        permissionMode: "bypassPermissions",
      })
      expect(host.worker()).toMatchObject({ permissionMode: "bypassPermissions" })
    } finally {
      rmSync(dir, { force: true, recursive: true })
    }
  })

  test("the probe starts in the mode its setting names", () => {
    const dir = scratch()
    try {
      const { calls, query } = fakeQuery()
      startSdkProbe(dir, new SdkHost(deps(query)), CLAUDE, "plan")
      expect(calls[0]?.options.permissionMode).toBe("plan")
    } finally {
      hostSessions(() => [])
      rmSync(dir, { force: true, recursive: true })
    }
  })

  test("a restart that picks the session up again records its mode reset to the setting's, in words; a first start records nothing", async () => {
    const dir = scratch()
    try {
      const rows: { action: string; actor: unknown; summary: string }[] = []
      const record = async (event: (typeof rows)[number]) => {
        rows.push(event)
      }
      startSdkProbe(dir, new SdkHost(deps(fakeQuery().query)), CLAUDE, "bypassPermissions", record)
      await Bun.sleep(0)
      expect(rows).toEqual([])
      hostSessions(() => [])
      startSdkProbe(dir, new SdkHost(deps(fakeQuery().query)), CLAUDE, "bypassPermissions", record)
      await Bun.sleep(0)
      expect(rows).toEqual([
        {
          action: "dashboard.mode",
          actor: { label: "Dashboard" },
          summary: `Reset ${SDK_PROBE}'s permission mode to Bypass permissions after a restart`,
        },
      ])
    } finally {
      hostSessions(() => [])
      rmSync(dir, { force: true, recursive: true })
    }
  })

  test("its folder is resolved to the real path Claude Code names the transcript from", () => {
    const dir = scratch()
    try {
      const host = new SdkHost(deps(fakeQuery().query))
      startSdkProbe(`${dir}/`, host, CLAUDE)
      const id = readFileSync(join(dir, SESSION_FILE), "utf8").trim()
      expect(host.transcript).toBe(transcriptOf(realpathSync(dir), id))
    } finally {
      hostSessions(() => [])
      rmSync(dir, { force: true, recursive: true })
    }
  })

  test("its transcript is where Claude Code writes one for its folder", () => {
    expect(transcriptOf("/Users/me/repo/.claude/worktrees/probe-sdk", "id-1", "/c")).toBe(
      "/c/projects/-Users-me-repo--claude-worktrees-probe-sdk/id-1.jsonl",
    )
  })
})

describe("the hosted session's prompts", () => {
  test("a prompt waits as a card in its row until the card's answer reaches the callback", async () => {
    const dir = scratch()
    try {
      const { calls, query } = fakeQuery()
      const host = new SdkHost(deps(query))
      host.start(dir, CLAUDE, "default")
      const asked = calls[0]!.options.canUseTool!("AskUserQuestion", question, {
        signal: signal(),
      } as never)
      const card = host.worker()!.feed[0]!
      expect(card.kind).toBe("question")
      // a probe's prompts are its spawner's: it never reads as waiting on you
      expect(host.worker()!.light).not.toBe("needs-you")
      const answer: FeedAnswer = { answers: [{ choices: ["S"], text: null }], kind: "question" }
      const recorded: string[] = []
      expect(
        await answerHosted(
          { actor, answer, approver: owner, requestId: card.requestId, sessionId: host.sessionId! },
          {
            approvals: false,
            host,
            now: () => new Date(AT),
            record: async (event, answering) => {
              recorded.push(event.summary)
              await answering()
            },
          },
        ),
      ).toEqual({ at: AT, ok: true })
      expect(await asked).toEqual({
        behavior: "allow",
        updatedInput: { ...question, answers: { "Which size?": "S" } },
      })
      expect(recorded).toEqual([`Answered ${SDK_PROBE}'s picker (1 question)`])
      expect(host.worker()!.feed).toEqual([])
    } finally {
      rmSync(dir, { force: true, recursive: true })
    }
  })

  test("a prompt whose call is cancelled is denied and its card goes, so a message can go again", async () => {
    const dir = scratch()
    try {
      const { calls, query } = fakeQuery()
      const host = new SdkHost(deps(query))
      host.start(dir, CLAUDE, "default")
      const abort = new AbortController()
      const asked = calls[0]!.options.canUseTool!("Bash", { command: "ls" }, {
        signal: abort.signal,
      } as never)
      expect(host.waiting()).toBe(true)
      abort.abort()
      expect(await asked).toMatchObject({ behavior: "deny" })
      expect(host.worker()!.feed).toEqual([])
      expect(host.waiting()).toBe(false)
    } finally {
      rmSync(dir, { force: true, recursive: true })
    }
  })

  test("when its process ends, the session leaves the board", async () => {
    const dir = scratch()
    try {
      const ended = (async function* () {})()
      const host = new SdkHost(deps((() => ended) as unknown as HostDeps["query"]))
      host.start(dir, CLAUDE, "default")
      await Bun.sleep(0)
      expect(host.worker()).toBeNull()
      expect(host.sessionId).toBeNull()
    } finally {
      rmSync(dir, { force: true, recursive: true })
    }
  })

  test("with approvals off a permission card is read-only, and the callback is denied once it times out", async () => {
    const dir = scratch()
    try {
      const { calls, query } = fakeQuery()
      const host = new SdkHost(deps(query, 20))
      host.start(dir, CLAUDE, "default")
      const asked = calls[0]!.options.canUseTool!("Bash", { command: "ls" }, {
        signal: signal(),
      } as never)
      const card = host.worker()!.feed[0]!
      const result = await answerHosted(
        {
          actor,
          answer: { kind: "permission", mode: "once" },
          approver: owner,
          requestId: card.requestId,
          sessionId: host.sessionId!,
        },
        { approvals: false, host, now: () => new Date(AT), record: async (_e, run) => run() },
      )
      expect(result).toMatchObject({ code: "DISABLED", ok: false })
      expect(await asked).toEqual({ behavior: "deny", message: TIMED_OUT })
      expect(host.worker()!.feed).toEqual([])
    } finally {
      rmSync(dir, { force: true, recursive: true })
    }
  })

  test("with approvals on the owner allows it once, and only the owner may", async () => {
    const dir = scratch()
    try {
      const { calls, query } = fakeQuery()
      const host = new SdkHost(deps(query))
      host.start(dir, CLAUDE, "default")
      const asked = calls[0]!.options.canUseTool!("Bash", { command: "ls" }, {
        signal: signal(),
      } as never)
      const requestId = host.worker()!.feed[0]!.requestId
      const on = {
        approvals: true,
        host,
        now: () => new Date(AT),
        record: async (_e: unknown, run: () => Promise<void>) => run(),
      }
      const answering = {
        actor,
        answer: { kind: "permission", mode: "once" } as FeedAnswer,
        requestId,
        sessionId: host.sessionId!,
      }
      expect(await answerHosted({ ...answering, approver: { role: "member" } }, on)).toMatchObject({
        code: "FORBIDDEN",
      })
      expect(await answerHosted({ ...answering, approver: owner }, on)).toEqual({
        at: AT,
        ok: true,
      })
      expect(await asked).toEqual({ behavior: "allow", updatedInput: { command: "ls" } })
      expect(await answerHosted({ ...answering, approver: owner }, on)).toMatchObject({
        code: "NOT_PENDING",
      })
    } finally {
      rmSync(dir, { force: true, recursive: true })
    }
  })
})

describe("changeHostedSetting", () => {
  const started = (options = {}) => {
    const dir = scratch()
    const fake = fakeQuery(options)
    const host = new SdkHost(deps(fake.query))
    host.start(dir, CLAUDE, "default")
    const recorded: string[] = []
    const on = {
      host,
      now: () => new Date(AT),
      record: async (event: { action: string; summary: string }, run: () => Promise<void>) => {
        await run()
        recorded.push(`${event.action}: ${event.summary}`)
      },
    }
    const changing = (setting: SessionSetting, sessionId = host.sessionId!) => ({
      actor,
      sessionId,
      setting,
    })
    return { changing, dir, fake, host, on, recorded }
  }

  test("a pick reaches the session through setModel or applyFlagSettings, never its input, and the row shows what it took", async () => {
    const { changing, dir, fake, host, on, recorded } = started()
    try {
      host.send("init:claude-opus-5-5")
      await Bun.sleep(0)
      expect(host.worker()).toMatchObject({ effort: null, model: "claude-opus-5-5" })
      expect(await changeHostedSetting(changing({ model: "sonnet" }), on)).toEqual({
        at: AT,
        ok: true,
        sessionId: host.sessionId!,
      })
      await changeHostedSetting(changing({ effort: "max" }), on)
      expect(fake.calls[0]!.settings).toEqual(["model sonnet", "effort max"])
      expect(fake.calls[0]!.sent).toEqual(["init:claude-opus-5-5"])
      expect(host.worker()).toMatchObject({ effort: "max", model: "sonnet" })
      expect(recorded).toEqual([
        `dashboard.setting: Set ${SDK_PROBE}'s model to sonnet`,
        `dashboard.setting: Set ${SDK_PROBE}'s effort to max`,
      ])
    } finally {
      rmSync(dir, { force: true, recursive: true })
    }
  })

  test("a session started again on the same host shows no model or effort from before", async () => {
    const { changing, dir, host, on } = started()
    try {
      await changeHostedSetting(changing({ model: "haiku" }), on)
      await changeHostedSetting(changing({ effort: "low" }), on)
      expect(host.worker()).toMatchObject({ effort: "low", model: "haiku" })
      host.start(dir, CLAUDE, "default")
      expect(host.worker()).toMatchObject({ effort: null, model: null })
    } finally {
      rmSync(dir, { force: true, recursive: true })
    }
  })

  test("a session not hosted gets NOT_FOUND, and a value the session refuses is not recorded and leaves the row as it was", async () => {
    const { changing, dir, fake, host, on, recorded } = started({ refuseSetting: true })
    try {
      expect(await changeHostedSetting(changing({ model: "haiku" }, "s-1"), on)).toMatchObject({
        code: "NOT_FOUND",
        ok: false,
      })
      await expect(changeHostedSetting(changing({ effort: "low" }), on)).rejects.toThrow("refused")
      expect(fake.calls[0]!.settings).toEqual([])
      expect(recorded).toEqual([])
      expect(host.worker()).toMatchObject({ effort: null, model: null })
    } finally {
      rmSync(dir, { force: true, recursive: true })
    }
  })
})

describe("changeHostedMode", () => {
  const started = (options = {}) => {
    const dir = scratch()
    const fake = fakeQuery(options)
    const host = new SdkHost(deps(fake.query))
    host.start(dir, CLAUDE, "default")
    const recorded: string[] = []
    const on = {
      approvals: true,
      host,
      now: () => new Date(AT),
      record: async (event: { action: string; summary: string }, run: () => Promise<void>) => {
        await run()
        recorded.push(`${event.action}: ${event.summary}`)
      },
    }
    const changing = (mode: HostedMode, over = {}) => ({
      actor,
      approver: owner,
      mode,
      sessionId: host.sessionId!,
      ...over,
    })
    return { changing, dir, fake, host, on, recorded }
  }

  test("the owner's pick reaches the session through setPermissionMode, and the row and the activity say from what to what", async () => {
    const { changing, dir, fake, host, on, recorded } = started()
    try {
      expect(await changeHostedMode(changing("plan"), on)).toEqual({
        at: AT,
        mode: "plan",
        ok: true,
      })
      expect(fake.calls[0]!.modes).toEqual(["plan"])
      expect(host.worker()).toMatchObject({ permissionMode: "plan" })
      expect(recorded).toEqual([
        `dashboard.mode: Changed ${SDK_PROBE}'s permission mode from Default to Plan`,
      ])
    } finally {
      rmSync(dir, { force: true, recursive: true })
    }
  })

  test("with approvals off, below the owner, or for a session not hosted, nothing reaches the session", async () => {
    const { changing, dir, fake, host, on, recorded } = started()
    try {
      expect(
        await changeHostedMode(changing("bypassPermissions"), { ...on, approvals: false }),
      ).toMatchObject({
        code: "DISABLED",
        ok: false,
      })
      expect(
        await changeHostedMode(changing("bypassPermissions", { approver: { role: "member" } }), on),
      ).toMatchObject({ code: "FORBIDDEN", ok: false })
      expect(
        await changeHostedMode(changing("bypassPermissions", { sessionId: "s-1" }), on),
      ).toMatchObject({ code: "NOT_FOUND", ok: false })
      expect(fake.calls[0]!.modes).toEqual([])
      expect(recorded).toEqual([])
      expect(host.worker()).toMatchObject({ permissionMode: "default" })
    } finally {
      rmSync(dir, { force: true, recursive: true })
    }
  })

  test("a mode the session refuses is not recorded and the row keeps the old one", async () => {
    const { changing, dir, host, on, recorded } = started({ refuseMode: true })
    try {
      await expect(changeHostedMode(changing("acceptEdits"), on)).rejects.toThrow("refused")
      expect(recorded).toEqual([])
      expect(host.worker()).toMatchObject({ permissionMode: "default" })
    } finally {
      rmSync(dir, { force: true, recursive: true })
    }
  })

  test("a mode the session moves to itself (leaving plan mode) shows on its row", async () => {
    const { dir, host } = started()
    try {
      host.send("report:acceptEdits")
      await Bun.sleep(0)
      expect(host.worker()).toMatchObject({ permissionMode: "acceptEdits" })
    } finally {
      rmSync(dir, { force: true, recursive: true })
    }
  })
})

describe("sendToHosted", () => {
  const delivery = (over: Partial<Delivery> = {}): Delivery => ({
    actor,
    text: "hello",
    to: SDK_PROBE,
    ...over,
  })

  test("a message goes on the session's input as the user's message, recorded by size", async () => {
    const dir = scratch()
    try {
      const { calls, query } = fakeQuery()
      const host = new SdkHost(deps(query))
      host.start(dir, CLAUDE, "default")
      const recorded: string[] = []
      const result = await sendToHosted(delivery(), {
        delivered: async () => null,
        host,
        now: () => new Date(AT),
        record: async (event, sending) => {
          recorded.push(event.summary)
          await sending()
        },
      })
      expect(result).toEqual({ at: AT, ok: true, sessionId: host.sessionId! })
      expect(recorded).toEqual([`Sent ${SDK_PROBE} a message of 5 characters`])
      await Bun.sleep(0)
      expect(calls[0]!.sent).toEqual(["hello"])
    } finally {
      rmSync(dir, { force: true, recursive: true })
    }
  })

  test("a setting passed with a message is never typed: the hosted session sets those through the SDK alone", async () => {
    const dir = scratch()
    try {
      const { calls, query } = fakeQuery()
      const host = new SdkHost(deps(query))
      host.start(dir, CLAUDE, "default")
      const recorded: string[] = []
      const result = await sendToHosted(
        delivery({ setting: { effort: "max" }, text: "/effort max" }),
        {
          delivered: async () => null,
          host,
          now: () => new Date(AT),
          record: async (event, sending) => {
            recorded.push(event.summary)
            await sending()
          },
        },
      )
      expect(result).toMatchObject({ code: "COMMAND", ok: false })
      expect(recorded).toEqual([])
      await Bun.sleep(0)
      expect(calls[0]!.sent).toEqual([])
    } finally {
      rmSync(dir, { force: true, recursive: true })
    }
  })

  test("while a card waits, a message is refused as on a picker and nothing is recorded", async () => {
    const dir = scratch()
    try {
      const { calls, query } = fakeQuery()
      const host = new SdkHost(deps(query))
      host.start(dir, CLAUDE, "default")
      void calls[0]!.options.canUseTool!("Bash", { command: "ls" }, { signal: signal() } as never)
      const recorded: string[] = []
      const result = await sendToHosted(delivery(), {
        delivered: async () => null,
        host,
        now: () => new Date(AT),
        record: async (event, sending) => {
          recorded.push(event.summary)
          await sending()
        },
      })
      expect(result).toMatchObject({ code: "ON_PICKER", ok: false })
      expect(recorded).toEqual([])
      await Bun.sleep(0)
      expect(calls[0]!.sent).toEqual([])
    } finally {
      rmSync(dir, { force: true, recursive: true })
    }
  })

  test("a command, a retry already recorded, and a session not hosted send nothing", async () => {
    const dir = scratch()
    try {
      const { calls, query } = fakeQuery()
      const host = new SdkHost(deps(query))
      const sendDeps = {
        delivered: async (id: string) => (id === "seen" ? new Date(AT) : null),
        host,
        now: () => new Date(AT),
        record: async (_e: unknown, sending: () => Promise<void>) => sending(),
      }
      expect(await sendToHosted(delivery(), sendDeps)).toMatchObject({ code: "NOT_FOUND" })
      host.start(dir, CLAUDE, "default")
      expect(await sendToHosted(delivery({ text: "/clear" }), sendDeps)).toMatchObject({
        code: "COMMAND",
      })
      expect(await sendToHosted(delivery({ id: "seen" }), sendDeps)).toMatchObject({
        at: AT,
        ok: true,
      })
      expect(await sendToHosted(delivery({ to: "dispatcher" }), sendDeps)).toMatchObject({
        code: "NOT_FOUND",
      })
      await Bun.sleep(0)
      expect(calls[0]!.sent).toEqual([])
    } finally {
      rmSync(dir, { force: true, recursive: true })
    }
  })
})

describe("the hosted session on the board", () => {
  test("it joins cmux's sessions with its transcript, and the dashboard answers for it", () => {
    const dir = scratch()
    try {
      const host = new SdkHost(deps(fakeQuery().query))
      host.start(dir, CLAUDE, "default")
      const worker = host.worker()!
      const live: Live = {
        surfaces: new Map(),
        transcripts: new Map([["s-1", "/t/s-1.jsonl"]]),
        workers: [],
      }
      const merged = withHosted(live, [{ transcript: "/t/probe.jsonl", worker }])
      expect(merged.workers.map((w) => w.name)).toEqual([SDK_PROBE])
      expect(merged.transcripts.get(worker.sessionId)).toBe("/t/probe.jsonl")
      expect(merged.surfaces.size).toBe(0)
      expect(worker).toMatchObject({ hosted: true, role: "other" })
      expect(hosts(worker.sessionId, host)).toBe(true)
      expect(hosts("s-1", host)).toBe(false)
    } finally {
      rmSync(dir, { force: true, recursive: true })
    }
  })
})

// The hosted session takes a message or an answer only from the owner's own clicks, the acts deliver() types for: the composer's and the card's routes.
describe("who reaches the hosted session", () => {
  test("only the dashboard router sends to it or answers it", async () => {
    const root = join(import.meta.dir, "../../../../../..")
    const listed = Bun.spawnSync(
      ["git", "ls-files", "--cached", "--others", "--exclude-standard"],
      {
        cwd: root,
        stdin: "ignore",
      },
    )
    expect(listed.exitCode).toBe(0)
    const callers: string[] = []
    for (const path of listed.stdout.toString().split("\n")) {
      if (!/\.(?:[cm]?[jt]sx?)$/.test(path) || path.startsWith("tests/") || path.endsWith(".d.ts"))
        continue
      if (path === "api/hono/src/lib/dashboard/sdk.ts") continue
      const file = Bun.file(join(root, path))
      if (!(await file.exists())) continue
      if (
        /\b(?:sendToHosted|answerHosted|changeHostedMode|changeHostedSetting|sdkHost|SdkHost)\b/.test(
          await file.text(),
        )
      )
        callers.push(path)
    }
    expect(callers.sort()).toEqual([
      "api/hono/src/lib/dashboard/hub.ts",
      "api/hono/src/routers/dashboard.ts",
    ])
  })
})
