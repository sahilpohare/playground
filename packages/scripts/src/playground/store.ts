import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"

import { dataDir } from "@packages/env/data-dir"
import {
  diffItem,
  exportTo,
  extensionsDir,
  importFrom,
  importLists,
  itemHistory,
  itemKeySchema,
  judgeItem,
  type Kind,
  KINDS,
  listExtensions,
  listItems,
  lostModes,
  type Outcome,
  putItem,
  type Ref,
  SCOPE_NAME,
  searchItems,
  setRootLock,
  showItem,
  type Verdict,
} from "@packages/settings"

import { SETTINGS_USAGE, settingsCommand } from "./settings"
// playground ext and playground settings write the extensions' folders here through the lib the dashboard's routes call, so neither needs a dashboard running. The helpers below serve both.

export type Out = (line: string) => void

export const EXT_USAGE =
  "usage: playground ext init [--yes | --dry-run] | add <name> [<owner/name>] [--yes | --dry-run] | order <name>... | link <name> <org|*> | unlink <name> <org|*> | lock | unlock | remove <name> | sync [<scope>] | list [--scope <scope>] [--kind <kind>] | show <scope> <kind> <key> [--rev <sha>] | put <scope> <kind> <key> <path|-> --reason <why> [--attach <path>]... | which <skill> [--repo <dir> | --org <org>] | why <scope> <kind> <key> | why <skill> [--repo <dir> | --org <org>] | diff <scope> <kind> <key> --from <sha> --to <sha> | search <words> [--kind <kind>] | export <dir> | import <dir> [--dry-run] | import --from-tree <dir> [--dry-run] | import-scripts <ops-dir> <job>... --org <org> [--dry-run] | score <scope> <kind> <key> <sha> <0-5> --reason <why> | accept|reject <scope> <kind> <key> <sha> --reason <why> | check-modes"

const MIME: Record<string, string> = {
  ".json": "application/json",
  ".md": "text/markdown",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".txt": "text/plain",
}

export class Usage extends Error {}

// Pure: a command's words split into its positional words and its options, a repeated option kept in order.
export const parseWords = (
  words: string[],
  flags: string[] = [],
): { options: Record<string, string[]>; positional: string[] } => {
  const options: Record<string, string[]> = {}
  const positional: string[] = []
  for (let i = 0; i < words.length; i++) {
    const word = words[i]!
    if (flags.includes(word)) (options[word] ??= []).push("")
    else if (word.startsWith("--") && word !== "-") {
      const value = words[++i]
      if (value === undefined) throw new Usage(`${word} needs a value`)
      ;(options[word] ??= []).push(value)
    } else positional.push(word)
  }
  return { options, positional }
}

export const one = (options: Record<string, string[]>, name: string) => options[name]?.at(-1)
export const need = (value: string | undefined, what: string) => {
  if (!value) throw new Usage(`${what} is required`)
  return value
}

// A value as JSON when it parses as JSON, else the words as a string, so `set ui.theme dark` needs no quotes.
export const valueOf = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

export const print = (out: Out, data: unknown) =>
  Array.isArray(data) && data.every((line) => typeof line === "string")
    ? data.forEach((line) => out(line))
    : out(JSON.stringify(data, null, 2))

const filesUnder = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? filesUnder(join(dir, e.name)) : e.isFile() ? [join(dir, e.name)] : [],
  )

// A file its owner may run, whose executable bit put keeps.
const runs = (file: string) => (statSync(file).mode & 0o100) !== 0

// A revision's content from its path: a skill's folder, or a script's, as its files, a list's file as its value, any other kind's file (or stdin, `-`) as its body; each --attach file read here and sent as bytes, never a path the API reads, and a script's or a skill's files that run directly named in executable.
export const contentOf = async (
  kind: string,
  path: string,
  attach: string[],
  stdin: () => Promise<string>,
) => {
  const attachments = attach.map((file) => ({
    bytes: readFileSync(file).toString("base64"),
    mime: MIME[file.slice(file.lastIndexOf("."))] ?? "application/octet-stream",
    name: file.slice(file.lastIndexOf("/") + 1),
  }))
  if (kind === "skill" || (kind === "script" && path !== "-" && statSync(path).isDirectory())) {
    if (path === "-" || !statSync(path).isDirectory())
      throw new Usage("a skill is added from its folder")
    const names = filesUnder(path)
    return {
      attachments,
      executable: names.filter(runs).map((f) => relative(path, f)),
      files: Object.fromEntries(names.map((f) => [relative(path, f), readFileSync(f, "utf8")])),
    }
  }
  const text = path === "-" ? await stdin() : readFileSync(path, "utf8")
  if (kind === "list") return { attachments, value: JSON.parse(text) }
  return {
    attachments,
    body: text,
    executable: kind === "script" && path !== "-" && runs(path) ? ["."] : [],
  }
}

export type Io = {
  // the checkout whose tracked files settings set's owner.names warning reads, this code's own when unset
  checkout?: string
  data: string
  // the calling session's name in Claude Code's registry, which a write records as its author
  name?: string
  out: Out
  // the caller's PLAYGROUND_ROLE, which a factory session sets and the owner's own terminal does not
  role?: string
  stdin: () => Promise<string>
  write: (path: string, data: string | Uint8Array) => Promise<unknown>
}

// The terminal's Io: the data folder, stdout, stdin, the caller's PLAYGROUND_ROLE, an empty one counting as none, and a session's name from CLAUDE_CODE_SESSION_ID.
export const terminalIo = async (
  env: Record<string, string | undefined> = process.env,
): Promise<Io> => {
  const role = env.PLAYGROUND_ROLE || undefined
  const session = role && env.CLAUDE_CODE_SESSION_ID
  return {
    data: dataDir(env),
    // loaded for a session alone, so the CLI's own import graph stays free of the hooks
    name: session
      ? await import("../../../../scripts/hooks/role")
          .then(({ registryName }) => registryName(session, env))
          .catch(() => undefined)
      : undefined,
    out: console.log,
    role,
    stdin: () => Bun.stdin.text(),
    write: Bun.write,
  }
}

// Who a write from the terminal is: the CLI as its actor, the calling session as its author (its name, else its role, else the owner), with its reason.
const whoOf = (options: Record<string, string[]>, io: Io) => {
  if (options["--by"])
    throw new Usage(
      "--by is gone: a write's author is the calling session, by its name or PLAYGROUND_ROLE, and the owner with no role",
    )
  return {
    actor: "cli",
    author: io.role ? (io.name ?? io.role) : "owner",
    inboxRef: null,
    reason: need(one(options, "--reason"), "--reason"),
  }
}

const done = <T>(result: Outcome<T>): T => {
  if (!result.ok) throw new Error(`${result.status} ${result.message}`)
  return result
}

// playground ext: the extensions' items read and written in their folders here, under the same lock the dashboard's API takes, so neither needs the other running.
export async function extCommand(words: string[], io: Io): Promise<number> {
  const [verb, ...rest] = words
  const { options, positional } = parseWords(rest, ["--dry-run", "--yes"])
  const ref = (): Ref => {
    const [scope, kind, key] = [0, 1, 2].map((i) =>
      need(positional[i], "a scope, a kind and a key"),
    )
    if (!SCOPE_NAME.test(scope!))
      throw new Usage(`${scope} is not a scope: a login, an org or core`)
    if (!(KINDS as readonly string[]).includes(kind!))
      throw new Usage(`${kind} is not a kind: ${KINDS.join(", ")}`)
    if (!itemKeySchema.safeParse(key).success) throw new Usage(`${key} is not an item key`)
    return { key: key!, kind: kind as Kind, scope: scope! }
  }
  const kind = one(options, "--kind") as Kind | undefined
  if (verb === "init" && "--dry-run" in options) {
    const { extInitCheck } = await import("./ext-init")
    print(io.out, await extInitCheck(io.data))
    return 0
  }
  if (verb === "add" && "--dry-run" in options) {
    const { extAddCheck } = await import("./ext-init")
    print(io.out, await extAddCheck(io.data, positional[0] ?? "", positional[1]))
    return 0
  }
  if (verb === "add" || verb === "init" || verb === "sync") {
    const { askCreate, extVerb } = await import("./ext-init")
    return extVerb(verb, positional, io, undefined, askCreate("--yes" in options))
  }
  if (verb === "lock" || verb === "unlock") {
    setRootLock(io.data, verb === "lock")
    io.out(`${verb}ed ${extensionsDir(io.data)}`)
    return 0
  }
  if (verb === "link" || verb === "order" || verb === "remove" || verb === "unlink")
    return (await import("./ext-init")).extArrange(verb, positional, io)
  // with no filter, list names the extensions themselves, in the order a name is taken from them
  if (verb === "list" && !kind && !one(options, "--scope")) print(io.out, listExtensions(io.data))
  else if (verb === "list")
    print(io.out, listItems(io.data, { kind, scope: one(options, "--scope") }))
  else if (verb === "show") {
    const item = showItem(io.data, ref(), one(options, "--rev"))
    if (!item) throw new Error("404 no such item or revision")
    print(io.out, item)
  } else if (verb === "which" || (verb === "why" && positional.length === 1)) {
    if (positional.length !== 1) throw new Usage("which takes one skill's name")
    const { orgsIo, whichSkill } = await import("./orgs")
    const found = await whichSkill(
      orgsIo(join(import.meta.dir, "../../../.."), io.data),
      positional[0]!,
      one(options, "--repo"),
      one(options, "--org"),
    )
    // which is a script's lookup of a folder, so a name no scope holds is a usage error, exit 2
    if (found.refusal !== undefined)
      throw verb === "which" ? new Usage(found.refusal) : new Error(found.refusal)
    if (verb === "which") io.out(found.dir)
    else print(io.out, { dir: found.dir, from: found.from, shadowed: found.shadowed })
  } else if (verb === "why") print(io.out, itemHistory(io.data, ref()))
  else if (verb === "diff") {
    const lines = diffItem(
      io.data,
      ref(),
      need(one(options, "--from"), "--from"),
      need(one(options, "--to"), "--to"),
    )
    if (!lines) throw new Error("404 no such revision")
    print(io.out, lines)
  } else if (verb === "search")
    print(io.out, searchItems(io.data, need(positional.join(" "), "the words to search for"), kind))
  else if (verb === "put") {
    const at = ref()
    const content = await contentOf(
      at.kind,
      need(positional[3], "a path, or - for stdin"),
      options["--attach"] ?? [],
      io.stdin,
    )
    const put = done(
      putItem(
        io.data,
        at,
        { body: null, files: null, value: null, ...content },
        whoOf(options, io),
        false,
      ),
    )
    print(io.out, { rev: put.rev, state: put.state })
  } else if (verb === "export") {
    for (const line of exportTo(io.data, need(positional[0], "a folder to export into")))
      io.out(line)
  } else if (verb === "import" && options["--from-tree"]) {
    const dir = one(options, "--from-tree")!
    const who = {
      ...whoOf({ ...options, "--reason": options["--reason"] ?? [`seeded from ${dir}`] }, io),
    }
    for (const line of done(importLists(io.data, dir, Boolean(options["--dry-run"]), who)).lines)
      io.out(line)
  } else if (verb === "import") {
    const dir = need(positional[0], "a folder to import")
    const who = whoOf(
      { ...options, "--reason": options["--reason"] ?? [`imported from ${dir}`] },
      io,
    )
    for (const line of done(importFrom(io.data, dir, Boolean(options["--dry-run"]), who)).lines)
      io.out(line)
  } else if (verb === "score" || verb === "accept" || verb === "reject") {
    if (verb === "accept" && io.role)
      throw new Error(
        `accept is the owner's own call, so a session with a role (${io.role}) scores a proposal instead, and asks for the accept as an accept decision with bun run ask new, whose Approve has the dashboard run it`,
      )
    // a score's author is the session by name, never its role, since two sessions of one role, or one whose registry a command redirects, would read as one author
    if (verb === "score" && io.role && !io.name)
      throw new Error(
        `no name in Claude Code's registry resolves for this session (role ${io.role}), so its score is refused rather than recorded under the role; score from a named session, as every session spawn.sh starts is`,
      )
    const at = ref()
    const rev = need(positional[3], "a rev")
    const who = whoOf(options, io)
    const score = verb === "score" ? Number(need(positional[4], "a score from 0 to 5")) : undefined
    if (score !== undefined && !(Number.isInteger(score) && score >= 0 && score <= 5))
      throw new Usage("a score is a whole number from 0 to 5")
    const verdict: Verdict = verb === "score" ? { kind: "score", score: score! } : { kind: verb }
    const judged = done(judgeItem(io.data, at, rev, verdict, who))
    io.out(`rev ${judged.rev} is ${judged.state}`)
  } else if (verb === "check-modes") {
    const lost = lostModes(io.data)
    for (const line of lost) io.out(line)
    io.out(
      lost.length
        ? "put each again from a copy that has its executable bit: playground ext put <scope> <kind> <key> <path> --reason <why>"
        : "every stored file that starts with #! keeps its executable bit",
    )
  } else if (verb === "import-scripts") {
    need(positional[1], "a job folder to import")
    return (await import("./import-scripts")).importScripts(
      io.data,
      positional[0]!,
      positional.slice(1),
      {
        dryRun: Boolean(options["--dry-run"]),
        org: need(one(options, "--org"), "--org"),
        reason: one(options, "--reason"),
      },
      io.out,
    )
  } else throw new Usage(`no ext command ${verb ?? ""}`.trim())
  return 0
}

// The command's exit code, with a usage error or the API's refusal printed on one line.
export const runStore = async (
  command: "ext" | "settings",
  words: string[],
  io: Io,
  err: Out,
): Promise<number> => {
  try {
    return await (command === "settings" ? settingsCommand : extCommand)(words, io, err)
  } catch (error) {
    const usage = error instanceof Usage
    err(
      `playground ${command}: ${(error as Error).message}${usage ? `\n${command === "settings" ? SETTINGS_USAGE : EXT_USAGE}` : ""}`,
    )
    return usage ? 2 : 1
  }
}
