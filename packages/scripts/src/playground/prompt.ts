// A permission prompt on a session's pane, judged against the session's waiting calls by the check `playground picker` makes before it presses a key, so ops-unstick's alert names only a key picker accepts. It imports by relative source path alone, as stuck-alert.ts does, so ops-unstick runs `bun prompt.ts answer` from the main checkout with no build.
import { basename } from "node:path"

import { configDirOf } from "../../../env/src/data-dir"
import { callKey, pendingCalls, pickerLines, transcriptOf } from "../stuck-alert"

// A permission prompt as Claude Code draws it (2.1, read off a herdr pane on 26 Oct): a full rule, its title, then the command between two dashed rules, any warning (a hook's confirmation prompt puts its reason here), its question and the cursor on its first option, Yes; one taller than the pane is clipped from its top (13 Nov).
const QUESTION = /Do you want to (proceed|make this edit|create|allow|run|fetch|use|overwrite)/i
const FIRST_YES = /^\s*[│ ]*❯\s*1\.\s+Yes\b/m
const RULE = /^\s*─{3,}\s*$/
const DASHES = /^\s*╌{3,}\s*$/

// A dialog's lines, and whether Claude Code clipped it: then its lines are the rows of its command box left on screen alone.
type Dialog = { clipped: boolean; lines: string[] }

// Pure: the permission dialog at a pane's foot, from below its top rule to its question; when no top rule shows but a dashed rule does, the box's rows above that last dashed rule, from the screen's top or the box's top dashed rule, since Claude Code clips a prompt taller than the pane from its top; else null.
function dialogOf(screen: string): Dialog | null {
  const lines = screen.trimEnd().split("\n")
  const question = lines.findLastIndex((line) => QUESTION.test(line))
  if (question < lines.length - 15 || !FIRST_YES.test(lines.slice(question).join("\n"))) return null
  const top = lines.slice(0, question).findLastIndex((line) => RULE.test(line))
  if (top >= 0) return { clipped: false, lines: lines.slice(top + 1, question + 1) }
  const box = lines.slice(0, question).findLastIndex((line) => DASHES.test(line))
  if (box < 0) return null
  const from = lines.slice(0, box).findLastIndex((line) => DASHES.test(line))
  return { clipped: true, lines: lines.slice(from + 1, box) }
}

// The tools whose child raises its own prompts while the call waits on it: a subagent (Agent, Task), a forked skill (Skill), a workflow's agents (Workflow); so a waiting call of one is never the prompt's own.
const PARENTS = new Set(["Agent", "Skill", "Task", "Workflow"])

// Pure: whether matchOf() can judge a call at all: one with a command, a URL or a file.
const judgeable = (input: Record<string, unknown>): boolean =>
  ["command", "file_path", "url"].some((name) => typeof input[name] === "string")

// no-raw-spawn refuses a key into a herdr pane from any session, the dispatcher included, so a close and a resume is the route left.
const herdrRoute = (name: string): string =>
  `close the session with spawn.sh close ${name}, then run the spawn.sh resume line ~/.playground/resume/${name}.sh holds with --brief <a file under ~/.playground of the reason and the simpler shape> added, and a reviewer's or tester's --pr <the PRs its roster row lists>, so it resumes under its name by its session id and the prompted call never runs`

// Pure: how a dialog matches the call, with whitespace and box borders dropped, since the pane wraps a long one: on a clipped dialog "weak" when its rows end the command, else null; otherwise "strong" when the command is the whole text between its dashed rules, "weak" when the command or URL sits whole in a dialog with no such box or the file's name sits in it, else null.
function matchOf(
  { clipped, lines: dialog }: Dialog,
  input: Record<string, unknown>,
): "strong" | "weak" | null {
  const flat = (text: string) => text.replace(/[\s│]+/g, "")
  const text = flat(dialog.join(""))
  if (clipped)
    return typeof input.command === "string" && text && flat(input.command).endsWith(text)
      ? "weak"
      : null
  if (typeof input.command === "string") {
    const [from, to] = dialog.flatMap((line, i) => (DASHES.test(line) ? [i] : []))
    if (from !== undefined && to !== undefined)
      return flat(dialog.slice(from + 1, to).join("")) === flat(input.command) ? "strong" : null
    return flat(input.command) && text.includes(flat(input.command)) ? "weak" : null
  }
  if (typeof input.url === "string")
    return flat(input.url) && text.includes(flat(input.url)) ? "weak" : null
  return typeof input.file_path === "string" && text.includes(flat(basename(input.file_path)))
    ? "weak"
    : null
}

// Pure: why picker presses no key for this call on a pane showing this screen, or "" when the prompt is the call's own.
export function refusalOf(name: string, screen: string, transcript: string, key: string): string {
  const call = pendingCalls(transcript).find((input) => callKey(input) === key)
  if (!call) return `${name} has no call waiting with key ${key}; nothing was pressed`
  const dialog = dialogOf(screen)
  if (!dialog) return `${name}'s pane shows no permission prompt; nothing was pressed`
  const match = matchOf(dialog, call)
  if (!match) return `${name}'s prompt is not for the call with key ${key}; nothing was pressed`
  // Only a strong match rules out a waiting parent's own prompt, which draws no dashed box.
  const others = pendingCalls(
    transcript,
    match === "strong" ? (tool) => !PARENTS.has(tool as string) : undefined,
  )
  return others.some(
    (other) => callKey(other) !== key && (!judgeable(other) || matchOf(dialog, other)),
  )
    ? `${name}'s prompt may be another waiting call's (a subagent's file or URL prompt always is, while its parent waits); nothing was pressed: ${herdrRoute(name)}`
    : ""
}

// Pure: the key picker answers the prompt on this screen by, a waiting call's, subagents' included, else null.
export const promptKey = (screen: string, transcript: string): string | null =>
  pendingCalls(transcript)
    .map(callKey)
    .find((key) => !refusalOf("", screen, transcript, key)) ?? null

// Pure: how ops-unstick's alert has the manager answer a permission prompt it read off a screen: picker's lines by the key of the waiting call the prompt shows, else the route left.
export const answerOf = (name: string, key: string | null): string =>
  key
    ? pickerLines(name, key)
    : `playground picker cannot answer it, since no waiting call is surely its own: ${herdrRoute(name)}.`

// `bun prompt.ts answer <name> <session id>`, the screen on stdin: prints answerOf() for the permission prompt that herdr pane's screen shows, for ops-unstick's screen backstop.
if (import.meta.main && process.argv[2] === "answer") {
  const [name = "", sessionId = ""] = process.argv.slice(3)
  const transcript = await transcriptOf(configDirOf(process.env), sessionId)
  console.log(answerOf(name, transcript ? promptKey(await Bun.stdin.text(), transcript) : null))
}
