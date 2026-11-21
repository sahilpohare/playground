// playground picker <session> allow|deny <key> [--rule <name>] ["reason"]: a session's manager answers the permission prompt its alert named, allowing what the work needs. Only the session's manager or the primary dispatcher answers, and only the call the alert's key names: a call of the session's still waiting on its result whose callKey() matches. The session's herdr pane gets a key only while its prompt shows that call: 1 (Yes, once) or Escape; a session in no herdr pane gets none. A deny carries its reason, which goes to the session as a message through the ops outbox, and every answer is one log line; --rule <name> cites the standing rule that settles the answer, named in that line and the deny's message, and a name no rules file holds presses nothing. A dispatcher's own prompt is never answered.
import { appendFile, mkdir } from "node:fs/promises"
import { join } from "node:path"

import { dispatcherOf } from "@packages/config/kinds"
import { configDirOf, dataDir } from "@packages/env/data-dir"

import { ruleText } from "../../../../scripts/hooks/rules"
import { herdrDir, serverEnv, sessionsOf } from "../ops-herdr/herdr"
import { herdrPath } from "../ops-herdr/pin"
import {
  callKey,
  callOf,
  liveNames,
  managerFor,
  pendingCalls,
  queueLine,
  reportsToOf,
  rosterAgents,
  transcriptOf,
  transcriptPathOf,
} from "../stuck-alert"
import { refusalOf } from "./prompt"

export type PickerDeps = {
  agents: { kind?: unknown; name?: unknown; worker?: unknown }[]
  by: string
  herdr: (server: string, args: string[]) => Promise<string>
  live: () => Promise<Map<string, { pid: number; sessionId: string }>>
  log: (line: string) => Promise<void>
  now: () => Date
  queue: (to: string, text: string) => Promise<void>
  reportsTo: (sessionId: string) => Promise<string | undefined>
  // A standing rule's text by its name, as `playground rules <name>` prints it, or undefined when no rules file holds it.
  rule: (name: string) => Promise<string | undefined>
  servers: string[]
  transcript: (sessionId: string) => Promise<string>
}

const PICKER_USAGE =
  'usage: playground picker <session> allow <key> [--rule <name>] | deny <key> [--rule <name>] "<reason>"'

type Pane = { pane: string; server: string }

const json = (text: string): Record<string, any> => {
  try {
    return JSON.parse(text) as Record<string, any>
  } catch {
    return {}
  }
}

async function paneOf(pid: number, deps: PickerDeps): Promise<Pane | null> {
  for (const server of deps.servers) {
    const panes = await deps
      .herdr(server, ["pane", "list"])
      .then((out) => (json(out).result?.panes ?? []) as { pane_id?: string }[])
      .catch(() => [])
    for (const { pane_id: pane } of panes) {
      if (!pane) continue
      const info = json(
        await deps.herdr(server, ["pane", "process-info", "--pane", pane]).catch(() => ""),
      )
      const processes = (info.result?.process_info?.foreground_processes ?? []) as {
        name?: string
        pid?: number
      }[]
      if (processes.some((p) => p.name === "claude" && p.pid === pid)) return { pane, server }
    }
  }
  return null
}

export async function runPicker(
  args: string[],
  deps: PickerDeps,
): Promise<{ code: number; out: string }> {
  const [name = "", answer = "", key = "", ...rest] = args
  const at = rest.indexOf("--rule")
  const cited = at === -1 ? undefined : (rest[at + 1] ?? "")
  const words = at === -1 ? rest : [...rest.slice(0, at), ...rest.slice(at + 2)]
  const reason = words.join(" ").trim()
  const refuse = (out: string) => ({ code: 1, out })
  if (
    !name ||
    !/^[0-9a-f]{8}$/.test(key) ||
    (answer !== "allow" && answer !== "deny") ||
    cited === "" ||
    cited?.startsWith("-")
  )
    return refuse(PICKER_USAGE)
  // The standing rule the answer cites, by the name `playground rules` prints it under, a hyphen standing for a space.
  const rule = cited?.replaceAll("-", " ")
  if (rule && !(await deps.rule(rule)))
    return refuse(`no rule named ${rule}: playground rules lists them; nothing was pressed`)
  if (answer === "deny" && !reason)
    return refuse(`a deny carries its reason, the simpler shape ${name} is to use: ${PICKER_USAGE}`)
  const live = await deps.live()
  const session = live.get(name)
  if (!session) return refuse(`no live session is named ${name}`)
  const manager = managerFor(
    name,
    deps.agents,
    await deps.reportsTo(session.sessionId).catch(() => undefined),
    new Set(live.keys()),
  )
  if (!manager) return refuse(`${name} has no manager: its prompts are the owner's to answer`)
  if (deps.by !== manager && deps.by !== dispatcherOf(deps.agents, 1))
    return refuse(`only ${name}'s manager, ${manager}, answers its prompts; you are ${deps.by}`)
  const transcript = await deps.transcript(session.sessionId).catch(() => "")
  const call = pendingCalls(transcript).find((input) => callKey(input) === key)
  const pane = await paneOf(session.pid, deps)
  if (!pane) return refuse(`${name} runs in no herdr pane; nothing was pressed`)
  const screen = await deps.herdr(pane.server, ["pane", "read", pane.pane, "--source", "visible"])
  const refusal = refusalOf(name, screen, transcript, key)
  if (refusal) return refuse(refusal)
  await deps.herdr(pane.server, ["pane", "send-keys", pane.pane, answer === "allow" ? "1" : "esc"])
  const what = callOf(call).replace(/\s+/g, " ").slice(0, 120)
  const when = deps
    .now()
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z")
  const under = rule ? ` under **${rule}**` : ""
  const line = `${when} ${deps.by} ${answer} ${name} via herdr: ${what}${rule ? `,${under}` : ""}${reason ? ` (${reason})` : ""}`
  await deps.log(line)
  if (answer === "deny")
    await deps.queue(name, `${deps.by} denied your permission prompt (${what})${under}: ${reason}`)
  return { code: 0, out: line }
}

const run = async (argv: string[], env: Record<string, string>): Promise<string> => {
  const proc = Bun.spawn(argv, { env, stderr: "pipe", stdout: "pipe" })
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (code !== 0)
    throw new Error(`${argv[0]} ${argv.slice(1, 3).join(" ")}: ${err.trim() || out.trim()}`)
  return out
}

// The calling session's name: the registry's entry for the nearest claude among this process's parents.
async function callerName(live: Map<string, { pid: number }>): Promise<string> {
  const pids = new Map([...live].map(([name, { pid }]) => [pid, name]))
  let pid = process.ppid
  for (let i = 0; i < 8 && pid > 1; i++) {
    const found = pids.get(pid)
    if (found) return found
    pid = Number((await run(["ps", "-o", "ppid=", "-p", String(pid)], {}).catch(() => "")).trim())
  }
  return "unknown"
}

// The real deps: the roster, herdr's CLI on each factory server, Claude's registry, the transcript, ops/picker.log and the ops outbox.
export async function pickerDeps(
  env: Record<string, string | undefined> = process.env,
): Promise<PickerDeps> {
  const live = await liveNames(env)
  const dir = herdrDir(env)
  const bin = env.HERDR_BIN_PATH || herdrPath(env)
  const ops = join(dataDir(env), "ops")
  return {
    agents: await rosterAgents(env),
    by: await callerName(live),
    herdr: (server, args) => run([bin, ...args], serverEnv(env, dir, server)),
    live: async () => live,
    log: async (line) => {
      await mkdir(ops, { recursive: true })
      await appendFile(join(ops, "picker.log"), `${line}\n`)
    },
    now: () => new Date(),
    queue: (to, text) => queueLine(env, "picker", to, text),
    reportsTo: async (sessionId) =>
      reportsToOf(await transcriptPathOf(configDirOf(env), sessionId)),
    rule: (name) => ruleText(name, process.cwd(), env),
    servers: sessionsOf(env),
    transcript: (sessionId) => transcriptOf(configDirOf(env), sessionId),
  }
}
