// The macOnly count: each call in the repo's code to a program or form that macOS alone has, with no Linux branch in front of it, so the ratchet stops a new one landing now the factory also runs on Linux. It is no private trace, so it stays out of kinds.ts, whose patterns no-public-leak refuses.
import type { File } from "./count"

// Each Mac-only call as its words, A to Z: a shell line runs them space-separated, and an argv names each as its own quoted string. `security find-generic-password` is no such call, since on Linux link-skills.sh links packages/scripts/src/security/cli.ts to ~/.bun/bin/security, which serves it.
const PROGRAMS = [
  ["brew", "install"],
  ["caffeinate"],
  ["cp", "-c"],
  ["launchctl"],
  ["memory_pressure"],
  ["open", "-a"],
  ["osascript"],
  ["pmset"],
  ["sysctl", "-n"],
  ["top", "-l"],
  ["vm_stat"],
]

// Where a shell line starts a command: the line's start, after an operator or `$(`, a backtick, or a word that runs the next one.
const SHELL_HEAD = String.raw`(?<=(?:^|[;&|{\x60!]|\$\(|\b(?:command|do|elif|else|env|exec|if|nohup|sudo|then|time|xargs))\s*["']?)`
const SHELL_CALL = new RegExp(
  `${SHELL_HEAD}(?:${PROGRAMS.map((words) => words.join(String.raw`\s+`)).join("|")})(?=\\s|$|[;&)])`,
)
// An argv's head: the program's name as a whole quoted string, first in an array or a call's first argument, its words on one line or split over several (`["vm_stat"`, `Bun.which("osascript"`).
const ARGV_CALL = new RegExp(
  `[[(]\\s*(?:${PROGRAMS.map((words) => words.map((word) => `["'\x60]${word}["'\x60]`).join(String.raw`\s*,\s*`)).join("|")})`,
  "g",
)

const CODE = /\.(?:[cm]?[jt]sx?|py|sh)$/
const SHELL = /\.sh$/
const COMMENT = /^\s*(?:\/\/|\/?\*|#)/
// A line's code, its trailing comment cut (`#` in a shell or Python file, `//` elsewhere, each after a space), so a comment that names Linux tests nothing.
const codeOf = (line: string, hash: boolean): string =>
  line.replace(hash ? /(?:^|\s)#.*$/ : /(?:^|\s)\/\/.*$/, "")
// A test of the platform, as a word match in a line's code: a shell's uname or OSTYPE, or the word darwin or linux, in any case (`Darwin)`, `darwin:`, `linux ?`), or a read of the platform in lower case (`process.platform`, `sys.platform`, `platform()`, `platform.system()`), so a name such as a `platform: NodeJS.Platform` parameter reads none.
const PLATFORM_WORD = /\buname\b|\bOSTYPE\b|\bdarwin\b|\blinux\b/i
const PLATFORM_READ = /\.platform\b|\bplatform(?:\.system)?\(/
const testsPlatform = (line: string): boolean =>
  PLATFORM_WORD.test(line) || PLATFORM_READ.test(line)
// A line that leaves its block, so an earlier platform test there takes Linux another way (`[ "$OS" = Darwin ] || return 1`).
const LEAVES = /\b(?:continue|exit|return|throw)\b/

const indent = (line: string): number => line.length - line.trimStart().length

// Whether a Linux branch covers line i of a file's code lines: its own line or an enclosing block's opening line tests the platform, or an earlier line of one of those blocks tests it and leaves; a top-level line's earlier lines are never read, so one test at a file's top guards nothing below it.
const guarded = (code: string[], i: number): boolean => {
  if (testsPlatform(code[i]!)) return true
  let depth = indent(code[i]!)
  for (let j = i - 1; j >= 0 && depth > 0; j--) {
    const line = code[j]!
    if (!line.trim()) continue
    const at = indent(line)
    if (at < depth) {
      if (testsPlatform(line)) return true
      depth = at
    } else if (at === depth && testsPlatform(line) && LEAVES.test(line)) return true
  }
  return false
}

// Whether a file is code the count reads: a source or script by its extension or its shebang, outside tests/ and this file, which hold these names as data.
const isCode = ({ path, text }: File): boolean =>
  (CODE.test(path) || text.startsWith("#!")) &&
  !path.startsWith("tests/") &&
  path !== "packages/scripts/src/trace-count/mac-only.ts"

// The 0-based lines of a file that hold a counted call, ascending: a call at a command's head, or an argv's at the line of its opening bracket, in a line's code, with no Linux branch in front of it.
export const macOnlyLines = (file: File): number[] => {
  if (!isCode(file)) return []
  const shell = SHELL.test(file.path) || /^#!.*\b(?:ba|z)?sh\b/.test(file.text)
  const hash = shell || file.path.endsWith(".py")
  const lines = file.text.split("\n")
  const code = lines.map((line) => (COMMENT.test(line) ? "" : codeOf(line, hash)))
  const starts: number[] = []
  lines.reduce((at, line) => (starts.push(at), at + line.length + 1), 0)
  const lineOf = (at: number) => starts.findLastIndex((start) => start <= at)
  const argv = [...file.text.matchAll(ARGV_CALL)].flatMap((match) => {
    const i = lineOf(match.index)
    return match.index - starts[i]! < code[i]!.length ? [i] : []
  })
  const heads = code.flatMap((line, i) => (shell && SHELL_CALL.test(line) ? [i] : []))
  return [...new Set([...heads, ...argv])].filter((i) => !guarded(code, i)).sort((a, b) => a - b)
}

// Each counted call as path:line: macOnly, the changed files' alone when they hold one, as located names the other kinds.
export const macOnlyAt = (files: File[], changed: string[] = []): string[] => {
  const at = (from: File[]) =>
    from.flatMap((file) => macOnlyLines(file).map((i) => `${file.path}:${i + 1}: macOnly`))
  const own = at(files.filter((file) => changed.includes(file.path)))
  return own.length > 0 ? own : at(files)
}
