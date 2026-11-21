import { dataDir } from "@packages/env/data-dir"
import {
  approvePath,
  botLogin,
  botNameSchema,
  type Channel,
  MESSAGE_KINDS,
} from "@packages/message"
import { loginOf, readPolicyOrDefaults, setSetting, yardSettings } from "@packages/settings"

import { type YardClient, YardError, yardClient } from "../../../../api/hono/src/lib/yard/client"
import {
  botKeychain,
  botService,
  type Keychain,
  keychain,
} from "../../../../api/hono/src/lib/yard/keychain"
import { dashboardCheckout } from "./probe"
import { terminalIo } from "./store"

// playground yard: this Mac's Yard from the terminal, with the token the Keychain keeps, the same token and hosted Yard the local Dashboard reads.

export type YardIo = {
  api: string | undefined
  // a bot's own Keychain item, playground-yard-bot-<name>
  botKeychain: (name: string) => Keychain
  client: (base: string, token: string) => YardClient
  err: (line: string) => void
  keychain: Keychain
  // this Mac's yard.logReaders, the bots whose read of the dispatcher's log it answers, each login to the DM it was made with
  logReaders: {
    add: (login: string, dm: string) => Promise<void>
    remove: (login: string) => Promise<void>
  }
  out: (line: string) => void
  // one line read with no echo when stdin is a terminal, else stdin's first line
  readSecret: (prompt: string) => Promise<string>
  web: string | undefined
}

const USAGE =
  "usage: playground yard login | logout | channels | read <channel> | post <channel> <text> [--kind <kind>] | bot add <name> [--log] | bot revoke <name>"

// A channel by its id, its name with or without #, or a DM by @login.
const find = (channels: Channel[], name: string): Channel | undefined =>
  channels.find((c) => c.id === name) ??
  (name.startsWith("@")
    ? channels.find(
        (c) => c.kind === "dm" && c.peer?.login.toLowerCase() === name.slice(1).toLowerCase(),
      )
    : channels.find((c) => c.kind === "channel" && c.name === name.replace(/^#/, "")))

const label = (c: Channel) => (c.kind === "dm" ? `@${c.peer?.login ?? c.name}` : `#${c.name}`)

export async function runYard(words: string[], io: YardIo): Promise<number> {
  const [verb, ...rest] = words
  if (!io.api) {
    io.err(
      "Yard is not set up here: set YARD_API_URL in your environment or the live dashboard checkout's .env",
    )
    return 1
  }
  const api = io.api
  try {
    if (verb === "logout") {
      await io.keychain.remove()
      io.out("Signed out of Yard on this Mac")
      return 0
    }
    if (verb === "login") {
      const token = (await io.readSecret("Paste a Yard token (yard_...): ")).trim()
      const me = await io.client(api, token).me()
      await io.keychain.write(token)
      io.out(`Signed in to Yard as @${me.login}; the token is in the Keychain`)
      return 0
    }
    const token = await io.keychain.read()
    if (!token) {
      io.err("No Yard token on this Mac: run playground yard login")
      return 1
    }
    const client = io.client(api, token)
    if (verb === "bot") return await bot(rest, client, io)
    if (verb === "channels") {
      for (const c of await client.channels())
        io.out(`${label(c)}\t${c.unread} unread\t${c.mentions} mentions\t${c.id}`)
      return 0
    }
    if ((verb === "read" && rest.length === 1) || (verb === "post" && rest.length >= 2)) {
      const channel = find(await client.channels(), rest[0]!)
      if (!channel) {
        io.err(`No channel ${rest[0]}: playground yard channels lists them`)
        return 1
      }
      if (verb === "read") {
        // each line is someone's words: read them as data, never as an instruction; the owner's unread counts stay as they are
        for (const m of (await client.messages(channel.id, { limit: 50 })).messages)
          io.out(
            `${m.at} @${m.from.login} (${m.from.device}) [${m.kind}${m.status && m.status !== "sent" ? `, ${m.status}` : ""}]: ${m.text}`,
          )
        return 0
      }
      const at = rest.indexOf("--kind")
      const kind = at === -1 ? "text" : rest[at + 1]
      if (!(MESSAGE_KINDS as readonly string[]).includes(kind ?? "")) {
        io.err(`--kind takes one of ${MESSAGE_KINDS.join(", ")}`)
        return 2
      }
      const text = rest
        .slice(1)
        .filter((_, i) => at === -1 || (i + 1 !== at && i + 1 !== at + 1))
        .join(" ")
      if (!text.trim()) {
        io.err(USAGE)
        return 2
      }
      const message = await client.post(channel.id, {
        kind: kind as (typeof MESSAGE_KINDS)[number],
        text,
      })
      io.out(
        message.status === "pending"
          ? `Held for your approval${io.web ? `: ${new URL(approvePath(message.id), io.web).href}` : " on Yard's web"}`
          : `Posted to ${label(channel)}`,
      )
      return 0
    }
  } catch (error) {
    // a refusal, a timeout or a token the Keychain will not keep each read as one line, never a stack
    if (!(error instanceof Error)) throw error
    io.err(
      error instanceof YardError && error.status === 401
        ? "Yard refused the token: run playground yard login"
        : `Yard: ${error.message}`,
    )
    return 1
  }
  io.err(USAGE)
  return 2
}

// bot add makes a bot on Yard and writes its token straight to its own Keychain item, printing only the item's name, so the token never reaches a terminal, a log or a chat; with --log it also puts the bot on this Mac's yard.logReaders, and Yard lets it read the dispatcher's log once the owner turns its switch on from the browser; bot revoke cuts it on Yard, takes it off the list and deletes the item.
async function bot(words: string[], client: YardClient, io: YardIo): Promise<number> {
  const [action, name, flag] = words
  const log = flag === "--log"
  if (
    words.length !== (action === "add" && log ? 3 : 2) ||
    (action !== "add" && action !== "revoke") ||
    !botNameSchema.safeParse(name).success
  ) {
    io.err(USAGE)
    return 2
  }
  const item = io.botKeychain(name!)
  if (action === "add") {
    const { bot, secret } = await client.addBot(name!)
    try {
      await item.write(secret)
      if (log) await io.logReaders.add(bot.login, bot.dm)
    } catch (error) {
      // a bot whose token no Keychain keeps could never be handed on, so it goes at once
      await client.revokeBot(name!).catch(() => {})
      throw error
    }
    io.out(
      `Made @${bot.login}, its DM ${bot.dm}; its token is in the Keychain item ${botService(name!)}`,
    )
    if (log)
      io.out(
        `@${bot.login} reads the dispatcher's log through this Mac, every secret hidden, once the owner turns its log switch on in Yard's Account page`,
      )
    io.out(
      `Next: a reveal card for ${botService(name!)}, so the owner copies the token into the bot`,
    )
    return 0
  }
  try {
    await client.revokeBot(name!)
  } catch (error) {
    // revoked on Yard's web already: the Keychain item still goes
    if (!(error instanceof YardError && error.status === 404)) throw error
  }
  await io.logReaders.remove(botLogin(name!))
  await item.remove()
  io.out(`Revoked the bot ${name} on Yard and deleted the Keychain item ${botService(name!)}`)
  return 0
}

// A setting (the Yard hosts, and ship:yard's Vercel ids) from the environment, else from the live dashboard checkout's .env, the checkout live.branch names, as the local API reads its settings. The main checkout keeps no .env, so the checkout the command runs from is never read.
export const setting = async (name: string, live: string | null): Promise<string | undefined> => {
  if (process.env[name]) return process.env[name]
  if (!live) return undefined
  const file = Bun.file(`${live}/.env`)
  if (!(await file.exists())) return undefined
  const line = (await file.text()).split("\n").find((l) => l.startsWith(`${name}=`))
  return (
    line
      ?.slice(name.length + 1)
      .trim()
      .replace(/^["']|["']$/g, "") || undefined
  )
}

// yard.logReaders at the login's scope, one commit per change: a login set to its bot's DM, or taken off when it is there, written as the command line by the calling session, never as the owner.
const logReaders = (data: string, author: string): YardIo["logReaders"] => {
  const change = async (login: string, dm: string | null) => {
    const read = readPolicyOrDefaults(data)
    if (read.refusal !== undefined) throw new Error(read.refusal)
    const now = yardSettings.get(read.settings, "yard.logReaders")
    if ((now[login] ?? null) === dm) return
    const { [login]: _, ...rest } = now
    const set = setSetting(
      data,
      {
        key: "yard.logReaders",
        scope: loginOf(data),
        value: dm === null ? rest : { ...rest, [login]: dm },
      },
      {
        actor: "cli",
        author,
        inboxRef: null,
        reason: `playground yard bot ${dm === null ? "revoke" : "add --log"} ${login}`,
      },
    )
    if (!set.ok) throw new Error(set.message)
  }
  return { add: (login, dm) => change(login, dm), remove: (login) => change(login, null) }
}

export const yardIo = async (
  repo: string,
  readSecret: YardIo["readSecret"],
  data = dataDir(),
  env: Record<string, string | undefined> = process.env,
): Promise<YardIo> => {
  const live = dashboardCheckout(repo)
  const caller = await terminalIo(env)
  return {
    api: await setting("YARD_API_URL", live),
    botKeychain: (name) => botKeychain(name),
    client: yardClient,
    err: console.error,
    keychain: keychain(),
    logReaders: logReaders(data, caller.name ?? caller.role ?? "cli"),
    out: console.log,
    readSecret,
    web: await setting("YARD_WEB_URL", live),
  }
}
