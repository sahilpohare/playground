// A check for the factory's sessions, run on Bash by guards.ts, so it has no main block of its own: lets a Vercel CLI call (vercel or vc, by any path or case, run as the shell walker reads a command and through bun x, bunx or npx, a runner one of them or bun's run or bare path starts included) run only as a read (whoami, ls, inspect, logs, help, the ls of alias, dns, domains, integration, project and teams, env ls without its values, promote and rollback status, rolling-release inspect, a vercel api GET outside /env) or a preview deploy, and refuses every other call, a command or deploy subcommand a later CLI adds included; a production move (a production deploy, which also migrates the hosted database, a deploy continue, a redeploy, a promote, a rollback, an alias or a rolling release) passes for the Ops lead alone, in a call that names no role variable and sources no file.
import { basename, isAbsolute, resolve } from "node:path"

import {
  bunCall,
  runnerReadings,
  runnerTarget,
  STARTED_RUNNERS,
  toolName,
  toolWords,
  UNREAD_CWD,
} from "./no-main-checkout"
import { namesRole, opsLead } from "./role"
import {
  type Env,
  lex,
  marked,
  program,
  run,
  slotWords,
  unreadable,
  viaXargs,
  type Visit,
  type Word,
} from "./shell"

type Environment = Record<string, string | undefined>
type Verdict = { production: boolean; what: string }

const NAMES = ["vc", "vercel"]
const words = (text: string) => new Set(text.split(" "))
type Options = { flags: Set<string>; takes: Set<string> }
// vercel 65.8.0's global options (`vercel --help` and globalCommandOptions in its dist), which every command takes.
const GLOBAL: Options = {
  flags: words("--debug --help --no-color --non-interactive --version -d -h -v"),
  takes: words("--api --cwd --global-config --local-config --scope --team --token -A -Q -S -T -t"),
}
// The options of each command judged here, from its --help on 65.8.0; any other option is read both ways, as a flag and as taking the next word.
// deploy's from deployCommand in the dist, its deprecated letters included: -e is --env's and -b --build-env's (DEPRECATED_SHORTHANDS), and judge() still reads an -e with no = as the environment.
const DEPLOY: Options = {
  flags: words(
    "--confirm --create-if-missing --dry --force --guidance --json --logs --no-clipboard --no-logs --no-wait --prebuilt --prod --skip-domain --temporary --turbo --verify --with-cache --yes -c -f -l -y",
  ),
  takes: words(
    "--archive --build-env --env --environment --format --meta --name --project --regions --target -F -b -e -m -n -p",
  ),
}
const INSTALL: Options = {
  flags: words("--claim --json --no-claim --no-connect --no-env-pull"),
  takes: words("--billing-plan --environment --installation --meta --name --prefix -e"),
}
const OWN: Record<string, Options> = {
  api: {
    flags: words(
      "--dangerously-skip-permissions --include --paginate --raw --refresh --silent --verbose -i",
    ),
    takes: words("--field --generate --header --input --method --raw-field --spec-url -F -H -X -f"),
  },
  deploy: DEPLOY,
  env: {
    flags: words("--guidance --json --yes -y"),
    takes: words("--environment --format --git-branch --project -F -e -p"),
  },
  install: INSTALL,
  integration: INSTALL,
  promote: { flags: words("--yes -y"), takes: words("--timeout") },
  redeploy: { flags: words("--no-wait"), takes: words("--environment --target -e") },
  rollback: { flags: words("--yes -y"), takes: words("--timeout") },
}
// Each command alias vercel 65.8.0 registers (commandsStructs' aliases in its dist), read as its command.
const ALIASES = new Map(
  Object.entries({
    aliases: "alias",
    budget: "budgets",
    cert: "certs",
    cron: "crons",
    daemon: "daemons",
    "deploy-hook": "deploy-hooks",
    develop: "dev",
    domain: "domains",
    drain: "drains",
    "edge-config": "global-config",
    environment: "environments",
    i: "install",
    image: "images",
    ir: "integration-resource",
    ln: "alias",
    log: "logs",
    ls: "list",
    mf: "microfrontends",
    organization: "organizations",
    permission: "permissions",
    projects: "project",
    rm: "remove",
    rr: "rolling-release",
    "status-page": "health",
    switch: "teams",
    tags: "tag",
    target: "environments",
    targets: "environments",
    team: "teams",
    versions: "version",
    webhook: "webhooks",
  }),
)
// vercel 65.8.0's commands (commandsStructs' names in its dist); any other first word is the path the default command, deploy, takes.
const COMMANDS = words(
  "activity agent agent-runs ai-gateway alerts alias api bisect blob budgets build builders buy cache certs changelog ci comments config connect contract crons curl daemons deploy deploy-hooks dev dns domains drains env environments experiments feedback firewall flags git global-config guidance health help httpstat image images init inspect install integration integration-resource kms link list login logout logs mcp metrics microfrontends monitors notifications open organizations page-integrity permissions pricing project promote pull redeploy redirects remove rollback rolling-release routes sandbox schedules security setup signup skills storage tag teams telemetry tokens traces upgrade usage vcr version webhooks whoami",
)
// The reads that pass whatever their options; judge() reads every other command by its words.
const READS = words("help inspect list logs whoami")
// The commands whose ls or list subcommand is a read.
const LISTS = words("dns domains integration project teams")
const HELP = new Set(["--help", "--version", "-h", "-v"])
const API_BODY = new Set(["--field", "--input", "--raw-field", "-F", "-f"])
// The readings one call's options make at most, so many unknown options cost a bounded time; past them the call is refused as one the hook cannot read.
const READINGS = 64

const MENTION = /\bv(?:ercel|c)\b|\byard\b/i
const STEP_NAMED = /\byard\b/i
// vercel or vc as a word of its own (an assignment's value, a tool at a version), so a program built at run time on such a line may be it.
const NAMED = /(?:^|[\s=;&|(`'"])v(?:ercel|c)(?=$|[\s;&|)`'"@])/i

type Flag = { name: string; value?: Word }
type Reading = { flags: Flag[]; positionals: Word[] }

// Every reading of a call's words under these options, each up to its first positional when toSub is set: an option on neither list is read both as a flag and as taking the next word (or the rest of its cluster), or undefined past READINGS.
function readingsOf(args: Word[], { flags, takes }: Options, toSub = false): Reading[] | undefined {
  const out: Reading[] = []
  const walk = (k: number, read: Reading): boolean => {
    if (out.length >= READINGS) return false
    for (; k < args.length; k++) {
      const v = args[k]!.value
      if (v === "--") {
        out.push({ ...read, positionals: [...read.positionals, ...args.slice(k + 1)] })
        return true
      }
      if (v.startsWith("--")) {
        const eq = v.indexOf("=")
        const name = eq === -1 ? v : v.slice(0, eq)
        if (eq !== -1)
          read = {
            ...read,
            flags: [...read.flags, { name, value: { ...args[k]!, value: v.slice(eq + 1) } }],
          }
        else if (takes.has(name))
          read = { ...read, flags: [...read.flags, { name, value: args[++k] }] }
        else if (flags.has(name)) read = { ...read, flags: [...read.flags, { name }] }
        else {
          if (!walk(k + 2, { ...read, flags: [...read.flags, { name, value: args[k + 1] }] }))
            return false
          read = { ...read, flags: [...read.flags, { name }] }
        }
        continue
      }
      if (v.startsWith("-") && v.length > 1) {
        for (let c = 1; c < v.length; c++) {
          const name = `-${v[c]}`
          const attached =
            c + 1 < v.length
              ? { ...args[k]!, value: v.slice(v[c + 1] === "=" ? c + 2 : c + 1) }
              : undefined
          if (flags.has(name)) {
            read = { ...read, flags: [...read.flags, { name }] }
            continue
          }
          const taken = {
            ...read,
            flags: [...read.flags, { name, value: attached ?? args[k + 1] }],
          }
          if (takes.has(name)) {
            read = taken
            if (!attached) k++
            break
          }
          if (!walk(attached ? k + 1 : k + 2, taken)) return false
          read = { ...read, flags: [...read.flags, { name }] }
        }
        continue
      }
      read = { ...read, positionals: [...read.positionals, args[k]!] }
      if (toSub) break
    }
    out.push(read)
    return true
  }
  return walk(0, { flags: [], positionals: [] }) ? out : undefined
}

const commandOf = (word: Word | undefined): string | undefined =>
  word === undefined ? undefined : (ALIASES.get(word.value) ?? word.value)

// What one vercel call does that the hook refuses, or undefined when it reads, deploys a preview or prints help: the gravest verdict over every reading of its options, first by the global ones alone, then by its command's own.
function judgeAll(args: Word[], fed: boolean): Verdict | undefined {
  const unread: Verdict = {
    production: false,
    what: "a vercel call with more options than the hook reads",
  }
  const first = readingsOf(args, GLOBAL, true)
  if (!first) return unread
  const verdicts: (Verdict | undefined)[] = []
  for (const name of new Set(first.map((r) => commandOf(r.positionals[0])))) {
    // a read (logs, inspect, whoami) passes whatever options follow it
    if (name !== undefined && READS.has(name)) continue
    const own = OWN[name !== undefined && COMMANDS.has(name) ? name : "deploy"]
    const options = own
      ? {
          flags: new Set([...GLOBAL.flags, ...own.flags]),
          takes: new Set([...GLOBAL.takes, ...own.takes]),
        }
      : GLOBAL
    const readings = readingsOf(args, options)
    if (!readings) return unread
    for (const reading of readings) verdicts.push(judge(reading, args.some(unreadable), fed))
  }
  return verdicts.find((v) => v && !v.production) ?? verdicts.find(Boolean)
}

function judge(
  { flags, positionals }: Reading,
  unreadWord: boolean,
  fed: boolean,
): Verdict | undefined {
  if (flags.some((f) => HELP.has(f.name))) return
  const [sub, ...rest] = positionals
  if (sub && unreadable(sub)) return { production: false, what: "a subcommand built at run time" }
  // xargs puts words from stdin among its words, which the hook cannot read, so a fed call it judges is refused for every session
  if (fed) return { production: false, what: "a vercel call whose words xargs feeds" }
  const built = unreadWord
  const has = (...names: string[]) => flags.some((f) => names.includes(f.name))
  // whether the last of these flags names production, or one it cannot read; absent, the command's own default
  const toProduction = (names: string[], absent: boolean) => {
    const flag = flags.findLast((f) => names.includes(f.name))
    if (!flag) return absent
    return !flag.value || unreadable(flag.value) || flag.value.value.toLowerCase() === "production"
  }
  const next = rest[0]?.value
  const name = commandOf(sub)
  const listing = next === "ls" || next === "list"
  // a first word that names no command is the folder deploy takes only when it reads as a path, so a command a later CLI adds is refused
  const path = sub !== undefined && !COMMANDS.has(name!) && /[./~]/.test(sub.value)
  // deploy's own subcommands: continue lands a deployment whose target the hook cannot read, init keeps deploy's rules, and any other word but a path is refused, so one a later CLI adds stays closed
  if (name === "deploy" && rest[0] !== undefined && next !== "init") {
    if (next === "continue") return { production: true, what: "a manual deploy's continue" }
    if (unreadable(rest[0]))
      return { production: false, what: "a word built at run time after vercel deploy" }
    if (!/[./~]/.test(next!)) return { production: false, what: `\`vercel deploy ${next}\`` }
  }
  // deploy's -e is --env's letter in 65.8.0 but names the environment on redeploy and env, and a letter's meaning can move between versions, and a run-time env var is KEY=VALUE, so a value with no = reads as the environment
  const envLetter = flags.some(
    (f) => f.name === "-e" && (!f.value || unreadable(f.value) || !f.value.value.includes("=")),
  )
  if (name === undefined || name === "deploy" || path)
    return has("--prod") || toProduction(["--environment", "--target"], false) || envLetter || built
      ? { production: true, what: "a production deploy" }
      : undefined
  if (name === "redeploy")
    return toProduction(["--environment", "-e", "--target"], true) || built
      ? { production: true, what: "a redeploy that may land in production" }
      : undefined
  if (name === "promote" || name === "rollback")
    return next === "status" ? undefined : { production: true, what: `a ${name}` }
  if (name === "alias") return listing ? undefined : { production: true, what: "an alias change" }
  if (name === "rolling-release")
    return next === "inspect" ? undefined : { production: true, what: "a rolling release step" }
  if (LISTS.has(name) && listing) return
  if (name === "env" && listing) {
    const format = flags.findLast((f) => f.name === "--format" || f.name === "-F")
    const json =
      !!format &&
      (!format.value || unreadable(format.value) || format.value.value.toLowerCase() === "json")
    return has("--json") || json || built
      ? { production: false, what: "an env list with its values" }
      : undefined
  }
  if (name === "api") return judgeApi(rest, flags, built)
  const words = [sub!.value, ...(next === undefined || unreadable(rest[0]!) ? [] : [next])]
  return { production: false, what: `\`vercel ${words.join(" ")}\`` }
}

// A vercel api call: a write (a method other than GET, or any body) or a read of a project's env.
function judgeApi(rest: Word[], flags: Flag[], built: boolean): Verdict | undefined {
  const [endpoint] = rest
  if (!endpoint || endpoint.value === "list") return
  if (built) return { production: false, what: "a vercel api call built at run time" }
  const method = flags.findLast((f) => f.name === "-X" || f.name === "--method")
  if (method && (!method.value || method.value.value.toUpperCase() !== "GET"))
    return { production: false, what: "a vercel api write" }
  if (flags.some((f) => API_BODY.has(f.name)))
    return { production: false, what: "a vercel api call with a body" }
  if (/(?:^|\/)env(?:[/?#]|$)/i.test(endpoint.value))
    return { production: false, what: "a vercel api read of a project's env" }
}

// The release skill's Yard ship step, which runs vercel deploy --prod itself, so its own command line is the production move: bun with its script (`bun run ship:yard`, `bun ship:yard`) or its file, resolved against the folder bun runs in, bun reached through a package runner, and npm, pnpm or yarn with its script; its help, before any `--`, moves nothing, and by another runner it is never help.
const STEP_FILE = /(?:^|\/)packages\/scripts\/src\/ship\/yard\.ts$/
const STEP_HELP = new Set(["--help", "-h"])
const RUNNERS = new Set(["npm", "pnpm", "yarn"])

function yardStep(name: string, args: Word[], shell: Env): boolean {
  if (RUNNERS.has(name)) return args.some((a) => a.value === "ship:yard")
  if (name !== "bun") return false
  const { at, chained, words } = bunCall(args, shell)
  const file = words[0] === "run" ? words[1] : words[0]
  if (file === undefined) return false
  const path = isAbsolute(file) ? file : chained ? resolve(chained, file) : undefined
  // with no folder to read it from, any file named yard.ts may be the step
  const step = file === "ship:yard" || (path ? STEP_FILE.test(path) : basename(file) === "yard.ts")
  const end = args.findIndex((a, k) => k > at && a.value === "--")
  return (
    step && !args.slice(at + 1, end === -1 ? undefined : end).some((a) => STEP_HELP.has(a.value))
  )
}

// The package runners that may hand bun its words (bunx, bun x, npx, and npm, pnpm or yarn by exec, x, dlx or a bin's name): each runner's words after each word naming bun, since one may be an option's value (npx -p bun bun ...).
const PACKAGE_RUNNERS = new Set(["bunx", "npm", "npx", "pnpm", "yarn"])
// A runner's words that may move the folder bun runs in (bun x --cwd, pnpm -C, --dir or --filter, npm --prefix or a workspace, yarn's workspace command), so the step's file is then read as any yard.ts.
const MOVES = /^(?:--(?:cwd|dir|filter|prefix|workspace)(?:=|$)|-[CFw]|workspaces?$)/
// The runners' options whose value is a command line they run in a shell (npm exec -c, npx --call, pnpm's shell mode).
const CALLS = new Set(["--call", "--shell-mode", "-c"])

type Reached = { args: Word[]; shell: Env }

function runnerBuns(name: string, args: Word[], shell: Env): Reached[] {
  let offset = 0
  if (name === "bun") {
    const { at, chained, sub, words } = bunCall(args, shell)
    if (words[0] !== "x") {
      // bun run starts a package's bin or a command on PATH by its name, and bare bun a package's bin (bun's run docs, its resolution order), so a runner either names may reach bun
      const started = toolName(args[at]?.value)
      const there = { ...shell, cwd: chained }
      if (started === "bun") return [{ args: args.slice(at + 1), shell: there }]
      return PACKAGE_RUNNERS.has(started) ? runnerBuns(started, args.slice(at + 1), there) : []
    }
    offset = sub + 1
  } else if (!PACKAGE_RUNNERS.has(name)) return []
  const reached: Reached[] = []
  for (let at = offset; at < args.length; at++) {
    if (toolName(args[at]!.value) !== "bun") continue
    const moved = args.slice(0, at).some((a) => MOVES.test(a.value))
    reached.push({ args: args.slice(at + 1), shell: moved ? { ...shell, cwd: undefined } : shell })
  }
  return reached
}

// Each bun a chain of package runners may reach (npx bun x bun ...), bounded so a long line costs a bounded time.
function throughRunners(name: string, args: Word[], shell: Env): Reached[] {
  const reached: Reached[] = []
  const queue = runnerBuns(name, args, shell)
  while (queue.length > 0 && reached.length < 32) {
    const next = queue.shift()!
    reached.push(next)
    for (const reading of runnerReadings("bun", next.args))
      queue.push(...runnerBuns("bun", reading, next.shell))
  }
  return reached
}

// The command lines a runner runs in a shell, each the value of its -c, --call or shell-mode option.
function runnerCalls(name: string, args: Word[]): Word[] {
  if (!PACKAGE_RUNNERS.has(name) || name === "bunx") return []
  const calls: Word[] = []
  for (let k = 0; k < args.length; k++) {
    const v = args[k]!.value
    if (CALLS.has(v) && args[k + 1]) calls.push(args[k + 1]!)
    else if (v.startsWith("--call=")) calls.push({ ...args[k]!, value: v.slice(7) })
  }
  return calls
}

type Link = { args: Word[]; name: string }
type Unread = { unread: string }

// A runner's program whose own name, after its last /, is built at run time, so it may name any runner; a written-out name in a folder built at run time (`$P/probe.ts`) names itself
const builtName = (word: Word | undefined) =>
  !!word && marked(word.value.slice(word.value.lastIndexOf("/") + 1))

// Each runner a call reaches, the call's own program first, then each runner it starts (npx npx, bunx npx, bun x npx, and bun run's or bare bun's runner, as runnerBuns reads it) until one runs vercel; a reading past runnerReadings' cap, or a program built at run time, may run any program, so it ends the chain as unread at any depth
function chain(name: string, args: Word[], shell: Env): (Link | Unread)[] {
  const links: (Link | Unread)[] = []
  for (;;) {
    if (args[1] === UNREAD_CWD)
      return [...links, { unread: "a runner call past the readings the hook makes" }]
    links.push({ args, name })
    if (!STARTED_RUNNERS.has(name) || toolWords(NAMES, name, args, shell)) return links
    let rest = args
    let at: number
    if (name === "bun") {
      const call = bunCall(args, shell)
      at = call.at
      if (call.words[0] === "x") {
        rest = args.slice(call.sub + 1)
        at = runnerTarget(rest)
      }
    } else at = runnerTarget(rest)
    if (builtName(rest[at])) return [...links, { unread: "a runner's program built at run time" }]
    const started = toolName(rest[at]?.value)
    if (!STARTED_RUNNERS.has(started)) return links
    name = started
    args = rest.slice(at + 1)
  }
}

export async function check(
  raw: string,
  environment: Environment = process.env,
): Promise<string | undefined> {
  const {
    cwd,
    tool_input: toolInput,
    tool_name: tool,
  } = JSON.parse(raw) as {
    cwd?: unknown
    tool_input?: { command?: unknown }
    tool_name?: unknown
  }
  if (tool !== "Bash" || typeof toolInput?.command !== "string") return
  const command = toolInput.command
  if (!MENTION.test(command.replace(/["'\\]/g, ""))) return
  const verdicts: Verdict[] = []
  const visit: Visit = async (_cmd, parsed, shell) => {
    if (parsed.first && unreadable(parsed.first) && NAMED.test(command))
      verdicts.push({
        production: false,
        what: "a program built at run time on a line naming vercel",
      })
    // run-slot.sh runs the words after its -- as the command
    const slotted = slotWords(parsed)
    const name = slotted ? program(slotted[0]?.value ?? "") : parsed.name
    // each reading of a runner's options is judged, so a value the reader takes for the program hides no deploy
    for (const args of runnerReadings(name, slotted ? slotted.slice(1) : parsed.args)) {
      if (
        yardStep(name, args, shell) ||
        throughRunners(name, args, shell).some((bun) => yardStep("bun", bun.args, bun.shell))
      )
        verdicts.push({ production: true, what: "the Yard ship step, which deploys production" })
      // npx reads every word for its -c line, so the runners after it need no second read
      let scanned = false
      for (const link of chain(name, args, shell)) {
        if ("unread" in link) {
          if (NAMED.test(command))
            verdicts.push({ production: false, what: `${link.unread} on a line naming vercel` })
          continue
        }
        // a runner's -c line runs in a shell, so it is read as sh -c's is, and one the hook cannot read is the step on a line naming it
        if (!scanned)
          for (const call of runnerCalls(link.name, link.args))
            if (!unreadable(call))
              await run(lex(call.value), { ...shell, vars: new Map(shell.vars) }, visit)
            else if (STEP_NAMED.test(command))
              verdicts.push({
                production: true,
                what: "a runner's command line built at run time on a line naming the Yard ship step",
              })
        scanned ||= link.name === "npx"
        const words = toolWords(NAMES, link.name, link.args, shell)
        // xargs hands it words from stdin, which the hook cannot read: appended, or in place of its -I or -J string
        const verdict =
          words &&
          judgeAll(
            words.map((w) => ({ ...w, ...viaXargs(w, parsed.xargs) })),
            parsed.xargs !== undefined,
          )
        if (verdict) verdicts.push(verdict)
      }
    }
    return undefined
  }
  const env: Env = {
    cwd: typeof cwd === "string" ? cwd : undefined,
    files: new Map(),
    known: {},
    process: {},
    vars: new Map(),
  }
  await run(lex(command), env, visit)
  const always = verdicts.find((v) => !v.production)
  if (always)
    return `no-raw-vercel hook refuses ${always.what}: in a factory session vercel runs its reads alone (whoami, ls, inspect, logs, help, the ls of alias, dns, domains, integration, project and teams, env ls without its values, promote and rollback status, rolling-release inspect, a vercel api GET outside /env) and a preview deploy (vercel deploy, vercel deploy init, or vercel ./<folder>). A secret reaches a project through an Inbox secret ask, and production ships from main through the release skill's ship:merge.`
  const production = verdicts.find((v) => v.production)
  if (!production || ((await opsLead(raw, environment)) && !namesRole(command))) return
  return `no-raw-vercel hook refuses ${production.what}: it changes what production serves, and a production deploy also migrates the hosted database. Production ships from main through the release skill's ship:merge; the Ops lead alone makes a hand production move, in a call that names no role variable and sources no file. A preview deploy (vercel deploy without --prod) and the reads (whoami, ls, inspect, logs, help) run.`
}
