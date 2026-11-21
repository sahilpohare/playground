import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
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
  LOAD_POLL_MS,
  LOAD_WAIT_MS,
  LOCAL_READ_MS,
  LOCAL_TOKEN,
  localPlan,
  resultOf,
  SDK_PROBE,
  SdkHost,
  sendToHosted,
  servedModels,
  SESSION_FILE,
  startSdkProbe,
  TIMED_OUT,
  transcriptOf,
  type HostDeps,
  type HostedMode,
} from "../../../../../../api/hono/src/lib/dashboard/sdk"
import type {
  HostedSetting,
  SessionSetting,
} from "../../../../../../api/hono/src/lib/dashboard/setting"
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

// A stand-in for the SDK's query(): it records the options it was given, every message put on the input and every mode, model and effort set, and ends a turn for each message; close() ends its stream, as the SDK's ends the session's process. A message `report:<mode>` has the session report that mode itself, as its status message does when it leaves plan mode, and `init:<model>` has it report its model as its init message does.
function fakeQuery({ refuseMode = false, refuseSetting = false } = {}) {
  const calls: {
    closed: boolean
    modes: string[]
    options: Options
    sent: string[]
    settings: string[]
  }[] = []
  const run = ({
    options,
    prompt,
  }: {
    options: Options
    prompt: AsyncIterable<SDKUserMessage>
  }) => {
    const call = {
      closed: false,
      modes: [] as string[],
      options,
      sent: [] as string[],
      settings: [] as string[],
    }
    calls.push(call)
    let stop = () => {}
    const stopped = new Promise<IteratorResult<SDKMessage>>(
      (resolve) => (stop = () => resolve({ done: true, value: undefined })),
    )
    const inner = (async function* () {
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
        if (text === "hold") continue
        yield { type: "assistant" } as SDKMessage
        yield { type: "result" } as SDKMessage
      }
    })()
    const stream = {
      [Symbol.asyncIterator]() {
        return this
      },
      next: () => Promise.race([inner.next(), stopped]),
    }
    return Object.assign(stream, {
      close: () => {
        call.closed = true
        stop()
      },
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

const LOCAL = {
  models: [
    { id: "ornith-1.5-122b-nvfp4", label: "M" },
    { id: "ornith-1.5-35b-a3b-nvfp4", label: "K" },
  ],
  url: "http://127.0.0.1:18000",
}

const deps = (query: HostDeps["query"], timeoutMs = 60_000, transcripts = true): HostDeps => ({
  exists: () => transcripts,
  local: LOCAL,
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

  test("a start whose login is the own account's seat token carries it in its environment alone: no log line, row or file holds it", () => {
    const dir = scratch()
    const token = `made-up-seat-${crypto.randomUUID()}`
    const logged: unknown[][] = []
    const error = console.error
    console.error = (...args: unknown[]) => void logged.push(args)
    try {
      const { calls, query } = fakeQuery()
      const host = new SdkHost({
        ...deps(query),
        login: () => ({ email: "owner@example.test", token }),
      })
      host.start(dir, CLAUDE, "default")
      expect(calls[0]?.options.env).toEqual({ ...hostedEnv(), CLAUDE_CODE_OAUTH_TOKEN: token })
      expect(JSON.stringify(logged)).not.toContain(token)
      expect(JSON.stringify(logged)).toContain("owner@example.test's seat token")
      expect(JSON.stringify(host.worker())).not.toContain(token)
      expect(host.worker()?.loginExpired).toBeUndefined()
      expect(readFileSync(join(dir, SESSION_FILE), "utf8")).not.toContain(token)
    } finally {
      console.error = error
      rmSync(dir, { force: true, recursive: true })
    }
  })

  test("a start on a local model never asks for a login, so no seat token reaches its server", () => {
    const dir = scratch()
    try {
      const { calls, query } = fakeQuery()
      let asked = 0
      const login = () => {
        asked += 1
        return { email: "owner@example.test", token: `made-up-seat-${crypto.randomUUID()}` }
      }
      new SdkHost({ ...deps(query), login }).start(dir, CLAUDE, "default", {
        id: LOCAL.models[0]!.id,
        url: LOCAL.url,
      })
      expect(asked).toBe(0)
      expect(calls[0]?.options.env?.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
    } finally {
      rmSync(dir, { force: true, recursive: true })
    }
  })

  test("a start with an ended login and no seat token runs as before, its row shows the expired login, and the log names the cause", () => {
    const dir = scratch()
    const cause =
      "its Claude Code login has ended (loginEnded: time_limit), and the Keychain holds no acme-claude item for it to start on"
    const logged: unknown[][] = []
    const error = console.error
    console.error = (...args: unknown[]) => void logged.push(args)
    try {
      const { calls, query } = fakeQuery()
      const host = new SdkHost({
        ...deps(query),
        login: () => ({ cause, email: "owner@example.test" }),
      })
      host.start(dir, CLAUDE, "default")
      expect(calls[0]?.options.env).toEqual(hostedEnv())
      expect(host.worker()?.loginExpired).toBe(true)
      expect(JSON.stringify(logged)).toContain(cause)
    } finally {
      console.error = error
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
      keptModel: () => "",
      served: async () => null,
      sleep: async () => {},
      start: async () => ({ code: 0, line: "" }),
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

describe("the hosted session on a local model", () => {
  const M = LOCAL.models[0]!
  const K = LOCAL.models[1]!

  // A host on a fake session whose server serves what served holds, read by reference so a test can change it mid-load; record waits a tick before it runs, as recordWhileSending awaits the database, and sleep moves the clock on.
  const started = (
    first: string[] | null = [M.id],
    { kept = "", start = { code: 0, line: "started" } } = {},
  ) => {
    const dir = scratch()
    const fake = fakeQuery()
    const host = new SdkHost(deps(fake.query))
    host.start(dir, CLAUDE, "plan")
    const recorded: string[] = []
    const reads: string[] = []
    const starts: string[] = []
    const clock = { at: Date.parse(AT) }
    const server = { served: first }
    const on = {
      host,
      keptModel: () => kept,
      now: () => new Date(clock.at),
      record: async (event: { action: string; summary: string }, run: () => Promise<void>) => {
        await Bun.sleep(0)
        await run()
        recorded.push(`${event.action}: ${event.summary}`)
      },
      served: async (url: string) => {
        reads.push(url)
        return server.served
      },
      sleep: async (ms: number) => {
        clock.at += ms
        await Bun.sleep(0)
      },
      start: async (model: string) => {
        starts.push(model)
        return start
      },
    }
    const pick = (setting: HostedSetting) =>
      changeHostedSetting({ actor, sessionId: host.sessionId!, setting }, on)
    // Waits for a load running past its request to end, loaded or failed.
    const loaded = async () => {
      for (let i = 0; i < 500 && host.loading(); i++) await Bun.sleep(1)
    }
    return { clock, dir, fake, host, loaded, on, pick, reads, recorded, server, starts }
  }

  test("on a local model the session gets its server, a placeholder token in place of the login's, the model under every alias, and few retries", () => {
    const env = hostedEnv(
      { ANTHROPIC_AUTH_TOKEN: "the-api's", HOME: "/h", PATH: "/bin" },
      "/stack-data",
      { id: M.id, url: LOCAL.url },
    )
    expect(env).toEqual({
      ANTHROPIC_AUTH_TOKEN: LOCAL_TOKEN,
      ANTHROPIC_BASE_URL: LOCAL.url,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: M.id,
      ANTHROPIC_DEFAULT_OPUS_MODEL: M.id,
      ANTHROPIC_DEFAULT_SONNET_MODEL: M.id,
      CLAUDE_CODE_MAX_RETRIES: "2",
      HOME: "/h",
      PATH: "/bin",
      PLAYGROUND_DATA_DIR: "/stack-data",
      PLAYGROUND_ROLE: "probe",
    })
    expect(hostedEnv({ HOME: "/h" }, "/d")).not.toHaveProperty("ANTHROPIC_BASE_URL")
  })

  test("picking a local model closes the session and resumes it on that server in the same mode, and a cloud pick then resumes it on the default endpoint", async () => {
    const { dir, fake, host, pick, reads, recorded } = started()
    try {
      const id = host.sessionId!
      expect(await pick({ local: M.id })).toMatchObject({ ok: true, sessionId: id })
      expect(reads).toEqual([LOCAL.url])
      expect(fake.calls[0]!.closed).toBe(true)
      expect(fake.calls[1]!.options).toMatchObject({
        model: M.id,
        permissionMode: "plan",
        resume: id,
      })
      expect(fake.calls[1]!.options.env).toMatchObject({ ANTHROPIC_BASE_URL: LOCAL.url })
      expect(host.worker()).toMatchObject({ model: M.id, sessionId: id })
      expect(host.localModel()).toBe(M.id)
      expect(await pick({ model: "opus" })).toMatchObject({ ok: true })
      expect(fake.calls[1]!.closed).toBe(true)
      expect(fake.calls[2]!.options).toMatchObject({ model: "opus", resume: id })
      expect(fake.calls[2]!.options.env).not.toHaveProperty("ANTHROPIC_BASE_URL")
      expect(host.localModel()).toBeNull()
      expect(recorded).toEqual([
        `dashboard.setting: Set ${SDK_PROBE}'s model to ${M.id} (local)`,
        `dashboard.setting: Set ${SDK_PROBE}'s model to opus`,
      ])
      // a cloud pick on the default endpoint keeps setModel, with no restart
      await pick({ model: "sonnet" })
      expect(fake.calls).toHaveLength(3)
      expect(fake.calls[2]!.settings).toEqual(["model sonnet"])
    } finally {
      rmSync(dir, { force: true, recursive: true })
    }
  })

  test("while a turn runs, a switch is refused as BUSY and the session is left running", async () => {
    const { dir, fake, host, pick, recorded } = started()
    try {
      host.send("hold")
      await Bun.sleep(0)
      expect(await pick({ local: M.id })).toEqual({
        code: "BUSY",
        ok: false,
        reason: "The chat is answering; switch the model once it's done.",
      })
      expect(fake.calls).toHaveLength(1)
      expect(fake.calls[0]!.closed).toBe(false)
      expect(recorded).toEqual([])
    } finally {
      rmSync(dir, { force: true, recursive: true })
    }
  })

  test("a second switch while one restarts the session, as from another tab, is refused as BUSY", async () => {
    const { dir, fake, pick, recorded } = started()
    try {
      const results = await Promise.all([pick({ local: M.id }), pick({ local: M.id })])
      expect(results.map((result) => (result.ok ? "ok" : result.code)).sort()).toEqual([
        "BUSY",
        "ok",
      ])
      expect(fake.calls).toHaveLength(2)
      expect(recorded).toHaveLength(1)
    } finally {
      rmSync(dir, { force: true, recursive: true })
    }
  })

  test("the claim holds until switchTo lets it go, so a pick right after a restart reads BUSY (PG-2647)", async () => {
    const { dir, host } = started()
    try {
      expect(host.claim()).toBe(true)
      await host.restart(null, "opus")
      expect(host.claim()).toBe(false)
      host.release()
      expect(host.claim()).toBe(true)
      host.release()
    } finally {
      rmSync(dir, { force: true, recursive: true })
    }
  })

  test("a pick made as the first switch's restart ends reads BUSY, and a pick once that switch lets go switches (PG-2647)", async () => {
    const { dir, fake, on, pick } = started()
    try {
      const record = on.record
      let during: Awaited<ReturnType<typeof pick>> | undefined
      on.record = async (event, run) => {
        on.record = record
        await record(event, async () => {
          await run()
          during = await pick({ model: "sonnet" })
        })
      }
      expect(await pick({ local: M.id })).toMatchObject({ ok: true })
      expect(during).toMatchObject({ code: "BUSY", ok: false })
      expect(await pick({ model: "opus" })).toMatchObject({ ok: true })
      expect(fake.calls).toHaveLength(3)
    } finally {
      rmSync(dir, { force: true, recursive: true })
    }
  })

  test("a switch keeps the effort picked before it, on the local server and back", async () => {
    const { dir, fake, host, pick } = started()
    try {
      await pick({ effort: "high" })
      await pick({ local: M.id })
      expect(fake.calls[1]!.settings).toEqual(["effort high"])
      expect(host.worker()).toMatchObject({ effort: "high", model: M.id })
      await pick({ model: "opus" })
      expect(fake.calls[2]!.settings).toEqual(["effort high"])
      expect(host.worker()).toMatchObject({ effort: "high", model: "opus" })
    } finally {
      rmSync(dir, { force: true, recursive: true })
    }
  })

  test("a pick while the server is down starts the kept model, shows it loading, then switches once the server serves it", async () => {
    const { dir, fake, host, loaded, pick, recorded, server, starts } = started(null, {
      kept: "m-folder",
    })
    try {
      expect(await pick({ local: M.id })).toMatchObject({ ok: true })
      expect(starts).toEqual(["m-folder"])
      expect(host.worker()!.localLoad).toEqual({ label: "M", state: "loading" })
      expect(fake.calls).toHaveLength(1)
      server.served = [M.id]
      await loaded()
      expect(host.worker()!.localLoad).toBeUndefined()
      expect(host.localModel()).toBe(M.id)
      expect(fake.calls).toHaveLength(2)
      expect(recorded).toEqual([`dashboard.setting: Set ${SDK_PROBE}'s model to ${M.id} (local)`])
    } finally {
      rmSync(dir, { force: true, recursive: true })
    }
  })

  test("a start the machine refuses shows its words on the row, the chat untouched, and the next model pick clears them", async () => {
    const { dir, fake, host, loaded, pick, recorded } = started(null, {
      kept: "m-folder",
      start: { code: 1, line: "spark-9dfb has 9 GiB free, under the 15 GiB floor" },
    })
    try {
      await pick({ local: M.id })
      await loaded()
      expect(host.worker()!.localLoad).toEqual({
        label: "M",
        reason:
          "The local model server couldn't start M, so the chat stays on its model: spark-9dfb has 9 GiB free, under the 15 GiB floor",
        state: "failed",
      })
      expect(fake.calls).toHaveLength(1)
      expect(recorded).toEqual([])
      await pick({ model: "opus" })
      expect(host.worker()!.localLoad).toBeUndefined()
    } finally {
      rmSync(dir, { force: true, recursive: true })
    }
  })

  test("while a model loads, another local pick is BUSY, and a cloud pick cancels the switch", async () => {
    const { dir, fake, host, loaded, pick, server } = started(null, { kept: "m-folder" })
    try {
      await pick({ local: M.id })
      expect(await pick({ local: M.id })).toEqual({
        code: "BUSY",
        ok: false,
        reason: "M is still loading on the local model server.",
      })
      expect(await pick({ model: "opus" })).toMatchObject({ ok: true })
      expect(host.worker()!.localLoad).toBeUndefined()
      server.served = [M.id]
      await Bun.sleep(5)
      await loaded()
      expect(host.localModel()).toBeNull()
      expect(fake.calls).toHaveLength(1)
      expect(fake.calls[0]!.settings).toEqual(["model opus"])
    } finally {
      rmSync(dir, { force: true, recursive: true })
    }
  })

  test("a server that answers with another model ends the load at once in plain words, and one that never answers fails after LOAD_WAIT_MS", async () => {
    for (const [served, reason, waited] of [
      [[K.id], "K is loaded on the local model server right now, not M.", [0, LOAD_POLL_MS]],
      [
        null,
        "M didn't come up on the local model server within 15 minutes, so the chat stays on its model.",
        [LOAD_WAIT_MS, LOAD_WAIT_MS + LOAD_POLL_MS],
      ],
    ] as const) {
      const { clock, dir, fake, host, loaded, pick, server } = started(null, { kept: "m-folder" })
      try {
        await pick({ local: M.id })
        server.served = served === null ? null : [...served]
        await loaded()
        expect(host.worker()!.localLoad).toEqual({ label: "M", reason, state: "failed" })
        // one read of the server may land before the test sets what it serves
        const elapsed = clock.at - Date.parse(AT)
        expect(elapsed).toBeGreaterThanOrEqual(waited[0])
        expect(elapsed).toBeLessThanOrEqual(waited[1])
        expect(fake.calls).toHaveLength(1)
      } finally {
        rmSync(dir, { force: true, recursive: true })
      }
    }
    expect([LOAD_WAIT_MS, LOAD_POLL_MS]).toEqual([15 * 60_000, 5_000])
  })

  test("a model served while a turn runs past LOAD_WAIT_MS waits for the turn to end, then switches", async () => {
    const { clock, dir, fake, host, loaded, pick, server } = started(null, { kept: "m-folder" })
    try {
      await pick({ local: M.id })
      host.send("hold")
      server.served = [M.id]
      for (let i = 0; i < 2_000 && clock.at - Date.parse(AT) <= LOAD_WAIT_MS; i++)
        await Bun.sleep(0)
      expect(clock.at - Date.parse(AT)).toBeGreaterThan(LOAD_WAIT_MS)
      expect(host.worker()!.localLoad).toEqual({ label: "M", state: "loading" })
      host.send("done")
      await loaded()
      expect(host.worker()!.localLoad).toBeUndefined()
      expect(host.localModel()).toBe(M.id)
      expect(fake.calls).toHaveLength(2)
    } finally {
      rmSync(dir, { force: true, recursive: true })
    }
  })

  test("a server that does not answer, or serves another model, refuses the pick in plain words and leaves the session where it was", async () => {
    for (const [served, code, reason] of [
      [
        null,
        "SESSIONS_FAILED",
        "The local model server isn't answering, so the chat stays on its model, not M.",
      ],
      [[K.id], "BUSY", "K is loaded on the local model server right now, not M."],
      [[], "BUSY", "No model is loaded on the local model server right now, so M can't answer."],
    ] as const) {
      const { dir, fake, pick, recorded } = started(served === null ? null : [...served])
      try {
        expect(await pick({ local: M.id })).toEqual({ code, ok: false, reason })
        expect(fake.calls).toHaveLength(1)
        expect(fake.calls[0]!.closed).toBe(false)
        expect(recorded).toEqual([])
      } finally {
        rmSync(dir, { force: true, recursive: true })
      }
    }
  })

  test("a local id config does not name is NOT_FOUND, and the row lists config's local models", async () => {
    const { dir, fake, host, pick } = started()
    try {
      expect(await pick({ local: "other-model" })).toMatchObject({ code: "NOT_FOUND", ok: false })
      expect(fake.calls).toHaveLength(1)
      expect(host.worker()).toMatchObject({ localModels: LOCAL.models })
    } finally {
      rmSync(dir, { force: true, recursive: true })
    }
  })
})

// The stub local server (tests/local-model-stub.ts) on 127.0.0.1 alone, its port read from its first line; stopped by its own pid.
async function stubServer(...args: string[]) {
  const stub = Bun.spawn(
    ["bun", join(import.meta.dir, "../../../../../local-model-stub.ts"), ...args],
    {
      stderr: "pipe",
      stdout: "pipe",
    },
  )
  const reader = stub.stdout.getReader()
  let out = ""
  while (!out.includes("\n")) {
    const { done, value } = await reader.read()
    if (done) break
    out += new TextDecoder().decode(value)
  }
  reader.releaseLock()
  return { stop: () => stub.kill(), stub, url: `http://127.0.0.1:${out.trim()}` }
}

describe("servedModels", () => {
  test("it reads the ids a local server lists, and null when the server is gone or does not answer in time", async () => {
    const up = await stubServer("ornith-1.5-122b-nvfp4", "0")
    try {
      expect(await servedModels(up.url)).toEqual(["ornith-1.5-122b-nvfp4"])
    } finally {
      up.stop()
      await up.stub.exited
    }
    expect(await servedModels(up.url, 1_000)).toBeNull()
    const hung = await stubServer("ornith-1.5-122b-nvfp4", "0", "--silent-models")
    try {
      const started = Date.now()
      expect(await servedModels(hung.url, 200)).toBeNull()
      expect(Date.now() - started).toBeLessThan(2_000)
    } finally {
      hung.stop()
      await hung.stub.exited
    }
    expect(LOCAL_READ_MS).toBe(5_000)
  })

  test("a server still loading its model reads as not answering until it serves it", async () => {
    const loading = await stubServer("ornith-1.5-122b-nvfp4", "0", "--down-for", "1")
    try {
      expect(await servedModels(loading.url)).toBeNull()
      await Bun.sleep(1_100)
      expect(await servedModels(loading.url)).toEqual(["ornith-1.5-122b-nvfp4"])
    } finally {
      loading.stop()
      await loading.stub.exited
    }
  })
})

describe("localPlan", () => {
  test("it loads when the server does not answer and a kept model can start there, and only then", () => {
    const [M, K] = LOCAL.models as [(typeof LOCAL.models)[0], (typeof LOCAL.models)[0]]
    expect(localPlan(M, null, LOCAL.models, true)).toEqual({ do: "load" })
    expect(localPlan(M, null, LOCAL.models, false)).toMatchObject({ do: "refuse", down: true })
    expect(localPlan(M, [K.id], LOCAL.models, true)).toMatchObject({ do: "refuse", down: false })
    expect(localPlan(M, [M.id], LOCAL.models, true)).toEqual({ do: "switch" })
  })

  test("it switches when the server serves the pick, and its refusals name the models in words, with no command to type", () => {
    const [M, K] = LOCAL.models as [(typeof LOCAL.models)[0], (typeof LOCAL.models)[0]]
    expect(localPlan(M, [M.id], LOCAL.models)).toEqual({ do: "switch" })
    const refusals = [
      localPlan(M, [K.id], LOCAL.models),
      localPlan(M, null, LOCAL.models),
      localPlan(M, ["x/y"], LOCAL.models),
    ]
    expect(refusals.map((plan) => plan.do)).toEqual(["refuse", "refuse", "refuse"])
    expect(refusals[2]).toMatchObject({
      reason: "x/y is loaded on the local model server right now, not M.",
    })
    for (const plan of refusals)
      expect(JSON.stringify(plan)).not.toMatch(/playground |`|\bbun\b|ssh/)
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
