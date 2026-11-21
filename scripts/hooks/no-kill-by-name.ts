// PreToolUse hook, acting for a factory session alone (role.ts): refuses a Bash command that signals processes chosen by name, pattern or port (pkill, killall, fuser -k, or kill in a call that searches with pgrep, pidof, lsof, ps or fuser, the words after run-slot.sh's -- read as the command), since a pattern matches the live dashboard and every worker's stack (31 Oct: a session ran pkill -f on its own watcher). It refuses a portless proxy stop with no port and a portless clean too, run by any launcher and behind portless's global flags, since each stops whichever proxy answers on 443, 80 or 1355. A kill given a literal pid, $! or a pid file's contents passes, as does every search alone, `ps -p <pid>` and a proxy stop given `-p <port>`.

import { input } from "./input"
import { fromFactory } from "./role"
import {
  examine,
  globSpells,
  lex,
  parse,
  program,
  run,
  shellSlot,
  SHELLS,
  slotWords,
  spelledText,
  UNKNOWN,
  type Command,
  type Visit,
  type Word,
} from "./shell"

const BY_NAME = new Set(["killall", "pkill"])
// The programs whose name in a call, written out or as a glob that may match it (`pk?ll`), sends the call to the full read
const KILLS = ["fuser", "kill", "killall", "pkill"]
const SEARCHES = new Set(["fuser", "lsof", "pgrep", "pidof", "ps"])
const READS_ONLY = new Set(["--help", "--version", "-V", "-h"])
// The programs that run portless from a word of theirs: bunx portless, npx -p portless portless, pnpm dlx portless, yarn portless, node node_modules/portless/dist/cli.js
const LAUNCHERS = new Set(["bun", "bunx", "node", "npm", "npx", "pnpm", "pnpx", "yarn"])
// portless's global flags, which it strips before it reads the subcommand (cli.js:8188-8226), and the ones of them that take a value
const GLOBAL_FLAGS = new Set(["--cloudflare", "--funnel", "--lan", "--ngrok", "--tailscale"])
const GLOBAL_VALUED = new Set(["--ip", "--lan-ip-auto", "--script"])

const WAY_OUT =
  "Stop a background task with TaskStop, a dev stack with bun run dev:stop in its worktree, and a process you spawned with kill <pid> on the pid you hold ($! or its pid file)."

const refuse = (what: string, beside = "") =>
  `no-kill-by-name hook refuses ${what}: a name, pattern or port matches the live dashboard and every worker's stack, not only your own process. ${WAY_OUT}${beside}`

// `command -v pkill` and `pkill --help` only read; `command -v` counts only before the program, since pkill's own -v inverts its match
const readsOnly = (cmd: Command, first: Word | undefined, args: Word[]) => {
  const before = cmd.words.slice(0, first ? cmd.words.indexOf(first) : 0)
  return (
    before.some(
      (w, i) => program(w.value) === "command" && /^-[vV]$/.test(before[i + 1]?.value ?? ""),
    ) ||
    (args.length > 0 && args.every((a) => READS_ONLY.has(a.value)))
  )
}

// portless by its name, a path to it or its dist/cli.js, a package name's trailing @<version or tag> read past (npx portless@0.15.11)
const isPortless = (word: string) => {
  const name = word.replace(/(?<=.)@[^@/]*$/, "")
  return program(name) === "portless" || /(?:^|\/)portless\/dist\/cli\.js$/.test(name)
}

// The words after each word that may run portless: the program itself, or any word of a launcher's, so npx -p portless portless yields both readings and either may be the stop
const portlessRuns = (name: string, args: Word[]): string[][] => {
  const values = args.map((a) => a.value)
  if (isPortless(name)) return [values]
  if (!LAUNCHERS.has(name)) return []
  return values.flatMap((v, i) => (isPortless(v) ? [values.slice(i + 1)] : []))
}

// portless 0.15.11 with its global flags stripped: a proxy stop reads its port as cli.js:7048 does, the word after the first --port, else after the first -p, and with none probes 443, 80 and 1355 and stops whichever proxy answers (cli.js:2121); clean stops the proxy discoverState finds and takes no port (cli.js:6326-6330)
const probingStop = (words: string[]) => {
  const args = words.filter(
    (v, i) =>
      !GLOBAL_FLAGS.has(v) && !GLOBAL_VALUED.has(v) && !GLOBAL_VALUED.has(words[i - 1] ?? ""),
  )
  if (args[0] === "clean") return !args.slice(1).some((v) => v === "--help" || v === "-h")
  if (args[0] !== "proxy" || args[1] !== "stop") return false
  const flag = args.includes("--port") ? args.indexOf("--port") : args.indexOf("-p")
  return flag < 0 || !/^\d+$/.test(args[flag + 1] ?? "")
}

// ps given a pid (-p, -q, --pid, --quick-pid) checks that one process, which is the way out's own liveness check
const isSearch = (name: string, args: Word[]) =>
  SEARCHES.has(name) &&
  !(
    name === "ps" && args.some((a) => /^-[A-Za-z]*[pq]$|^-[pq]\d|^--(?:quick-)?pid\b/.test(a.value))
  )

async function inspect(raw: string) {
  const { tool_input: toolInput, tool_name: tool } = JSON.parse(raw) as {
    tool_input?: { command?: unknown }
    tool_name?: unknown
  }
  if (tool !== "Bash" || typeof toolInput?.command !== "string") return
  // Quotes and backslashes go first, since the shell reads p"k"ill and \pkill as pkill. An ANSI-C string's words are read as the lexer decodes them (`$'pkill\x20-f'`). These pass the first look too: 2 or more back-to-back variable reads (`$P$Q`), whose joined name the reader resolves; a glob that may match a kill program (`/usr/bin/pk?ll`), matched on the disk; a brace list or zsh group, spelled out by spelledText (`/usr/bin/pk{i,x}ll`, `/usr/bin/pk(i|x)ll`); and a brace sequence joined to a name (`pk{i..i}ll`), which the reader reads as unread
  const decoded = toolInput.command.includes("$'")
    ? lex(toolInput.command)
        .commands.flatMap((c) => c.words.map((w) => w.value))
        .join(" ")
    : ""
  const bare = spelledText(`${toolInput.command} ${decoded}`).replace(/["'\\]/g, "")
  const namesKill =
    /\b(?:fuser|kill|killall|pkill)\b/.test(bare) ||
    /(?:\$\{?\w+\}?){2,}/.test(bare) ||
    /\w\{[^{}\s]*\.\.[^{}\s]*\}|\{[^{}\s]*\.\.[^{}\s]*\}\w/.test(bare) ||
    globSpells(bare, KILLS)
  if (!namesKill && !/\bportless\b/.test(bare)) return
  const lexed = lex(toolInput.command)
  const fresh = () => ({ files: new Map(), known: {}, process: {}, vars: new Map() })
  // the whole call is read for a search first, since a loop's `done < <(pgrep …)` is read after the kill it feeds
  let search: string | undefined
  const find: Visit = async (cmd, parsed, env) => {
    const slot = slotWords(parsed)
    if (slot?.length) return examine({ ...cmd, words: slot }, env, find, false)
    if (isSearch(parsed.name, parsed.args)) search ??= parsed.name
    return undefined
  }
  await run(lexed, fresh(), find)
  // a pid xargs hands a shell it starts arrives as the -I string (`xargs -I{} sh -c 'kill {}'`)
  const handed = lexed.commands.flatMap((c) => parse(c).xargs?.replace || [])
  const visit: Visit = async (cmd, parsed, env) => {
    // run-slot.sh, typed bare or as a shell's script, runs the words after its -- as the command, with the input an xargs running run-slot hands that command alone
    const slot =
      slotWords(parsed) ??
      (SHELLS.has(parsed.name) ? shellSlot(parsed.args, parsed.name) : undefined)
    if (slot?.length) {
      const slotted = { ...cmd, words: slot }
      return examine(
        slotted,
        env,
        (c, p, e) => visit(c, c === slotted ? { ...p, xargs: p.xargs ?? parsed.xargs } : p, e),
        false,
      )
    }
    const { args, first, name, xargs } = parsed
    // a command the shell builds from a value the reader cannot read may be any kill, in a call whose text names one
    if (parsed.unread && namesKill)
      return refuse(
        "a command built from a value it cannot read, in a call that names a kill",
        " Write the program and its words out in the call.",
      )
    if (portlessRuns(name, args).some(probingStop))
      return refuse(
        "a portless proxy stop with no port, or a portless clean",
        " portless then probes 443, 80 and 1355 and stops whichever proxy answers, the live one every worktree routes through: stop your own proxy with portless proxy stop -p <its port>.",
      )
    if (BY_NAME.has(name) && !readsOnly(cmd, first, args)) return refuse(name)
    if (name === "fuser" && args.some((a) => /^-\w*k|^--kill\b/.test(a.value)))
      return refuse("fuser -k")
    if (name !== "kill" || !search) return
    const fed =
      xargs ||
      args.some((a) => a.value.includes(UNKNOWN) || handed.some((h) => a.value.includes(h)))
    if (fed)
      return refuse(
        `a kill in a call that searches with ${search}`,
        ` Run a kill of a pid you hold in a Bash call of its own, apart from the search.`,
      )
  }
  return run(lexed, { ...fresh(), visitShells: true }, visit)
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
  const raw = await input("no-kill-by-name", "guard")
  const reason = (await fromFactory(raw)) ? await check(raw) : undefined
  if (reason) {
    console.error(reason)
    process.exit(2)
  }
}
