// How a guard reads a Codex session's hook input (codex-cli 0.167.1, its turn_id telling it from Claude Code's): a shell call comes as Bash with its command and an MCP call by its mcp__ name and arguments, both in Claude Code's shape, and an edit comes in two shapes, an apply_patch call whose command is the patch, or an apply_patch command run in the shell. Each edit is read into one Write per file its patch adds, updates, deletes or moves to, which every edit guard judges as it judges Claude Code's.
import { isAbsolute, resolve } from "node:path"

// The patch's file headers in the patch format's own order, read from a line with its ends trimmed, as Codex's parser reads them (codex-rs/apply-patch/src/streaming_parser.rs).
const HEADERS = ["*** Add File: ", "*** Delete File: ", "*** Update File: ", "*** Move to: "]
// apply_patch, or its other name applypatch, as the program a shell command runs, past any assignments ahead of it.
const SHELL_PATCH =
  /(?:^|[\n;&|(`]|\$\()\s*(?:[A-Za-z_]\w*=\S*\s+)*(?:\S*\/)?(?:apply_patch|applypatch)(?=$|[\s;&|)<>'"`])/

type Input = Record<string, unknown>

// Pure: each file a patch's text names, in its order, as written.
export const patchPaths = (text: string): string[] =>
  text.split("\n").flatMap((line) => {
    const trimmed = line.trim()
    const header = HEADERS.find((h) => trimmed.startsWith(h))
    return header && trimmed.length > header.length ? [trimmed.slice(header.length)] : []
  })

const writeOf = (input: Input, path: string, patch: string): string => {
  const cwd = typeof input.cwd === "string" ? input.cwd : "/"
  return JSON.stringify({
    ...input,
    tool_input: { content: patch, file_path: isAbsolute(path) ? path : resolve(cwd, path) },
    tool_name: "Write",
  })
}

// Pure: the inputs a guard judges for one hook input, the input itself for every one but a Codex edit; null for a Codex edit whose patch names no file, which no guard can judge.
export function guardInputs(raw: string): string[] | null {
  let input: Input
  try {
    input = JSON.parse(raw) as Input
  } catch {
    return [raw]
  }
  if (typeof input !== "object" || input === null || typeof input.turn_id !== "string") return [raw]
  const tool = input.tool_name
  const command = (input.tool_input as { command?: unknown } | null | undefined)?.command
  const text = typeof command === "string" ? command : ""
  const shell = tool === "Bash" && SHELL_PATCH.test(text)
  if (tool !== "apply_patch" && !shell) return [raw]
  const paths = patchPaths(text)
  if (paths.length === 0) return null
  return [...(shell ? [raw] : []), ...paths.map((path) => writeOf(input, path, text))]
}

// Each input guardInputs reads, judged in turn until one is refused; a Codex edit it cannot read is refused in the guard's name.
export async function eachInput(
  raw: string,
  guard: string,
  judge: (input: string) => Promise<string | undefined>,
): Promise<string | undefined> {
  const inputs = guardInputs(raw)
  if (!inputs)
    return `${guard} hook refuses an apply_patch whose patch names no file it can read: give the patch whole in the call itself, with each file on its own *** Add File, *** Update File or *** Delete File line.`
  for (const input of inputs) {
    const reason = await judge(input)
    if (reason) return reason
  }
}
