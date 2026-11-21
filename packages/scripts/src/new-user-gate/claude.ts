#!/usr/bin/env bun
// The gate's scripted claude, which the box's claude stand-in runs for a launch that names its session (-n): it stays up as a live session (Claude's registry file at its pid, its transcript under ~/.claude/projects, its state reported to herdr as claude's), draws the input box and ready mark spawn.sh and the Dashboard read, and plays one routed task by its role: the dispatcher, on its first typed message, hands the task to a brief and starts the builder; the builder starts a worker on it; the worker opens its PR through gh, which the box's gh stand-in logs. It calls no model.
import { appendFileSync, mkdirSync, rmSync } from "node:fs"
import { join } from "node:path"

import { dataDirOf } from "@packages/env/data-dir"
import { accountKey, accountSettings, accountsOf, readPolicyOrDefaults } from "@packages/settings"

export type Launch = { model: string; name: string; prompt: string; sessionId: string }

// Claude Code's flags that take a value, so a value is never read as the prompt.
const VALUED = new Set([
  "--effort",
  "--model",
  "--plugin-dir",
  "--resume",
  "--session-id",
  "--settings",
])

// Pure: a launch as spawn.sh gives it, `claude --session-id <id> -n <name> <flags> "<prompt>"`; no -n reads as no session to keep.
export const launchOf = (argv: string[]): Launch => {
  const launch: Launch = { model: "", name: "", prompt: "", sessionId: "" }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    const value = argv[i + 1] ?? ""
    const key =
      arg === "-n" || arg === "--name"
        ? "name"
        : arg === "--session-id" || arg === "--resume"
          ? "sessionId"
          : arg === "--model"
            ? "model"
            : null
    if (key) launch[key] = value
    if (key || VALUED.has(arg)) i++
    else if (!arg.startsWith("-")) launch.prompt = arg
  }
  return launch
}

// Pure: the screen, the lines said so far above Claude Code's input box (the two rules deliver() frames it by, the ❯ prompt between) and its bypass mark, which spawn.sh waits on as the REPL's.
export const screenOf = (said: string[], columns: number): string => {
  const rule = "─".repeat(Math.max(10, columns - 1))
  return `\x1b[2J\x1b[H${[...said.slice(-10), rule, "❯ ", rule, "  ⏵⏵ bypass permissions on"].join("\r\n")}`
}

// Pure: raw keys in, the messages they submit and what is still being typed; herdr pastes a message in bracketed-paste marks, then presses Enter.
export const typedOf = (held: string, keys: string): { held: string; sent: string[] } => {
  const lines = (held + keys.replaceAll("\x1b[200~", "").replaceAll("\x1b[201~", "")).split(
    /\r\n|\r|\n/,
  )
  return {
    held: lines.pop() ?? "",
    sent: lines.map((line) => line.trim()).filter(Boolean),
  }
}

// The task the dispatcher hands on, a brief under the data folder (spawn.sh takes a brief's path from there).
const TASK = "handoffs/gate-task.md"

// The first Claude row of usage.accounts in the data folder, the account first run's Add wrote; none when the settings list none or do not read.
const claudeAccountOf = (data: string): string | undefined => {
  const read = readPolicyOrDefaults(data)
  if (read.refusal !== undefined) return undefined
  const row = accountsOf(accountSettings.get(read.settings, "usage.accounts"), "claude")[0]
  return row ? accountKey(row) : undefined
}

// The worker the builder starts, an `<id>-worker` name spawn.sh reads the kind from; one fixed id serves, since every box is a fresh HOME no session has used.
const WORKER = "g8tw7k-worker"

// Pure: the one step a session takes in the routed task, by the role spawn.sh started it as (lead for every manager but the dispatcher, and the builder is the one lead the gate starts), or null when that role waits; a dispatcher acts on a typed message alone, the rest on their start. The builder names `account`, the Claude row first run added, since spawn.sh refuses a worker with none while usage.accounts lists one.
export const stepOf = (
  role: string,
  { account, data, repo, typed }: { account?: string; data: string; repo: string; typed: boolean },
): string[] | null => {
  if (role === "dispatcher" && typed)
    return ["bun", join(repo, "packages", "scripts", "src", "playground", "cli.ts"), "builder"]
  if (role === "lead" && !typed)
    return [
      "bash",
      join(repo, "scripts", "spawn.sh"),
      "worker",
      WORKER,
      TASK,
      "--title",
      "the routed task",
      ...(account ? ["--account", account] : []),
    ]
  if (role === "worker" && !typed)
    return ["gh", "pr", "create", "--title", "the routed task", "--body-file", join(data, TASK)]
  return null
}

const main = async () => {
  const launch = launchOf(process.argv.slice(2))
  if (!launch.name) return
  const env = process.env
  const home = env.HOME ?? ""
  const claude = env.CLAUDE_CONFIG_DIR || join(home, ".claude")
  const data = dataDirOf(env, home)
  const repo = env.PLAYGROUND_REPO ?? process.cwd()
  const role = env.PLAYGROUND_ROLE ?? ""
  const cwd = process.cwd()
  const sessionId = launch.sessionId || crypto.randomUUID()
  const registry = join(claude, "sessions", `${process.pid}.json`)
  const transcript = join(
    claude,
    "projects",
    cwd.replace(/[^a-zA-Z0-9]/g, "-"),
    `${sessionId}.jsonl`,
  )
  const said: string[] = []

  const draw = () => process.stdout.write(screenOf(said, process.stdout.columns || 80))
  const entry = (type: "assistant" | "user", text: string) =>
    appendFileSync(
      transcript,
      `${JSON.stringify({
        cwd,
        entrypoint: "cli",
        message:
          type === "user"
            ? { content: text, role: "user" }
            : { content: [{ text, type: "text" }], model: launch.model, role: "assistant" },
        sessionId,
        timestamp: new Date().toISOString(),
        type,
        uuid: crypto.randomUUID(),
      })}\n`,
    )
  // herdr's custom reporter route, as the session-state hook reports a real session: claude, the kind agent.prompt types into; every child is detached, since herdr holds the agent to the pane's foreground process and a child in its group would take that place, leaving the pane unpromptable once the child exits (agent_not_ready, measured in the gate)
  const report = (state: "idle" | "release" | "working") => {
    if (env.HERDR_ENV !== "1" || !env.HERDR_BIN_PATH || !env.HERDR_PANE_ID) return
    const seq = String(Math.floor((performance.timeOrigin + performance.now()) * 1000))
    const source = ["--source", "custom:playground", "--agent", "claude"]
    const args =
      state === "release"
        ? ["release-agent", env.HERDR_PANE_ID, ...source]
        : ["report-agent", env.HERDR_PANE_ID, ...source, "--state", state]
    Bun.spawn([env.HERDR_BIN_PATH, "pane", ...args, "--seq", seq], {
      detached: true,
      stdio: ["ignore", "ignore", "ignore"],
    }).unref()
  }
  const act = async (typed: boolean) => {
    const argv = stepOf(role, { account: claudeAccountOf(data), data, repo, typed })
    if (!argv) return
    report("working")
    const child = Bun.spawn(argv, {
      cwd,
      detached: true,
      stderr: "pipe",
      stdin: "ignore",
      stdout: "pipe",
    })
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    const last = (err.trim() || out.trim()).split("\n").at(-1) ?? ""
    const line = `${argv.slice(0, 3).join(" ")} exited ${code}${last ? `: ${last}` : ""}`
    said.push(line)
    entry("assistant", line)
    report("idle")
    draw()
  }

  mkdirSync(join(transcript, ".."), { recursive: true })
  await Bun.write(
    registry,
    JSON.stringify({
      cwd,
      kind: "interactive",
      name: launch.name,
      pid: process.pid,
      sessionId,
      startedAt: Date.now(),
      status: "idle",
    }),
  )
  const end = () => {
    rmSync(registry, { force: true })
    report("release")
    process.exit(0)
  }
  for (const signal of ["SIGHUP", "SIGINT", "SIGTERM"] as const) process.on(signal, end)
  if (launch.prompt) entry("user", launch.prompt)
  report("idle")
  draw()

  let held = ""
  let routed = false
  if (process.stdin.isTTY) process.stdin.setRawMode(true)
  process.stdin.on("data", (chunk: Buffer) => {
    const typed = typedOf(held, chunk.toString())
    held = typed.held
    for (const text of typed.sent) {
      said.push(`> ${text}`)
      entry("user", text)
      if (role === "dispatcher" && !routed) {
        routed = true
        void Bun.write(join(data, TASK), `${text}\n`).then(() => act(true))
      }
    }
    draw()
  })
  await act(false)
  // the session runs until its pane closes or it is signalled, as an idle Claude Code does
  await new Promise(() => {})
}

if (import.meta.main) await main()
