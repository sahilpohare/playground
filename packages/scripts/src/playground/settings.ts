import {
  CORE,
  CORE_READ_ONLY,
  listSettings,
  loginOf,
  readSetting,
  resetSetting,
  type Result,
  setSetting,
  settingHistory,
} from "@packages/settings"

import { type Io, need, one, type Out, parseWords, print, Usage, valueOf } from "./store"

// playground settings: reads and writes the settings files in the extensions folder itself, with no dashboard needed; a write is one commit in its scope's clone, under the lock every writer takes.

export const SETTINGS_USAGE =
  "usage: playground settings list | get <key> [--org <org>] | why <key> | set <key> <value> --reason <why> [--scope <scope>] | set <key> <value> --from-owner-msg <id> | set <key> <value> --propose | reset <key> --reason <why> [--scope <scope>] | import-jobs <jobs.json> [--launch-agents <dir>] [--scope <scope>] [--dry-run]"

const done = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`${result.status} ${result.message}`)
  const { ok: _, ...data } = result
  return data as T
}

export async function settingsCommand(words: string[], io: Io, err: Out): Promise<number> {
  const [verb, ...rest] = words
  const { options, positional } = parseWords(rest, ["--dry-run", "--propose"])
  const who = () => ({
    actor: "cli",
    author: one(options, "--by") ?? "owner",
    inboxRef: null,
    reason: need(one(options, "--reason"), "--reason"),
  })
  const scope = () => {
    const named = one(options, "--scope") ?? loginOf(io.data)
    if (named === CORE) throw new Usage(CORE_READ_ONLY)
    return named
  }
  const key = () => need(positional[0], "a key")
  const known = <T>(read: T | null): T => {
    if (read === null) throw new Error(`404 no setting ${key()}`)
    return read
  }
  if (verb === "list") print(io.out, listSettings(io.data))
  else if (verb === "get") print(io.out, known(readSetting(io.data, key(), one(options, "--org"))))
  else if (verb === "why") print(io.out, known(settingHistory(io.data, key())))
  else if (verb === "set" && options["--propose"]) {
    // ops-wa asks the owner on WhatsApp, "set <key> to <value>? yes or no", and sets it on his yes alone; this shell writes nothing (ADR 0041)
    if (options["--scope"] || options["--by"] || options["--reason"] || options["--from-owner-msg"])
      throw new Usage(
        "--propose takes no --scope, --by, --reason or --from-owner-msg: ops-wa sets it at your login's scope, as the owner's act, on his yes to its question",
      )
    const { requestSettingPropose, socketPath } = await import("../ops-wa/server")
    const reply = await requestSettingPropose(
      socketPath(io.data),
      key(),
      need(positional[1], "a value"),
    )
    if (reply.refusal) throw new Error(reply.refusal)
    io.out(`playground settings: ${reply.note}`)
  } else if (verb === "set" && options["--from-owner-msg"]) {
    // ops-wa writes it, not this shell: it proves the id is the owner's own WhatsApp message holding the value, and asks the owner to confirm a key a guard reads (ADR 0035)
    if (options["--scope"] || options["--by"] || options["--reason"])
      throw new Usage(
        "--from-owner-msg takes no --scope, --by or --reason: ops-wa sets it at your login's scope, as the owner's act, with the message id as its reason",
      )
    // loaded only here, since no other settings call needs ops-wa's socket
    const { requestSettingSet, socketPath } = await import("../ops-wa/server")
    const reply = await requestSettingSet(
      socketPath(io.data),
      need(one(options, "--from-owner-msg"), "--from-owner-msg"),
      key(),
      need(positional[1], "a value"),
    )
    if (reply.refusal) throw new Error(reply.refusal)
    io.out(`playground settings: ${reply.note}`)
  } else if (verb === "set") {
    const value = valueOf(need(positional[1], "a value"))
    print(io.out, done(setSetting(io.data, { key: key(), scope: scope(), value }, who())))
    if (key() === "owner.names") {
      // loaded only here, since trace-count reads the whole tree, which no other settings call needs
      const { oneWords, warning } = await import("../trace-count/one-word")
      for (const hit of await oneWords(value as string[], io.data, io.checkout))
        err(`playground settings: ${warning(hit).join("\n")}`)
    }
  } else if (verb === "reset")
    print(io.out, done(resetSetting(io.data, { key: key(), scope: scope() }, who())))
  else if (verb === "import-jobs") {
    const into = scope()
    const reason = one(options, "--reason")
    return (await import("./jobs")).importJobs(
      need(positional[0], "a jobs.json"),
      {
        dryRun: Boolean(options["--dry-run"]),
        launchAgents: one(options, "--launch-agents"),
        scope: into,
      },
      (setting, value, why) =>
        done(
          setSetting(
            io.data,
            { key: setting, scope: into, value },
            { actor: "cli", author: "owner", inboxRef: null, reason: reason ?? why },
          ),
        ),
      io.out,
    )
  } else throw new Usage(`no settings command ${verb ?? ""}`.trim())
  return 0
}
