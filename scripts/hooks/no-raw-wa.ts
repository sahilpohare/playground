// PreToolUse hook, acting for a factory session alone (role.ts): refuses a call that reaches the data folder's whatsapp/, which holds ops-wa's linked device (its auth state, its socket and the owner's messages), so no session can copy the device or write to anyone but the owner past playground wa send (ADR 0023). It reads Bash, the file tools and Grep and Glob; playground wa send names no path there, so it runs.
import { realpathSync } from "node:fs"
import { homedir } from "node:os"
import { resolve } from "node:path"

import { dataDirOf } from "../../packages/env/src/data-dir"
import { eachInput } from "./codex"
import { fromFactory } from "./role"
import {
  knownVariables,
  lex,
  marked,
  places,
  program,
  run,
  visible,
  type Env,
  type Visit,
  type Word,
} from "./shell"

type Environment = Record<string, string | undefined>

const refuse = (what: string) =>
  `no-raw-wa hook refuses ${what}: the data folder's whatsapp/ holds ops-wa's linked device, its auth state, its socket and the owner's messages, which no session reads or writes. To write to the owner on WhatsApp, run playground wa send <absolute file>; to see ops-wa's state, read its row on the System page.`

// Programs that read a folder's files all the way down, so naming a folder above whatsapp/ reaches it too.
const RECURSIVE = new Set(["ack", "ag", "ditto", "find", "rg", "rsync", "tar"])
// Programs that read all the way down given one of these options.
const RECURSIVE_WITH: Record<string, RegExp> = {
  cp: /^-[A-Za-z]*[rRa]|^--(?:recursive|archive)$/,
  egrep: /^-[A-Za-z]*[rR]|^--(?:recursive|dereference-recursive|directories=recurse)$/,
  fgrep: /^-[A-Za-z]*[rR]|^--(?:recursive|dereference-recursive|directories=recurse)$/,
  grep: /^-[A-Za-z]*[rR]|^--(?:recursive|dereference-recursive|directories=recurse)$/,
  scp: /^-[A-Za-z]*r/,
  zip: /^-[A-Za-z]*r/,
}

// whatsapp/ under the data folder, as typed and as its links resolve, each in lower case, since macOS opens a path in any case.
const targetsOf = (environment: Environment): string[] => {
  const typed = resolve(dataDirOf(environment), "whatsapp")
  let real = typed
  try {
    real = resolve(realpathSync(dataDirOf(environment)), "whatsapp")
  } catch {}
  return [...new Set([typed, real].map((p) => p.toLowerCase()))]
}

const segments = (path: string) => resolve(path).toLowerCase().split("/").filter(Boolean)

// Where a path, a glob's pattern when glob is set, stands against the target: at or inside it, above it, or apart from it.
export function reach(path: string, target: string, glob = false): "above" | "inside" | undefined {
  const p = segments(path)
  const t = segments(target)
  for (let i = 0; i < Math.min(p.length, t.length); i++) {
    if (glob && p[i]!.includes("**")) return "inside"
    if (!(glob ? new Bun.Glob(p[i]!).match(t[i]!) : p[i] === t[i])) return
  }
  return p.length >= t.length ? "inside" : "above"
}

const worst = (path: string, targets: string[], glob = false) => {
  const found = targets.map((t) => reach(path, t, glob))
  return found.includes("inside") ? "inside" : found.includes("above") ? "above" : undefined
}

// The text net under the word reading: a call whose text names whatsapp/ under the data folder, whatever reads it (a script's string, a variable the hook cannot expand).
const namesTarget = (command: string, targets: string[]) => {
  const text = command.replace(/["'\\]/g, "").toLowerCase()
  return (
    targets.some((t) => text.includes(t)) ||
    /(?:\.playground|playground_data_dir\}?)\/+whatsapp(?![\w.-])/.test(text)
  )
}

// A word as the shell runs it: one the lexer could not read is lexed again with the variables the call has set by then, else it stays unread.
const readOf = (word: Word, at: Env): { glob?: boolean; value: string } | undefined => {
  if (!marked(word.value)) return word
  if (!word.raw) return
  const known = { ...at.known }
  for (const [key, text] of at.vars) if (!marked(text.value)) known[key] = text.value
  const again = lex(word.raw, known).commands[0]?.words[0]
  return again && !marked(again.value) ? again : undefined
}

const recursive = (name: string, args: Word[]) =>
  RECURSIVE.has(name) || args.some((a) => RECURSIVE_WITH[name]?.test(a.value))

async function judgeBash(command: string, cwd: string | undefined, environment: Environment) {
  const targets = targetsOf(environment)
  if (namesTarget(command, targets)) return refuse("a command naming whatsapp/ in the data folder")
  const env: Env = {
    cwd,
    files: new Map(),
    known: knownVariables(command, environment, cwd),
    process: environment,
    vars: new Map(),
  }
  const visit: Visit = async (cmd, { args, first, name }, at) => {
    const words = [
      ...(first ? [first] : []),
      ...args,
      ...cmd.redirects.flatMap((r) => (r.target ? [r.target] : [])),
    ]
    for (const place of places(at)) {
      if (place.cwd && worst(place.cwd, targets) === "inside")
        return refuse(`a command run inside whatsapp/ in the data folder`)
      for (const typed of words) {
        const word = readOf(typed, at)
        if (!word?.value) continue
        // an option's value (--file=<path>, dd's if=<path>) is a path too
        for (const raw of [word.value, word.value.slice(word.value.indexOf("=") + 1)]) {
          // the shell expands a ~ after an assignment's = too, which the reader keeps as typed
          const value = /^~(?:\/|$)/.test(raw) ? `${homedir()}${raw.slice(1)}` : raw
          const path = value.startsWith("/") ? value : place.cwd && resolve(place.cwd, value)
          if (!path) continue
          const stands = worst(path, targets, !!word.glob)
          if (stands === "inside")
            return refuse(`${visible(word.value)}, which reaches whatsapp/ in the data folder`)
          if (stands === "above" && recursive(program(name), args))
            return refuse(
              `${name} through ${visible(word.value)}, which reads whatsapp/ in the data folder on its way down`,
            )
        }
      }
    }
  }
  return run(lex(command, env.known), env, visit, true)
}

const FILE_TOOLS = new Set(["Edit", "MultiEdit", "NotebookEdit", "Read", "Write"])

async function inspect(raw: string, environment: Environment) {
  const {
    cwd,
    tool_input: input,
    tool_name: tool,
  } = JSON.parse(raw) as {
    cwd?: unknown
    tool_input?: Record<string, unknown>
    tool_name?: unknown
  }
  const folder = typeof cwd === "string" ? cwd : undefined
  const targets = targetsOf(environment)
  if (tool === "Bash" && typeof input?.command === "string")
    return judgeBash(input.command, folder, environment)
  if (typeof tool === "string" && FILE_TOOLS.has(tool)) {
    const path = input?.file_path ?? input?.notebook_path
    if (typeof path === "string" && worst(path, targets) === "inside")
      return refuse(`a ${tool} of ${path}`)
    return
  }
  if (tool === "Grep" || tool === "Glob") {
    const path = typeof input?.path === "string" ? input.path : folder
    if (!path) return
    const at = worst(path, targets)
    if (at === "inside" || (tool === "Grep" && at === "above"))
      return refuse(`a ${tool} through ${path}, which reads whatsapp/ in the data folder`)
    const pattern = input?.pattern
    if (
      tool === "Glob" &&
      typeof pattern === "string" &&
      worst(resolve(path, pattern), targets, true) === "inside"
    )
      return refuse(`a Glob of ${pattern}, which reaches whatsapp/ in the data folder`)
  }
}

// Fails open on a call it cannot read, so a parser bug never blocks a call; the text net reads before the parse.
export async function check(
  raw: string,
  environment: Environment = process.env,
): Promise<string | undefined> {
  try {
    return await eachInput(raw, "no-raw-wa", (one) => inspect(one, environment))
  } catch {
    return undefined
  }
}

if (import.meta.main) {
  const raw = await Bun.stdin.text()
  const reason = (await fromFactory(raw)) ? await check(raw) : undefined
  if (reason) {
    console.error(reason)
    process.exit(2)
  }
}
