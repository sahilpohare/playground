// PreToolUse hook, for every session: refuses a GitHub label create or edit whose color is not a Tailwind 500, and a create with no color, since GitHub then picks one, so any label created from now on is a Tailwind 500.
import { input } from "./input"
import {
  type Command,
  type Env,
  ghApi,
  ghCommand,
  knownVariables,
  lex,
  parseFlags,
  PRINTERS,
  program,
  resolveText,
  run,
  type Text,
  unreadable,
  type Visit,
  type Word,
} from "./shell"

// Tailwind's own order, the hue wheel then the grays, which is how a person reads the palette.
export const TAILWIND_500 = {
  red: "ef4444",
  orange: "f97316",
  amber: "f59e0b",
  yellow: "eab308",
  lime: "84cc16",
  green: "22c55e",
  emerald: "10b981",
  teal: "14b8a6",
  cyan: "06b6d4",
  sky: "0ea5e9",
  blue: "3b82f6",
  indigo: "6366f1",
  violet: "8b5cf6",
  purple: "a855f7",
  fuchsia: "d946ef",
  pink: "ec4899",
  rose: "f43f5e",
  slate: "64748b",
  gray: "6b7280",
  zinc: "71717a",
  neutral: "737373",
  stone: "78716c",
}
const HEXES = new Set<string>(Object.values(TAILWIND_500))
const PALETTE = Object.entries(TAILWIND_500)
  .map(([name, hex]) => `${name} ${hex}`)
  .join(", ")

const SPECS = new Map([
  ["label create", new Set(["-c", "--color", "-d", "--description", "-R", "--repo"])],
  ["label edit", new Set(["-c", "--color", "-d", "--description", "-n", "--name", "-R", "--repo"])],
])
const LABELS = /^repos\/[^/]+\/[^/]+\/labels(\/[^/]+)?$/
const MCP_LABEL = /^mcp__.+__label_write$/

const refuse = (what: string, detail: string) =>
  `no-off-palette-label hook refused ${what}: ${detail}. Every label is a Tailwind 500: ${PALETTE}. Give one of them as the color, written literally, and leave existing labels as they are.`

// Undefined when the color is a 500; a color the hook cannot read, or none on a create, is refused.
function judge(what: string, color: Text | undefined, create: boolean): string | undefined {
  if (!color || (color.value === "" && !unreadable(color)))
    return create ? refuse(what, "it sets no color, so GitHub picks one") : undefined
  if (unreadable(color))
    return refuse(
      what,
      `the hook cannot read its color (it comes from ${color.unknown ?? "a variable"})`,
    )
  if (!HEXES.has(color.value.replace(/^#/, "").toLowerCase()))
    return refuse(what, `its color ${color.value} is not a Tailwind 500`)
}

const visit: Visit = async (cmd, { args, first, name }, env) => {
  // a program named by a variable (`G=gh; $G label create`) is read as gh when a gh group follows it
  if (name === "gh" || (first?.unknown && ["api", "label"].includes(args[0]?.value ?? "")))
    return gh(args, cmd, env)
  const nested = args.findIndex((a) => program(a.value) === "gh")
  if (nested !== -1 && !PRINTERS.has(name)) return gh(args.slice(nested + 1), cmd, env)
}

async function gh(args: Word[], cmd: Command, env: Env): Promise<string | undefined> {
  const { head, rest } = ghCommand(args)
  if (head[0] === "api") return api(rest, cmd, env)
  const key = head.join(" ")
  const takes = SPECS.get(key)
  if (!takes) return
  const { flags } = parseFlags(rest, takes)
  const color = flags.findLast((f) => f.name === "-c" || f.name === "--color")?.value
  return judge(`gh ${key}`, color && (await resolveText(color, env)), key === "label create")
}

async function api(args: Word[], cmd: Command, env: Env): Promise<string | undefined> {
  const request = await ghApi(args, cmd, env, undefined)
  if (!request || !["PATCH", "POST"].includes(request.method)) return
  const path = request.endpoint.value
    .replace(/^https?:\/\/[^/]+/i, "")
    .replace(/^\/+/, "")
    .replace(/^api\/v3\//, "")
    .split("?")[0]
  const match = LABELS.exec(path)
  if (!match) return
  const create = request.method === "POST" && !match[1]
  let color = request.fields.findLast((f) => f.key === "color")?.text
  for (const input of request.inputs) color = colorOf(await resolveText(input, env)) ?? color
  return judge(`gh api ${request.method} ${path}`, color && (await resolveText(color, env)), create)
}

// The color a JSON body sets, or the body itself when the hook cannot read it.
function colorOf(body: Text): Text | undefined {
  if (body.unknown) return body
  try {
    const { color } = JSON.parse(body.value) as { color?: unknown }
    if (color === undefined) return
    return typeof color === "string"
      ? { value: color }
      : { unknown: "a color that is not text", value: "" }
  } catch {
    return { unknown: "a body that is not JSON", value: "" }
  }
}

function mcp(input: Record<string, unknown>): string | undefined {
  const method = String(input.method).toLowerCase()
  if (method !== "create" && method !== "update") return
  const { color } = input
  const text =
    color === undefined || color === ""
      ? undefined
      : typeof color === "string"
        ? { value: color }
        : { unknown: "a color that is not text", value: "" }
  return judge(`label_write ${method}`, text, method === "create")
}

async function inspect(raw: string): Promise<string | undefined> {
  const {
    cwd,
    tool_input: toolInput,
    tool_name: tool,
  } = JSON.parse(raw) as {
    cwd?: unknown
    tool_input?: Record<string, unknown>
    tool_name?: unknown
  }
  if (typeof tool === "string" && MCP_LABEL.test(tool)) return mcp(toolInput ?? {})
  const command = toolInput?.command
  if (tool !== "Bash" || typeof command !== "string") return
  // quotes and backslashes go first, since the shell reads l"abel" and \gh as label and gh
  const bare = command.replace(/["'\\]/g, "")
  if (!/label/i.test(bare)) return
  const directory = typeof cwd === "string" ? cwd : undefined
  const env: Env = {
    cwd: directory,
    files: new Map(),
    known: knownVariables(command, process.env, directory),
    process: process.env,
    vars: new Map(),
  }
  return run(lex(command, env.known), env, visit)
}

// Fails open: a call the hook cannot read runs, so a parser bug never blocks a Bash command.
export async function check(raw: string): Promise<string | undefined> {
  try {
    return await inspect(raw)
  } catch {
    return undefined
  }
}

if (import.meta.main) {
  const reason = await check(await input("no-off-palette-label", "guard"))
  if (reason) {
    console.error(reason)
    process.exit(2)
  }
}
